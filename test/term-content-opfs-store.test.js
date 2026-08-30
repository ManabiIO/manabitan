/*
 * Copyright (C) 2023-2025  Yomitan Authors
 * Copyright (C) 2020-2022  Yomichan Authors
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

import {afterEach, describe, expect, test, vi} from 'vitest';
import {TermContentOpfsStore} from '../ext/js/dictionary/term-content-opfs-store.js';

/**
 * @param {string} message
 * @returns {Error}
 */
function createNotReadableError(message = 'The requested file could not be read') {
    const error = new Error(message);
    error.name = 'NotReadableError';
    return error;
}

/**
 * @param {Uint8Array} bytes
 * @returns {{size: number, slice: (start: number, end: number) => {arrayBuffer: () => Promise<ArrayBufferLike>}}}
 */
function createReadableFile(bytes) {
    return {
        size: bytes.byteLength,
        slice(start, end) {
            const clampedStart = Math.max(0, start);
            const clampedEnd = Math.max(clampedStart, end);
            const page = bytes.slice(clampedStart, clampedEnd);
            return {
                async arrayBuffer() {
                    return page.buffer;
                },
            };
        },
    };
}

/**
 * @param {Map<string, Uint8Array>} fileBytesByName
 * @returns {FileSystemDirectoryHandle}
 */
