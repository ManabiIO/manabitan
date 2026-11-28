/* SPDX-License-Identifier: GPL-3.0-or-later */

import {createImportIndexTestFileHandle} from './import-index-test-file-handle.js';
import {parentPort, workerData} from 'node:worker_threads';

// This adapter supplies OPFS-shaped synchronous file handles to the unchanged
// production worker entry. Messages and transferred buffers use a real thread.
const port = parentPort;
if (port === null) { throw new Error('Expected an import index test worker thread'); }

/** @typedef {import('./import-index-test-file-handle.js').FileOptions} FileOptions */

Reflect.set(globalThis, 'self', {
    /**
     * @param {string} type
     * @param {(event: {data: unknown}) => void} listener
     */
    addEventListener(type, listener) {
        if (type !== 'message') { throw new Error('Unexpected worker listener'); }
        port.on('message', (data) => {
            if (data.action === 'open') { data.fileHandle = createImportIndexTestFileHandle(data.fileHandle); }
            listener({data});
        });
    },
    /** @param {unknown} value */
    postMessage(value) { port.postMessage(value); },
});

if (workerData.entry !== new URL('../../ext/js/dictionary/term-record-import-index-worker.js', import.meta.url).href) {
    throw new Error('Expected production import index worker entry');
}
await import('../../ext/js/dictionary/term-record-import-index-worker.js');
