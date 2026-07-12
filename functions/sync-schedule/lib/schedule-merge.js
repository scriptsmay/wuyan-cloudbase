/**
 * schedule-merge — 赛程窗口计算与事务合并公共逻辑
 *
 * 由 sync-schedule（每日兜底）和 sync-schedule-live（比赛日高频）共用。
 * get-schedule API 也复用 computeWindowStatus 纯函数以返回即时计算的 window_active。
 */

// ---- 窗口计算 ----

/**
 * 判断单场比赛是否在其活跃窗口内。
 *
 * 窗口 = [start_ts - 30min, start_ts + expected_duration + 90min]
 * expected_duration = bo >= 7 ? 5h : 4h
 *
 * @param {Object} match - { start_ts, bo }
 * @param {Date} now - 当前时刻（Date 内部为 UTC epoch，与运行时时区无关）
 * @returns {boolean}
 */
function isMatchInWindow(match, now) {
  if (!match || !match.start_ts) return false

  const nowTs = Math.floor(now.getTime() / 1000)
  const startTs = match.start_ts
  const bo = match.bo || 5
  const expectedSec = (bo >= 7 ? 5 : 4) * 3600

  const windowStart = startTs - 30 * 60
  const windowEnd = startTs + expectedSec + 90 * 60

  return nowTs >= windowStart && nowTs <= windowEnd
}

/**
 * 计算当前窗口状态。**纯函数**，get-schedule API 和 sync-schedule-live 共用。
 *
 * 注意：每场比赛独立计算窗口，不合并成超长窗口。
 *
 * @param {Array<Object>} matches - match_schedules.matches[]
 * @param {Date} now - 可注入的当前时刻，默认为真实当前时间
 * @returns {{ window_active: boolean, active_count: number, computed_at: string }}
 */
function computeWindowStatus(matches, now = new Date()) {
  if (!Array.isArray(matches) || matches.length === 0) {
    return { window_active: false, active_count: 0, computed_at: now.toISOString() }
  }
  const activeCount = matches.filter(m => isMatchInWindow(m, now)).length
  return {
    window_active: activeCount > 0,
    active_count: activeCount,
    computed_at: now.toISOString()
  }
}

// ---- KPL API ----

const KPL_API_BASE = 'https://kplshop-op.timi-esports.qq.com/kplow'
const TEAM_KEYWORD = 'KSG'

/**
 * 调用 KPL getScheduleList 返回全量赛程原始响应。
 * 不做过滤，不做转换，调用方负责处理。
 *
 * @param {string} seasonId - 赛季 ID
 * @param {number} timeout - 超时 ms
 * @returns {Array<Object>} 原始比赛列表
 */
async function fetchKplScheduleList(seasonId, timeout = 15000) {
  const https = require('https')
  const http = require('http')
  const url = new URL(`${KPL_API_BASE}/getScheduleList`)

  const payload = JSON.stringify({ season_id: seasonId })
  const options = {
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    },
    timeout
  }

  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http
    const req = transport.request(options, (res) => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => {
        try {
          const data = JSON.parse(body)
          const list = data?.data?.list
          if (!Array.isArray(list)) {
            reject(new Error(`KPL API returned non-list: body_len=${body.length}`))
            return
          }
          resolve(list)
        } catch (e) {
          reject(new Error(`KPL API JSON parse error: ${e.message}`))
        }
      })
    })
    req.on('timeout', () => { req.destroy(); reject(new Error('KPL API timeout')) })
    req.on('error', (e) => reject(new Error(`KPL API request error: ${e.message}`)))
    req.write(payload)
    req.end()
  })
}

/**
 * 将 KPL 原始比赛数据转换为 canonical match 格式。
 * 只返回 team_a_name 或 team_b_name 包含 TEAM_KEYWORD 的比赛。
 *
 * @param {Array<Object>} rawMatches - getScheduleList 返回的 list
 * @param {string} seasonId - 赛季 ID（用于日志）
 * @returns {{ matches: Array<Object>, allCount: number, ksgCount: number }}
 */
function convertKplMatches(rawMatches, seasonId) {
  const allMatches = rawMatches.map(m => {
    const status = parseInt(m.schedule_status, 10) || 1
    const teamA = m.team_a_name || ''
    const teamB = m.team_b_name || ''
    const match = {
      schedule_id: String(m.scheduleid || ''),
      start_ts: parseInt(m.start_timestamp, 10) || 0,
      date: tsToBeijingDate(m.start_timestamp),
      team_a: teamA,
      team_b: teamB,
      is_ksg: teamA.includes(TEAM_KEYWORD) || teamB.includes(TEAM_KEYWORD),
      location: m.location_name || '',
      stage: m.stage_name || '',
      bo: parseInt(m.bo_total, 10) || 5,
      status
    }
    if (status >= 2) {
      match.score_a = parseInt(m.team_a_score, 10) || 0
      match.score_b = parseInt(m.team_b_score, 10) || 0
    }
    return match
  })

  const ksgMatches = allMatches.filter(m => m.is_ksg)
  ksgMatches.sort((a, b) => (a.start_ts || 0) - (b.start_ts || 0))

  console.log(`[schedule-merge] KPL fetch: ${allMatches.length} total, ${ksgMatches.length} KSG matches`)
  return { matches: ksgMatches, allCount: allMatches.length, ksgCount: ksgMatches.length }
}

