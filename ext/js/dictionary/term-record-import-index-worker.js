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
/* eslint-disable-next-line @stylistic/semi */
import {completeTermRecordLookupChunkChecksums} from './term-record-lookup-index-checksum.js'

/** @type {Map<number, import('./term-record-import-index-writer.js').SyncImportIndexWriter>} */
const writers = new Map();
/** @type {Set<number>} */
const opening = new Set();
/** @type {Map<Error, number>} */
const errors = new Map();

self.addEventListener('message', (event) => { void handleRequest(event.data); });
self.postMessage({type: 'ready'});

/** @param {unknown} value */
async function handleRequest(value) {
    const data = /** @type {{id?: unknown, writerId?: unknown, action?: unknown, fileHandle?: unknown, chunks?: unknown, checksumChunkIndexes?: unknown, offset?: unknown, size?: unknown}} */ (value);
    const id = typeof data?.id === 'number' ? data.id : -1;
    try {
        const writerId = data.writerId;
        if (
            !Number.isSafeInteger(id) || id <= 0 || typeof writerId !== 'number' ||
            !Number.isSafeInteger(writerId) || writerId <= 0
        ) {
            throw new TypeError('Invalid import index worker request');
        }
        let result;
        if (data.action === 'open') {
            if (writers.has(writerId) || opening.has(writerId)) { throw new Error('Import index writer already exists'); }
            if (typeof data.fileHandle !== 'object' || data.fileHandle === null) { throw new TypeError('Missing import index file handle'); }
            opening.add(writerId);
            try {
                const writer = await openSyncImportIndexWriter(/** @type {Parameters<typeof openSyncImportIndexWriter>[0]} */ (data.fileHandle), true);
                if (writer === null) {
                    result = 'unsupported';
                } else {
                    writers.set(writerId, writer);
                    result = 'opened';
                }
            } finally {
                opening.delete(writerId);
            }
        } else {
            const writer = writers.get(writerId);
            if (typeof writer === 'undefined') { throw new Error('Import index writer is unavailable'); }
            switch (data.action) {
                /* eslint-disable @stylistic/semi */
                case 'writeChunks': {
                    const chunks = /** @type {Uint8Array[]} */ (data.chunks)
                    const checksumChunkIndexes = /** @type {number[]|undefined} */ (data.checksumChunkIndexes)
                    // Preparation belongs to the ordered writer operation, so
                    // its failure is sticky and close/abort must join it.
                    await writer.writeChunks(
                        chunks,
                        typeof checksumChunkIndexes === 'undefined' ?
                            null :
                            () => {
                                let previousIndex = -1
                                for (const index of checksumChunkIndexes) {
                                    if (!Number.isInteger(index) || index <= previousIndex || index >= chunks.length) {
                                        throw new RangeError('Invalid import index checksum chunk index')
                                    }
                                    completeTermRecordLookupChunkChecksums(chunks[index])
                                    previousIndex = index
                                }
                            },
                    )
                    break;
                }
                /* eslint-enable @stylistic/semi */
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
                        writers.delete(writerId);
                    }
                    break;
                default:
                    throw new TypeError('Unknown import index worker operation');
            }
        }
        self.postMessage({id, result});
    } catch (error) {
        self.postMessage({id, error: serializeImportIndexWorkerError(error, errors)});
    }
}
