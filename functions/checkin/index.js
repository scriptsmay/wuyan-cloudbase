'use strict';

const cloudbase = require('@cloudbase/node-sdk');
const {
  ENV_ID,
  parseBody,
  getQuery,
  getHeader,
  resolveIdentity,
  successResponse,
  errorResponse,
  optionsResponse,
  getRequestId,
  getClientIp,
  shanghaiDate,
  normalizeClientId,
  isValidClientId,
  hashValue,
} = require('./runtime');

const app = cloudbase.init({ env: ENV_ID });
const db = app.database();

exports.main = async (event) => {
  const requestId = getRequestId(event);
  const origin = getHeader(event, 'origin');
  const method = String(
    event.httpMethod || (event.requestContext && event.requestContext.httpMethod) || 'POST'
  ).toUpperCase();
  const path = getPath(event);
  if (method === 'OPTIONS') return optionsResponse(requestId, origin);

  if (method === 'GET' && path.endsWith('/stats')) {
    try {
      return successResponse(await getStats(), requestId, origin);
    } catch (error) {
      console.error('[checkin] stats failed', error.message);
      return errorResponse(503, 'WRITE_FAILED', '统计服务暂时不可用', requestId, origin);
    }
  }

  let body;
  try {
    body = parseBody(event);
  } catch (_) {
    return errorResponse(400, 'INVALID_ARGUMENT', '请求体不是合法 JSON', requestId, origin);
  }
  const identity = await resolveIdentity(app, event, body);
  if (!identity.ok) return errorResponse(401, 'SESSION_REQUIRED', '匿名会话无效或已过期', requestId, origin);
  if (identity.kind !== 'session' && !identity.subjectId.startsWith('legacy:')) {
    return errorResponse(401, 'SESSION_REQUIRED', '打卡需要有效会话', requestId, origin);
  }

  try {
    if (method === 'GET' && path.endsWith('/me')) {
      return successResponse(await getMine(identity.subjectId), requestId, origin);
    }
    if (method === 'GET' && path.endsWith('/me/report')) {
      const report = await getMyReport(identity.subjectId);
      if (!report) return errorResponse(404, 'NOT_FOUND', '今日还没有生成加油卡', requestId, origin);
      return successResponse(report, requestId, origin);
    }
    if (method === 'POST' && /\/api\/checkins\/?$/u.test(path)) {
      const clientId = normalizeClientId(body.client_id || body._cid || '');
      if (!isValidClientId(clientId))
        return errorResponse(400, 'INVALID_ARGUMENT', 'client_id 不合法', requestId, origin);
      if (
        Object.prototype.hasOwnProperty.call(body, 'subject_id') ||
        Object.prototype.hasOwnProperty.call(body, 'date')
      ) {
        console.warn('[checkin] ignored client-owned fields', {
          requestId,
          hasSubjectId: 'subject_id' in body,
          hasDate: 'date' in body,
        });
      }
      const rateAllowed = await consumeRequestQuota(identity.subjectId, getClientIp(event));
      if (!rateAllowed) return errorResponse(429, 'RATE_LIMITED', '打卡操作过于频繁', requestId, origin, 60);
      return successResponse(await createCheckin(identity.subjectId, body), requestId, origin);
    }
    return errorResponse(404, 'NOT_FOUND', '接口不存在', requestId, origin);
  } catch (error) {
    console.error('[checkin] request failed', { requestId, message: error.message });
    return errorResponse(503, 'WRITE_FAILED', '打卡写入失败，请稍后重试', requestId, origin);
  }
};

async function getStats() {
  const date = shanghaiDate().date;
  const result = await db.collection('checkin_daily_stats').doc(date).get();
  const doc = result.data && result.data[0];
  return {
    date,
    today_count: Number((doc && doc.count) || 0),
    updated_at: (doc && doc.updated_at) || new Date().toISOString(),
  };
}

async function getMine(subjectId) {
  const clock = shanghaiDate();
  const checkinId = hashValue(`${subjectId}:${clock.date}`);
  const [userResult, todayResult] = await Promise.all([
    db.collection('checkin_users').doc(subjectId).get(),
    db.collection('checkins').doc(checkinId).get(),
  ]);
  const user = userResult.data && userResult.data[0];
  const today = todayResult.data && todayResult.data[0];
  return {
    checked_in_today: Boolean(today),
    streak: Number((user && user.streak) || 0),
    total_days: Number((user && user.total_days) || 0),
    ...(today ? { today } : {}),
  };
}

