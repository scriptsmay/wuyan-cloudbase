const test = require('node:test')
const assert = require('node:assert/strict')

const modulePaths = [
  '../functions/lib/schedule-merge',
  '../functions/get-schedule/lib/schedule-merge',
  '../functions/sync-schedule/lib/schedule-merge',
  '../functions/sync-schedule-live/lib/schedule-merge'
]

const match = {
  schedule_id: 'KPL2026S2M4W3D1',
  start_ts: 1783836000,
  bo: 5
}

const cases = [
  ['before window', '2026-07-12T05:29:59Z', false],
  ['window start', '2026-07-12T05:30:00Z', true],
  ['match start', '2026-07-12T06:00:00Z', true],
  ['window end', '2026-07-12T11:30:00Z', true],
  ['after window', '2026-07-12T11:30:01Z', false]
]

for (const modulePath of modulePaths) {
  const { computeWindowStatus } = require(modulePath)

  test(`${modulePath} uses absolute timestamps for exact window boundaries`, () => {
    for (const [label, isoTime, expected] of cases) {
      const result = computeWindowStatus([match], new Date(isoTime))
      assert.equal(result.window_active, expected, label)
      assert.equal(result.active_count, expected ? 1 : 0, label)
      assert.equal(result.computed_at, new Date(isoTime).toISOString())
    }
  })

  test(`${modulePath} handles an empty schedule at the injected time`, () => {
    const now = new Date('2026-07-12T01:30:00Z')
    assert.deepEqual(computeWindowStatus([], now), {
      window_active: false,
      active_count: 0,
      computed_at: now.toISOString()
    })
  })
}
