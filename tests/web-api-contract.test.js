'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const runtime = require('../functions/ai-cheer/runtime')
const cheer = require('../functions/ai-cheer/index')

test('web runtime returns both flat and legacy-wrapped success payloads', () => {
  process.env.ALLOW_LOCALHOST = 'true'
  const response = runtime.successResponse({ answer: 'ok' }, 'request-1', 'http://127.0.0.1:5173')
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['Access-Control-Allow-Origin'], 'http://127.0.0.1:5173')
  assert.deepEqual(JSON.parse(response.body), {
    answer: 'ok',
    code: 200,
    message: 'ok',
    data: { answer: 'ok' }
  })
})

test('bearer identity is taken from verified introspection result', async () => {
  const previousFetch = global.fetch
  global.fetch = async () => ({ ok: true, json: async () => ({ sub: 'anonymous-user-1' }) })
  try {
    const identity = await runtime.resolveIdentity(
      { auth: () => ({ getUserInfo: () => ({}) }) },
      { headers: { Authorization: 'Bearer session-token' } },
      { client_id: 'client-id-1234' }
    )
    assert.deepEqual(identity, { ok: true, kind: 'session', subjectId: 'anonymous-user-1' })
  } finally {
    global.fetch = previousFetch
  }
})

test('AI output rejects numbers not present in source refs', () => {
  const source = { refs: [{ label: 'KDA', value: '4.8', source: 'season_summaries' }] }
  assert.equal(
    cheer.__test.validateGeneratedOutput(
      { lines: ['今天冲到 10 连胜', '继续向前', '期待亮相'], emoji_caption: '加油' },
      source
    ),
    null
  )
  assert.equal(
    cheer.__test.validateGeneratedOutput(
      { lines: ['4.8 的稳定就是底气', '继续向前', '期待亮相'], emoji_caption: '加油' },
      source
    ).lines.length,
    3
  )
})

test('AI output requires exactly three lines', () => {
  const source = { refs: [] }
  assert.equal(cheer.__test.validateGeneratedOutput({ lines: ['继续向前'], emoji_caption: '加油' }, source), null)
  assert.equal(
    cheer.__test.validateGeneratedOutput({ lines: ['继续向前', '期待亮相'], emoji_caption: '加油' }, source),
    null
  )
})

test('AI cheer formats whole-number win rates without a trailing decimal', () => {
  assert.equal(cheer.__test.formatRate(0.6), '60%')
  assert.equal(cheer.__test.formatRate(60), '60%')
  assert.equal(cheer.__test.formatRate('60.0%'), '60%')
  assert.equal(cheer.__test.formatRate(0.523), '52.3%')
})

test('Shanghai date is stable YYYY-MM-DD across Node locales', () => {
  assert.deepEqual(runtime.shanghaiDate(new Date('2026-07-13T16:00:00.000Z')), {
    date: '2026-07-14',
    yesterday: '2026-07-13'
  })
})

test('each deployed function owns a self-contained runtime helper', () => {
  const root = path.join(__dirname, '..', 'functions')
  const files = ['ai-cheer', 'ask', 'checkin'].map((name) => fs.readFileSync(path.join(root, name, 'runtime.js'), 'utf8'))
  assert.equal(new Set(files).size, 1)
})
