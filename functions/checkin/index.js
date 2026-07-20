'use strict';

/**
 * 打卡云函数（checkin）
 *
 * 职责：
 *  - 处理用户每日打卡的创建、查询与统计
 *  - 提供当前用户打卡状态（是否已打卡、连续天数、累计天数）
 *  - 提供今日"加油卡"（AI 报告）的查询
 *  - 基于用户维度与 IP 维度的分钟级限流
 *
 * 路由约定（通过 URL path 区分）：
 *  - OPTIONS *            → CORS 预检
 *  - GET  …/stats         → 当日全局打卡统计
 *  - GET  …/me            → 当前用户打卡摘要
 *  - GET  …/me/report     → 当前用户今日加油卡报告
 *  - POST /api/checkins   → 创建打卡记录
 */

const cloudbase = require('@cloudbase/node-sdk');
// 从 runtime 模块引入公共工具：环境ID、请求解析、鉴权、响应封装等
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
} = require('./runtime');
const { makeCheckinId, computeCheckinSummary } = require('./summary');

// 初始化 CloudBase 应用与数据库实例
const app = cloudbase.init({ env: ENV_ID });
const db = app.database();

/**
 * 云函数入口 —— 处理打卡相关的所有 HTTP 请求
 * @param {object} event - 云函数事件对象，包含 HTTP 请求信息
 * @returns {Promise<object>} 标准化的 HTTP 响应
 */
exports.main = async (event) => {
  const requestId = getRequestId(event);
  const origin = getHeader(event, 'origin');
  // 规范化 HTTP 方法（兼容多种事件格式，默认 POST）
  const method = String(
    event.httpMethod || (event.requestContext && event.requestContext.httpMethod) || 'POST'
  ).toUpperCase();
  const path = getPath(event);

  // CORS 预检请求直接返回
  if (method === 'OPTIONS') return optionsResponse(requestId, origin);

  // 公共统计接口：GET /stats（无需鉴权）
  if (method === 'GET' && path.endsWith('/stats')) {
    try {
      return successResponse(await getStats(), requestId, origin);
    } catch (error) {
      console.error('[checkin] stats failed', error.message);
      return errorResponse(503, 'WRITE_FAILED', '统计服务暂时不可用', requestId, origin);
    }
  }

  // 以下接口均需鉴权：先解析请求体并验证会话身份
  let body;
  try {
    body = parseBody(event);
  } catch (_) {
    return errorResponse(400, 'INVALID_ARGUMENT', '请求体不是合法 JSON', requestId, origin);
  }
  // resolveIdentity 返回 { ok, kind, subjectId }；kind 可能是 session（正式会话）或 legacy（旧版匿名）
  const identity = await resolveIdentity(app, event, body);
  if (!identity.ok) return errorResponse(401, 'SESSION_REQUIRED', '匿名会话无效或已过期', requestId, origin);
  // 非 session 类型且非 legacy 身份 → 视为无效会话
  if (identity.kind !== 'session' && !identity.subjectId.startsWith('legacy:')) {
    return errorResponse(401, 'SESSION_REQUIRED', '打卡需要有效会话', requestId, origin);
  }

  try {
    // GET /me → 查询当前用户今日打卡摘要
    if (method === 'GET' && path.endsWith('/me')) {
      return successResponse(await getMine(identity.subjectId), requestId, origin);
    }
    // GET /me/report → 查询今日"加油卡"AI 报告
    if (method === 'GET' && path.endsWith('/me/report')) {
      const report = await getMyReport(identity.subjectId);
      if (!report) return errorResponse(404, 'NOT_FOUND', '今日还没有生成加油卡', requestId, origin);
      return successResponse(report, requestId, origin);
    }
    // POST /api/checkins → 创建打卡记录
    if (method === 'POST' && /\/api\/checkins\/?$/u.test(path)) {
      // 校验客户端 ID（防重复提交的幂等标识）
      const clientId = normalizeClientId(body.client_id || body._cid || '');
      if (!isValidClientId(clientId))
        return errorResponse(400, 'INVALID_ARGUMENT', 'client_id 不合法', requestId, origin);
      // 客户端不应携带 subject_id / date 等服务端拥有所有权的字段；记录警告但忽略其值
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
      // 限流检查：按用户维度 + IP 维度进行每分钟配额校验
      const rateAllowed = await consumeRequestQuota(identity.subjectId, getClientIp(event));
      if (!rateAllowed) return errorResponse(429, 'RATE_LIMITED', '打卡操作过于频繁', requestId, origin, 60);
      // 鉴权 + 限流通过 → 执行打卡创建（内部带事务 + 幂等）
      return successResponse(await createCheckin(identity.subjectId, body), requestId, origin);
    }
    // 未匹配任何路由
    return errorResponse(404, 'NOT_FOUND', '接口不存在', requestId, origin);
  } catch (error) {
    console.error('[checkin] request failed', { requestId, message: error.message });
    return errorResponse(503, 'WRITE_FAILED', '打卡写入失败，请稍后重试', requestId, origin);
  }
};

