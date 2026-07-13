'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const checkin = require('../functions/checkin/index');

function fakeDb(checkinsDoc, reportsDoc) {
  return {
    collection(name) {
      const doc = name === 'checkins' ? checkinsDoc : reportsDoc;
      return {
        doc() {
          return {
            async get() {
              return { data: doc ? [doc] : [] };
            },
          };
        },
      };
    },
  };
}

const SUBJECT = 'user-1';

test('getMyReport returns stored report when subject matches', async () => {
  const db = fakeDb(
    { subject_id: SUBJECT, date: '2026-07-13', report_id: 'rep-1' },
    {
      report_id: 'rep-1',
      subject_id: SUBJECT,
      ai_output: { lines: ['今天也要加油'], emoji_caption: '冲', refs: [{ label: 'KDA', value: '4.8', source: 'x' }] },
      source_snapshot_at: '2026-07-13T00:00:00.000Z',
    }
  );
  const report = await checkin.__test.getMyReport(SUBJECT, db);
  assert.deepEqual(report, {
    lines: ['今天也要加油'],
    emoji_caption: '冲',
    report_id: 'rep-1',
    refs: [{ label: 'KDA', value: '4.8', source: 'x' }],
    source_snapshot_at: '2026-07-13T00:00:00.000Z',
  });
});

test('getMyReport returns null when no report_id stored', async () => {
  const db = fakeDb({ subject_id: SUBJECT, date: '2026-07-13' }, null);
  assert.equal(await checkin.__test.getMyReport(SUBJECT, db), null);
});

test('getMyReport returns null when report missing', async () => {
  const db = fakeDb({ subject_id: SUBJECT, date: '2026-07-13', report_id: 'rep-1' }, null);
  assert.equal(await checkin.__test.getMyReport(SUBJECT, db), null);
});

test('getMyReport returns null when subject_id mismatches (only owner visible)', async () => {
  const db = fakeDb(
    { subject_id: SUBJECT, date: '2026-07-13', report_id: 'rep-1' },
    { report_id: 'rep-1', subject_id: 'other-user', ai_output: { lines: ['x'], emoji_caption: 'y', refs: [] } }
  );
  assert.equal(await checkin.__test.getMyReport(SUBJECT, db), null);
});

test('getMyReport tolerates missing ai_output fields', async () => {
  const db = fakeDb(
    { subject_id: SUBJECT, date: '2026-07-13', report_id: 'rep-1' },
    { report_id: 'rep-1', subject_id: SUBJECT }
  );
  const report = await checkin.__test.getMyReport(SUBJECT, db);
  assert.deepEqual(report, {
    lines: [],
    emoji_caption: '',
    report_id: 'rep-1',
    refs: [],
    source_snapshot_at: '',
  });
});
