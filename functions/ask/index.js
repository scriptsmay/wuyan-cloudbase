const crypto = require('crypto');
const cloudbase = require('@cloudbase/node-sdk');
const {
  ENV_ID,
  parseBody,
  getHeader,
  resolveIdentity,
  successResponse,
  errorResponse,
  optionsResponse,
  getRequestId,
} = require('./runtime');

const CACHE_TTL = 5 * 60 * 1000;
const BJ_OFFSET = 8 * 60 * 60 * 1000;

function getBjDate(ts) {
  const d = ts ? new Date(ts) : new Date();
  const utc = d.getTime() + d.getTimezoneOffset() * 60 * 1000;
  return new Date(utc + BJ_OFFSET);
}

function formatBjTime(startTs) {
  const d = getBjDate(startTs * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${hh}:${mm}`;
}

exports.main = async (_event, _context) => {
  const requestId = getRequestId(event);
  const origin = getHeader(event, 'origin');
  const method = String(
    event.httpMethod || (event.requestContext && event.requestContext.httpMethod) || 'POST'
  ).toUpperCase();
  if (method === 'OPTIONS') return optionsResponse(requestId, origin);
  if (method !== 'POST') return errorResponse(405, 'METHOD_NOT_ALLOWED', '仅支持 POST', requestId, origin);

  const app = cloudbase.init({ env: ENV_ID });
  const db = app.database();

  let body;
  try {
    body = parseBody(event);
  } catch (_) {
    return errorResponse(400, 'INVALID_ARGUMENT', '请求体不是合法 JSON', requestId, origin);
  }
  const query = event.queryStringParameters || {};
  const identity = await resolveIdentity(app, event, body);
  if (!identity.ok) return errorResponse(401, 'SESSION_REQUIRED', '匿名会话无效或已过期', requestId, origin);

  const q = (body.q || query.q || event.q || '').trim();
  if (!q) {
    return errorResponse(400, 'INVALID_ARGUMENT', '问题不能为空', requestId, origin);
  }
  if (Array.from(q).length > 200)
    return errorResponse(400, 'INVALID_ARGUMENT', '问题不能超过 200 个字符', requestId, origin);
  if (isContentBlocked(q)) {
    return errorResponse(451, 'CONTENT_BLOCKED', '问题内容未通过安全检查', requestId, origin);
  }

  try {
    const cacheKey = md5(normalize(q));
    const cached = await getCache(db, cacheKey);
    if (cached) {
      await recordUsage(db, 'ask', 'cache');
      return successResponse(cached, requestId, origin);
    }

    const { overviewData, liveData, scheduleData, refs } = await fetchContextData(db);
    if (!overviewData) {
      return errorResponse(404, 'NOT_FOUND', '暂无相关数据', requestId, origin);
    }

    const dailyLimit = await getDailyLimit(db, 'ask');
    const limitOk = await checkUsageLimit(db, 'ask', dailyLimit, identity.subjectId, requestId);
    if (!limitOk) {
      return errorResponse(429, 'RATE_LIMITED', '今日 AI 调用已达上限，请明日再来', requestId, origin, 86400);
    }

    const systemPrompt = buildSystemPrompt(overviewData, liveData);
    const userPrompt = buildUserPrompt(q, overviewData, liveData, scheduleData);

    let answer = '';
    try {
      answer = await callAI(app, systemPrompt, userPrompt);
    } catch (aiErr) {
      console.error('[ask] AI call failed:', aiErr.message);
      await recordAIReport(db, 'ask', identity.subjectId, q, '', aiErr.message);
      return errorResponse(503, 'AI_UNAVAILABLE', '小秘书暂时开小差，稍后再试～', requestId, origin);
    }

    const result = { answer, refs };
    if (isContentBlocked(answer)) {
      console.warn('[ask] AI answer blocked by content safety');
      await recordAIReport(db, 'ask', identity.subjectId, q, 'BLOCKED: ' + answer, 'content_blocked');
      return errorResponse(451, 'CONTENT_BLOCKED', '回答内容未通过安全检查，请换个方式提问', requestId, origin);
    }
    await setCache(db, cacheKey, q, normalize(q), result);
    await recordUsage(db, 'ask', 'ai');
    await recordAIReport(db, 'ask', identity.subjectId, q, answer, '');

    return successResponse(result, requestId, origin);
  } catch (err) {
    console.error('[ask] Error:', err.message, err.stack);
    return errorResponse(503, 'WRITE_FAILED', '服务暂时不可用，请稍后重试', requestId, origin);
  }
};

function normalize(q) {
  return q
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
    .replace(/\s+/g, '');
}

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

async function getCache(db, cacheKey) {
  try {
    const res = await db.collection('ask_cache').doc(cacheKey).get();
    if (res.data && res.data.length > 0) {
      const doc = res.data[0];
      if (doc.expires_at > Date.now()) {
        return { answer: doc.answer, refs: doc.refs || [] };
      }
      await db.collection('ask_cache').doc(cacheKey).remove();
    }
  } catch (_) {}
  return null;
}

async function setCache(db, cacheKey, q, normalizedQ, result) {
  try {
    const now = Date.now();
    const doc = {
      q,
      normalized_q: normalizedQ,
      answer: result.answer,
      refs: result.refs || [],
      created_at: now,
      expires_at: now + CACHE_TTL,
    };
    await db.collection('ask_cache').add(doc);
  } catch (e) {
    console.warn('[ask] cache set failed:', e.message);
  }
}

async function fetchContextData(db) {
  const refs = [];
  let overviewData = null;
  let liveData = null;
  let scheduleData = null;

  try {
    const ovRes = await db.collection('season_summaries').orderBy('updated_at', 'desc').limit(1).get();
    if (ovRes.data.length > 0) {
      overviewData = ovRes.data[0];
      refs.push('当前赛季概览');
    }
  } catch (e) {
    console.warn('[ask] fetch overview failed:', e.message);
  }

  try {
    const nowBj = getBjDate();
    const year = nowBj.getUTCFullYear();
    const month = nowBj.getUTCMonth() + 1;
    const liveRes = await db
      .collection('live_streams')
      .where({ year, month })
      .orderBy('stream_date', 'desc')
      .limit(30)
      .get();
    const streams = (liveRes.data || []).filter((s) => s.type !== 'monthly_summary');
    if (streams.length > 0) {
      const totalHours = Math.round(streams.reduce((s, x) => s + (x.duration || 0), 0) / 360) / 10;
      liveData = {
        month: `${year}-${String(month).padStart(2, '0')}`,
        total_sessions: streams.length,
        total_hours: totalHours,
        latest_date: streams[0].stream_date,
      };
      refs.push('本月直播数据');
    }
  } catch (e) {
    console.warn('[ask] fetch live failed:', e.message);
  }

  try {
    const schedRes = await db.collection('match_schedules').orderBy('updated_at', 'desc').limit(1).get();
    if (schedRes.data.length > 0) {
      const doc = schedRes.data[0];
      const matches = doc.matches || [];
      const nowTs = Math.floor(Date.now() / 1000);
      const todayBj = getBjDate();
      todayBj.setUTCHours(0, 0, 0, 0);
      const todayStartTs = Math.floor(todayBj.getTime() / 1000) - BJ_OFFSET / 1000;
      const todayEndTs = todayStartTs + 86400;

      const todayMatches = matches.filter((m) => {
        const ts = m.start_ts || 0;
        return ts >= todayStartTs && ts < todayEndTs;
      });
      const upcoming = matches
        .filter((m) => {
          const ts = m.start_ts || 0;
          return ts >= nowTs;
        })
        .slice(0, 5);
      const recent = matches
        .filter((m) => {
          const ts = m.start_ts || 0;
          return ts > 0 && ts < nowTs;
        })
        .slice(-5)
        .reverse();

      const fmt = (m) => {
        const dateStr = formatBjTime(m.start_ts || 0);
        const score = m.status === 4 ? ` ${m.score_a || 0}:${m.score_b || 0}` : '';
        return `${dateStr} ${m.team_a || ''} vs ${m.team_b || ''}${score} (${m.stage || m.date || ''})`;
      };

      if (upcoming.length > 0 || recent.length > 0 || todayMatches.length > 0) {
        scheduleData = {
          season_name: doc.season_name || '',
          today: todayMatches.map(fmt),
          upcoming: upcoming.map(fmt),
          recent: recent.map(fmt),
        };
        refs.push('赛程数据');
      }
    }
  } catch (e) {
    console.warn('[ask] fetch schedule failed:', e.message);
  }

  return { overviewData, liveData, scheduleData, refs };
}

function buildSystemPrompt(overview, _live) {
  const player = overview.player_name || '无言';
  const team = overview.team_name || '';
  return `你是${player}的贴身小秘书，语气亲切活泼，带粉圈感。
你只基于下面提供的 JSON 数据回答问题，数据中没有的内容要明确说"暂无相关数据"，绝对不能编造数据。
回答要简短自然，用口语化的中文，不要太正式。
当前选手：${player}，所属战队：${team}。`;
}

function buildUserPrompt(q, overview, live, schedule) {
  const rawData = overview.data || {};
  // overview.json 结构: { schema_version, season, data: { career_summary, season_stats, hero_stats } }
  const data = rawData.data || rawData;
  const seasonId = overview.season || '';
  const seasonName = overview.season_name || seasonId || '';
  const career = data.career_summary || {};
  const seasonStatsArr = data.season_stats || [];
  const seasonStats = seasonStatsArr.find((s) => s.season_id === seasonId) || {};
  const heroStats = data.hero_stats || [];
  console.log(
    '[ask] buildUserPrompt seasonId:',
    seasonId,
    'seasonStats found:',
    !!seasonStats.season_id,
    'heroStats count:',
    heroStats.length
  );

  // 胜率统一格式化为 xx.x%
  const fmtRate = (v) => {
    if (v == null) return '暂无';
    if (typeof v === 'string') {
      if (v.includes('%')) return v;
      const n = parseFloat(v);
      if (!isNaN(n) && n <= 1) return (n * 100).toFixed(1) + '%';
      return v;
    }
    if (typeof v === 'number') {
      if (v <= 1) return (v * 100).toFixed(1) + '%';
      return v.toFixed(1) + '%';
    }
    return String(v);
  };

  // 优先取当前赛季数据，其次生涯汇总
  const winRate = seasonStats.win_rate != null ? fmtRate(seasonStats.win_rate) : fmtRate(career.win_rate);
  const kda = seasonStats.kda_ratio != null ? seasonStats.kda_ratio : '暂无';
  const totalMatches = seasonStats.battles != null ? seasonStats.battles : career.total_matches || '暂无';
  const mvp = seasonStats.mvp != null ? seasonStats.mvp : '暂无';
  const avgKills = seasonStats.avg_kills != null ? seasonStats.avg_kills : '暂无';
  const avgDeaths = seasonStats.avg_deaths != null ? seasonStats.avg_deaths : '暂无';
  const avgAssists = seasonStats.avg_assists != null ? seasonStats.avg_assists : '暂无';

  const heroTopStr = heroStats
    .slice(0, 5)
    .map((h) => `${h.hero_name}(${fmtRate(h.win_rate)}, ${h.battles}场)`)
    .join('、');

  let context = `【赛季概览 - ${seasonName}】
战队: ${overview.team_name || ''}
胜率: ${winRate}
KDA: ${kda}
总场次: ${totalMatches}
MVP次数: ${mvp}
场均击杀: ${avgKills}
场均死亡: ${avgDeaths}
场均助攻: ${avgAssists}
常用英雄Top5: ${heroTopStr || '暂无'}`;

  if (live) {
    context += `

【本月直播数据 - ${live.month}】
直播天数: ${live.total_sessions}天
总时长: ${live.total_hours}小时
最近直播: ${live.latest_date}`;
  }

  if (schedule) {
    context += `

【赛程数据 - ${schedule.season_name}】`;
    if (schedule.today && schedule.today.length > 0) {
      context += `
今日比赛:
${schedule.today.join('\n')}`;
    }
    if (schedule.upcoming && schedule.upcoming.length > 0) {
      context += `
即将开始的比赛:
${schedule.upcoming.join('\n')}`;
    }
    if (schedule.recent && schedule.recent.length > 0) {
      context += `
最近已完赛的比赛:
${schedule.recent.join('\n')}`;
    }
    if (!schedule.upcoming.length && !schedule.recent.length && !schedule.today.length) {
      context += `
暂无赛程信息`;
    }
  }

  context += `

用户问题：${q}
请基于以上数据回答，数据中没有的就说"暂无相关数据"。`;

  return context;
}

async function callAI(app, systemPrompt, userPrompt) {
  const ai = app.ai();
  const model = ai.createModel('cloudbase');
  const res = await model.generateText({
    model: process.env.AI_MODEL || 'hy3',
    temperature: 0.75,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  });

  if (res && res.usage) {
    console.log('[ask] AI tokens used:', res.usage.total_tokens);
  }

  if (res && res.text) {
    return res.text;
  }
  if (res && res.choices && res.choices.length > 0) {
    const choice = res.choices[0];
    if (choice.message && choice.message.content) {
      return choice.message.content;
    }
  }
  throw new Error('AI response format unexpected');
}

async function getDailyLimit(db, module) {
  const defaultLimit = 10;
  try {
    const res = await db.collection('app_config').doc('ai_limits').get();
    if (res.data && res.data.length > 0) {
      const doc = res.data[0];
      if (module === 'ask') return doc.ask_daily_limit || defaultLimit;
      if (module === 'aiCheer') return doc.cheer_daily_limit || defaultLimit;
    }
  } catch (e) {
    console.warn('[ask] getDailyLimit failed, using default:', e.message);
  }
  return defaultLimit;
}

async function checkUsageLimit(db, module, dailyLimit, subjectId, requestId) {
  const bjNow = getBjDate();
  const y = bjNow.getUTCFullYear();
  const m = String(bjNow.getUTCMonth() + 1).padStart(2, '0');
  const d = String(bjNow.getUTCDate()).padStart(2, '0');
  const today = `${y}-${m}-${d}`;
  const subjectHash = crypto.createHash('sha256').update(String(subjectId)).digest('hex');
  const docId = `${module}_user_${subjectHash}_${today}`;
  const receiptId = `${module}_request_${crypto.createHash('sha256').update(`${subjectId}:${requestId}`).digest('hex')}`;
  try {
    return await db.runTransaction(async (transaction) => {
      const collection = transaction.collection('usage_limits');
      const receiptResult = await collection.doc(receiptId).get();
      if (receiptResult.data && receiptResult.data.length) return true;
      const result = await collection.doc(docId).get();
      const doc = result.data && result.data[0];
      const count = Number((doc && doc.count) || 0);
      if (count >= dailyLimit) return false;
      const now = new Date().toISOString();
      await collection
        .doc(docId)
        .set({ module, dimension: 'user', date: today, count: count + 1, limit: dailyLimit, updated_at: now });
      await collection
        .doc(receiptId)
        .set({ module: `${module}Request`, request_id: requestId, subject_id_hash: subjectHash, created_at: now });
      return true;
    });
  } catch (e) {
    console.error('[ask] usage limit check failed:', e.message);
    throw e;
  }
}

async function recordUsage(_db, _module, _source) {
  // usage count already updated in checkUsageLimit
  return true;
}

async function recordAIReport(db, module, subjectId, userInput, aiOutput, error) {
  try {
    const now = new Date();
    const reportId = crypto.randomUUID();
    await db
      .collection('ai_reports')
      .doc(reportId)
      .set({
        report_id: reportId,
        module,
        status: 'active',
        subject_id: subjectId,
        user_input: userInput,
        ai_output: aiOutput,
        error: error || null,
        timestamp: now.getTime(),
        created_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
  } catch (e) {
    console.warn('[ask] ai report failed:', e.message);
  }
}

function isContentBlocked(text) {
  if (typeof text !== 'string' || !text) return false;
  const configured = String(process.env.BLOCKED_TERMS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return (
    configured.some((term) => text.includes(term)) ||
    [/自杀/u, /博彩/u, /色情/u, /仇恨/u].some((pattern) => pattern.test(text))
  );
}
