exports.main = async (event, context) => {
  const cloudbase = require('@cloudbase/node-sdk')
  const app = cloudbase.init({ env: cloudbase.SYMBOL_DEFAULT_ENV })
  const db = app.database()

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
    const now = new Date()
    const year = parseInt(query.year) || now.getFullYear()
    const month = parseInt(query.month) || (now.getMonth() + 1)
    const monthKey = `${year}-${String(month).padStart(2, '0')}`

    // 当月直播记录
    const streamsRes = await db.collection('live_streams')
      .where({ year, month })
      .orderBy('stream_date', 'desc')
      .get()

    const streams = (streamsRes.data || [])
      .filter(s => s.type !== 'monthly_summary')

    // 动态计算汇总（不依赖可能过期的 monthly_summary 缓存）
    const totalSessions = streams.length
    const totalSeconds = streams.reduce((sum, s) => sum + (s.duration || 0), 0)
    const totalHours = Math.round(totalSeconds / 360) / 10 // 保留 1 位小数
    const avgHoursPerSession = totalSessions > 0
      ? Math.round((totalSeconds / 3600) / totalSessions * 10) / 10
      : 0

    const summary = totalSessions > 0 ? {
      total_days: [...new Set(streams.map(s => s.stream_date || '').filter(Boolean))].length,
      total_sessions: totalSessions,
      total_hours: totalHours,
      avg_hours_per_session: avgHoursPerSession,
      computed: true
    } : null

    const isCurrent = (year === now.getFullYear() && month === (now.getMonth() + 1))

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        code: 200,
        message: 'ok',
        data: { year, month, is_current: isCurrent, summary, streams }
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
