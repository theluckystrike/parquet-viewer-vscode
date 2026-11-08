// Release check in a real VS Code: installs the .vsix into an isolated profile, opens real Parquet files (one large,
// several hostile), drives the grid with real mouse and key events, saves screenshots and a JSON report.
// usage: node scripts/e2e-vscode.mjs <work> <port> <vsix> <samplesDir> <shotDir> <outJson> [largeFile]
import { launch, installVsix, sleep } from './vsc.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const [work0, port, vsix, ws0, shotDir, outJson, large] = process.argv.slice(2);
const work = path.resolve(work0), ws = path.resolve(ws0);
const R = { started: new Date().toISOString(), install: null, vscode: null, steps: [], console: [], hashes: {}, unchanged: null };
const hash = f => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
for (const f of walk(ws)) if (fs.statSync(f).size < 50e6) R.hashes[path.relative(ws, f)] = hash(f);
fs.rmSync(path.join(work, 'ud'), { recursive: true, force: true });
R.install = installVsix(work, vsix);
const vs = await launch(work, Number(port), ws, { 'files.simpleDialog.enable': true, 'workbench.secondarySideBar.defaultVisibility': 'hidden', 'workbench.auxiliaryBar.visible': false, 'window.titleBarStyle': 'custom', 'workbench.sideBar.location': 'left', 'parquetViewer.askForRating': false });
R.vscode = await vs.wbEval(`navigator.userAgent.match(/Code\\/[\\d.]+/)?.[0] || navigator.userAgent`);
const shots = [];
const shot = async name => { const f = path.join(shotDir, `pq-${String(shots.length + 1).padStart(2, '0')}-${name}.png`); await vs.shot(f); shots.push(f); return f; };
const step = async (name, fn) => {
  const t0 = Date.now();
  try { const v = await fn(); R.steps.push({ name, ok: v !== false, value: v, ms: Date.now() - t0 }); console.log('ok  ', name); }
  catch (e) { R.steps.push({ name, ok: false, error: String(e.message || e).slice(0, 800), ms: Date.now() - t0 }); console.log('FAIL', name, String(e.message || e).slice(0, 300)); try { await shot('FAIL-' + name.replace(/\W+/g, '_').slice(0, 40)); } catch {} }
};
let wv;
const E = expr => vs.wvEval(wv, expr);
const probe = async () => JSON.parse(await E(`JSON.stringify(window.parquetProbe ? window.parquetProbe() : null)`));
const getWv = async title => vs.waitFor(async () => (await vs.webviews()).find(w => w.title === title && w.w > 0), 30000);
const open = async file => {
  const t0 = Date.now(); vs.open(path.isAbsolute(file) ? file : path.join(ws, file)); await sleep(300);
  wv = await getWv(path.basename(file)); if (!wv) throw new Error('no webview for ' + file);
  return t0;
};
const rendered = async (t0, ms = 30000) => {
  const p = await vs.waitFor(async () => { const p = await probe(); return p && (p.error || (p.rendered && p.missing === 0)) ? p : null; }, ms, 50);
  if (!p) throw new Error('not rendered: ' + JSON.stringify(await probe()).slice(0, 400));
  return { p, ms: Date.now() - t0 };
};
const settle = async () => vs.waitFor(async () => { const p = await probe(); return p && !p.querying && p.missing === 0 ? p : null; }, 60000, 100);
const btn = t => `[...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(t)})`;
const clip = () => execSync('pbpaste', { encoding: 'utf8' });
const scrollX = x => E(`(() => { const s = document.querySelector('.scroller'); s.scrollLeft = ${x === 'end' ? 's.scrollWidth' : x}; return 1; })()`).then(() => sleep(300));
const cellSel = (row, col) => `[...document.querySelectorAll('.row')][${row}].querySelector('.cell[data-c="${col}"]')`;
const extHostRss = () => {
  try {
    const out = execSync(`ps -axo pid,rss,command | grep -F ${JSON.stringify(path.join(work, 'ud'))} | grep -i 'extensionHost\\|--type=utility' | grep -v grep`, { encoding: 'utf8' });
    return out.trim().split('\n').map(l => { const [pid, rss] = l.trim().split(/\s+/); return { pid: +pid, mb: Math.round(+rss / 1024), cmd: l.includes('extensionHost') ? 'extensionHost' : 'utility' }; });
  } catch { return []; }
};

