exports.main = async (event, context) => {
  const cloudbase = require('@cloudbase/node-sdk')
  const app = cloudbase.init({ env: process.env.TCB_ENV || 'trial-sh-d1gqznm4577d6a062' })
  const db = app.database()

  const query = event.queryStringParameters || {}
  const token = query.token || ''
  const AUTH_TOKEN = process.env.AUTH_TOKEN
  if (!AUTH_TOKEN || token !== AUTH_TOKEN) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ code: 401, message: 'Unauthorized', data: null })
    }
  }

  try {
    const week = query.week
    let res
    if (week) {
      res = await db.collection('weekly_story').where({ week }).get()
    } else {
      res = await db.collection('weekly_story')
        .orderBy('created_at', 'desc')
        .limit(1)
        .get()
    }

    if (res.data.length === 0) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ code: 404, message: '暂无故事卡数据', data: null })
      }
    }

    const doc = res.data[0]

    // 补充前端期望的字段（season_name, hero, live_hours）
    let seasonName = 'KPL2026夏季赛'
    let heroName = ''
    let heroWinRate = 0
    let liveHours = 0

    try {
      const overviewRes = await db.collection('season_summaries')
        .orderBy('updated_at', 'desc')
        .limit(1)
        .get()
      if (overviewRes.data.length > 0) {
        const o = overviewRes.data[0]
        seasonName = o.season_name || seasonName
        const rawData = o.data || {}
        const innerData = rawData.data || rawData
        const heroStats = innerData.hero_stats || []
        const heroTop = heroStats.sort((a, b) => (b.battles || 0) - (a.battles || 0)).slice(0, 5)
        if (heroTop.length > 0) {
          heroName = heroTop[0].hero_name || ''
          heroWinRate = parseFloat(heroTop[0].win_rate || '0')
        }
      }
    } catch (_) {}

    try {
      const now = new Date()
      const year = now.getFullYear()
      const month = now.getMonth() + 1
      const liveRes = await db.collection('live_streams')
        .where({ year, month })
        .get()
      const streams = (liveRes.data || []).filter(s => s.type !== 'monthly_summary')
      const totalSeconds = streams.reduce((sum, s) => sum + (s.duration || 0), 0)
      liveHours = Math.round(totalSeconds / 360) / 10
    } catch (_) {}

    // 转换 stats 结构为前端期望的扁平格式
    var rawStats = doc.stats || {}
    var flatStats = {
      winRateDiff: rawStats.win_rate ? rawStats.win_rate.diff : 0,
      kdaDiff: rawStats.kda_ratio ? rawStats.kda_ratio.diff : 0,
      battlesDiff: rawStats.battles ? rawStats.battles.diff : 0
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        code: 200,
        message: 'ok',
        data: {
          week: doc.week,
          season_name: seasonName,
          text: doc.text,
          stats: flatStats,
          cover_color: doc.cover_color,
          created_at: doc.created_at,
          hero: { name: heroName, win_rate: heroWinRate },
          live_hours: liveHours
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
