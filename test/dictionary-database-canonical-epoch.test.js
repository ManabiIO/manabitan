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

/** @typedef {Parameters<DictionaryDatabase['_bulkAddArtifactTermsChunkWithContentDedup']>[0]} ArtifactChunk */
/** @typedef {NonNullable<ArtifactChunk['contentDedupPlan']>} ContentPlan */

/**
 * @returns {{database: DictionaryDatabase, chunk: ArtifactChunk, plan: ContentPlan}}
 */
function createFixture() {
    const database = new DictionaryDatabase();
    const plan = /** @type {ContentPlan} */ ({
        uniqueCount: 3,
        sourceRowCount: 4,
        uniqueRowIndexes: new Uint32Array([0, 2, 3]),
        resolvedFlags: new Uint8Array(3),
        resolvedOffsets: new Float64Array(3),
        resolvedLengths: new Uint32Array(3),
        resolvedDictNames: null,
        pendingEpochs: new Uint32Array([7, 7, 7]),
        pendingIndexes: new Uint32Array([99, 98, 97]),
        nextEpoch: 8,
        persistedLookupRequired: true,
    });
    const chunk = /** @type {ArtifactChunk} */ ({
        dictionary: 'Test dictionary',
        rowCount: 4,
        contentRowStart: 0,
        expressionBytesList: [],
        readingBytesList: [],
        readingEqualsExpressionList: new Uint8Array(4),
        scoreList: new Int32Array(4),
        sequenceList: new Int32Array([-1, -1, -1, -1]),
        contentBytesList: [],
        contentHash1List: new Uint32Array(0),
        contentHash2List: new Uint32Array(0),
        contentBytesBuffer: new Uint8Array([1, 2, 3]),
        contentBytesBaseOffset: 0,
        contentMetaList: new Uint32Array([0, 1, 10, 20, 0, 1, 10, 20, 1, 1, 30, 40, 2, 1, 50, 60]),
        contentUniqueIndexList: new Uint32Array([0, 0, 1, 2]),
        contentDedupPlan: plan,
        contentDictNameList: null,
        uniformContentDictName: 'raw-v6',
        termRecordPreinternedPlan: null,
    });
    return {database, chunk, plan};
}

/**
 * @param {DictionaryDatabase} database
 * @param {ArtifactChunk} chunk
 * @param {boolean} canonical
 * @returns {ReturnType<DictionaryDatabase['_resolveArtifactTermContentDedup']>}
 */
async function resolve(database, chunk, canonical) {
    return await Reflect.get(database, '_resolveArtifactTermContentDedup').call(database, {
        ...chunk,
        contentRowStart: canonical ? chunk.contentRowStart : void 0,
    });
}

