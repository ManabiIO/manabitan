/*
 * Copyright (C) 2026 Manabitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, test, vi} from 'vitest';
import {ByteBoundedLruCache, TermContentBlockImportSession, TermContentBlockStore} from '../ext/js/dictionary/term-content-block-store.js';
import {TermContentOpfsStore} from '../ext/js/dictionary/term-content-opfs-store.js';
import {encodeRawTermContentBlockReference} from '../ext/js/dictionary/raw-term-content.js';
import {compressTermContentZstdBatch} from '../ext/js/dictionary/zstd-term-content.js';

vi.mock('../ext/js/dictionary/zstd-term-content.js', () => ({
    compressTermContentZstd: (bytes) => Uint8Array.from(bytes),
    compressTermContentZstdBatch: vi.fn(async (chunks) => chunks.map((bytes) => Uint8Array.from(bytes))),
    decompressTermContentZstd: (bytes) => Uint8Array.from(bytes),
}));

describe('ByteBoundedLruCache', () => {
    test('evicts least-recently-used blocks by bytes', () => {
        const cache = new ByteBoundedLruCache(6);
        cache.set('a', new Uint8Array(3));
        cache.set('b', new Uint8Array(3));
        expect(cache.get('a')).toBeInstanceOf(Uint8Array);

        cache.set('c', new Uint8Array(3));

        expect(cache.get('b')).toBeUndefined();
        expect(cache.get('a')).toBeInstanceOf(Uint8Array);
        expect(cache.get('c')).toBeInstanceOf(Uint8Array);
        expect(cache.bytes).toBe(6);
    });

    test('does not cache a block larger than the budget', () => {
        const cache = new ByteBoundedLruCache(2);
        cache.set('large', new Uint8Array(3));
        expect(cache.size).toBe(0);
        expect(cache.bytes).toBe(0);
    });
});

describe('TermContentBlockImportSession', () => {
    test('forces block mode only after that dictionary selected it', async () => {
        const tryAppend = vi.fn()
            .mockResolvedValueOnce({contentOffsets: [], contentLengths: [], contentDictName: 'raw-block-v1'})
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);
        const session = new TermContentBlockImportSession({tryAppend});

        await session.append('A', [], null);
        await session.append('A', [], null);
        await session.append('B', [], null);

        expect(tryAppend.mock.calls.map((call) => call[2])).toStrictEqual([false, true, false]);
    });

    test('rejects writes after close', async () => {
        const session = new TermContentBlockImportSession({tryAppend: vi.fn()});
        session.close();
        await expect(session.append('A', [], null)).rejects.toThrow('closed');
    });

    test('tracks forced block mode for shared-slab appends', async () => {
        const tryAppendSpans = vi.fn()
            .mockResolvedValueOnce({contentOffsets: [], contentLengths: [], contentDictName: 'raw-block-v1'})
            .mockResolvedValueOnce(null);
        const session = new TermContentBlockImportSession({tryAppendSpans});
        const source = new Uint8Array([1]);
        const offsets = new Uint32Array([0]);
        const lengths = new Uint32Array([1]);

        await session.appendSpans('A', source, offsets, lengths, null);
        await session.appendSpans('A', source, offsets, lengths, null);

        expect(tryAppendSpans.mock.calls.map((call) => call[4])).toStrictEqual([false, true]);
    });
});

describe('TermContentBlockStore', () => {
    test('atomically appends blocks and reads each logical entry', async () => {
        const contentStore = new TermContentOpfsStore();
        const blockStore = new TermContentBlockStore(contentStore, {
            blockTargetBytes: 5,
            referencePackTargetBytes: 56,
            minInputBytes: 0,
        });
        const content = [
            new Uint8Array([1, 2, 3]),
            new Uint8Array([4, 5]),
            new Uint8Array([6, 7, 8, 9]),
        ];

        const result = await blockStore.tryAppend(content, null, true);

        expect(result).not.toBeNull();
        for (let i = 0; i < content.length; ++i) {
            expect(await blockStore.read(
                result.contentOffsets[i],
                result.contentLengths[i],
                result.contentDictName,
            )).toStrictEqual(content[i]);
        }
        expect(blockStore.getDiagnostics()).toMatchObject({cacheEntries: 2, cacheBytes: 9});
    });

    test('appends logical entries directly from a shared byte slab', async () => {
        const contentStore = new TermContentOpfsStore();
        const blockStore = new TermContentBlockStore(contentStore, {
            blockTargetBytes: 5,
            referencePackTargetBytes: 56,
            minInputBytes: 0,
        });
        const source = new Uint8Array([99, 1, 2, 3, 88, 4, 5, 77, 6, 7, 8, 9]);
        const offsets = new Uint32Array([1, 5, 8]);
        const lengths = new Uint32Array([3, 2, 4]);

        const result = await blockStore.tryAppendSpans(source, offsets, lengths, null, true);

        expect(result).not.toBeNull();
        expect(await blockStore.read(
            result.contentOffsets[0],
            result.contentLengths[0],
            result.contentDictName,
        )).toStrictEqual(new Uint8Array([1, 2, 3]));
        expect(await blockStore.read(
            result.contentOffsets[1],
            result.contentLengths[1],
            result.contentDictName,
        )).toStrictEqual(new Uint8Array([4, 5]));
        expect(await blockStore.read(
            result.contentOffsets[2],
            result.contentLengths[2],
            result.contentDictName,
        )).toStrictEqual(new Uint8Array([6, 7, 8, 9]));
    });

    test('rejects invalid shared-slab spans before writing', async () => {
        const blockStore = new TermContentBlockStore(new TermContentOpfsStore(), {minInputBytes: 0});

        await expect(blockStore.tryAppendSpans(
            new Uint8Array([1, 2, 3]),
            new Uint32Array([2]),
            new Uint32Array([2]),
            null,
            true,
        )).rejects.toThrow('out of bounds');
    });

    test('repacks shared-slab input after parallel compression detaches output', async () => {
        vi.mocked(compressTermContentZstdBatch).mockImplementationOnce(async (chunks) => {
            for (const chunk of chunks) {
                structuredClone(chunk, {transfer: [chunk.buffer]});
            }
            throw new Error('injected worker failure');
        });
        const contentStore = new TermContentOpfsStore();
        const blockStore = new TermContentBlockStore(contentStore, {
            blockTargetBytes: 3,
            referencePackTargetBytes: 56,
            minInputBytes: 0,
        });
        const source = new Uint8Array([1, 2, 3, 4, 5, 6]);

        const result = await blockStore.tryAppendSpans(
            source,
            new Uint32Array([0, 3]),
            new Uint32Array([3, 3]),
            null,
            true,
        );

        expect(result).not.toBeNull();
        expect(await blockStore.read(
            result.contentOffsets[0],
            result.contentLengths[0],
            result.contentDictName,
        )).toStrictEqual(new Uint8Array([1, 2, 3]));
        expect(await blockStore.read(
            result.contentOffsets[1],
            result.contentLengths[1],
            result.contentDictName,
        )).toStrictEqual(new Uint8Array([4, 5, 6]));
    });

    test('falls back when batch compression returns an incomplete result', async () => {
        vi.mocked(compressTermContentZstdBatch).mockResolvedValueOnce([]);
        const contentStore = new TermContentOpfsStore();
        const blockStore = new TermContentBlockStore(contentStore, {
            blockTargetBytes: 3,
            referencePackTargetBytes: 56,
            minInputBytes: 0,
        });
        const source = new Uint8Array([1, 2, 3, 4, 5, 6]);

        const result = await blockStore.tryAppendSpans(
            source,
            new Uint32Array([0, 3]),
            new Uint32Array([3, 3]),
            null,
            true,
        );

        expect(result).not.toBeNull();
        expect(await blockStore.read(
            result.contentOffsets[0],
            result.contentLengths[0],
            result.contentDictName,
        )).toStrictEqual(new Uint8Array([1, 2, 3]));
        expect(await blockStore.read(
            result.contentOffsets[1],
            result.contentLengths[1],
            result.contentDictName,
        )).toStrictEqual(new Uint8Array([4, 5, 6]));
    });

    test('repacks detached slabs and falls back after parallel compression fails', async () => {
        vi.mocked(compressTermContentZstdBatch).mockImplementationOnce(async (chunks) => {
            for (const chunk of chunks) {
                structuredClone(chunk, {transfer: [chunk.buffer]});
            }
            throw new Error('injected worker failure');
        });
        const contentStore = new TermContentOpfsStore();
        const blockStore = new TermContentBlockStore(contentStore, {
            blockTargetBytes: 3,
            referencePackTargetBytes: 56,
            minInputBytes: 0,
        });
        const content = [
            new Uint8Array([1, 2, 3]),
            new Uint8Array([4, 5, 6]),
        ];

        const result = await blockStore.tryAppend(content, null, true);

        expect(result).not.toBeNull();
        expect(await blockStore.read(
            result.contentOffsets[0],
            result.contentLengths[0],
            result.contentDictName,
        )).toStrictEqual(content[0]);
        expect(await blockStore.read(
            result.contentOffsets[1],
            result.contentLengths[1],
            result.contentDictName,
        )).toStrictEqual(content[1]);
    });

    test('coalesces concurrent reads of entries in the same block', async () => {
        const contentStore = new TermContentOpfsStore();
        const blockStore = new TermContentBlockStore(contentStore, {
            blockTargetBytes: 1024,
            referencePackTargetBytes: 1024,
            minInputBytes: 0,
        });
        const result = await blockStore.tryAppend([
            new Uint8Array([1, 2, 3]),
            new Uint8Array([4, 5, 6]),
        ], null, true);
        expect(result).not.toBeNull();
        blockStore.clearCache();
        const readSlice = vi.spyOn(contentStore, 'readSlice');

        const values = await Promise.all(result.contentOffsets.map((offset, index) => blockStore.read(
            offset,
            result.contentLengths[index],
            result.contentDictName,
        )));

        expect(values).toStrictEqual([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]);
        // Two reference reads and one shared compressed-block read.
        expect(readSlice).toHaveBeenCalledTimes(3);
        expect(blockStore.getDiagnostics()).toMatchObject({inFlightBlocks: 0});
    });

    test('rejects a reference whose entry extends beyond its block', async () => {
        const contentStore = new TermContentOpfsStore();
        await contentStore.appendBatch([new Uint8Array([1, 2, 3])]);
        const [{offset: referenceOffset}] = await contentStore.appendBatch([
            encodeRawTermContentBlockReference(0, 3, 3, 2, 2),
        ]);
        const blockStore = new TermContentBlockStore(contentStore);

        expect(await blockStore.read(referenceOffset, 2, 'raw-block-v1')).toBeNull();
        expect(blockStore.getDiagnostics().lastError).toMatchObject({
            contentOffset: referenceOffset,
            contentLength: 2,
            decodedEntryLength: null,
        });
    });

    test('does not reuse a cached block for a conflicting uncompressed length', async () => {
        const contentStore = new TermContentOpfsStore();
        await contentStore.appendBatch([new Uint8Array([1, 2, 3])]);
        const references = await contentStore.appendBatch([
            encodeRawTermContentBlockReference(0, 3, 3, 0, 3),
            encodeRawTermContentBlockReference(0, 3, 4, 0, 3),
        ]);
        const blockStore = new TermContentBlockStore(contentStore);

        expect(await blockStore.read(references[0].offset, 3, 'raw-block-v1')).toStrictEqual(new Uint8Array([1, 2, 3]));
        expect(await blockStore.read(references[1].offset, 3, 'raw-block-v1')).toBeNull();
        expect(blockStore.getDiagnostics().lastError).toMatchObject({
            blockOffset: 0,
            expectedLength: 4,
            actualLength: 3,
        });
    });
});
