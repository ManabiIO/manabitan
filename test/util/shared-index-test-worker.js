/* SPDX-License-Identifier: GPL-3.0-or-later */

import {closeSync, fsyncSync, ftruncateSync, openSync, writeSync} from 'node:fs';
import {parentPort, threadId, workerData} from 'node:worker_threads';
import {attachImportIndexWorkerServer} from '../../ext/js/dictionary/term-record-import-index-worker-server.js';

// Real worker messages and MessagePorts exercise the production index server.
// Compression replies are deliberately tiny protocol witnesses, not codec data.
const parent = parentPort;
if (parent === null) { throw new Error('Expected shared index test worker'); }

/**
 * @typedef {{shortWrite?: number, blockWriteAt?: number, flushErrorAt?: number, acquireError?: boolean, truncateError?: boolean, closeError?: boolean}} FileOptions
 * @typedef {{path: string, counters: SharedArrayBuffer, options: FileOptions}} FileToken
 * @typedef {{compressionErrorAt?: number, dropReplyAction?: string}} WorkerOptions
 */
const options = /** @type {{options: WorkerOptions}} */ (workerData).options;
/** @type {import('node:worker_threads').MessagePort[]} */
const ports = [];
let compressionCount = 0;

/**
 * @param {FileToken} token
 * @returns {Parameters<import('../../ext/js/dictionary/term-record-import-index-writer.js').openSyncImportIndexWriter>[0]}
 */
function fileHandle(token) {
    const counters = new Int32Array(token.counters);
    return {
        async createSyncAccessHandle() {
            if (token.options.acquireError) { throw new Error('Shared acquisition witness'); }
            if (Atomics.compareExchange(counters, 8, 0, 1) !== 0) { throw new Error('Shared sidecar is still locked'); }
            const fd = openSync(token.path, 'r+');
            Atomics.add(counters, 0, 1);
            Atomics.store(counters, 9, threadId);
            return {
                /**
                 * @param {Uint8Array} bytes
                 * @param {{at?: number}} [position]
                 * @returns {number}
                 */
                write(bytes, {at = 0} = {}) {
                    const call = Atomics.add(counters, 1, 1) + 1;
                    Atomics.store(counters, 7, Math.max(Atomics.load(counters, 7), bytes.byteLength));
                    if (token.options.blockWriteAt === call) {
                        Atomics.store(counters, 4, 1);
                        Atomics.notify(counters, 4);
                        if (Atomics.wait(counters, 5, 0, 10_000) === 'timed-out') {
                            throw new Error('Shared writer test gate timed out');
                        }
                    }
                    const length = writeSync(fd, bytes, 0, Math.min(bytes.byteLength, token.options.shortWrite ?? bytes.byteLength), at);
                    Atomics.add(counters, 6, length);
                    return length;
                },
                /** @param {number} size */
                truncate(size) {
                    if (token.options.truncateError) { throw new Error('Shared truncate witness'); }
                    ftruncateSync(fd, size);
                },
                flush() {
                    const call = Atomics.add(counters, 2, 1) + 1;
                    if (token.options.flushErrorAt === call) { throw new Error('Shared final flush witness'); }
                    fsyncSync(fd);
                },
                close() {
                    Atomics.add(counters, 3, 1);
                    // Throw before closing, so an empty server writer map is
                    // not evidence that its access-handle lock was released.
                    if (token.options.closeError) { throw new Error('Shared close witness'); }
                    closeSync(fd);
                    Atomics.store(counters, 8, 0);
                },
            };
        },
    };
}

/** @param {import('node:worker_threads').MessagePort} port */
function attach(port) {
    ports.push(port);
    /** @type {Map<number, string>} */
    const actions = new Map();
    /** @type {Map<(event: MessageEvent<unknown>) => void, (value: Record<string, unknown>) => void>} */
    const listeners = new Map();
    const endpoint = {
        /**
         * @param {string} type
         * @param {(event: MessageEvent<unknown>) => void} listener
         */
        addEventListener(type, listener) {
            if (type !== 'message') { throw new Error('Unexpected server event'); }
            const wrapped = (/** @type {Record<string, unknown>} */ value) => {
                actions.set(/** @type {number} */ (value.id), /** @type {string} */ (value.action));
                if (value.action === 'open') {
                    value.fileHandle = fileHandle(/** @type {FileToken} */ (value.fileHandle));
                }
                listener(new MessageEvent('message', {data: value}));
            };
            listeners.set(listener, wrapped);
            port.on('message', wrapped);
        },
        /**
         * @param {string} type
         * @param {(event: MessageEvent<unknown>) => void} listener
         */
        removeEventListener(type, listener) {
            if (type !== 'message') { throw new Error('Unexpected server event'); }
            const wrapped = listeners.get(listener);
            if (typeof wrapped !== 'undefined') { port.off('message', wrapped); }
            listeners.delete(listener);
        },
        /** @param {Record<string, unknown>} value */
        postMessage(value) {
            const action = actions.get(/** @type {number} */ (value.id));
            if (typeof action === 'string' && action === options.dropReplyAction) { return; }
            port.postMessage(value);
        },
    };
    attachImportIndexWorkerServer(/** @type {MessagePort} */ (/** @type {unknown} */ (endpoint)), () => { port.close(); });
    port.start();
}

parent.on('message', (/** @type {Record<string, unknown>} */ data) => {
    if (data.testControl === 'close-ports') {
        for (const port of ports) { port.close(); }
        parent.postMessage({testControlAck: data.controlId});
        return;
    }
    if (data.type === 'connect-import-index') {
        attach(/** @type {import('node:worker_threads').MessagePort} */ (data.port));
        return;
    }
    ++compressionCount;
    if (compressionCount === options.compressionErrorAt) {
        parent.postMessage({id: data.id, error: 'Shared compression witness'});
        return;
    }
    const content = /** @type {Uint8Array} */ (data.content);
    const compressed = Uint8Array.of(content?.[0] ?? 0).buffer;
    parent.postMessage({id: data.id, compressed, envelopeMs: 0}, [compressed]);
});
parent.postMessage({type: 'ready'});