describe('canonical content plans across generic scans', () => {
    test.each([false, true])('preserves pending grouping when the first scan is canonical=%s', async (canonicalFirst) => {
        const {database, chunk, plan} = createFixture();
        for (const canonical of [canonicalFirst, !canonicalFirst, canonicalFirst]) {
            const beforeEpoch = plan.nextEpoch;
            const result = await resolve(database, chunk, canonical);
            expect(result.pendingContentCount).toBe(3);
            expect(result.pendingHitCount).toBe(1);
            expect([...result.pendingContentHash1s]).toEqual([10, 30, 50]);
            expect([...result.pendingContentHash2s]).toEqual([20, 40, 60]);
            expect(result.pendingPlanUniqueIndexes).toEqual([0, 1, 2]);
            expect(result.pendingContentSpans?.lengths).toEqual(new Uint32Array([1, 1, 1]));
            if (!canonical) {
                expect(result.pendingRowToUniqueIndex).toEqual(new Int32Array([0, 0, 1, 2]));
            }
            expect(plan.nextEpoch).toBe(beforeEpoch + 1);
            expect(plan.resolvedFlags).toEqual(new Uint8Array(3));
        }
    });

    test('keeps epoch wrap safe across generic, canonical and generic scans', async () => {
        const {database, chunk, plan} = createFixture();
        plan.nextEpoch = 0xffffffff;
        await resolve(database, chunk, false);
        expect(plan.nextEpoch).toBe(0);
        const canonical = await resolve(database, chunk, true);
        expect(plan.nextEpoch).toBe(2);
        expect(canonical.pendingPlanUniqueIndexes).toEqual([0, 1, 2]);
        const generic = await resolve(database, chunk, false);
        expect(plan.nextEpoch).toBe(3);
        expect(generic.pendingContentCount).toBe(3);
        expect(generic.pendingHitCount).toBe(1);
        expect(generic.pendingRowToUniqueIndex).toEqual(new Int32Array([0, 0, 1, 2]));
    });

    test.each(['content', 'records'])('restores collision journals after %s failure and allows generic scan plus retry', async (failureStage) => {
        const {database, chunk, plan} = createFixture();
        Reflect.set(database, '_bulkImportTransactionOpen', true);
        Reflect.set(database, '_termRecordStore', {prepareArtifactChunkLookupIndexes: () => null});
        // Two distinct canonical contents deliberately share an existing hash
        // pair. Exact bytes must reject the old primary and retain both misses.
        chunk.contentMetaList?.set([10, 20], 10);
        Reflect.get(database, '_cacheTermEntryContentMeta').call(database, null, 7, 1, 'raw-v6', 0, 10, 20);
        Reflect.set(database, '_readTermEntryContentBytesDetailed', async () => ({status: 'ok', bytes: new Uint8Array([99])}));
        const failure = new Error(`injected ${failureStage} failure`);
        const persistImplementation = /** @type {DictionaryDatabase['_persistArtifactTermContent']} */ (async (_dictionary, _bytes, _names, _uniform, spans) => {
            if (spans === null) { throw new Error('Expected canonical content spans'); }
            return {
                pendingOffsets: Float64Array.from(spans.offsets, (_offset, index) => 100 + index * 10),
                pendingLengths: new Uint32Array(spans.lengths),
                pendingResolvedDictNames: 'raw-v6',
                blockProfile: null,
            };
        });
        const persist = vi.fn(persistImplementation);
        const appendRecords = vi.fn(async () => {});
        if (failureStage === 'content') {
            persist.mockRejectedValueOnce(failure);
        } else {
            appendRecords.mockRejectedValueOnce(failure);
        }
        Reflect.set(database, '_persistArtifactTermContent', persist);
        Reflect.set(database, '_appendResolvedArtifactTermRecords', appendRecords);
        const bulkAdd = Reflect.get(database, '_bulkAddArtifactTermsChunkWithContentDedup').bind(database);

        await expect(bulkAdd(chunk)).rejects.toBe(failure);
        expect(plan.resolvedFlags).toEqual(new Uint8Array(3));
        expect(plan.resolvedOffsets).toEqual(new Float64Array(3));
        expect(plan.resolvedLengths).toEqual(new Uint32Array(3));
        expect(Reflect.get(database, '_termEntryContentMetaHashPairPendingCount')).toBe(0);
        expect(Reflect.get(database, '_termEntryContentMetaHashPairCount')).toBe(1);
        expect(Reflect.get(database, '_termEntryContentMetaCollisionsByHashPair').size).toBe(0);
        expect(Reflect.get(database, '_getTermEntryContentMetaByHashPair').call(database, 10, 20)?.offset).toBe(7);

        const generic = await resolve(database, chunk, false);
        expect(generic.pendingContentCount).toBe(3);
        expect(generic.pendingRowToUniqueIndex).toEqual(new Int32Array([0, 0, 1, 2]));
        await bulkAdd(chunk);
        expect(plan.resolvedFlags).toEqual(new Uint8Array([1, 1, 1]));
        // Direct misses precede the failed-exact wave in canonical publication.
        expect(plan.resolvedOffsets).toEqual(new Float64Array([110, 120, 100]));
        expect(plan.resolvedLengths).toEqual(new Uint32Array([1, 1, 1]));
        expect(Reflect.get(database, '_termEntryContentMetaHashPairPendingCount')).toBe(0);
        expect(Reflect.get(database, '_termEntryContentMetaHashPairCount')).toBe(2);
        expect(Reflect.get(database, '_termEntryContentMetaCollisionsByHashPair').get('10:20')?.map((/** @type {{offset: number}} */ meta) => meta.offset)).toEqual([110, 120]);
    });
});
