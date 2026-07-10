const cloudbase = require('@cloudbase/node-sdk')

const DEFAULT_CONFIG = {
  ask_daily_limit: 10,
  cheer_daily_limit: 10
}

exports.main = async (event, context) => {
  const app = cloudbase.init({ env: process.env.TCB_ENV || 'trial-sh-d1gqznm4577d6a062' })
  const db = app.database()

  const query = event.queryStringParameters || {}
  const token = query.token || event.token || ''
  const AUTH_TOKEN = process.env.AUTH_TOKEN
  if (!AUTH_TOKEN || token !== AUTH_TOKEN) {
    return jsonResp(401, { code: 401, message: 'Unauthorized', data: null })
  }

  try {
    let config = { ...DEFAULT_CONFIG }
    try {
      const res = await db.collection('app_config').doc('ai_limits').get()
      if (res.data && res.data.length > 0) {
        const doc = res.data[0]
        config.ask_daily_limit = doc.ask_daily_limit || DEFAULT_CONFIG.ask_daily_limit
        config.cheer_daily_limit = doc.cheer_daily_limit || DEFAULT_CONFIG.cheer_daily_limit
      }
    } catch (e) {
      console.warn('[get-config] app_config not found, using defaults:', e.message)
    }

    return jsonResp(200, { code: 200, message: 'ok', data: config })
  } catch (err) {
    console.error('[get-config] Error:', err.message)
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
