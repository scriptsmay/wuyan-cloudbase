/**
 * sync-data 云函数
 * 从云存储读取 overview.json，同步到 CloudBase 数据库 season_summaries 集合
 */
const cloudbase = require('@cloudbase/node-sdk')

exports.main = async (event, context) => {
  const envId = process.env.TCB_ENV || 'trial-sh-d1gqznm4577d6a062'
  const bucket = '7472-trial-sh-d1gqznm4577d6a062-1251520283'
  const app = cloudbase.init({ env: envId })
  const db = app.database()

  const results = { season: null, synced: [], skipped: [], errors: [] }

  try {
    // 1. 读取当前赛季
    const seasonRaw = await download(app, envId, bucket, 'data/latest/current-season.json')
    if (!seasonRaw) {
      results.errors.push('current-season.json not found')
      return results
    }
    const seasonMeta = JSON.parse(seasonRaw)
    const season = seasonMeta.current || seasonMeta.season
    results.season = season
    console.log(`[sync] Current season: ${season}`)

    // 2. 读取 overview.json
    const overviewRaw = await download(app, envId, bucket, `data/derived/${season}/overview.json`)
    if (!overviewRaw) {
      console.warn(`[sync] overview.json not found for ${season}`)
      results.skipped.push('overview.json')
      return results
    }
    const overview = JSON.parse(overviewRaw)
    const playerInfo = overview.data && overview.data.player_info ? overview.data.player_info : overview
    console.log(`[sync] Overview loaded: ${playerInfo.latest_nickname} - ${season}`)

    // 3. Upsert season_summaries
    const summaryDoc = {
      season,
      season_name: overview.data && overview.data.career_summary
        ? overview.data.career_summary.last_season_id : season,
      player_name: playerInfo.latest_nickname || 'unknown',
      team_name: playerInfo.latest_team || 'unknown',
      data: overview,
      updated_at: new Date().toISOString()
    }
    const existing = await db.collection('season_summaries').where({ season }).get()
    if (existing.data.length > 0) {
      await db.collection('season_summaries').doc(existing.data[0]._id).update(summaryDoc)
      console.log(`[sync] season_summaries updated for ${season}`)
    } else {
      await db.collection('season_summaries').add(summaryDoc)
      console.log(`[sync] season_summaries created for ${season}`)
    }
    results.synced.push('season_summaries')

    // 4. 记录同步快照
    await db.collection('sync_snapshots').add({
      season, type: 'daily', status: 'success',
      source: `cloud-storage:data/derived/${season}/overview.json`,
      updated_at: new Date().toISOString()
    })
    results.synced.push('sync_snapshots')
    console.log('[sync] Done')

  } catch (err) {
    console.error('[sync] Error:', err.message, err.stack)
    results.errors.push(err.message)
    try {
      await db.collection('sync_snapshots').add({
        season: results.season || 'unknown', type: 'daily', status: 'error',
        error: err.message, updated_at: new Date().toISOString()
      })
    } catch (_) {}
  }

  return results
}

/**
 * 从云存储下载文件，返回文本内容
 * fileID 格式: cloud://envId.bucketName/filePath（必须包含桶名）
 */
async function download(app, envId, bucket, cloudPath) {
  const fileID = `cloud://${envId}.${bucket}/${cloudPath}`
  console.log(`[sync] Downloading: ${cloudPath}`)
  try {
    const res = await app.downloadFile({ fileID })
    if (res && res.fileContent) return res.fileContent.toString()
    if (Buffer.isBuffer(res)) return res.toString()
    console.warn(`[sync] Unexpected download result for: ${cloudPath}`)
  } catch (e) {
    console.error(`[sync] Download failed: ${cloudPath} - ${e.code || e.message}`)
  }
  return null
}
