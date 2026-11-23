/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test, vi} from 'vitest'
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js'

/** @typedef {Parameters<TermRecordOpfsStore['_encodeAndAppendArtifactChunkForState']>[1]} ArtifactChunk */
/** @typedef {NonNullable<ArtifactChunk['resolvedContentReferences']>} References */

/**
 * @param {number[]} [offsets]
 * @param {number[]} [lengths]
 * @returns {ArtifactChunk}
 */
function createChunk(offsets = [16, 16, 0x100000010], lengths = [7, 7, 9]) {
    const count = offsets.length
    return {
        dictionary: 'Resolved run validation',
        rowCount: count,
        expressionBytesList: Array.from({length: count}, (_, i) => new TextEncoder().encode(`word-${i}`)),
        readingBytesList: [],
        readingEqualsExpressionList: new Uint8Array(count).fill(1),
        scoreList: new Int32Array(count).fill(2),
        sequenceList: new Int32Array(count).fill(-1),
        resolvedContentReferences: {
            uniqueIndexList: Uint32Array.from({length: count}, (_, i) => i),
            offsets: Float64Array.from(offsets),
            lengths: Uint32Array.from(lengths),
        },
    }
}

/**
 * Capture the actual serialized sidecar bytes at the persistence boundary.
 * @param {ArtifactChunk} chunk
 * @param {number[]} [offsets]
 * @param {number[]} [lengths]
 * @param {(appendCount: number) => Promise<void>|void} [afterAppend]
 * @returns {Promise<Uint8Array[]>}
 * @throws {Error} If encoding does not supply the fields expected at the persistence boundary.
 */
async function encodeRuns(chunk, offsets = [], lengths = [], afterAppend = () => {}) {
    const store = new TermRecordOpfsStore()
    /** @type {Uint8Array[]} */
    const bytes = []
    vi.spyOn(store, '_appendEncodedChunk').mockImplementation(async (_state, firstId, count, _name, base = 0, payload = null, fields = null, format = 1) => {
        if (payload === null || fields === null) { throw new Error('Missing encoded fields') }
        bytes.push(store._createLookupIndexChunk(firstId, count, base, payload, fields, format))
        await afterAppend(bytes.length)
    })
    await store._encodeAndAppendArtifactChunkForState(
        /** @type {Parameters<TermRecordOpfsStore['_encodeAndAppendArtifactChunkForState']>[0]} */ ({}),
        chunk,
        1,
        offsets,
        lengths,
    )
    return bytes
}

describe('resolved content run validation', () => {
    test.each(['compact', 'legacy', 'float64'])('matches generic sidecar bytes across offset splits (%s)', async (format) => {
        const offsets = Array.from({length: 32}, (_, i) => (i < 16 ? (i === 1 ? -1 : 16) : 0x100000010 + i * 16))
        const lengths = offsets.map(() => (format === 'legacy' ? 70000 : 7))
        const chunk = createChunk(offsets, lengths)
        if (format === 'float64') { chunk.scoreList = new Float64Array(offsets.length).fill(1.25) }
        const actual = await encodeRuns(chunk)
        const generic = {...chunk, resolvedContentReferences: void 0}
        expect(actual).toStrictEqual(await encodeRuns(generic, offsets, lengths))
        expect(actual).toHaveLength(2)
        const expectedFormat = format === 'compact' ? 2 : (format === 'legacy' ? 1 : 3)
        expect(actual.map((bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(36, true))).toStrictEqual([expectedFormat, expectedFormat])
    })

    /** @type {Array<{name: string, change: (references: References) => void, error: string}>} */
    const malformed = [
        {name: 'offset bounds', change: (references) => { references.offsets = new Float64Array(1) }, error: 'Invalid resolved term content reference index: 1'},
        {name: 'length bounds', change: (references) => { references.lengths = new Uint32Array(1) }, error: 'Invalid resolved term content reference index: 1'},
        {name: 'missing row index', change: (references) => { references.uniqueIndexList = new Uint32Array(1) }, error: 'Invalid term content offset: undefined'},
        {name: 'invalid row index', change: (references) => { references.uniqueIndexList[0] = 0xffffffff }, error: 'Invalid resolved term content reference index: 4294967295'},
        {name: 'fractional offset', change: (references) => { references.offsets[0] = 0.5 }, error: 'Invalid term content offset: 0.5'},
        {name: 'negative offset', change: (references) => { references.offsets[0] = -2 }, error: 'Invalid term content offset: -2'},
        {name: 'unsafe offset', change: (references) => { references.offsets[0] = Number.MAX_SAFE_INTEGER + 1 }, error: 'Invalid term content offset: 9007199254740992'},
        {name: 'reserved length', change: (references) => { references.lengths[0] = 0xffffffff }, error: 'Invalid term content length: 4294967295'},
    ]
    test.each(malformed)('preserves $name failure', async ({change, error}) => {
        const chunk = createChunk([16, 32], [7, 9])
        const references = chunk.resolvedContentReferences
        if (typeof references === 'undefined') { throw new Error('Missing fixture references') }
        change(references)
        await expect(encodeRuns(chunk)).rejects.toThrow(error)
    })

    test('preserves the fixed-length override even with a short reference length table', async () => {
        const chunk = createChunk([16, 32], [0xffffffff])
        chunk.fixedContentLength = 7
        const actual = await encodeRuns(chunk)
        expect(actual).toStrictEqual(await encodeRuns({...chunk, resolvedContentReferences: void 0}, [16, 32], []))
    })

    test('preserves a complete fixed span over invalid references', async () => {
        const chunk = createChunk([0.5, -2], [])
        chunk.fixedContentOffsetBase = 1024
        chunk.fixedContentLength = 7
        expect(await encodeRuns(chunk)).toStrictEqual(await encodeRuns({...chunk, resolvedContentReferences: void 0}))
    })

    test('reselects references after an awaited append changes the next run', async () => {
        const offsets = [0, 0x100000000, 16]
        const lengths = [4, 5, 6]
        const chunk = createChunk(offsets, lengths)
        const actual = await encodeRuns(chunk, [], [], async (count) => {
            if (count !== 1) { return }
            await Promise.resolve()
            chunk.resolvedContentReferences = {
                uniqueIndexList: Uint32Array.of(0, 1, 2),
                offsets: Float64Array.of(0, 100, 110),
                lengths: Uint32Array.from(lengths),
            }
        })
        const generic = {...createChunk(offsets, lengths), resolvedContentReferences: void 0}
        const expected = await encodeRuns(generic, offsets, lengths, async (count) => {
            if (count !== 1) { return }
            await Promise.resolve()
            offsets[1] = 100
            offsets[2] = 110
        })
        expect(actual).toStrictEqual(expected)
        expect(actual).toHaveLength(2)
    })

    test('preserves generic shared-reference handling', async () => {
        const chunk = createChunk([16, 32], [7, 9])
        const references = chunk.resolvedContentReferences
        if (typeof references === 'undefined') { throw new Error('Missing fixture references') }
        const indexes = new Uint32Array(new SharedArrayBuffer(references.uniqueIndexList.byteLength))
        indexes.set(references.uniqueIndexList)
        references.uniqueIndexList = indexes
        expect(await encodeRuns(chunk)).toStrictEqual(await encodeRuns({...chunk, resolvedContentReferences: void 0}, [16, 32], [7, 9]))
    })
})
