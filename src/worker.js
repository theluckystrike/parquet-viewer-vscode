'use strict';
// Worker thread: reading, filtering and sorting never block the extension host.
const { parentPort } = require('worker_threads');
const { createSession } = require('./core/session');

const session = createSession({ post: msg => parentPort.postMessage(msg) });

parentPort.on('message', msg => {
  Promise.resolve()
    .then(() => session.handle(msg))
    .catch(e => parentPort.postMessage({ type: 'fatal', message: e && e.message ? e.message : String(e) }));
});
