'use strict';
// Checks every message from the webview before the host or the worker acts on it.

const int = v => Number.isFinite(v) && Math.floor(v) === v && v >= 0 && v <= 2 ** 40;
const str = (v, max) => typeof v === 'string' && v.length <= max;

const FORMATS = new Set(['csv', 'tsv', 'json', 'markdown']);

/** Returns {ok:true, msg} with a clean copy, or {ok:false, why}. */
function validateWebviewMessage(m) {
  if (!m || typeof m !== 'object' || typeof m.type !== 'string') return { ok: false, why: 'not a message' };
  switch (m.type) {
    case 'ready': case 'rendered': case 'schemaJson': case 'cancel': case 'exportCsv': case 'exportJsonl': case 'settings': case 'reload':
      return { ok: true, msg: { type: m.type, req: int(m.req) ? m.req : 0 } };
    case 'rows':
      if (!int(m.start) || !int(m.end) || m.end < m.start) return { ok: false, why: 'bad rows range' };
      return { ok: true, msg: { type: 'rows', req: int(m.req) ? m.req : 0, viewId: int(m.viewId) ? m.viewId : 0, start: m.start, end: Math.min(m.end, m.start + 1000) } };
    case 'query': {
      const filters = Array.isArray(m.filters) ? m.filters.slice(0, 500).filter(f => f && str(f.col, 10000) && str(f.text, 2000)).map(f => ({ col: f.col, text: f.text })) : [];
      const sort = m.sort && str(m.sort.col, 10000) ? { col: m.sort.col, desc: !!m.sort.desc } : null;
      const search = str(m.search, 2000) ? m.search : '';
      return { ok: true, msg: { type: 'query', req: int(m.req) ? m.req : 0, filters, sort, search } };
    }
    case 'cell':
      if (!int(m.row) || !int(m.col)) return { ok: false, why: 'bad cell' };
      return { ok: true, msg: { type: 'cell', req: int(m.req) ? m.req : 0, row: m.row, col: m.col } };
    case 'copy': {
      if (!int(m.r0) || !int(m.r1) || m.r1 < m.r0) return { ok: false, why: 'bad copy range' };
      const cols = Array.isArray(m.cols) ? m.cols.filter(int).slice(0, 100000) : [];
      const format = FORMATS.has(m.format) ? m.format : 'csv';
      return { ok: true, msg: { type: 'copy', req: int(m.req) ? m.req : 0, r0: m.r0, r1: m.r1, cols, format } };
    }
    case 'copyText':
      if (!str(m.text, 50 * 1024 * 1024)) return { ok: false, why: 'bad text' };
      return { ok: true, msg: { type: 'copyText', text: m.text } };
    default:
      return { ok: false, why: 'unknown type' };
  }
}

module.exports = { validateWebviewMessage };
