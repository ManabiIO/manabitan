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

describe('DictionaryDatabase term content dedup metadata cache', () => {
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
        Reflect.set(database, '_termContentStore', {
            ensureLoadedForRead: vi.fn(async () => {}),
            warmSlices: vi.fn(async () => {}),
        });
        Reflect.set(database, '_termRecordStore', {getByIds});
        const fetchTermRowsByIds = /** @type {(this: DictionaryDatabase, ids: Iterable<number>) => Promise<Map<number, unknown>>} */ (
            Reflect.get(database, '_fetchTermRowsByIds')
        );

        const firstRows = await fetchTermRowsByIds.call(database, [1]);
        const secondRows = await fetchTermRowsByIds.call(database, [1]);

        expect(getByIds).toHaveBeenCalledTimes(1);
        expect(firstRows.get(1)).toBe(secondRows.get(1));

        Reflect.get(database, '_clearDirectTermIndexCaches').call(database);
        await fetchTermRowsByIds.call(database, [1]);

        expect(getByIds).toHaveBeenCalledTimes(2);
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
        Reflect.set(database, '_termContentStore', {readSlice: vi.fn(async () => firstBytes)});

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
        Reflect.set(database, '_termContentStore', {readSlice: vi.fn(async () => persistedBytes)});

        cache(null, 10, persistedBytes.byteLength, 'raw', 0, 123, 456);

        const result = findMatching(123, 456, collidingBytes);
        expect(result).toBeInstanceOf(Promise);
        await expect(result).resolves.toBeUndefined();
    });

    test('returns synchronously when a hash pair has no persisted candidate', () => {
        const database = new DictionaryDatabase();
        const findMatching = Reflect.get(database, '_findMatchingTermEntryContentMeta').bind(database);

        const result = findMatching(123, 456, new Uint8Array([1, 2, 3]));

        expect(result).toBeUndefined();
    });

    test('parses string content hashes into the numeric cache and clears both indexes', () => {
        const database = new DictionaryDatabase();
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
    });
});

describe('DictionaryDatabase artifact term content dedup import', () => {
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
                    wasmEncodeMs: 0,
                };
            }),
        });
        const getMetaOriginal = /** @type {(this: DictionaryDatabase, hash1: number, hash2: number) => unknown} */ (
            Reflect.get(database, '_getTermEntryContentMetaByHashPair')
        );
        const getMetaSpy = vi.fn(function (hash1, hash2) {
            return getMetaOriginal.call(database, hash1, hash2);
        });
        Reflect.set(database, '_getTermEntryContentMetaByHashPair', getMetaSpy);

        const bulkAddArtifactTermsChunkWithContentDedup = /** @type {(this: DictionaryDatabase, chunk: unknown) => Promise<void>} */ (
            Reflect.get(database, '_bulkAddArtifactTermsChunkWithContentDedup')
        );
        const makeChunk = (contentBytesList, hash1List, hash2List) => ({
            dictionary: 'dedup-test',
            rowCount: contentBytesList.length,
            dictionaryTotalRows: contentBytesList.length,
            expressionBytesList: contentBytesList.map((_, index) => new TextEncoder().encode(`term-${index}`)),
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
        expect(getMetaSpy).toHaveBeenCalled();
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
            pair: new Map(),
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
                pair: new Map(),
                sequence: new Map(),
            }],
            ['Jitendex', {
                expression: new Map([['日本', [2]]]),
                reading: new Map(),
                expressionReverse: new Map(),
                readingReverse: new Map(),
                pair: new Map(),
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

    test('warms exact lookup storage without eagerly sorting prefix indexes', async () => {
        const database = new DictionaryDatabase();
        const index = {
            expression: new Map([['日本', [1]]]),
            reading: new Map([['にほん', [1]]]),
            expressionReverse: new Map(),
            readingReverse: new Map(),
            pair: new Map(),
            sequence: new Map(),
        };
        Reflect.set(database, '_termContentStore', {ensureLoadedForRead: vi.fn(async () => {})});
        Reflect.set(database, '_termRecordStore', {
            ensureDictionariesLoaded: vi.fn(async () => {}),
            getDictionaryIndex: vi.fn(() => index),
        });
        Reflect.set(database, '_warmSharedGlossaryArtifacts', vi.fn(async () => {}));
        Reflect.set(database, '_warmLookupProbeTerms', vi.fn(async () => {}));
        const getSortedTermIndexKeys = vi.fn(() => []);
        Reflect.set(database, '_getSortedTermIndexKeys', getSortedTermIndexKeys);

        await database.warmTermLookupCaches(['JMdict']);

        expect(Reflect.get(database, '_termContentStore').ensureLoadedForRead).toHaveBeenCalledOnce();
        expect(Reflect.get(database, '_termRecordStore').ensureDictionariesLoaded).toHaveBeenCalledWith(['JMdict']);
        expect(Reflect.get(database, '_warmSharedGlossaryArtifacts')).toHaveBeenCalledWith(['JMdict']);
        expect(Reflect.get(database, '_warmLookupProbeTerms')).toHaveBeenCalledWith(['JMdict']);
        expect(getSortedTermIndexKeys).not.toHaveBeenCalled();
    });

    test('exact term-reading lookup builds pair indexes on demand', async () => {
        const database = new DictionaryDatabase();
        Reflect.set(database, '_db', {});
        const index = {
            expression: new Map([['日本', [1]]]),
            reading: new Map([['にほん', [1]]]),
            expressionReverse: new Map(),
            readingReverse: new Map(),
            pair: new Map([['日本\u001fにほん', [1]]]),
            sequence: new Map(),
        };
        const ensureDictionariesLoaded = vi.fn(async () => {});
        const ensureDictionaryIndexes = vi.fn();
        const ensureDictionaryPairIndex = vi.fn();
        const getDictionaryIndex = vi.fn(() => index);
        Reflect.set(database, '_termRecordStore', {ensureDictionariesLoaded, ensureDictionaryIndexes, ensureDictionaryPairIndex, getDictionaryIndex});
        Reflect.set(database, '_fetchTermRowsByIds', vi.fn(async () => new Map([[1, {
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
        }]])));

        const results = await database.findTermsExactBulk([{term: '日本', reading: 'にほん'}], new Set(['JMdict']));

        expect(ensureDictionaryPairIndex).toHaveBeenCalledOnce();
        expect(ensureDictionaryPairIndex).toHaveBeenCalledWith('JMdict', index);
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
