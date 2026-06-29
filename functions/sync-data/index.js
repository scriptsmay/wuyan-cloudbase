const cloudbase = require('@cloudbase/node-sdk')

// CloudBase 云函数入口
exports.main = async (event, context) => {
  const app = cloudbase.init({ env: cloudbase.SYMBOL_DEFAULT_ENV })
  const db = app.database()
  const storage = app.storage()

  const results = { season: null, synced: [], skipped: [], errors: [] }

  try {
    // 1. 读取 current-season.json 获取当前赛季 ID
    const seasonBuf = await downloadFile(storage, '/data/latest/current-season.json')
    const seasonMeta = JSON.parse(seasonBuf.toString())
    const season = seasonMeta.season
    results.season = season
    console.log(`[sync] Current season: ${season}`)

    // 2. 读取 overview.json（最核心的聚合数据）
    const overviewBuf = await downloadFile(storage, `/data/derived/${season}/overview.json`)
    if (!overviewBuf) {
      console.warn(`[sync] overview.json not found for season ${season}`)
      results.skipped.push('overview.json')
      return results
    }
    const overview = JSON.parse(overviewBuf.toString())
    console.log(`[sync] Overview loaded: ${overview.player_name} - ${overview.season_name}`)

    // 3. 更新 season_summaries（upsert）
    const summaryDoc = {
      season,
      season_name: overview.season_name,
      player_name: overview.player_name,
      team_name: overview.team_name,
      data: overview,
      updated_at: new Date().toISOString()
    }
    await db.collection('season_summaries')
      .where({ season })
      .get()
      .then(async (res) => {
        if (res.data.length > 0) {
          await db.collection('season_summaries')
            .doc(res.data[0]._id)
            .update(summaryDoc)
          console.log(`[sync] season_summaries updated for ${season}`)
        } else {
          await db.collection('season_summaries').add(summaryDoc)
          console.log(`[sync] season_summaries created for ${season}`)
        }
      })
    results.synced.push('season_summaries')

    // 4. 写入 sync_snapshots
    await db.collection('sync_snapshots').add({
      season,
      type: 'daily',
      status: 'success',
      source: `cloud-storage:/data/derived/${season}/overview.json`,
      updated_at: new Date().toISOString()
    })
    results.synced.push('sync_snapshots')
    console.log('[sync] Sync snapshot recorded')

  } catch (err) {
    console.error('[sync] Error:', err.message)
    results.errors.push(err.message)

    // 记录失败快照
    try {
      await db.collection('sync_snapshots').add({
        season: results.season || 'unknown',
        type: 'daily',
        status: 'error',
        error: err.message,
        updated_at: new Date().toISOString()
      })
    } catch (dbErr) {
      console.error('[sync] Failed to record error snapshot:', dbErr.message)
    }
  }

  return results
}

/**
 * 从云存储下载文件，返回 Buffer
 */
async function downloadFile(storage, cloudPath) {
  try {
    const result = await storage.downloadFile({ cloudPath })
    if (result && result.fileContent) {
      return result.fileContent
    }
    console.warn(`[sync] File empty or missing: ${cloudPath}`)
    return null
  } catch (err) {
    console.error(`[sync] Download failed: ${cloudPath} - ${err.message}`)
    return null
  }
}