function tsToBeijingDate(tsStr) {
  try {
    const ts = parseInt(tsStr, 10)
    if (!ts) return ''
    const d = new Date(ts * 1000)
    const bj = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }))
    const mm = String(bj.getMonth() + 1).padStart(2, '0')
    const dd = String(bj.getDate()).padStart(2, '0')
    const hh = String(bj.getHours()).padStart(2, '0')
    const min = String(bj.getMinutes()).padStart(2, '0')
    return `${mm}-${dd} ${hh}:${min}`
  } catch (_) {
    return ''
  }
}

// ---- 事务合并 ----

/**
 * 判断是否为 CloudBase 数据库事务冲突错误。
 */
function isTransactionConflict(err) {
  if (!err) return false
  const code = err.code || err.errorCode || ''
  return code === 'DATABASE_TRANSACTION_CONFLICT' || code === 'DATABASE_TRANSACTION_FAIL'
}

/**
 * 按 schedule_id（主键）或 start_ts + team_a + team_b（兼容兜底）匹配。
 * 返回 matchedIndex，未匹配返回 -1。
 */
function findMatchIndex(matches, update) {
  // 主键：schedule_id
  if (update.schedule_id) {
    const idx = matches.findIndex(m => m.schedule_id && m.schedule_id === update.schedule_id)
    if (idx >= 0) return { index: idx, key: 'schedule_id' }
  }
  // 兼容兜底：start_ts + team_a + team_b（仅当旧数据缺少 schedule_id 时）
  if (update.start_ts && update.team_a && update.team_b) {
    const idx = matches.findIndex(m =>
      !m.schedule_id &&
      m.start_ts === update.start_ts &&
      m.team_a === update.team_a &&
      m.team_b === update.team_b
    )
    if (idx >= 0) return { index: idx, key: 'fallback' }
  }
  return { index: -1, key: null }
}

/** 允许增量更新的字段 */
const UPDATABLE_FIELDS = ['start_ts', 'date', 'status', 'score_a', 'score_b', 'stage', 'location', 'bo']

/**
 * 在事务内执行赛程合并写入。
 *
 * - 每日全量（isFullSync=true）：按 schedule_id 合并全部赛程，仅当 source_fetched_at 晚于
 *   文档已有 source_fetched_at 时才吸收；可新增比赛。
 * - 实时增量（isFullSync=false）：只合并匹配到的比赛，不新增、不删除、不重排。
 *
 * @param {Object} db - CloudBase database 实例
 * @param {string} seasonId - 赛季 ID
 * @param {Array<Object>} updates - 待合并的 match 数组
 * @param {Object} opts
 * @param {boolean} opts.isFullSync - 是否为每日全量同步
 * @param {string}  opts.sourceFetchedAt - 本次数据源采集时间
 * @param {string}  opts.sourceStatus - 数据源状态（'ok' / 'error'）
 * @param {boolean} opts.isLive - 是否为实时同步（影响 last_live_synced_at）
 * @param {number}  opts.maxRetries - 事务冲突最大重试次数（默认 3）
 * @returns {{ action: string, matchedCount: number, changedCount: number, revision: number, fallbackUsed: boolean }}
 */
