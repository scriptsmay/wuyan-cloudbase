const cloudbase = require('@cloudbase/node-sdk');
const app = cloudbase.init({ env: 'trial-sh-d1gqznm4577d6a062' });
const db = app.database();

const API_BASE = 'https://cal.kplwuyan.site/api/streams';

/**
 * Fetch live stream data from wuyan-calendar API
 * @param {number} year
 * @param {number} month - 1-12
 * @returns {Promise<object|null>}
 */
async function fetchStreams(year, month) {
  const url = `${API_BASE}?year=${year}&month=${month}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`API ${url} returned ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`Failed to fetch ${url}:`, err.message);
    return null;
  }
}

/**
 * Normalize and store individual stream records
 */
async function upsertStreams(streams, year, month) {
  let count = 0;
  for (const s of streams) {
    const doc = {
      stream_date: s.date,
      year: year,
      month: month,
      start_time: s.startTime,
      duration: s.duration,
      title: s.title,
      external_id: s.id,
      updated_at: new Date().toISOString(),
    };
    // Upsert by stream_date + external_id combo
    const existing = await db.collection('live_streams').where({ stream_date: s.date, external_id: s.id }).get();
    if (existing.data && existing.data.length > 0) {
      await db.collection('live_streams').doc(existing.data[0]._id).update(doc);
    } else {
      await db.collection('live_streams').add(doc);
    }
    count++;
  }
  return count;
}

/**
 * Store monthly summary as a separate doc
 */
async function upsertSummary(year, month, summary) {
  const doc = {
    type: 'monthly_summary',
    year: year,
    month: month,
    month_key: `${year}-${String(month).padStart(2, '0')}`,
    total_days: summary.totalDays,
    total_sessions: summary.totalSessions,
    total_hours: summary.totalHours,
    avg_hours_per_session: summary.avgHoursPerSession,
    updated_at: new Date().toISOString(),
  };
  const existing = await db
    .collection('live_streams')
    .where({ type: 'monthly_summary', month_key: doc.month_key })
    .get();
  if (existing.data && existing.data.length > 0) {
    await db.collection('live_streams').doc(existing.data[0]._id).update(doc);
  } else {
    await db.collection('live_streams').add(doc);
  }
}

exports.main = async (event = {}) => {
  const now = new Date();
  const currentYear = event.year || now.getFullYear();
  const currentMonth = event.month || now.getMonth() + 1;

  // Sync current month + previous month
  const months = [
    { year: currentYear, month: currentMonth },
    { year: currentMonth === 1 ? currentYear - 1 : currentYear, month: currentMonth === 1 ? 12 : currentMonth - 1 },
  ];

  const results = [];

  for (const { year, month } of months) {
    console.log(`Fetching streams for ${year}-${month}`);
    const data = await fetchStreams(year, month);

    if (!data || !data.streams) {
      results.push({ month: `${year}-${month}`, status: 'api_error' });
      continue;
    }

    if (data.streams.length === 0) {
      results.push({ month: `${year}-${month}`, status: 'empty', sessions: 0 });
      continue;
    }

    const count = await upsertStreams(data.streams, year, month);
    await upsertSummary(year, month, data.summary);

    results.push({
      month: `${year}-${month}`,
      status: 'ok',
      sessions: count,
      summary: data.summary,
    });
  }

  // Write sync snapshot
  await db.collection('sync_snapshots').add({
    type: 'live_streams',
    status: 'success',
    results: results,
    created_at: new Date().toISOString(),
  });

  return { success: true, results };
};