async function createCheckin(subjectId, body) {
  const clock = shanghaiDate();
  const checkinId = hashValue(`${subjectId}:${clock.date}`);
  return withTransactionRetry(async (transaction) => {
    const checkins = transaction.collection('checkins');
    const users = transaction.collection('checkin_users');
    const stats = transaction.collection('checkin_daily_stats');
    const existingResult = await checkins.doc(checkinId).get();
    const existing = existingResult.data && existingResult.data[0];
    if (existing) {
      const statResult = await stats.doc(clock.date).get();
      const stat = statResult.data && statResult.data[0];
      return { checkin: existing, already_checked_in: true, today_count: Number((stat && stat.count) || 0) };
    }

    const userResult = await users.doc(subjectId).get();
    const user = userResult.data && userResult.data[0];
    const streak = user && user.last_date === clock.yesterday ? Number(user.streak || 0) + 1 : 1;
    const totalDays = Number((user && user.total_days) || 0) + 1;
    const now = new Date().toISOString();
    const checkin = {
      subject_id: subjectId,
      date: clock.date,
      tz: 'Asia/Shanghai',
      streak,
      total_days: totalDays,
      report_id: typeof body.report_id === 'string' ? body.report_id.slice(0, 80) : '',
      created_at: now,
      updated_at: now,
    };
    await checkins.doc(checkinId).set(checkin);
    await users.doc(subjectId).set({
      last_date: clock.date,
      streak,
      total_days: totalDays,
      created_at: (user && user.created_at) || now,
      updated_at: now,
    });
    const statResult = await stats.doc(clock.date).get();
    const stat = statResult.data && statResult.data[0];
    const todayCount = Number((stat && stat.count) || 0) + 1;
    await stats.doc(clock.date).set({ date: clock.date, count: todayCount, updated_at: now });
    return { checkin, already_checked_in: false, today_count: todayCount };
  });
}

async function consumeRequestQuota(subjectId, ip) {
  const minute = new Date().toISOString().slice(0, 16);
  const limits = [
    { id: `checkin_user_${hashValue(subjectId)}_${minute}`, limit: 10, dimension: 'user' },
    { id: `checkin_ip_${hashValue(ip, process.env.IP_HASH_SALT || ENV_ID)}_${minute}`, limit: 60, dimension: 'ip' },
  ];
  return db.runTransaction(async (transaction) => {
    const collection = transaction.collection('usage_limits');
    const current = [];
    for (const item of limits) {
      const result = await collection.doc(item.id).get();
      const doc = result.data && result.data[0];
      const count = Number((doc && doc.count) || 0);
      if (count >= item.limit) return false;
      current.push({ ...item, count });
    }
    const now = new Date().toISOString();
    for (const item of current) {
      await collection.doc(item.id).set({
        module: 'checkin',
        dimension: item.dimension,
        minute,
        count: item.count + 1,
        limit: item.limit,
        updated_at: now,
      });
    }
    return true;
  });
}

async function withTransactionRetry(work) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await db.runTransaction(work);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function getMyReport(subjectId, database = db) {
  const clock = shanghaiDate();
  const checkinId = hashValue(`${subjectId}:${clock.date}`);
  const todayResult = await database.collection('checkins').doc(checkinId).get();
  const today = todayResult.data && todayResult.data[0];
  const reportId = today && typeof today.report_id === 'string' ? today.report_id : '';
  if (!reportId) return null;
  const reportResult = await database.collection('ai_reports').doc(reportId).get();
  const doc = reportResult.data && reportResult.data[0];
  if (!doc) return null;
  // 仅本人可见：归属校验失败时当未找到处理
  if (doc.subject_id !== subjectId) return null;
  const output = doc.ai_output || {};
  return {
    lines: Array.isArray(output.lines) ? output.lines : [],
    emoji_caption: typeof output.emoji_caption === 'string' ? output.emoji_caption : '',
    report_id: doc.report_id,
    refs: Array.isArray(output.refs) ? output.refs : [],
    source_snapshot_at: typeof doc.source_snapshot_at === 'string' ? doc.source_snapshot_at : '',
  };
}

function getPath(event) {
  const candidates = [event.requestContext && event.requestContext.path, event.rawPath, event.path];
  const path = candidates.find((value) => typeof value === 'string' && value.startsWith('/') && value !== '/');
  if (path) return path.replace(/\/$/u, '');
  const query = getQuery(event);
  return typeof query.__path === 'string' ? query.__path.replace(/\/$/u, '') : '/api/checkins';
}

exports.__test = { getPath, shanghaiDate, getMyReport };
