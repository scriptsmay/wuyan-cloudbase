const cloudbase = require('@cloudbase/node-sdk')

/**
 * 获取当前赛季 overview 数据
 * API: HTTP 触发器 / POST
 * 返回: { season, season_name, player_name, data, updated_at }
 */
exports.main = async (event, context) => {
  const app = cloudbase.init({ env: cloudbase.SYMBOL_DEFAULT_ENV })
  const db = app.database()

  try {
    const res = await db.collection('season_summaries')
      .orderBy('updated_at', 'desc')
      .limit(1)
      .get()

    if (res.data.length === 0) {
      return {
        code: 404,
        message: 'No data yet. Run sync-data function first.',
        data: null
      }
    }

    const doc = res.data[0]
    return {
      code: 200,
      message: 'ok',
      data: {
        season: doc.season,
        season_name: doc.season_name,
        player_name: doc.player_name,
        team_name: doc.team_name,
        updated_at: doc.updated_at,
        overview: doc.data
      }
    }
  } catch (err) {
    console.error('[get-overview] Error:', err.message)
    return {
      code: 500,
      message: err.message,
      data: null
    }
  }
}