/**
 * 获取今日全局打卡统计数据（公开接口，无需鉴权）
 * @returns {Promise<{date: string, today_count: number, updated_at: string}>}
 */
async function getStats() {
  const date = shanghaiDate().date; // 上海时区当日日期
  const result = await db.collection('checkin_daily_stats').doc(date).get();
  const doc = result.data && result.data[0];
  return {
    date,
    today_count: Number((doc && doc.count) || 0),
    updated_at: (doc && doc.updated_at) || new Date().toISOString(),
  };
}

/**
 * 获取当前用户的打卡摘要
 * 并行查询用户表和今日打卡记录，返回是否已打卡、连续天数、累计天数等信息。
 * @param {string} subjectId - 用户唯一标识
 * @returns {Promise<object>}
 */
async function getMine(subjectId) {
  const clock = shanghaiDate();
  // 打卡记录 ID = 用户ID + 日期的哈希（保证同一用户同一天唯一）
  const checkinId = makeCheckinId(subjectId, clock.date);
  // 并行查询用户表（累计/连续）和今日打卡记录
  const [userResult, todayResult] = await Promise.all([
    db.collection('checkin_users').doc(subjectId).get(),
    db.collection('checkins').doc(checkinId).get(),
  ]);
  const user = userResult.data && userResult.data[0];
  const today = todayResult.data && todayResult.data[0];
  const summary = user
    ? { streak: Number(user.streak || 0), total_days: Number(user.total_days || 0) }
    : computeCheckinSummary(await getHistory(subjectId));
  return {
    checked_in_today: Boolean(today),
    streak: summary.streak,
    total_days: summary.total_days,
    ...(today ? { today } : {}), // 今日已打卡则附带完整记录
  };
}

/**
 * 创建打卡记录（核心逻辑）
 *
 * 在事务中完成以下操作：
 *  1. 幂等检查：若今日已打卡则直接返回已有记录
 *  2. 计算连续天数（streak）：上次打卡是昨天则 +1，否则重置为 1
 *  3. 写入打卡记录（checkins 集合）
 *  4. 更新用户累计数据（checkin_users 集合）
 *  5. 更新每日统计计数（checkin_daily_stats 集合）
 *
 * @param {string} subjectId - 用户唯一标识
 * @param {object} body - 请求体，包含 report_id（可选）等字段
 * @returns {Promise<{checkin: object, already_checked_in: boolean, today_count: number}>}
 */
