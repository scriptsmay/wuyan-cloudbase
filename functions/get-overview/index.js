exports.main = async (event, context) => {
  const cloudbase = require('@cloudbase/node-sdk')
  const app = cloudbase.init({ env: 'trial-sh-d1gqznm4577d6a062' })
  const db = app.database()

  // 鉴权
  const query = event.queryStringParameters || {}
  const token = query.token || ''
  const AUTH_TOKEN = process.env.AUTH_TOKEN || 'wuyan-mini-2026'
  if (token !== AUTH_TOKEN) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ code: 401, message: 'Unauthorized', data: null })
    }
  }

  try {
    const result = await db.collection('season_summaries')
      .orderBy('updated_at', 'desc')
      .limit(1)
      .get()

    if (result.data.length === 0) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ code: 404, message: 'No data yet.', data: null })
      }
    }

    const doc = result.data[0]
    const rawData = doc.data || {}
    const innerData = rawData.data || rawData
    const seasonId = doc.season || ''

    // 扁平化 overview 数据，适配前端期望格式
    const seasonStats = (innerData.season_stats || []).find(s => s.season_id === seasonId) || {}
    const heroStats = innerData.hero_stats || []
    const heroTop = heroStats
      .sort((a, b) => (b.battles || 0) - (a.battles || 0))
      .slice(0, 10)

    const overview = {
      player_info: innerData.player_info || {},
      career_summary: innerData.career_summary || {},
      current_season: seasonStats,
      hero_top: heroTop,
      team_stats: innerData.team_stats || [],
      recent_matches: innerData.recent_matches || []
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        code: 200,
        message: 'ok',
        data: {
          season: doc.season,
          season_name: doc.season_name,
          player_name: doc.player_name,
          team_name: doc.team_name,
          updated_at: doc.updated_at,
          overview
        }
      })
    }
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ code: 500, message: err.message, data: null })
    }
  }
}
