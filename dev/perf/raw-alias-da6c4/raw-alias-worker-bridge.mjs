// SPDX-License-Identifier: GPL-3.0-or-later
// Browser-worker transport adapter for this Node storage component only.
import {parentPort, workerData} from 'node:worker_threads';
import {readFile} from 'node:fs/promises';
import {reviveFileHandle} from './raw-alias-node-opfs.mjs';

const entry = new URL(workerData.entry);
const compression = entry.pathname.endsWith('/zstd-term-content-compression-worker.js');
const indexWriter = entry.pathname.endsWith('/term-record-import-index-worker.js');
if (!compression && !indexWriter) { throw new Error('Unexpected component worker entry'); }
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
    if (url.protocol !== 'file:') { return originalFetch(input, options); }
    return new Response(await readFile(url), {
        headers: {'Content-Type': url.pathname.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream'},
    });
};
const listeners = new Set();
globalThis.self = {
    addEventListener(type, listener) { if (type === 'message') { listeners.add(listener); } },
    postMessage(data, transfer = []) { parentPort.postMessage(data, transfer); },
};
parentPort.on('message', (message) => {
    void (async () => {
        let data = message;
        if (indexWriter && data.action === 'open') {
            if (data.fileHandle?.rootPath !== workerData.rootPath) { throw new Error('Index worker file handle escaped observation root'); }
            data = {...data, fileHandle: await reviveFileHandle(data.fileHandle)};
        }
        for (const listener of listeners) { listener({data}); }
    })().catch((error) => { setImmediate(() => { throw error; }); });
});
await import(entry.href);
