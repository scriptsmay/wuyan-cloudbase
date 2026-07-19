'use strict';

const { createHash, randomBytes, randomUUID } = require('node:crypto');

const ENV_ID = process.env.TCB_ENV || 'trial-sh-d1gqznm4577d6a062';
const AUTH_BASE_URL = process.env.AUTH_BASE_URL || `https://${ENV_ID}.api.tcloudbasegateway.com`;
const TRANSFER_TTL_MS = 10 * 60 * 1000;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseBody(event) {
  if (!event || event.body === undefined || event.body === null || event.body === '') return {};
  if (isObject(event.body)) return event.body;
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : String(event.body);
  const parsed = JSON.parse(raw);
  return isObject(parsed) ? parsed : {};
}

function getHeader(event, name) {
  const headers = isObject(event && event.headers) ? event.headers : {};
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
  return key && typeof headers[key] === 'string' ? headers[key] : '';
}

function getRequestId(event) {
  const value = getHeader(event, 'x-request-id') || (event && event.requestContext && event.requestContext.requestId);
  return (
    String(value || randomUUID())
      .replace(/[^a-zA-Z0-9:_-]/gu, '')
      .slice(0, 80) || randomUUID()
  );
}

function getPath(event) {
  const candidates = [
    event && event.requestContext && event.requestContext.path,
    event && event.rawPath,
    event && event.path,
  ];
  const path = candidates.find((value) => typeof value === 'string' && value.startsWith('/'));
  if (path) return path.replace(/\/$/u, '');
  return '/api/auth/me';
}

function getBearerToken(event) {
  const match = getHeader(event, 'authorization').match(/^Bearer\s+(.+)$/iu);
  return match ? match[1].trim() : '';
}

function isAnonymousTokenInfo(info) {
  if (!isObject(info)) return false;
  if (info.is_anonymous === true || info.isAnonymous === true || info.anonymous === true) return true;
  const user = isObject(info.user) ? info.user : {};
  if (user.is_anonymous === true || user.isAnonymous === true) return true;
  return ['anonymous', 'ANONYMOUS'].includes(
    String(info.login_type || info.loginType || user.login_type || user.loginType || '')
  );
}

async function resolveIdentity(event, body = {}) {
  const bearer = getBearerToken(event);
  if (!bearer) return { ok: false };
  try {
    const response = await fetch(`${AUTH_BASE_URL}/auth/v1/token/introspect`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${bearer}`, 'x-device-id': String(body.client_id || 'web-session') },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return { ok: false };
    const info = await response.json();
    if (!info || typeof info.sub !== 'string' || !info.sub) return { ok: false };
    return { ok: true, subjectId: info.sub, isAnonymous: isAnonymousTokenInfo(info), tokenInfo: info };
  } catch (_) {
    return { ok: false };
  }
}

function hashTicket(ticket) {
  return createHash('sha256')
    .update(`${process.env.TRANSFER_TICKET_SALT || ENV_ID}:${ticket}`)
    .digest('hex');
}

function createTicket() {
  return randomBytes(32).toString('base64url');
}

function transferExpiry(now = Date.now()) {
  return new Date(now + TRANSFER_TTL_MS).toISOString();
}

function isExpired(value, now = Date.now()) {
  const timestamp = Date.parse(String(value || ''));
  return !Number.isFinite(timestamp) || timestamp <= now;
}

function jsonResponse(statusCode, payload, requestId, origin) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Request-Id',
    Vary: 'Origin',
    'X-Request-Id': requestId,
  };
  const allowed = String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (
    origin &&
    (allowed.includes(origin) ||
      (/^http:\/\/(localhost|127\.0\.0\.1):\d+$/u.test(origin) && process.env.ALLOW_LOCALHOST === 'true'))
  ) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return { statusCode, headers, body: payload === null ? '' : JSON.stringify(payload) };
}

function successResponse(payload, requestId, origin) {
  return jsonResponse(200, { ...payload, code: 200, message: 'ok', data: payload }, requestId, origin);
}

function errorResponse(status, code, message, requestId, origin) {
  return jsonResponse(status, { code, message, request_id: requestId }, requestId, origin);
}

module.exports = {
  TRANSFER_TTL_MS,
  parseBody,
  getHeader,
  getPath,
  getRequestId,
  resolveIdentity,
  hashTicket,
  createTicket,
  transferExpiry,
  isExpired,
  jsonResponse,
  successResponse,
  errorResponse,
  isAnonymousTokenInfo,
};
