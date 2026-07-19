'use strict';

const cloudbase = require('@cloudbase/node-sdk');
const {
  parseBody,
  getHeader,
  getPath,
  getRequestId,
  resolveIdentity,
  hashTicket,
  createTicket,
  transferExpiry,
  isExpired,
  successResponse,
  errorResponse,
  jsonResponse,
} = require('./runtime');

const ENV_ID = process.env.TCB_ENV || 'trial-sh-d1gqznm4577d6a062';
const app = cloudbase.init({ env: ENV_ID });
const db = app.database();

exports.main = async (event) => {
  const requestId = getRequestId(event);
  const origin = getHeader(event, 'origin');
  const method = String(
    event.httpMethod || (event.requestContext && event.requestContext.httpMethod) || 'GET'
  ).toUpperCase();
  if (method === 'OPTIONS') return jsonResponse(204, null, requestId, origin);
  const path = getPath(event);
  let body;
  try {
    body = parseBody(event);
  } catch (_) {
    return errorResponse(400, 'INVALID_ARGUMENT', '请求体不是合法 JSON', requestId, origin);
  }

  try {
    if (method === 'GET' && path.endsWith('/me')) return await me(event, body, requestId, origin);
    if (method === 'POST' && path.endsWith('/transfer/start')) return await start(event, body, requestId, origin);
    if (method === 'POST' && path.endsWith('/transfer/complete')) return await complete(event, body, requestId, origin);
    return errorResponse(404, 'NOT_FOUND', '认证接口不存在', requestId, origin);
  } catch (error) {
    console.error('[auth] request failed', { requestId, message: error.message });
    return errorResponse(503, 'WRITE_FAILED', '认证服务暂时不可用，请稍后重试', requestId, origin);
  }
};

async function me(event, body, requestId, origin) {
  const identity = await requireIdentity(event, body);
  if (!identity.ok) return errorResponse(401, 'SESSION_REQUIRED', '会话无效或已过期', requestId, origin);
  const user = identity.tokenInfo && identity.tokenInfo.user;
  return successResponse(
    {
      uid: identity.subjectId,
      username: typeof user?.username === 'string' ? user.username : '',
      mode: identity.isAnonymous ? 'anonymous' : 'authenticated',
    },
    requestId,
    origin
  );
}

async function start(event, body, requestId, origin) {
  const identity = await requireIdentity(event, body);
  if (!identity.ok) return errorResponse(401, 'SESSION_REQUIRED', '会话无效或已过期', requestId, origin);
  if (!identity.isAnonymous)
    return errorResponse(409, 'TRANSFER_NOT_ANONYMOUS', '当前已经是正式账号，无需迁移', requestId, origin);

  const ticket = createTicket();
  const transferId = `transfer_${hashTicket(ticket).slice(0, 32)}`;
  const now = new Date().toISOString();
  await db
    .collection('auth_transfers')
    .doc(transferId)
    .set({
      source_uid: identity.subjectId,
      ticket_hash: hashTicket(ticket),
      status: 'pending',
      expires_at: transferExpiry(),
      created_at: now,
      updated_at: now,
    });
  return successResponse(
    { transfer_id: transferId, ticket, expires_at: transferExpiry(), source_uid: identity.subjectId },
    requestId,
    origin
  );
}

