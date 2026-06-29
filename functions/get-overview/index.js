const http = require('http')
const cloudbase = require('@cloudbase/node-sdk')

const app = cloudbase.init({ env: cloudbase.SYMBOL_DEFAULT_ENV })
const db = app.database()

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', '*')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  try {
    const result = await db.collection('season_summaries')
      .orderBy('updated_at', 'desc')
      .limit(1)
      .get()

    if (result.data.length === 0) {
      res.writeHead(404)
      res.end(JSON.stringify({
        code: 404,
        message: 'No data yet.',
        data: null
      }))
      return
    }

    const doc = result.data[0]
    res.writeHead(200)
    res.end(JSON.stringify({
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
    }))
  } catch (err) {
    res.writeHead(500)
    res.end(JSON.stringify({
      code: 500,
      message: err.message,
      data: null
    }))
  }
})

server.listen(9000, () => {
  console.log('[get-overview] Listening on port 9000')
})