async function createCheckin(subjectId, body) {
  const clock = shanghaiDate();
  const checkinId = makeCheckinId(subjectId, clock.date);
  const initialUserResult = await db.collection('checkin_users').doc(subjectId).get();
  const initialUser = initialUserResult.data && initialUserResult.data[0];
  const historySummary = initialUser ? null : computeCheckinSummary(await getHistory(subjectId));
  return withTransactionRetry(async (transaction) => {
    const checkins = transaction.collection('checkins');
    const users = transaction.collection('checkin_users');
    const stats = transaction.collection('checkin_daily_stats');

    // 幂等检查：同一用户同一天重复提交时返回已有记录，不重复写入
    const existingResult = await checkins.doc(checkinId).get();
    const existing = existingResult.data && existingResult.data[0];
    if (existing) {
      const statResult = await stats.doc(clock.date).get();
      const stat = statResult.data && statResult.data[0];
      return { checkin: existing, already_checked_in: true, today_count: Number((stat && stat.count) || 0) };
    }

    // 计算连续天数：若上次打卡是昨天则 +1，否则重置为 1
    const userResult = await users.doc(subjectId).get();
    const user = userResult.data && userResult.data[0];
    const previousLastDate = user ? user.last_date : historySummary.last_date;
    const previousStreak = user ? Number(user.streak || 0) : historySummary.streak;
    const previousTotalDays = user ? Number(user.total_days || 0) : historySummary.total_days;
    const streak = previousLastDate === clock.yesterday ? previousStreak + 1 : 1;
    const totalDays = previousTotalDays + 1;
    const now = new Date().toISOString();

    // 构建打卡记录
    const checkin = {
      subject_id: subjectId,
      date: clock.date,
      tz: 'Asia/Shanghai',
      streak,
      total_days: totalDays,
      report_id: typeof body.report_id === 'string' ? body.report_id.slice(0, 80) : '', // 截断防止超长
      created_at: now,
      updated_at: now,
    };

    // 写入打卡记录
    await checkins.doc(checkinId).set(checkin);
    // 更新用户表（保留原始 created_at）
    await users.doc(subjectId).set({
      last_date: clock.date,
      streak,
      total_days: totalDays,
      created_at: (user && user.created_at) || now,
      updated_at: now,
    });
    // 更新当日全局统计计数 +1
    const statResult = await stats.doc(clock.date).get();
    const stat = statResult.data && statResult.data[0];
    const todayCount = Number((stat && stat.count) || 0) + 1;
    await stats.doc(clock.date).set({ date: clock.date, count: todayCount, updated_at: now });

    return { checkin, already_checked_in: false, today_count: todayCount };
  });
}

async function getHistory(subjectId) {
  const records = [];
  const pageSize = 100;
  for (let offset = 0; ; offset += pageSize) {
    const result = await db.collection('checkins').where({ subject_id: subjectId }).skip(offset).limit(pageSize).get();
    const page = Array.isArray(result.data) ? result.data : [];
    records.push(...page);
    if (page.length < pageSize) return records;
  }
}

/**
 * 消费请求配额（限流检查）
 *
 * 在事务中同时对"用户维度"和"IP维度"两个限额进行原子检查与自增，
 * 确保在并发场景下也不会超出限制。
 *
 * 限制规则（每分钟刷新）：
 *  - 用户维度：每分钟最多 10 次（防止单用户刷量）
 *  - IP 维度：每分钟最多 60 次（防止多用户共IP刷量）
 *
 * @param {string} subjectId - 用户唯一标识
 * @param {string} ip - 客户端 IP 地址
 * @returns {Promise<boolean>} true=允许请求，false=已超限
 */
