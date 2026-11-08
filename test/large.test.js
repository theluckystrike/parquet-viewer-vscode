'use strict';
// Large file check. Runs only with PQV_LARGE=<path to a 1-2 GB Parquet file> (made by
// `python3 scripts/make-fixtures.py --large <path> <MB>`, kept outside the repo and deleted after the run).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { openParquet } = require('../src/core/parquet');
const { createSession } = require('../src/core/session');

const LARGE = process.env.PQV_LARGE;
const skip = !LARGE || !fs.existsSync(LARGE) ? 'set PQV_LARGE to a large Parquet file' : false;

test('large file: footer only on open, first rows fast, never the whole file', { skip }, async () => {
  const size = fs.statSync(LARGE).size;
  const t0 = Date.now();
  const s = await openParquet({ path: LARGE });
  const openMs = Date.now() - t0;
  const openRead = s.bytesRead;
  const rows = await s.rows(0, 200);
  const firstMs = Date.now() - t0;
  const mid = Math.floor(s.totalRows / 2);
  const t1 = Date.now();
  const midRows = await s.rows(mid, mid + 100);
  const midMs = Date.now() - t1;
  const last = await s.rows(s.totalRows - 50, s.totalRows);
  const rss = Math.round(process.memoryUsage().rss / 1048576);
  const out = { size, rows: s.totalRows, groups: s.groups.length, openMs, openRead, firstMs, midMs, bytesRead: s.bytesRead, share: +(s.bytesRead / size).toFixed(4), rss };
  console.log('LARGE', JSON.stringify(out));
  fs.writeFileSync(process.env.PQV_LARGE_OUT || '/dev/null', JSON.stringify(out));
  await s.close();
  assert.equal(rows.length, 200);
  assert.equal(String(midRows[0][0]), String(mid));
  assert.equal(String(last[49][0]), String(s.totalRows - 1));
  assert.ok(openRead < 2 * 1048576, `open read ${openRead} bytes`);
  assert.ok(firstMs < 3000, `first rows in ${firstMs} ms`);
  assert.ok(s.bytesRead < size / 4, `read ${s.bytesRead} of ${size}`);
  assert.ok(rss < 500, `rss ${rss} MB`);
});

test('large file: a whole-file filter streams with progress and can be cancelled', { skip }, async () => {
  const msgs = [];
  const session = createSession({ post: m => msgs.push(m) });
  await session.handle({ type: 'open', path: LARGE, options: {} });
  const q = session.handle({ type: 'query', req: 1, filters: [{ col: 'sensor', text: '=sensor-042' }], sort: null, search: '' });
  await new Promise(r => setTimeout(r, 1500));
  await session.handle({ type: 'cancel', req: 2 });
  await q;
  assert.ok(msgs.some(m => m.type === 'progress'), 'progress was posted');
  assert.ok(!msgs.some(m => m.type === 'view'), 'cancelled before it finished');
  const rss = Math.round(process.memoryUsage().rss / 1048576);
  assert.ok(rss < 700, `rss ${rss} MB`);
  await session.handle({ type: 'close' });
});
