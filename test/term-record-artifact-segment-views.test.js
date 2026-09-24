/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test} from 'vitest'
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js'

describe('artifact record segment ownership', () => {
    test('borrows read-only typed columns while segmenting a large chunk', async () => {
        const count = 30_001
        const emptyBytes = new Uint8Array(0)
        const expressionBytesList = new Array(count).fill(emptyBytes)
        const readingBytesList = new Array(count).fill(emptyBytes)
        const readingEqualsExpressionList = new Uint8Array(count)
        const scoreList = new Float64Array(count)
        const sequenceList = new Int32Array(count)
        const contentOffsets = new Float64Array(count)
        const contentLengths = new Uint32Array(count)
        for (let i = 0; i < count; ++i) {
            scoreList[i] = i
            sequenceList[i] = i
            contentOffsets[i] = i
            contentLengths[i] = 1
        }

        const store = new TermRecordOpfsStore()
        /** @type {Array<{chunk: import('core').SafeAny, offsets: import('core').SafeAny, lengths: import('core').SafeAny}>} */
        const observed = []
        /**
         * @param {import('core').SafeAny} chunk
         * @param {import('core').SafeAny} offsets
         * @param {import('core').SafeAny} lengths
         */
        const encodeArtifactChunkRecords = async (chunk, offsets, lengths) => {
            observed.push({chunk, offsets, lengths})
            return {
                contentOffsetBase: offsets[0] ?? 0,
                lookupIndexBytes: new Uint8Array(0),
                recordFields: new Uint8Array(0),
                recordFieldsFormat: 0,
                validationMs: 0,
                recordFieldEncodeMs: 0,
                lookupIndexEncodeMs: 0,
            }
        }
        Reflect.set(store, '_encodeArtifactChunkRecords', encodeArtifactChunkRecords)
        Reflect.set(store, '_appendEncodedChunk', async () => {})

        const state = /** @type {Parameters<TermRecordOpfsStore['_encodeAndAppendArtifactChunkForState']>[0]} */ (
            /** @type {unknown} */ ({})
        )
        await Reflect.get(store, '_encodeAndAppendArtifactChunkForState').call(
            store,
            state,
            {
                dictionary: 'test',
                rowCount: count,
                expressionBytesList,
                readingBytesList,
                readingEqualsExpressionList,
                scoreList,
                sequenceList,
            },
            1,
            contentOffsets,
            contentLengths,
        )

        expect(observed).toHaveLength(2)
        expect(observed.map(({chunk}) => chunk.rowCount)).toEqual([30_000, 1])
        for (const {chunk, offsets, lengths} of observed) {
            expect(chunk.expressionBytesList).not.toBe(expressionBytesList)
            expect(chunk.readingBytesList).not.toBe(readingBytesList)
            expect(chunk.readingEqualsExpressionList.buffer).toBe(readingEqualsExpressionList.buffer)
            expect(chunk.scoreList.buffer).toBe(scoreList.buffer)
            expect(chunk.sequenceList.buffer).toBe(sequenceList.buffer)
            expect(offsets.buffer).toBe(contentOffsets.buffer)
            expect(lengths.buffer).toBe(contentLengths.buffer)
        }
        expect(observed[0].chunk.scoreList.byteOffset).toBe(scoreList.byteOffset)
        expect(observed[1].chunk.scoreList.byteOffset).toBe(scoreList.byteOffset + 30_000 * Float64Array.BYTES_PER_ELEMENT)
        expect(observed[1].offsets.byteOffset).toBe(contentOffsets.byteOffset + 30_000 * Float64Array.BYTES_PER_ELEMENT)
    })
})
