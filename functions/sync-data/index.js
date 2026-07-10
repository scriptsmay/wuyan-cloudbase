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

    // 3. 防御：从 hero_stats 重新计算 hero_top，防止上游截断
    if (overview.data && overview.data.hero_stats) {
      const heroTop = overview.data.hero_stats.map(h => ({
        hero_name: h.hero_name,
        battles: h.battles,
        win_rate: h.win_rate
      }))
      console.log(`[sync] hero_top computed from hero_stats: ${heroTop.length} heroes (was ${(overview.hero_top || []).length})`)
      overview.hero_top = heroTop
    }

    // 4. Upsert season_summaries
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

    // 5. 写入每日赛季快照（供故事卡周环比计算）
    const today = new Date().toISOString().split('T')[0]
    const metrics = extractMetrics(overview)
    const overviewHash = md5(JSON.stringify(metrics))
    const snapshotDoc = {
      date: today,
      season_id: season,
      overview_hash: overviewHash,
      metrics,
      created_at: new Date().toISOString()
    }
    const snapExisting = await db.collection('season_snapshots').where({ date: today, season_id: season }).get()
    if (snapExisting.data.length > 0) {
      await db.collection('season_snapshots').doc(snapExisting.data[0]._id).update(snapshotDoc)
      console.log(`[sync] season_snapshots updated for ${season} @ ${today}`)
    } else {
      await db.collection('season_snapshots').add(snapshotDoc)
      console.log(`[sync] season_snapshots created for ${season} @ ${today}`)
    }
    results.synced.push('season_snapshots')

    // 6. 清理 90 天前的旧快照
    const cutoffDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    try {
      const oldSnaps = await db.collection('season_snapshots').where({
        date: db.command.lt(cutoffDate)
      }).get()
      for (const s of oldSnaps.data) {
        await db.collection('season_snapshots').doc(s._id).remove()
      }
      console.log(`[sync] season_snapshots cleaned: ${oldSnaps.data.length} records before ${cutoffDate}`)
    } catch (e) {
      console.warn(`[sync] season_snapshots cleanup skipped: ${e.message}`)
    }

    // 7. 记录同步快照
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

function extractMetrics(overview) {
  const data = overview.data || overview
  const summary = data.career_summary || {}
  const season = data.season_stats || data
  return {
    win_rate: season.win_rate != null ? season.win_rate : (summary.win_rate || 0),
    kda_ratio: season.kda_ratio != null ? season.kda_ratio : (summary.kda_ratio || 0),
    battles: season.battles != null ? season.battles : (summary.total_matches || 0),
    mvp: season.mvp != null ? season.mvp : (summary.mvp_count || 0),
    wins: season.wins != null ? season.wins : 0,
    loses: season.loses != null ? season.loses : 0,
    avg_kills: season.avg_kills != null ? season.avg_kills : 0,
    avg_deaths: season.avg_deaths != null ? season.avg_deaths : 0,
    avg_assists: season.avg_assists != null ? season.avg_assists : 0
  }
}

function md5(str) {
  const crypto = require('crypto')
  return crypto.createHash('md5').update(str).digest('hex')
}
