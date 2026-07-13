'use strict'

const cloudbase = require('@cloudbase/node-sdk')
const { randomUUID } = require('node:crypto')

const ENV_ID = process.env.TCB_ENV || 'trial-sh-d1gqznm4577d6a062'
const DEFAULT_CONFIG = { ask_daily_limit: 10, cheer_daily_limit: 10 }
const app = cloudbase.init({ env: ENV_ID })
const db = app.database()

exports.main = async (event) => {
  const requestId = getHeader(event, 'x-request-id') || randomUUID()
  const origin = getHeader(event, 'origin')
  const method = String(event.httpMethod || event.requestContext && event.requestContext.httpMethod || 'GET').toUpperCase()
  if (method === 'OPTIONS') return response(204, null, requestId, origin)
  if (method !== 'GET') return response(405, { code: 'METHOD_NOT_ALLOWED', message: '仅支持 GET', request_id: requestId }, requestId, origin)

  const config = { ...DEFAULT_CONFIG }
  try {
    const result = await db.collection('app_config').doc('ai_limits').get()
    const document = result.data && result.data[0]
    if (document) {
      config.ask_daily_limit = positiveInt(document.ask_daily_limit, DEFAULT_CONFIG.ask_daily_limit)
      config.cheer_daily_limit = positiveInt(document.cheer_daily_limit, DEFAULT_CONFIG.cheer_daily_limit)
    }
  } catch (error) {
    console.warn('[get-config] using defaults', error.message)
  }
  return response(200, { ...config, code: 200, message: 'ok', data: config }, requestId, origin)
}

function response(statusCode, payload, requestId, origin) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=60',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Request-Id',
    Vary: 'Origin',
    'X-Request-Id': requestId
  }
  const allowedOrigin = resolveOrigin(origin)
  if (allowedOrigin) headers['Access-Control-Allow-Origin'] = allowedOrigin
  return { statusCode, headers, body: payload === null ? '' : JSON.stringify(payload) }
}

function resolveOrigin(origin) {
  if (!origin) return ''
  const allowed = String(process.env.ALLOWED_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean)
  if (allowed.includes(origin)) return origin
  if (/^http:\/\/(localhost|127\.0\.0\.1):\d+$/u.test(origin) && process.env.ALLOW_LOCALHOST === 'true') return origin
  return ''
}

function getHeader(event, name) {
  const headers = event && event.headers && typeof event.headers === 'object' ? event.headers : {}
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase())
  return key && typeof headers[key] === 'string' ? headers[key] : ''
}

function positiveInt(value, fallback) { const number = Number(value); return Number.isInteger(number) && number > 0 ? number : fallback }
