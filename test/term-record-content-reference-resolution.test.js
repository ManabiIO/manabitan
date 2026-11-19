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

/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test, vi} from 'vitest'
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js'

describe('term record content column selection', () => {
    test.each(['compact', 'legacy', 'float64'])('preserves encoded %s bytes for duplicate resolved references', (format) => {
        const count = 80
        const uniqueOffsets = new Float64Array([32, 96, 160])
        const uniqueLengths = new Uint32Array(format === 'legacy' ? [70000, 5, 9] : [7, 5, 9])
        const uniqueIndexList = Uint32Array.from({length: count}, (_, index) => index % uniqueOffsets.length)
        const offsets = Float64Array.from(uniqueIndexList, (index) => uniqueOffsets[index])
        const lengths = Uint32Array.from(uniqueIndexList, (index) => uniqueLengths[index])
        const scoreList = format === 'float64' ? new Float64Array(count).fill(1.25) : new Int32Array(count).fill(4)
        const store = new TermRecordOpfsStore()
        const expected = store._encodeArtifactRecordFields({rowCount: count, scoreList}, offsets, lengths, 32)
        const actual = store._encodeArtifactRecordFields({
            rowCount: count,
            scoreList,
            resolvedContentReferences: {uniqueIndexList, offsets: uniqueOffsets, lengths: uniqueLengths},
        }, new Float64Array(0), new Uint32Array(0), 32)
        expect(actual).toStrictEqual(expected)
    })

    test.each(['compact', 'legacy', 'float64'])('preserves an independent fixed length in %s fields', (format) => {
        const count = 80
        const fixedContentLength = format === 'legacy' ? 70000 : 7
        const offsets = Float64Array.from({length: count}, (_, index) => 32 + index * 16)
        const scoreList = format === 'float64' ? new Float64Array(count).fill(-0) : new Int32Array(count).fill(4)
        const store = new TermRecordOpfsStore()
        const expected = store._encodeArtifactRecordFields({rowCount: count, scoreList}, offsets, new Uint32Array(count).fill(fixedContentLength), 32)
        const actual = store._encodeArtifactRecordFields({
            rowCount: count,
            scoreList,
            fixedContentOffsetBase: -1,
            fixedContentLength,
            resolvedContentReferences: {
                uniqueIndexList: Uint32Array.from({length: count}, (_, index) => index),
                offsets,
                lengths: new Uint32Array(0),
            },
        }, new Float64Array(0), new Uint32Array(0), 32)
        expect(actual).toStrictEqual(expected)
    })

    test.each(['offsets', 'lengths'])('rejects a reference beyond the %s column', (shortColumn) => {
        const store = new TermRecordOpfsStore()
        const chunk = {
            rowCount: 2,
            scoreList: new Int32Array([1, 1]),
            resolvedContentReferences: {
                uniqueIndexList: new Uint32Array([0, 1]),
                offsets: new Float64Array(shortColumn === 'offsets' ? [16] : [16, 32]),
                lengths: new Uint32Array(shortColumn === 'lengths' ? [7] : [7, 9]),
            },
        }
        expect(() => store._encodeArtifactRecordFields(chunk, [], [], 16)).toThrow('Invalid resolved term content reference index: 1')
    })

    test('refreshes resolved columns after an awaited split append', async () => {
        const store = new TermRecordOpfsStore()
        const chunk = {
            dictionary: 'Reference replacement',
            rowCount: 3,
            expressionBytesList: [],
            readingBytesList: [],
            readingEqualsExpressionList: new Uint8Array(3).fill(1),
            scoreList: new Int32Array(3),
            sequenceList: new Int32Array(3).fill(-1),
            resolvedContentReferences: {
                uniqueIndexList: new Uint32Array([0, 1, 2]),
                offsets: new Float64Array([16, 0x100000010, 0x100000020]),
                lengths: new Uint32Array([7, 7, 7]),
            },
        }
        vi.spyOn(store, '_encodeArtifactChunkRecords').mockResolvedValue({
            contentOffsetBase: 16,
            lookupIndexBytes: new Uint8Array(0),
            recordFields: new Uint8Array(0),
            recordFieldsFormat: 1,
            validationMs: 0,
            recordFieldEncodeMs: 0,
            lookupIndexEncodeMs: 0,
        })
        vi.spyOn(store, '_appendEncodedChunk').mockImplementation(async () => {
            chunk.resolvedContentReferences = {
                uniqueIndexList: new Uint32Array([0, 4, 0]),
                offsets: new Float64Array([16]),
                lengths: new Uint32Array([7]),
            }
        })
        await expect(store._encodeAndAppendArtifactChunkForState(
            /** @type {Parameters<TermRecordOpfsStore['_encodeAndAppendArtifactChunkForState']>[0]} */ ({}),
            chunk,
            1,
            [],
            [],
        )).rejects.toThrow('Invalid resolved term content reference index: 4')
        expect(store._appendEncodedChunk).toHaveBeenCalledTimes(1)
    })
})
