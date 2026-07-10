const cloudbase = require('@cloudbase/node-sdk')

const DAILY_LIMIT = 50

const MOOD_PROMPTS = {
  victory: '胜利时刻，欢呼雀跃，激情澎湃，用最燃的语气庆祝胜利',
  low: '低谷时期，温暖治愈，鼓励打气，相信选手一定能触底反弹',
  daily: '日常陪伴，轻松温馨，像老朋友一样聊天，加油打气',
  eager: '求胜心切，热血沸腾，气势拉满，为选手呐喊助威'
}

const MOOD_NAMES = {
  victory: '胜利',
  low: '低谷',
  daily: '日常',
  eager: '求胜'
}

exports.main = async (event, context) => {
  const app = cloudbase.init({ env: process.env.TCB_ENV || 'trial-sh-d1gqznm4577d6a062' })
  const db = app.database()

  const body = parseBody(event)
  const query = event.queryStringParameters || {}
  const token = query.token || body.token || ''
  const AUTH_TOKEN = process.env.AUTH_TOKEN
  if (!AUTH_TOKEN || token !== AUTH_TOKEN) {
    return jsonResp(401, { code: 401, message: 'Unauthorized', data: null })
  }

  const mood = (body.mood || 'daily').toLowerCase()
  const customText = body.text || ''

  if (!MOOD_PROMPTS[mood]) {
    return jsonResp(400, { code: 400, message: '心情参数不支持', data: null })
  }

  try {
    const overview = await getLatestOverview(db)
    if (!overview) {
      return jsonResp(404, { code: 404, message: '暂无相关数据', data: null })
    }

    const limitOk = await checkUsageLimit(db, 'aiCheer', DAILY_LIMIT)
    if (!limitOk) {
      return jsonResp(429, { code: 429, message: '今日 AI 调用已达上限，请明日再来', data: null })
    }

    const systemPrompt = `你是一位KPL（王者荣耀职业联赛）选手无言的超级粉丝，擅长写应援文案。
所有文案必须围绕电竞比赛、王者荣耀游戏场景，禁止使用打球、球场等传统体育词汇。
请根据用户选择的心情，写3条简短有力的应援文案（每条不超过30字）和1句emoji配文。
3条文案要尽量分散使用不同的英雄名字，不要3条都写同一个英雄。
文案要自然融入选手的真实数据，比如KDA、胜率、英雄名字等。
emoji_caption只包含emoji和简短感叹语，不要出现战队名（如KSG）或选手真实姓名。
风格：${MOOD_PROMPTS[mood]}。
只输出JSON格式：{"lines": ["文案1", "文案2", "文案3"], "emoji_caption": "🎉..." }
不要输出任何其他文字。`

    const rawData = overview.data || {}
    const data = rawData.data || rawData
    const seasonId = overview.season || ''
    const seasonStats = (data.season_stats || []).find(s => s.season_id === seasonId) || {}
    const career = data.career_summary || {}

    // 胜率统一格式化
    const fmtRate = (v) => {
      if (v == null) return '暂无'
      if (typeof v === 'string') {
        if (v.includes('%')) return v
        const n = parseFloat(v)
        if (!isNaN(n) && n <= 1) return (n * 100).toFixed(1) + '%'
        return v
      }
      if (typeof v === 'number') {
        if (v <= 1) return (v * 100).toFixed(1) + '%'
        return v.toFixed(1) + '%'
      }
      return String(v)
    }

    const heroStats = data.hero_stats || []
    const heroTop = heroStats.sort((a, b) => (b.battles || 0) - (a.battles || 0)).slice(0, 5)
    const heroList = heroTop.map(h => `${h.hero_name}(${fmtRate(h.win_rate)})`).join('、')

    const kda = seasonStats.kda_ratio != null ? seasonStats.kda_ratio : (career.kda_ratio || '暂无')
    const winRate = seasonStats.win_rate != null ? fmtRate(seasonStats.win_rate) : fmtRate(career.win_rate)
    const totalMatches = seasonStats.battles != null ? seasonStats.battles : (career.total_matches || '暂无')

    let userPrompt = `选手：无言
战队：${overview.team_name || ''}
当前赛季KDA：${kda}
胜率：${winRate}
总场次：${totalMatches}
常用英雄（含胜率）：${heroList || '暂无'}
心情：${MOOD_NAMES[mood] || mood}`

    if (customText) {
      userPrompt += `\n用户补充：${customText}`
    }

    userPrompt += `\n请生成3条应援文案和1句emoji配文，输出JSON格式。`

    let result = { lines: [], emoji_caption: '' }
    try {
      const aiText = await callAI(app, systemPrompt, userPrompt)
      result = parseAIResult(aiText)
    } catch (aiErr) {
      console.error('[aiCheer] AI call failed:', aiErr.message)
      await recordAIReport(db, 'aiCheer', `mood=${mood}`, '', aiErr.message)
      return jsonResp(503, { code: 503, message: '文案生成失败，请重试', data: null })
    }

    await recordUsage(db, 'aiCheer')
    await recordAIReport(db, 'aiCheer', `mood=${mood}`, JSON.stringify(result), '')

    return jsonResp(200, { code: 200, message: 'ok', data: result })
  } catch (err) {
    console.error('[aiCheer] Error:', err.message, err.stack)
    return jsonResp(500, { code: 500, message: err.message, data: null })
  }
}

