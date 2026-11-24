/*
 * Copyright (C) 2026 Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, describe, expect, test, vi} from 'vitest';
import {deferPromise} from '../ext/js/core/utilities.js';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {TermContentBlockImportSession, TermContentBlockStore} from '../ext/js/dictionary/term-content-block-store.js';
import {wrapCompressedTermContentBlock} from '../ext/js/dictionary/term-content-block-envelope.js';
import {TermContentOpfsStore} from '../ext/js/dictionary/term-content-opfs-store.js';
import {hasOwnedTermContent, registerOwnedTermContent, takeOwnedTermContent} from '../ext/js/dictionary/term-content-ownership.js';
import {compressTermContentZstd, compressWrappedTermContentZstdBlocks, getTermContentZstdBlockSizeBound} from '../ext/js/dictionary/zstd-term-content.js';

vi.mock('../ext/js/dictionary/zstd-term-content.js', async () => {
    const {wrapCompressedTermContentBlock: wrap} = await import('../ext/js/dictionary/term-content-block-envelope.js');
    return {
        resolveTermContentZstdDictName: () => 'jmdict',
        getTermContentZstdBlockSizeBound: vi.fn((/** @type {number} */ length) => length + 12),
        compressTermContentZstd: vi.fn((/** @type {Uint8Array} */ bytes) => Uint8Array.from(bytes)),
        compressWrappedTermContentZstdBlocks: vi.fn(async (
            /** @type {Uint32Array} */ lengths,
            /** @type {(index: number) => Uint8Array} */ createBlock,
        ) => ({chunks: Array.from(lengths, (_, index) => wrap(createBlock(index))), envelopeMs: 0, wrapped: true})),
        compressWrappedTermContentZstdBatch: vi.fn(async (/** @type {Uint8Array[]} */ chunks) => ({
            chunks: chunks.map(wrap), envelopeMs: 0, wrapped: true,
        })),
        compressWrappedTermContentZstdSpansBatch: vi.fn(),
        beginCompressWrappedTermContentZstdSpansBatch: vi.fn(),
        decompressTermContentZstd: vi.fn((/** @type {Uint8Array} */ bytes) => Uint8Array.from(bytes)),
    };
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
});

/** @returns {Promise<void>} */
async function flush() {
    await new Promise((resolve) => { setTimeout(resolve, 0); });
}

/** @returns {Uint8Array<ArrayBuffer>} */
function createOwnedSource() {
    const source = Uint8Array.of(99, 1, 2, 3, 88, 4, 5, 77, 6, 7, 8, 9);
    registerOwnedTermContent(source);
    return source;
}

/**
 * @param {TermContentBlockStore} store
 * @param {Uint8Array} source
 * @returns {NonNullable<ReturnType<TermContentBlockStore['tryBeginAppendSpans']>>}
 */
function begin(store, source) {
    const operation = store.tryBeginAppendSpans(source, Uint32Array.of(1, 5, 8), Uint32Array.of(3, 2, 4), 'jmdict', true);
    if (operation === null) { throw new Error('Expected an owned private reservation'); }
    return operation;
}

