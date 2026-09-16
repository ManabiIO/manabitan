/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test, vi} from 'vitest'
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js'

/** @typedef {Parameters<TermRecordOpfsStore['_encodeArtifactRecordFields']>} Arguments */
const store = new TermRecordOpfsStore()

/**
 * Independent row-first format oracle. Explicit DataView writes also verify
 * section alignment and byte order without using the production column writer.
 * @param {Arguments} args
 * @returns {Uint8Array}
 */
function expectedFields([chunk, offsets, lengths, base]) {
    const {rowCount: count, scoreList, resolvedContentReferences: references} = chunk
    const fixed = typeof chunk.fixedContentOffsetBase === 'number' && Number.isFinite(chunk.fixedContentOffsetBase) && chunk.fixedContentOffsetBase >= 0 &&
    typeof chunk.fixedContentLength === 'number' && Number.isFinite(chunk.fixedContentLength) && chunk.fixedContentLength >= 0
    const rows = Array.from({length: count}, (_, i) => {
        const key = references?.uniqueIndexList[i] ?? 0
        const offset = fixed ? /** @type {number} */ (chunk.fixedContentOffsetBase) + i * /** @type {number} */ (chunk.fixedContentLength) : (references ? references.offsets[key] : offsets[i])
        const length = typeof chunk.fixedContentLength === 'number' ? chunk.fixedContentLength : (references ? references.lengths[key] : lengths[i])
        return {offset: offset < 0 ? 0xffffffff : offset - base, contentLength: length, score: scoreList[i] ?? 0}
    })
    const scores = [...new Set(rows.map((row) => row.score))]
    const keys = new Map(scores.map((value, index) => [value, index]))
    const compactSize = 16 + scores.length * 4 + count * 8
    const compact = count > 0 && scores.length < 65535 && compactSize < count * 12 && rows.every((row) => row.contentLength < 65535)
    const bytes = new Uint8Array(compact ? compactSize : count * 12)
    const view = new DataView(bytes.buffer)
    if (compact) {
        view.setUint32(0, 0x3246524d, true)
        view.setUint32(4, count, true)
        view.setUint32(8, scores.length, true)
        view.setUint32(12, 2, true)
        for (const [i, score] of scores.entries()) { view.setInt32(16 + i * 4, score, true) }
    }
    const columns = 16 + scores.length * 4
    for (const [i, row] of rows.entries()) {
        if (compact) {
            view.setUint32(columns + i * 4, row.offset, true)
            view.setUint16(columns + count * 4 + i * 2, row.contentLength < 0 ? 65535 : row.contentLength, true)
            view.setUint16(columns + count * 6 + i * 2, /** @type {number} */ (keys.get(row.score)), true)
        } else {
            view.setUint32(i * 12, row.offset, true)
            view.setUint32(i * 12 + 4, row.contentLength < 0 ? 0xffffffff : row.contentLength, true)
            view.setInt32(i * 12 + 8, row.score, true)
        }
    }
    return bytes
}

/**
 * @param {Arguments} args
 * @returns {Uint8Array}
 */
function check(args) {
    const expected = expectedFields(args)
    const result = store._encodeArtifactRecordFields(...args)
    expect(Buffer.compare(result, expected)).toBe(0)
    expect(result.byteLength).toBe(expected.byteLength)
    return result
}

