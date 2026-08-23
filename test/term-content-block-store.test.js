/*
 * Copyright (C) 2026 Manabitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, test, vi} from 'vitest';
import {ByteBoundedLruCache, TermContentBlockImportSession, TermContentBlockStore, wrapCompressedTermContentBlock} from '../ext/js/dictionary/term-content-block-store.js';
import {TERM_CONTENT_BLOCK_ENVELOPE_BYTES, writeCompressedTermContentBlockEnvelope} from '../ext/js/dictionary/term-content-block-envelope.js';
import {TermContentOpfsStore} from '../ext/js/dictionary/term-content-opfs-store.js';
import {encodeRawTermContentBlockReference} from '../ext/js/dictionary/raw-term-content.js';
import {compressWrappedTermContentZstdBatch, compressWrappedTermContentZstdSpansBatch, decompressTermContentZstd} from '../ext/js/dictionary/zstd-term-content.js';

vi.mock('../ext/js/dictionary/zstd-term-content.js', () => ({
    compressTermContentZstd: (bytes) => Uint8Array.from(bytes),
    compressWrappedTermContentZstdBatch: vi.fn(async (chunks) => ({
        chunks: chunks.map((bytes) => Uint8Array.from(bytes)),
        envelopeMs: 0,
        wrapped: false,
    })),
    compressWrappedTermContentZstdSpansBatch: vi.fn(async (source, offsets, lengths, blockStarts, blockLengths) => ({
        chunks: Array.from(blockLengths, (blockLength, blockIndex) => {
            const output = new Uint8Array(blockLength);
            let outputOffset = 0;
            for (let i = blockStarts[blockIndex]; i < blockStarts[blockIndex + 1]; ++i) {
                output.set(source.subarray(offsets[i], offsets[i] + lengths[i]), outputOffset);
                outputOffset += lengths[i];
            }
            return output;
        }),
        envelopeMs: 0,
        wrapped: false,
    })),
    decompressTermContentZstd: vi.fn((bytes) => Uint8Array.from(bytes)),
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

    test('retries early shared-slab selection after block mode is selected', async () => {
        const storage = {
            contentOffsets: new Float64Array(0),
            contentLengths: new Uint32Array(0),
            contentDictName: 'raw-block-v2:jmdict',
        };
        const operation = {
            storage: Promise.resolve(storage),
            completion: Promise.resolve({
                ...storage,
                compressedBytes: 0,
                uncompressedBytes: 0,
                packMs: 0,
                compressMs: 0,
                envelopeMs: 0,
                referenceMs: 0,
                opfsAppendMs: 0,
            }),
        };
        const tryAppendSpans = vi.fn().mockResolvedValue({contentOffsets: [], contentLengths: [], contentDictName: 'raw-block-v2'});
        const tryBeginAppendSpans = vi.fn()
            .mockReturnValueOnce(null)
            .mockReturnValue(operation);
        const session = new TermContentBlockImportSession({tryAppendSpans, tryBeginAppendSpans});
        const source = new Uint8Array(new SharedArrayBuffer(1));
        const offsets = new Uint32Array([0]);
        const lengths = new Uint32Array([1]);

        expect(session.tryBeginAppendSpans('A', source, offsets, lengths, 'jmdict')).toBeNull();
        await session.appendSpans('A', source, offsets, lengths, 'jmdict');
        expect(session.tryBeginAppendSpans('A', source, offsets, lengths, 'jmdict')).toMatchObject({
            ...operation,
            initialSelection: false,
        });
        expect(tryBeginAppendSpans.mock.calls.map((call) => call[4])).toStrictEqual([false, true]);
        expect(tryBeginAppendSpans).toHaveBeenCalledWith(source, offsets, lengths, 'jmdict', true);
    });

    test('keeps forcing blocks after source-driven early selection succeeds', () => {
        const operation = {
            storage: Promise.resolve({}),
            completion: Promise.resolve({}),
        };
        const tryBeginAppendSpans = vi.fn(() => operation);
        const session = new TermContentBlockImportSession({tryBeginAppendSpans});
        const source = new Uint8Array(new SharedArrayBuffer(1));
        const offsets = new Uint32Array([0]);
        const lengths = new Uint32Array([1]);

        expect(session.tryBeginAppendSpans('A', source, offsets, lengths, 'jmdict')).toMatchObject({
            ...operation,
            initialSelection: true,
        });
        expect(session.tryBeginAppendSpans('A', source, offsets, lengths, 'jmdict')).toMatchObject({
            ...operation,
            initialSelection: false,
        });
        expect(tryBeginAppendSpans.mock.calls.map((call) => call[4])).toStrictEqual([false, true]);
    });
});

describe('TermContentBlockStore', () => {
    test('finishes a reserved checksum envelope without replacing its buffer', () => {
        const output = new Uint8Array(TERM_CONTENT_BLOCK_ENVELOPE_BYTES + 4);
        output.set([1, 2, 3, 4], TERM_CONTENT_BLOCK_ENVELOPE_BYTES);
        const buffer = output.buffer;

        writeCompressedTermContentBlockEnvelope(output);

        expect(output.buffer).toBe(buffer);
        expect(output).toStrictEqual(wrapCompressedTermContentBlock(new Uint8Array([1, 2, 3, 4])));
    });

    test('validates and reports runtime block-target changes', () => {
        const blockStore = new TermContentBlockStore(new TermContentOpfsStore());

        blockStore.setBlockTargetBytes(2 * 1024 * 1024);

        expect(blockStore.getDiagnostics()).toMatchObject({blockTargetBytes: 2 * 1024 * 1024});
        expect(() => blockStore.setBlockTargetBytes(0)).toThrow(RangeError);
        expect(() => blockStore.setBlockTargetBytes(1.5)).toThrow(RangeError);
    });

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
        expect(result.contentOffsets).toStrictEqual(new Float64Array([33, 53, 73]));
        expect(result.contentLengths).toBeInstanceOf(Uint32Array);
        expect(result.contentDictName).toBe('raw-block-v2');
        // Two 12-byte integrity envelopes plus nine payload bytes and three references.
        expect(Reflect.get(contentStore, '_length')).toBe(93);
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

    test('compresses shared parser spans without a main-thread packing copy', async () => {
        vi.mocked(compressWrappedTermContentZstdSpansBatch).mockClear();
        const contentStore = new TermContentOpfsStore();
        const blockStore = new TermContentBlockStore(contentStore, {
            blockTargetBytes: 5,
            referencePackTargetBytes: 56,
            minInputBytes: 0,
        });
        const source = new Uint8Array(new SharedArrayBuffer(12));
        source.set([99, 1, 2, 3, 88, 4, 5, 77, 6, 7, 8, 9]);
        const offsets = new Uint32Array([1, 5, 8]);
        const lengths = new Uint32Array([3, 2, 4]);

        const result = await blockStore.tryAppendSpans(source, offsets, lengths, 'jmdict', true);

        expect(compressWrappedTermContentZstdSpansBatch).toHaveBeenCalledOnce();
        expect(result).not.toBeNull();
        for (let i = 0; i < lengths.length; ++i) {
            expect(await blockStore.read(
                result.contentOffsets[i],
                result.contentLengths[i],
                result.contentDictName,
            )).toStrictEqual(source.slice(offsets[i], offsets[i] + lengths[i]));
        }
    });

    test('reserves the first sufficiently compressible shared slab', async () => {
        const blockStore = new TermContentBlockStore(new TermContentOpfsStore(), {
            blockTargetBytes: 512,
            referencePackTargetBytes: 56,
            minInputBytes: 512,
        });
        const source = new Uint8Array(new SharedArrayBuffer(1024));
        source.fill(7);
        const offsets = new Uint32Array([0, 256, 512, 768]);
        const lengths = new Uint32Array([256, 256, 256, 256]);

        const operation = blockStore.tryBeginAppendSpans(source, offsets, lengths, 'jmdict');
        if (operation === null) { throw new Error('Expected source-driven early block selection'); }
        const storage = await operation.storage;
        const completion = await operation.completion;

        expect(storage.contentOffsets).toStrictEqual(new Float64Array([0, 20, 40, 60]));
        // The identity compression mock intentionally misses the real Zstd
        // savings target, which must remain observable rather than silent.
        expect(completion.initialSelectionSavingsMiss).toBe(true);
        expect(await blockStore.read(
            storage.contentOffsets[2],
            storage.contentLengths[2],
            storage.contentDictName,
        )).toStrictEqual(source.slice(512, 768));
    });

    test('does not reserve an incompressible first slab or sample unused capacity', () => {
        vi.mocked(compressWrappedTermContentZstdSpansBatch).mockClear();
        const blockStore = new TermContentBlockStore(new TermContentOpfsStore(), {
            minInputBytes: 512,
        });
        const source = new Uint8Array(new SharedArrayBuffer(8192));
        for (let i = 4096; i < source.length; ++i) {
            source[i] = i & 0xff;
        }

        expect(blockStore.tryBeginAppendSpans(
            source,
            new Uint32Array([4096]),
            new Uint32Array([4096]),
            'jmdict',
        )).toBeNull();
        expect(compressWrappedTermContentZstdSpansBatch).not.toHaveBeenCalled();
    });

    test('does not reserve a first slab below the measured-savings input floor', () => {
        const blockStore = new TermContentBlockStore(new TermContentOpfsStore(), {
            minInputBytes: 1024,
        });
        const source = new Uint8Array(new SharedArrayBuffer(512));

        expect(blockStore.tryBeginAppendSpans(
            source,
            new Uint32Array([0]),
            new Uint32Array([512]),
            'jmdict',
        )).toBeNull();
    });

    test('publishes reserved references while shared compression is pending', async () => {
        /** @type {() => void} */
        let releaseCompression = () => {};
        vi.mocked(compressWrappedTermContentZstdSpansBatch).mockImplementationOnce(
            (source, offsets, lengths, blockStarts, blockLengths) => new Promise((resolve) => {
                releaseCompression = () => {
                    resolve({
                        chunks: Array.from(blockLengths, (blockLength, blockIndex) => {
                            const output = new Uint8Array(blockLength);
                            let outputOffset = 0;
                            for (let i = blockStarts[blockIndex]; i < blockStarts[blockIndex + 1]; ++i) {
                                output.set(source.subarray(offsets[i], offsets[i] + lengths[i]), outputOffset);
                                outputOffset += lengths[i];
                            }
                            return wrapCompressedTermContentBlock(output);
                        }),
                        envelopeMs: 0,
                        wrapped: true,
                    });
                };
            }),
        );
        const contentStore = new TermContentOpfsStore();
        const blockStore = new TermContentBlockStore(contentStore, {
            blockTargetBytes: 5,
            referencePackTargetBytes: 56,
            minInputBytes: 0,
        });
        const source = new Uint8Array(new SharedArrayBuffer(12));
        source.set([99, 1, 2, 3, 88, 4, 5, 77, 6, 7, 8, 9]);
        const offsets = new Uint32Array([1, 5, 8]);
        const lengths = new Uint32Array([3, 2, 4]);

        const operation = blockStore.tryBeginAppendSpans(source, offsets, lengths, 'jmdict', true);
        if (operation === null) { throw new Error('Expected an early block append operation'); }
        const storage = await operation.storage;
        expect(storage.contentOffsets).toStrictEqual(new Float64Array([0, 20, 40]));
        expect(Reflect.get(contentStore, '_length')).toBe(0);

        let competingAppendFinished = false;
        const competingAppend = contentStore.appendBatch([new Uint8Array([10])]).then((result) => {
            competingAppendFinished = true;
            return result;
        });
        await Promise.resolve();
        expect(competingAppendFinished).toBe(false);

        releaseCompression();
        await expect(operation.completion).resolves.toMatchObject({
            contentOffsets: new Float64Array([0, 20, 40]),
            contentDictName: 'raw-block-v2:jmdict',
        });
        await expect(competingAppend).resolves.toStrictEqual([{offset: 93, length: 1}]);
        for (let i = 0; i < lengths.length; ++i) {
            expect(await blockStore.read(
                storage.contentOffsets[i],
                storage.contentLengths[i],
                storage.contentDictName,
            )).toStrictEqual(source.slice(offsets[i], offsets[i] + lengths[i]));
        }
    });

    test('uses the reserved block plan after parallel shared compression fails', async () => {
        vi.mocked(compressWrappedTermContentZstdSpansBatch).mockRejectedValueOnce(
            new Error('injected reservation compression failure'),
        );
        const contentStore = new TermContentOpfsStore();
        const blockStore = new TermContentBlockStore(contentStore, {
            blockTargetBytes: 3,
            referencePackTargetBytes: 56,
            minInputBytes: 0,
        });
        const source = new Uint8Array(new SharedArrayBuffer(6));
        source.set([1, 2, 3, 4, 5, 6]);

        const operation = blockStore.tryBeginAppendSpans(
            source,
            new Uint32Array([0, 3]),
            new Uint32Array([3, 3]),
            'jmdict',
            true,
        );
        if (operation === null) { throw new Error('Expected an early block append operation'); }
        const storage = await operation.storage;
        await expect(operation.completion).resolves.toMatchObject({
            contentOffsets: new Float64Array([0, 20]),
        });
        expect(await blockStore.read(
            storage.contentOffsets[1],
            storage.contentLengths[1],
            storage.contentDictName,
        )).toStrictEqual(new Uint8Array([4, 5, 6]));
    });

    test('falls back to packed compression when shared-span dispatch fails', async () => {
        vi.mocked(compressWrappedTermContentZstdSpansBatch).mockRejectedValueOnce(new Error('injected span failure'));
        const blockStore = new TermContentBlockStore(new TermContentOpfsStore(), {
            blockTargetBytes: 5,
            referencePackTargetBytes: 56,
            minInputBytes: 0,
        });
        const source = new Uint8Array(new SharedArrayBuffer(5));
        source.set([1, 2, 3, 4, 5]);

        const result = await blockStore.tryAppendSpans(
            source,
            new Uint32Array([0, 3]),
            new Uint32Array([3, 2]),
            'jmdict',
            true,
        );

        expect(result).not.toBeNull();
        expect(await blockStore.read(
            result.contentOffsets[1],
            result.contentLengths[1],
            result.contentDictName,
        )).toStrictEqual(new Uint8Array([4, 5]));
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
        vi.mocked(compressWrappedTermContentZstdBatch).mockImplementationOnce(async (chunks) => {
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

    test('checksums compressed slabs after parallel compression detaches its input', async () => {
        vi.mocked(compressWrappedTermContentZstdBatch).mockImplementationOnce(async (chunks) => {
            const compressed = chunks.map((chunk) => Uint8Array.from(chunk));
            for (const chunk of chunks) {
                structuredClone(chunk, {transfer: [chunk.buffer]});
            }
            return {chunks: compressed, envelopeMs: 0, wrapped: false};
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

    test('stores worker-wrapped slabs without adding a second envelope', async () => {
        vi.mocked(compressWrappedTermContentZstdBatch).mockImplementationOnce(async (chunks) => ({
            chunks: chunks.map((chunk) => wrapCompressedTermContentBlock(chunk)),
            envelopeMs: 0.25,
            wrapped: true,
        }));
        const contentStore = new TermContentOpfsStore();
        const blockStore = new TermContentBlockStore(contentStore, {
            blockTargetBytes: 6,
            referencePackTargetBytes: 56,
            minInputBytes: 0,
        });
        const content = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])];

        const result = await blockStore.tryAppend(content, null, true);

        expect(result).not.toBeNull();
        expect(result.envelopeMs).toBe(0.25);
        // One six-byte block, one 12-byte envelope, and two 20-byte references.
        expect(Reflect.get(contentStore, '_length')).toBe(58);
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

    test('falls back when batch compression returns an incomplete result', async () => {
        vi.mocked(compressWrappedTermContentZstdBatch).mockResolvedValueOnce({chunks: [], envelopeMs: 0, wrapped: true});
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
        vi.mocked(compressWrappedTermContentZstdBatch).mockImplementationOnce(async (chunks) => {
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

        const values = await Promise.all(Array.from(result.contentOffsets, (offset, index) => blockStore.read(
            offset,
            result.contentLengths[index],
            result.contentDictName,
        )));

        expect(values).toStrictEqual([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]);
        // Two compact-reference reads and one coalesced compressed-block read.
        expect(readSlice).toHaveBeenCalledTimes(3);
        expect(blockStore.getDiagnostics()).toMatchObject({inFlightBlocks: 0});
    });

    test('rejects malformed compact block metadata before block decompression', async () => {
        const contentStore = new TermContentOpfsStore();
        await contentStore.appendBatch([new Uint8Array(20)]);
        const readSlice = vi.spyOn(contentStore, 'readSlice');
        const blockStore = new TermContentBlockStore(contentStore);

        expect(await blockStore.read(0, 1, 'raw-block-v2')).toBeNull();
        await expect(blockStore.readDetailed(0, 1, 'raw-block-v2')).resolves.toMatchObject({status: 'corrupt'});
        expect(readSlice).toHaveBeenCalledTimes(2);
        expect(blockStore.getDiagnostics().lastError).toMatchObject({
            contentOffset: 0,
            contentLength: 1,
            contentDictName: 'raw-block-v2',
        });
    });

    test('rejects corrupted compressed block bytes before decompression', async () => {
        vi.mocked(decompressTermContentZstd).mockClear();
        const contentStore = new TermContentOpfsStore();
        const block = wrapCompressedTermContentBlock(new Uint8Array([1, 2, 3]));
        block[12] ^= 0xff;
        await contentStore.appendBatch([block]);
        const [{offset: referenceOffset}] = await contentStore.appendBatch([
            encodeRawTermContentBlockReference(0, block.byteLength, 3, 0, 3),
        ]);
        const blockStore = new TermContentBlockStore(contentStore);

        await expect(blockStore.readDetailed(referenceOffset, 3, 'raw-block-v1')).resolves.toMatchObject({
            status: 'corrupt',
            reason: expect.stringContaining('stored payload'),
        });
        expect(blockStore.getDiagnostics().lastError).toMatchObject({
            blockOffset: 0,
        });
        expect(decompressTermContentZstd).not.toHaveBeenCalled();
    });

    test('rejects a reference whose entry extends beyond its block', async () => {
        const contentStore = new TermContentOpfsStore();
        const block = wrapCompressedTermContentBlock(new Uint8Array([1, 2, 3]));
        await contentStore.appendBatch([block]);
        const [{offset: referenceOffset}] = await contentStore.appendBatch([
            encodeRawTermContentBlockReference(0, block.byteLength, 3, 2, 2),
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
        const block = wrapCompressedTermContentBlock(new Uint8Array([1, 2, 3]));
        await contentStore.appendBatch([block]);
        const references = await contentStore.appendBatch([
            encodeRawTermContentBlockReference(0, block.byteLength, 3, 0, 3),
            encodeRawTermContentBlockReference(0, block.byteLength, 4, 0, 3),
        ]);
        const blockStore = new TermContentBlockStore(contentStore);

        expect(await blockStore.read(references[0].offset, 3, 'raw-block-v1')).toStrictEqual(new Uint8Array([1, 2, 3]));
        expect(await blockStore.read(references[1].offset, 3, 'raw-block-v1')).toBeNull();
        await expect(blockStore.readDetailed(references[1].offset, 3, 'raw-block-v1')).resolves.toMatchObject({status: 'corrupt'});
        expect(blockStore.getDiagnostics().lastError).toMatchObject({
            blockOffset: 0,
            expectedLength: 4,
            actualLength: 3,
        });
    });
});
