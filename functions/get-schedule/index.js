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
    const seasonid = query.seasonid
    let res
    if (seasonid) {
      res = await db.collection('match_schedules').where({ season_id: seasonid }).get()
    } else {
      res = await db.collection('match_schedules')
        .orderBy('updated_at', 'desc')
        .limit(1)
        .get()
    }

    if (res.data.length === 0) {
      return {
        statusCode: 503,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ code: 503, message: '赛程暂不可用', data: null })
      }
    }

    const doc = res.data[0]
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        code: 200,
        message: 'ok',
        data: {
          season_name: doc.season_name,
          matches: doc.matches || [],
          updated_at: doc.updated_at
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
