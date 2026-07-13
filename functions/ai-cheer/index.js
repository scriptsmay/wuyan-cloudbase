'use strict'

const cloudbase = require('@cloudbase/node-sdk')
const { randomUUID } = require('node:crypto')
const {
  ENV_ID, parseBody, getHeader, resolveIdentity, successResponse, errorResponse,
  optionsResponse, getRequestId, getClientIp, shanghaiDate, normalizeClientId,
  isValidClientId, hashValue
} = require('./runtime')

const AI_MODEL = process.env.AI_MODEL || 'hy3'
const DAY_MS = 24 * 60 * 60 * 1000
const ALLOWED_MOODS = new Set(['victory', 'low', 'daily', 'hope'])
const MOOD_ALIASES = { eager: 'hope' }
const MOOD_PROMPTS = {
  victory: '胜利时刻，全力欢呼！用追竞女孩/男孩最燃的语气庆祝，有夺冠氛围感',
  low: '低谷时期，温暖守护。用同担之间互相打气的语气，相信选手会杀回来',
  daily: '日常陪伴，轻松有活力。像同担在超话里聊天一样自然，元气满满地加油',
  hope: '求胜时刻，热血拉满！用最冲的语气给下一场蓄力，气势不能输'
}
const MOOD_NAMES = { victory: '胜利', low: '低谷', daily: '日常', hope: '求胜' }
const DEFAULT_BLOCKED_PATTERNS = [/自杀/u, /博彩/u, /色情/u, /仇恨/u]

const app = cloudbase.init({ env: ENV_ID })
const db = app.database()

exports.main = async (event) => {
  const requestId = getRequestId(event)
  const origin = getHeader(event, 'origin')
  const method = String(event.httpMethod || event.requestContext && event.requestContext.httpMethod || 'POST').toUpperCase()
  if (method === 'OPTIONS') return optionsResponse(requestId, origin)
  if (method !== 'POST') return errorResponse(405, 'METHOD_NOT_ALLOWED', '仅支持 POST', requestId, origin)

  let body
  try { body = parseBody(event) } catch (_) {
    return errorResponse(400, 'INVALID_ARGUMENT', '请求体不是合法 JSON', requestId, origin)
  }

  const identity = await resolveIdentity(app, event, body)
  if (!identity.ok) return errorResponse(401, 'SESSION_REQUIRED', '匿名会话无效或已过期', requestId, origin)

  const moodInput = typeof body.mood === 'string' ? body.mood.toLowerCase() : 'daily'
  const mood = MOOD_ALIASES[moodInput] || moodInput
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  const clientId = normalizeClientId(body.client_id || body._cid || 'unknown')
  if (!ALLOWED_MOODS.has(mood) || textLength(text) > 120 || !isValidClientId(clientId)) {
    return errorResponse(400, 'INVALID_ARGUMENT', '心情、补充文字或 client_id 不合法', requestId, origin)
  }
  if (isContentBlocked(text)) return errorResponse(451, 'CONTENT_BLOCKED', '补充文字未通过内容安全检查', requestId, origin)

  try {
    const overview = await getLatestOverview()
    const source = buildGroundedSource(overview)
    const idempotencyKey = normalizeRequestId(getHeader(event, 'x-request-id') || requestId)
    const quota = await consumeAiQuota({
      subjectId: identity.subjectId,
      ipHash: hashValue(getClientIp(event), process.env.IP_HASH_SALT || ENV_ID),
      requestId: idempotencyKey,
      date: shanghaiDate().date
    })
    if (!quota.allowed) return errorResponse(429, 'RATE_LIMITED', '今日应援生成额度已用完', requestId, origin, 86400)
    if (quota.response) return successResponse(quota.response, requestId, origin)

    let generated
    try {
      const model = app.ai().createModel('cloudbase')
      const result = await model.generateText({
        model: AI_MODEL,
        messages: [
          { role: 'system', content: buildSystemPrompt(mood, source) },
          { role: 'user', content: buildUserPrompt(mood, text, source) }
        ],
        temperature: 0.85
      })
      generated = parseGeneratedText(result && result.text)
      console.log('[ai-cheer] model completed', { requestId, totalTokens: result && result.usage && result.usage.total_tokens })
    } catch (error) {
      await markReceipt(quota.receiptId, 'failed')
      console.error('[ai-cheer] model failed', { requestId, message: getErrorMessage(error) })
      return errorResponse(503, 'AI_UNAVAILABLE', '文案生成暂时不可用，请稍后重试', requestId, origin)
    }

    const safeOutput = validateGeneratedOutput(generated, source)
    if (!safeOutput || safeOutput.lines.some(isContentBlocked) || isContentBlocked(safeOutput.emoji_caption)) {
      await markReceipt(quota.receiptId, 'failed')
      return errorResponse(451, 'CONTENT_BLOCKED', '生成内容未通过安全检查', requestId, origin)
    }

    const reportId = randomUUID()
    const now = new Date()
    const sourceSnapshotAt = source.snapshotAt || now.toISOString()
    const payload = {
      lines: safeOutput.lines,
      emoji_caption: safeOutput.emoji_caption,
      report_id: reportId,
      refs: source.refs,
      source_snapshot_at: sourceSnapshotAt
    }
    await db.collection('ai_reports').doc(reportId).set({
      report_id: reportId,
      module: 'aiCheer',
      status: 'active',
      subject_id: identity.subjectId,
      client_id_hash: hashValue(clientId, ENV_ID),
      user_input: { mood, text_summary: text.slice(0, 40) },
      ai_output: safeOutput,
      refs: source.refs,
      source_snapshot_at: sourceSnapshotAt,
      timestamp: now.getTime(),
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 30 * DAY_MS).toISOString()
    })
    await db.collection('usage_limits').doc(quota.receiptId).update({ status: 'success', response: payload, updated_at: now.toISOString() })
    return successResponse(payload, requestId, origin)
  } catch (error) {
    console.error('[ai-cheer] request failed', { requestId, message: getErrorMessage(error) })
    return errorResponse(503, 'WRITE_FAILED', '服务暂时不可用，请稍后重试', requestId, origin)
  }
}

