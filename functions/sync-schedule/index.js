const cloudbase = require('@cloudbase/node-sdk')

exports.main = async (event, context) => {
  const envId = process.env.TCB_ENV || 'trial-sh-d1gqznm4577d6a062'
  const bucket = '7472-trial-sh-d1gqznm4577d6a062-1251520283'
  const app = cloudbase.init({ env: envId })
  const db = app.database()

  const result = { season: null, status: 'pending', matches: 0, error: null }

  try {
    const seasonRaw = await download(app, envId, bucket, 'data/latest/current-season.json')
    if (!seasonRaw) {
      result.status = 'error'
      result.error = 'current-season.json not found'
      await recordSnapshot(db, null, 'error', result.error)
      return result
    }
    const seasonMeta = JSON.parse(seasonRaw)
    const season = seasonMeta.current || seasonMeta.season
    result.season = season
    console.log(`[sync-schedule] Current season: ${season}`)

    const scheduleRaw = await download(app, envId, bucket, `data/derived/${season}/schedule.json`)
    if (!scheduleRaw) {
      result.status = 'skipped'
      result.error = 'schedule.json not found'
      await recordSnapshot(db, season, 'skipped', result.error)
      return result
    }
    const schedule = JSON.parse(scheduleRaw)
    const matches = schedule.matches || []
    result.matches = matches.length

    const doc = {
      season_id: schedule.season_id || season,
      season_name: schedule.season_name || season,
      team_id: schedule.team_id || '',
      matches,
      updated_at: schedule.updated_at || new Date().toISOString(),
      source_status: 'ok'
    }

    const existing = await db.collection('match_schedules').where({ season_id: doc.season_id }).get()
    if (existing.data.length > 0) {
      await db.collection('match_schedules').doc(existing.data[0]._id).update(doc)
      console.log(`[sync-schedule] match_schedules updated for ${season} (${matches.length} matches)`)
    } else {
      await db.collection('match_schedules').add(doc)
      console.log(`[sync-schedule] match_schedules created for ${season} (${matches.length} matches)`)
    }

    result.status = 'success'
    await recordSnapshot(db, season, 'success', null, `data/derived/${season}/schedule.json`)
    console.log('[sync-schedule] Done')
  } catch (err) {
    console.error('[sync-schedule] Error:', err.message, err.stack)
    result.status = 'error'
    result.error = err.message
    try {
      await recordSnapshot(db, result.season || 'unknown', 'error', err.message)
    } catch (_) {}
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

async function recordSnapshot(db, season, status, error, source) {
  await db.collection('sync_snapshots').add({
    season: season || 'unknown',
    type: 'schedule',
    status,
    error: error || null,
    source: source || '',
    updated_at: new Date().toISOString()
  })
}