function createMutableDirectory(fileBytesByName) {
    const getFileHandle = async (
        /** @type {string} */ name,
        /** @type {{create?: boolean}} */ options = {},
    ) => {
        const create = options.create === true;
        if (!fileBytesByName.has(name)) {
            if (!create) {
                const error = new Error(`File not found: ${name}`);
                error.name = 'NotFoundError';
                throw error;
            }
            fileBytesByName.set(name, new Uint8Array());
        }
        return {
            kind: 'file',
            name,
            async getFile() {
                const bytes = fileBytesByName.get(name) ?? new Uint8Array();
                return createReadableFile(bytes);
            },
            async createWritable() {
                let nextBytes = new Uint8Array(fileBytesByName.get(name) ?? new Uint8Array());
                return {
                    async truncate(/** @type {number} */ length) {
                        nextBytes = nextBytes.slice(0, length);
                    },
                    async close() {
                        fileBytesByName.set(name, nextBytes);
                    },
                };
            },
        };
    };
    return /** @type {FileSystemDirectoryHandle} */ (/** @type {unknown} */ ({
        getFileHandle,
        async removeEntry(/** @type {string} */ name) {
            fileBytesByName.delete(name);
        },
        async *entries() {
            for (const name of fileBytesByName.keys()) {
                yield [name, await getFileHandle(name)];
            }
        },
    }));
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('TermContentOpfsStore', () => {
    test('uses the lower raw-content flush threshold selected by source-import profiling', () => {
        const store = new TermContentOpfsStore();
        store.setImportStorageMode('raw-bytes');
        expect(Reflect.get(store, '_flushThresholdBytes')).toBe(8 * 1024 * 1024);
    });

    test('starts queued import writes before the sustained flush threshold', async () => {
        const store = new TermContentOpfsStore();
        Reflect.set(store, '_fileHandle', {});
        Reflect.set(store, '_importSessionActive', true);
        Reflect.set(store, '_flushThresholdBytes', 8 * 1024 * 1024);
        store.setQueueImportWritesEnabled(true);
        const flush = vi.spyOn(store, '_flushPendingWrites').mockResolvedValue();

        await store.appendBatch([new Uint8Array(4 * 1024 * 1024)]);

        expect(flush).toHaveBeenCalledOnce();
    });

    test('coalesces concurrent cold snapshot initialization', async () => {
        /** @type {() => void} */
        let releaseGetFile = () => {};
        const file = /** @type {File} */ (/** @type {unknown} */ ({size: 3}));
        const getFile = vi.fn(() => new Promise((resolve) => {
            releaseGetFile = () => { resolve(file); };
        }));
        const fileHandle = /** @type {FileSystemFileHandle} */ (/** @type {unknown} */ ({getFile}));
        const store = new TermContentOpfsStore();
        Reflect.set(store, '_fileHandle', fileHandle);
        Reflect.set(store, '_length', 3);
        Reflect.set(store, '_segmentStates', [{
            index: 0,
            fileName: 'manabitan-term-content.bin',
            fileHandle,
            fileLength: 3,
            startOffset: 0,
            readFile: null,
        }]);

        const first = store.ensureLoadedForRead();
        const second = store.ensureLoadedForRead();
        await vi.waitFor(() => expect(getFile).toHaveBeenCalledOnce());
        releaseGetFile();
        await Promise.all([first, second]);

        expect(getFile).toHaveBeenCalledOnce();
        expect(Reflect.get(store, '_loadedForRead')).toBe(true);
    });

    test('discards an in-flight snapshot invalidated by a newer generation', async () => {
        /** @type {() => void} */
        let releaseOldGetFile = () => {};
        const oldFile = /** @type {File} */ (/** @type {unknown} */ ({size: 3, generation: 'old'}));
        const newFile = /** @type {File} */ (/** @type {unknown} */ ({size: 5, generation: 'new'}));
        const oldGetFile = vi.fn(() => new Promise((resolve) => {
            releaseOldGetFile = () => { resolve(oldFile); };
        }));
        const newGetFile = vi.fn(async () => newFile);
        const oldFileHandle = /** @type {FileSystemFileHandle} */ (/** @type {unknown} */ ({getFile: oldGetFile}));
        const newFileHandle = /** @type {FileSystemFileHandle} */ (/** @type {unknown} */ ({getFile: newGetFile}));
        const store = new TermContentOpfsStore();
        const oldState = {
            index: 0,
            fileName: 'manabitan-term-content.bin',
            fileHandle: oldFileHandle,
            fileLength: 3,
            startOffset: 0,
            readFile: null,
        };
        Reflect.set(store, '_fileHandle', oldFileHandle);
        Reflect.set(store, '_length', 3);
        Reflect.set(store, '_segmentStates', [oldState]);

        const loading = store.ensureLoadedForRead();
        await vi.waitFor(() => expect(oldGetFile).toHaveBeenCalledOnce());
        const newState = {...oldState, fileHandle: newFileHandle, fileLength: 5};
        Reflect.set(store, '_fileHandle', newFileHandle);
        Reflect.set(store, '_segmentStates', [newState]);
        Reflect.get(store, '_invalidateReadState').call(store);
        releaseOldGetFile();
        await loading;

        expect(newGetFile).toHaveBeenCalledOnce();
        expect(oldState.readFile).toBeNull();
        expect(newState.readFile).toBe(newFile);
        expect(Reflect.get(store, '_length')).toBe(5);
        expect(Reflect.get(store, '_loadedForRead')).toBe(true);
    });

    test('keeps queued write failures sticky until rollback resets storage', async () => {
        const store = new TermContentOpfsStore();
        const writeError = new Error('injected write failure');
        const deferredWrite = {
            /** @type {(error: Error) => void} */
            reject: () => {},
        };
        vi.spyOn(store, '_writePendingChunksCoalesced').mockImplementation(() => {
            return new Promise((_, reject) => {
                deferredWrite.reject = reject;
            });
        });
        Reflect.set(store, '_queuedWriteChunks', [new Uint8Array([1])]);
        Reflect.set(store, '_queuedWriteBytes', 1);

        const drain = Reflect.get(store, '_drainQueuedWrites').call(store);
        Reflect.set(store, '_queuedWritePromise', drain);
        Reflect.get(store, '_queueWriteChunks').call(store, [new Uint8Array([2])]);
        deferredWrite.reject(writeError);
        await expect(drain).rejects.toBe(writeError);

        expect(Reflect.get(store, '_queuedWriteChunks')).toStrictEqual([]);
        Reflect.get(store, '_queueWriteChunks').call(store, [new Uint8Array([3])]);
        expect(Reflect.get(store, '_queuedWriteChunks')).toStrictEqual([]);
        await expect(Reflect.get(store, '_awaitQueuedWrites').call(store)).rejects.toBe(writeError);
    });

    test('queues a residual import write without waiting for persistence', async () => {
        const store = new TermContentOpfsStore();
        /** @type {() => void} */
        let releaseWrite = () => {};
        const writeStarted = vi.fn();
        vi.spyOn(store, '_writePendingChunksCoalesced').mockImplementation(async () => {
            writeStarted();
            await new Promise((resolve) => { releaseWrite = resolve; });
        });
        Reflect.set(store, '_fileHandle', {});
        Reflect.set(store, '_writable', {});
        Reflect.set(store, '_importSessionActive', true);
        Reflect.set(store, '_queueImportWritesEnabled', true);
        Reflect.set(store, '_pendingWriteChunks', [new Uint8Array([1, 2, 3])]);
        Reflect.set(store, '_pendingWriteBytes', 3);

        await expect(store.queuePendingImportWrites()).resolves.toBeUndefined();
        expect(writeStarted).toHaveBeenCalledOnce();
        expect(Reflect.get(store, '_pendingWriteBytes')).toBe(0);
        const queuedWritePromise = Reflect.get(store, '_queuedWritePromise');
        expect(queuedWritePromise).toBeInstanceOf(Promise);

        releaseWrite();
        await queuedWritePromise;
    });

    test('rollback survives a rejected queued write and does not create missing checkpoint files', async () => {
        const fileName = 'manabitan-term-content.bin';
        const createdName = 'manabitan-term-content^1.bin';
        const fileBytesByName = new Map([[fileName, new Uint8Array([1, 2, 3])]]);
        const root = createMutableDirectory(fileBytesByName);
        vi.stubGlobal('navigator', {storage: {getDirectory: vi.fn(async () => root)}});
        const store = new TermContentOpfsStore();
        await store.prepare();
        const checkpoint = await store.createImportCheckpoint();

        fileBytesByName.set(fileName, new Uint8Array([1, 2, 3, 4]));
        fileBytesByName.set(createdName, new Uint8Array([9]));
        Reflect.set(store, '_queuedWritePromise', Promise.reject(new Error('injected write failure')));
        await expect(store.rollbackImportSession(checkpoint)).resolves.toBeUndefined();
        expect(fileBytesByName.get(fileName)).toStrictEqual(new Uint8Array([1, 2, 3]));
        expect(fileBytesByName.has(createdName)).toBe(false);

        await expect(store.rollbackImportSession({
            segments: [{fileName: 'manabitan-term-content-2.bin', fileLength: 12}],
        })).rejects.toThrow(/Failed to roll back term-content import storage/);
        expect(fileBytesByName.has('manabitan-term-content-2.bin')).toBe(false);
    });

    test('appends primary and offset-derived chunks in one logical mutation', async () => {
        const store = new TermContentOpfsStore();
        const result = await store.appendBatchWithDerivedChunks(
            [new Uint8Array([1, 2]), new Uint8Array([3])],
            (offsets, lengths) => [new Uint8Array([offsets[0], lengths[0], offsets[1], lengths[1]])],
        );

        expect(result).toStrictEqual({
            primaryOffsets: [0, 2],
            primaryLengths: [2, 1],
            derivedOffsets: [3],
            derivedLengths: [4],
        });
        expect(await store.readSlice(0, 7)).toStrictEqual(new Uint8Array([1, 2, 3, 0, 2, 2, 1]));
    });

    test('does not mutate storage when derived chunk construction fails', async () => {
        const store = new TermContentOpfsStore();
        await store.appendBatch([new Uint8Array([7, 8])]);

        await expect(store.appendBatchWithDerivedChunks(
            [new Uint8Array([9])],
            () => { throw new Error('derive failed'); },
        )).rejects.toThrow('derive failed');
        expect(await store.readSlice(0, 3)).toBeNull();
        expect(await store.readSlice(0, 2)).toStrictEqual(new Uint8Array([7, 8]));
    });

    test('reserves derived-prefix offsets while primary chunks are pending', async () => {
        const store = new TermContentOpfsStore();
        /** @type {(value: Uint8Array[]) => void} */
        let resolvePrimary = () => {};
        const primaryChunks = new Promise((resolve) => { resolvePrimary = resolve; });
        const operation = store.beginAppendBatchWithDerivedPrefix(
            primaryChunks,
            new Uint32Array([2, 3]),
            (offsets, lengths) => [
                new Uint8Array([offsets[0], lengths[0]]),
                new Uint8Array([offsets[1], lengths[1], 9]),
            ],
        );

        await expect(operation.reserved).resolves.toStrictEqual({
            derivedOffsets: [0, 2],
            derivedLengths: [2, 3],
        });
        expect(Reflect.get(store, '_length')).toBe(0);
        resolvePrimary([new Uint8Array([1, 2]), new Uint8Array([3])]);
        await expect(operation.completion).resolves.toStrictEqual({
            primaryOffsets: [5, 7],
            primaryLengths: [2, 1],
            derivedOffsets: [0, 2],
            derivedLengths: [2, 3],
        });
        expect(await store.readSlice(0, 8)).toStrictEqual(new Uint8Array([5, 2, 7, 1, 9, 1, 2, 3]));
    });

    test('releases a derived-prefix reservation after primary production fails', async () => {
        const store = new TermContentOpfsStore();
        const operation = store.beginAppendBatchWithDerivedPrefix(
            Promise.reject(new Error('injected compression failure')),
            [4],
            () => [new Uint8Array(4)],
        );

        await expect(operation.reserved).resolves.toStrictEqual({derivedOffsets: [0], derivedLengths: [4]});
        await expect(operation.completion).rejects.toThrow('injected compression failure');
        expect(Reflect.get(store, '_length')).toBe(0);
        await expect(store.appendBatch([new Uint8Array([1])])).resolves.toStrictEqual([{offset: 0, length: 1}]);
    });

    test('releases a derived-prefix reservation after reference construction fails', async () => {
        const store = new TermContentOpfsStore();
        const operation = store.beginAppendBatchWithDerivedPrefix(
            Promise.resolve([new Uint8Array([1, 2])]),
            [4],
            () => { throw new Error('injected reference construction failure'); },
        );

        await expect(operation.reserved).resolves.toStrictEqual({derivedOffsets: [0], derivedLengths: [4]});
        await expect(operation.completion).rejects.toThrow('injected reference construction failure');
        expect(Reflect.get(store, '_length')).toBe(0);
        await expect(store.appendBatch([new Uint8Array([3])])).resolves.toStrictEqual([{offset: 0, length: 1}]);
    });

    test('writes coalesced Blob data continuously across file segments', async () => {
        const maxSegmentBytes = 128 * 1024 * 1024;
        const firstWritable = {write: vi.fn(async () => {}), close: vi.fn(async () => {})};
        const secondWritable = {write: vi.fn(async () => {}), close: vi.fn(async () => {}), seek: vi.fn(async () => {})};
        const firstFileHandle = {createWritable: vi.fn(async () => firstWritable)};
        const secondFileHandle = {
            createWritable: vi.fn(async () => secondWritable),
            getFile: vi.fn(async () => ({size: 0})),
        };
        vi.stubGlobal('navigator', {
            storage: {
                getDirectory: vi.fn(async () => ({
                    getFileHandle: vi.fn(async () => secondFileHandle),
                })),
            },
        });

        const store = new TermContentOpfsStore();
        Reflect.set(store, '_writable', firstWritable);
        Reflect.set(store, '_fileHandle', firstFileHandle);
        Reflect.set(store, '_length', maxSegmentBytes - 2);
        Reflect.set(store, '_segmentStates', [{
            index: 0,
            fileName: 'manabitan-term-content.bin',
            fileHandle: firstFileHandle,
            fileLength: maxSegmentBytes - 2,
            startOffset: 0,
            readFile: null,
        }]);

        await Reflect.get(store, '_writeDataToActiveSegments').call(store, new Blob([new Uint8Array([1, 2, 3, 4])]));

        expect(firstWritable.write).toHaveBeenCalledTimes(1);
        expect(Reflect.get(firstWritable.write.mock.calls[0][0], 'size')).toBe(2);
        expect(secondWritable.write).toHaveBeenCalledTimes(1);
        expect(Reflect.get(secondWritable.write.mock.calls[0][0], 'size')).toBe(2);
        expect(Reflect.get(store, '_segmentStates')).toHaveLength(2);
        expect(Reflect.get(store, '_length')).toBe(maxSegmentBytes + 2);
    });

    test('reopens and retries a Blob write when Chromium closes the stream', async () => {
        const closingError = new Error('Cannot write to a closed or closing stream');
        const firstWritable = {write: vi.fn(async () => { throw closingError; })};
        const recoveredWritable = {write: vi.fn(async () => {}), seek: vi.fn(async () => {})};
        const fileHandle = {createWritable: vi.fn(async () => recoveredWritable)};
        const store = new TermContentOpfsStore();
        Reflect.set(store, '_writable', firstWritable);
        Reflect.set(store, '_fileHandle', fileHandle);
        Reflect.set(store, '_segmentStates', [{
            index: 0,
            fileName: 'manabitan-term-content.bin',
            fileHandle,
            fileLength: 10,
            startOffset: 0,
            readFile: null,
        }]);

        await Reflect.get(store, '_writeDataToActiveSegments').call(store, new Blob([new Uint8Array([1, 2, 3])]));

        expect(fileHandle.createWritable).toHaveBeenCalledTimes(1);
        expect(recoveredWritable.seek).toHaveBeenCalledWith(10);
        expect(recoveredWritable.write).toHaveBeenCalledTimes(1);
        expect(Reflect.get(store, '_length')).toBe(13);
    });

    test('reads the pre-import snapshot without waiting for queued append writes', async () => {
        const initialBytes = new Uint8Array([1, 2, 3, 4]);
        const store = new TermContentOpfsStore();
        /** @type {(() => void)|null} */
        let releaseWrite = null;
        const writeStarted = new Promise((resolve) => {
            const writable = {
                seek: vi.fn(async () => {}),
                close: vi.fn(async () => {}),
                write: vi.fn(async () => {
                    resolve(void 0);
                    await new Promise((writeResolve) => {
                        releaseWrite = writeResolve;
                    });
                }),
            };
            const fileHandle = {
                createWritable: vi.fn(async () => writable),
                getFile: vi.fn(async () => createReadableFile(initialBytes)),
            };
            Reflect.set(store, '_fileHandle', fileHandle);
            Reflect.set(store, '_segmentStates', [{
                index: 0,
                fileName: 'manabitan-term-content.bin',
                fileHandle,
                fileLength: initialBytes.byteLength,
                startOffset: 0,
                readFile: createReadableFile(initialBytes),
            }]);
            Reflect.set(store, '_loadedForRead', true);
            Reflect.set(store, '_length', initialBytes.byteLength);
            Reflect.set(store, '_importSessionActive', true);
            Reflect.set(store, '_flushThresholdBytes', 1);
            store.setQueueImportWritesEnabled(true);
        });

        await store.appendBatch([new Uint8Array([5, 6]), new Uint8Array([7, 8])]);
        await writeStarted;

        await expect(store.readSlice(1, 2)).resolves.toStrictEqual(new Uint8Array([2, 3]));
        await expect(store.readSlice(4, 4)).resolves.toStrictEqual(new Uint8Array([5, 6, 7, 8]));
        expect(Reflect.get(store, '_loadedForRead')).toBe(true);
        expect(store.getDebugState()).toMatchObject({
            importReadOverlayChunkCount: 2,
            importReadOverlayBytes: 4,
        });

        releaseWrite?.();
        await store.endImportSession();
        expect(Reflect.get(store, '_loadedForRead')).toBe(false);
        expect(store.getDebugState()).toMatchObject({
            importReadOverlayChunkCount: 0,
            importReadOverlayBytes: 0,
        });
    });

    test('import append offsets include bytes in active queued writes', async () => {
        const store = new TermContentOpfsStore();
        /** @type {(() => void)|null} */
        let releaseWrite = null;
        let writeCount = 0;
        const writeStarted = new Promise((resolve) => {
            const writable = {
                seek: vi.fn(async () => {}),
                close: vi.fn(async () => {}),
                write: vi.fn(async () => {
                    ++writeCount;
                    if (writeCount === 1) {
                        resolve(void 0);
                        await new Promise((writeResolve) => {
                            releaseWrite = writeResolve;
                        });
                    }
                }),
            };
            const fileHandle = {
                createWritable: vi.fn(async () => writable),
                getFile: vi.fn(async () => createReadableFile(new Uint8Array(0))),
            };
            Reflect.set(store, '_fileHandle', fileHandle);
            Reflect.set(store, '_segmentStates', [{
                index: 0,
                fileName: 'manabitan-term-content.bin',
                fileHandle,
                fileLength: 0,
                startOffset: 0,
                readFile: null,
            }]);
            Reflect.set(store, '_importSessionActive', true);
            Reflect.set(store, '_flushThresholdBytes', 1);
            store.setQueueImportWritesEnabled(true);
        });

        /** @type {number[]} */
        const firstOffsets = [];
        /** @type {number[]} */
        const firstLengths = [];
        await store.appendBatchToArrays([new Uint8Array([1, 2, 3])], firstOffsets, firstLengths);
        await writeStarted;

        /** @type {number[]} */
        const secondOffsets = [];
        /** @type {number[]} */
        const secondLengths = [];
        await store.appendBatchToArrays([new Uint8Array([4, 5])], secondOffsets, secondLengths);

        expect(firstOffsets).toStrictEqual([0]);
        expect(firstLengths).toStrictEqual([3]);
        expect(secondOffsets).toStrictEqual([3]);
        expect(secondLengths).toStrictEqual([2]);

        releaseWrite?.();
        await store.endImportSession();
    });

    test('readSlice recovers after transient NotReadableError and returns bytes', async () => {
        const bytes = new Uint8Array([11, 12, 13, 14, 15, 16]);
        const store = new TermContentOpfsStore();
        const readableFile = createReadableFile(bytes);
        const fileHandle = {
            getFile: vi.fn(async () => readableFile),
        };
        const unreadableFile = {
            size: bytes.byteLength,
            slice() {
                return {
                    async arrayBuffer() {
                        throw createNotReadableError();
                    },
                };
            },
        };
        Reflect.set(store, '_fileHandle', fileHandle);
        Reflect.set(store, '_readFile', unreadableFile);
        Reflect.set(store, '_segmentStates', [{
            index: 0,
            fileName: 'manabitan-term-content.bin',
            fileHandle,
            fileLength: bytes.byteLength,
            startOffset: 0,
            readFile: unreadableFile,
        }]);
        Reflect.set(store, '_loadedForRead', true);
        Reflect.set(store, '_length', bytes.byteLength);

        const result = await store.readSlice(1, 4);

        expect(result).toStrictEqual(new Uint8Array([12, 13, 14, 15]));
        expect(fileHandle.getFile).toHaveBeenCalledTimes(1);
    });

    test('readSlice returns null (without throwing) when NotReadableError is persistent', async () => {
        const bytes = new Uint8Array([1, 2, 3, 4]);
        const store = new TermContentOpfsStore();
        const fileHandle = {
            getFile: vi.fn(async () => {
                throw createNotReadableError('still unreadable');
            }),
        };
        const unreadableFile = {
            size: bytes.byteLength,
            slice() {
                return {
                    async arrayBuffer() {
                        throw createNotReadableError('unreadable on slice');
                    },
                };
            },
        };
        Reflect.set(store, '_fileHandle', fileHandle);
        Reflect.set(store, '_readFile', unreadableFile);
        Reflect.set(store, '_segmentStates', [{
            index: 0,
            fileName: 'manabitan-term-content.bin',
            fileHandle,
            fileLength: bytes.byteLength,
            startOffset: 0,
            readFile: unreadableFile,
        }]);
        Reflect.set(store, '_loadedForRead', true);
        Reflect.set(store, '_length', bytes.byteLength);

        const result = await store.readSlice(0, bytes.byteLength);

        expect(result).toBeNull();
        expect(fileHandle.getFile).toHaveBeenCalledTimes(2);
    });
});