async function getLatestOverview() {
  const result = await db.collection('season_summaries').orderBy('updated_at', 'desc').limit(1).get()
  return result.data && result.data.length ? result.data[0] : null
}

function buildGroundedSource(overview) {
  if (!overview) return { refs: [], snapshotAt: '', promptLines: [] }
  const envelope = isObject(overview.data) ? overview.data : {}
  const data = isObject(envelope.data) ? envelope.data : envelope
  const seasonId = typeof overview.season === 'string' ? overview.season : ''
  const seasonStats = Array.isArray(data.season_stats)
    ? data.season_stats.find((item) => isObject(item) && item.season_id === seasonId) || {}
    : {}
  const career = isObject(data.career_summary) ? data.career_summary : {}
  const heroes = Array.isArray(data.hero_stats) ? [...data.hero_stats] : []
  heroes.sort((a, b) => Number(b && b.battles || 0) - Number(a && a.battles || 0))
  const refs = []
  const promptLines = []
  addRef(refs, promptLines, '当前赛季 KDA', seasonStats.kda_ratio ?? career.kda_ratio, 'season_summaries')
  addRef(refs, promptLines, '当前赛季胜率', formatRate(seasonStats.win_rate ?? career.win_rate), 'season_summaries')
  const hero = heroes.find((item) => isObject(item) && typeof item.hero_name === 'string' && item.hero_name)
  if (hero) addRef(refs, promptLines, '常用英雄', hero.hero_name, 'season_summaries')
  return { refs: refs.slice(0, 3), promptLines: promptLines.slice(0, 3), snapshotAt: normalizeSnapshotAt(overview.updated_at || overview.source_snapshot_at) }
}

function addRef(refs, promptLines, label, value, source) {
  if (value === null || value === undefined || value === '' || value === '暂无') return
  const text = String(value)
  refs.push({ label, value: text, source })
  promptLines.push(`${label}：${text}`)
}

function buildSystemPrompt(mood, source) {
  return [
    '你是 KPL 选手无言的粉丝应援文案助手。',
    '受众是 18 岁左右的追竞年轻人，用语要贴合粉圈氛围——用”同担””守护””冲冲冲””杀回来”这类词，不用”老友””朋友””稳重”等长辈口吻。',
    '语气要有活力、有朝气，像超话里同担发帖一样自然，不用书面语。',
    '只允许使用下方”可引用数据”中的具体数字、百分比、英雄名；没有提供的数据绝不能猜测。',
    '输出 1 到 3 条中文短句，每条不超过 30 个汉字，并给出一句简短 emoji_caption。',
    '不得使用传统球类运动词汇，不得声称单场 MVP、本周表现或未提供的赛程结果。',
    `语气：${MOOD_PROMPTS[mood]}`,
    `可引用数据：${source.promptLines.length ? source.promptLines.join('；') : '无，生成纯情绪应援文案'}`,
    '只输出合法 JSON：{“lines”:[“文案”],”emoji_caption”:”配文”}'
  ].join('\n')
}

function buildUserPrompt(mood, text, source) {
  const lines = [`心情：${MOOD_NAMES[mood]}`, `数据条目数：${source.refs.length}`]
  if (text) lines.push(`用户补充：${text}`)
  lines.push('请生成可直接复制发布的应援文案。')
  return lines.join('\n')
}

