/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

import {prepareTermLookupIndexesFromPreinternedPlan} from '../../ext/js/dictionary/term-lookup-index-preparation.js'
import {registerOwnedTermLookupIndexes} from '../../ext/js/dictionary/term-lookup-index-ownership.js'
import {TermRecordOpfsStore} from '../../ext/js/dictionary/term-record-opfs-store.js'

/**
 * @param {number} [rowCount=128]
 * @param {number} [score=0]
 * @param {boolean} [owned=true]
 * @returns {Promise<{chunk: import('../../ext/js/dictionary/term-bank-wasm-parser.js').TermBankColumnChunk, prepared: import('../../ext/js/dictionary/term-lookup-index-preparation.js').PreparedTermLookupIndex, store: TermRecordOpfsStore, encoded: Awaited<ReturnType<TermRecordOpfsStore['_encodeArtifactChunkRecords']>>, expected: Uint8Array, adopt: () => import('../../ext/js/dictionary/term-record-import-index-chunk.js').ImportIndexChunk}>}
 * @throws {Error} If the fixture cannot produce a complete lookup index.
 */
export async function createImportIndexChunkFixture(rowCount = 128, score = 0, owned = true) {
    /** @type {import('../../ext/js/dictionary/term-bank-wasm-parser.js').TermBankColumnChunk} */
    let chunk = {
        rowCount,
        expressionBytesList: [],
        readingBytesList: [],
        readingEqualsExpressionList: new Uint8Array(rowCount),
        scoreList: Number.isInteger(score) ? new Int32Array(rowCount).fill(score) : new Float64Array(rowCount).fill(score),
        sequenceList: new Int32Array(rowCount).fill(1),
        termRecordPreinternedPlan: {
            stringLengths: Uint16Array.of(9, 6),
            stringOffsets: Uint32Array.of(0, 9),
            stringsBuffer: new TextEncoder().encode('同じ語よみ'),
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
    if (owned) { registerOwnedTermLookupIndexes(chunk) }
    const prepared = chunk.preparedLookupIndexes?.get(`0:${rowCount}`)
    if (!prepared) { throw new Error('Expected complete fixture index') }
    const store = new TermRecordOpfsStore()
    store.setRawTermBankSourceBytes(1024 ** 3)
    Reflect.set(store, '_importSessionActive', true)
    const recordChunk = {dictionary: 'Envelope parity', ...chunk}
    const offsets = Float64Array.from({length: rowCount}, (_, i) => 2 ** 40 + i * 16)
    const lengths = new Uint32Array(rowCount).fill(8)
    const encoded = await store._encodeArtifactChunkRecords(
        recordChunk,
        offsets,
        lengths,
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
        prepared,
    )
    return {chunk, prepared, store, encoded, expected, adopt}
}
