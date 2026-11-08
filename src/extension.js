'use strict';
const vscode = require('vscode');
const path = require('path');
const { Worker } = require('worker_threads');
const { buildHtml } = require('./html');
const { validateWebviewMessage } = require('./core/protocol');
const { createRatingPrompt } = require('./rate');
const { registerSupport, commandUris, showLinks } = require('./support');

const VIEW_TYPE = 'parquetViewer.grid';
const SECTION = 'parquetViewer';
const EXT_ID = 'zovo.zovo-parquet-viewer';
let rating = { success() {}, failure() {} };

function settings() {
  const c = vscode.workspace.getConfiguration(SECTION);
  return {
    maxSortRows: c.get('maxSortRows', 2000000),
    maxMatches: c.get('maxMatches', 5000000),
    maxCopyRows: c.get('maxCopyRows', 100000),
    maxFooterMB: c.get('maxFooterMB', 256),
    maxChunkMB: c.get('maxChunkMB', 2048),
    maxVirtualFileMB: c.get('maxVirtualFileMB', 512),
  };
}

class ParquetEditorProvider {
  constructor(context) { this.context = context; }

  openCustomDocument(uri) { return { uri, dispose() {} }; }

  async resolveCustomEditor(document, panel) {
    const ctx = this.context;
    const uri = document.uri;
    const dist = vscode.Uri.joinPath(ctx.extensionUri, 'dist');
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [dist, media], enableCommandUris: commandUris(SECTION) };
    const name = path.posix.basename(uri.path);
    panel.webview.html = buildHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'webview.css')).toString(),
      title: name,
      showSupportLinks: showLinks(vscode, SECTION),
    });

    let disposed = false;
    let counted = false;
    let worker = null;
    const post = m => (disposed ? Promise.resolve(false) : panel.webview.postMessage(m));

    const startWorker = async () => {
      if (worker) { worker.terminate().catch(() => {}); worker = null; }
      worker = new Worker(vscode.Uri.joinPath(dist, 'worker.js').fsPath);
      const w = worker;
      w.on('message', m => onWorker(m, w));
      w.on('error', e => { if (w === worker) post({ type: 'openError', code: 'WORKER', message: `The reader stopped: ${e && e.message ? e.message : e}` }); });
      w.on('exit', code => {
        if (w === worker && !disposed && code !== 0) post({ type: 'openError', code: 'WORKER_EXIT', message: 'The reader stopped (out of memory or crashed). Lower the limits in the parquetViewer settings, then reload.' });
      });
      const options = settings();
      if (uri.scheme === 'file') {
        w.postMessage({ type: 'open', path: uri.fsPath, options });
      } else {
        // Virtual and remote file systems: no range reads, so read the bytes once (with a size limit).
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > options.maxVirtualFileMB * 1024 * 1024) {
          post({ type: 'openError', code: 'TOO_LARGE', message: `This file is on a ${uri.scheme} file system and is ${(stat.size / 1048576).toFixed(0)} MB. Over ${options.maxVirtualFileMB} MB (setting parquetViewer.maxVirtualFileMB) it must be on a local disk, where only the needed parts are read.` });
          return;
        }
        const bytes = await vscode.workspace.fs.readFile(uri);
        w.postMessage({ type: 'open', bytes, options });
      }
    };

    const onWorker = async (m, w) => {
      if (w !== worker || !m) return;
      if (m.type === 'openError') { rating.failure(); post(m); return; }
      if (m.type === 'copyText') {
        if (m.error) { post({ type: 'toast', text: m.error, error: true }); return; }
        await vscode.env.clipboard.writeText(m.text);
        const what = { csv: 'CSV', tsv: 'tab-separated text', json: 'JSON', markdown: 'a Markdown table' }[m.format] || m.format;
        post({ type: 'toast', text: `Copied ${m.rows.toLocaleString('en-US')} row${m.rows === 1 ? '' : 's'} as ${what}.${m.cut ? ` Limit ${settings().maxCopyRows.toLocaleString('en-US')} rows (setting parquetViewer.maxCopyRows).` : ''}` });
        return;
      }
      if (m.type === 'schemaJson') {
        await vscode.env.clipboard.writeText(m.text);
        post({ type: 'toast', text: 'Copied the schema as JSON.' });
        return;
      }
      if (m.type === 'exported') {
        post(m);
        if (m.error) { vscode.window.showErrorMessage(`Export failed: ${m.error}`); return; }
        const open = 'Show in Folder';
        vscode.window.showInformationMessage(`Exported ${m.rows.toLocaleString('en-US')} rows to ${path.basename(m.path)}.`, open).then(c => {
          if (c === open) vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(m.path));
        });
        return;
      }
      if (m.type === 'fatal') { post({ type: 'toast', text: m.message, error: true }); return; }
      post(m);
    };

    const exportRows = async format => {
      const base = name.replace(/\.(parquet|parq|pq)$/i, '');
      const ext = format === 'jsonl' ? 'jsonl' : 'csv';
      const folder = uri.scheme === 'file' ? vscode.Uri.file(path.dirname(uri.fsPath)) : undefined;
      const target = await vscode.window.showSaveDialog({
        defaultUri: folder ? vscode.Uri.joinPath(folder, `${base}.${ext}`) : undefined,
        filters: format === 'jsonl' ? { 'JSON Lines': ['jsonl'] } : { CSV: ['csv'] },
        saveLabel: 'Export',
      });
      if (!target) return;
      if (target.scheme !== 'file') { vscode.window.showErrorMessage('Export writes to a local file. Pick a folder on this computer.'); return; }
      if (target.toString() === uri.toString()) { vscode.window.showErrorMessage('Pick another file name. The Parquet file is never overwritten.'); return; }
      post({ type: 'exportStarted' });
      worker.postMessage({ type: 'export', path: target.fsPath, format });
    };

    panel.webview.onDidReceiveMessage(async raw => {
      const v = validateWebviewMessage(raw);
      if (!v.ok) return;
      const msg = v.msg;
      try {
        switch (msg.type) {
          case 'ready': case 'reload': await startWorker(); return;
          case 'rendered': if (!counted) { counted = true; rating.success(uri); } return;
          case 'exportCsv': await exportRows('csv'); return;
          case 'exportJsonl': await exportRows('jsonl'); return;
          case 'settings': await vscode.commands.executeCommand('workbench.action.openSettings', SECTION); return;
          case 'copyText': await vscode.env.clipboard.writeText(msg.text); return;
          default: if (worker) worker.postMessage(msg);
        }
      } catch (e) {
        post({ type: 'toast', text: e && e.message ? e.message : String(e), error: true });
      }
    });
    panel.onDidDispose(() => {
      disposed = true;
      if (worker) { worker.postMessage({ type: 'close' }); const w = worker; setTimeout(() => w.terminate().catch(() => {}), 500); worker = null; }
    });
  }
}

function activate(context) {
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: SECTION, name: 'Parquet Grid Viewer' });
  registerSupport({ vscode, context, prefix: SECTION, selfId: EXT_ID });
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new ParquetEditorProvider(context), {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('parquetViewer.openWalkthrough', () =>
      vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#parquetViewer.start`, false)),
    vscode.commands.registerCommand('parquetViewer.openWith', async uri => {
      const target = uri instanceof vscode.Uri ? uri : (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
      if (target) await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
      else vscode.commands.executeCommand('workbench.action.quickOpen', '.parquet');
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate, ParquetEditorProvider, VIEW_TYPE };