describe('direct artifact record field encoding', () => {
    test('allocates only the score-key scratch column before final output', () => {
        const count = 128
        const args = /** @type {Arguments} */ ([
            {rowCount: count, scoreList: new Int32Array(count)},
            new Float64Array(count).fill(100),
            new Uint32Array(count).fill(20),
            100,
        ])
        let scratchBytes = 0
        /** @type {Uint8Array|null} */
        let result = null
        try {
            for (const constructor of [Uint16Array, Uint32Array]) {
                vi.stubGlobal(constructor.name, new Proxy(constructor, {
                    construct(target, args) {
                        if (typeof args[0] === 'number') { scratchBytes += args[0] * target.BYTES_PER_ELEMENT }
                        return Reflect.construct(target, args)
                    },
                }))
            }
            result = store._encodeArtifactRecordFields(...args)
        } finally {
            vi.unstubAllGlobals()
        }
        expect(scratchBytes).toBe(count * 2)
        expect(result).toEqual(expectedFields(args))
    })

    test.each([0, 1, 2, 4, 5, 6, 7, 8, 31, 32, 33, 65534, 65535, 65536, 70001])('preserves compact and legacy bytes for %i rows', (count) => {
        for (const distinct of [1, 3, count]) {
            const chunk = {rowCount: count, scoreList: Int32Array.from({length: count}, (_, i) => i % Math.max(1, distinct) - 2)}
            const offsets = Float64Array.from({length: count}, (_, i) => (i % 17 === 0 ? -1 : 2 ** 40 + i * 20))
            const lengths = Array.from({length: count}, (_, i) => (i % 17 === 0 ? -1 : i % 65535))
            check([chunk, offsets, lengths, 2 ** 40])
        }
    })

    test.each([0, 20, 65534, 65535, 65536, 0xfffffffe])('preserves fixed content length %i including legacy admission', (length) => {
        check([{rowCount: 32, scoreList: new Int32Array(32), fixedContentOffsetBase: 2 ** 40, fixedContentLength: length}, [], [], 2 ** 40])
    })

    test('preserves resolved reference aliases and ignores unrelated row arrays', () => {
        const count = 257
        const references = {uniqueIndexList: Uint32Array.from({length: count}, (_, i) => i % 9),
            offsets: Float64Array.from({length: 9}, (_, i) => 2 ** 42 + i * 113),
            lengths: Uint32Array.from({length: 9}, (_, i) => i + 1)}
        const chunk = {rowCount: count, scoreList: new Int32Array([0, -2147483648, 2147483647]), resolvedContentReferences: references}
        check([chunk, [], [], 2 ** 42])
        chunk.resolvedContentReferences.lengths[4] = 65535
        check([chunk, [], [], 2 ** 42])
    })

    test('returns an owning buffer independent of inputs and subsequent calls', () => {
        const offsets = new Float64Array(new SharedArrayBuffer(8 * 64), 8, 32)
        offsets.fill(2000)
        const lengths = new Uint32Array(new SharedArrayBuffer(4 * 64), 4, 32)
        lengths.fill(20)
        const scoreList = new Int32Array(32).fill(-3)
        const args = /** @type {Arguments} */ ([{rowCount: 32, scoreList}, offsets, lengths, 2000])
        const actual = check(args)
        const retained = Uint8Array.from(actual)
        offsets.fill(4000)
        lengths.fill(30)
        scoreList.fill(9)
        const next = check(args)
        next.fill(255)
        expect(Buffer.compare(actual, retained)).toBe(0)
    })

    test.each([0, 1, 8, 63])('retains invalid resolved-index rejection at row %i', (index) => {
        const mapping = new Uint32Array(64)
        mapping[index] = 5
        const chunk = {rowCount: 64,
            scoreList: new Int32Array(64),
            resolvedContentReferences: {
                uniqueIndexList: mapping, offsets: Float64Array.of(10), lengths: Uint32Array.of(20),
            }}
        expect(() => store._encodeArtifactRecordFields(chunk, [], [], 0)).toThrow(RangeError)
        chunk.resolvedContentReferences.lengths[0] = 65535
        expect(() => store._encodeArtifactRecordFields(chunk, [], [], 0)).toThrow(RangeError)
    })

    test('matches an independent format oracle for 200 deterministic irregular chunks', () => {
        let state = 0x8faca713
        const random = () => {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0
            return state
        }
        for (let trial = 0; trial < 200; ++trial) {
            const count = random() % 1001
            const base = 2 ** 34 + random()
            const offsets = Float64Array.from({length: count}, () => base + random() % 0xfffffffe)
            const lengths = Uint32Array.from({length: count}, () => random() % (trial % 3 === 0 ? 100000 : 65000))
            const scoreList = Int32Array.from({length: count}, () => random() % 7)
            check([{rowCount: count, scoreList}, offsets, lengths, base])
        }
    })
})