async function mergeScheduleMatches(db, seasonId, updates, opts = {}) {
  const {
    isFullSync = false,
    sourceFetchedAt = null,
    sourceStatus = 'ok',
    isLive = false,
    maxRetries = 3
  } = opts

  let lastError = null

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await db.runTransaction(async (transaction) => {
        const existing = await transaction.collection('match_schedules')
          .where({ season_id: seasonId })
          .get()

        if (existing.data.length === 0) {
          // 无已有文档：创建新文档
          const doc = {
            season_id: seasonId,
            season_name: updates.length > 0 ? (updates[0].season_name || seasonId) : seasonId,
            team_id: '',
            matches: updates.sort((a, b) => (a.start_ts || 0) - (b.start_ts || 0)),
            revision: 1,
            updated_at: new Date().toISOString(),
            source_fetched_at: sourceFetchedAt || new Date().toISOString(),
            source_status: sourceStatus
          }
          if (isLive) {
            doc.last_live_synced_at = new Date().toISOString()
          }
          await transaction.collection('match_schedules').add(doc)
          return {
            action: 'created',
            matchedCount: updates.length,
            changedCount: updates.length,
            revision: 1,
            fallbackUsed: false
          }
        }

        const doc = existing.data[0]
        const currentRevision = doc.revision || 0
        const matches = Array.from(doc.matches || [])

        // 每日全量：检查数据源时间，旧文件跳过
        if (isFullSync && sourceFetchedAt && doc.source_fetched_at) {
          if (new Date(sourceFetchedAt) <= new Date(doc.source_fetched_at)) {
            return {
              action: 'skipped',
              reason: 'source_not_newer',
              matchedCount: 0,
              changedCount: 0,
              revision: currentRevision,
              fallbackUsed: false
            }
          }
        }

        let matchedCount = 0
        let changedCount = 0
        let fallbackUsed = false

        for (const update of updates) {
          const { index, key } = findMatchIndex(matches, update)
          if (key === 'fallback') fallbackUsed = true

          if (index >= 0) {
            matchedCount++
            // 检查是否有实际字段变化
            let changed = false
            for (const field of UPDATABLE_FIELDS) {
              if (update[field] !== undefined && update[field] !== matches[index][field]) {
                matches[index][field] = update[field]
                changed = true
              }
            }
            // 实时同步时确保 schedule_id 被写入（旧数据可能缺失）
            if (update.schedule_id && !matches[index].schedule_id) {
              matches[index].schedule_id = update.schedule_id
              changed = true
            }
            if (changed) changedCount++
          } else if (isFullSync) {
            // 每日全量可新增比赛
            matches.push(update)
            matchedCount++
            changedCount++
          }
        }

        // 排序
        matches.sort((a, b) => (a.start_ts || 0) - (b.start_ts || 0))

        const updateData = {
          matches,
          revision: currentRevision + 1,
          updated_at: new Date().toISOString()
        }

        if (sourceFetchedAt) {
          updateData.source_fetched_at = sourceFetchedAt
        }
        if (sourceStatus) {
          updateData.source_status = sourceStatus
        }
        if (isLive && changedCount > 0) {
          updateData.last_live_synced_at = new Date().toISOString()
        }

        await transaction.collection('match_schedules')
          .doc(doc._id)
          .update(updateData)

        return {
          action: changedCount > 0 ? 'updated' : 'no_change',
          matchedCount,
          changedCount,
          revision: currentRevision + 1,
          fallbackUsed
        }
      })

      if (result.fallbackUsed) {
        console.warn(`[schedule-merge] Fallback merge key used for season=${seasonId}`)
      }
      return result

    } catch (err) {
      lastError = err
      if (isTransactionConflict(err) && attempt < maxRetries - 1) {
        console.warn(`[schedule-merge] Transaction conflict (attempt ${attempt + 1}/${maxRetries}), retrying...`)
        // 小退避
        await new Promise(r => setTimeout(r, 100 * (attempt + 1)))
        continue
      }
      throw err
    }
  }

  throw lastError || new Error('mergeScheduleMatches: max retries exceeded')
}

// ---- 快照记录 ----

/**
 * 写入 sync_snapshots 记录。
 *
 * @param {Object} db - CloudBase database 实例
 * @param {Object} snap
 * @param {string} snap.type - "schedule" | "schedule-live"
 * @param {string} snap.season - 赛季 ID
 * @param {string} snap.status - "success" | "error" | "skipped" | "no_change"
 * @param {number} snap.matchedCount
 * @param {number} snap.changedCount
 * @param {boolean} snap.windowActive
 * @param {string}  snap.sourceFetchedAt
 * @param {string}  snap.error
 */
async function recordSyncSnapshot(db, snap) {
  const doc = {
    season: snap.season || 'unknown',
    type: snap.type || 'schedule',
    status: snap.status || 'ok',
    matched_count: snap.matchedCount ?? 0,
    changed_count: snap.changedCount ?? 0,
    window_active: snap.windowActive ?? false,
    source_fetched_at: snap.sourceFetchedAt || null,
    error: snap.error || null,
    updated_at: new Date().toISOString()
  }
  try {
    await db.collection('sync_snapshots').add(doc)
  } catch (e) {
    console.error(`[schedule-merge] Failed to record snapshot: ${e.message}`)
  }
}

module.exports = {
  isMatchInWindow,
  computeWindowStatus,
  fetchKplScheduleList,
  convertKplMatches,
  mergeScheduleMatches,
  recordSyncSnapshot,
  isTransactionConflict,
  UPDATABLE_FIELDS
}
