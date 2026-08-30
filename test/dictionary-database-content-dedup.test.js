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

import {describe, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {
    encodeRawTermContentSharedGlossaryBinary,
    RAW_TERM_CONTENT_SHARED_GLOSSARY_DICT_NAME,
} from '../ext/js/dictionary/raw-term-content.js';
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js';

/**
 * @param {DictionaryDatabase} database
 * @param {number} hash1
 * @param {number} hash2
 * @returns {{id: number, offset: number, length: number, dictName: string, hash2?: number}|undefined}
 */
function getMeta(database, hash1, hash2) {
    const getTermEntryContentMetaByHashPair = /** @type {(this: DictionaryDatabase, hash1: number, hash2: number) => {id: number, offset: number, length: number, dictName: string, hash2?: number}|undefined} */ (
        Reflect.get(database, '_getTermEntryContentMetaByHashPair')
    );
    return getTermEntryContentMetaByHashPair.call(database, hash1, hash2);
}

/**
 * @param {DictionaryDatabase} database
 * @param {string|null} contentHash
 * @param {number} offset
 * @param {number} length
 * @param {string} dictName
 * @param {number} hash1
 * @param {number} hash2
 */
function cacheMeta(database, contentHash, offset, length, dictName, hash1, hash2) {
    const cacheTermEntryContentMeta = /** @type {(this: DictionaryDatabase, contentHash: string|null, offset: number, length: number, dictName: string, id?: number, hash1?: number, hash2?: number) => {id: number, offset: number, length: number, dictName: string, hash2?: number}} */ (
        Reflect.get(database, '_cacheTermEntryContentMeta')
    );
    cacheTermEntryContentMeta.call(database, contentHash, offset, length, dictName, 0, hash1, hash2);
}

/**
 * @returns {{database: DictionaryDatabase, chunk: Record<string, unknown>, plan: Record<string, unknown>, appendRecords: ReturnType<typeof vi.fn>, releaseBorrowedContent: ReturnType<typeof vi.fn>, resolveContent: () => void, rejectContent: (error: Error) => void, resolveRecords: () => void, rejectRecords: (error: Error) => void, run: () => Promise<void>}}
 */
function createArtifactOverlapHarness() {
    const database = new DictionaryDatabase();
    Reflect.set(database, '_bulkImportTransactionOpen', true);
    Reflect.set(database, '_deferTermsVirtualTableSync', true);
    Reflect.set(database, '_termContentZstdInitialized', true);

    /** @type {(value: Record<string, number>) => void} */
    let resolveContent = () => {};
    /** @type {(error: Error) => void} */
    let rejectContent = () => {};
    const contentCompletion = new Promise((resolve, reject) => {
        resolveContent = () => {
            resolve({packMs: 1, compressMs: 2, envelopeMs: 3, referenceMs: 4, opfsAppendMs: 5});
        };
        rejectContent = reject;
    });
    /** @type {(value: Record<string, number>) => void} */
    let resolveRecords = () => {};
    /** @type {(error: Error) => void} */
    let rejectRecords = () => {};
    const recordCompletion = new Promise((resolve, reject) => {
        resolveRecords = () => {
            resolve({
                buildRecordsMs: 0,
                encodeMs: 0,
                appendWriteMs: 0,
                internMs: 0,
                packLengthsMs: 0,
                heapCopyMs: 0,
                recordFieldEncodeMs: 0,
                validationMs: 0,
                lookupIndexEncodeMs: 0,
            });
        };
        rejectRecords = reject;
    });
    const appendRecords = vi.fn(async () => await recordCompletion);
    Reflect.set(database, '_termRecordStore', {
        appendBatchFromArtifactChunkResolvedContent: appendRecords,
    });
    Reflect.set(database, '_termContentBlockImportSession', {
        tryBeginAppendSpans: vi.fn(() => ({
            initialSelection: true,
            sourceConsumed: Promise.resolve(),
            storage: Promise.resolve({
                contentOffsets: new Float64Array([100]),
                contentLengths: new Uint32Array([3]),
                contentDictName: 'raw-block-v2:jmdict',
            }),
            completion: contentCompletion.then((profile) => ({
                contentOffsets: new Float64Array([100]),
                contentLengths: new Uint32Array([3]),
                contentDictName: 'raw-block-v2:jmdict',
                ...profile,
            })),
        })),
    });

    const source = new Uint8Array(new SharedArrayBuffer(3));
    source.set([1, 2, 3]);
    const releaseBorrowedContent = vi.fn();
    const plan = {
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
    };
    const chunk = {
        dictionary: 'JMdict',
        rowCount: 1,
        dictionaryTotalRows: 1,
        expressionBytesList: [new TextEncoder().encode('test')],
        readingBytesList: [new Uint8Array(0)],
        readingEqualsExpressionList: new Uint8Array([1]),
        scoreList: new Int32Array(1),
        sequenceList: new Int32Array([-1]),
        contentBytesList: [],
        contentHash1List: new Uint32Array(0),
        contentHash2List: new Uint32Array(0),
        contentBytesBuffer: source,
        contentBytesBaseOffset: 0,
        contentMetaList: new Uint32Array([0, 3, 10, 20]),
        contentUniqueIndexList: new Uint32Array([0]),
        contentDedupPlan: plan,
        releaseBorrowedContent,
        contentDictNameList: null,
        uniformContentDictName: 'raw-v6',
        termRecordPreinternedPlan: null,
    };
    const bulkAdd = Reflect.get(database, '_bulkAddArtifactTermsChunkWithContentDedup').bind(database);
    return {
        database,
        chunk,
        plan,
        appendRecords,
        releaseBorrowedContent,
        resolveContent,
        rejectContent,
        resolveRecords,
        rejectRecords,
        run: async () => await bulkAdd(chunk),
    };
}

describe('DictionaryDatabase term content dedup metadata cache', () => {
    test('fails fast when metadata insertion is attempted without reserved capacity', () => {
        const database = new DictionaryDatabase();
        const contentBytes = Uint8Array.of(1);
        const reserve = Reflect.get(database, '_reserveArtifactTermContentMetadata').bind(database);
        const insert = Reflect.get(database, '_insertTermEntryContentMetaByHashPairFast').bind(database);

        expect(() => reserve(10, 20, contentBytes, 0, 1)).toThrow('has no free slot');
        expect(() => insert(10, 20, 0, 1, 'raw', 0, contentBytes)).toThrow('has no free slot');
    });

    test('uses parser-prepared signatures without resampling reserved content', () => {
        const database = new DictionaryDatabase();
        const ensureCapacity = Reflect.get(database, '_ensureTermEntryContentMetaHashPairCapacity').bind(database);
        const reserve = Reflect.get(database, '_reserveArtifactTermContentMetadata').bind(database);
        const readSignature = vi.spyOn(database, '_readTermContentSignature');
        ensureCapacity(1);

        const index = reserve(10, 20, Uint8Array.of(1), 0, 1, 101, 202, 303);

        expect(index).toBe(0);
        expect(readSignature).not.toHaveBeenCalled();
        expect(Reflect.get(database, '_termEntryContentMetaSignature1Table')[index]).toBe(101);
        expect(Reflect.get(database, '_termEntryContentMetaSignature2Table')[index]).toBe(202);
        expect(Reflect.get(database, '_termEntryContentMetaSignature3Table')[index]).toBe(303);
    });

    test('leases cleared dedup scratch tables without sharing active leases', () => {
        const database = new DictionaryDatabase();
        const acquire = Reflect.get(database, '_acquireArtifactTermContentDedupScratch').bind(database);
        const release = Reflect.get(database, '_releaseArtifactTermContentDedupScratch').bind(database);

        const first = acquire(16);
        first.hash1Table[3] = 123;
        first.indexTable[3] = 4;
        release(first);

        const reused = acquire(16);
        expect(reused).toBe(first);
        expect(reused.hash1Table[3]).toBe(123);
        expect(reused.indexTable[3]).toBe(0);

        const concurrent = acquire(16);
        expect(concurrent).not.toBe(reused);
        release(reused);
        release(concurrent);

        expect(Reflect.get(database, '_artifactTermContentDedupScratchPool')).toHaveLength(2);
    });

    test('promotes weighted content-cache hits without re-weighing them', () => {
        const database = new DictionaryDatabase();
        const cache = Reflect.get(database, '_termEntryContentCache');
        const getCached = Reflect.get(database, '_getCachedTermEntryContent').bind(database);
        const setCached = Reflect.get(database, '_setCachedTermEntryContent').bind(database);
        const value = {definitionTags: null, termTags: '', rules: '', glossaryJson: '[]', glossary: []};
        setCached('first', value);
        setCached('second', {...value});
        const weightBefore = cache.weight;
        const setSpy = vi.spyOn(cache, 'set');

        expect(getCached('first')).toBe(value);

        expect(setSpy).not.toHaveBeenCalled();
        expect(cache.weight).toBe(weightBefore);
        expect([...cache.keys()]).toStrictEqual(['second', 'first']);
    });

    test('groups duplicate external content spans for sequential row materialization', () => {
        const database = new DictionaryDatabase();
        const groupEntries = /** @type {(entries: Array<[number, unknown]>) => Array<Array<[number, unknown]>>} */ (
            Reflect.get(database, '_groupTermRecordEntriesByContentCacheKey').bind(database)
        );

        const groups = groupEntries([
            [1, {entryContentOffset: 10, entryContentLength: 5, entryContentDictName: 'raw'}],
            [2, {entryContentOffset: 10, entryContentLength: 5, entryContentDictName: 'raw'}],
            [3, {entryContentOffset: 20, entryContentLength: 5, entryContentDictName: 'raw'}],
            [4, {entryContentOffset: -1, entryContentLength: 0, entryContentDictName: 'raw'}],
            [5, {entryContentOffset: 10, entryContentLength: 5, entryContentDictName: 'jmdict'}],
        ]);

        expect(groups.map((group) => group.map(([id]) => id))).toEqual([[1, 2], [3], [4], [5]]);
    });

    test('reuses deserialized term rows until lookup caches are reset', async () => {
        const database = new DictionaryDatabase();
        const record = {
            id: 1,
            dictionary: 'JMdict',
            expression: '日本',
            reading: 'にほん',
            expressionReverse: null,
            readingReverse: null,
            entryContentOffset: -1,
            entryContentLength: 0,
            entryContentDictName: null,
            score: 10,
            sequence: 100,
        };
        const getByIds = vi.fn((ids) => new Map([...ids].map((id) => [id, {...record, id}])));
        /** @type {Array<{offset: number, length: number}>} */
        const warmedSpans = [];
        const warmSlices = vi.fn(async (/** @type {Iterable<{offset: number, length: number}>} */ spans) => {
            warmedSpans.push(...spans);
        });
        Reflect.set(database, '_termContentStore', {
            ensureLoadedForRead: vi.fn(async () => {}),
            warmSlices,
        });
        Reflect.set(database, '_termRecordStore', {getByIds});
        const fetchTermRowsByIds = /** @type {(this: DictionaryDatabase, ids: Iterable<number>) => Promise<Map<number, unknown>>} */ (
            Reflect.get(database, '_fetchTermRowsByIds')
        );

        const firstRows = await fetchTermRowsByIds.call(database, [1]);
        const secondRows = await fetchTermRowsByIds.call(database, [1]);

        expect(getByIds).toHaveBeenCalledTimes(1);
        expect(firstRows.get(1)).toBe(secondRows.get(1));
        expect(warmedSpans).toEqual([{offset: -1, length: 0}]);

        Reflect.get(database, '_clearDirectTermIndexCaches').call(database);
        await fetchTermRowsByIds.call(database, [1]);

        expect(getByIds).toHaveBeenCalledTimes(2);
    });

    test('does not cache transient content read failures as empty glossaries', async () => {
        const database = new DictionaryDatabase();
        const readDetailed = vi.fn()
            .mockResolvedValueOnce({status: 'temporarilyUnavailable', reason: 'injected OPFS failure'})
            .mockResolvedValueOnce({
                status: 'ok',
                bytes: new TextEncoder().encode(JSON.stringify({
                    definitionTags: '',
                    termTags: '',
                    rules: '',
                    glossary: ['definition'],
                })),
            });
        Reflect.set(database, '_termContentBlockStore', {readDetailed});
        const markDictionaryReimportRequired = vi.spyOn(
            Reflect.get(database, '_termRecordStore'),
            'markDictionaryReimportRequired',
        );
        const deserialize = Reflect.get(database, '_deserializeTermRow').bind(database);
        const row = {
            id: 1,
            dictionary: 'JMdict',
            expression: '日本',
            reading: 'にほん',
            expressionReverse: null,
            readingReverse: null,
            entryContentId: null,
            entryContentOffset: 10,
            entryContentLength: 20,
            entryContentDictName: 'raw',
            score: 1,
            sequence: 1,
        };

        await expect(deserialize(row)).rejects.toThrow('temporarily unavailable');
        expect(Reflect.get(database, '_termEntryContentCache').size).toBe(0);
        expect(markDictionaryReimportRequired).not.toHaveBeenCalled();

        await expect(deserialize(row)).resolves.toMatchObject({glossary: ['definition']});
        expect(readDetailed).toHaveBeenCalledTimes(2);
        expect(Reflect.get(database, '_termEntryContentCache').size).toBe(1);
    });

    test('does not misclassify a transient shared-glossary read as corruption', async () => {
        const database = new DictionaryDatabase();
        const textEncoder = new TextEncoder();
        const glossaryBytes = textEncoder.encode('["shared definition"]');
        const sharedHeader = encodeRawTermContentSharedGlossaryBinary(
            '',
            '',
            '',
            200,
            glossaryBytes.byteLength,
            textEncoder,
        );
        const readDetailed = vi.fn()
            .mockResolvedValueOnce({status: 'ok', bytes: sharedHeader})
            .mockResolvedValueOnce({status: 'temporarilyUnavailable', reason: 'injected shared OPFS failure'})
            .mockResolvedValueOnce({status: 'ok', bytes: sharedHeader})
            .mockResolvedValueOnce({status: 'ok', bytes: glossaryBytes});
        Reflect.set(database, '_termContentBlockStore', {readDetailed});
        const markDictionaryReimportRequired = vi.spyOn(
            Reflect.get(database, '_termRecordStore'),
            'markDictionaryReimportRequired',
        );
        const deserialize = Reflect.get(database, '_deserializeTermRow').bind(database);
        const row = {
            id: 1,
            dictionary: 'JMdict',
            expression: '日本',
            reading: 'にほん',
            entryContentId: null,
            entryContentOffset: 10,
            entryContentLength: sharedHeader.byteLength,
            entryContentDictName: RAW_TERM_CONTENT_SHARED_GLOSSARY_DICT_NAME,
            score: 1,
            sequence: 1,
        };

        await expect(deserialize(row)).rejects.toThrow('temporarily unavailable');
        expect(markDictionaryReimportRequired).not.toHaveBeenCalled();
        expect(Reflect.get(database, '_termEntryContentCache').size).toBe(0);

        await expect(deserialize(row)).resolves.toMatchObject({glossary: ['shared definition']});
        expect(readDetailed).toHaveBeenCalledTimes(4);
        expect(Reflect.get(database, '_termEntryContentCache').size).toBe(1);
    });

    test('marks confirmed term-content corruption as requiring reimport', async () => {
        const database = new DictionaryDatabase();
        Reflect.set(database, '_termContentBlockStore', {
            readDetailed: vi.fn(async () => ({status: 'corrupt', reason: 'injected checksum mismatch'})),
        });
        const markDictionaryReimportRequired = vi.spyOn(
            Reflect.get(database, '_termRecordStore'),
            'markDictionaryReimportRequired',
        );
        const deserialize = Reflect.get(database, '_deserializeTermRow').bind(database);

        await expect(deserialize({
            id: 1,
            dictionary: 'JMdict',
            expression: '日本',
            reading: 'にほん',
            entryContentId: null,
            entryContentOffset: 10,
            entryContentLength: 20,
            entryContentDictName: 'raw-block-v2',
            score: 1,
            sequence: 1,
        })).rejects.toThrow('must be re-imported');
        expect(markDictionaryReimportRequired).toHaveBeenCalledWith('JMdict', 'injected checksum mismatch');
        expect(Reflect.get(database, '_termEntryContentCache').size).toBe(0);
    });

    test('keeps exact hash-pair matches distinct through collisions and resize', () => {
        const database = new DictionaryDatabase();
        Reflect.set(database, '_getTermEntryContentMetaHashPairSlot', () => 0);

        for (let i = 0; i < 64; ++i) {
            cacheMeta(database, null, i * 10, i + 1, `raw-${i}`, 0x1000 + i, 0x2000 + (i * 17));
        }

        expect(Reflect.get(database, '_termEntryContentMetaHashPairCount')).toBe(64);
        for (let i = 0; i < 64; ++i) {
            expect(getMeta(database, 0x1000 + i, 0x2000 + (i * 17))).toMatchObject({
                offset: i * 10,
                length: i + 1,
                dictName: `raw-${i}`,
            });
        }
        expect(getMeta(database, 0x1000, 0x2001)).toBeUndefined();
        expect(getMeta(database, 0x1999, 0x2000)).toBeUndefined();
        expect(Reflect.get(database, '_termEntryContentMetaHashPairTable')).toBeInstanceOf(Uint32Array);
        expect(Reflect.get(database, '_termEntryContentMetaStateTable')).toBeInstanceOf(Uint8Array);
        expect(Reflect.get(database, '_termEntryContentMetaOffsetTable')).toBeInstanceOf(Float64Array);
        expect(Reflect.get(database, '_termEntryContentMetaLengthTable')).toBeInstanceOf(Uint32Array);
        expect(Reflect.get(database, '_termEntryContentMetaDictNameIdTable')).toBeInstanceOf(Uint32Array);
        expect(Reflect.get(database, '_termEntryContentMetaHashPairTable').length).toBeGreaterThan(
            Reflect.get(database, '_termEntryContentMetaOffsetTable').length,
        );
    });

    test('preserves large offsets and signatures through typed-table resizes', () => {
        const database = new DictionaryDatabase();
        const cache = Reflect.get(database, '_cacheTermEntryContentMeta').bind(database);
        const findMatching = Reflect.get(database, '_findMatchingTermEntryContentMeta').bind(database);
        const contentBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
        const largeOffset = 0x100000000 + 123;
        cache(null, largeOffset, contentBytes.byteLength, 'raw-block-v1:jmdict', 0, 123, 456, contentBytes);
        for (let i = 0; i < 128; ++i) {
            cacheMeta(database, null, i * 10, i + 1, `raw-${i}`, 1000 + i, 2000 + i);
        }

        expect(getMeta(database, 123, 456)).toMatchObject({
            offset: largeOffset,
            length: contentBytes.byteLength,
            dictName: 'raw-block-v1:jmdict',
        });
        expect(findMatching(123, 456, new Uint8Array(contentBytes))).toMatchObject({offset: largeOffset});
    });

    test('preallocates bounded metadata capacity using the parser unique ratio', () => {
        const database = new DictionaryDatabase();
        const getCapacityHint = Reflect.get(database, '_getArtifactTermContentMetaCapacityHint').bind(database);

        expect(getCapacityHint({
            rowCount: 250,
            dictionaryTotalRows: 1000,
            contentDedupPlan: {sourceRowCount: 250, uniqueCount: 125},
        }, 125)).toBe(500);
        expect(getCapacityHint({
            rowCount: 100,
            dictionaryTotalRows: 10_000,
            contentDedupPlan: {sourceRowCount: 100, uniqueCount: 90},
        }, 90)).toBe(9000);
        expect(getCapacityHint({
            rowCount: 100,
            dictionaryTotalRows: 10_000_000,
            contentDedupPlan: {sourceRowCount: 100, uniqueCount: 100},
        }, 100)).toBe(1024 * 1024);
        expect(getCapacityHint({
            rowCount: 100,
            dictionaryTotalRows: 1000,
            contentDedupPlan: {sourceRowCount: 0, uniqueCount: 50},
        }, 50)).toBe(50);

        cacheMeta(database, null, 0, 1, 'raw', 1, 2);
        expect(getCapacityHint({
            rowCount: 250,
            dictionaryTotalRows: 1000,
            contentDedupPlan: {sourceRowCount: 250, uniqueCount: 125},
        }, 125)).toBe(126);
    });

    test('keeps staged metadata invisible until persisted offsets are published', () => {
        const database = new DictionaryDatabase();
        const stage = Reflect.get(database, '_stageArtifactTermContentMetadata').bind(database);
        const publish = Reflect.get(database, '_publishArtifactTermContentMetadata').bind(database);
        const contentBytes = new Uint8Array([1, 2, 3, 4, 5]);
        const stagedContentMetadata = stage([101], [202], [contentBytes], null);

        expect(getMeta(database, 101, 202)).toBeUndefined();
        expect(Reflect.get(database, '_termEntryContentMetaHashPairPendingCount')).toBe(1);
        publish({
            count: 1,
            contentOffsets: new Float64Array(1),
            contentLengths: new Uint32Array(1),
            resolvedContentDictNames: 'raw',
            pendingRowToUniqueIndex: new Int32Array([0]),
            pendingContentBytes: [contentBytes],
            pendingContentHash1s: [101],
            pendingContentHash2s: [202],
            pendingOffsets: [1234],
            pendingLengths: [contentBytes.byteLength],
            pendingResolvedDictNames: 'raw',
            pendingContentSpans: null,
            stagedContentMetadata,
        });

        expect(getMeta(database, 101, 202)).toMatchObject({
            offset: 1234,
            length: contentBytes.byteLength,
            dictName: 'raw',
        });
        expect(Reflect.get(database, '_termEntryContentMetaHashPairPendingCount')).toBe(0);
        expect(Reflect.get(database, '_termEntryContentMetaHashPairCount')).toBe(1);
    });

    test('keeps staged dense indexes stable across hash-table rehashes', () => {
        const database = new DictionaryDatabase();
        const stage = Reflect.get(database, '_stageArtifactTermContentMetadata').bind(database);
        const ensureCapacity = Reflect.get(database, '_ensureTermEntryContentMetaHashPairCapacity').bind(database);
        const publish = Reflect.get(database, '_publishArtifactTermContentMetadata').bind(database);
        const contentBytes = new Uint8Array([1, 2, 3, 4]);
        const staged = stage([101], [202], [contentBytes], null);
        const denseIndex = staged.indexes[0];
        const oldHashSlots = Reflect.get(database, '_termEntryContentMetaHashPairTable');

        ensureCapacity(128);

        expect(Reflect.get(database, '_termEntryContentMetaHashPairTable')).not.toBe(oldHashSlots);
        expect(staged.indexes[0]).toBe(denseIndex);
        publish({
            count: 1,
            contentOffsets: new Float64Array(1),
            contentLengths: new Uint32Array(1),
            resolvedContentDictNames: 'raw',
            pendingRowToUniqueIndex: new Int32Array([0]),
            pendingContentBytes: [contentBytes],
            pendingContentHash1s: [101],
            pendingContentHash2s: [202],
            pendingOffsets: [9876],
            pendingLengths: [contentBytes.byteLength],
            pendingResolvedDictNames: 'raw',
            pendingContentSpans: null,
            stagedContentMetadata: staged,
        });
        expect(getMeta(database, 101, 202)).toMatchObject({offset: 9876, length: 4});
    });

    test('rejects untrusted persisted offsets before publishing staged metadata', () => {
        const database = new DictionaryDatabase();
        const stage = Reflect.get(database, '_stageArtifactTermContentMetadata').bind(database);
        const publish = Reflect.get(database, '_publishArtifactTermContentMetadata').bind(database);
        const rollback = Reflect.get(database, '_rollbackStagedArtifactTermContentMetadata').bind(database);
        const contentBytes = new Uint8Array([1, 2, 3]);
        const stagedContentMetadata = stage([101], [202], [contentBytes], null);

        expect(() => publish({
            count: 1,
            contentOffsets: new Float64Array(1),
            contentLengths: new Uint32Array(1),
            resolvedContentDictNames: 'raw',
            pendingRowToUniqueIndex: new Int32Array([0]),
            pendingContentBytes: [contentBytes],
            pendingContentHash1s: [101],
            pendingContentHash2s: [202],
            pendingOffsets: [-1],
            pendingLengths: [contentBytes.byteLength],
            pendingResolvedDictNames: 'raw',
            pendingContentSpans: null,
            stagedContentMetadata,
        })).toThrow('Invalid term content metadata offset');

        rollback(stagedContentMetadata);
        expect(getMeta(database, 101, 202)).toBeUndefined();
    });

    test('clears unpublished staged metadata after persistence failure', () => {
        const database = new DictionaryDatabase();
        const stage = Reflect.get(database, '_stageArtifactTermContentMetadata').bind(database);
        const clear = Reflect.get(database, '_rollbackStagedArtifactTermContentMetadata').bind(database);
        const staged = stage(
            [101, 303],
            [202, 404],
            [new Uint8Array([1]), new Uint8Array([2])],
            null,
        );

        clear(staged);

        expect(getMeta(database, 101, 202)).toBeUndefined();
        expect(getMeta(database, 303, 404)).toBeUndefined();
        expect(Reflect.get(database, '_termEntryContentMetaHashPairPendingCount')).toBe(0);
        expect(Reflect.get(database, '_termEntryContentMetaHashPairCount')).toBe(0);
    });

    test('rolls back already-published staged metadata without losing prior entries', () => {
        const database = new DictionaryDatabase();
        cacheMeta(database, null, 50, 3, 'raw', 11, 22);
        const stage = Reflect.get(database, '_stageArtifactTermContentMetadata').bind(database);
        const publish = Reflect.get(database, '_publishArtifactTermContentMetadata').bind(database);
        const rollback = Reflect.get(database, '_rollbackStagedArtifactTermContentMetadata').bind(database);
        const contentBytes = new Uint8Array([9, 8, 7, 6]);
        const stagedContentMetadata = stage([101], [202], [contentBytes], null);
        publish({
            count: 1,
            contentOffsets: new Float64Array(1),
            contentLengths: new Uint32Array(1),
            resolvedContentDictNames: 'raw',
            pendingRowToUniqueIndex: new Int32Array([0]),
            pendingContentBytes: [contentBytes],
            pendingContentHash1s: [101],
            pendingContentHash2s: [202],
            pendingOffsets: [1234],
            pendingLengths: [contentBytes.byteLength],
            pendingResolvedDictNames: 'raw',
            pendingContentSpans: null,
            stagedContentMetadata,
        });

        rollback(stagedContentMetadata);
        rollback(stagedContentMetadata);

        expect(getMeta(database, 101, 202)).toBeUndefined();
        expect(getMeta(database, 11, 22)).toMatchObject({offset: 50, length: 3});
        expect(Reflect.get(database, '_termEntryContentMetaHashPairCount')).toBe(1);
    });

    test('rolls back parser-verified hash collisions with staged metadata', () => {
        const database = new DictionaryDatabase();
        const stage = Reflect.get(database, '_stageArtifactTermContentMetadata').bind(database);
        const publish = Reflect.get(database, '_publishArtifactTermContentMetadata').bind(database);
        const rollback = Reflect.get(database, '_rollbackStagedArtifactTermContentMetadata').bind(database);
        const findMatching = Reflect.get(database, '_findMatchingTermEntryContentMeta').bind(database);
        const first = new Uint8Array([1, 2, 3, 4, 5]);
        const second = new Uint8Array([6, 7, 8, 9, 10]);
        const staged = stage([101, 101], [202, 202], [first, second], null);

        expect([...staged.indexes]).toEqual([0, -1]);
        publish({
            count: 2,
            contentOffsets: new Float64Array(2),
            contentLengths: new Uint32Array(2),
            resolvedContentDictNames: 'raw',
            pendingRowToUniqueIndex: new Int32Array([0, 1]),
            pendingContentBytes: [first, second],
            pendingContentHash1s: [101, 101],
            pendingContentHash2s: [202, 202],
            pendingOffsets: [1000, 2000],
            pendingLengths: [first.byteLength, second.byteLength],
            pendingResolvedDictNames: 'raw',
            pendingContentSpans: null,
            stagedContentMetadata: staged,
        });

        expect(findMatching(101, 202, first)).toMatchObject({offset: 1000});
        expect(findMatching(101, 202, second)).toMatchObject({offset: 2000});
        rollback(staged);
        expect(findMatching(101, 202, first)).toBeUndefined();
        expect(findMatching(101, 202, second)).toBeUndefined();
        expect(Reflect.get(database, '_termEntryContentMetaCollisionsByHashPair').size).toBe(0);
    });

    test('updates existing hash pairs without growing the cache', () => {
        const database = new DictionaryDatabase();

        cacheMeta(database, null, 10, 5, 'raw', 0xabcdef01, 0x12345678);
        cacheMeta(database, null, 20, 7, 'raw-v3', 0xabcdef01, 0x12345678);

        expect(Reflect.get(database, '_termEntryContentMetaHashPairCount')).toBe(1);
        expect(getMeta(database, 0xabcdef01, 0x12345678)).toMatchObject({
            offset: 20,
            length: 7,
            dictName: 'raw-v3',
        });
    });

    test('uses content signatures to disambiguate identical hash pairs', async () => {
        const database = new DictionaryDatabase();
        const cache = Reflect.get(database, '_cacheTermEntryContentMeta').bind(database);
        const findMatching = Reflect.get(database, '_findMatchingTermEntryContentMeta').bind(database);
        const firstBytes = new Uint8Array([1, 2, 3]);
        const secondBytes = new Uint8Array([1, 2, 4]);
        Reflect.set(database, '_readTermEntryContentBytes', vi.fn(async () => firstBytes));

        cache(null, 10, firstBytes.byteLength, 'raw', 0, 123, 456, firstBytes);
        expect(findMatching(123, 456, secondBytes)).toBeUndefined();
        cache(null, 20, secondBytes.byteLength, 'raw', 0, 123, 456, secondBytes);

        expect(findMatching(123, 456, firstBytes)).toMatchObject({offset: 10});
        expect(findMatching(123, 456, secondBytes)).toMatchObject({offset: 20});
    });

    test('exactly compares persisted candidates which predate content signatures', async () => {
        const database = new DictionaryDatabase();
        const cache = Reflect.get(database, '_cacheTermEntryContentMeta').bind(database);
        const findMatching = Reflect.get(database, '_findMatchingTermEntryContentMeta').bind(database);
        const persistedBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
        const collidingBytes = persistedBytes.slice();
        collidingBytes[5] = 99;
        Reflect.set(database, '_readTermEntryContentBytes', vi.fn(async () => persistedBytes));

        cache(null, 10, persistedBytes.byteLength, 'raw', 0, 123, 456);

        const result = findMatching(123, 456, collidingBytes);
        expect(result).toBeInstanceOf(Promise);
        await expect(result).resolves.toBeUndefined();
    });

    test('exactly compares persisted block content after a database reload', async () => {
        const database = new DictionaryDatabase();
        const cache = Reflect.get(database, '_cacheTermEntryContentMeta').bind(database);
        const findMatching = Reflect.get(database, '_findMatchingTermEntryContentMeta').bind(database);
        const persistedBytes = new Uint8Array([1, 2, 3, 4]);
        const readTermEntryContentBytes = vi.fn(async () => persistedBytes);
        Reflect.set(database, '_readTermEntryContentBytes', readTermEntryContentBytes);

        cache(null, 10, persistedBytes.byteLength, 'raw-block-v1:jmdict', 0, 123, 456);

        const result = findMatching(123, 456, persistedBytes.slice());
        expect(result).toBeInstanceOf(Promise);
        await expect(result).resolves.toMatchObject({offset: 10, dictName: 'raw-block-v1:jmdict'});
        expect(readTermEntryContentBytes).toHaveBeenCalledWith(10, persistedBytes.byteLength, 'raw-block-v1:jmdict');
    });

    test('returns synchronously when a hash pair has no persisted candidate', () => {
        const database = new DictionaryDatabase();
        const findMatching = Reflect.get(database, '_findMatchingTermEntryContentMeta').bind(database);

        const result = findMatching(123, 456, new Uint8Array([1, 2, 3]));

        expect(result).toBeUndefined();
    });

    test('parses string content hashes into the numeric cache and clears both indexes', () => {
        const database = new DictionaryDatabase();
        const clearBlockCache = vi.spyOn(Reflect.get(database, '_termContentBlockStore'), 'clearCache');
        const clearTermEntryContentMetaCaches = /** @type {(this: DictionaryDatabase) => void} */ (
            Reflect.get(database, '_clearTermEntryContentMetaCaches')
        );

        cacheMeta(database, '0000000100000002', 30, 9, 'raw', -1, -1);
        expect(getMeta(database, 1, 2)).toMatchObject({offset: 30, length: 9, dictName: 'raw'});
        expect(Reflect.get(database, '_termEntryContentMetaByHash').get('0000000100000002')).toMatchObject({
            offset: 30,
            length: 9,
            dictName: 'raw',
        });

        clearTermEntryContentMetaCaches.call(database);
        expect(getMeta(database, 1, 2)).toBeUndefined();
        expect(Reflect.get(database, '_termEntryContentMetaByHash').size).toBe(0);
        expect(Reflect.get(database, '_termEntryContentMetaHashPairCount')).toBe(0);
        expect(clearBlockCache).toHaveBeenCalledOnce();
    });
});

describe('DictionaryDatabase artifact term content dedup import', () => {
    test('compares content bytes across unrolled-loop boundaries', () => {
        const database = new DictionaryDatabase();
        const compare = Reflect.get(database, '_termContentBytesEqual').bind(database);
        for (const length of [0, 1, 7, 8, 9, 15, 16, 17, 63, 64, 65]) {
            const a = new Uint8Array(length);
            const b = new Uint8Array(length);
            for (let i = 0; i < length; ++i) {
                a[i] = i & 0xff;
                b[i] = i & 0xff;
            }
            expect(compare(a, b)).toBe(true);
            for (const index of new Set([0, Math.floor(length / 2), length - 1])) {
                if (index < 0 || index >= length) { continue; }
                b[index] ^= 0xff;
                expect(compare(a, b)).toBe(false);
                b[index] ^= 0xff;
            }
        }
        expect(compare(new Uint8Array(8), new Uint8Array(9))).toBe(false);
    });

    test('compares bounded content spans', () => {
        const database = new DictionaryDatabase();
        const compare = Reflect.get(database, '_termContentBytesEqualSpan').bind(database);
        const buffer = new Uint8Array([9, 1, 2, 3, 8, 1, 2, 4, 7]);

        expect(compare(new Uint8Array([1, 2, 3]), buffer, 1, 3)).toBe(true);
        expect(compare(new Uint8Array([1, 2, 3]), buffer, 5, 3)).toBe(false);
        expect(compare(new Uint8Array([1, 2]), buffer, 1, 3)).toBe(false);
    });

    test('deduplicates slab content while materializing only unique views', async () => {
        const database = new DictionaryDatabase();
        const resolve = Reflect.get(database, '_resolveArtifactTermContentDedup').bind(database);
        const buffer = new Uint8Array([99, 1, 2, 3, 1, 2, 4, 1, 2, 3, 88]);
        const result = await resolve({
            rowCount: 3,
            contentBytesList: [],
            contentHash1List: new Uint32Array(0),
            contentHash2List: new Uint32Array(0),
            contentBytesBuffer: buffer,
            contentBytesBaseOffset: 1,
            contentMetaList: new Uint32Array([
                0,
                3,
                10,
                20,
                3,
                3,
                10,
                20,
                6,
                3,
                10,
                20,
            ]),
            contentDictNameList: null,
            uniformContentDictName: 'raw',
        });

        expect(result.pendingContentBytes).toHaveLength(2);
        expect([...result.pendingContentBytes[0]]).toEqual([1, 2, 3]);
        expect([...result.pendingContentBytes[1]]).toEqual([1, 2, 4]);
        expect([...result.pendingRowToUniqueIndex]).toEqual([0, 1, 0]);
        expect(result.pendingHitCount).toBe(1);

        await expect(resolve({
            rowCount: 1,
            contentBytesList: [],
            contentHash1List: new Uint32Array(0),
            contentHash2List: new Uint32Array(0),
            contentBytesBuffer: buffer,
            contentBytesBaseOffset: 1,
            contentMetaList: new Uint32Array([buffer.byteLength, 1, 10, 20]),
            contentDictNameList: null,
            uniformContentDictName: 'raw',
        })).rejects.toThrow('Artifact term content bytes are invalid at row 0');
    });

    test('skips persisted probes only when a native bank plan starts against an empty store', async () => {
        const database = new DictionaryDatabase();
        const findPersistedIndex = vi.spyOn(
            /** @type {DictionaryDatabase & {_findTermEntryContentMetaHashPairIndex: (hash1: number, hash2: number) => number}} */ (database),
            '_findTermEntryContentMetaHashPairIndex',
        );
        const resolve = Reflect.get(database, '_resolveArtifactTermContentDedup').bind(database);
        const plan = {
            resolvedFlags: new Uint8Array(2),
            resolvedOffsets: new Float64Array(2),
            resolvedLengths: new Uint32Array(2),
            resolvedDictNames: new Array(2),
            pendingEpochs: new Uint32Array(2),
            pendingIndexes: new Uint32Array(2),
            nextEpoch: 1,
            persistedLookupRequired: null,
        };
        const makeChunk = (uniqueIndex, byte, hash) => ({
            rowCount: 1,
            contentBytesList: [new Uint8Array([byte])],
            contentHash1List: new Uint32Array([hash]),
            contentHash2List: new Uint32Array([hash + 1]),
            contentUniqueIndexList: new Uint32Array([uniqueIndex]),
            contentDedupPlan: plan,
            contentDictNameList: null,
            uniformContentDictName: 'raw',
        });

        await resolve(makeChunk(0, 1, 10));
        cacheMeta(database, null, 100, 1, 'raw', 99, 100);
        findPersistedIndex.mockClear();
        await resolve(makeChunk(1, 2, 20));

        expect(plan.persistedLookupRequired).toBe(false);
        expect(findPersistedIndex).not.toHaveBeenCalled();

        const secondDatabase = new DictionaryDatabase();
        cacheMeta(secondDatabase, null, 200, 1, 'raw', 30, 31);
        const secondFindPersistedIndex = vi.spyOn(
            /** @type {DictionaryDatabase & {_findTermEntryContentMetaHashPairIndex: (hash1: number, hash2: number) => number}} */ (secondDatabase),
            '_findTermEntryContentMetaHashPairIndex',
        );
        const secondResolve = Reflect.get(secondDatabase, '_resolveArtifactTermContentDedup').bind(secondDatabase);
        const secondPlan = {
            ...plan,
            resolvedFlags: new Uint8Array(1),
            resolvedOffsets: new Float64Array(1),
            resolvedLengths: new Uint32Array(1),
            resolvedDictNames: new Array(1),
            pendingEpochs: new Uint32Array(1),
            pendingIndexes: new Uint32Array(1),
            nextEpoch: 1,
            persistedLookupRequired: null,
        };
        await secondResolve({
            ...makeChunk(0, 3, 30),
            contentDedupPlan: secondPlan,
        });

        expect(secondPlan.persistedLookupRequired).toBe(true);
        expect(secondFindPersistedIndex).toHaveBeenCalled();
    });

    test('resolves empty-store native unique indexes as contiguous ranges across chunks', async () => {
        const database = new DictionaryDatabase();
        const resolve = Reflect.get(database, '_resolveArtifactTermContentDedup').bind(database);
        const plan = {
            uniqueCount: 2,
            resolvedFlags: new Uint8Array([1, 0]),
            resolvedOffsets: new Float64Array([123, 0]),
            resolvedLengths: new Uint32Array([3, 0]),
            resolvedDictNames: null,
            resolvedUniformDictName: 'raw-block-v1:jmdict',
            pendingEpochs: new Uint32Array(2),
            pendingIndexes: new Uint32Array(2),
            nextEpoch: 1,
            nextUnresolvedUniqueIndex: 1,
            persistedLookupRequired: false,
        };
        const first = new Uint8Array([1, 2, 3]);
        const second = new Uint8Array([4, 5]);
        const result = await resolve({
            rowCount: 3,
            contentBytesList: [first, second, second],
            contentHash1List: new Uint32Array([10, 30, 30]),
            contentHash2List: new Uint32Array([20, 40, 40]),
            contentUniqueIndexList: new Uint32Array([0, 1, 1]),
            contentDedupPlan: plan,
            contentDictNameList: null,
            uniformContentDictName: 'raw-v6',
        });

        expect(result.pendingContentBytes).toEqual([second]);
        expect(result.pendingRowToUniqueIndex).toBeNull();
        expect(result.pendingPlanUniqueStart).toBe(1);
        expect(result.pendingHitCount).toBe(2);
        expect(result.contentOffsets[0]).toBe(123);
        expect(result.contentLengths[0]).toBe(3);
        expect(result.resolvedContentDictNames).toEqual(['raw-block-v1:jmdict', void 0, void 0]);
        expect(plan.nextUnresolvedUniqueIndex).toBe(2);
    });

    test('keeps empty-store native unique content as shared slab spans', async () => {
        const database = new DictionaryDatabase();
        const resolve = Reflect.get(database, '_resolveArtifactTermContentDedup').bind(database);
        const source = new Uint8Array([99, 1, 2, 3, 4, 5, 88]);
        const plan = {
            uniqueCount: 2,
            resolvedFlags: new Uint8Array(2),
            resolvedOffsets: new Float64Array(2),
            resolvedLengths: new Uint32Array(2),
            resolvedDictNames: new Array(2),
            pendingEpochs: new Uint32Array(2),
            pendingIndexes: new Uint32Array(2),
            nextEpoch: 1,
            nextUnresolvedUniqueIndex: 0,
            persistedLookupRequired: false,
        };

        const result = await resolve({
            rowCount: 3,
            contentBytesList: [],
            contentHash1List: new Uint32Array(0),
            contentHash2List: new Uint32Array(0),
            contentBytesBuffer: source,
            contentBytesBaseOffset: 1,
            contentMetaList: new Uint32Array([
                0,
                3,
                10,
                20,
                3,
                2,
                30,
                40,
                3,
                2,
                30,
                40,
            ]),
            contentUniqueIndexList: new Uint32Array([0, 1, 1]),
            contentDedupPlan: plan,
            contentDictNameList: null,
            uniformContentDictName: 'raw-v6',
        });

        expect(result.pendingContentBytes).toHaveLength(0);
        expect(result.pendingContentCount).toBe(2);
        expect(result.pendingContentSpans?.buffer).toBe(source);
        expect([...result.pendingContentSpans.offsets]).toEqual([1, 4]);
        expect([...result.pendingContentSpans.lengths]).toEqual([3, 2]);
        expect(result.pendingRowToUniqueIndex).toBeNull();
        expect(result.pendingHitCount).toBe(1);
        expect(Reflect.get(database, '_termEntryContentMetaHashPairPendingCount')).toBe(0);

        const offsetScratch = plan.pendingSpanOffsetsScratch;
        const lengthScratch = plan.pendingSpanLengthsScratch;
        plan.resolvedFlags.fill(1);
        plan.resolvedOffsets.set([100, 200]);
        plan.resolvedLengths.set([3, 2]);
        plan.resolvedDictNames.splice(0, 2, 'raw-v6', 'raw-v6');
        const repeated = await resolve({
            rowCount: 1,
            contentBytesList: [],
            contentHash1List: new Uint32Array(0),
            contentHash2List: new Uint32Array(0),
            contentBytesBuffer: source,
            contentBytesBaseOffset: 1,
            contentMetaList: new Uint32Array([0, 3, 10, 20]),
            contentUniqueIndexList: new Uint32Array([0]),
            contentDedupPlan: plan,
            contentDictNameList: null,
            uniformContentDictName: 'raw-v6',
        });
        expect(plan.pendingSpanOffsetsScratch).toBe(offsetScratch);
        expect(plan.pendingSpanLengthsScratch).toBe(lengthScratch);
        expect(repeated.pendingContentCount).toBe(0);
        expect(repeated.contentOffsets[0]).toBe(plan.resolvedOffsets[0]);
    });

    test('keeps resolver-reserved native metadata invisible until publication', async () => {
        const database = new DictionaryDatabase();
        const resolve = Reflect.get(database, '_resolveArtifactTermContentDedup').bind(database);
        const rollback = Reflect.get(database, '_rollbackStagedArtifactTermContentMetadata').bind(database);
        const source = new Uint8Array([1, 2, 3]);
        const result = await resolve({
            dictionary: 'JMdict',
            rowCount: 1,
            dictionaryTotalRows: 1,
            contentBytesList: [],
            contentHash1List: new Uint32Array(0),
            contentHash2List: new Uint32Array(0),
            contentBytesBuffer: source,
            contentBytesBaseOffset: 0,
            contentMetaList: new Uint32Array([0, 3, 10, 20]),
            contentUniqueIndexList: new Uint32Array([0]),
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
            contentDictNameList: null,
            uniformContentDictName: 'raw-v6',
        }, true);

        expect(result.stagedContentMetadata?.indexes[0]).toBeGreaterThanOrEqual(0);
        expect(getMeta(database, 10, 20)).toBeUndefined();
        expect(Reflect.get(database, '_termEntryContentMetaHashPairPendingCount')).toBe(1);
        rollback(result.stagedContentMetadata);
        expect(Reflect.get(database, '_termEntryContentMetaHashPairPendingCount')).toBe(0);
    });

    test('projects persisted native-plan metadata without allocating a row map', () => {
        const database = new DictionaryDatabase();
        Reflect.get(database, '_ensureTermEntryContentMetaHashPairCapacity').call(database, 2);
        const publish = Reflect.get(database, '_publishArtifactTermContentMetadata').bind(database);
        const contentOffsets = new Float64Array(3);
        const contentLengths = new Uint32Array(3);
        const first = new Uint8Array([1, 2, 3]);
        const second = new Uint8Array([4, 5, 6, 7]);
        const resolvedContentDictNames = publish({
            count: 3,
            contentOffsets,
            contentLengths,
            resolvedContentDictNames: 'raw',
            pendingRowToUniqueIndex: null,
            pendingContentBytes: [first, second],
            pendingContentHash1s: [11, 22],
            pendingContentHash2s: [33, 44],
            pendingOffsets: [100, 200],
            pendingLengths: [3, 4],
            pendingResolvedDictNames: 'raw',
            pendingContentSpans: null,
            contentDedupPlan: {
                resolvedFlags: new Uint8Array([1, 1]),
                resolvedOffsets: new Float64Array([100, 200]),
                resolvedLengths: new Uint32Array([3, 4]),
                resolvedDictNames: ['raw', 'raw'],
            },
            contentUniqueIndexList: new Uint32Array([0, 1, 0]),
        });

        expect([...contentOffsets]).toEqual([100, 200, 100]);
        expect([...contentLengths]).toEqual([3, 4, 3]);
        expect(resolvedContentDictNames).toBe('raw');
        expect(getMeta(database, 11, 33)).toMatchObject({offset: 100, length: 3, dictName: 'raw'});
        expect(getMeta(database, 22, 44)).toMatchObject({offset: 200, length: 4, dictName: 'raw'});
    });

    test('keeps unmatched persisted-plan content as shared slab spans', async () => {
        const database = new DictionaryDatabase();
        cacheMeta(database, null, 400, 1, 'raw', 90, 91);
        const resolve = Reflect.get(database, '_resolveArtifactTermContentDedup').bind(database);
        const source = new Uint8Array([99, 1, 2, 3, 4, 5, 88]);
        const plan = {
            uniqueCount: 2,
            resolvedFlags: new Uint8Array(2),
            resolvedOffsets: new Float64Array(2),
            resolvedLengths: new Uint32Array(2),
            resolvedDictNames: new Array(2),
            pendingEpochs: new Uint32Array(2),
            pendingIndexes: new Uint32Array(2),
            nextEpoch: 1,
            persistedLookupRequired: true,
        };

        const result = await resolve({
            rowCount: 3,
            contentBytesList: [],
            contentHash1List: new Uint32Array(0),
            contentHash2List: new Uint32Array(0),
            contentBytesBuffer: source,
            contentBytesBaseOffset: 1,
            contentMetaList: new Uint32Array([
                0,
                3,
                10,
                20,
                3,
                2,
                30,
                40,
                3,
                2,
                30,
                40,
            ]),
            contentUniqueIndexList: new Uint32Array([0, 1, 1]),
            contentDedupPlan: plan,
            contentDictNameList: null,
            uniformContentDictName: 'raw-v6',
        });

        expect(result.pendingContentBytes).toHaveLength(0);
        expect(result.pendingContentCount).toBe(2);
        expect(result.pendingContentSpans?.buffer).toBe(source);
        expect([...result.pendingContentSpans.offsets]).toEqual([1, 4]);
        expect([...result.pendingContentSpans.lengths]).toEqual([3, 2]);
        expect([...result.pendingRowToUniqueIndex]).toEqual([0, 1, 1]);
        expect(result.pendingHitCount).toBe(1);
    });

    test('checks persisted metadata once per parser-verified unique slab content', async () => {
        const database = new DictionaryDatabase();
        const findPersistedIndex = vi.spyOn(
            /** @type {DictionaryDatabase & {_findTermEntryContentMetaHashPairIndex: (hash1: number, hash2: number) => number}} */ (database),
            '_findTermEntryContentMetaHashPairIndex',
        );
        const resolve = Reflect.get(database, '_resolveArtifactTermContentDedup').bind(database);
        const source = new Uint8Array([99, 1, 2, 3, 4, 5, 88]);
        const plan = {
            uniqueCount: 2,
            sourceRowCount: 3,
            uniqueRowIndexes: new Uint32Array([0, 1]),
            resolvedFlags: new Uint8Array(2),
            resolvedOffsets: new Float64Array(2),
            resolvedLengths: new Uint32Array(2),
            resolvedDictNames: new Array(2),
            pendingEpochs: new Uint32Array(2),
            pendingIndexes: new Uint32Array(2),
            nextEpoch: 1,
            persistedLookupRequired: true,
        };

        const result = await resolve({
            rowCount: 3,
            contentRowStart: 0,
            contentBytesList: [],
            contentHash1List: new Uint32Array(0),
            contentHash2List: new Uint32Array(0),
            contentBytesBuffer: source,
            contentBytesBaseOffset: 1,
            contentMetaList: new Uint32Array([
                0,
                3,
                10,
                20,
                3,
                2,
                30,
                40,
                3,
                2,
                30,
                40,
            ]),
            contentUniqueIndexList: new Uint32Array([0, 1, 1]),
            contentDedupPlan: plan,
            contentDictNameList: null,
            uniformContentDictName: 'raw-v6',
        });

        expect(findPersistedIndex).toHaveBeenCalledTimes(2);
        expect(result.pendingContentCount).toBe(2);
        expect(result.pendingRowToUniqueIndex).toBeNull();
        expect([...result.pendingContentSpans.offsets]).toEqual([1, 4]);
        expect([...result.pendingContentSpans.lengths]).toEqual([3, 2]);
        expect(result.pendingPlanUniqueIndexes).toEqual([0, 1]);
        expect(result.pendingHitCount).toBe(1);
    });

    test('projects one persisted canonical hit onto every duplicate row', async () => {
        const database = new DictionaryDatabase();
        const source = new Uint8Array([99, 1, 2, 3, 1, 2, 3, 88]);
        Reflect.get(database, '_cacheTermEntryContentMeta').call(
            database,
            null,
            400,
            3,
            'raw-v6',
            0,
            10,
            20,
            source.subarray(1, 4),
        );
        const findPersistedIndex = vi.spyOn(
            /** @type {DictionaryDatabase & {_findTermEntryContentMetaHashPairIndex: (hash1: number, hash2: number) => number}} */ (database),
            '_findTermEntryContentMetaHashPairIndex',
        );
        const readSignature = vi.spyOn(database, '_readTermContentSignature');
        const resolve = Reflect.get(database, '_resolveArtifactTermContentDedup').bind(database);
        const result = await resolve({
            rowCount: 2,
            contentRowStart: 0,
            contentBytesList: [],
            contentHash1List: new Uint32Array(0),
            contentHash2List: new Uint32Array(0),
            contentBytesBuffer: source,
            contentBytesBaseOffset: 1,
            contentMetaList: new Uint32Array([
                0,
                3,
                10,
                20,
                3,
                3,
                10,
                20,
            ]),
            contentUniqueIndexList: new Uint32Array([0, 0]),
            contentDedupPlan: {
                uniqueCount: 1,
                sourceRowCount: 2,
                uniqueRowIndexes: new Uint32Array([0]),
                uniqueSignatures: new Uint32Array([197121, 197121, 197121]),
                resolvedFlags: new Uint8Array(1),
                resolvedOffsets: new Float64Array(1),
                resolvedLengths: new Uint32Array(1),
                resolvedDictNames: new Array(1),
                pendingEpochs: new Uint32Array(1),
                pendingIndexes: new Uint32Array(1),
                nextEpoch: 1,
                persistedLookupRequired: true,
            },
            contentDictNameList: null,
            uniformContentDictName: 'raw-v6',
        });

        expect(findPersistedIndex).toHaveBeenCalledOnce();
        expect(readSignature).not.toHaveBeenCalled();
        expect(result.pendingContentCount).toBe(0);
        expect(result.persistedHitCount).toBe(1);
        expect([...result.contentOffsets]).toEqual([400, 400]);
        expect([...result.contentLengths]).toEqual([3, 3]);
        expect(result.resolvedContentDictNames).toBe('raw-v6');
    });

    test('defers mixed canonical projection until pending offsets are published', async () => {
        const database = new DictionaryDatabase();
        const source = new Uint8Array([1, 2, 3, 1, 2, 3, 4, 5]);
        Reflect.get(database, '_cacheTermEntryContentMeta').call(
            database,
            null,
            400,
            3,
            'raw-v6',
            0,
            10,
            20,
            source.subarray(0, 3),
        );
        const plan = {
            uniqueCount: 2,
            sourceRowCount: 3,
            uniqueRowIndexes: new Uint32Array([0, 2]),
            resolvedFlags: new Uint8Array(2),
            resolvedOffsets: new Float64Array(2),
            resolvedLengths: new Uint32Array(2),
            resolvedDictNames: new Array(2),
            pendingEpochs: new Uint32Array(2),
            pendingIndexes: new Uint32Array(2),
            nextEpoch: 1,
            persistedLookupRequired: true,
        };
        const chunk = {
            rowCount: 3,
            contentRowStart: 0,
            dictionaryTotalRows: 3,
            contentBytesList: [],
            contentHash1List: new Uint32Array(0),
            contentHash2List: new Uint32Array(0),
            contentBytesBuffer: source,
            contentBytesBaseOffset: 0,
            contentMetaList: new Uint32Array([
                0, 3, 10, 20,
                3, 3, 10, 20,
                6, 2, 30, 40,
            ]),
            contentUniqueIndexList: new Uint32Array([0, 0, 1]),
            contentDedupPlan: plan,
            contentDictNameList: null,
            uniformContentDictName: 'raw-v6',
        };
        const resolve = Reflect.get(database, '_resolveArtifactTermContentDedup').bind(database);
        const result = await resolve(chunk, true);

        expect(result.pendingContentCount).toBe(1);
        expect(result.contentOffsets).toStrictEqual(new Float64Array(3));

        plan.resolvedOffsets[1] = 500;
        plan.resolvedLengths[1] = 2;
        plan.resolvedDictNames[1] = 'raw-block-v2:jmdict';
        plan.resolvedFlags[1] = 1;
        const publish = Reflect.get(database, '_publishArtifactTermContentMetadata').bind(database);
        const names = publish({
            count: 3,
            contentOffsets: result.contentOffsets,
            contentLengths: result.contentLengths,
            resolvedContentDictNames: result.resolvedContentDictNames,
            pendingRowToUniqueIndex: null,
            pendingContentBytes: result.pendingContentBytes,
            pendingContentHash1s: result.pendingContentHash1s,
            pendingContentHash2s: result.pendingContentHash2s,
            pendingOffsets: new Float64Array([500]),
            pendingLengths: new Uint32Array([2]),
            pendingResolvedDictNames: 'raw-block-v2:jmdict',
            pendingContentSpans: result.pendingContentSpans,
            contentDedupPlan: plan,
            contentUniqueIndexList: chunk.contentUniqueIndexList,
            stagedContentMetadata: result.stagedContentMetadata,
            metadataValidated: true,
        });

        expect([...result.contentOffsets]).toEqual([400, 400, 500]);
        expect([...result.contentLengths]).toEqual([3, 3, 2]);
        expect(names).toEqual(['raw-v6', 'raw-v6', 'raw-block-v2:jmdict']);
    });

    test('does not merge a canonical row with a persisted hash collision', async () => {
        const database = new DictionaryDatabase();
        const persisted = new Uint8Array([1, 2, 3, 4]);
        Reflect.get(database, '_cacheTermEntryContentMeta').call(
            database,
            null,
            400,
            persisted.byteLength,
            'raw',
            0,
            10,
            20,
            persisted,
        );
        Reflect.set(database, '_termContentStore', {
            readSlice: vi.fn(async () => persisted),
        });
        const resolve = Reflect.get(database, '_resolveArtifactTermContentDedup').bind(database);
        const source = new Uint8Array([99, 1, 2, 3, 5, 88]);
        const result = await resolve({
            rowCount: 1,
            contentRowStart: 0,
            contentBytesList: [],
            contentHash1List: new Uint32Array(0),
            contentHash2List: new Uint32Array(0),
            contentBytesBuffer: source,
            contentBytesBaseOffset: 1,
            contentMetaList: new Uint32Array([0, 4, 10, 20]),
            contentUniqueIndexList: new Uint32Array([0]),
            contentDedupPlan: {
                uniqueCount: 1,
                sourceRowCount: 1,
                uniqueRowIndexes: new Uint32Array([0]),
                resolvedFlags: new Uint8Array(1),
                resolvedOffsets: new Float64Array(1),
                resolvedLengths: new Uint32Array(1),
                resolvedDictNames: new Array(1),
                pendingEpochs: new Uint32Array(1),
                pendingIndexes: new Uint32Array(1),
                nextEpoch: 1,
                persistedLookupRequired: true,
            },
            contentDictNameList: null,
            uniformContentDictName: 'raw-v6',
        });

        expect(result.persistedHitCount).toBe(0);
        expect(result.exactFallbackCount).toBe(1);
        expect(result.pendingContentCount).toBe(1);
        expect([...result.pendingContentSpans.offsets]).toEqual([1]);
    });

    test('uses global canonical row indexes with nonzero chunk starts', async () => {
        const database = new DictionaryDatabase();
        const resolve = Reflect.get(database, '_resolveArtifactTermContentDedup').bind(database);
        const plan = {
            uniqueCount: 3,
            sourceRowCount: 5,
            uniqueRowIndexes: new Uint32Array([0, 2, 4]),
            resolvedFlags: new Uint8Array([1, 0, 0]),
            resolvedOffsets: new Float64Array([100, 0, 0]),
            resolvedLengths: new Uint32Array([3, 0, 0]),
            resolvedDictNames: ['raw-v6', void 0, void 0],
            pendingEpochs: new Uint32Array(3),
            pendingIndexes: new Uint32Array(3),
            nextEpoch: 1,
            persistedLookupRequired: true,
        };
        const source = new Uint8Array([99, 4, 5, 4, 5, 6, 88]);
        const result = await resolve({
            rowCount: 3,
            contentRowStart: 2,
            contentBytesList: [],
            contentHash1List: new Uint32Array(0),
            contentHash2List: new Uint32Array(0),
            contentBytesBuffer: source,
            contentBytesBaseOffset: 1,
            contentMetaList: new Uint32Array([
                0,
                2,
                30,
                40,
                2,
                2,
                30,
                40,
                4,
                1,
                50,
                60,
            ]),
            contentUniqueIndexList: new Uint32Array([1, 1, 2]),
            contentDedupPlan: plan,
            contentDictNameList: null,
            uniformContentDictName: 'raw-v6',
        });

        expect(result.pendingPlanUniqueIndexes).toEqual([1, 2]);
        expect([...result.pendingContentSpans.offsets]).toEqual([1, 5]);
        expect([...result.pendingContentSpans.lengths]).toEqual([2, 1]);
        expect(result.pendingHitCount).toBe(1);
    });

    test('rolls back canonical-row plan publication after persistence failure', async () => {
        const harness = createArtifactOverlapHarness();
        Reflect.set(harness.plan, 'uniqueRowIndexes', new Uint32Array([0]));
        Reflect.set(harness.plan, 'persistedLookupRequired', true);
        Reflect.set(harness.chunk, 'contentRowStart', 0);
        const stageMetadata = vi.spyOn(harness.database, '_stageArtifactTermContentMetadata');
        const importing = harness.run();

        await vi.waitFor(() => expect(harness.appendRecords).toHaveBeenCalledOnce());
        harness.rejectContent(new Error('injected canonical content failure'));
        harness.resolveRecords();

        await expect(importing).rejects.toThrow('injected canonical content failure');
        expect(getMeta(harness.database, 10, 20)).toBeUndefined();
        expect(Reflect.get(harness.database, '_termEntryContentMetaHashPairPendingCount')).toBe(0);
        expect(stageMetadata).not.toHaveBeenCalled();
        expect(harness.plan.resolvedFlags).toStrictEqual(new Uint8Array([0]));
        expect(harness.plan.resolvedOffsets).toStrictEqual(new Float64Array([0]));
        expect(harness.plan.resolvedLengths).toStrictEqual(new Uint32Array([0]));
    });

    test('passes parser-owned resolved content references directly to record persistence', async () => {
        const harness = createArtifactOverlapHarness();
        Reflect.set(harness.plan, 'uniqueRowIndexes', new Uint32Array([0]));
        Reflect.set(harness.chunk, 'contentRowStart', 0);
        Reflect.set(harness.chunk, 'useResolvedContentReferences', true);
        const importing = harness.run();

        await vi.waitFor(() => expect(harness.appendRecords).toHaveBeenCalledOnce());
        expect(harness.releaseBorrowedContent).toHaveBeenCalledOnce();
        const [recordChunk, contentOffsets, contentLengths, contentDictName] = harness.appendRecords.mock.calls[0];
        expect(contentOffsets).toStrictEqual(new Float64Array(0));
        expect(contentLengths).toStrictEqual(new Uint32Array(0));
        expect(contentDictName).toBe('raw-block-v2:jmdict');
        expect(recordChunk.resolvedContentReferences).toEqual({
            uniqueIndexList: harness.chunk.contentUniqueIndexList,
            offsets: harness.plan.resolvedOffsets,
            lengths: harness.plan.resolvedLengths,
        });

        harness.resolveContent();
        harness.resolveRecords();
        await importing;
    });

    test('bounds persisted signatures for short slab content', async () => {
        const database = new DictionaryDatabase();
        const contentBytes = new Uint8Array([1, 2, 3]);
        Reflect.get(database, '_cacheTermEntryContentMeta').call(
            database,
            null,
            1234,
            contentBytes.byteLength,
            'raw',
            0,
            10,
            20,
            contentBytes,
        );
        const resolve = Reflect.get(database, '_resolveArtifactTermContentDedup').bind(database);
        const result = await resolve({
            rowCount: 1,
            contentBytesList: [],
            contentHash1List: new Uint32Array(0),
            contentHash2List: new Uint32Array(0),
            contentBytesBuffer: new Uint8Array([99, 1, 2, 3, 0xff, 0xff, 0xff, 0xff]),
            contentBytesBaseOffset: 1,
            contentMetaList: new Uint32Array([0, 3, 10, 20]),
            contentDictNameList: null,
            uniformContentDictName: 'raw',
        });

        expect(result.persistedHitCount).toBe(1);
        expect(result.pendingContentBytes).toHaveLength(0);
        expect(result.contentOffsets[0]).toBe(1234);
    });

    test('reuses discovered insertion slots without merging exact hash collisions', async () => {
        const database = new DictionaryDatabase();
        const resolve = Reflect.get(database, '_resolveArtifactTermContentDedup').bind(database);
        const first = new Uint8Array([1, 2, 3]);
        const second = new Uint8Array([1, 2, 4]);

        const result = await resolve({
            rowCount: 4,
            contentBytesList: [first, second, first.slice(), second.slice()],
            contentHash1List: new Uint32Array([10, 10, 10, 10]),
            contentHash2List: new Uint32Array([20, 20, 20, 20]),
            contentDictNameList: null,
            uniformContentDictName: 'raw',
        });

        expect(result.pendingContentBytes).toHaveLength(2);
        expect([...result.pendingRowToUniqueIndex]).toEqual([0, 1, 0, 1]);
        expect(result.pendingHitCount).toBe(2);
        expect(result.persistedHitCount).toBe(0);
    });

    test('rolls back reserved metadata when content persistence fails during record append', async () => {
        const harness = createArtifactOverlapHarness();
        const importing = harness.run();

        await vi.waitFor(() => expect(harness.appendRecords).toHaveBeenCalledOnce());
        expect(harness.appendRecords.mock.calls[0][1]).toStrictEqual(new Float64Array([100]));
        harness.rejectContent(new Error('injected reserved content failure'));
        harness.resolveRecords();

        await expect(importing).rejects.toThrow('injected reserved content failure');
        expect(getMeta(harness.database, 10, 20)).toBeUndefined();
        expect(harness.plan.resolvedFlags).toStrictEqual(new Uint8Array([0]));
        expect(harness.plan.nextUnresolvedUniqueIndex).toBe(0);

        const resolve = Reflect.get(harness.database, '_resolveArtifactTermContentDedup').bind(harness.database);
        const retry = await resolve(harness.chunk, true);
        expect(retry.stagedContentMetadata?.indexes[0]).toBeGreaterThanOrEqual(0);
        expect(getMeta(harness.database, 10, 20)).toBeUndefined();
        Reflect.get(harness.database, '_rollbackStagedArtifactTermContentMetadata').call(
            harness.database,
            retry.stagedContentMetadata,
        );
        expect(Reflect.get(harness.database, '_termEntryContentMetaHashPairPendingCount')).toBe(0);
    });

    test('reports source-driven initial content reservation', async () => {
        const harness = createArtifactOverlapHarness();
        const importing = harness.run();

        await vi.waitFor(() => expect(harness.appendRecords).toHaveBeenCalledOnce());
        harness.resolveContent();
        harness.resolveRecords();
        await importing;

        expect(getMeta(harness.database, 10, 20)).toMatchObject({
            offset: 100,
            length: 3,
            dictName: 'raw-block-v2:jmdict',
        });
        expect(harness.database.getLastBulkAddTermsMetrics()).toMatchObject({
            contentInitialReservationCount: 1,
        });
    });

    test('waits for pending content before surfacing a concurrent record failure', async () => {
        const harness = createArtifactOverlapHarness();
        const importing = harness.run();
        let importSettled = false;
        void importing.finally(() => { importSettled = true; }).catch(() => {});

        await vi.waitFor(() => expect(harness.appendRecords).toHaveBeenCalledOnce());
        harness.rejectRecords(new Error('injected term record failure'));
        await Promise.resolve();
        expect(importSettled).toBe(false);

        harness.resolveContent();
        await expect(importing).rejects.toThrow('injected term record failure');
        expect(getMeta(harness.database, 10, 20)).toBeUndefined();
        expect(harness.plan.resolvedFlags).toStrictEqual(new Uint8Array([0]));
        expect(harness.plan.nextUnresolvedUniqueIndex).toBe(0);
    });

    test('keeps local non-journaled imports on completed-content ordering', async () => {
        const database = new DictionaryDatabase();
        const db = {exec: vi.fn()};
        Reflect.set(database, '_db', db);
        Reflect.set(database, '_deferTermsVirtualTableSync', true);
        vi.spyOn(database, '_beginImmediateTransaction').mockResolvedValue();
        const tryBeginPersistence = vi.spyOn(database, '_tryBeginPersistArtifactTermContent');
        const persist = vi.spyOn(database, '_persistArtifactTermContent').mockResolvedValue({
            pendingOffsets: [50],
            pendingLengths: [3],
            pendingResolvedDictNames: 'raw',
            blockProfile: null,
        });
        Reflect.set(database, '_termRecordStore', {
            appendBatchFromArtifactChunkResolvedContent: vi.fn(async () => ({
                buildRecordsMs: 0,
                encodeMs: 0,
                appendWriteMs: 0,
                internMs: 0,
                packLengthsMs: 0,
                heapCopyMs: 0,
                recordFieldEncodeMs: 0,
            })),
        });
        const bytes = new Uint8Array([1, 2, 3]);
        const chunk = {
            dictionary: 'JMdict',
            rowCount: 1,
            dictionaryTotalRows: 1,
            expressionBytesList: [new TextEncoder().encode('test')],
            readingBytesList: [new Uint8Array(0)],
            readingEqualsExpressionList: new Uint8Array([1]),
            scoreList: new Int32Array(1),
            sequenceList: new Int32Array([-1]),
            contentBytesList: [bytes],
            contentHash1List: new Uint32Array([10]),
            contentHash2List: new Uint32Array([20]),
            contentDictNameList: null,
            uniformContentDictName: 'raw',
            termRecordPreinternedPlan: null,
        };
        const bulkAdd = Reflect.get(database, '_bulkAddArtifactTermsChunkWithContentDedup').bind(database);

        await bulkAdd(chunk);

        expect(tryBeginPersistence).not.toHaveBeenCalled();
        expect(persist).toHaveBeenCalledOnce();
        expect(db.exec).toHaveBeenCalledWith('COMMIT');
    });

    test('reuses duplicate artifact content within and across chunks', async () => {
        const database = new DictionaryDatabase();
        Reflect.set(database, '_bulkImportTransactionOpen', true);
        Reflect.set(database, '_termContentStorageMode', 'raw-bytes');
        Reflect.set(database, '_rawTermContentPackTargetBytes', 1024);

        /** @type {Array<{chunks: Uint8Array[], offsets: number[], lengths: number[]}>} */
        const appendCalls = [];
        Reflect.set(database, '_termContentStore', {
            appendBatchToArrays: vi.fn((chunks, offsets, lengths) => {
                appendCalls.push({chunks: [...chunks], offsets, lengths});
                let offset = 1000;
                for (let i = 0; i < chunks.length; ++i) {
                    offsets.push(offset);
                    lengths.push(chunks[i].byteLength);
                    offset += chunks[i].byteLength;
                }
            }),
            readSlice: vi.fn(async (offset, length) => {
                const call = appendCalls.find(({offsets, lengths}) => offsets.some((value, index) => value === offset && lengths[index] >= length));
                if (typeof call === 'undefined') { throw new Error('Missing test content span'); }
                const index = call.offsets.indexOf(offset);
                return call.chunks[index].slice(0, length);
            }),
        });

        /** @type {Array<{contentOffsets: number[], contentLengths: number[], contentDictNames: string|string[]}>} */
        const termRecordCalls = [];
        Reflect.set(database, '_termRecordStore', {
            appendBatchFromArtifactChunkResolvedContent: vi.fn(async (_chunk, contentOffsets, contentLengths, contentDictNames) => {
                termRecordCalls.push({
                    contentOffsets: [...contentOffsets],
                    contentLengths: [...contentLengths],
                    contentDictNames: Array.isArray(contentDictNames) ? [...contentDictNames] : contentDictNames,
                });
                return {
                    buildRecordsMs: 0,
                    encodeMs: 0,
                    appendWriteMs: 0,
                    internMs: 0,
                    packLengthsMs: 0,
                    heapCopyMs: 0,
                    recordFieldEncodeMs: 0,
                };
            }),
        });
        const bulkAddArtifactTermsChunkWithContentDedup = /** @type {(this: DictionaryDatabase, chunk: unknown) => Promise<void>} */ (
            Reflect.get(database, '_bulkAddArtifactTermsChunkWithContentDedup')
        );
        const makeChunk = (
            /** @type {Uint8Array[]} */ contentBytesList,
            /** @type {number[]} */ hash1List,
            /** @type {number[]} */ hash2List,
        ) => ({
            dictionary: 'dedup-test',
            rowCount: contentBytesList.length,
            dictionaryTotalRows: contentBytesList.length,
            expressionBytesList: contentBytesList.map((/** @type {Uint8Array} */ _, index) => new TextEncoder().encode(`term-${index}`)),
            readingBytesList: contentBytesList.map(() => new Uint8Array(0)),
            readingEqualsExpressionList: new Uint8Array(contentBytesList.length).fill(1),
            scoreList: new Int32Array(contentBytesList.length),
            sequenceList: new Int32Array(contentBytesList.length).fill(-1),
            contentBytesList,
            contentHash1List: new Uint32Array(hash1List),
            contentHash2List: new Uint32Array(hash2List),
            contentDictNameList: null,
            uniformContentDictName: 'raw',
            termRecordPreinternedPlan: null,
        });

        await bulkAddArtifactTermsChunkWithContentDedup.call(database, makeChunk(
            [
                new Uint8Array([1, 2, 3]),
                new Uint8Array([1, 2, 3]),
                new Uint8Array([4, 5]),
            ],
            [10, 10, 30],
            [20, 20, 40],
        ));
        await bulkAddArtifactTermsChunkWithContentDedup.call(database, makeChunk(
            [new Uint8Array([1, 2, 3])],
            [10],
            [20],
        ));

        expect(appendCalls).toHaveLength(1);
        expect(getMeta(database, 10, 20)).toMatchObject({offset: termRecordCalls[0].contentOffsets[0], length: 3});
        expect(termRecordCalls).toHaveLength(2);
        expect(termRecordCalls[0].contentOffsets[0]).toBe(termRecordCalls[0].contentOffsets[1]);
        expect(termRecordCalls[0].contentLengths).toEqual([3, 3, 2]);
        expect(termRecordCalls[0].contentDictNames).toBe('raw');
        expect(termRecordCalls[1].contentOffsets).toEqual([termRecordCalls[0].contentOffsets[0]]);
        expect(termRecordCalls[1].contentLengths).toEqual([3]);
        expect(termRecordCalls[1].contentDictNames).toBe('raw');
    });
});

describe('DictionaryDatabase term lookup warming', () => {
    test('does not reload direct term indexes already cached for lookup', async () => {
        const database = new DictionaryDatabase();
        Reflect.get(database, '_directTermIndexByDictionary').set('JMdict', {
            expression: new Map(),
            reading: new Map(),
            expressionReverse: new Map(),
            readingReverse: new Map(),
            sequence: new Map(),
        });
        const ensureDictionariesLoaded = vi.fn(async () => {});
        Reflect.set(database, '_termRecordStore', {ensureDictionariesLoaded});

        const ensureDirectTermIndexesLoaded = /** @type {(this: DictionaryDatabase, dictionaryNames: Iterable<string>) => Promise<void>} */ (
            Reflect.get(database, '_ensureDirectTermIndexesLoaded')
        );
        await ensureDirectTermIndexesLoaded.call(database, ['JMdict']);

        expect(ensureDictionariesLoaded).not.toHaveBeenCalled();
    });

    test('loads and indexes missing direct term indexes as one batch', async () => {
        const database = new DictionaryDatabase();
        const indexes = new Map([
            ['JMdict', {
                expression: new Map([['日本', [1]]]),
                reading: new Map(),
                expressionReverse: new Map(),
                readingReverse: new Map(),
                sequence: new Map(),
            }],
            ['Jitendex', {
                expression: new Map([['日本', [2]]]),
                reading: new Map(),
                expressionReverse: new Map(),
                readingReverse: new Map(),
                sequence: new Map(),
            }],
        ]);
        const ensureDictionariesLoaded = vi.fn(async () => {});
        const ensureDictionaryIndexes = vi.fn();
        const getDictionaryIndex = vi.fn((name) => indexes.get(name));
        Reflect.set(database, '_termRecordStore', {ensureDictionariesLoaded, ensureDictionaryIndexes, getDictionaryIndex});

        const ensureDirectTermIndexesLoaded = /** @type {(this: DictionaryDatabase, dictionaryNames: Iterable<string>) => Promise<void>} */ (
            Reflect.get(database, '_ensureDirectTermIndexesLoaded')
        );
        await ensureDirectTermIndexesLoaded.call(database, ['JMdict', 'Jitendex']);

        expect(ensureDictionariesLoaded).toHaveBeenCalledOnce();
        expect(ensureDictionariesLoaded).toHaveBeenCalledWith(['JMdict', 'Jitendex']);
        expect(ensureDictionaryIndexes).toHaveBeenCalledOnce();
        expect(ensureDictionaryIndexes).toHaveBeenCalledWith(['JMdict', 'Jitendex']);
        expect(getDictionaryIndex).toHaveBeenCalledTimes(2);
        expect(Reflect.get(database, '_directTermIndexByDictionary').get('JMdict')).toBe(indexes.get('JMdict'));
        expect(Reflect.get(database, '_directTermIndexByDictionary').get('Jitendex')).toBe(indexes.get('Jitendex'));
    });

    test('warms exact lookup storage and transient persisted prefix indexes', async () => {
        const database = new DictionaryDatabase();
        const index = {
            expression: new Map([['日本', [1]]]),
            reading: new Map([['にほん', [1]]]),
            expressionReverse: new Map(),
            readingReverse: new Map(),
            sequence: new Map(),
        };
        Reflect.set(database, '_termContentStore', {ensureLoadedForRead: vi.fn(async () => {})});
        const warmPrefixIndexes = vi.fn(async () => {});
        Reflect.set(database, '_termRecordStore', {
            ensureDictionariesLoaded: vi.fn(async () => {}),
            getDictionaryIndex: vi.fn(() => index),
            warmPrefixIndexes,
        });
        Reflect.set(database, '_warmSharedGlossaryArtifacts', vi.fn(async () => {}));
        const warmLookupProbeTerms = vi.fn(async () => {});
        Reflect.set(database, '_warmLookupProbeTerms', warmLookupProbeTerms);
        const getSortedTermIndexKeys = vi.fn(() => []);
        Reflect.set(database, '_getSortedTermIndexKeys', getSortedTermIndexKeys);

        await database.warmTermLookupCaches(['JMdict']);

        expect(Reflect.get(database, '_termContentStore').ensureLoadedForRead).toHaveBeenCalledOnce();
        expect(Reflect.get(database, '_termRecordStore').ensureDictionariesLoaded).toHaveBeenCalledWith(['JMdict']);
        expect(warmPrefixIndexes).toHaveBeenCalledWith(['JMdict']);
        expect(Reflect.get(database, '_warmSharedGlossaryArtifacts')).toHaveBeenCalledWith(['JMdict']);
        expect(warmLookupProbeTerms).toHaveBeenCalledWith(['JMdict']);
        expect(warmLookupProbeTerms.mock.invocationCallOrder[0]).toBeLessThan(
            warmPrefixIndexes.mock.invocationCallOrder[0],
        );
        expect(getSortedTermIndexKeys).not.toHaveBeenCalled();
    });

    test('exact term-reading lookup filters expression candidates without building pair indexes', async () => {
        const database = new DictionaryDatabase();
        Reflect.set(database, '_db', {});
        const index = {
            expression: new Map([['日本', [1, 2]]]),
            reading: new Map([['にほん', [1]], ['にっぽん', [2]]]),
            expressionReverse: new Map(),
            readingReverse: new Map(),
            sequence: new Map(),
        };
        const ensureDictionariesLoaded = vi.fn(async () => {});
        const ensureDictionaryIndexes = vi.fn();
        const getDictionaryIndex = vi.fn(() => index);
        Reflect.set(database, '_termRecordStore', {ensureDictionariesLoaded, ensureDictionaryIndexes, getDictionaryIndex});
        const fetchTermRowsByIds = vi.fn(async () => new Map([
            [1, {
                id: 1,
                dictionary: 'JMdict',
                expression: '日本',
                reading: 'にほん',
                definitionTags: '',
                termTags: '',
                rules: '',
                score: 0,
                glossary: ['Japan'],
                sequence: 100,
            }],
            [2, {
                id: 2,
                dictionary: 'JMdict',
                expression: '日本',
                reading: 'にっぽん',
                definitionTags: '',
                termTags: '',
                rules: '',
                score: 0,
                glossary: ['Japan'],
                sequence: 101,
            }],
        ]));
        Reflect.set(database, '_fetchTermRowsByIds', fetchTermRowsByIds);

        const results = await database.findTermsExactBulk([{term: '日本', reading: 'にほん'}], new Set(['JMdict']));

        expect([...fetchTermRowsByIds.mock.calls[0][0]]).toEqual([1]);
        expect(results).toHaveLength(1);
        expect(results[0].term).toBe('日本');
    });
});

describe('TermRecordOpfsStore batch dictionary indexes', () => {
    test('builds multiple missing dictionary indexes with one record pass', () => {
        const store = new TermRecordOpfsStore();
        const recordsById = Reflect.get(store, '_recordsById');
        recordsById.set(1, {
            id: 1,
            dictionary: 'JMdict',
            expression: '日本',
            reading: 'にほん',
            entryContentOffset: 10,
            entryContentLength: 5,
            entryContentDictName: 'raw',
            score: 1,
            sequence: 100,
        });
        recordsById.set(2, {
            id: 2,
            dictionary: 'Jitendex',
            expression: '日本',
            reading: 'にほん',
            entryContentOffset: 20,
            entryContentLength: 5,
            entryContentDictName: 'raw',
            score: 2,
            sequence: 200,
        });
        recordsById.set(3, {
            id: 3,
            dictionary: 'Other',
            expression: '猫',
            reading: 'ねこ',
            entryContentOffset: 30,
            entryContentLength: 5,
            entryContentDictName: 'raw',
            score: 3,
            sequence: 300,
        });

        store.ensureDictionaryIndexes(['JMdict', 'Jitendex']);

        const jmdict = store.getDictionaryIndex('JMdict');
        const jitendex = store.getDictionaryIndex('Jitendex');
        expect(jmdict.expression.get('日本')).toEqual([1]);
        expect(jmdict.reading.get('にほん')).toEqual([1]);
        expect(jmdict.sequence.get(100)).toEqual([1]);
        expect(jitendex.expression.get('日本')).toEqual([2]);
        expect(jitendex.reading.get('にほん')).toEqual([2]);
        expect(jitendex.sequence.get(200)).toEqual([2]);
        expect(Reflect.get(store, '_indexByDictionary').has('Other')).toBe(false);
    });
});
