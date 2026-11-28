/* SPDX-License-Identifier: GPL-3.0-or-later */

import {closeSync, fsyncSync, ftruncateSync, openSync, writeSync} from 'node:fs';

/**
 * @typedef {{shortWrite?: number, blockWriteAt?: number, blockFlushAt?: number, writeErrorAt?: number, flushErrorAt?: number, closeError?: boolean, crashWriteAt?: number}} FileOptions
 * @typedef {{path: string, counters: SharedArrayBuffer, options: FileOptions}} FileToken
 */

/**
 * @param {FileToken} token
 * @returns {Parameters<import('../../ext/js/dictionary/term-record-import-index-writer.js').openSyncImportIndexWriter>[0]}
 */
export function createImportIndexTestFileHandle(token) {
    const counters = new Int32Array(token.counters);
    const {options} = token;
    return {
        async createSyncAccessHandle() {
            const fd = openSync(token.path, 'r+');
            Atomics.add(counters, 0, 1);
            return {
                /**
                 * @param {Uint8Array} bytes
                 * @param {{at?: number}} [position]
                 * @returns {number}
                 */
                write(bytes, {at = 0} = {}) {
                    const count = Atomics.add(counters, 1, 1) + 1;
                    Atomics.store(counters, 7, Math.max(Atomics.load(counters, 7), bytes.byteLength));
                    if (options.blockWriteAt === count) { block(counters, 1); }
                    if (options.crashWriteAt === count) { process.exit(7); }
                    if (options.writeErrorAt === count) { throw new Error('Worker write witness'); }
                    const length = writeSync(fd, bytes, 0, Math.min(bytes.byteLength, options.shortWrite ?? bytes.byteLength), at);
                    Atomics.add(counters, 6, length);
                    return length;
                },
                /** @param {number} size */
                truncate(size) { ftruncateSync(fd, size); },
                flush() {
                    const count = Atomics.add(counters, 2, 1) + 1;
                    if (options.blockFlushAt === count) { block(counters, 2); }
                    if (options.flushErrorAt === count) { throw new Error('Worker flush witness'); }
                    fsyncSync(fd);
                },
                close() {
                    Atomics.add(counters, 3, 1);
                    closeSync(fd);
                    if (options.closeError) { throw new Error('Worker close witness'); }
                },
            };
        },
    };
}

/**
 * @param {Int32Array} counters
 * @param {number} kind
 */
function block(counters, kind) {
    Atomics.store(counters, 4, kind);
    Atomics.notify(counters, 4);
    if (Atomics.wait(counters, 5, 0, 10_000) === 'timed-out') { throw new Error('Worker test gate timed out'); }
}
