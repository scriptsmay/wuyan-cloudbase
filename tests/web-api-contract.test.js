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
  const validLines = [
    '4.8 的稳定就是底气，继续保持节奏向前冲刺，我们一直在为你加油',
    '继续向前，慢慢找回节奏，我们会一直在背后为你加油和守护每一场比赛',
    '期待亮相，下一场也请尽情发挥自己的实力，所有努力都会有回响吧'
  ]
  assert.equal(
    cheer.__test.validateGeneratedOutput(
      {
        lines: ['今天冲到 10 连胜，继续保持节奏向前冲刺，我们一直在为你加油', validLines[1], validLines[2]],
        emoji_caption: '加油'
      },
      source
    ),
    null
  )
  assert.equal(
    cheer.__test.validateGeneratedOutput(
      { lines: validLines, emoji_caption: '加油' },
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

test('AI output enforces the 30-50 character line length range', () => {
  const source = { refs: [] }
  const makeOutput = (length) => ({
    lines: ['字'.repeat(length), '字'.repeat(length), '字'.repeat(length)],
    emoji_caption: '加油'
  })

  assert.equal(cheer.__test.validateGeneratedOutput(makeOutput(29), source), null)
  assert.equal(cheer.__test.validateGeneratedOutput(makeOutput(30), source).lines.length, 3)
  assert.equal(cheer.__test.validateGeneratedOutput(makeOutput(50), source).lines.length, 3)
  assert.equal(cheer.__test.validateGeneratedOutput(makeOutput(51), source), null)
})

test('AI cheer formats whole-number win rates without a trailing decimal', () => {
  assert.equal(cheer.__test.formatRate(0.6), '60%')
  assert.equal(cheer.__test.formatRate(60), '60%')
  assert.equal(cheer.__test.formatRate('60.0%'), '60%')
  assert.equal(cheer.__test.formatRate(0.523), '52.3%')
})

test('AI cheer exposes expanded season metrics and the top three heroes', () => {
  const source = cheer.__test.buildGroundedSource({
    season: 'KPL2026S2',
    updated_at: '2026-07-13T20:00:04.776Z',
    data: {
      data: {
        season_stats: [
          {
            season_id: 'KPL2026S2',
            kda_ratio: 5,
            win_rate: '60.0%',
            battles: 25,
            mvp: 6,
            avg_assists: 4.64
          }
        ],
        hero_stats: [
          { hero_name: '狂铁', battles: 22, win_rate: '72.7%' },
          { hero_name: '关羽', battles: 18, win_rate: '77.8%' },
          { hero_name: '夏洛特', battles: 27, win_rate: '70.4%' },
          { hero_name: '马超', battles: 17, win_rate: '41.2%' }
        ]
      }
    }
  })

  assert.deepEqual(source.promptLines, [
    '当前赛季 KDA：5',
    '当前赛季胜率：60%',
    '当前赛季对局数：25',
    '当前赛季 MVP 次数：6',
    '当前赛季场均助攻：4.64',
    '常用英雄（按出场数）：夏洛特（27局，胜率70.4%）、狂铁（22局，胜率72.7%）、关羽（18局，胜率77.8%）'
  ])
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
