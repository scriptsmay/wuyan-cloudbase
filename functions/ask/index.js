const crypto = require('crypto')
const cloudbase = require('@cloudbase/node-sdk')

const CACHE_TTL = 5 * 60 * 1000
const DAILY_LIMIT = 500

exports.main = async (event, context) => {
  const app = cloudbase.init({ env: cloudbase.SYMBOL_DEFAULT_ENV })
  const db = app.database()

  const body = parseBody(event)
  const token = (event.queryStringParameters && event.queryStringParameters.token) || body.token || ''
  const AUTH_TOKEN = process.env.AUTH_TOKEN
  if (!AUTH_TOKEN || token !== AUTH_TOKEN) {
    return jsonResp(401, { code: 401, message: 'Unauthorized', data: null })
  }

  const q = (body.q || '').trim()
  if (!q) {
    return jsonResp(400, { code: 400, message: '问题不能为空', data: null })
  }

  try {
    const limitOk = await checkUsageLimit(db, 'ask', DAILY_LIMIT)
    if (!limitOk) {
      return jsonResp(429, { code: 429, message: '今日 AI 调用已达上限，请明日再来', data: null })
    }

    const cacheKey = md5(normalize(q))
    const cached = await getCache(db, cacheKey)
    if (cached) {
      await recordUsage(db, 'ask', 'cache')
      return jsonResp(200, { code: 200, message: 'ok', data: cached })
    }

    const { overviewData, liveData, refs } = await fetchContextData(db)
    if (!overviewData) {
      return jsonResp(404, { code: 404, message: '暂无相关数据', data: null })
    }

    const systemPrompt = buildSystemPrompt(overviewData, liveData)
    const userPrompt = buildUserPrompt(q, overviewData, liveData)

    let answer = ''
    try {
      answer = await callAI(app, systemPrompt, userPrompt)
    } catch (aiErr) {
      console.error('[ask] AI call failed:', aiErr.message)
      await recordAIReport(db, 'ask', q, '', aiErr.message)
      return jsonResp(503, { code: 503, message: '小秘书暂时开小差，稍后再试～', data: null })
    }

    const result = { answer, refs }
    await setCache(db, cacheKey, q, normalize(q), result)
    await recordUsage(db, 'ask', 'ai')
    await recordAIReport(db, 'ask', q, answer, '')

    return jsonResp(200, { code: 200, message: 'ok', data: result })
  } catch (err) {
    console.error('[ask] Error:', err.message, err.stack)
    return jsonResp(500, { code: 500, message: err.message, data: null })
  }
}

function parseBody(event) {
  if (event.body) {
    try {
      if (event.isBase64Encoded) {
        const buf = Buffer.from(event.body, 'base64')
        return JSON.parse(buf.toString('utf-8'))
      }
      return typeof event.body === 'string' ? JSON.parse(event.body) : event.body
    } catch (_) {
      return {}
    }
  }
  return {}
}

function jsonResp(statusCode, data) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(data)
  }
}

function normalize(q) {
  return q.toLowerCase().replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').replace(/\s+/g, '')
}

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex')
}

async function getCache(db, cacheKey) {
  try {
    const res = await db.collection('ask_cache').doc(cacheKey).get()
    if (res.data && res.data.length > 0) {
      const doc = res.data[0]
      if (doc.expires_at > Date.now()) {
        return { answer: doc.answer, refs: doc.refs || [] }
      }
      await db.collection('ask_cache').doc(cacheKey).remove()
    }
  } catch (_) {}
  return null
}

async function setCache(db, cacheKey, q, normalizedQ, result) {
  try {
    const now = Date.now()
    const doc = {
      _id: cacheKey,
      q,
      normalized_q: normalizedQ,
      answer: result.answer,
      refs: result.refs || [],
      created_at: now,
      expires_at: now + CACHE_TTL
    }
    await db.collection('ask_cache').add(doc)
  } catch (e) {
    console.warn('[ask] cache set failed:', e.message)
  }
}

