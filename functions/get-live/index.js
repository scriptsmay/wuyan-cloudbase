exports.main = async (event, context) => {
  const cloudbase = require('@cloudbase/node-sdk')
  const app = cloudbase.init({ env: cloudbase.SYMBOL_DEFAULT_ENV })
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
    const now = new Date()
    const year = parseInt(query.year) || now.getFullYear()
    const month = parseInt(query.month) || (now.getMonth() + 1)
    const monthKey = `${year}-${String(month).padStart(2, '0')}`

    // 月度汇总
    const summaryRes = await db.collection('live_streams')
      .where({ type: 'monthly_summary', month_key: monthKey })
      .get()

    // 当月直播记录
    const streamsRes = await db.collection('live_streams')
      .where({ year, month })
      .orderBy('stream_date', 'desc')
      .get()

    const summary = summaryRes.data.length > 0 ? summaryRes.data[0] : null
    const streams = (streamsRes.data || [])
      .filter(s => s.type !== 'monthly_summary')

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        code: 200,
        message: 'ok',
        data: { year, month, summary, streams }
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
