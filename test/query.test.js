'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../src/core/query');

const t = (text, kind, v) => Q.parseFilter(text, kind).test(v);

test('filters: contains, exact, not, compare, range, null, regex', () => {
  assert.equal(Q.parseFilter('', 'string'), null);
  assert.ok(t('mid', 'string', 'Midtown'));
  assert.ok(!t('=mid', 'string', 'Midtown'));
  assert.ok(t('=midtown', 'string', 'Midtown'));
  assert.ok(t('!air', 'string', 'Midtown'));
  assert.ok(!t('!air', 'string', 'JFK Airport'));
  assert.ok(t('!=a', 'string', 'b'));
  assert.ok(t('>10', 'int', 11n));
  assert.ok(!t('>10', 'int', 10));
  assert.ok(t('>=10', 'decimal', '10.00'));
  assert.ok(t('<0', 'float', -0.5));
  assert.ok(t('5..9', 'int', 9));
  assert.ok(!t('5..9', 'int', 10));
  assert.ok(t('2026-03-01..2026-03-02', 'timestamp', '2026-03-01 23:00:00'));
  assert.ok(t('>2026-03', 'timestamp', '2026-03-01 06:00:00'));
  assert.ok(t('null', 'int', null));
  assert.ok(!t('null', 'int', 0));
  assert.ok(t('!null', 'int', 0));
  assert.ok(t('/^a.c$/', 'string', 'abc'));
  assert.ok(Q.parseFilter('/(/', 'string').error);
  assert.ok(t('lisbon', 'struct', { city: 'Lisbon' }));
  assert.ok(t('=9007199254740993', 'int', 9007199254740993n));
});

test('sort: numbers, BigInt, text, nulls last both ways, stable', () => {
  const rows = [10, 11, 12, 13, 14];
  const keys = [3n, null, -1, 3, 2.5];
  assert.deepEqual(Array.from(Q.sortRows(rows, keys, false)), [12, 14, 10, 13, 11]);
  assert.deepEqual(Array.from(Q.sortRows(rows, keys, true)), [10, 13, 14, 12, 11]);
  assert.deepEqual(Array.from(Q.sortRows([1, 2, 3], ['b', 'a', null], false)), [2, 1, 3]);
});

test('search box matches any column, case-insensitive', () => {
  const s = Q.searchTest('LIS');
  assert.ok(s('lisbon'));
  assert.ok(!s(null));
  assert.equal(Q.searchTest('  '), null);
});