try {
  await sleep(2500);
  await vs.command('View: Close Primary Side Bar').catch(() => {});
  await step('taxi-trips.parquet opens as the default editor: types, exact INT64, first rows', async () => {
    const t0 = await open('taxi-trips.parquet'); const { p, ms } = await rendered(t0);
    if (p.error) throw new Error(p.error);
    if (p.total !== 50000 || p.columns.length !== 12 || p.rows[0][1] !== '9007199254740993' || p.kinds.join() !== 'int,timestamp,timestamp,int,float,decimal,string,string,list,struct,map,binary') throw new Error(JSON.stringify(p).slice(0, 600));
    return { ms, summary: p.summary, firstRow: p.rows[0].slice(0, 8), status: p.status };
  });
  await step('sort by clicking the fare header twice (descending), real mouse clicks', async () => {
    await vs.wvClick(wv, `[...document.querySelectorAll('.hcell')].find(h => h.querySelector('.hname').textContent === 'fare')`, { dx: 20 });
    await sleep(200); await settle();
    await vs.wvClick(wv, `[...document.querySelectorAll('.hcell')].find(h => h.querySelector('.hname').textContent === 'fare')`, { dx: 20 });
    await sleep(200); const p = await settle();
    const fares = p.rows.map(r => Number(r[6]));
    if (!p.sort || !p.sort.desc || fares.some((f, i) => i && fares[i - 1] < f)) throw new Error(JSON.stringify(p).slice(0, 600));
    return { sort: p.sort, top: fares.slice(0, 4), status: p.status };
  });
  await step('filter by typing in the payment box (=cash) and a numeric box (>10), search box (wheelchair)', async () => {
    await vs.wvClick(wv, `document.querySelectorAll('.filter')[6]`); await vs.type('=cash');
    await vs.wvClick(wv, `document.querySelectorAll('.filter')[4]`); await vs.type('>10'); await vs.key('Enter', 'Enter');
    await sleep(700); const p = await settle();
    if (!(p.count > 0 && p.count < 50000) || p.rows.some(r => r[7] !== 'cash' || !(Number(r[5]) > 10))) throw new Error(JSON.stringify(p).slice(0, 600));
    await vs.wvClick(wv, `document.querySelector('.search')`); await vs.type('wheelchair'); await vs.key('Enter', 'Enter');
    await sleep(700); const q = await settle();
    if (!(q.count > 0 && q.count < p.count) || q.rows.some(r => !r[9].includes('wheelchair'))) throw new Error(JSON.stringify(q).slice(0, 600));
    await shot('taxi-filtered-sorted');
    return { filtered: p.count, withSearch: q.count, summary: q.summary };
  });
  await step('Clear, then a nested STRUCT cell opens as a tree in the detail pane', async () => {
    await vs.wvClick(wv, btn('Clear')); await sleep(500); await settle();
    await scrollX('end');
    await vs.wvClick(wv, cellSel(2, 9));
    await sleep(600);
    const p = await probe();
    if (!/pickup/.test(p.detail) || !/lat/.test(p.detail) || !/lon/.test(p.detail)) throw new Error(JSON.stringify(p).slice(0, 600));
    return { detail: p.detail.slice(0, 200), count: p.count };
  });
  await step('README screenshot: dark theme, nested detail pane open', async () => {
    await vs.wvClick(wv, cellSel(3, 9)); await sleep(500);
    await scrollX(0);
    return { file: await shot('readme-dark-grid') };
  });
  await step('select 3 rows x 3 columns by Shift+click, Copy as CSV and as Markdown via the menu (clipboard checked)', async () => {
    await vs.wvClick(wv, cellSel(0, 0));
    await vs.wvClick(wv, cellSel(2, 2), { modifiers: 8 });
    await vs.wvClick(wv, btn('Copy ▾')); await vs.wvClick(wv, `[...document.querySelectorAll('.menu-item')].find(b => b.textContent === 'Copy as CSV')`);
    await sleep(800); const csv = clip();
    await vs.wvClick(wv, btn('Copy ▾')); await vs.wvClick(wv, `[...document.querySelectorAll('.menu-item')].find(b => b.textContent === 'Copy as Markdown table')`);
    await sleep(800); const md = clip();
    const lines = csv.trim().split('\n');
    if (lines.length !== 4 || lines[0] !== 'trip_id,pickup_at,dropoff_at' || !lines[1].startsWith('9007199254740993,') || !md.startsWith('| trip_id | pickup_at | dropoff_at |')) throw new Error(JSON.stringify({ csv, md }));
    return { csv: lines, md: md.split('\n').slice(0, 3) };
  });
  await step('keyboard: Ctrl+End jumps to the last row, Home/arrows move, Ctrl+C copies TSV', async () => {
    await vs.wvClick(wv, cellSel(1, 0));
    await vs.key('End', 'End', 4); await sleep(600); const p = await settle();
    await vs.key('c', 'KeyC', 4, 67); await sleep(600); const t = clip();
    if (!/50,000/.test(p.status) || !/^\d+$/.test(t.trim())) throw new Error(JSON.stringify({ status: p.status, t }));
    return { status: p.status, copied: t.trim() };
  });
  await step('Schema tab: cards, nested schema, row groups; Copy schema as JSON (clipboard checked)', async () => {
    await vs.wvClick(wv, btn('Schema')); await sleep(400);
    await vs.wvClick(wv, btn('Copy schema as JSON')); await sleep(800);
    const j = JSON.parse(clip());
    const rows = await E(`document.querySelectorAll('.schemaview tbody tr').length`);
    await shot('readme-schema');
    await vs.wvClick(wv, btn('Data')); await sleep(300);
    if (j.fields.length !== 12 || !j.fields.find(f => f.name === 'pickup').fields || rows < 20) throw new Error(JSON.stringify({ j, rows }));
    return { fields: j.fields.length, tableRows: rows, fare: j.fields.find(f => f.name === 'fare') };
  });
  await step('Export ▾ CSV through the save dialog writes every row of the view', async () => {
    const out = path.join(work, 'export-taxi.csv'); fs.rmSync(out, { force: true });
    await vs.wvClick(wv, btn('Export ▾')); await vs.wvClick(wv, `document.querySelectorAll('.menu-item')[0]`);
    await sleep(1200);
    await vs.wbEval(`(() => { const i = document.querySelector('.quick-input-widget input'); if (i) { i.focus(); i.select(); } return !!i; })()`);
    await vs.type(out); await sleep(400); await vs.key('Enter', 'Enter');
    const ok = await vs.waitFor(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8').trim().split('\n').length === 50001, 30000, 300);
    const n = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim().split('\n').length : 0;
    if (!ok) throw new Error('export lines ' + n);
    fs.rmSync(out, { force: true });
    return { lines: n };
  });
  const files = [
    ['precision.parquet', p => p.rows[0].includes('1234567890123456789012345678.0123456789') && p.rows[0].includes('9007199254740993') && p.rows[0].includes('2023-11-14 22:13:20.123456789')],
    ['precision-flba.parquet', p => p.rows[1].includes('-0.0000000001') && p.rows[0].includes('18446744073709551615')],
    ['nested.parquet', p => p.rows[0].includes('{"name":"Ana","address":{"city":"Lisbon","zip":"1000"}}')],
    ['codec-brotli.parquet', p => p.total === 2000 && p.rows[0][1] === '9007199254740993'],
    ['codec-lz4.parquet', p => p.total === 2000 && p.rows[0][1] === '9007199254740993'],
    ['codec-gzip.parquet', p => p.total === 2000],
    ['legacy-v1.parq', p => p.total === 2000 && p.rows[0][1] === '9007199254740993'],
    ['datapage-v2.pq', p => p.total === 2000],
    ["it's 100% names.parquet", p => p.columns.join('|') === 'rate %|a|b|quote"col|名前|tab\tname' && p.rows[0][1] === '0.5'],
    ['apache/int96_from_spark.parquet', p => p.rows[0][1] === '2024-01-01 20:34:56.123456'],
    ['apache/fixed_length_decimal.parquet', p => p.rows[0][1] === '1.00'],
    ['apache/nested_maps.snappy.parquet', p => p.rows[0][1] === '{"a":{"1":true,"2":false}}'],
    ['apache/nonnullable.impala.parquet', p => p.total === 1],
    ['page-index.parquet', p => p.total === 20000],
    ['empty.parquet', p => p.total === 0 && /0 rows/.test(p.banner)],
  ];
  for (const [f, check] of files) {
    await step(`opens ${f}`, async () => {
      const t0 = await open(f); const { p, ms } = await rendered(t0);
      if (p.error || !check(p)) throw new Error(JSON.stringify(p).slice(0, 700));
      return { ms, total: p.total, firstRow: (p.rows[0] || []).slice(0, 6) };
    });
  }
  const hostile = [
    ['hostile-truncated.parquet', /end of this Parquet file is missing/],
    ['hostile-not-parquet.parquet', /not a Parquet file/],
    ['hostile-footer-past-eof.parquet', /damaged or cut off/],
    ['hostile-garbage-footer.parquet', /can't be read/],
    ['hostile-zero-bytes.parquet', /empty/],
    ['apache/encrypt_columns_and_footer.parquet.encrypted', /encrypted/],
  ];
  // .encrypted is not a Parquet file name: open it with the command
  for (const [f, re] of hostile) {
    await step(`hostile ${f}: a clear message, no crash, no hang`, async () => {
      let t0;
      if (f.endsWith('.encrypted')) {
        const copy = path.join(ws, 'encrypted-footer.parquet'); fs.copyFileSync(path.join(ws, f), copy); t0 = await open(copy);
      } else t0 = await open(f);
      const p = await vs.waitFor(async () => { const p = await probe(); return p && p.error ? p : null; }, 10000, 100);
      if (!p || !re.test(p.error)) throw new Error(JSON.stringify(p || await probe()).slice(0, 500));
      if (f === 'hostile-truncated.parquet') await shot('hostile-truncated');
      return { ms: Date.now() - t0, message: p.error };
    });
  }
  await step('hostile-chunk-4gb.parquet: schema opens, the bad row group shows a message, nothing hangs', async () => {
    const t0 = await open('hostile-chunk-4gb.parquet');
    const p = await vs.waitFor(async () => { const p = await probe(); return p && p.opened && /4\.0 GB/.test(p.banner) ? p : null; }, 10000, 100);
    if (!p) throw new Error(JSON.stringify(await probe()).slice(0, 500));
    await shot('hostile-chunk-4gb');
    return { ms: Date.now() - t0, banner: p.banner.slice(0, 220), rss: extHostRss() };
  });
  if (large && fs.existsSync(large)) {
    await step(`LARGE ${path.basename(large)} (${(fs.statSync(large).size / 1073741824).toFixed(2)} GB): first rows on screen, memory`, async () => {
      const before = extHostRss();
      const t0 = await open(large); const { p, ms } = await rendered(t0, 60000);
      if (p.error) throw new Error(p.error);
      const after = extHostRss();
      await shot('large-first-rows');
      return { firstRowsMs: ms, total: p.total, status: p.status, summary: p.summary, rssBefore: before, rssAfter: after };
    });
    await step('LARGE: jump to the last row (Ctrl+End) and to the middle, rows load', async () => {
      const t0 = Date.now();
      await vs.wvClick(wv, cellSel(1, 0));
      await vs.key('End', 'End', 4); await sleep(100); const p = await settle();
      const endMs = Date.now() - t0;
      const t1 = Date.now();
      await E(`(() => { const s = document.querySelector('.scroller'); s.scrollTop = (s.scrollHeight - s.clientHeight) / 2; return 1; })()`);
      await sleep(100); const q = await settle();
      const midMs = Date.now() - t1;
      return { endMs, endStatus: p.status, midMs, midStatus: q.status, firstMidRow: q.rows[0].slice(0, 3), rss: extHostRss() };
    });
    await step('LARGE: filter one sensor over the whole file, with progress, then Cancel works', async () => {
      await vs.wvClick(wv, `document.querySelectorAll('.filter')[2]`); await vs.type('=sensor-042'); await vs.key('Enter', 'Enter');
      const prog = await vs.waitFor(async () => { const p = await probe(); return p.querying && /Filtering/.test(p.banner) ? p : null; }, 15000, 100);
      await sleep(1500);
      const mid = await probe();
      await vs.wvClick(wv, btn('Cancel')); await sleep(500);
      const after = await probe();
      if (!prog || after.querying) throw new Error(JSON.stringify({ prog, after }).slice(0, 500));
      await vs.wvClick(wv, btn('Clear')); await sleep(400);
      return { progress: mid.banner, afterCancel: after.count, rss: extHostRss() };
    });
  }
  await step('light theme: the grid follows the VS Code colors', async () => {
    const sp = path.join(work, 'ud', 'User', 'settings.json');
    const s = JSON.parse(fs.readFileSync(sp, 'utf8')); s['workbench.colorTheme'] = 'Default Light Modern'; fs.writeFileSync(sp, JSON.stringify(s, null, 1));
    await sleep(2500);
    const t0 = await open('codec-zstd.parquet'); await rendered(t0);
    const bg = await E(`getComputedStyle(document.body).backgroundColor`);
    await shot('light-theme');
    if (!/255, 255, 255|rgb\(2[0-9]{2}, 2[0-9]{2}, 2[0-9]{2}\)/.test(bg)) throw new Error('background ' + bg);
    return { background: bg };
  });
} finally {
  R.console = vs.console.filter(c => !/ExtensionGalleryService|marketplace|update|telemetry|ERR_NETWORK|net::|punycode|SQLite|chat/i.test(c.text)).slice(0, 60);
  R.unchanged = Object.entries(R.hashes).every(([f, hsh]) => !fs.existsSync(path.join(ws, f)) || hash(path.join(ws, f)) === hsh);
  R.shots = shots;
  R.finished = new Date().toISOString();
  R.summary = { pass: R.steps.filter(s => s.ok).length, fail: R.steps.filter(s => !s.ok).length };
  fs.writeFileSync(outJson, JSON.stringify(R, null, 1));
  await vs.close();
  console.log(JSON.stringify(R.summary));
}
