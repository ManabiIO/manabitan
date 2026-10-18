/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {deflateRawSync} from 'node:zlib';
import {afterEach, describe, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';

afterEach(() => { vi.unstubAllGlobals(); });

/**
 * @param {DictionaryDatabase} database
 * @param {Record<string, unknown>} row
 * @returns {Promise<{content: ArrayBuffer}>}
 */
async function deserialize(database, row) {
    const deserializeMediaRow = /** @type {(this: DictionaryDatabase, row: Record<string, unknown>) => Promise<{content: ArrayBuffer}>} */ (
        Reflect.get(database, '_deserializeMediaRow')
    );
    return await deserializeMediaRow.call(database, row);
}

describe('DictionaryDatabase media deserialization', () => {
    test('returns an empty media payload instead of throwing when external content is unreadable', async () => {
        const database = new DictionaryDatabase();
        Reflect.set(database, '_termContentStore', {
            readSlice: vi.fn().mockResolvedValue(null),
        });

        const deserializeMediaRow = /** @type {(this: DictionaryDatabase, row: Record<string, unknown>) => Promise<{content: ArrayBuffer}>} */ (
            Reflect.get(database, '_deserializeMediaRow')
        );
        const result = await deserializeMediaRow.call(database, {
            dictionary: 'media-test',
            path: 'missing.png',
            mediaType: 'image/png',
            width: 16,
            height: 16,
            content: new Uint8Array(0),
            contentOffset: 128,
            contentLength: 64,
            contentCompressionMethod: 0,
            contentUncompressedLength: 0,
        });

        expect(result.content).toBeInstanceOf(ArrayBuffer);
        expect(result.content.byteLength).toBe(0);
        expect(Reflect.get(database, '_termContentStore').readSlice).toHaveBeenCalledWith(128, 64);
    });

    test('returns an empty media payload instead of throwing when external content read fails', async () => {
        const database = new DictionaryDatabase();
        Reflect.set(database, '_termContentStore', {
            readSlice: vi.fn().mockRejectedValue(new Error('media read failed')),
        });

        const deserializeMediaRow = /** @type {(this: DictionaryDatabase, row: Record<string, unknown>) => Promise<{content: ArrayBuffer}>} */ (
            Reflect.get(database, '_deserializeMediaRow')
        );
        const result = await deserializeMediaRow.call(database, {
            dictionary: 'media-test',
            path: 'broken.png',
            mediaType: 'image/png',
            width: 16,
            height: 16,
            content: new Uint8Array(0),
            contentOffset: 256,
            contentLength: 32,
            contentCompressionMethod: 0,
            contentUncompressedLength: 0,
        });

        expect(result.content).toBeInstanceOf(ArrayBuffer);
        expect(result.content.byteLength).toBe(0);
        expect(Reflect.get(database, '_termContentStore').readSlice).toHaveBeenCalledWith(256, 32);
    });
});


describe('DictionaryDatabase compressed external media', () => {
    test('inflates valid raw deflate media to the declared exact length', async () => {
        const payload = Uint8Array.from({length: 8192}, (_, index) => (index * 73) & 255);
        const compressed = new Uint8Array(deflateRawSync(payload));
        const database = new DictionaryDatabase();
        Reflect.set(database, '_termContentStore', {
            readSlice: vi.fn().mockResolvedValue(compressed),
        });

        const result = await deserialize(database, {
            dictionary: 'media-test',
            path: 'compressed.png',
            mediaType: 'image/png',
            width: 16,
            height: 16,
            content: new Uint8Array(0),
            contentOffset: 512,
            contentLength: compressed.byteLength,
            contentCompressionMethod: 8,
            contentUncompressedLength: payload.byteLength,
        });

        expect(new Uint8Array(result.content)).toEqual(payload);
    });

    test('stops retaining decoded output as soon as it exceeds the declared length', async () => {
        let pullCount = 0;
        /** @type {unknown} */
        let cancelReason = null;
        class ControlledDecompressionStream {
            constructor() {
                this.writable = new WritableStream();
                this.readable = new ReadableStream({
                    pull(controller) {
                        ++pullCount;
                        switch (pullCount) {
                            case 1:
                            case 2:
                                controller.enqueue(new Uint8Array(6));
                                break;
                            case 3:
                                controller.enqueue(new Uint8Array(4096));
                                break;
                            default:
                                controller.close();
                                break;
                        }
                    },
                    cancel(reason) {
                        cancelReason = reason;
                    },
                }, {highWaterMark: 0});
            }
        }
        vi.stubGlobal('DecompressionStream', ControlledDecompressionStream);

        const database = new DictionaryDatabase();
        Reflect.set(database, '_termContentStore', {
            readSlice: vi.fn().mockResolvedValue(new Uint8Array([1])),
        });
        const result = await deserialize(database, {
            dictionary: 'media-test',
            path: 'bomb.png',
            mediaType: 'image/png',
            width: 16,
            height: 16,
            content: new Uint8Array(0),
            contentOffset: 1024,
            contentLength: 1,
            contentCompressionMethod: 8,
            contentUncompressedLength: 10,
        });

        expect(result.content.byteLength).toBe(0);
        expect(pullCount).toBe(2);
        expect(cancelReason).toBeInstanceOf(RangeError);
    });

    test('rejects decoded media that ends before the declared exact length', async () => {
        class ShortDecompressionStream {
            constructor() {
                this.writable = new WritableStream();
                this.readable = new ReadableStream({
                    start(controller) {
                        controller.enqueue(new Uint8Array(4));
                        controller.close();
                    },
                });
            }
        }
        vi.stubGlobal('DecompressionStream', ShortDecompressionStream);

        const database = new DictionaryDatabase();
        Reflect.set(database, '_termContentStore', {
            readSlice: vi.fn().mockResolvedValue(new Uint8Array([1])),
        });
        const result = await deserialize(database, {
            dictionary: 'media-test',
            path: 'short.png',
            mediaType: 'image/png',
            width: 16,
            height: 16,
            content: new Uint8Array(0),
            contentOffset: 1536,
            contentLength: 1,
            contentCompressionMethod: 8,
            contentUncompressedLength: 5,
        });

        expect(result.content.byteLength).toBe(0);
    });

    test('rejects an unsafe decoded-length descriptor before starting decompression', async () => {
        const constructorSpy = vi.fn();
        class UnexpectedDecompressionStream {
            constructor() {
                constructorSpy();
                this.writable = new WritableStream();
                this.readable = new ReadableStream();
            }
        }
        vi.stubGlobal('DecompressionStream', UnexpectedDecompressionStream);

        const database = new DictionaryDatabase();
        Reflect.set(database, '_termContentStore', {
            readSlice: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
        });
        const result = await deserialize(database, {
            dictionary: 'media-test',
            path: 'unsafe.png',
            mediaType: 'image/png',
            width: 16,
            height: 16,
            content: new Uint8Array(0),
            contentOffset: 2048,
            contentLength: 3,
            contentCompressionMethod: 8,
            contentUncompressedLength: '9007199254740992',
        });

        expect(result.content.byteLength).toBe(0);
        expect(constructorSpy).not.toHaveBeenCalled();
    });
});
