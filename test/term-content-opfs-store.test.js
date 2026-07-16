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

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('TermContentOpfsStore', () => {
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

        await store.appendBatch([new Uint8Array([5, 6])]);
        await writeStarted;

        await expect(store.readSlice(1, 2)).resolves.toStrictEqual(new Uint8Array([2, 3]));
        expect(Reflect.get(store, '_loadedForRead')).toBe(true);

        releaseWrite?.();
        await store.endImportSession();
        expect(Reflect.get(store, '_loadedForRead')).toBe(false);
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
