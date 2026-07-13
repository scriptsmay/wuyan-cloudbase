'use strict'

const DEFAULT_BLOCKED_PATTERNS = [/自杀/u, /博彩/u, /色情/u, /仇恨/u]

/**
 * 检查文本是否包含被阻止的内容
 * @param {string} text
 * @returns {boolean}
 */
function isContentBlocked(text) {
  if (typeof text !== 'string' || !text) return false
  const configured = String(process.env.BLOCKED_TERMS || '')
    .split(',')
    .map(function (item) { return item.trim() })
    .filter(Boolean)
  return configured.some(function (term) { return text.includes(term) }) ||
    DEFAULT_BLOCKED_PATTERNS.some(function (pattern) { return pattern.test(text) })
}

/**
 * 格式化胜率为 xx.x%
 * @param {*} v
 * @returns {string}
 */
function fmtRate(v) {
  if (v === null || v === undefined) return '暂无'
  if (typeof v === 'string') {
    if (v.includes('%')) return v
    var n = parseFloat(v)
    if (!isNaN(n) && n <= 1) return (n * 100).toFixed(1) + '%'
    return v
  }
  if (typeof v === 'number') {
    if (v <= 1) return (v * 100).toFixed(1) + '%'
    return v.toFixed(1) + '%'
  }
  return String(v)
}

module.exports = {
  isContentBlocked,
  fmtRate
}
