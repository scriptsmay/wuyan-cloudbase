const cloudbase = require('@cloudbase/node-sdk')

exports.main = async (event, context) => {
  const app = cloudbase.init({ env: process.env.TCB_ENV || 'trial-sh-d1gqznm4577d6a062' })
  const db = app.database()

  const query = event.queryStringParameters || {}
  const token = query.token || event.token || ''
  const AUTH_TOKEN = process.env.AUTH_TOKEN || 'wuyan_mini_20260710'
  if (token !== AUTH_TOKEN) {
    return jsonResp(401, { code: 401, message: 'Unauthorized', data: null })
  }

  try {
    const result = await db.collection('season_summaries')
      .orderBy('updated_at', 'desc')
      .limit(1)
      .get()

    if (result.data.length === 0) {
      return jsonResp(404, { code: 404, message: 'No data yet.', data: null })
    }

    const doc = result.data[0]
    const rawData = doc.data || {}
    const innerData = rawData.data || rawData
    const heroStats = innerData.hero_stats || []

    return jsonResp(200, {
      code: 200,
      message: 'ok',
      data: {
        season: doc.season,
        season_name: doc.season_name,
        player_name: doc.player_name,
        team_name: doc.team_name,
        updated_at: doc.updated_at,
        hero_stats: heroStats
      }
    })
  } catch (err) {
    console.error('[get-heroes] Error:', err.message)
    return jsonResp(500, { code: 500, message: err.message, data: null })
  }
}

function jsonResp(statusCode, data) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(data)
  }
}
