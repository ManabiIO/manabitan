/* SPDX-License-Identifier: GPL-3.0-or-later */

import {readFileSync} from 'node:fs';
import {parentPort, workerData} from 'node:worker_threads';
import {createImportIndexTestFileHandle} from './import-index-test-file-handle.js';

// Execute the production codec and borrowed index handler in one real thread.
// Only browser file fetching and OPFS handles use Node-backed adapters.
const port = parentPort;
if (port === null) { throw new Error('Expected a compression index test worker thread'); }

Reflect.set(globalThis, 'fetch', async (/** @type {string|URL|Request} */ input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.protocol !== 'file:') { throw new Error('Expected a repository-owned codec asset'); }
    return new Response(readFileSync(url), {
        headers: {'Content-Type': url.pathname.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream'},
    });
});

Reflect.set(globalThis, 'self', {
    /**
     * @param {string} type
     * @param {(event: {data: unknown}) => void} listener
     */
    addEventListener(type, listener) {
        if (type !== 'message') { throw new Error('Unexpected worker listener'); }
        port.on('message', (data) => {
            if (data.type === 'bind-import-index' && data.port instanceof MessagePort) {
                // MessagePort is transferred intact. Decorate the cloned file
                // token before the production handler observes that same event.
                data.port.addEventListener('message', (/** @type {MessageEvent<{action?: unknown, fileHandle?: unknown}>} */ event) => {
                    const request = event.data;
                    if (request.action === 'open') {
                        request.fileHandle = createImportIndexTestFileHandle(
                            /** @type {import('./import-index-test-file-handle.js').FileToken} */ (request.fileHandle),
                        );
                    }
                });
            }
            listener({data});
        });
    },
    /**
     * @param {unknown} value
     * @param {import('node:worker_threads').TransferListItem[]} [transfer]
     */
    postMessage(value, transfer = []) { port.postMessage(value, transfer); },
});

if (workerData.entry !== new URL('../../ext/js/dictionary/zstd-term-content-compression-worker.js', import.meta.url).href) {
    throw new Error('Expected production compression worker entry');
}
await import('../../ext/js/dictionary/zstd-term-content-compression-worker.js');
