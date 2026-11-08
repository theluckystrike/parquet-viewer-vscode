'use strict';
// Column filters, the search box and sort keys. Pure functions.
// Filter syntax (one box per column): text (contains), =exact, !text (does not contain), !=exact,
// >5, >=5, <5, <=5, 5..9 (between, inclusive), null, !null, /regex/.

const { valueText } = require('./format');

const NUMERIC = new Set(['int', 'float', 'decimal']);

function num(s) {
  const t = String(s).trim().replace(/_/g, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return null;
  return Number(t);
}

function lowerText(v) {
  const s = valueText(v);
  return s === null ? null : s.toLowerCase();
}

/** Compares a value with the user's operand: numbers as numbers in numeric columns, everything else as text. */
function cmp(v, operand, kind) {
  if (NUMERIC.has(kind)) {
    const x = num(operand);
    if (x !== null) {
      const a = typeof v === 'bigint' ? Number(v) : typeof v === 'string' ? Number(v) : Number(v);
      if (Number.isNaN(a)) return NaN;
      return a < x ? -1 : a > x ? 1 : 0;
    }
  }
  const s = valueText(v);
  if (s === null) return NaN;
  const o = String(operand);
  return s < o ? -1 : s > o ? 1 : 0;
}

/**
 * Parses one column filter. Returns null for an empty box, {error} for a bad one, or {test(value) -> boolean}.
 */
function parseFilter(text, kind) {
  const t = String(text || '').trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  if (lower === 'null' || lower === 'empty') return { test: v => v === null || v === undefined || v === '' };
  if (lower === '!null' || lower === '!empty') return { test: v => !(v === null || v === undefined || v === '') };
  const re = /^\/(.+)\/([imsu]*)$/.exec(t);
  if (re) {
    let rx;
    try { rx = new RegExp(re[1], re[2]); } catch (e) { return { error: `Bad regular expression: ${e.message}` }; }
    return { test: v => { const s = valueText(v); return s !== null && rx.test(s); } };
  }
  const range = /^(.+?)\.\.(.+)$/.exec(t);
  if (range && !/^[<>=!]/.test(t)) {
    const a = range[1].trim(), b = range[2].trim();
    return { test: v => { if (v === null || v === undefined) return false; const x = cmp(v, a, kind), y = cmp(v, b, kind); return x >= 0 && y <= 0; } };
  }
  const op = /^(>=|<=|!=|>|<|=|!)(.*)$/.exec(t);
  if (op) {
    const operand = op[2].trim();
    const o = op[1];
    if (o === '!') {
      if (!operand) return null;
      const needle = operand.toLowerCase();
      return { test: v => { const s = lowerText(v); return s === null || !s.includes(needle); } };
    }
    if (o === '=' || o === '!=') {
      const eq = v => {
        if (v === null || v === undefined) return false;
        if (NUMERIC.has(kind) && num(operand) !== null) return cmp(v, operand, kind) === 0;
        const s = lowerText(v);
        return s === operand.toLowerCase();
      };
      return o === '=' ? { test: eq } : { test: v => !eq(v) };
    }
    if (!operand) return null;
    const want = { '>': c => c > 0, '>=': c => c >= 0, '<': c => c < 0, '<=': c => c <= 0 }[o];
    return { test: v => { if (v === null || v === undefined) return false; const c = cmp(v, operand, kind); return !Number.isNaN(c) && want(c); } };
  }
  return { test: v => { const s = lowerText(v); return s !== null && s.includes(lower); } };
}

/** Search box: case-insensitive text match in any column. */
function searchTest(text) {
  const needle = String(text || '').trim().toLowerCase();
  if (!needle) return null;
  return v => { const s = lowerText(v); return s !== null && s.includes(needle); };
}

/** Sort key of a value: numbers for numeric columns, text otherwise, null stays null. */
function sortKey(v, kind) {
  if (v === null || v === undefined) return null;
  if (kind === 'decimal') { const n = Number(v); return Number.isNaN(n) ? null : n; }
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return typeof v === 'boolean' ? (v ? 1 : 0) : v;
  if (typeof v === 'string') return v;
  return valueText(v);
}

function compareKeys(a, b) {
  if (a === null) return b === null ? 0 : 1; // nulls last in both directions (handled by the caller)
  if (b === null) return -1;
  const ta = typeof a, tb = typeof b;
  if ((ta === 'number' || ta === 'bigint') && (tb === 'number' || tb === 'bigint')) {
    if (Number.isNaN(a)) return Number.isNaN(b) ? 0 : 1;
    if (Number.isNaN(b)) return -1;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const sa = String(a), sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** Sorts row numbers by their keys. Stable; nulls go last whatever the direction. */
function sortRows(rows, keys, desc) {
  const idx = new Uint32Array(rows.length);
  for (let i = 0; i < idx.length; i++) idx[i] = i;
  const arr = Array.from(idx);
  arr.sort((i, j) => {
    const a = keys[i], b = keys[j];
    if (a === null || b === null) {
      if (a === null && b === null) return i - j;
      return a === null ? 1 : -1;
    }
    const c = compareKeys(a, b);
    return c !== 0 ? (desc ? -c : c) : i - j;
  });
  const out = new Float64Array(arr.length);
  for (let k = 0; k < arr.length; k++) out[k] = rows[arr[k]];
  return out;
}

module.exports = { parseFilter, searchTest, sortKey, compareKeys, sortRows, NUMERIC };
