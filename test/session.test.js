'use strict';
// The worker session: rows, filter, sort, search, copy formats, detail values and export.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSession } = require('../src/core/session');

const FX = path.join(__dirname, 'fixtures');

function harness(options) {
  const msgs = [];
  const waiters = [];
  const session = createSession({ post: m => { msgs.push(m); waiters.splice(0).forEach(w => w()); } });
  const next = async (type, pred = () => true) => {
    for (;;) {
      const i = msgs.findIndex(m => m.type === type && pred(m));
      if (i >= 0) return msgs.splice(i, 1)[0];
      await new Promise(r => waiters.push(r));
    }
  };
  const send = m => session.handle(m);
  return { session, send, next, msgs, options };
}

async function opened(file, options) {
  const h = harness();
  await h.send({ type: 'open', path: path.join(FX, file), options });
  const m = h.msgs.shift();
  return { ...h, opened: m };
}

test('open: columns, row count, info; first rows', async () => {
  const h = await opened('taxi-trips.parquet');
  assert.equal(h.opened.type, 'opened');
  assert.equal(h.opened.totalRows, 50000);
  assert.equal(h.opened.columns[0].name, 'trip_id');
  assert.equal(h.opened.info.codecs[0], 'ZSTD');
  await h.send({ type: 'rows', req: 1, viewId: 0, start: 0, end: 30 });
  const r = await h.next('rows');
  assert.equal(r.cells.length, 30);
  assert.equal(r.cells[0][0], '9007199254740993');
  assert.equal(r.rowNums[29], 29);
});

test('open error is a message, not a throw', async () => {
  const h = await opened('hostile-truncated.parquet');
  assert.equal(h.opened.type, 'openError');
  assert.equal(h.opened.code, 'TRUNCATED');
});

test('filter, sort and search', async () => {
  const h = await opened('taxi-trips.parquet');
  await h.send({ type: 'query', req: 2, filters: [{ col: 'payment', text: '=cash' }, { col: 'distance_km', text: '>10' }], sort: { col: 'fare', desc: true }, search: '' });
  const v = await h.next('view');
  assert.ok(v.count > 100 && v.count < 50000, `count ${v.count}`);
  await h.send({ type: 'rows', req: 3, viewId: 1, start: 0, end: v.count });
  const r = await h.next('rows');
  const fares = r.cells.map(c => Number(c[5]));
  for (let i = 1; i < fares.length; i++) assert.ok(fares[i - 1] >= fares[i], 'sorted descending');
  assert.ok(r.cells.every(c => c[6] === 'cash' && Number(c[4]) > 10));
  // search in every column (nested too)
  await h.send({ type: 'query', req: 4, filters: [], sort: null, search: 'wheelchair' });
  const s = await h.next('view');
  await h.send({ type: 'rows', req: 5, viewId: 2, start: 0, end: Math.min(50, s.count) });
  const sr = await h.next('rows');
  assert.ok(s.count > 0 && sr.cells.every(c => c[8].includes('wheelchair')));
  // range, null and regex
  await h.send({ type: 'query', req: 6, filters: [{ col: 'passengers', text: 'null' }], sort: { col: 'trip_id', desc: false }, search: '' });
  const nv = await h.next('view');
  await h.send({ type: 'rows', req: 7, viewId: 3, start: 0, end: 5 });
  assert.ok((await h.next('rows')).cells.every(c => c[3] === null));
  assert.ok(nv.count > 0);
  await h.send({ type: 'query', req: 8, filters: [{ col: 'pickup_zone', text: '/^(JFK|LaGuardia)/' }, { col: 'pickup_at', text: '2026-03-01..2026-03-02' }], sort: null, search: '' });
  const rv = await h.next('view');
  assert.ok(rv.count > 0);
  await h.send({ type: 'query', req: 9, filters: [{ col: 'fare', text: '/(/' }], sort: null, search: '' });
  assert.match((await h.next('queryError')).message, /Bad regular expression/);
  // clear
  await h.send({ type: 'query', req: 10, filters: [], sort: null, search: '' });
  assert.equal((await h.next('view')).count, 50000);
});

