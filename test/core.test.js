'use strict';
// Values against pyarrow (expected.json from scripts/make-fixtures.py), the Apache parquet-testing files and hostile files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { openParquet } = require('../src/core/parquet');
const F = require('../src/core/format');

const FX = path.join(__dirname, 'fixtures');
const expected = JSON.parse(fs.readFileSync(path.join(FX, 'expected.json'), 'utf8'));

async function firstRows(file, n = 5) {
  const s = await openParquet({ path: path.join(FX, file) });
  try {
    const rows = await s.rows(0, Math.min(n, s.totalRows));
    return { s, cells: rows.map(r => r.map(F.cellText)), raw: rows };
  } finally { await s.close(); }
}

for (const [file, exp] of Object.entries(expected)) {
  test(`matches pyarrow: ${file}`, async () => {
    const { s, cells } = await firstRows(file, exp.first.length);
    assert.equal(s.totalRows, exp.rows, 'row count');
    assert.deepEqual(s.columns.map(c => c.name), exp.columns, 'column names');
    exp.first.forEach((row, i) => row.forEach((want, c) => {
      if (want === '__skip__') return;
      assert.equal(cells[i][c], want, `${file} row ${i} column ${exp.columns[c]}`);
    }));
  });
}

test('exact values a JS number would round: INT64, UINT64, DECIMAL(38,10)', async () => {
  for (const f of ['precision.parquet', 'precision-flba.parquet']) {
    const { cells, s } = await firstRows(f);
    const col = n => s.columns.findIndex(c => c.name === n);
    assert.equal(cells[0][col('int64_big')], '9007199254740993');
    assert.equal(cells[1][col('int64_big')], '-9223372036854775808');
    assert.equal(cells[0][col('uint64_big')], '18446744073709551615');
    assert.equal(cells[0][col('dec38')], '1234567890123456789012345678.0123456789');
    assert.equal(cells[1][col('dec38')], '-0.0000000001');
    assert.equal(cells[3][col('dec38')], '99999999999999999999999999.9999999999');
    assert.equal(cells[1][col('dec9_2')], '-0.05');
    assert.equal(cells[0][col('dec18_4')], '12345678901234.5678');
    assert.equal(cells[0][col('ts_ns')], '2023-11-14 22:13:20.123456789');
    assert.equal(cells[2][col('ts_ns')], '1969-12-31 23:59:59.999999999');
    assert.equal(cells[3][col('ts_us_utc')], '9999-12-31 23:59:59.999999');
    assert.equal(cells[4][col('ts_us_utc')], '0001-01-01 00:00:00');
    assert.equal(cells[0][col('time_us')], '23:59:59.999999');
    assert.equal(cells[3][col('time_ms')], '06:07:08.009');
    assert.equal(cells[0][col('raw')], '0x0001ff');
  }
});

test('Apache parquet-testing: decimals, INT96, nested, codecs, encodings', async () => {
  const one = async (f, n = 3) => (await firstRows(path.join('apache', f), n)).cells;
  assert.deepEqual((await one('int32_decimal.parquet')).map(r => r[0]), ['1.00', '2.00', '3.00']);
  assert.deepEqual((await one('int64_decimal.parquet')).map(r => r[0]), ['1.00', '2.00', '3.00']);
  assert.deepEqual((await one('fixed_length_decimal.parquet')).map(r => r[0]), ['1.00', '2.00', '3.00']);
  assert.deepEqual((await one('byte_array_decimal.parquet')).map(r => r[0]), ['1', '2', '3']);
  assert.deepEqual((await one('int96_from_spark.parquet')).map(r => r[0]), ['2024-01-01 20:34:56.123456', '2024-01-01 01:00:00', '9999-12-31 03:00:00']);
  assert.deepEqual((await one('flba12_timestamp.parquet', 6)).map(r => r[2]), ['1970-01-01 00:00:00', '1970-01-01 00:00:01', '1969-12-31 23:59:59', '2262-04-11 23:47:16', '9999-12-31 23:59:59', '0001-01-01 00:00:00']);
  assert.equal((await one('nested_maps.snappy.parquet'))[0][0], '{"a":{"1":true,"2":false}}');
  assert.equal((await one('nested_lists.snappy.parquet'))[0][0], '[[["a","b"],["c"]],[null,["d"]]]');
  assert.deepEqual((await one('lz4_raw_compressed.parquet'))[0], ['1593604800', 'abc', '42']);
  assert.deepEqual((await one('hadoop_lz4_compressed.parquet'))[1], ['1593604800', 'def', '7.7']);
  assert.equal((await one('binary.parquet'))[1][0], '0x01');
  assert.equal((await one('bson.parquet'))[0][0], '0x0c0000001061000100000000');
  assert.deepEqual((await one('datapage_v2.snappy.parquet'))[0], ['abc', '1', '2', 'true', '[1,2,3]']);
});

