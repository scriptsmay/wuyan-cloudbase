/**
 * sync-schedule — 每日赛程全量兜底同步
 *
 * 从 CloudBase 云存储读取 schedule.json（由 kpl-data-daily GitHub Action 采集上传），
 * 按 schedule_id 合并到 match_schedules。使用事务版本控制，与 sync-schedule-live
 * 并发时通过 revision 防止后写覆盖先写。
 */
const cloudbase = require('@cloudbase/node-sdk')
const {
  mergeScheduleMatches,
  recordSyncSnapshot
} = require('./lib/schedule-merge')

exports.main = async (event, context) => {
  const envId = process.env.TCB_ENV
  if (!envId) {
    return { season: null, status: 'error', matches: 0, error: 'TCB_ENV not configured' }
  }
  const bucket = process.env.TCB_BUCKET
  if (!bucket) {
    return { season: null, status: 'error', matches: 0, error: 'TCB_BUCKET not configured' }
  }
  const app = cloudbase.init({ env: envId })
  const db = app.database()

  const result = { season: null, status: 'pending', matches: 0, error: null }

  try {
    // 1. 读取赛季元信息
    const seasonRaw = await download(app, envId, bucket, 'data/latest/current-season.json')
    if (!seasonRaw) {
      result.status = 'error'
      result.error = 'current-season.json not found'
      await recordSyncSnapshot(db, { type: 'schedule', season: null, status: 'error', error: result.error })
      return result
    }
    const seasonMeta = JSON.parse(seasonRaw)
    const season = seasonMeta.current || seasonMeta.season
    result.season = season
    console.log(`[sync-schedule] Current season: ${season}`)

    // 2. 读取赛程文件
    const scheduleRaw = await download(app, envId, bucket, `data/derived/${season}/schedule.json`)
    if (!scheduleRaw) {
      result.status = 'skipped'
      result.error = 'schedule.json not found'
      await recordSyncSnapshot(db, { type: 'schedule', season, status: 'skipped', error: result.error })
      return result
    }
    const schedule = JSON.parse(scheduleRaw)
    const matches = schedule.matches || []
    result.matches = matches.length

    if (matches.length === 0) {
      result.status = 'skipped'
      result.error = 'schedule.json has no matches'
      await recordSyncSnapshot(db, { type: 'schedule', season, status: 'skipped', error: result.error })
      return result
    }

    // 3. 为 matches 补全 season_name（convertKplMatches 会写，但 schedule.json 也可能缺失）
    const seasonName = schedule.season_name || season
    for (const m of matches) {
      if (!m.season_name) m.season_name = seasonName
    }

    // 4. 事务合并（isFullSync=true，每日文件 sourceFetchedAt = schedule.json.updated_at）
    const sourceFetchedAt = schedule.updated_at || new Date().toISOString()
    const mergeResult = await mergeScheduleMatches(db, season, matches, {
      isFullSync: true,
      isLive: false,
      sourceFetchedAt,
      sourceStatus: schedule.source_status || 'ok',
      maxRetries: 3
    })

    console.log(
      `[sync-schedule] Merge result: action=${mergeResult.action}, ` +
      `matched=${mergeResult.matchedCount}, changed=${mergeResult.changedCount}, ` +
      `revision=${mergeResult.revision}, fallback=${mergeResult.fallbackUsed || false}`
    )

    result.status = mergeResult.action === 'skipped' ? 'skipped'
      : mergeResult.action === 'no_change' ? 'no_change'
      : 'success'
    result.matched_count = mergeResult.matchedCount
    result.changed_count = mergeResult.changedCount
    result.revision = mergeResult.revision
    result.fallback_used = mergeResult.fallbackUsed || false

    // 5. 快照记录
    await recordSyncSnapshot(db, {
      type: 'schedule',
      season,
      status: result.status,
      matchedCount: mergeResult.matchedCount,
      changedCount: mergeResult.changedCount,
      sourceFetchedAt,
      error: result.fallback_used ? 'fallback merge key used' : null
    })

    console.log('[sync-schedule] Done')

  } catch (err) {
    console.error('[sync-schedule] Error:', err.message, err.stack)
    result.status = 'error'
    result.error = err.message
    try {
      await recordSyncSnapshot(db, {
        type: 'schedule',
        season: result.season || 'unknown',
        status: 'error',
        error: err.message
      })
    } catch (_) {
      // 快照写入失败不阻塞主流程
    }
  }

  return result
}

async function download(app, envId, bucket, cloudPath) {
  const fileID = `cloud://${envId}.${bucket}/${cloudPath}`
  console.log(`[sync-schedule] Downloading: ${cloudPath}`)
  try {
    const res = await app.downloadFile({ fileID })
    if (res && res.fileContent) return res.fileContent.toString()
    if (Buffer.isBuffer(res)) return res.toString()
    console.warn(`[sync-schedule] Unexpected download result for: ${cloudPath}`)
  } catch (e) {
    console.error(`[sync-schedule] Download failed: ${cloudPath} - ${e.code || e.message}`)
  }
  return null
}
