/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {describe, expect, test, vi} from 'vitest'
import {createArtifactTermRecordChunkWithResolvedContent, TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js'

/** @typedef {Parameters<TermRecordOpfsStore['_encodeArtifactRecordFields']>[0]} Chunk */
/** @typedef {NonNullable<Chunk['resolvedContentReferences']>} References */

/**
 * @param {References} references
 * @param {Chunk['scoreList']} scores
 * @param {boolean} owned
 * @returns {Chunk}
 */
function makeChunk(references, scores, owned) {
    const chunk = {rowCount: references.uniqueIndexList.length, scoreList: scores, resolvedContentReferences: references}
    return owned ?
        createArtifactTermRecordChunkWithResolvedContent(chunk, references.uniqueIndexList, references.offsets, references.lengths) :
        chunk
}

/**
 * @param {Chunk} chunk
 * @param {number} base
 * @returns {Uint8Array}
 */
function encode(chunk, base) {
    return new TermRecordOpfsStore()._encodeArtifactRecordFields(chunk, [], [], base)
}

describe('compact record encoding of repeated content and scores', () => {
    test.each(['compact', 'large-length-fallback'])('matches every scalar field byte with %s content', (kind) => {
        const base = 2 ** 40 + 123
        const references = {
            uniqueIndexList: new Uint32Array(2000),
            offsets: Float64Array.of(base, base + 128, -1, base + 0xfffffffe),
            lengths: Uint32Array.of(7, 0, 65534, kind === 'compact' ? 42 : 65535),
        }
        const scores = new Int32Array(references.uniqueIndexList.length)
        const values = [75, 50, 100, -256, 255, 256, -257, -2147483648, 2147483647]
        for (let i = 0; i < scores.length; ++i) {
            references.uniqueIndexList[i] = Math.floor(i / 47) % references.offsets.length
            scores[i] = values[Math.floor(i / 29) % values.length]
        }
        const expected = encode(makeChunk(references, scores, false), base)
        const actual = encode(makeChunk(references, scores, true), base)
        expect(actual).toStrictEqual(expected)
        expect(actual.buffer.byteLength).toBe(actual.byteLength)
        expect(actual.byteLength).toBe(kind === 'compact' ? 16 + values.length * 4 + scores.length * 8 : scores.length * 12)
    })

    test('keeps score changes inside an identical content run and nonconsecutive aliases', () => {
        const references = {
            uniqueIndexList: Uint32Array.from({length: 256}, (_, i) => Math.floor(i / 64) % 2),
            offsets: Float64Array.of(1234, 4567),
            lengths: Uint32Array.of(7, 11),
        }
        const scores = Int32Array.from({length: 256}, (_, i) => (Math.floor(i / 16) % 3 === 0 ? 50 : 100))
        const result = encode(makeChunk(references, scores, true), 1234)
        expect(result).toStrictEqual(encode(makeChunk(references, scores, false), 1234))
        const header = new Uint32Array(result.buffer, 0, 4)
        expect([...header]).toEqual([0x3246524d, 256, 2, 2])
        expect([...new Int32Array(result.buffer, 16, 2)]).toEqual([50, 100])
        expect([...new Uint16Array(result.buffer, 24 + 256 * 6, 256)]).toEqual([...scores].map((score) => (score === 50 ? 0 : 1)))
    })

    test('rebuilds legacy fields when the score dictionary exceeds compact keys', () => {
        const references = {
            uniqueIndexList: new Uint32Array(65536),
            offsets: Float64Array.of(100),
            lengths: Uint32Array.of(10),
        }
        const scores = Int32Array.from({length: 65536}, (_, i) => i - 32768)
        const actual = encode(makeChunk(references, scores, true), 100)
        assert.deepEqual(actual, encode(makeChunk(references, scores, false), 100))
        expect(actual.byteLength).toBe(scores.length * 12)
    })

    test('writes long content runs into final columns without staged field copies', () => {
        const references = {
            uniqueIndexList: Uint32Array.from({length: 256}, (_, i) => Math.floor(i / 64) % 2),
            offsets: Float64Array.of(100, 200),
            lengths: Uint32Array.of(10, 20),
        }
        const scores = Int32Array.from({length: 256}, (_, i) => Math.floor(i / 16) % 2)
        const expected = encode(makeChunk(references, scores, false), 100)
        const offsetCopies = vi.spyOn(Uint32Array.prototype, 'set')
        const shortCopies = vi.spyOn(Uint16Array.prototype, 'set')
        try {
            const actual = encode(makeChunk(references, scores, true), 100)
            expect(offsetCopies).not.toHaveBeenCalled()
            expect(shortCopies).toHaveBeenCalledTimes(1)
            expect(actual).toStrictEqual(expected)
        } finally {
            offsetCopies.mockRestore()
            shortCopies.mockRestore()
        }
    })

    test.each(['array', 'float64', 'shared', 'subclass', 'shadowed-length', 'shadowed-buffer'])('retains scalar parity for %s scores', (kind) => {
        const references = {
            uniqueIndexList: new Uint32Array(120),
            offsets: Float64Array.of(100),
            lengths: Uint32Array.of(10),
        }
        /** @type {Chunk['scoreList']} */
        let scores = new Int32Array(120).fill(50)
        switch (kind) {
            case 'array': scores = [...scores]; break
            case 'float64':
                scores = new Float64Array(120).fill(50)
                scores[20] = -0
                scores[21] = 0
                scores[60] = 0.25
                break
            case 'shared': scores = new Int32Array(new SharedArrayBuffer(480)).fill(50); break
            case 'subclass': {
                class Scores extends Int32Array {}
                scores = new Scores(120).fill(50)
                break
            }
            case 'shadowed-length': Object.defineProperty(scores, 'length', {value: 120}); break
            case 'shadowed-buffer': Object.defineProperty(scores, 'buffer', {value: scores.buffer}); break
        }
        expect(encode(makeChunk(references, scores, true), 100)).toStrictEqual(encode(makeChunk(references, scores, false), 100))
        if (kind === 'float64') {
            const output = encode(makeChunk(references, scores, true), 100)
            const view = new DataView(output.buffer)
            expect(output.byteLength).toBe(120 * 16)
            expect(Object.is(view.getFloat64(20 * 16 + 8, true), -0)).toBe(true)
            expect(Object.is(view.getFloat64(21 * 16 + 8, true), 0)).toBe(true)
            expect(view.getFloat64(60 * 16 + 8, true)).toBe(0.25)
        }
    })

    test('preserves per-row score getter effects on resolved content', () => {
        /**
         * @param {boolean} owned
         * @returns {{bytes: Uint8Array, reads: number}}
         */
        const run = (owned) => {
            const references = {
                uniqueIndexList: new Uint32Array(120),
                offsets: Float64Array.of(100),
                lengths: Uint32Array.of(10),
            }
            const scores = new Int32Array(120).fill(75)
            const chunk = makeChunk(references, scores, owned)
            let reads = 0
            Object.defineProperty(chunk, 'scoreList', {
                get() {
                    references.offsets[0] = 100 + ++reads
                    return scores
                },
            })
            return {bytes: encode(chunk, 100), reads}
        }
        const generic = run(false)
        const owned = run(true)
        expect(owned).toStrictEqual(generic)
        expect(owned.reads).toBeGreaterThanOrEqual(120)
    })

    test('keeps indexed score Proxy effects on the scalar path', () => {
        /**
         * @param {boolean} owned
         * @returns {{bytes: Uint8Array, reads: number}}
         */
        const run = (owned) => {
            const references = {
                uniqueIndexList: new Uint32Array(120),
                offsets: Float64Array.of(100),
                lengths: Uint32Array.of(10),
            }
            let reads = 0
            const scores = new Proxy(new Int32Array(120).fill(75), {
                get(target, key) {
                    if (typeof key === 'string' && /^\d+$/.test(key)) { references.offsets[0] = 100 + ++reads }
                    return Reflect.get(target, key, target)
                },
            })
            return {bytes: encode(makeChunk(references, scores, owned), 100), reads}
        }
        expect(run(true)).toStrictEqual(run(false))
        expect(run(true).reads).toBe(120)
    })

    test.each(['buffer', 'length'])('does not invoke a shadowed score %s accessor during admission', (property) => {
        const references = {
            uniqueIndexList: new Uint32Array(120),
            offsets: Float64Array.of(100),
            lengths: Uint32Array.of(10),
        }
        const scores = new Int32Array(120).fill(75)
        let reads = 0
        Object.defineProperty(scores, property, {
            get() { ++reads; throw new Error('Unexpected shadowed property read') },
        })
        expect(encode(makeChunk(references, scores, true), 100)).toStrictEqual(encode(makeChunk(references, scores, false), 100))
        expect(reads).toBe(0)
    })

    test('rejects an out-of-bounds ID after a long repeated run', () => {
        const references = {
            uniqueIndexList: new Uint32Array(120),
            offsets: Float64Array.of(100),
            lengths: Uint32Array.of(10),
        }
        references.uniqueIndexList[119] = 1
        expect(() => encode(makeChunk(references, new Int32Array(120).fill(75), true), 100)).toThrow('Invalid resolved term content reference index: 1')
    })
})
