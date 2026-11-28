/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test, vi} from 'vitest'
import {createArtifactTermRecordChunkWithResolvedContent, TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js'

/** @typedef {Parameters<TermRecordOpfsStore['_encodeAndAppendArtifactChunkForState']>[1]} ArtifactChunk */

/**
 * @param {Uint32Array} indexes
 * @param {Float64Array} offsets
 * @param {Uint32Array} lengths
 * @returns {ArtifactChunk}
 */
function createChunk(indexes, offsets, lengths) {
    const count = indexes.length
    const expression = new TextEncoder().encode('辞書')
    return createArtifactTermRecordChunkWithResolvedContent(
        {
            dictionary: 'Private record run helper', rowCount: count,
            expressionBytesList: new Array(count).fill(expression),
            readingBytesList: new Array(count).fill(expression),
            readingEqualsExpressionList: new Uint8Array(count).fill(1),
            scoreList: new Int32Array(count), sequenceList: new Int32Array(count).fill(-1),
        },
        indexes, offsets, lengths,
    )
}

/** @returns {TermRecordOpfsStore} */
function createStore() {
    const store = new TermRecordOpfsStore()
    vi.spyOn(store, '_encodeArtifactChunkRecords').mockImplementation(async (_chunk, _offsets, _lengths, _plan, _lookup, base) => ({
        contentOffsetBase: base ?? 0, lookupIndexBytes: new Uint8Array(0), recordFields: new Uint8Array(0),
        recordFieldsFormat: 1, validationMs: 0, recordFieldEncodeMs: 0, lookupIndexEncodeMs: 0,
    }))
    vi.spyOn(store, '_appendEncodedChunk').mockResolvedValue()
    return store
}

/**
 * @param {TermRecordOpfsStore} store
 * @param {ArtifactChunk} chunk
 * @returns {ReturnType<TermRecordOpfsStore['_encodeAndAppendArtifactChunkForState']>}
 */
function encode(store, chunk) {
    return store._encodeAndAppendArtifactChunkForState(
        /** @type {Parameters<TermRecordOpfsStore['_encodeAndAppendArtifactChunkForState']>[0]} */ ({}),
        chunk, 1, new Float64Array(0), new Uint32Array(0),
    )
}

describe('private resolved-reference run validation', () => {
    test.each([
        [Uint32Array.of(0, 0, 2), Float64Array.of(16, Number.NaN), Uint32Array.of(7, 0xffffffff), 'Invalid resolved term content reference index: 2'],
        [Uint32Array.of(0, 0, 1), Float64Array.of(16, Number.NaN), Uint32Array.of(7, 0xffffffff), 'Invalid term content offset: NaN'],
        [Uint32Array.of(0, 0, 1), Float64Array.of(16, 16 + 0xffffffff), Uint32Array.of(7, 0xffffffff), 'Invalid term content length: 4294967295'],
    ])('rejects the first malformed value before accepting a prospective split row (%#)', async (indexes, offsets, lengths, message) => {
        const store = createStore()
        await expect(encode(store, createChunk(indexes, offsets, lengths))).rejects.toThrow(message)
        expect(store._encodeArtifactChunkRecords).not.toHaveBeenCalled()
        expect(store._appendEncodedChunk).not.toHaveBeenCalled()
    })

    test.each([[-0, 0], [0, -0]])('preserves a negative-zero minimum for private signed-zero columns (%#)', async (first, second) => {
        const chunk = createChunk(Uint32Array.of(0, 0, 1, 1), Float64Array.of(first, second), Uint32Array.of(0, 7))
        const store = createStore()
        await encode(store, chunk)
        expect(store._encodeArtifactChunkRecords).toHaveBeenCalledTimes(1)
        expect(Object.is(vi.mocked(store._encodeArtifactChunkRecords).mock.calls[0][5], -0)).toBe(true)
    })

    test('keeps the exact maximum offset delta and aliases on each side of a split', async () => {
        const chunk = createChunk(
            Uint32Array.of(0, 0, 1, 1, 2, 2),
            Float64Array.of(-0, 0xfffffffe, 0xffffffff), Uint32Array.of(0, 7, 9),
        )
        const store = createStore()
        await encode(store, chunk)
        const calls = vi.mocked(store._encodeArtifactChunkRecords).mock.calls
        expect(calls.map(([run]) => run.rowCount)).toEqual([4, 2])
        expect(Object.is(calls[0][5], -0)).toBe(true)
        expect(calls[1][5]).toBe(0xffffffff)
    })

    test('reacquires the reference origin after an awaited range split', async () => {
        const chunk = createChunk(Uint32Array.of(0, 0, 1, 1), Float64Array.of(16, 16 + 0xffffffff), Uint32Array.of(7, 9))
        const store = createStore()
        vi.mocked(store._appendEncodedChunk).mockImplementationOnce(async () => {
            await Promise.resolve()
            chunk.resolvedContentReferences = {
                uniqueIndexList: Uint32Array.of(0, 0, 1, 1), offsets: Float64Array.of(16, Number.NaN), lengths: Uint32Array.of(7, 9),
            }
        })
        await expect(encode(store, chunk)).rejects.toThrow('Invalid term content offset: NaN')
        expect(store._appendEncodedChunk).toHaveBeenCalledTimes(1)
        expect(vi.mocked(store._appendEncodedChunk).mock.calls[0][2]).toBe(2)
    })
})