async function fetchContextData(db) {
  const refs = []
  let overviewData = null
  let liveData = null

  try {
    const ovRes = await db.collection('season_summaries')
      .orderBy('updated_at', 'desc')
      .limit(1)
      .get()
    if (ovRes.data.length > 0) {
      overviewData = ovRes.data[0]
      refs.push('当前赛季概览')
    }
  } catch (e) {
    console.warn('[ask] fetch overview failed:', e.message)
  }

  try {
    const now = new Date()
    const year = now.getFullYear()
    const month = now.getMonth() + 1
    const liveRes = await db.collection('live_streams')
      .where({ year, month })
      .orderBy('stream_date', 'desc')
      .limit(30)
      .get()
    const streams = (liveRes.data || []).filter(s => s.type !== 'monthly_summary')
    if (streams.length > 0) {
      const totalHours = Math.round(streams.reduce((s, x) => s + (x.duration || 0), 0) / 360) / 10
      liveData = {
        month: `${year}-${String(month).padStart(2, '0')}`,
        total_sessions: streams.length,
        total_hours: totalHours,
        latest_date: streams[0].stream_date
      }
      refs.push('本月直播数据')
    }
  } catch (e) {
    console.warn('[ask] fetch live failed:', e.message)
  }

  return { overviewData, liveData, refs }
}

function buildSystemPrompt(overview, live) {
  const player = overview.player_name || '无言'
  const team = overview.team_name || ''
  return `你是${player}的贴身小秘书，语气亲切活泼，带粉圈感。
你只基于下面提供的 JSON 数据回答问题，数据中没有的内容要明确说"暂无相关数据"，绝对不能编造数据。
回答要简短自然，用口语化的中文，不要太正式。
当前选手：${player}，所属战队：${team}。`
}

function buildUserPrompt(q, overview, live) {
  const data = overview.data || {}
  const season = overview.season_name || overview.season || ''
  const summary = data.career_summary || {}
  const heroTop = data.hero_top || []
  const heroTopStr = heroTop.slice(0, 5).map(h => `${h.hero_name}(${h.win_rate}胜率, ${h.battles}场)`).join('、')

  let context = `【赛季概览 - ${season}】
战队: ${overview.team_name || ''}
胜率: ${summary.win_rate != null ? summary.win_rate : '暂无'}
KDA: ${summary.kda_ratio != null ? summary.kda_ratio : '暂无'}
总场次: ${summary.total_matches != null ? summary.total_matches : '暂无'}
MVP次数: ${summary.mvp_count != null ? summary.mvp_count : '暂无'}
场均击杀: ${summary.avg_kills != null ? summary.avg_kills : '暂无'}
场均死亡: ${summary.avg_deaths != null ? summary.avg_deaths : '暂无'}
场均助攻: ${summary.avg_assists != null ? summary.avg_assists : '暂无'}
常用英雄Top5: ${heroTopStr || '暂无'}`

  if (live) {
    context += `

【本月直播数据 - ${live.month}】
直播天数: ${live.total_sessions}天
总时长: ${live.total_hours}小时
最近直播: ${live.latest_date}`
  }

  context += `

用户问题：${q}
请基于以上数据回答，数据中没有的就说"暂无相关数据"。`

  return context
}

async function callAI(app, systemPrompt, userPrompt) {
  const ai = app.ai()
  const res = await ai.run({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    model: process.env.AI_MODEL || 'default',
    stream: false
  })

  if (res && res.choices && res.choices.length > 0) {
    const choice = res.choices[0]
    if (choice.message && choice.message.content) {
      return choice.message.content
    }
    if (choice.text) {
      return choice.text
    }
  }
  if (res && res.content) {
    return res.content
  }
  throw new Error('AI response format unexpected')
}

async function checkUsageLimit(db, module, dailyLimit) {
  const today = new Date().toISOString().split('T')[0]
  const docId = `${module}_${today}`
  try {
    const res = await db.collection('usage_limits').doc(docId).get()
    if (res.data && res.data.length > 0) {
      const doc = res.data[0]
      if (doc.count >= dailyLimit) {
        return false
      }
      await db.collection('usage_limits').doc(docId).update({ count: doc.count + 1 })
    } else {
      await db.collection('usage_limits').add({
        _id: docId,
        module,
        date: today,
        count: 1,
        limit: dailyLimit,
        created_at: Date.now()
      })
    }
    return true
  } catch (e) {
    console.warn('[ask] usage limit check failed, allowing:', e.message)
    return true
  }
}

async function recordUsage(db, module, source) {
  // usage count already updated in checkUsageLimit
  return true
}

async function recordAIReport(db, module, userInput, aiOutput, error) {
  try {
    await db.collection('ai_reports').add({
      module,
      user_input: userInput,
      ai_output: aiOutput,
      error: error || null,
      timestamp: Date.now(),
      created_at: new Date().toISOString()
    })
  } catch (e) {
    console.warn('[ask] ai report failed:', e.message)
  }
}
