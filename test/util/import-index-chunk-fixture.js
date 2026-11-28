/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

import {prepareTermLookupIndexesFromPreinternedPlan} from '../../ext/js/dictionary/term-lookup-index-preparation.js'
import {prepareImportIndexChunkParts} from '../../ext/js/dictionary/term-record-import-index-chunk.js'
import {createArtifactTermRecordChunkWithResolvedContent, TermRecordOpfsStore} from '../../ext/js/dictionary/term-record-opfs-store.js'

/**
 * @param {number} [rowCount=128]
 * @param {number} [score=0]
 * @param {string} [expression="同じ語"]
 * @returns {Promise<{chunk: import('../../ext/js/dictionary/term-bank-wasm-parser.js').TermBankColumnChunk, prepared: import('../../ext/js/dictionary/term-lookup-index-preparation.js').PreparedTermLookupIndex, consumer: import('../../ext/js/dictionary/term-bank-wasm-parser.js').TermBankColumnChunk & {dictionary: string, dictionaryTotalRows: number, resolvedContentReferences: {uniqueIndexList: Uint32Array, offsets: Float64Array, lengths: Uint32Array}}, store: TermRecordOpfsStore, encoded: Awaited<ReturnType<TermRecordOpfsStore['_encodeArtifactChunkRecords']>>, expected: Uint8Array, adopt: () => import('../../ext/js/dictionary/term-record-opfs-store.js').PendingLookupIndexChunk}>}
 * @throws {Error} If the fixture cannot produce a complete lookup index.
 */
export async function createImportIndexChunkFixture(rowCount = 128, score = 0, expression = '同じ語') {
    const expressionLength = new TextEncoder().encode(expression).byteLength
    /** @type {import('../../ext/js/dictionary/term-bank-wasm-parser.js').TermBankColumnChunk} */
    let chunk = {
        rowCount,
        expressionBytesList: [],
        readingBytesList: [],
        readingEqualsExpressionList: new Uint8Array(rowCount),
        scoreList: Number.isInteger(score) ? new Int32Array(rowCount).fill(score) : new Float64Array(rowCount).fill(score),
        sequenceList: new Int32Array(rowCount).fill(1),
        termRecordPreinternedPlan: {
            stringLengths: Uint16Array.of(expressionLength, 6),
            stringOffsets: Uint32Array.of(0, expressionLength),
            stringsBuffer: new TextEncoder().encode(`${expression}よみ`),
            expressionIndexes: new Uint32Array(rowCount),
            readingIndexes: new Uint32Array(rowCount).fill(1),
        },
        contentBytesList: [],
        contentHash1List: new Uint32Array(0),
        contentHash2List: new Uint32Array(0),
        contentUniqueIndexList: null,
        contentDedupPlan: null,
        mediaRows: [],
    }
    const result = prepareTermLookupIndexesFromPreinternedPlan(chunk)
    if (result === null) { throw new Error('Expected prepared fixture index') }
    chunk.preparedLookupIndexes = result.indexes
    // Worker-message cloning preserves the actual cross-field alias graph.
    chunk = structuredClone(chunk)
    const prepared = chunk.preparedLookupIndexes?.get(`0:${rowCount}`)
    if (!prepared) { throw new Error('Expected complete fixture index') }
    const store = new TermRecordOpfsStore()
    store.setRawTermBankSourceBytes(1024 ** 3)
    Reflect.set(store, '_importSessionActive', true)
    const offsets = Float64Array.from({length: rowCount}, (_, i) => 2 ** 40 + i * 16)
    const lengths = new Uint32Array(rowCount).fill(8)
    const consumer = createArtifactTermRecordChunkWithResolvedContent(
        {dictionary: 'Envelope parity', dictionaryTotalRows: 528299, ...chunk},
        Uint32Array.from({length: rowCount}, (_, i) => i),
        offsets,
        lengths,
    )
    const encoded = await store._encodeArtifactChunkRecords(
        consumer,
        new Float64Array(0),
        new Uint32Array(0),
        prepared.preinternedPlan,
        prepared.bytes,
    )
    const expected = store._createLookupIndexChunk(
        1,
        rowCount,
        encoded.contentOffsetBase,
        encoded.lookupIndexBytes,
        encoded.recordFields,
        encoded.recordFieldsFormat,
    )
    const adopt = () => store._createPendingLookupIndexChunk(
        1,
        rowCount,
        encoded.contentOffsetBase,
        encoded.lookupIndexBytes,
        encoded.recordFields,
        encoded.recordFieldsFormat,
    )
    return {chunk, prepared, consumer, store, encoded, expected, adopt}
}

/**
 * @param {import('../../ext/js/dictionary/term-record-opfs-store.js').PendingLookupIndexChunk[]} chunks
 * @returns {Uint8Array[]}
 */
export function getImportIndexChunkParts(chunks) {
    return prepareImportIndexChunkParts(chunks)
}
