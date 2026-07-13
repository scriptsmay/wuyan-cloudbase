const test = require('node:test')
const assert = require('node:assert/strict')

const { isContentBlocked, fmtRate } = require('../functions/lib/ai-utils')

test('isContentBlocked blocks configured terms', () => {
  // Set env var for test
  process.env.BLOCKED_TERMS = '赌博,色情,自杀'
  assert.equal(isContentBlocked('这是一条包含赌博的测试'), true)
  assert.equal(isContentBlocked('包含色情内容'), true)
  assert.equal(isContentBlocked('涉及自杀相关'), true)
  assert.equal(isContentBlocked('正常应援文案加油'), false)
  assert.equal(isContentBlocked(''), false)
  assert.equal(isContentBlocked(''), false, 'empty string is not blocked')
  delete process.env.BLOCKED_TERMS
})

test('isContentBlocked uses built-in patterns', () => {
  // Without BLOCKED_TERMS, only regex patterns should match
  assert.equal(isContentBlocked('博彩网站推荐'), true, 'blocked regex pattern')
  assert.equal(isContentBlocked('KPL加油无言最强'), false, 'normal cheer text')
})

test('fmtRate formats win rate values', () => {
  assert.equal(fmtRate(0.523), '52.3%')
  assert.equal(fmtRate(0.0), '0.0%')
  assert.equal(fmtRate(1.0), '100.0%')
  assert.equal(fmtRate(52.3), '52.3%')
  assert.equal(fmtRate('0.523'), '52.3%')
  assert.equal(fmtRate('52.3%'), '52.3%')
  assert.equal(fmtRate(null), '暂无')
  assert.equal(fmtRate(undefined), '暂无')
  assert.equal(fmtRate('暂无'), '暂无')
})
