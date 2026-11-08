'use strict';
// Value formatting for the grid, the detail pane and copy/export. Pure functions, no VS Code, no Node APIs.

const MAX_CELL = 2000; // characters of one cell sent to the grid; the detail pane asks for the full value

function pad(n, w) { return String(n).padStart(w, '0'); }

/** Days since 1970-01-01 -> 'YYYY-MM-DD'. Out-of-range values come back as the number. */
function dateFromDays(days) {
  const n = Number(days);
  const ms = n * 86400000;
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return String(days);
  return isoDate(new Date(ms));
}

function isoDate(d) {
  const y = d.getUTCFullYear();
  const ys = y < 0 ? '-' + pad(-y, 4) : y > 9999 ? '+' + y : pad(y, 4);
  return `${ys}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}`;
}

/**
 * Integer count of units since the epoch -> 'YYYY-MM-DD HH:MM:SS[.fraction]', keeping every digit of the unit
 * (micro and nano seconds are not rounded to milliseconds as a JS Date would).
 */
function timestampText(value, perSecond, digits) {
  let v;
  if (value instanceof Uint8Array) v = bigIntFromBytesLE(value);
  else { try { v = typeof value === 'bigint' ? value : BigInt(Math.trunc(Number(value))); } catch { return String(value); } }
  if (v === null) return null;
  const per = BigInt(perSecond);
  let sec = v / per;
  let frac = v % per;
  if (frac < 0n) { frac += per; sec -= 1n; }
  const ms = Number(sec) * 1000;
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return String(value);
  const d = new Date(ms);
  let s = `${isoDate(d)} ${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}`;
  if (frac !== 0n && digits > 0) {
    let f = frac.toString().padStart(digits, '0');
    // trim to 3, 6 or 9 digits, like pandas and pyarrow print it
    while (f.length > 3 && f.endsWith('000')) f = f.slice(0, -3);
    s += '.' + f;
  }
  return s;
}

/** Parsers for hyparquet: timestamps and dates become exact text instead of rounded JS Dates. */
function makeParsers(defaults) {
  const safe = (fn, fallback) => v => { try { return fn(v); } catch { return fallback(v); } };
  const hex = v => bytesText(v);
  return {
    timestampFromMilliseconds: v => timestampText(v, 1000, 3),
    timestampFromMicroseconds: v => timestampText(v, 1000000, 6),
    timestampFromNanoseconds: v => timestampText(v, 1000000000, 9),
    dateFromDays,
    stringFromBytes,
    jsonFromBytes: v => {
      const text = new TextDecoder().decode(v);
      try { return JSON.parse(text); } catch { return text; }
    },
    ...(defaults && defaults.geometryFromBytes ? { geometryFromBytes: safe(defaults.geometryFromBytes, hex) } : {}),
    ...(defaults && defaults.geographyFromBytes ? { geographyFromBytes: safe(defaults.geographyFromBytes, hex) } : {}),
  };
}

/** Signed big-endian two's complement bytes -> BigInt. */
function bigIntFromBytes(bytes) {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  const bits = BigInt(bytes.length * 8);
  if (bytes.length && (bytes[0] & 0x80)) v -= 1n << bits;
  return v;
}

/** Signed little-endian bytes -> BigInt (FIXED_LEN_BYTE_ARRAY(12) timestamps). */
function bigIntFromBytesLE(bytes) {
  if (!bytes.length) return null;
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  if (bytes[bytes.length - 1] & 0x80) v -= 1n << BigInt(bytes.length * 8);
  return v;
}

const UTF8 = new TextDecoder();
/** Bytes -> text. Bytes that are not text (invalid UTF-8 or control characters) show as hex. */
function stringFromBytes(bytes) {
  if (bytes === null || bytes === undefined) return bytes;
  const s = UTF8.decode(bytes);
  // eslint-disable-next-line no-control-regex
  if (s.includes('\uFFFD') || /[\x00-\x08\x0e-\x1f]/.test(s)) return bytesText(bytes);
  return s;
}

/** Exact decimal text from an unscaled integer (number, bigint or bytes) and a scale. */
function decimalText(raw, scale) {
  if (raw === null || raw === undefined) return null;
  let v;
  if (raw instanceof Uint8Array) v = bigIntFromBytes(raw);
  else if (typeof raw === 'bigint') v = raw;
  else if (typeof raw === 'number') { if (!Number.isInteger(raw)) return String(raw); v = BigInt(raw); }
  else return String(raw);
  const neg = v < 0n;
  let digits = (neg ? -v : v).toString();
  const s = Math.max(0, Number(scale) || 0);
  if (s > 0) {
    digits = digits.padStart(s + 1, '0');
    digits = digits.slice(0, -s) + '.' + digits.slice(-s);
  }
  return (neg ? '-' : '') + digits;
}

