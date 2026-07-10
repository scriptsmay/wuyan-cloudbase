const cloudbase = require('@cloudbase/node-sdk')

const DAILY_LIMIT = 50

const MOOD_PROMPTS = {
  victory: '胜利时刻，欢呼雀跃，激情澎湃，用最燃的语气庆祝胜利',
  trough: '低谷时期，温暖治愈，鼓励打气，相信选手一定能触底反弹',
  daily: '日常陪伴，轻松温馨，像老朋友一样聊天，加油打气',
  comeback: '求胜心切，热血沸腾，气势拉满，为选手呐喊助威'
}

const MOOD_NAMES = {
  victory: '胜利',
  trough: '低谷',
  daily: '日常',
  comeback: '求胜'
}

exports.main = async (event, context) => {
  const app = cloudbase.init({ env: cloudbase.SYMBOL_DEFAULT_ENV })
  const db = app.database()

  const body = parseBody(event)
  const query = event.queryStringParameters || {}
  const token = query.token || body.token || ''
  const AUTH_TOKEN = process.env.AUTH_TOKEN || 'wuyan-mini-2026'
  if (token !== AUTH_TOKEN) {
    return jsonResp(401, { code: 401, message: 'Unauthorized', data: null })
  }

  const mood = (body.mood || 'daily').toLowerCase()
  const customText = body.text || ''

  if (!MOOD_PROMPTS[mood]) {
    return jsonResp(400, { code: 400, message: '心情参数不支持', data: null })
  }

  try {
    const limitOk = await checkUsageLimit(db, 'aiCheer', DAILY_LIMIT)
    if (!limitOk) {
      return jsonResp(429, { code: 429, message: '今日 AI 调用已达上限，请明日再来', data: null })
    }

    const overview = await getLatestOverview(db)
    if (!overview) {
      return jsonResp(404, { code: 404, message: '暂无相关数据', data: null })
    }

    const systemPrompt = `你是一位KPL选手无言的超级粉丝，擅长写应援文案。
请根据用户选择的心情，写3条简短有力的应援文案（每条不超过30字）和1句emoji配文。
文案要自然融入选手的真实数据，比如KDA、胜率、英雄名字等。
风格：${MOOD_PROMPTS[mood]}。
只输出JSON格式：{"lines": ["文案1", "文案2", "文案3"], "emoji_caption": "🎉..." }
不要输出任何其他文字。`

    const data = overview.data || {}
    const summary = data.career_summary || {}
    const heroTop = data.hero_top || []
    const heroName = heroTop.length > 0 ? heroTop[0].hero_name : ''
    const heroWinRate = heroTop.length > 0 ? heroTop[0].win_rate : ''

    let userPrompt = `选手：无言
战队：${overview.team_name || ''}
当前赛季KDA：${summary.kda_ratio != null ? summary.kda_ratio : '暂无'}
胜率：${summary.win_rate != null ? (summary.win_rate * 100).toFixed(1) + '%' : '暂无'}
总场次：${summary.total_matches != null ? summary.total_matches : '暂无'}
常用英雄：${heroName || '暂无'}
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
  try {
    const jsonStr = text.match(/\{[\s\S]*\}/)
    if (jsonStr) {
      const parsed = JSON.parse(jsonStr[0])
      if (Array.isArray(parsed.lines) && typeof parsed.emoji_caption === 'string') {
        return parsed
      }
    }
  } catch (_) {}
  const lines = text.split(/\n+/).filter(l => l.trim().length > 0 && !l.includes('{') && !l.includes('}')).slice(0, 3)
  return {
    lines: lines.length > 0 ? lines : ['无言加油！', '相信你！', '永远支持你！'],
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
  const res = await ai.run({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    model: process.env.AI_MODEL || 'default',
    stream: false
  })

  if (res && res.choices && res.choices.length > 0) {
    const choice = res.choices[0]
    if (choice.message && choice.message.content) {
      return choice.message.content
    }
    if (choice.text) {
      return choice.text
    }
  }
  if (res && res.content) {
    return res.content
  }
  throw new Error('AI response format unexpected')
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
