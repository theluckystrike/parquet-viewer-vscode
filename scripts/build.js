'use strict';
// Bundles the extension host, the worker and the webview with esbuild.
const esbuild = require('esbuild');
const path = require('path');
const root = path.join(__dirname, '..');
const prod = process.argv.includes('--production');
// legalComments 'none': the bundled libraries' licenses are in THIRD-PARTY-NOTICES.txt, which ships in the VSIX.
const common = { bundle: true, minify: prod, sourcemap: !prod, legalComments: 'none', logLevel: 'info', absWorkingDir: root };
Promise.all([
  esbuild.build({ ...common, entryPoints: ['src/extension.js'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'] }),
  esbuild.build({ ...common, entryPoints: ['src/worker.js'], outfile: 'dist/worker.js', platform: 'node', format: 'cjs', target: 'node18' }),
  esbuild.build({ ...common, entryPoints: ['src/webview/main.js'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'chrome110' }),
]).catch(() => process.exit(1));