test('nested columns: lists, structs, maps and lists of structs', async () => {
  const { cells, s } = await firstRows('nested.parquet');
  assert.deepEqual(s.columns.map(c => c.kind), ['int', 'list', 'list', 'struct', 'map', 'list']);
  assert.equal(cells[0][1], '[1,2,3]');
  assert.equal(cells[0][2], '[["a","b"],["c"]]');
  assert.equal(cells[0][3], '{"name":"Ana","address":{"city":"Lisbon","zip":"1000"}}');
  assert.equal(cells[0][4], '{"math":90,"art":75}');
  assert.equal(cells[0][5], '[{"t":1,"kind":"open"},{"t":2,"kind":"close"}]');
  assert.equal(cells[2][1], null);
});

test('every codec gives the same rows', async () => {
  const base = (await firstRows('codec-none.parquet', 50)).cells;
  for (const c of ['snappy', 'gzip', 'zstd', 'brotli', 'lz4']) {
    assert.deepEqual((await firstRows(`codec-${c}.parquet`, 50)).cells, base, c);
  }
  assert.deepEqual((await firstRows('legacy-v1.parq', 50)).cells, base, '.parq, format 1.0, data page v1, no dictionary');
  assert.deepEqual((await firstRows('datapage-v2.pq', 50)).cells, base, '.pq, data page v2');
});

test('rows deep in a file come from range reads (page index file)', async () => {
  const s = await openParquet({ path: path.join(FX, 'page-index.parquet') });
  try {
    const before = s.bytesRead;
    const rows = await s.rows(17000, 17010);
    assert.equal(rows.length, 10);
    assert.ok(s.bytesRead - before < s.size / 4, `read ${s.bytesRead - before} of ${s.size}`);
    const all = await openParquet({ path: path.join(FX, 'taxi-trips.parquet') });
    const ref = await all.rows(17000, 17010);
    await all.close();
    assert.deepEqual(rows.map(r => r.map(F.cellText)), ref.map(r => r.map(F.cellText)));
  } finally { await s.close(); }
});

test('opening reads the footer only', async () => {
  const s = await openParquet({ path: path.join(FX, 'taxi-trips.parquet') });
  try {
    assert.ok(s.bytesRead < 600 * 1024, `opened with ${s.bytesRead} bytes of ${s.size}`);
    assert.equal(s.totalRows, 50000);
    assert.equal(s.info().rowGroups, 5);
  } finally { await s.close(); }
});

const HOSTILE = {
  'hostile-truncated.parquet': ['TRUNCATED', /end of this Parquet file is missing/],
  'hostile-not-parquet.parquet': ['NOT_PARQUET', /not a Parquet file.*text file/],
  'hostile-zero-bytes.parquet': ['EMPTY', /empty/],
  'hostile-footer-past-eof.parquet': ['BAD_FOOTER', /damaged or cut off/],
  'hostile-garbage-footer.parquet': ['BAD_METADATA', /can't be read/],
  'apache/encrypt_columns_and_footer.parquet.encrypted': ['ENCRYPTED', /encrypted/],
};
for (const [f, [code, re]] of Object.entries(HOSTILE)) {
  test(`hostile file gives a clear message: ${f}`, async () => {
    const t0 = Date.now();
    await assert.rejects(openParquet({ path: path.join(FX, f) }), e => e.code === code && re.test(e.message));
    assert.ok(Date.now() - t0 < 3000, 'no hang');
  });
}

test('hostile: a column chunk that claims 4 GB is refused before any read', async () => {
  const s = await openParquet({ path: path.join(FX, 'hostile-chunk-4gb.parquet') });
  try {
    const info = s.info();
    assert.match(info.problems[0], /4\.0 GB.*damaged or cut off/);
    const before = s.bytesRead;
    await assert.rejects(s.rows(0, 10), /damaged or cut off/);
    assert.equal(s.bytesRead, before, 'nothing read for the bad row group');
  } finally { await s.close(); }
});

test('hostile: encrypted columns with a plain footer, malformed dictionary', async () => {
  const enc = await openParquet({ path: path.join(FX, 'apache/encrypt_columns_plaintext_footer.parquet.encrypted') });
  await assert.rejects(enc.rows(0, 5), /encrypted/);
  assert.ok(enc.columns.length > 0, 'schema still shown');
  await enc.close();
  const bad = await openParquet({ path: path.join(FX, 'apache/nation.dict-malformed.parquet') });
  await assert.rejects(bad.rows(0, 5), /can't be read/);
  await bad.close();
});

test('bytes source (virtual file systems)', async () => {
  const bytes = fs.readFileSync(path.join(FX, 'nested.parquet'));
  const s = await openParquet({ bytes: new Uint8Array(bytes) });
  assert.equal(s.totalRows, 4);
  await s.close();
});
