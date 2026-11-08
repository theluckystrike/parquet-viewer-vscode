'use strict';
// The worker side of one open file: answers the webview's requests (rows, query, cell, copy, export).
// No VS Code here, so tests drive it directly.

const fs = require('fs');
const { openParquet } = require('./parquet');
const F = require('./format');
const Q = require('./query');

const DEFAULTS = { maxSortRows: 2000000, maxMatches: 5000000, maxCopyRows: 100000, maxFooterMB: 256, maxChunkMB: 2048 };
const MAX_DETAIL = 5 * 1024 * 1024;

class Growable {
  constructor() { this.buf = new Float64Array(65536); this.length = 0; }
  push(v) {
    if (this.length === this.buf.length) { const b = new Float64Array(this.buf.length * 2); b.set(this.buf); this.buf = b; }
    this.buf[this.length++] = v;
  }
  done() { return this.buf.slice(0, this.length); }
}

function createSession({ post }) {
  let src = null;
  let opts = { ...DEFAULTS };
  let view = null; // Float64Array of physical row numbers, or null for all rows in file order
  let viewNote = '';
  let gen = 0; // query generation; a new query or cancel stops the running one
  let rowsBusy = false;
  let rowsPending = null;

  const count = () => (view ? view.length : src ? src.totalRows : 0);
  const physical = i => (view ? view[i] : i);

  async function open(msg) {
    opts = { ...DEFAULTS, ...(msg.options || {}) };
    const t0 = Date.now();
    try {
      src = await openParquet(msg.bytes ? { bytes: msg.bytes } : { path: msg.path }, { maxFooterMB: opts.maxFooterMB, maxChunkMB: opts.maxChunkMB });
    } catch (e) {
      post({ type: 'openError', code: e.code || 'ERROR', message: e.message || String(e) });
      return;
    }
    post({ type: 'opened', columns: src.columns, totalRows: src.totalRows, info: src.info(), ms: Date.now() - t0, bytesRead: src.bytesRead });
  }

  async function rows(msg) {
    if (rowsBusy) { rowsPending = msg; return; }
    rowsBusy = true;
    try {
      let m = msg;
      while (m) {
        rowsPending = null;
        await rowsNow(m);
        m = rowsPending;
      }
    } finally {
      rowsBusy = false;
    }
  }

  async function rowsNow(msg) {
    const n = count();
    const start = Math.max(0, Math.min(n, Math.floor(msg.start)));
    const end = Math.max(start, Math.min(n, Math.floor(msg.end), start + 1000));
    const nums = [];
    for (let i = start; i < end; i++) nums.push(physical(i));
    try {
      const raw = await src.rowsAt(nums);
      post({ type: 'rows', req: msg.req, viewId: msg.viewId, start, rowNums: nums, cells: raw.map(r => r.map(F.cellText)), bytesRead: src.bytesRead });
    } catch (e) {
      post({ type: 'rows', req: msg.req, viewId: msg.viewId, start, rowNums: nums, cells: null, error: e.message || String(e) });
    }
  }

  async function query(msg) {
    const my = ++gen;
    const filters = [];
    for (const f of msg.filters || []) {
      const ci = src.columns.findIndex(c => c.name === f.col);
      if (ci < 0) continue;
      const p = Q.parseFilter(f.text, src.columns[ci].kind);
      if (!p) continue;
      if (p.error) { post({ type: 'queryError', req: msg.req, message: `${f.col}: ${p.error}` }); return; }
      filters.push({ ci, test: p.test });
    }
    const search = Q.searchTest(msg.search);
    let sortCi = -1;
    if (msg.sort && msg.sort.col !== undefined && msg.sort.col !== null) {
      sortCi = src.columns.findIndex(c => c.name === msg.sort.col);
      if (sortCi >= 0 && src.columns[sortCi].nested) {
        post({ type: 'queryError', req: msg.req, message: `"${msg.sort.col}" is a nested column (${src.columns[sortCi].kind}). Sort works on plain columns.` });
        return;
      }
    }
    if (!filters.length && !search && sortCi < 0) {
      view = null; viewNote = '';
      post({ type: 'view', req: msg.req, count: count(), note: '', filtered: false });
      return;
    }
    if (sortCi >= 0 && !filters.length && !search && src.totalRows > opts.maxSortRows) {
      post({ type: 'queryError', req: msg.req, message: `Sorting reads the whole column into memory. This file has ${src.totalRows.toLocaleString('en-US')} rows, over the limit of ${opts.maxSortRows.toLocaleString('en-US')} (setting parquetViewer.maxSortRows). Filter the rows first, or raise the limit.` });
      return;
    }
    const need = new Set();
    filters.forEach(f => need.add(f.ci));
    if (sortCi >= 0) need.add(sortCi);
    if (search) src.columns.forEach((c, i) => need.add(i));
    const cis = [...need].sort((a, b) => a - b);
    const names = cis.map(i => src.columns[i].name);
    const pos = new Map(cis.map((ci, k) => [ci, k]));
    const matches = new Growable();
    const keys = sortCi >= 0 ? [] : null;
    const kind = sortCi >= 0 ? src.columns[sortCi].kind : '';
    let capped = false, tooMany = false;
    let lastProgress = 0;
    const t0 = Date.now();
    try {
      const ok = await src.scan(names, (start, data, n) => {
        for (let i = 0; i < n; i++) {
          let pass = true;
          for (const f of filters) { if (!f.test(data[pos.get(f.ci)][i])) { pass = false; break; } }
          if (pass && search) {
            pass = false;
            for (let k = 0; k < data.length; k++) { if (search(data[k][i])) { pass = true; break; } }
          }
          if (!pass) continue;
          matches.push(start + i);
          if (keys) keys.push(Q.sortKey(data[pos.get(sortCi)][i], kind));
          if (keys && matches.length > opts.maxSortRows) { tooMany = true; return; }
          if (!keys && matches.length >= opts.maxMatches) { capped = true; return; }
        }
      }, () => my !== gen || tooMany || capped, p => {
        const now = Date.now();
        if (now - lastProgress > 200) { lastProgress = now; post({ type: 'progress', req: msg.req, fraction: p, matches: matches.length }); }
      });
      if (my !== gen) return; // replaced or cancelled
      void ok;
    } catch (e) {
      if (my === gen) post({ type: 'queryError', req: msg.req, message: e.message || String(e) });
      return;
    }
    if (tooMany) {
      post({ type: 'queryError', req: msg.req, message: `More than ${opts.maxSortRows.toLocaleString('en-US')} rows match, too many to sort in memory (setting parquetViewer.maxSortRows). Add a filter to narrow the rows, then sort.` });
      return;
    }
    let rowsOut = matches.done();
    if (keys) rowsOut = Q.sortRows(rowsOut, keys, !!msg.sort.desc);
    view = rowsOut;
    viewNote = capped ? `Showing the first ${opts.maxMatches.toLocaleString('en-US')} matches (setting parquetViewer.maxMatches).` : '';
    post({ type: 'view', req: msg.req, count: view.length, note: viewNote, filtered: !!(filters.length || search), ms: Date.now() - t0 });
  }

  /** Raw rows of the current view, [r0, r1), optionally some columns only. */
  async function viewRows(r0, r1, cols) {
    const nums = [];
    for (let i = r0; i < r1; i++) nums.push(physical(i));
    const raw = await src.rowsAt(nums);
    return cols ? raw.map(r => cols.map(c => r[c])) : raw;
  }

  async function cell(msg) {
    const i = Math.floor(msg.row), c = Math.floor(msg.col);
    if (!(i >= 0 && i < count()) || !(c >= 0 && c < src.columns.length)) return;
    try {
      const [r] = await viewRows(i, i + 1);
      const v = r[c];
      const col = src.columns[c];
      let text = F.valueText(v);
      let json = null;
      if (col.nested || (v !== null && typeof v === 'object' && !(v instanceof Uint8Array))) json = JSON.stringify(F.jsonSafe(v), null, 2);
      let cut = false;
      if (text && text.length > MAX_DETAIL) { text = text.slice(0, MAX_DETAIL); cut = true; }
      if (json && json.length > MAX_DETAIL) { json = json.slice(0, MAX_DETAIL); cut = true; }
      post({ type: 'cell', req: msg.req, row: i, col: c, rowNum: physical(i), name: col.name, kind: col.kind, detail: col.detail, text, json, tree: col.nested ? F.jsonSafe(v) : null, cut });
    } catch (e) {
      post({ type: 'cell', req: msg.req, row: i, col: c, error: e.message || String(e) });
    }
  }

  async function copy(msg) {
    const n = count();
    const r0 = Math.max(0, Math.floor(msg.r0)), r1 = Math.min(n, Math.floor(msg.r1));
    let end = r1;
    let cut = false;
    if (end - r0 > opts.maxCopyRows) { end = r0 + opts.maxCopyRows; cut = true; }
    const cols = (Array.isArray(msg.cols) && msg.cols.length ? msg.cols : src.columns.map((_, i) => i)).filter(c => c >= 0 && c < src.columns.length);
    try {
      const rowsRaw = end > r0 ? await viewRows(r0, end, cols) : [];
      const header = cols.map(c => src.columns[c].name);
      let text;
      switch (msg.format) {
        case 'json': text = F.toJson(header, rowsRaw); break;
        case 'markdown': text = F.toMarkdown(header, rowsRaw); break;
        case 'tsv': text = F.toTsv(rowsRaw); break;
        default: text = F.toCsv(header, rowsRaw);
      }
      post({ type: 'copyText', req: msg.req, format: msg.format || 'csv', text, rows: end - r0, cut });
    } catch (e) {
      post({ type: 'copyText', req: msg.req, error: e.message || String(e) });
    }
  }

  async function exportFile(msg) {
    const my = gen;
    const n = count();
    const header = src.columns.map(c => c.name);
    const jsonl = msg.format === 'jsonl';
    let out;
    try {
      out = fs.createWriteStream(msg.path, { encoding: 'utf8' });
      const write = s => new Promise((res, rej) => { if (out.write(s)) res(); else out.once('drain', res); out.once('error', rej); });
      if (!jsonl) await write(header.map(h => F.csvField(h, ',')).join(',') + '\n');
      const step = 5000;
      let last = 0;
      for (let r = 0; r < n; r += step) {
        if (my !== gen) throw new Error('Export cancelled.');
        const rowsRaw = await viewRows(r, Math.min(n, r + step));
        let chunk = '';
        for (const row of rowsRaw) {
          if (jsonl) { const o = {}; header.forEach((h, i) => { o[h] = F.jsonSafe(row[i]); }); chunk += JSON.stringify(o) + '\n'; }
          else chunk += row.map(v => F.csvField(F.valueText(v), ',')).join(',') + '\n';
        }
        await write(chunk);
        const now = Date.now();
        if (now - last > 250) { last = now; post({ type: 'exportProgress', req: msg.req, fraction: Math.min(1, (r + step) / Math.max(1, n)) }); }
      }
      await new Promise((res, rej) => out.end(err => (err ? rej(err) : res())));
      post({ type: 'exported', req: msg.req, path: msg.path, rows: n });
    } catch (e) {
      if (out) out.destroy();
      post({ type: 'exported', req: msg.req, error: e.message || String(e) });
    }
  }

  async function handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'open') return open(msg);
    if (!src) return;
    switch (msg.type) {
      case 'rows': return rows(msg);
      case 'query': return query(msg);
      case 'cancel': gen++; post({ type: 'cancelled', req: msg.req }); return;
      case 'cell': return cell(msg);
      case 'copy': return copy(msg);
      case 'export': return exportFile(msg);
      case 'schemaJson': post({ type: 'schemaJson', req: msg.req, text: JSON.stringify(src.schemaJson(), null, 2) }); return;
      case 'close': gen++; await src.close(); src = null; return;
      default:
    }
  }

  return { handle, get source() { return src; }, get viewCount() { return count(); } };
}

module.exports = { createSession, DEFAULTS };
