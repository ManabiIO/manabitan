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
        expect(termRecordCalls).toHaveLength(2);
        expect(termRecordCalls[0].contentOffsets[0]).toBe(termRecordCalls[0].contentOffsets[1]);
        expect(termRecordCalls[0].contentLengths).toEqual([3, 3, 2]);
        expect(termRecordCalls[0].contentDictNames).toBe('raw');
        expect(termRecordCalls[1].contentOffsets).toEqual([termRecordCalls[0].contentOffsets[0]]);
        expect(termRecordCalls[1].contentLengths).toEqual([3]);
        expect(termRecordCalls[1].contentDictNames).toBe('raw');
    });
});