/** TIME value -> 'HH:MM:SS[.fraction]'. unit: MILLIS (int32), MICROS or NANOS (int64). */
function timeText(raw, unit) {
  if (raw === null || raw === undefined) return null;
  const per = unit === 'NANOS' ? 1000000000n : unit === 'MICROS' ? 1000000n : 1000n;
  const digits = unit === 'NANOS' ? 9 : unit === 'MICROS' ? 6 : 3;
  let v;
  try { v = BigInt(raw); } catch { return String(raw); }
  const neg = v < 0n;
  if (neg) v = -v;
  const sec = v / per;
  const frac = v % per;
  const h = sec / 3600n, m = (sec / 60n) % 60n, s = sec % 60n;
  let out = `${neg ? '-' : ''}${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}`;
  if (frac) {
    let f = frac.toString().padStart(digits, '0');
    while (f.length > 3 && f.endsWith('000')) f = f.slice(0, -3);
    out += '.' + f;
  }
  return out;
}

/** INTERVAL (12 bytes: months, days, millis, little-endian uint32) -> text. */
function intervalText(raw) {
  if (!(raw instanceof Uint8Array) || raw.length !== 12) return bytesText(raw);
  const dv = new DataView(raw.buffer, raw.byteOffset, 12);
  const months = dv.getUint32(0, true), days = dv.getUint32(4, true), millis = dv.getUint32(8, true);
  return `${months} months ${days} days ${millis} ms`;
}

function bytesText(b) {
  if (!(b instanceof Uint8Array)) return String(b);
  const n = Math.min(b.length, 64);
  let s = '0x';
  for (let i = 0; i < n; i++) s += b[i].toString(16).padStart(2, '0');
  if (b.length > n) s += `... (${b.length} bytes)`;
  return s;
}

function base64(b) {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64');
}

/** A value made safe for JSON.stringify: BigInt, bytes, Map, typed arrays, Dates. */
function jsonSafe(v, depth = 0) {
  if (v === null || v === undefined) return null;
  if (depth > 64) return '...';
  const t = typeof v;
  if (t === 'bigint') return (v <= 9007199254740991n && v >= -9007199254740991n) ? Number(v) : v.toString();
  if (t === 'number') return Number.isFinite(v) ? v : String(v);
  if (t === 'string' || t === 'boolean') return v;
  if (v instanceof Date) return isNaN(v.getTime()) ? String(v) : v.toISOString();
  if (v instanceof Uint8Array) return bytesText(v);
  if (ArrayBuffer.isView(v)) return Array.from(v, x => jsonSafe(x, depth + 1));
  if (Array.isArray(v)) return v.map(x => jsonSafe(x, depth + 1));
  if (v instanceof Map) { const o = {}; for (const [k, x] of v) o[String(k)] = jsonSafe(x, depth + 1); return o; }
  if (t === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = jsonSafe(v[k], depth + 1); return o; }
  return String(v);
}

/** Full text of one value (no truncation). null stays null. */
function valueText(v) {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === 'string') return v;
  if (t === 'number') return Number.isNaN(v) ? 'NaN' : String(v);
  if (t === 'bigint' || t === 'boolean') return String(v);
  if (v instanceof Date) return isNaN(v.getTime()) ? 'Invalid date' : v.toISOString();
  if (v instanceof Uint8Array) return bytesText(v);
  return JSON.stringify(jsonSafe(v));
}

/** Text for one grid cell, cut at MAX_CELL characters. */
function cellText(v) {
  const s = valueText(v);
  if (s === null) return null;
  return s.length > MAX_CELL ? s.slice(0, MAX_CELL) + '…' : s;
}

// ---------- copy formats ----------

function csvField(s, delim) {
  if (s === null || s === undefined) return '';
  return /[",\r\n\t;|]/.test(s) || s.includes(delim) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(header, rows, delim = ',') {
  const lines = [header.map(h => csvField(h, delim)).join(delim)];
  for (const r of rows) lines.push(r.map(v => csvField(valueText(v), delim)).join(delim));
  return lines.join('\n') + '\n';
}

function toTsv(rows) {
  return rows.map(r => r.map(v => { const s = valueText(v); return s === null ? '' : s.replace(/[\t\r\n]+/g, ' '); }).join('\t')).join('\n');
}

function toJson(header, rows) {
  return JSON.stringify(rows.map(r => { const o = {}; header.forEach((h, i) => { o[h] = jsonSafe(r[i]); }); return o; }), null, 2);
}

function mdCell(s) { return s === null ? '' : s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>'); }

function toMarkdown(header, rows) {
  const out = ['| ' + header.map(mdCell).join(' | ') + ' |', '|' + header.map(() => ' --- ').join('|') + '|'];
  for (const r of rows) out.push('| ' + r.map(v => mdCell(valueText(v))).join(' | ') + ' |');
  return out.join('\n') + '\n';
}

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}

module.exports = {
  MAX_CELL, dateFromDays, stringFromBytes, bigIntFromBytesLE, timestampText, makeParsers, decimalText, bigIntFromBytes, timeText, intervalText, bytesText, base64,
  jsonSafe, valueText, cellText, toCsv, toTsv, toJson, toMarkdown, csvField, fmtBytes,
};