test('sort limit and nested sort give a message', async () => {
  const h = await opened('taxi-trips.parquet', { maxSortRows: 1000 });
  await h.send({ type: 'query', req: 1, filters: [], sort: { col: 'fare' }, search: '' });
  assert.match((await h.next('queryError')).message, /50,000 rows, over the limit of 1,000/);
  await h.send({ type: 'query', req: 2, filters: [], sort: { col: 'tags' }, search: '' });
  assert.match((await h.next('queryError')).message, /nested column/);
});

test('sort puts nulls last and keeps BigInt order exact', async () => {
  const h = await opened('precision.parquet');
  await h.send({ type: 'query', req: 1, filters: [], sort: { col: 'int64_big', desc: false }, search: '' });
  await h.next('view');
  await h.send({ type: 'rows', req: 2, viewId: 1, start: 0, end: 5 });
  const r = await h.next('rows');
  assert.deepEqual(r.cells.map(c => c[0]), ['-9223372036854775808', '0', '9007199254740993', '9223372036854775807', null]);
});

test('copy as CSV, TSV, JSON and Markdown', async () => {
  const h = await opened("it's 100% names.parquet");
  await h.send({ type: 'copy', req: 1, r0: 0, r1: 2, cols: [], format: 'csv' });
  assert.equal((await h.next('copyText')).text, 'rate %,"a|b","quote""col",名前,"tab\tname"\n0.5,"x|y","""q""",山田,1\n1.25,z,it\'s,Ünïcödé,2\n');
  await h.send({ type: 'copy', req: 2, r0: 0, r1: 1, cols: [1, 2], format: 'markdown' });
  assert.equal((await h.next('copyText')).text, '| a\\|b | quote"col |\n| --- | --- |\n| x\\|y | "q" |\n');
  await h.send({ type: 'copy', req: 3, r0: 1, r1: 2, cols: [0, 3], format: 'tsv' });
  assert.equal((await h.next('copyText')).text, '1.25\tÜnïcödé');
  const p = await opened('precision.parquet');
  await p.send({ type: 'copy', req: 4, r0: 0, r1: 1, cols: [0, 2, 5], format: 'json' });
  assert.deepEqual(JSON.parse((await p.next('copyText')).text), [{ int64_big: '9007199254740993', dec38: '1234567890123456789012345678.0123456789', ts_ns: '2023-11-14 22:13:20.123456789' }]);
});

test('cell detail: nested value as a tree and JSON', async () => {
  const h = await opened('nested.parquet');
  await h.send({ type: 'cell', req: 1, row: 0, col: 3 });
  const c = await h.next('cell');
  assert.deepEqual(c.tree, { name: 'Ana', address: { city: 'Lisbon', zip: '1000' } });
  assert.match(c.json, /"city": "Lisbon"/);
});

test('export the filtered view to CSV and JSON Lines', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pqv-'));
  try {
    const h = await opened('taxi-trips.parquet');
    await h.send({ type: 'query', req: 1, filters: [{ col: 'payment', text: '=voucher' }], sort: null, search: '' });
    const v = await h.next('view');
    const out = path.join(dir, 'out.csv');
    await h.send({ type: 'export', req: 2, path: out, format: 'csv' });
    const e = await h.next('exported');
    assert.equal(e.rows, v.count);
    const lines = fs.readFileSync(out, 'utf8').trim().split('\n');
    assert.equal(lines.length, v.count + 1);
    assert.ok(lines[0].startsWith('trip_id,pickup_at'));
    const outj = path.join(dir, 'out.jsonl');
    await h.send({ type: 'export', req: 3, path: outj, format: 'jsonl' });
    await h.next('exported');
    const first = JSON.parse(fs.readFileSync(outj, 'utf8').split('\n')[0]);
    assert.equal(first.payment, 'voucher');
    assert.equal(typeof first.trip_id, 'string', 'INT64 above 2^53 stays exact as a string');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
