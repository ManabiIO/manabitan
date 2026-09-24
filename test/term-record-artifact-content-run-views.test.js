/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {expect, test} from 'vitest'
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js'

test('mixed artifact content descriptor runs borrow typed numeric columns', async () => {
    const count = 30_001
    const split = 20_000
    const emptyBytes = new Uint8Array(0)
    const expressionBytesList = new Array(count).fill(emptyBytes)
    const readingBytesList = new Array(count).fill(emptyBytes)
    const readingEqualsExpressionList = new Uint8Array(count)
    const scoreList = new Float64Array(count)
    const sequenceList = new Int32Array(count)
    const contentOffsets = new Float64Array(count)
    const contentLengths = new Uint32Array(count)
    const contentDictNames = new Array(count).fill('raw-v2')
    contentDictNames.fill('raw-v6', split)

    const store = new TermRecordOpfsStore()
    Reflect.set(store, '_importSessionActive', true)
    Reflect.set(store, '_nextId', 0)
    Reflect.set(store, '_nextIdReady', true)
    Reflect.set(store, '_ensureNextIdReadyForAppend', async () => {})
    Reflect.set(store, '_getOrCreateShardState', async () => ({}))

    /** @type {Array<{chunk: import('core').SafeAny, offsets: import('core').SafeAny, lengths: import('core').SafeAny, contentDictName: string}>} */
    const observed = []
    Reflect.set(store, '_encodeAndAppendArtifactChunkForState', async (
        _state,
        chunk,
        _firstId,
        offsets,
        lengths,
        _preinternedPlan,
        contentDictName,
    ) => {
        observed.push({chunk, offsets, lengths, contentDictName})
        return {
            encodeMs: 0,
            appendWriteMs: 0,
            validationMs: 0,
            recordFieldEncodeMs: 0,
            lookupIndexEncodeMs: 0,
        }
    })

    await store.appendBatchFromArtifactChunkResolvedContent(
        {
            dictionary: 'test',
            dictionaryTotalRows: 1_000_000,
            rowCount: count,
            expressionBytesList,
            readingBytesList,
            readingEqualsExpressionList,
            scoreList,
            sequenceList,
        },
        contentOffsets,
        contentLengths,
        contentDictNames,
    )

    expect(observed).toHaveLength(2)
    expect(observed.map(({chunk}) => chunk.rowCount)).toEqual([split, count - split])
    expect(observed.map(({contentDictName}) => contentDictName).toEqual(['raw-v2', 'raw-v6']))

    for (const {chunk, offsets, lengths} of observed) {
        expect(chunk.expressionBytesList).not.toBe(expressionBytesList)
        expect(chunk.readingBytesList).not.toBe(readingBytesList)
        expect(chunk.readingEqualsExpressionList.buffer).toBe(readingEqualsExpressionList.buffer)
        expect(chunk.scoreList.buffer).toBe(scoreList.buffer)
        expect(chunk.sequenceList.buffer).toBe(sequenceList.buffer)
        expect(offsets.buffer).toBe(contentOffsets.buffer)
        expect(lengths.buffer).toBe(contentLengths.buffer)
    }

    expect(observed[1].chunk.scoreList.byteOffset)
        .toBe(scoreList.byteOffset + split * Float64Array.BYTES_PER_ELEMENT)
    expect(observed[1].offsets.byteOffset)
        .toBe(contentOffsets.byteOffset + split * Float64Array.BYTES_PER_ELEMENT)
})
