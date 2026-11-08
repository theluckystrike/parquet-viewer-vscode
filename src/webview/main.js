// Webview: the grid, the schema tab and the detail pane. Talks to the extension host by messages only.
/* global acquireVsCodeApi */
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const ROW_H = 22;
  const HEAD_H = 26;
  const FILTER_H = 26;
  const TOP_H = HEAD_H + FILTER_H;
  const MAX_SPACER = 15000000; // px; taller views are scaled
  const NUM_W_MIN = 56;

  const S = {
    columns: [], total: 0, count: 0, info: null, viewId: 0, req: 0,
    cache: new Map(), // view row -> {cells, rowNum}
    pendingReq: 0, wanted: null, errorRows: '',
    widths: [], sort: null, filters: new Map(), search: '',
    sel: null, // {r0, c0, r1, c1} anchor r0/c0, focus r1/c1
    rowSel: false,
    detailOpen: false, detailFor: null,
    tab: 'data', queryReq: 0, querying: false, rendered: false, note: '', filtered: false,
    bytesRead: 0, openMs: 0,
  };

  const h = (tag, attrs, ...kids) => {
    const e = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'style') e.style.cssText = v; // CSSOM, allowed by the CSP (a style attribute is not)
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return e;
  };
  const fmt = n => Number(n).toLocaleString('en-US');
  const fmtBytes = n => {
    n = Number(n) || 0;
    if (n < 1024) return `${n} B`;
    const u = ['KB', 'MB', 'GB', 'TB']; let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
  };

  // ---------- layout ----------
  const title = app.dataset.title || '';
  const searchBox = h('input', { class: 'search', type: 'search', placeholder: 'Search all columns', 'aria-label': 'Search all columns', spellcheck: 'false' });
  const tabData = h('button', { class: 'tab active', 'data-tab': 'data', title: 'Rows' }, 'Data');
  const tabSchema = h('button', { class: 'tab', 'data-tab': 'schema', title: 'Schema, row groups and file metadata' }, 'Schema');
  const copyBtn = h('button', { class: 'btn', title: 'Copy the selected cells, or the rows on screen' }, 'Copy ▾');
  const exportBtn = h('button', { class: 'btn', title: 'Save all rows of this view (filters and sort applied) to a file' }, 'Export ▾');
  const detailBtn = h('button', { class: 'btn', title: 'Show the full value of the selected cell (Enter)' }, 'Details');
  const clearBtn = h('button', { class: 'btn hidden', title: 'Remove the sort, the filters and the search' }, 'Clear');
  const summary = h('span', { class: 'summary' });
  const toolbar = h('div', { class: 'toolbar' },
    h('span', { class: 'fname', title }, title), summary,
    h('span', { class: 'spacer-flex' }),
    tabData, tabSchema, searchBox, clearBtn, detailBtn, copyBtn, exportBtn);
  const banner = h('div', { class: 'banner hidden', role: 'status' });
  const scroller = h('div', { class: 'scroller', tabindex: '0', 'aria-label': 'Rows' });
  const spacer = h('div', { class: 'spacer' });
  scroller.append(spacer);
  const layer = h('div', { class: 'layer' });
  const hdr = h('div', { class: 'hdr' });
  const body = h('div', { class: 'body' });
  layer.append(body, hdr);
  const gridwrap = h('div', { class: 'gridwrap' }, scroller, layer);
  const detail = h('aside', { class: 'detail hidden', 'aria-label': 'Cell details' });
  const dataView = h('div', { class: 'dataview' }, gridwrap, detail);
  const schemaView = h('div', { class: 'schemaview hidden' });
  const status = h('div', { class: 'status' }, h('span', { class: 'status-text' }));
  const menu = h('div', { class: 'menu hidden', role: 'menu' });
  const toast = h('div', { class: 'toast hidden', role: 'status' });
  const loading = h('div', { class: 'loading' }, h('div', { class: 'spinner' }), h('div', { text: `Reading the footer of ${title}…` }));
  app.append(toolbar, banner, dataView, schemaView, status, menu, toast, loading);
  const tpl = document.getElementById('support-tpl');
  if (tpl && tpl.content.firstElementChild) status.append(tpl.content.firstElementChild);

  // ---------- messages ----------
  const send = m => vscode.postMessage(m);
  window.addEventListener('message', e => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'opened': return onOpened(m);
      case 'openError': return onOpenError(m);
      case 'rows': return onRows(m);
      case 'view': return onView(m);
      case 'queryError': S.querying = false; setBanner(m.message, 'warn'); updateSummary(); return;
      case 'progress': if (m.req === S.queryReq) showProgress(m); return;
      case 'cancelled': return;
      case 'cell': return onCell(m);
      case 'toast': return showToast(m.text, m.error);
      case 'exportStarted': setBanner('Exporting…', 'info'); return;
      case 'exportProgress': setBanner(`Exporting… ${Math.round(m.fraction * 100)}%`, 'info'); return;
      case 'exported': clearBanner(); if (m.error) showToast(m.error, true); return;
      default:
    }
  });

  function onOpenError(m) {
    loading.remove();
    dataView.classList.add('hidden');
    schemaView.classList.add('hidden');
    toolbar.querySelectorAll('button, input').forEach(b => { b.disabled = true; });
    const box = h('div', { class: 'error-view', role: 'alert' },
      h('div', { class: 'error-title' }, "Can't open this file"),
      h('div', { class: 'error-msg' }, m.message),
      h('div', { class: 'error-code' }, `${title} · ${m.code}`),
      h('button', { class: 'btn', onclick: () => location.reload() }, 'Try again'));
    app.insertBefore(box, status);
    status.querySelector('.status-text').textContent = 'Not opened';
  }

  function onOpened(m) {
    loading.remove();
    S.columns = m.columns;
    S.total = m.totalRows;
    S.count = m.totalRows;
    S.info = m.info;
    S.bytesRead = m.bytesRead;
    S.openMs = m.ms;
    S.widths = S.columns.map(c => Math.max(70, Math.min(260, 24 + c.name.length * 7.2, 24 + Math.max(c.name.length, 8) * 7.2)));
    buildHeader();
    renderSchema();
    const notes = [];
    if (m.info.rowCountNote) notes.push(m.info.rowCountNote);
    if (m.info.problems && m.info.problems.length) notes.push(...m.info.problems.slice(0, 2));
    if (notes.length) setBanner(notes.join(' '), 'warn');
    if (!S.columns.length) setBanner('This file has no columns.', 'info');
    else if (!S.total) setBanner('This file has the schema below and 0 rows.', 'info');
    updateSummary();
    layout();
    scroller.focus();
  }

  // ---------- header ----------
  const KIND_LABEL = { int: 'int', float: 'float', decimal: 'decimal', string: 'text', bool: 'bool', date: 'date', time: 'time', timestamp: 'timestamp', binary: 'bytes', json: 'json', list: 'list', map: 'map', struct: 'struct' };
  let headCells = [], filterInputs = [];
  function buildHeader() {
    hdr.textContent = '';
    headCells = []; filterInputs = [];
    const corner = h('div', { class: 'corner', title: 'Row number in the file' }, '#');
    hdr.append(corner);
    S.columns.forEach((c, i) => {
      const sortMark = h('span', { class: 'sortmark' });
      const grip = h('span', { class: 'grip', title: 'Drag to resize' });
      const cell = h('div', { class: 'hcell', role: 'columnheader', title: `${c.name}\n${c.detail}\nClick to sort. Drag the right edge to resize.` },
        h('span', { class: 'hname' }, c.name), h('span', { class: `kind k-${c.kind}` }, KIND_LABEL[c.kind] || c.kind), sortMark, grip);
      cell.addEventListener('click', e => { if (e.target === grip) return; cycleSort(i); });
      grip.addEventListener('mousedown', e => startResize(e, i));
      grip.addEventListener('dblclick', e => { e.stopPropagation(); autoWidth(i); });
      const input = h('input', { class: 'filter', type: 'text', spellcheck: 'false', placeholder: c.nested ? 'contains' : filterHint(c.kind), 'aria-label': `Filter ${c.name}`, title: 'text = contains · =x exact · !x not · >5 <5 >=5 <=5 · 5..9 · null · !null · /regex/' });
      input.addEventListener('input', () => { const v = input.value; if (v.trim()) S.filters.set(c.name, v); else S.filters.delete(c.name); scheduleQuery(); });
      input.addEventListener('keydown', e => { if (e.key === 'Enter') { runQuery(); } if (e.key === 'Escape') { input.value = ''; S.filters.delete(c.name); runQuery(); scroller.focus(); } e.stopPropagation(); });
      headCells.push({ cell, sortMark });
      filterInputs.push(input);
      hdr.append(cell, input);
    });
  }
  function filterHint(kind) {
    if (kind === 'int' || kind === 'float' || kind === 'decimal') return '>0, 5..9';
    if (kind === 'date' || kind === 'timestamp') return '>2024-01';
    return 'contains';
  }
  function cycleSort(i) {
    const name = S.columns[i].name;
    if (S.columns[i].nested) { showToast(`"${name}" is a nested column. Sort works on plain columns.`, true); return; }
    if (!S.sort || S.sort.col !== name) S.sort = { col: name, desc: false };
    else if (!S.sort.desc) S.sort = { col: name, desc: true };
    else S.sort = null;
    runQuery();
  }
  let resizing = null;
  function startResize(e, i) {
    e.preventDefault(); e.stopPropagation();
    resizing = { i, x: e.clientX, w: S.widths[i] };
    document.body.classList.add('resizing');
  }
  window.addEventListener('mousemove', e => {
    if (!resizing) return;
    S.widths[resizing.i] = Math.max(40, Math.min(2000, resizing.w + e.clientX - resizing.x));
    layout();
  });
  window.addEventListener('mouseup', () => { if (resizing) { resizing = null; document.body.classList.remove('resizing'); } });
  function autoWidth(i) {
    let w = 24 + S.columns[i].name.length * 7.2;
    for (const r of S.cache.values()) { if (r.cells) { const s = r.cells[i]; if (s) w = Math.max(w, 16 + Math.min(s.length, 80) * 7); } }
    S.widths[i] = Math.max(50, Math.min(700, w));
    layout();
  }

  // ---------- geometry ----------
  let numW = NUM_W_MIN;
  let xs = [];
  function geometry() {
    numW = Math.max(NUM_W_MIN, 18 + String(Math.max(1, S.total)).length * 7.5);
    xs = [];
    let x = numW;
    for (const w of S.widths) { xs.push(x); x += w; }
    return x; // total width
  }
  function spacerHeight() { return Math.min(MAX_SPACER, S.count * ROW_H) + TOP_H + 4; }
  function topRowExact() {
    const viewH = scroller.clientHeight - TOP_H;
    const visible = Math.max(1, viewH / ROW_H);
    const full = S.count * ROW_H;
    if (full <= MAX_SPACER) return scroller.scrollTop / ROW_H;
    const maxScroll = Math.max(1, spacer.offsetHeight - scroller.clientHeight);
    return (scroller.scrollTop / maxScroll) * Math.max(0, S.count - visible + 1);
  }
  function scrollToRow(r) {
    const viewH = scroller.clientHeight - TOP_H;
    const visible = Math.max(1, Math.floor(viewH / ROW_H));
    const top = topRowExact();
    let want = top;
    if (r < top) want = r; else if (r >= top + visible - 1) want = r - visible + 2;
    if (want === top) return;
    const full = S.count * ROW_H;
    if (full <= MAX_SPACER) scroller.scrollTop = want * ROW_H;
    else {
      const maxScroll = Math.max(1, spacer.offsetHeight - scroller.clientHeight);
      scroller.scrollTop = (want / Math.max(1, S.count - visible + 1)) * maxScroll;
    }
  }
  function scrollToCol(c) {
    if (c < 0 || c >= xs.length) return;
    const left = xs[c] - numW, right = xs[c] + S.widths[c];
    const viewW = scroller.clientWidth;
    if (left < scroller.scrollLeft) scroller.scrollLeft = left;
    else if (right > scroller.scrollLeft + viewW) scroller.scrollLeft = right - viewW;
  }

  // ---------- painting ----------
  let raf = 0;
  function layout() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(); }); }
  scroller.addEventListener('scroll', layout, { passive: true });
  window.addEventListener('resize', layout);
  hdr.addEventListener('wheel', e => { scroller.scrollLeft += e.deltaX; scroller.scrollTop += e.deltaY; }, { passive: true });

  const rowPool = [];
  function paint() {
    if (!S.columns.length) return;
    const totalW = geometry();
    spacer.style.width = `${totalW}px`;
    spacer.style.height = `${spacerHeight()}px`;
    const sbw = scroller.offsetWidth - scroller.clientWidth;
    const sbh = scroller.offsetHeight - scroller.clientHeight;
    layer.style.right = `${sbw}px`;
    layer.style.bottom = `${sbh}px`;
    const sl = scroller.scrollLeft;
    const viewW = scroller.clientWidth;
    // visible columns
    let c0 = 0;
    while (c0 < xs.length - 1 && xs[c0] + S.widths[c0] - sl < numW) c0++;
    let c1 = c0;
    while (c1 < xs.length && xs[c1] - sl < viewW) c1++;
    // header
    hdr.firstChild.style.width = `${numW}px`;
    S.columns.forEach((c, i) => {
      const vis = i >= c0 && i < c1;
      const hc = headCells[i].cell, fi = filterInputs[i];
      if (!vis) { if (hc.style.display !== 'none') { hc.style.display = 'none'; if (document.activeElement !== fi) fi.style.display = 'none'; } return; }
      hc.style.display = ''; fi.style.display = '';
      const x = xs[i] - sl;
      hc.style.transform = `translateX(${x}px)`; hc.style.width = `${S.widths[i]}px`;
      fi.style.transform = `translate(${x}px, ${HEAD_H}px)`; fi.style.width = `${S.widths[i]}px`;
      const sorted = S.sort && S.sort.col === c.name;
      headCells[i].sortMark.textContent = sorted ? (S.sort.desc ? '▼' : '▲') : '';
      hc.classList.toggle('sorted', !!sorted);
      fi.classList.toggle('active', S.filters.has(c.name));
    });
    // rows
    const top = topRowExact();
    const first = Math.floor(top);
    const offY = -(top - first) * ROW_H;
    const viewH = scroller.clientHeight - TOP_H;
    const n = Math.min(S.count - first, Math.ceil(viewH / ROW_H) + 1);
    while (rowPool.length < n) { const r = h('div', { class: 'row' }); rowPool.push(r); body.append(r); }
    const missing = [];
    for (let k = 0; k < rowPool.length; k++) {
      const el = rowPool[k];
      if (k >= n) { el.style.display = 'none'; continue; }
      el.style.display = '';
      const vr = first + k;
      el.style.transform = `translateY(${TOP_H + offY + k * ROW_H}px)`;
      const rec = S.cache.get(vr);
      if (!rec) missing.push(vr);
      paintRow(el, vr, rec, c0, c1, sl);
    }
    if (missing.length) want(missing[0], missing[missing.length - 1] + 1);
    updateStatus(first, n);
    if (!S.rendered && n > 0 && missing.length === 0) { S.rendered = true; send({ type: 'rendered' }); }
    if (!S.rendered && S.count === 0 && S.info) { S.rendered = true; send({ type: 'rendered' }); }
  }

  function paintRow(el, vr, rec, c0, c1, sl) {
    // reuse child nodes: [num, ...cells]
    const need = 1 + (c1 - c0);
    while (el.childNodes.length < need) el.append(h('div', { class: 'cell' }));
    while (el.childNodes.length > need) el.lastChild.remove();
    const num = el.firstChild;
    num.className = 'cell num';
    num.style.width = `${numW}px`;
    num.style.transform = '';
    num.textContent = rec ? fmt(rec.rowNum + 1) : fmt(vr + 1);
    const sel = S.sel;
    const rowIn = sel && vr >= Math.min(sel.r0, sel.r1) && vr <= Math.max(sel.r0, sel.r1);
    num.classList.toggle('selrow', !!rowIn);
    for (let c = c0; c < c1; c++) {
      const d = el.childNodes[1 + c - c0];
      const col = S.columns[c];
      let cls = `cell k-${col.kind}`;
      let text = '';
      if (!rec) { cls += ' wait'; text = '…'; }
      else if (rec.error) { cls += ' err'; text = '!'; }
      else {
        const v = rec.cells[c];
        if (v === null || v === undefined) { cls += ' null'; text = 'null'; }
        else text = v;
      }
      if (rowIn && c >= Math.min(sel.c0, sel.c1) && c <= Math.max(sel.c0, sel.c1)) cls += ' sel';
      if (sel && vr === sel.r1 && c === sel.c1) cls += ' focus';
      if (d.className !== cls) d.className = cls;
      if (d.textContent !== text) d.textContent = text.length > 400 ? text.slice(0, 400) : text;
      d.style.transform = `translateX(${xs[c] - sl}px)`;
      d.style.width = `${S.widths[c]}px`;
      d.dataset.c = c;
    }
  }

  // ---------- row fetching ----------
  let wantTimer = 0;
  function want(a, b) {
    S.wanted = [a, b];
    if (wantTimer) return;
    wantTimer = setTimeout(() => {
      wantTimer = 0;
      const [x, y] = S.wanted;
      const start = Math.max(0, x - 60);
      const end = Math.min(S.count, Math.max(y, x + 1) + 120, start + 1000);
      S.pendingReq = ++S.req;
      send({ type: 'rows', req: S.pendingReq, viewId: S.viewId, start, end });
    }, 12);
  }
  function onRows(m) {
    if (m.viewId !== S.viewId) return;
    if (typeof m.bytesRead === 'number') S.bytesRead = m.bytesRead;
    if (m.error) {
      for (let i = 0; i < m.rowNums.length; i++) S.cache.set(m.start + i, { rowNum: m.rowNums[i], error: m.error });
      setBanner(m.error, 'warn');
    } else {
      for (let i = 0; i < m.cells.length; i++) S.cache.set(m.start + i, { rowNum: m.rowNums[i], cells: m.cells[i] });
    }
    if (S.cache.size > 20000) {
      // drop rows far from the screen
      const top = topRowExact();
      for (const k of S.cache.keys()) if (Math.abs(k - top) > 5000) S.cache.delete(k);
    }
    layout();
  }

  // ---------- query ----------
  let qTimer = 0;
  function scheduleQuery() { clearTimeout(qTimer); qTimer = setTimeout(runQuery, 450); }
  function runQuery() {
    clearTimeout(qTimer);
    S.queryReq = ++S.req;
    S.querying = true;
    const filters = [...S.filters].map(([col, text]) => ({ col, text }));
    send({ type: 'query', req: S.queryReq, filters, sort: S.sort, search: S.search });
    clearBtn.classList.toggle('hidden', !(filters.length || S.sort || S.search));
    if (filters.length || S.search || S.sort) showProgress({ fraction: 0, matches: 0 });
    layout();
  }
  function showProgress(m) {
    if (!S.querying) return;
    const what = S.sort && !S.filters.size && !S.search ? 'Sorting' : 'Filtering';
    banner.className = 'banner info';
    banner.textContent = '';
    banner.append(h('span', null, `${what}… ${Math.round(m.fraction * 100)}% of rows read · ${fmt(m.matches)} match`),
      h('button', { class: 'btn small', onclick: () => { send({ type: 'cancel', req: S.queryReq }); S.querying = false; clearBanner(); } }, 'Cancel'));
  }
  function onView(m) {
    if (m.req !== S.queryReq) return;
    S.querying = false;
    S.viewId++;
    S.cache.clear();
    S.count = m.count;
    S.filtered = m.filtered;
    S.note = m.note || '';
    S.sel = null;
    clearBanner();
    if (S.note) setBanner(S.note, 'info');
    else if (m.filtered && m.count === 0) setBanner('No rows match the filters.', 'info');
    scroller.scrollTop = 0;
    updateSummary();
    layout();
  }
  clearBtn.addEventListener('click', () => {
    S.filters.clear(); S.sort = null; S.search = ''; searchBox.value = '';
    filterInputs.forEach(i => { i.value = ''; });
    runQuery();
  });
  searchBox.addEventListener('input', () => { S.search = searchBox.value; scheduleQuery(); });
  searchBox.addEventListener('keydown', e => { if (e.key === 'Enter') { S.search = searchBox.value; runQuery(); } e.stopPropagation(); });

  // ---------- selection ----------
  function cellAt(e) {
    const r = scroller.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (y < TOP_H || x > scroller.clientWidth || y > scroller.clientHeight) return null;
    const top = topRowExact();
    const vr = Math.floor(top + (y - TOP_H) / ROW_H);
    if (vr < 0 || vr >= S.count) return null;
    if (x < numW) return { r: vr, c: -1 };
    const ax = x + scroller.scrollLeft;
    for (let c = 0; c < xs.length; c++) if (ax >= xs[c] && ax < xs[c] + S.widths[c]) return { r: vr, c };
    return null;
  }
  let dragging = false;
  scroller.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    const p = cellAt(e);
    if (!p) return;
    scroller.focus();
    if (p.c === -1) {
      // row number: select whole rows
      const last = S.columns.length - 1;
      if (e.shiftKey && S.sel) S.sel = { r0: S.sel.r0, c0: 0, r1: p.r, c1: last };
      else S.sel = { r0: p.r, c0: 0, r1: p.r, c1: last };
    } else if (e.shiftKey && S.sel) S.sel = { ...S.sel, r1: p.r, c1: p.c };
    else S.sel = { r0: p.r, c0: p.c, r1: p.r, c1: p.c };
    dragging = true;
    layout();
    selectionChanged();
  });
  scroller.addEventListener('mousemove', e => {
    if (!dragging || !S.sel) return;
    const p = cellAt(e);
    if (!p || p.c === -1) return;
    if (p.r !== S.sel.r1 || p.c !== S.sel.c1) { S.sel = { ...S.sel, r1: p.r, c1: p.c }; layout(); }
  });
  window.addEventListener('mouseup', () => { if (dragging) { dragging = false; selectionChanged(); } });
  scroller.addEventListener('dblclick', e => { const p = cellAt(e); if (p && p.c >= 0) openDetail(); });
  function selectionChanged() {
    if (S.detailOpen && S.sel) requestCell(S.sel.r1, S.sel.c1);
    else if (S.sel && S.sel.r0 === S.sel.r1 && S.sel.c0 === S.sel.c1 && S.columns[S.sel.c1] && S.columns[S.sel.c1].nested) openDetail();
    updateSummary();
  }
  scroller.addEventListener('keydown', e => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); copySel('tsv'); return; }
    if (mod && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); S.sel = { r0: 0, c0: 0, r1: S.count - 1, c1: S.columns.length - 1 }; layout(); updateSummary(); return; }
    if (mod && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); searchBox.focus(); searchBox.select(); return; }
    if (e.key === 'Enter') { if (S.sel) openDetail(); e.preventDefault(); return; }
    if (e.key === 'Escape') { if (S.detailOpen) closeDetail(); else { S.sel = null; layout(); updateSummary(); } return; }
    const page = Math.max(1, Math.floor((scroller.clientHeight - TOP_H) / ROW_H) - 1);
    const moves = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], PageDown: [page, 0], PageUp: [-page, 0] };
    let mv = moves[e.key];
    if (e.key === 'Home') mv = mod ? [-Infinity, 0] : [0, -Infinity];
    if (e.key === 'End') mv = mod ? [Infinity, 0] : [0, Infinity];
    if (!mv || !S.count || !S.columns.length) return;
    e.preventDefault();
    const cur = S.sel || { r0: Math.floor(topRowExact()), c0: 0, r1: Math.floor(topRowExact()), c1: 0 };
    const r = Math.max(0, Math.min(S.count - 1, cur.r1 + mv[0]));
    const c = Math.max(0, Math.min(S.columns.length - 1, cur.c1 + mv[1]));
    S.sel = e.shiftKey ? { ...cur, r1: r, c1: c } : { r0: r, c0: c, r1: r, c1: c };
    scrollToRow(r); scrollToCol(c);
    layout();
    selectionChanged();
  });

  function selRange() {
    if (!S.sel) {
      const top = Math.floor(topRowExact());
      const n = Math.max(1, Math.floor((scroller.clientHeight - TOP_H) / ROW_H));
      return { r0: top, r1: Math.min(S.count, top + n), cols: S.columns.map((_, i) => i), what: 'rows on screen' };
    }
    const r0 = Math.min(S.sel.r0, S.sel.r1), r1 = Math.max(S.sel.r0, S.sel.r1) + 1;
    const a = Math.min(S.sel.c0, S.sel.c1), b = Math.max(S.sel.c0, S.sel.c1);
    const cols = []; for (let c = a; c <= b; c++) cols.push(c);
    return { r0, r1, cols, what: 'selection' };
  }
  function copySel(format) {
    if (!S.count) return;
    const s = selRange();
    send({ type: 'copy', req: ++S.req, r0: s.r0, r1: s.r1, cols: s.cols, format });
  }

  // ---------- menus ----------
  function openMenu(anchor, items) {
    menu.textContent = '';
    for (const it of items) menu.append(h('button', { class: 'menu-item', role: 'menuitem', onclick: () => { closeMenu(); it.run(); } }, it.label));
    const b = anchor.getBoundingClientRect();
    menu.style.top = `${b.bottom + 2}px`;
    menu.style.left = `${Math.max(4, Math.min(window.innerWidth - 230, b.left))}px`;
    menu.classList.remove('hidden');
    menu.firstChild && menu.firstChild.focus();
  }
  function closeMenu() { menu.classList.add('hidden'); }
  document.addEventListener('mousedown', e => { if (!menu.contains(e.target) && e.target !== copyBtn && e.target !== exportBtn) closeMenu(); });
  menu.addEventListener('keydown', e => { if (e.key === 'Escape') { closeMenu(); scroller.focus(); } });
  copyBtn.addEventListener('click', () => openMenu(copyBtn, [
    { label: 'Copy as CSV', run: () => copySel('csv') },
    { label: 'Copy as JSON', run: () => copySel('json') },
    { label: 'Copy as Markdown table', run: () => copySel('markdown') },
    { label: 'Copy as tab-separated (Ctrl+C)', run: () => copySel('tsv') },
    { label: 'Copy schema as JSON', run: () => send({ type: 'schemaJson', req: ++S.req }) },
  ]));
  exportBtn.addEventListener('click', () => openMenu(exportBtn, [
    { label: `Export ${S.filtered || S.sort ? 'these' : 'all'} ${fmt(S.count)} rows to CSV…`, run: () => send({ type: 'exportCsv' }) },
    { label: `Export ${fmt(S.count)} rows to JSON Lines…`, run: () => send({ type: 'exportJsonl' }) },
  ]));

  // ---------- detail pane ----------
  let cellReq = 0;
  function requestCell(r, c) { cellReq = ++S.req; send({ type: 'cell', req: cellReq, row: r, col: c }); }
  function openDetail() {
    if (!S.sel) { showToast('Select a cell first.'); return; }
    S.detailOpen = true;
    detail.classList.remove('hidden');
    detailBtn.classList.add('on');
    requestCell(S.sel.r1, S.sel.c1);
    layout();
  }
  function closeDetail() { S.detailOpen = false; detail.classList.add('hidden'); detailBtn.classList.remove('on'); layout(); scroller.focus(); }
  detailBtn.addEventListener('click', () => (S.detailOpen ? closeDetail() : openDetail()));
  function onCell(m) {
    if (m.req !== cellReq) return;
    detail.textContent = '';
    const close = h('button', { class: 'btn small close', title: 'Close (Escape)', onclick: closeDetail }, '×');
    if (m.error) { detail.append(close, h('div', { class: 'err' }, m.error)); return; }
    const head = h('div', { class: 'd-head' }, h('div', { class: 'd-name' }, m.name), h('div', { class: 'd-type' }, `${m.detail} · row ${fmt(m.rowNum + 1)}`));
    const buttons = h('div', { class: 'd-buttons' },
      h('button', { class: 'btn small', onclick: () => { send({ type: 'copyText', text: m.text === null ? '' : m.text }); showToast('Copied the value.'); } }, 'Copy value'));
    if (m.json) buttons.append(h('button', { class: 'btn small', onclick: () => { send({ type: 'copyText', text: m.json }); showToast('Copied as JSON.'); } }, 'Copy JSON'));
    detail.append(close, head, buttons);
    if (m.tree !== null && m.tree !== undefined && typeof m.tree === 'object') detail.append(h('div', { class: 'tree' }, treeNode(m.tree, 0)));
    else detail.append(h('pre', { class: m.text === null ? 'd-val null' : 'd-val' }, m.text === null ? 'null' : m.text));
    if (m.cut) detail.append(h('div', { class: 'note' }, 'The value is long; the first 5 MB are shown.'));
  }
  function treeNode(v, depth) {
    if (v === null || typeof v !== 'object') return h('span', { class: v === null ? 'tv null' : `tv t-${typeof v}` }, v === null ? 'null' : typeof v === 'string' ? JSON.stringify(v) : String(v));
    const isArr = Array.isArray(v);
    const keys = Object.keys(v);
    const det = h('details', depth < 2 ? { open: true } : null);
    det.append(h('summary', null, isArr ? `[${keys.length} item${keys.length === 1 ? '' : 's'}]` : `{${keys.length} field${keys.length === 1 ? '' : 's'}}`));
    const list = h('div', { class: 'tchildren' });
    const shown = keys.slice(0, 2000);
    for (const k of shown) list.append(h('div', { class: 'trow' }, h('span', { class: 'tk' }, isArr ? `${k}: ` : `${k}: `), treeNode(v[k], depth + 1)));
    if (keys.length > shown.length) list.append(h('div', { class: 'note' }, `${fmt(keys.length - shown.length)} more`));
    det.append(list);
    return det;
  }

  // ---------- schema tab ----------
  function renderSchema() {
    const i = S.info;
    schemaView.textContent = '';
    const ratio = i.compressedBytes ? (i.uncompressedBytes / i.compressedBytes) : 0;
    const card = (k, v) => h('div', { class: 'card' }, h('div', { class: 'card-k' }, k), h('div', { class: 'card-v' }, v));
    schemaView.append(h('div', { class: 'cards' },
      card('Rows', fmt(i.rows)), card('Columns', fmt(S.columns.length)), card('Row groups', fmt(i.rowGroups)),
      card('File size', fmtBytes(i.fileSize)), card('Uncompressed', `${fmtBytes(i.uncompressedBytes)}${ratio ? ` (${ratio.toFixed(1)}x)` : ''}`),
      card('Compression', i.codecs.join(', ') || 'none'), card('Format version', String(i.version ?? '')),
      card('Opened in', `${S.openMs} ms, read ${fmtBytes(S.bytesRead)}`)));
    if (i.createdBy) schemaView.append(h('div', { class: 'created' }, 'Created by ', h('code', null, i.createdBy)));
    schemaView.append(h('div', { class: 'section-head' }, h('h2', null, 'Schema'), h('button', { class: 'btn small', onclick: () => send({ type: 'schemaJson', req: ++S.req }) }, 'Copy schema as JSON')));
    const t = h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', null, 'Column'), h('th', null, 'Physical type'), h('th', null, 'Logical type'), h('th', null, 'Repetition'))));
    const tb = h('tbody');
    for (const f of i.fields) tb.append(h('tr', null, h('td', { style: `padding-left:${8 + f.depth * 18}px` }, f.name), h('td', null, f.physical + (f.typeLength ? `(${f.typeLength})` : '')), h('td', null, f.logical), h('td', null, f.repetition)));
    t.append(tb); schemaView.append(t);
    if (i.keyValue.length) {
      schemaView.append(h('h2', null, 'Key-value metadata'));
      const kv = h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', null, 'Key'), h('th', null, 'Value'))));
      const kb = h('tbody');
      for (const p of i.keyValue) kb.append(h('tr', null, h('td', null, p.key), h('td', null, h('pre', { class: 'kv' }, p.value))));
      kv.append(kb); schemaView.append(kv);
    }
    schemaView.append(h('h2', null, `Row groups (${fmt(i.rowGroups)})`));
    const rg = h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'First row'), h('th', null, 'Rows'), h('th', null, 'Compressed'), h('th', null, 'Uncompressed'), h('th', null, 'Page index'), h('th', null, 'Note'))));
    const rb = h('tbody');
    for (const g of i.groups) rb.append(h('tr', null, h('td', null, String(g.index + 1)), h('td', null, fmt(g.start + 1)), h('td', null, fmt(g.rows)), h('td', null, fmtBytes(g.comp)), h('td', null, fmtBytes(g.uncomp)), h('td', null, g.offsetIndex ? 'yes' : 'no'), h('td', { class: g.problem ? 'err' : '' }, g.problem || '')));
    rg.append(rb); schemaView.append(rg);
    if (i.rowGroups > i.groups.length) schemaView.append(h('div', { class: 'note' }, `The first ${fmt(i.groups.length)} row groups are listed.`));
    schemaView.append(h('div', { class: 'note' }, `Encodings: ${i.encodings.join(', ') || 'none'}`));
  }
  [tabData, tabSchema].forEach(b => b.addEventListener('click', () => {
    S.tab = b.dataset.tab;
    tabData.classList.toggle('active', S.tab === 'data'); tabSchema.classList.toggle('active', S.tab === 'schema');
    dataView.classList.toggle('hidden', S.tab !== 'data'); schemaView.classList.toggle('hidden', S.tab !== 'schema');
    if (S.tab === 'data') { layout(); scroller.focus(); }
  }));

  // ---------- status, banner, toast ----------
  function updateSummary() {
    const parts = [];
    if (S.filtered) parts.push(`${fmt(S.count)} of ${fmt(S.total)} rows`);
    else parts.push(`${fmt(S.total)} rows`);
    parts.push(`${fmt(S.columns.length)} columns`);
    if (S.info) parts.push(fmtBytes(S.info.fileSize));
    summary.textContent = parts.join(' · ');
  }
  function updateStatus(first, n) {
    const t = status.querySelector('.status-text');
    const parts = [];
    if (S.count) parts.push(`Rows ${fmt(first + 1)}–${fmt(Math.min(S.count, first + n))} of ${fmt(S.count)}${S.filtered ? ` (filtered from ${fmt(S.total)})` : ''}`);
    else parts.push('0 rows');
    if (S.sort) parts.push(`sorted by ${S.sort.col} ${S.sort.desc ? '▼' : '▲'}`);
    if (S.sel) {
      const r = Math.abs(S.sel.r1 - S.sel.r0) + 1, c = Math.abs(S.sel.c1 - S.sel.c0) + 1;
      parts.push(`selected ${fmt(r)} × ${fmt(c)}`);
    }
    if (S.info) parts.push(`read ${fmtBytes(S.bytesRead)} of ${fmtBytes(S.info.fileSize)}`);
    t.textContent = parts.join(' · ');
  }
  function setBanner(text, kind) { banner.className = `banner ${kind || 'info'}`; banner.textContent = text; }
  function clearBanner() { banner.className = 'banner hidden'; banner.textContent = ''; }
  let toastTimer = 0;
  function showToast(text, error) {
    toast.textContent = text;
    toast.className = `toast${error ? ' error' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.className = 'toast hidden'; }, error ? 6000 : 2500);
  }

  // Read-only state for the release check in a real VS Code (scripts/e2e-vscode.mjs). Not used by the UI.
  window.parquetProbe = () => {
    const rows = [...body.querySelectorAll('.row')].filter(r => r.style.display !== 'none').slice(0, 8)
      .map(r => [...r.childNodes].map(c => c.textContent));
    return {
      opened: !!S.info, error: (document.querySelector('.error-msg') || {}).textContent || '', total: S.total, count: S.count,
      columns: S.columns.map(c => c.name), kinds: S.columns.map(c => c.kind), rendered: S.rendered, querying: S.querying,
      banner: banner.classList.contains('hidden') ? '' : banner.textContent, status: status.querySelector('.status-text').textContent,
      summary: summary.textContent, rows, sort: S.sort, detail: S.detailOpen ? detail.innerText : '', tab: S.tab,
      cached: S.cache.size, missing: [...body.querySelectorAll('.cell.wait')].length, toast: toast.classList.contains('hidden') ? '' : toast.textContent,
    };
  };

  send({ type: 'ready' });
})();
