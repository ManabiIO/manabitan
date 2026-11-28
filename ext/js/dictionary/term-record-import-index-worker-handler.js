/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {openSyncImportIndexWriter} from './term-record-import-index-writer.js';
import {serializeImportIndexWorkerError} from './term-record-import-index-worker-client.js';

/**
 * Owns an independent request namespace and every handle opened through it.
 * A borrowed worker session must acknowledge disposal after all handles and
 * operations settle; closing a message port alone is not a storage barrier.
 */
export class ImportIndexWorkerHandler {
    /**
     * @param {(value: unknown) => void} postMessage
     * @param {(() => void)|null} [disposeSession]
     */
    constructor(postMessage, disposeSession = null) {
        /** @type {(value: unknown) => void} */
        this._postMessage = postMessage;
        /** @type {(() => void)|null} */
        this._disposeSession = disposeSession;
        /** @type {Map<number, import('./term-record-import-index-writer.js').SyncImportIndexWriter>} */
        this._writers = new Map();
        /** @type {Set<number>} */
        this._opening = new Set();
        /** @type {Map<Error, number>} */
        this._errors = new Map();
        /** @type {number} */
        this._activeRequests = 0;
        /** @type {boolean} */
        this._disposed = false;
        /** @type {boolean} */
        this._storageFailed = false;
    }

    /** @param {unknown} value */
    async handleRequest(value) {
        const data = /** @type {{id?: unknown, writerId?: unknown, action?: unknown, fileHandle?: unknown, chunks?: unknown, offset?: unknown, size?: unknown}} */ (value);
        const id = typeof data?.id === 'number' ? data.id : -1;
        ++this._activeRequests;
        try {
            if (this._disposed) { throw new Error('Import index worker session is disposed'); }
            const writerId = data.writerId;
            if (!Number.isSafeInteger(id) || id <= 0) {
                throw new TypeError('Invalid import index worker request');
            }
            if (data.action === 'dispose-session') {
                if (writerId !== 0 || this._disposeSession === null) {
                    throw new TypeError('Import index worker session cannot detach');
                }
                if (this._storageFailed) {
                    throw new Error('Import index worker session cannot detach after storage failure');
                }
                if (this._writers.size > 0 || this._opening.size > 0 || this._activeRequests !== 1) {
                    throw new Error('Import index worker session still owns pending storage');
                }
                this._disposed = true;
                this._errors.clear();
                this._postMessage({id, result: 'disposed'});
                this._disposeSession();
                return;
            }
            if (typeof writerId !== 'number' || !Number.isSafeInteger(writerId) || writerId <= 0) {
                throw new TypeError('Invalid import index worker request');
            }
            let result;
            if (data.action === 'open') {
                if (this._writers.has(writerId) || this._opening.has(writerId)) { throw new Error('Import index writer already exists'); }
                if (typeof data.fileHandle !== 'object' || data.fileHandle === null) { throw new TypeError('Missing import index file handle'); }
                this._opening.add(writerId);
                try {
                    const writer = await openSyncImportIndexWriter(/** @type {Parameters<typeof openSyncImportIndexWriter>[0]} */ (data.fileHandle), true);
                    if (writer === null) {
                        result = 'unsupported';
                    } else {
                        this._writers.set(writerId, writer);
                        result = 'opened';
                    }
                } finally {
                    this._opening.delete(writerId);
                }
            } else {
                const writer = this._writers.get(writerId);
                if (typeof writer === 'undefined') { throw new Error('Import index writer is unavailable'); }
                switch (data.action) {
                    case 'writeChunks':
                        await writer.writeChunks(/** @type {Uint8Array[]} */ (data.chunks));
                        break;
                    case 'seek':
                        await writer.seek(/** @type {number} */ (data.offset));
                        break;
                    case 'truncate':
                        await writer.truncate(/** @type {number} */ (data.size));
                        break;
                    case 'close':
                    case 'abort':
                        try {
                            await (data.action === 'close' ? writer.close() : writer.abort());
                        } finally {
                            this._writers.delete(writerId);
                        }
                        break;
                    default:
                        throw new TypeError('Unknown import index worker operation');
                }
            }
            this._postMessage({id, result});
        } catch (error) {
            // Dedicated workers release ambiguous handles when terminated. A
            // borrowed worker must retain that guarantee after failed open,
            // write or close operations, even if its writer map is now empty.
            if (data?.action !== 'dispose-session') { this._storageFailed = true; }
            this._postMessage({id, error: serializeImportIndexWorkerError(error, this._errors)});
        } finally {
            --this._activeRequests;
        }
    }
}

/**
 * Binds only this channel. Compression messages use the worker's existing
 * endpoint and cannot collide with storage request or writer identifiers.
 * @param {MessagePort} port
 * @param {() => void} [onDispose]
 */
export function attachImportIndexWorkerPort(port, onDispose = () => {}) {
    /** @param {MessageEvent<unknown>} event */
    const listener = (event) => { void handler.handleRequest(event.data); };
    const handler = new ImportIndexWorkerHandler(
        (value) => { port.postMessage(value); },
        () => {
            port.removeEventListener('message', listener);
            port.close();
            onDispose();
        },
    );
    port.addEventListener('message', listener);
    port.start();
    port.postMessage({type: 'ready'});
}