async function complete(event, body, requestId, origin) {
  const identity = await requireIdentity(event, body);
  if (!identity.ok || identity.isAnonymous)
    return errorResponse(401, 'AUTHENTICATED_SESSION_REQUIRED', '请先使用正式账号登录', requestId, origin);
  const ticket = typeof body.ticket === 'string' ? body.ticket.trim() : '';
  if (!/^[A-Za-z0-9_-]{40,100}$/u.test(ticket))
    return errorResponse(400, 'INVALID_ARGUMENT', '迁移票据无效', requestId, origin);

  const transferId = `transfer_${hashTicket(ticket).slice(0, 32)}`;
  const transferResult = await db.collection('auth_transfers').doc(transferId).get();
  const transfer = transferResult.data && transferResult.data[0];
  if (!transfer || transfer.ticket_hash !== hashTicket(ticket))
    return errorResponse(404, 'TRANSFER_NOT_FOUND', '迁移票据不存在或已失效', requestId, origin);
  if (isExpired(transfer.expires_at))
    return errorResponse(410, 'TRANSFER_EXPIRED', '迁移票据已过期，请重新登录', requestId, origin);
  if (transfer.status === 'completed') return successResponse(transfer.result, requestId, origin);
  if (transfer.status === 'processing')
    return errorResponse(409, 'TRANSFER_IN_PROGRESS', '迁移正在处理中，请稍后刷新', requestId, origin);
  if (transfer.target_uid && transfer.target_uid !== identity.subjectId)
    return errorResponse(409, 'TRANSFER_TARGET_MISMATCH', '迁移票据与当前账号不匹配', requestId, origin);

  await db
    .collection('auth_transfers')
    .doc(transferId)
    .update({ status: 'processing', target_uid: identity.subjectId, updated_at: new Date().toISOString() });
  try {
    const result = await migrateData(transfer.source_uid, identity.subjectId);
    const completedAt = new Date().toISOString();
    const payload = { transfer_id: transferId, migrated: result, completed_at: completedAt };
    await db
      .collection('auth_transfers')
      .doc(transferId)
      .update({ status: 'completed', result: payload, completed_at: completedAt, updated_at: completedAt });
    return successResponse(payload, requestId, origin);
  } catch (error) {
    await db
      .collection('auth_transfers')
      .doc(transferId)
      .update({ status: 'pending', updated_at: new Date().toISOString() });
    throw error;
  }
}

async function requireIdentity(event, body) {
  return resolveIdentity(event, body);
}

async function migrateData(sourceUid, targetUid) {
  if (!sourceUid || !targetUid || sourceUid === targetUid) return { checkins: 0, users: 0, ai_reports: 0 };
  const checkinResult = await db.collection('checkins').where({ subject_id: sourceUid }).get();
  const sourceCheckins = Array.isArray(checkinResult.data) ? checkinResult.data : [];
  let migratedCheckins = 0;
  for (const source of sourceCheckins) {
    const targetId = hashValue(`${targetUid}:${source.date}`);
    const targetResult = await db.collection('checkins').doc(targetId).get();
    const target = targetResult.data && targetResult.data[0];
    if (!target) {
      const { _id: ignoredId, ...sourceFields } = source;
      void ignoredId;
      await db
        .collection('checkins')
        .doc(targetId)
        .set({ ...sourceFields, subject_id: targetUid });
      migratedCheckins += 1;
    }
    if (source._id && source._id !== targetId) await db.collection('checkins').doc(source._id).remove();
  }

  const sourceUserResult = await db.collection('checkin_users').doc(sourceUid).get();
  const sourceUser = sourceUserResult.data && sourceUserResult.data[0];
  if (sourceUser) {
    const targetUserResult = await db.collection('checkin_users').doc(targetUid).get();
    const targetUser = targetUserResult.data && targetUserResult.data[0];
    const now = new Date().toISOString();
    await db
      .collection('checkin_users')
      .doc(targetUid)
      .set({
        ...(targetUser || {}),
        last_date: [targetUser && targetUser.last_date, sourceUser.last_date].filter(Boolean).sort().pop() || '',
        streak: Math.max(Number((targetUser && targetUser.streak) || 0), Number(sourceUser.streak || 0)),
        total_days: Math.max(Number((targetUser && targetUser.total_days) || 0), Number(sourceUser.total_days || 0)),
        created_at: (targetUser && targetUser.created_at) || sourceUser.created_at || now,
        updated_at: now,
      });
    await db.collection('checkin_users').doc(sourceUid).remove();
  }

  const reportResult = await db.collection('ai_reports').where({ subject_id: sourceUid }).get();
  const reports = Array.isArray(reportResult.data) ? reportResult.data : [];
  for (const report of reports) {
    if (report._id)
      await db
        .collection('ai_reports')
        .doc(report._id)
        .update({ subject_id: targetUid, updated_at: new Date().toISOString() });
  }
  return { checkins: migratedCheckins, users: sourceUser ? 1 : 0, ai_reports: reports.length };
}

function hashValue(value) {
  return require('node:crypto').createHash('sha256').update(`${ENV_ID}:${value}`).digest('hex');
}

exports.__test = { migrateData, isAnonymousTokenInfo: require('./runtime').isAnonymousTokenInfo };
