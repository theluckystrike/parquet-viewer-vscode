'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateWebviewMessage: v } = require('../src/core/protocol');
const { buildHtml } = require('../src/html');

test('webview messages are checked', () => {
  assert.equal(v(null).ok, false);
  assert.equal(v({ type: 'nope' }).ok, false);
  assert.equal(v({ type: 'rows', start: -1, end: 5 }).ok, false);
  assert.equal(v({ type: 'rows', start: 0, end: 5000 }).msg.end, 1000, 'at most 1000 rows per request');
  assert.equal(v({ type: 'cell', row: 1.5, col: 0 }).ok, false);
  assert.equal(v({ type: 'copy', r0: 0, r1: 3, cols: [0, 'x', 2], format: 'exe' }).msg.format, 'csv');
  assert.deepEqual(v({ type: 'copy', r0: 0, r1: 3, cols: [0, 'x', 2] }).msg.cols, [0, 2]);
  const q = v({ type: 'query', filters: [{ col: 'a', text: '>1' }, { col: 5 }], sort: { col: 'a', desc: 1 }, search: 'x', extra: 'y' }).msg;
  assert.deepEqual(q, { type: 'query', req: 0, filters: [{ col: 'a', text: '>1' }], sort: { col: 'a', desc: true }, search: 'x' });
  assert.equal(v({ type: 'export', path: '/etc/passwd' }).ok, false, 'the webview can not pick an export path');
});

test('CSP: no network, scripts by nonce only', () => {
  const html = buildHtml({ cspSource: 'vscode-resource:', scriptUri: 's.js', styleUri: 's.css', title: '<x>', nonce: 'abc' });
  const csp = /content="([^"]+)"/.exec(html)[1];
  assert.match(csp, /^default-src 'none'/);
  assert.match(csp, /script-src 'nonce-abc'/);
  assert.match(csp, /img-src vscode-resource: blob: data:/);
  assert.ok(!/https?:/.test(csp), 'no remote origin');
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp));
  assert.ok(html.includes('&lt;x&gt;'), 'title escaped');
});