function parseGeneratedText(text) {
  if (typeof text !== 'string' || !text.trim()) return null
  const match = text.replace(/```(?:json)?/giu, '').trim().match(/\{[\s\S]*\}/u)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[0])
    const lines = Array.isArray(parsed.lines) ? parsed.lines.filter((line) => typeof line === 'string' && line.trim()).map((line) => line.trim()).slice(0, 3) : []
    return { lines, emoji_caption: typeof parsed.emoji_caption === 'string' ? parsed.emoji_caption.trim() : '' }
  } catch (_) { return null }
}

function validateGeneratedOutput(output, source) {
  if (!output || !Array.isArray(output.lines) || output.lines.length < 1 || output.lines.length > 3) return null
  if (output.lines.some((line) => !line || textLength(line) > 40)) return null
  const allowedNumbers = new Set(source.refs.flatMap((ref) => String(ref.value).match(/\d+(?:\.\d+)?%?/gu) || []))
  for (const line of output.lines) {
    const numbers = line.match(/\d+(?:\.\d+)?%?/gu) || []
    if (numbers.some((number) => !allowedNumbers.has(number))) return null
  }
  return { lines: output.lines, emoji_caption: output.emoji_caption || '继续并肩，为无言加油！' }
}

async function consumeAiQuota({ subjectId, ipHash, requestId, date }) {
  const receiptId = `aiCheer_request_${hashValue(`${subjectId}:${requestId}`)}`
  return db.runTransaction(async (transaction) => {
    const collection = transaction.collection('usage_limits')
    const receiptResult = await collection.doc(receiptId).get()
    const receipt = receiptResult.data && receiptResult.data[0]
    if (receipt) return { allowed: true, receiptId, response: receipt.response || null }
    const limits = [
      { id: `aiCheer_user_${hashValue(subjectId)}_${date}`, limit: readLimit('AI_USER_DAILY_LIMIT', 10), dimension: 'user' },
      { id: `aiCheer_ip_${ipHash}_${date}`, limit: readLimit('AI_IP_DAILY_LIMIT', 30), dimension: 'ip' },
      { id: `aiCheer_global_${date}`, limit: readLimit('AI_GLOBAL_DAILY_LIMIT', 500), dimension: 'global' }
    ]
    const current = []
    for (const item of limits) {
      const result = await collection.doc(item.id).get()
      const doc = result.data && result.data[0]
      const count = Number(doc && doc.count || 0)
      if (count >= item.limit) return { allowed: false, receiptId: '' }
      current.push({ ...item, count })
    }
    const now = new Date().toISOString()
    for (const item of current) {
      await collection.doc(item.id).set({ module: 'aiCheer', dimension: item.dimension, date, count: item.count + 1, limit: item.limit, updated_at: now })
    }
    await collection.doc(receiptId).set({ module: 'aiCheerRequest', subject_id_hash: hashValue(subjectId, ENV_ID), request_id: requestId, status: 'pending', created_at: now })
    return { allowed: true, receiptId, response: null }
  })
}

async function markReceipt(receiptId, status) {
  if (!receiptId) return
  try { await db.collection('usage_limits').doc(receiptId).update({ status, updated_at: new Date().toISOString() }) } catch (_) { /* best effort */ }
}

function isContentBlocked(text) {
  if (typeof text !== 'string' || !text) return false
  const terms = String(process.env.BLOCKED_TERMS || '').split(',').map((item) => item.trim()).filter(Boolean)
  return terms.some((term) => text.includes(term)) || DEFAULT_BLOCKED_PATTERNS.some((pattern) => pattern.test(text))
}

function normalizeRequestId(value) { return String(value || '').trim().replace(/[^a-zA-Z0-9:_-]/gu, '').slice(0, 80) || randomUUID() }
function formatRate(value) { if (value === null || value === undefined || value === '') return ''; if (typeof value === 'string' && value.includes('%')) return value; const number = Number(value); return Number.isFinite(number) ? `${number <= 1 ? (number * 100).toFixed(1) : number.toFixed(1)}%` : '' }
function normalizeSnapshotAt(value) { if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString(); if (typeof value === 'number') return new Date(value).toISOString(); return '' }
function readLimit(name, fallback) { const value = Number(process.env[name]); return Number.isInteger(value) && value > 0 ? value : fallback }
function textLength(value) { return Array.from(String(value || '')).length }
function isObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
function getErrorMessage(error) { return error instanceof Error ? error.message : String(error || 'unknown error') }

exports.__test = { buildGroundedSource, parseGeneratedText, validateGeneratedOutput, formatRate }
