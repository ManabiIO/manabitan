/*
 * Copyright (C) 2026  Yomitan Authors
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

import {NativeTermRecordImportOwner, registerReceivedNativeTermRecordChunk} from '../../ext/js/dictionary/native-term-record-ownership.js';
import {createTermRecordPreinternedPlanBuilder} from '../../ext/js/dictionary/term-record-preinterned-plan.js';
import {prepareTermLookupIndexesFromPreinternedPlan} from '../../ext/js/dictionary/term-lookup-index-preparation.js';
import {createArtifactTermRecordChunkWithResolvedContent} from '../../ext/js/dictionary/term-record-opfs-store.js';

/** @typedef {import('../../ext/js/dictionary/dictionary-database.js').ArtifactTermRecordChunk} RecordChunk */

/**
 * Builds actual prepared lookup bytes with private native-shaped columns.
 * The registration below stands in for the known worker receiver in unit tests.
 * @param {{rawEntries?: number, rawLength?: number}} [options]
 * @returns {{source: RecordChunk, rawBytes: Uint8Array}}
 */
export function createNativeRecordFixture({rawEntries = 1, rawLength = 8} = {}) {
    const count = rawEntries + 1;
    const builder = createTermRecordPreinternedPlanBuilder(count);
    const encoder = new TextEncoder();
    for (let index = 0; index < count; ++index) { builder.internStringBytes(encoder.encode(`term${index}`)); }
    const keyIndexes = Uint32Array.from({length: count}, (_, index) => index);
    const plan = builder.buildPlan(keyIndexes, new Uint32Array(keyIndexes));
    const rawBytes = new Uint8Array(rawLength);
    rawBytes.set([0x4d, 0x42, 0x52, 0x36]);
    const source = {
        dictionary: 'Alias fixture',
        rowCount: count,
        contentRowStart: 0,
        dictionaryTotalRows: count,
        expressionBytesList: [],
        readingBytesList: [],
        readingEqualsExpressionList: new Uint8Array(count).fill(1),
        scoreList: new Int32Array(count),
        sequenceList: new Int32Array(count).fill(-1),
        termRecordPreinternedPlan: plan,
        contentUniqueIndexList: new Uint32Array(keyIndexes),
        contentBytesList: [],
        contentHash1List: new Uint32Array(count),
        contentHash2List: new Uint32Array(count),
        contentDictNameList: null,
        useResolvedContentReferences: true,
        contentDedupPlan: {
            sourceRowCount: count,
            uniqueCount: count,
            uniqueRowIndexes: new Uint32Array(keyIndexes),
            resolvedFlags: new Uint8Array(count).fill(1),
            resolvedOffsets: Float64Array.from({length: count}, (_, index) => 100 + index * rawLength),
            resolvedLengths: new Uint32Array(count).fill(rawLength),
            resolvedDictNames: Array.from({length: count}, (_, index) => (index < rawEntries ? 'raw-v6' : 'raw-block-v2')),
            pendingEpochs: null,
            pendingIndexes: null,
            nextEpoch: 1,
        },
    };
    const prepared = prepareTermLookupIndexesFromPreinternedPlan(source);
    if (prepared === null || prepared.indexes.size !== 1) { throw new Error('Fixture did not produce a complete lookup index'); }
    return {source: {...source, preparedLookupIndexes: prepared.indexes}, rawBytes};
}

/**
 * @param {RecordChunk} source
 * @param {() => void} [validateOwner]
 * @returns {{owner: NativeTermRecordImportOwner, lease: object, chunk: RecordChunk, recordChunk: RecordChunk}}
 */
export function receiveNativeRecordFixture(source, validateOwner = () => {}) {
    if (!registerReceivedNativeTermRecordChunk(source)) { throw new Error('Fixture is not eligible for native ownership'); }
    const owner = new NativeTermRecordImportOwner(validateOwner);
    const chunk = {...source};
    const bound = owner.bind(source, chunk);
    const lease = owner.claim(chunk);
    if (bound === null || lease !== bound) { throw new Error('Fixture lease could not be claimed'); }
    const plan = /** @type {NonNullable<typeof chunk.contentDedupPlan>} */ (chunk.contentDedupPlan);
    const recordChunk = createArtifactTermRecordChunkWithResolvedContent(
        chunk,
        /** @type {Uint32Array} */ (chunk.contentUniqueIndexList),
        plan.resolvedOffsets,
        plan.resolvedLengths,
        chunk.preparedLookupIndexes,
    );
    return {owner, lease, chunk, recordChunk};
}

/** @returns {{promise: Promise<void>, resolve: () => void, reject: (reason: unknown) => void}} */
export function createNativeRecordGate() {
    return /** @type {ReturnType<typeof createNativeRecordGate>} */ (Promise.withResolvers());
}