describe('accepted private content reservations', () => {
    test('requires a complete owned slab and a prior measured block selection', async () => {
        const store = new TermContentBlockStore(new TermContentOpfsStore(), {minInputBytes: 0});
        const source = createOwnedSource();
        const offsets = Uint32Array.of(0);
        const lengths = Uint32Array.of(4);
        expect(store.tryBeginAppendSpans(Uint8Array.of(1, 2, 3, 4), offsets, lengths, 'jmdict', true)).toBeNull();
        expect(store.tryBeginAppendSpans(source.subarray(1, 5), offsets, lengths, 'jmdict', true)).toBeNull();
        expect(store.tryBeginAppendSpans(source, offsets, lengths, null, true)).toBeNull();
        expect(store.tryBeginAppendSpans(source, offsets, lengths, 'jmdict', false)).toBeNull();
        const session = new TermContentBlockImportSession(store);
        expect(session.tryBeginAppendSpans('Jitendex', source, offsets, lengths, 'jmdict')).toBeNull();
        // The no-op codec grows this first batch, so measured savings reject it.
        await expect(session.appendSpans('Jitendex', source, offsets, lengths, 'jmdict')).resolves.toBeNull();
        expect(session.tryBeginAppendSpans('Jitendex', source, offsets, lengths, 'jmdict')).toBeNull();
        expect(hasOwnedTermContent(source)).toBe(true);
    });

    test('reserves references without consuming source ownership or admitting another append', async () => {
        const source = createOwnedSource();
        const original = Uint8Array.from(source);
        const release = deferPromise();
        vi.mocked(compressWrappedTermContentZstdBlocks).mockImplementationOnce(async (lengths, createBlock) => {
            const chunks = Array.from(lengths, (_, index) => wrapCompressedTermContentBlock(createBlock(index)));
            await release.promise;
            return {chunks, envelopeMs: 0, wrapped: true};
        });
        const contentStore = new TermContentOpfsStore();
        const store = new TermContentBlockStore(contentStore, {blockTargetBytes: 5, referencePackTargetBytes: 40});
        const operation = begin(store, source);
        const storage = await operation.storage;
        expect(storage.contentOffsets).toEqual(Float64Array.of(0, 20, 40));
        expect(hasOwnedTermContent(source)).toBe(true);
        expect(takeOwnedTermContent(source)).toBe(true);
        expect(source).toEqual(original);
        let consumed = false;
        void operation.sourceConsumed.then(() => { consumed = true; });
        let appended = false;
        const next = contentStore.appendBatch([Uint8Array.of(10)]).then((result) => {
            appended = true;
            return result;
        });
        await flush();
        expect(consumed).toBe(false);
        expect(appended).toBe(false);
        expect(Reflect.get(contentStore, '_length')).toBe(0);
        release.resolve(void 0);
        await operation.completion;
        await operation.sourceConsumed;
        await expect(next).resolves.toEqual([{offset: 93, length: 1}]);
        for (const [index, expected] of [Uint8Array.of(1, 2, 3), Uint8Array.of(4, 5), Uint8Array.of(6, 7, 8, 9)].entries()) {
            expect(await store.read(storage.contentOffsets[index], storage.contentLengths[index], storage.contentDictName)).toEqual(expected);
        }
    });

    test('reconstructs every block from the stable source after transferred worker inputs fail', async () => {
        const source = createOwnedSource();
        const original = Uint8Array.from(source);
        vi.mocked(compressWrappedTermContentZstdBlocks).mockImplementationOnce(async (lengths, createBlock) => {
            for (let index = 0; index < lengths.length; ++index) {
                const block = createBlock(index);
                structuredClone(block, {transfer: [(block.buffer)]});
                expect(block.byteLength).toBe(0);
            }
            throw new Error('injected drained worker failure');
        });
        const contentStore = new TermContentOpfsStore();
        const store = new TermContentBlockStore(contentStore, {blockTargetBytes: 5});
        const result = await begin(store, source).completion;
        expect(source).toEqual(original);
        expect(compressTermContentZstd).toHaveBeenCalledTimes(2);
        expect(Reflect.get(contentStore, '_length')).toBe(93);
        expect(await store.read(result.contentOffsets[2], result.contentLengths[2], result.contentDictName)).toEqual(Uint8Array.of(6, 7, 8, 9));
    });

    test.each([false, true])('drains private compression after reservation failure (setup %s)', async (setupFails) => {
        const release = deferPromise();
        vi.mocked(compressWrappedTermContentZstdBlocks).mockImplementationOnce(async (lengths, createBlock) => {
            const chunks = Array.from(lengths, (_, index) => wrapCompressedTermContentBlock(createBlock(index)));
            await release.promise;
            return {chunks, envelopeMs: 0, wrapped: true};
        });
        const contentStore = new TermContentOpfsStore();
        const failure = new Error('injected reservation failure');
        if (setupFails) {
            vi.spyOn(contentStore, 'beginAppendBatchWithDerivedPrefix').mockImplementationOnce(() => { throw failure; });
        } else {
            Reflect.set(contentStore, '_queuedWriteError', failure);
        }
        const operation = begin(new TermContentBlockStore(contentStore), createOwnedSource());
        let settled = false;
        void operation.completion.finally(() => { settled = true; }).catch(() => {});
        await expect(operation.storage).rejects.toBe(failure);
        await flush();
        expect(settled).toBe(false);
        release.resolve(void 0);
        await expect(operation.completion).rejects.toBe(failure);
        await operation.sourceConsumed;
        expect(Reflect.get(contentStore, '_length')).toBe(0);
    });

    test('keeps the original suffix bytes when the codec bound is unavailable', async () => {
        vi.mocked(getTermContentZstdBlockSizeBound).mockImplementationOnce(() => { throw new Error('codec is not initialized'); });
        const contentStore = new TermContentOpfsStore();
        const store = new TermContentBlockStore(contentStore, {blockTargetBytes: 5});
        const result = await begin(store, createOwnedSource()).completion;
        expect(result.contentOffsets).toEqual(Float64Array.of(33, 53, 73));
        expect(Reflect.get(contentStore, '_length')).toBe(93);
        expect(compressWrappedTermContentZstdBlocks).toHaveBeenCalledOnce();
        expect(await contentStore.readSlice(0, 17)).toEqual(wrapCompressedTermContentBlock(Uint8Array.of(1, 2, 3, 4, 5)));
    });

    test.each([false, true])('overlaps record append but retains the database join (record failure %s)', async (recordFails) => {
        const release = deferPromise();
        vi.mocked(compressWrappedTermContentZstdBlocks).mockImplementationOnce(async (lengths, createBlock) => {
            const chunks = Array.from(lengths, (_, index) => wrapCompressedTermContentBlock(createBlock(index)));
            await release.promise;
            return {chunks, envelopeMs: 0, wrapped: true};
        });
        const source = Uint8Array.of(1, 2, 3);
        registerOwnedTermContent(source);
        const database = new DictionaryDatabase();
        Reflect.set(database, '_bulkImportTransactionOpen', true);
        Reflect.set(database, '_deferTermsVirtualTableSync', true);
        Reflect.set(database, '_termContentZstdInitialized', true);
        const contentStore = new TermContentOpfsStore();
        const blockStore = new TermContentBlockStore(contentStore);
        const session = blockStore.beginImportSession();
        Reflect.get(session, '_blockEnabledDictionaries').add('Jitendex');
        Reflect.set(database, '_termContentBlockImportSession', session);
        const recordFailure = new Error('injected record failure');
        const appendRecords = vi.fn(async () => {
            if (recordFails) { throw recordFailure; }
            return {buildRecordsMs: 0, encodeMs: 0, appendWriteMs: 0, internMs: 0, packLengthsMs: 0, heapCopyMs: 0, recordFieldEncodeMs: 0};
        });
        Reflect.set(database, '_termRecordStore', {appendBatchFromArtifactChunkResolvedContent: appendRecords});
        /** @type {Parameters<DictionaryDatabase['_bulkAddArtifactTermsChunkWithContentDedup']>[0]} */
        const chunk = {
            dictionary: 'Jitendex',
            rowCount: 1,
            dictionaryTotalRows: 1,
            expressionBytesList: [new TextEncoder().encode('test')],
            readingBytesList: [new Uint8Array(0)],
            readingEqualsExpressionList: Uint8Array.of(1),
            scoreList: new Int32Array(1),
            sequenceList: Int32Array.of(-1),
            contentBytesList: [],
            contentHash1List: new Uint32Array(0),
            contentHash2List: new Uint32Array(0),
            contentBytesBuffer: source,
            contentBytesBaseOffset: 0,
            contentMetaList: Uint32Array.of(0, 3, 10, 20),
            contentUniqueIndexList: Uint32Array.of(0),
            contentDictNameList: null,
            uniformContentDictName: 'raw',
            contentDedupPlan: {
                uniqueCount: 1,
                sourceRowCount: 1,
                resolvedFlags: new Uint8Array(1),
                resolvedOffsets: new Float64Array(1),
                resolvedLengths: new Uint32Array(1),
                resolvedDictNames: null,
                pendingEpochs: new Uint32Array(1),
                pendingIndexes: new Uint32Array(1),
                nextEpoch: 1,
                nextUnresolvedUniqueIndex: 0,
                persistedLookupRequired: false,
            },
        };
        const importing = database._bulkAddArtifactTermsChunkWithContentDedup(chunk);
        let settled = false;
        void importing.finally(() => { settled = true; }).catch(() => {});
        await vi.waitFor(() => expect(appendRecords).toHaveBeenCalledOnce());
        expect(settled).toBe(false);
        expect(Reflect.get(contentStore, '_length')).toBe(0);
        expect(Reflect.get(database, '_inFlightTermContentSourceBatches').size).toBe(1);
        release.resolve(void 0);
        if (recordFails) {
            await expect(importing).rejects.toBe(recordFailure);
            expect(chunk.contentDedupPlan?.resolvedFlags).toEqual(Uint8Array.of(0));
        } else {
            await importing;
            expect(chunk.contentDedupPlan?.resolvedFlags).toEqual(Uint8Array.of(1));
        }
        expect(Reflect.get(database, '_inFlightTermContentSourceBatches').size).toBe(0);
        expect(source).toEqual(Uint8Array.of(1, 2, 3));
    });
});
