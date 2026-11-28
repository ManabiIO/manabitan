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

import {afterEach, describe, expect, test, vi} from 'vitest'
import {createArtifactTermRecordChunkWithResolvedContent, TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js'

/** @typedef {ReturnType<typeof fixture>} Fixture */

/**
 * @param {number} [count=128]
 * @returns {{rowCount: number, scoreList: Int32Array, resolvedContentReferences: {uniqueIndexList: Uint32Array, offsets: Float64Array, lengths: Uint32Array}}}
 */
function fixture(count = 128) {
    const values = [-256, 255, 256, -257, -2147483648, 2147483647, 0]
    return createArtifactTermRecordChunkWithResolvedContent(
        {rowCount: count, scoreList: Int32Array.from({length: count}, (_, i) => values[i % values.length])},
        Uint32Array.from({length: count}, (_, i) => (i * 17) % count),
        Float64Array.from({length: count}, (_, i) => 2 ** 40 + i * 19),
        Uint32Array.from({length: count}, (_, i) => i % 31),
    )
}

/**
 * @param {Fixture} chunk
 * @param {number} [base=2 ** 40]
 * @returns {Uint8Array}
 */
function encodeGeneric(chunk, base = 2 ** 40) {
    // Spreading deliberately removes the internal origin proof; this exercises
    // the unchanged generic encoder with exactly the same column values.
    return new TermRecordOpfsStore()._encodeArtifactRecordFields({...chunk}, [], [], base)
}

/**
 * @param {Fixture} chunk
 * @param {number} [base=2 ** 40]
 * @returns {Uint8Array}
 */
function encodeDirect(chunk, base = 2 ** 40) {
    return new TermRecordOpfsStore()._encodeArtifactRecordFields(chunk, [], [], base)
}

afterEach(() => { vi.restoreAllMocks() })

describe('direct resolved record-field columns', () => {
    test('preserves compact bytes, first-use score order and nonmonotonic aliases', () => {
        const chunk = fixture()
        chunk.resolvedContentReferences.offsets[2] = -1
        chunk.resolvedContentReferences.lengths[3] = 65534
        chunk.resolvedContentReferences.uniqueIndexList[4] = 3
        chunk.resolvedContentReferences.uniqueIndexList[5] = 3
        const expected = encodeGeneric(chunk)
        expect(expected.byteLength).toBe(16 + 7 * 4 + 128 * 8)
        expect(encodeDirect(chunk)).toEqual(expected)
        expect(new TermRecordOpfsStore()._encodeArtifactRecordFields(chunk, [], [], 2 ** 40)).toEqual(expected)
    })

    test('preserves first-use score IDs after repeated signed-score cache collisions', () => {
        const values = [0, 0, 512, 512, -512, -512, 2147483136, -2147483648, 0, -512, 1024, 512]
        const chunk = fixture(values.length * 16)
        chunk.scoreList = Int32Array.from({length: chunk.rowCount}, (_, i) => values[i % values.length])
        const actual = encodeDirect(chunk)
        expect(actual).toEqual(encodeGeneric(chunk))
        const expectedScores = [...new Set(values)]
        const scores = new Int32Array(actual.buffer, 16, expectedScores.length)
        const keys = new Uint16Array(actual.buffer, 16 + scores.byteLength + chunk.rowCount * 6, chunk.rowCount)
        expect([...scores]).toEqual(expectedScores)
        expect(Array.from(keys, (key) => scores[key])).toEqual([...chunk.scoreList])
    })

    test('uses current scores after colliding slots and columns change between calls', () => {
        const chunk = fixture()
        chunk.scoreList.fill(-10200)
        const first = encodeDirect(chunk)
        chunk.scoreList.fill(-10200 + 512)
        chunk.scoreList[1] = -10200
        const second = encodeDirect(chunk)
        expect(second).toEqual(encodeGeneric(chunk))
        expect(second).not.toEqual(first)
        const header = new Uint32Array(second.buffer, 0, 4)
        expect(header[2]).toBe(2)
        expect([...new Int32Array(second.buffer, 16, 2)]).toEqual([-9688, -10200])
    })

    test('preserves scores outside the inline range after the bounded eligibility prefix', () => {
        const chunk = fixture(256)
        chunk.scoreList.fill(-200)
        chunk.scoreList[chunk.rowCount - 1] = -10200
        const actual = encodeDirect(chunk)
        expect(actual).toEqual(encodeGeneric(chunk))
        expect([...new Int32Array(actual.buffer, 16, 2)]).toEqual([-200, -10200])
    })

    test('rechecks cache eligibility when the score prefix changes between calls', () => {
        const chunk = fixture()
        chunk.scoreList.fill(-200)
        const original = encodeDirect(chunk)
        chunk.scoreList[0] = -10200
        const changed = encodeDirect(chunk)
        expect(changed).toEqual(encodeGeneric(chunk))
        expect([...new Int32Array(changed.buffer, 16, 2)]).toEqual([-10200, -200])
        chunk.scoreList[0] = -200
        expect(encodeDirect(chunk)).toEqual(original)
    })

    test('writes field columns into the final allocation without copying staged offsets or lengths', () => {
        const chunk = fixture()
        const expected = encodeGeneric(chunk)
        const offsetCopies = vi.spyOn(Uint32Array.prototype, 'set')
        const shortCopies = vi.spyOn(Uint16Array.prototype, 'set')
        const actual = encodeDirect(chunk)
        expect(offsetCopies).not.toHaveBeenCalled()
        expect(shortCopies).toHaveBeenCalledTimes(1) // Only score keys are staged.
        expect(actual).toEqual(expected)
        expect(actual?.buffer.byteLength).toBe(actual?.byteLength)
    })

    test.each([65535, 65536, 0xffffffff])('preserves legacy fallback for content length %i', (length) => {
        const chunk = fixture()
        chunk.resolvedContentReferences.lengths[0] = length
        const expected = encodeGeneric(chunk)
        expect(expected.byteLength).toBe(chunk.rowCount * 12)
        expect(encodeDirect(chunk)).toEqual(expected)
    })

    test.each([64, 65535, 65536])('preserves high-cardinality score fallback at %i rows', (count) => {
        const chunk = fixture(count)
        chunk.scoreList = Int32Array.from({length: count}, (_, i) => i - 32768)
        const expected = encodeGeneric(chunk)
        expect(expected.byteLength).toBe(count * 12)
        expect(encodeDirect(chunk)).toEqual(expected)
    })

    test('rejects invalid references both before and after selecting legacy fields', () => {
        for (const legacy of [false, true]) {
            const chunk = fixture()
            if (legacy) { chunk.resolvedContentReferences.lengths[0] = 65535 }
            chunk.resolvedContentReferences.uniqueIndexList[127] = 128
            expect(() => encodeDirect(chunk)).toThrow('Invalid resolved term content reference index: 128')
            expect(() => encodeGeneric(chunk)).toThrow('Invalid resolved term content reference index: 128')
        }
    })

    test('returns owned bytes and rereads mutable columns on every invocation', () => {
        const chunk = fixture()
        const first = encodeDirect(chunk)
        const original = first?.slice()
        chunk.scoreList.fill(-901)
        chunk.resolvedContentReferences.offsets.fill(2 ** 40 + 2048)
        chunk.resolvedContentReferences.lengths.fill(42)
        expect(first).toEqual(original)
        expect(encodeDirect(chunk)).toEqual(encodeGeneric(chunk))
        expect(encodeDirect(chunk)).not.toEqual(first)
    })

    test('requires existing origin proof and private ordinary score columns', () => {
        const chunk = fixture()
        const changed = [chunk, fixture(), fixture()]
        changed[0].scoreList = new Int32Array(127)
        changed[1].scoreList = new Int32Array(new SharedArrayBuffer(128 * 4))
        changed[2].scoreList = new Proxy(new Int32Array(128), {})
        const withAccessor = fixture()
        Object.defineProperty(withAccessor, 'scoreList', {get: () => new Int32Array(128)})
        for (const input of [{...fixture()}, new Proxy(fixture(), {}), ...changed, withAccessor]) {
            const expected = encodeGeneric(input)
            const copy = vi.spyOn(Uint32Array.prototype, 'set')
            expect(encodeDirect(input)).toEqual(expected)
            expect(copy).toHaveBeenCalledTimes(1)
            copy.mockRestore()
        }
    })

    test('preserves per-row field snapshots when a score accessor mutates resolved columns', () => {
        /**
         * @param {boolean} trusted
         * @returns {Fixture}
         */
        const make = (trusted) => {
            const chunk = trusted ? fixture() : {...fixture()}
            const scores = new Int32Array(chunk.rowCount).fill(1)
            chunk.resolvedContentReferences.uniqueIndexList.fill(0)
            chunk.resolvedContentReferences.lengths[0] = 2
            let calls = 0
            Object.defineProperty(chunk, 'scoreList', {get() {
                if (++calls === 3) {
                    chunk.resolvedContentReferences.offsets[0] = 2 ** 40 + 99
                    chunk.resolvedContentReferences.lengths[0] = 7
                }
                return scores
            }})
            return chunk
        }
        const actual = encodeDirect(make(true))
        expect(actual).toEqual(encodeDirect(make(false)))
        const offsets = new Uint32Array(actual.buffer, 20, 128)
        const lengths = new Uint16Array(actual.buffer, 20 + 128 * 4, 128)
        expect(offsets[0]).toBe(0)
        expect(offsets[1]).toBe(99)
        expect(lengths[0]).toBe(2)
        expect(lengths[1]).toBe(7)
    })

    test('rejects score views with shadowed length or buffer without reading the accessor', () => {
        for (const property of ['length', 'buffer']) {
            const chunk = fixture()
            const get = vi.fn(() => { throw new Error('Unexpected accessor') })
            Object.defineProperty(chunk.scoreList, property, {get})
            expect(encodeDirect(chunk)).toEqual(encodeGeneric(chunk))
            expect(get).not.toHaveBeenCalled()
        }
    })

    test('keeps shared columns and explicit fixed lengths on the generic path', () => {
        const shared = fixture()
        shared.resolvedContentReferences.lengths = new Uint32Array(new SharedArrayBuffer(128 * 4))
        const expectedShared = encodeGeneric(shared)
        const copy = vi.spyOn(Uint32Array.prototype, 'set')
        expect(encodeDirect(shared)).toEqual(expectedShared)
        expect(copy).toHaveBeenCalledTimes(1)
        copy.mockRestore()
        const fixed = fixture()
        Object.assign(fixed, {fixedContentOffsetBase: 2 ** 40, fixedContentLength: 17})
        expect(new TermRecordOpfsStore()._encodeArtifactRecordFields(fixed, [], [], 2 ** 40)).toEqual(encodeGeneric(fixed))
    })

    test('preserves Float64 scores without allocating compact column scratch', () => {
        const chunk = fixture()
        const scores = Float64Array.from({length: chunk.rowCount}, (_, i) => (i % 2 ? -0 : 1.5))
        const candidate = {...chunk, scoreList: scores}
        const store = new TermRecordOpfsStore()
        const uint32 = vi.spyOn(globalThis, 'Uint32Array')
        const uint16 = vi.spyOn(globalThis, 'Uint16Array')
        const bytes = store._encodeArtifactRecordFields(candidate, [], [], 2 ** 40)
        const view = new DataView(bytes.buffer)
        expect(bytes.byteLength).toBe(chunk.rowCount * 16)
        expect(uint32).not.toHaveBeenCalled()
        expect(uint16).not.toHaveBeenCalled()
        expect(view.getFloat64(8, true)).toBe(1.5)
        expect(Object.is(view.getFloat64(24, true), -0)).toBe(true)
    })
})
