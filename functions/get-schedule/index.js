/**
 * get-schedule — HTTP API: 返回最新赛程数据
 *
 * 新增字段（Phase 3 实时同步上线后）：
 * - last_live_synced_at: 最近一次实时同步成功时间
 * - sync_mode: "live" | "daily"（基于 window_active 即时计算）
 * - window_active: 当前是否在比赛活跃窗口内（纯函数即时计算）
 */
const cloudbase = require('@cloudbase/node-sdk')
const { computeWindowStatus } = require('./lib/schedule-merge')

exports.main = async (event, context) => {
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
    const matches = doc.matches || []

    // 即时计算窗口状态（纯函数，不依赖上一次定时任务留下的布尔值）
    const windowStatus = computeWindowStatus(matches)

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        code: 200,
        message: 'ok',
        data: {
          season_name: doc.season_name,
          matches,
          updated_at: doc.updated_at,
          last_live_synced_at: doc.last_live_synced_at || null,
          sync_mode: windowStatus.window_active ? 'live' : 'daily',
          window_active: windowStatus.window_active
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