function parseBody(event) {
  if (event.body) {
    try {
      if (event.isBase64Encoded) {
        const buf = Buffer.from(event.body, 'base64')
        return JSON.parse(buf.toString('utf-8'))
      }
      return typeof event.body === 'string' ? JSON.parse(event.body) : event.body
    } catch (_) {
      return {}
    }
  }
  return {}
}

function jsonResp(statusCode, data) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(data)
  }
}

function parseAIResult(text) {
  // 去除 markdown 代码块标记
  var cleaned = text.replace(/```(?:json)?/gi, '').trim()

  // 尝试直接解析
  try {
    var parsed = JSON.parse(cleaned)
    var lines = Array.isArray(parsed.lines) ? parsed.lines.filter(function (l) { return typeof l === 'string' && l.trim() }) : []
    var emoji = typeof parsed.emoji_caption === 'string' ? parsed.emoji_caption : ''
    if (lines.length > 0) {
      return { lines: lines.slice(0, 3), emoji_caption: emoji || '🎉💪🔥' }
    }
  } catch (_) {}

  // 尝试正则提取 JSON
  try {
    var jsonStr = cleaned.match(/\{[\s\S]*\}/)
    if (jsonStr) {
      var parsed2 = JSON.parse(jsonStr[0])
      var lines2 = Array.isArray(parsed2.lines) ? parsed2.lines.filter(function (l) { return typeof l === 'string' && l.trim() }) : []
      var emoji2 = typeof parsed2.emoji_caption === 'string' ? parsed2.emoji_caption : ''
      if (lines2.length > 0) {
        return { lines: lines2.slice(0, 3), emoji_caption: emoji2 || '🎉💪🔥' }
      }
    }
  } catch (_) {}

  // fallback: 逐行提取纯文案，排除 JSON 结构行
  var rawLines = cleaned.split(/\n+/)
    .map(function (l) { return l.trim() })
    .filter(function (l) {
      if (!l) return false
      if (l.includes('{') || l.includes('}')) return false
      if (l.includes('":') || l.includes('"lines"') || l.includes('"emoji')) return false
      if (l.startsWith('"') && l.endsWith('",')) return false
      // 去掉引号和逗号后的纯文本
      return true
    })
    .map(function (l) {
      return l.replace(/^["'\s]+|["'\s,]+$/g, '')
    })
    .filter(function (l) { return l.length > 2 })
    .slice(0, 3)

  return {
    lines: rawLines.length > 0 ? rawLines : ['无言加油！', '相信你！', '永远支持你！'],
    emoji_caption: '🎉💪🔥'
  }
}

async function getLatestOverview(db) {
  try {
    const res = await db.collection('season_summaries')
      .orderBy('updated_at', 'desc')
      .limit(1)
      .get()
    return res.data.length > 0 ? res.data[0] : null
  } catch (e) {
    return null
  }
}

async function callAI(app, systemPrompt, userPrompt) {
  const ai = app.ai()
  const model = ai.createModel("cloudbase")
  const res = await model.generateText({
    model: process.env.AI_MODEL || "hy3",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]
  })

  if (res && res.text) {
    return res.text
  }
  if (res && res.choices && res.choices.length > 0) {
    const choice = res.choices[0]
    if (choice.message && choice.message.content) {
      return choice.message.content
    }
  }
  throw new Error("AI response format unexpected")
}

async function checkUsageLimit(db, module, dailyLimit) {
  const today = new Date().toISOString().split('T')[0]
  const docId = `${module}_${today}`
  try {
    const res = await db.collection('usage_limits').doc(docId).get()
    if (res.data && res.data.length > 0) {
      const doc = res.data[0]
      if (doc.count >= dailyLimit) {
        return false
      }
      await db.collection('usage_limits').doc(docId).update({ count: doc.count + 1 })
    } else {
      await db.collection('usage_limits').add({
        _id: docId,
        module,
        date: today,
        count: 1,
        limit: dailyLimit,
        created_at: Date.now()
      })
    }
    return true
  } catch (e) {
    console.warn('[aiCheer] usage limit check failed, allowing:', e.message)
    return true
  }
}

async function recordUsage(db, module) {
  return true
}

async function recordAIReport(db, module, userInput, aiOutput, error) {
  try {
    await db.collection('ai_reports').add({
      module,
      user_input: userInput,
      ai_output: aiOutput,
      error: error || null,
      timestamp: Date.now(),
      created_at: new Date().toISOString()
    })
  } catch (e) {
    console.warn('[aiCheer] ai report failed:', e.message)
  }
}
