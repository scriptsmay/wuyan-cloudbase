// sync-schedule-live — 比赛日高频增量赛程同步
//
// 触发器：每 10 分钟一次（cron: 0 */10 * * * * *）
// 仅在比赛活跃窗口内请求 KPL 官方 API，按 schedule_id 增量合并到 match_schedules。
// 窗口外直接 return，不请求外部 API，不写 sync_snapshots。
const cloudbase = require('@cloudbase/node-sdk');
const {
  computeWindowStatus,
  fetchKplScheduleList,
  convertKplMatches,
  mergeScheduleMatches,
  recordSyncSnapshot,
} = require('./lib/schedule-merge');

exports.main = async (_event, _context) => {
  const envId = process.env.TCB_ENV;
  if (!envId) {
    console.error('[sync-schedule-live] TCB_ENV not configured');
    return { status: 'error', error: 'TCB_ENV not configured' };
  }

  const app = cloudbase.init({ env: envId });
  const db = app.database();

  const result = {
    status: 'pending',
    window_active: false,
    matched_count: 0,
    changed_count: 0,
    error: null,
  };

  try {
    // 1. 读取最新赛季文档
    const existing = await db.collection('match_schedules').orderBy('updated_at', 'desc').limit(1).get();

    if (existing.data.length === 0) {
      console.log('[sync-schedule-live] No match_schedules document found, skip');
      result.status = 'skipped';
      result.error = 'no match_schedules document';
      return result;
    }

    const doc = existing.data[0];
    const seasonId = doc.season_id;
    const matches = doc.matches || [];

    console.log(`[sync-schedule-live] Season: ${seasonId}, matches: ${matches.length}`);

    // 2. 计算窗口状态（纯函数，不依赖外部 API）
    const windowStatus = computeWindowStatus(matches);
    result.window_active = windowStatus.window_active;
    result.computed_at = windowStatus.computed_at;

    if (!windowStatus.window_active) {
      console.log(`[sync-schedule-live] Not in match window (${windowStatus.computed_at}), skip external API call`);
      result.status = 'skipped';
      result.reason = 'window_not_active';
      return result;
    }

    console.log(
      `[sync-schedule-live] Match window active (${windowStatus.active_count} matches), fetching KPL schedule...`
    );

    // 3. 调用 KPL 官方 API
    let rawMatches;
    try {
      rawMatches = await fetchKplScheduleList(seasonId, 15000);
    } catch (apiErr) {
      console.error(`[sync-schedule-live] KPL API error: ${apiErr.message}`);
      result.status = 'error';
      result.error = `KPL API: ${apiErr.message}`;

      await recordSyncSnapshot(db, {
        type: 'schedule-live',
        season: seasonId,
        status: 'error',
        windowActive: true,
        error: apiErr.message,
      });
      return result;
    }

    if (!Array.isArray(rawMatches) || rawMatches.length === 0) {
      console.warn('[sync-schedule-live] KPL API returned empty list, preserving existing data');
      result.status = 'skipped';
      result.error = 'KPL API empty list';

      await recordSyncSnapshot(db, {
        type: 'schedule-live',
        season: seasonId,
        status: 'skipped',
        windowActive: true,
        error: 'KPL API empty list',
      });
      return result;
    }

    // 4. 转换为 canonical 格式，过滤 KSG
    const sourceFetchedAt = new Date().toISOString();
    const { matches: ksgMatches } = convertKplMatches(rawMatches, seasonId);

    // 5. 事务合并
    const mergeResult = await mergeScheduleMatches(db, seasonId, ksgMatches, {
      isFullSync: false,
      isLive: true,
      sourceFetchedAt,
      sourceStatus: 'ok',
      maxRetries: 3,
    });

    result.status = mergeResult.action === 'no_change' ? 'no_change' : 'success';
    result.matched_count = mergeResult.matchedCount;
    result.changed_count = mergeResult.changedCount;
    result.revision = mergeResult.revision;
    result.fallback_used = mergeResult.fallbackUsed || false;

    console.log(
      `[sync-schedule-live] Done: action=${mergeResult.action}, ` +
        `matched=${mergeResult.matchedCount}, changed=${mergeResult.changedCount}, ` +
        `revision=${mergeResult.revision}, fallback=${mergeResult.fallbackUsed || false}`
    );

    // 6. 写入快照（比赛窗口内成功/失败/兼容匹配时写快照）
    await recordSyncSnapshot(db, {
      type: 'schedule-live',
      season: seasonId,
      status: result.status,
      matchedCount: mergeResult.matchedCount,
      changedCount: mergeResult.changedCount,
      windowActive: true,
      sourceFetchedAt,
      error: result.fallback_used ? 'fallback merge key used' : null,
    });
  } catch (err) {
    console.error(`[sync-schedule-live] Error: ${err.message}`, err.stack);
    result.status = 'error';
    result.error = err.message;

    try {
      await recordSyncSnapshot(db, {
        type: 'schedule-live',
        season: result.season || 'unknown',
        status: 'error',
        windowActive: result.window_active || false,
        error: err.message,
      });
    } catch (_) {
      // 快照写入失败不阻塞主流程
    }
  }

  return result;
};