async function consumeRequestQuota(subjectId, ip) {
  // minute 截取到分钟（如 "2024-01-15T10:30"），用作配额时间窗 key 的一部分
  const minute = new Date().toISOString().slice(0, 16);
  // 两个维度的限流项：
  //  - 用户维度：按 subjectId 哈希分桶，每分钟 10 次
  //  - IP 维度：用 IP_HASH_SALT 加盐哈希（保护隐私），每分钟 60 次
  const limits = [
    { id: `checkin_user_${hashValue(subjectId)}_${minute}`, limit: 10, dimension: 'user' },
    { id: `checkin_ip_${hashValue(ip, process.env.IP_HASH_SALT || ENV_ID)}_${minute}`, limit: 60, dimension: 'ip' },
  ];
  // 在事务内完成"读检查 → 写自增"，保证并发安全
  return db.runTransaction(async (transaction) => {
    const collection = transaction.collection('usage_limits');
    const current = [];
    // 第一步：遍历所有维度，检查是否已超限
    for (const item of limits) {
      const result = await collection.doc(item.id).get();
      const doc = result.data && result.data[0];
      const count = Number((doc && doc.count) || 0);
      if (count >= item.limit) return false; // 任一维度超限 → 拒绝
      current.push({ ...item, count });
    }
    // 第二步：全部维度通过 → 各维度计数 +1
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

/**
 * 事务重试包装器
 * 在并发冲突等可恢复错误时自动重试，最多尝试 4 次，
 * 每次重试间隔递增（25ms → 50ms → 75ms）。
 *
 * @param {Function} work - 事务工作函数，接收 transaction 参数
 * @returns {Promise<*>} work 函数的返回值
 */
async function withTransactionRetry(work) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await db.runTransaction(work);
    } catch (error) {
      lastError = error;
      // 前 3 次失败后等待递增延迟再重试
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError; // 4 次全部失败 → 抛出最后一个错误
}

/**
 * 获取当前用户的今日"加油卡"（AI 报告）
 *
 * 流程：
 *  1. 先查今日打卡记录，取出关联的 report_id
 *  2. 根据 report_id 查 AI 报告集合（ai_reports）
 *  3. 进行归属校验（仅本人可见）
 *
 * @param {string} subjectId - 用户唯一标识
 * @param {object} [database=db] - 数据库实例（可注入，便于测试）
 * @returns {Promise<object|null>} 报告内容；未打卡或无报告或归属不匹配时返回 null
 */
async function getMyReport(subjectId, database = db) {
  const clock = shanghaiDate();
  const checkinId = makeCheckinId(subjectId, clock.date);
  // 查今日打卡记录 → 取其关联的 report_id
  const todayResult = await database.collection('checkins').doc(checkinId).get();
  const today = todayResult.data && todayResult.data[0];
  const reportId = today && typeof today.report_id === 'string' ? today.report_id : '';
  if (!reportId) return null; // 今日未打卡或打卡时无报告

  // 查 AI 报告集合
  const reportResult = await database.collection('ai_reports').doc(reportId).get();
  const doc = reportResult.data && reportResult.data[0];
  if (!doc) return null;
  // 归属校验：报告必须属于当前用户；不一致时按"未找到"处理（防止越权）
  if (doc.subject_id !== subjectId) return null;

  // 提取并规范化 AI 输出字段
  const output = doc.ai_output || {};
  return {
    lines: Array.isArray(output.lines) ? output.lines : [], // 报告文本行数组
    emoji_caption: typeof output.emoji_caption === 'string' ? output.emoji_caption : '', // emoji 标题
    report_id: doc.report_id,
    refs: Array.isArray(output.refs) ? output.refs : [], // 引用来源列表
    source_snapshot_at: typeof doc.source_snapshot_at === 'string' ? doc.source_snapshot_at : '', // 快照时间
  };
}

/**
 * 从云函数事件中提取请求路径
 * 兼容多种网关格式（requestContext.path / rawPath / path），
 * 回退时使用查询参数 __path，最终默认为 /api/checkins。
 * 返回值会去掉末尾的斜杠。
 *
 * @param {object} event - 云函数事件对象
 * @returns {string} 规范化后的路径
 */
function getPath(event) {
  // 按优先级排列的候选路径来源
  const candidates = [event.requestContext && event.requestContext.path, event.rawPath, event.path];
  const path = candidates.find((value) => typeof value === 'string' && value.startsWith('/') && value !== '/');
  if (path) return path.replace(/\/$/u, ''); // 去除末尾斜杠
  // 回退：从查询参数 __path 获取
  const query = getQuery(event);
  return typeof query.__path === 'string' ? query.__path.replace(/\/$/u, '') : '/api/checkins';
}

// 导出内部函数用于单元测试
exports.__test = { getPath, shanghaiDate, getMyReport };
