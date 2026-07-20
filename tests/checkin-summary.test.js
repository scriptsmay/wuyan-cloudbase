'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeCheckinSummary, makeCheckinId } = require('../functions/checkin/summary');

test('computeCheckinSummary counts unique dates and trailing consecutive days', () => {
  assert.deepEqual(
    computeCheckinSummary([
      { date: '2026-07-18' },
      { date: '2026-07-19' },
      { date: '2026-07-19' },
      { date: '2026-07-21' },
    ]),
    { last_date: '2026-07-21', streak: 1, total_days: 3 }
  );
});

test('computeCheckinSummary handles a continuous history across the Shanghai date boundary', () => {
  assert.deepEqual(computeCheckinSummary([{ date: '2026-07-19' }, { date: '2026-07-20' }, { date: '2026-07-21' }]), {
    last_date: '2026-07-21',
    streak: 3,
    total_days: 3,
  });
});

test('makeCheckinId is deterministic for the same subject and business date', () => {
  assert.equal(makeCheckinId('user-1', '2026-07-21'), makeCheckinId('user-1', '2026-07-21'));
  assert.notEqual(makeCheckinId('user-1', '2026-07-21'), makeCheckinId('user-1', '2026-07-22'));
});
