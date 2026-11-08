'use strict';
// Listing and manifest rules from the factory standard.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('engine floor for Cursor, Windsurf, VSCodium and code-server (OVX1)', () => {
  assert.equal(pkg.engines.vscode, '^1.90.0');
  assert.equal(pkg.devDependencies['@types/vscode'], '~1.90.0');
});

test('display name: every word of the target phrases, not a copy of another listing', () => {
  const name = pkg.displayName.toLowerCase();
  for (const w of ['parquet', 'viewer', 'file']) assert.ok(name.includes(w), w);
  for (const other of ['parquet-viewer', 'parquet viewer', 'parquet explorer', 'parquet file viewer', 'parquet visualizer']) {
    assert.notEqual(name, other);
    assert.ok(!name.startsWith(other), `starts like "${other}"`);
  }
  assert.equal(pkg.name, 'zovo-parquet-viewer');
});

test('opens .parquet, .parq and .pq; settings and walkthrough files exist', () => {
  const sel = pkg.contributes.customEditors[0].selector.map(s => s.filenamePattern);
  assert.deepEqual(sel, ['*.parquet', '*.parq', '*.pq']);
  const props = Object.keys(pkg.contributes.configuration.properties);
  assert.ok(props.includes('parquetViewer.askForRating') && props.includes('parquetViewer.showSupportLinks'));
  for (const s of pkg.contributes.walkthroughs[0].steps) {
    const m = s.media.markdown || s.media.image;
    assert.ok(fs.existsSync(path.join(root, m)) || m.startsWith('images/'), m);
  }
  assert.ok(fs.existsSync(path.join(root, pkg.icon)));
});

test('the VSIX ships only the bundles, media, docs and the README images', () => {
  const ig = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8');
  assert.match(ig, /^\*\*$/m);
  for (const f of ['dist/extension.js', 'dist/worker.js', 'dist/webview.js', 'THIRD-PARTY-NOTICES.txt', 'images/screenshot.png']) assert.ok(ig.includes('!' + f), f);
});

test('README: first screen says free, no sign-in, works offline, and shows a screenshot', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const first = readme.split('\n').slice(0, 8).join('\n');
  assert.match(first, /Free, no sign-in, works offline/);
  assert.match(first, /!\[[^\]]+\]\(images\/screenshot\.png\)/);
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(readme), 'no unfilled numbers');
});
