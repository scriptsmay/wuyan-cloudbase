'use strict'

const { createHash, randomUUID } = require('node:crypto')

const ENV_ID = process.env.TCB_ENV || 'trial-sh-d1gqznm4577d6a062'
const AUTH_BASE_URL = process.env.AUTH_BASE_URL || `https://${ENV_ID}.api.tcloudbasegateway.com`
const DAY_MS = 24 * 60 * 60 * 1000

function parseBody(event) {
  if (!event || event.body === undefined || event.body === null || event.body === '') return {}
  if (isObject(event.body)) return event.body
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : String(event.body)
  const parsed = JSON.parse(raw)
  return isObject(parsed) ? parsed : {}
}

function getQuery(event) {
  return isObject(event && event.queryStringParameters) ? event.queryStringParameters : {}
}

function getHeader(event, name) {
  const headers = isObject(event && event.headers) ? event.headers : {}
  const target = name.toLowerCase()
  const key = Object.keys(headers).find((item) => item.toLowerCase() === target)
  return key && typeof headers[key] === 'string' ? headers[key] : ''
}

function getBearerToken(event) {
  const match = getHeader(event, 'authorization').match(/^Bearer\s+(.+)$/iu)
  return match ? match[1].trim() : ''
}

async function resolveIdentity(app, event, body = parseBody(event)) {
  const query = getQuery(event)
  try {
    const user = app.auth().getUserInfo()
    const uid = user && (user.uid || user.customUserId)
    if (typeof uid === 'string' && uid) return { ok: true, kind: 'session', subjectId: uid }
  } catch (_) { /* fall through to bearer introspection */ }

  const bearer = getBearerToken(event)
  if (bearer) {
    try {
      const response = await fetch(`${AUTH_BASE_URL}/auth/v1/token/introspect`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${bearer}`,
          'x-device-id': normalizeClientId(body.client_id || query.client_id || 'web-session')
        },
        signal: AbortSignal.timeout(5000)
      })
      if (response.ok) {
        const tokenInfo = await response.json()
        if (tokenInfo && typeof tokenInfo.sub === 'string' && tokenInfo.sub) {
          return { ok: true, kind: 'session', subjectId: tokenInfo.sub }
        }
      }
    } catch (_) { /* invalid or temporarily unverifiable bearer */ }
  }

  const legacyToken = query.token || body.token || event.token || ''
  if (process.env.AUTH_TOKEN && legacyToken === process.env.AUTH_TOKEN) {
    const legacyId = event.openid || event.wxOpenid || body._cid || query._cid || body.client_id || 'legacy'
    return { ok: true, kind: 'legacy', subjectId: `legacy:${normalizeClientId(legacyId)}` }
  }
  return { ok: false }
}

function jsonResponse(statusCode, payload, requestId, origin) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Request-Id',
    Vary: 'Origin',
    'X-Request-Id': requestId
  }
  const allowedOrigin = resolveAllowedOrigin(origin)
  if (allowedOrigin) headers['Access-Control-Allow-Origin'] = allowedOrigin
  return { statusCode, headers, body: payload === null ? '' : JSON.stringify(payload) }
}

function successResponse(payload, requestId, origin) {
  return jsonResponse(200, { ...payload, code: 200, message: 'ok', data: payload }, requestId, origin)
}

function errorResponse(status, code, message, requestId, origin, retryAfter) {
  const response = jsonResponse(status, {
    code,
    message,
    request_id: requestId,
    ...(retryAfter ? { retry_after: retryAfter } : {})
  }, requestId, origin)
  if (retryAfter) response.headers['Retry-After'] = String(retryAfter)
  return response
}

function optionsResponse(requestId, origin) {
  return jsonResponse(204, null, requestId, origin)
}

function resolveAllowedOrigin(origin) {
  if (!origin) return ''
  const configured = String(process.env.ALLOWED_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean)
  if (configured.includes(origin)) return origin
  if (/^http:\/\/(localhost|127\.0\.0\.1):\d+$/u.test(origin) && process.env.ALLOW_LOCALHOST === 'true') return origin
  return ''
}

function getRequestId(event) {
  return normalizeRequestId(getHeader(event, 'x-request-id') || event && event.requestContext && event.requestContext.requestId || randomUUID())
}

function getClientIp(event) {
  const forwarded = getHeader(event, 'x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()
  return String(event && (event.clientIP || event.requestContext && event.requestContext.sourceIp) || 'unknown')
}

function shanghaiDate(now = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
  const format = (value) => {
    const parts = Object.fromEntries(formatter.formatToParts(value).map((part) => [part.type, part.value]))
    return `${parts.year}-${parts.month}-${parts.day}`
  }
  return { date: format(now), yesterday: format(new Date(now.getTime() - DAY_MS)) }
}

function normalizeClientId(value) { return String(value || '').trim().slice(0, 80) }
function isValidClientId(value) { return /^[a-zA-Z0-9:_-]{8,80}$/u.test(value) }
function normalizeRequestId(value) { return String(value || '').trim().replace(/[^a-zA-Z0-9:_-]/gu, '').slice(0, 80) || randomUUID() }
function hashValue(value, salt = '') { return createHash('sha256').update(`${salt}:${value}`).digest('hex') }
function isObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }

module.exports = { ENV_ID, parseBody, getQuery, getHeader, resolveIdentity, jsonResponse, successResponse, errorResponse, optionsResponse, getRequestId, getClientIp, shanghaiDate, normalizeClientId, isValidClientId, hashValue }
