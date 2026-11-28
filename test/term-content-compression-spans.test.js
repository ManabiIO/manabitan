/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ['error', 'never'] */

import {describe, expect, test} from 'vitest'
import {planTermContentCompressionSpans, validateTermContentSpans} from '../ext/js/dictionary/term-content-compression-spans.js'

/**
 * @param {Uint8Array} source
 * @param {Uint32Array} offsets
 * @param {Uint32Array} lengths
 * @param {number} targetBytes
 * @returns {ReturnType<typeof planTermContentCompressionSpans>}
 */
function planSpans(source, offsets, lengths, targetBytes) {
    const validation = validateTermContentSpans(source, offsets, lengths, targetBytes)
    return planTermContentCompressionSpans(offsets, lengths, targetBytes, validation)
}

/**
 * @param {Uint8Array} source
 * @param {Uint32Array} offsets
 * @param {Uint32Array} lengths
 * @param {Uint32Array} starts
 * @returns {number[][]}
 */
function gatherBlocks(source, offsets, lengths, starts) {
    return Array.from(starts.subarray(1), (end, block) => {
        const output = []
        for (let i = starts[block]; i < end; ++i) {
            output.push(...source.subarray(offsets[i], offsets[i] + lengths[i]))
        }
        return output
    })
}

describe('compression span planning', () => {
    test('preserves reference blocks while coalescing ranges and snapshotting private columns', () => {
        const source = new Uint8Array(new SharedArrayBuffer(160), 7, 140)
        for (let i = 0; i < source.length; ++i) { source[i] = i }
        const offsets = Uint32Array.from({length: 32}, (_, i) => (i <= 15 ? i - 1 : i + 84)).subarray(1, 31)
        const lengths = new Uint32Array(30).fill(1)
        const starts = Uint32Array.of(0, 10, 20, 30)
        const expected = gatherBlocks(source, offsets, lengths, starts)
        const plan = planSpans(source, offsets, lengths, 10)

        expect(plan.blockStartIndexes).toEqual(starts)
        expect([...plan.packedChunkLengths]).toEqual([10, 10, 10])
        expect([...plan.compressionSourceOffsets]).toEqual([0, 10, 100, 105])
        expect([...plan.compressionSourceLengths]).toEqual([10, 5, 5, 10])
        expect([...plan.compressionBlockStartIndexes]).toEqual([0, 1, 3, 4])
        expect(plan.compressionSourceOffsets.buffer).toBe(plan.compressionSourceLengths.buffer)
        expect(plan.compressionSourceOffsets.buffer).toBeInstanceOf(ArrayBuffer)
        offsets.fill(0)
        lengths.fill(0)
        expect(gatherBlocks(source, plan.compressionSourceOffsets, plan.compressionSourceLengths, plan.compressionBlockStartIndexes)).toEqual(expected)
    })

    test('keeps an oversized entry in its own original block', () => {
        const source = new Uint8Array(new SharedArrayBuffer(64))
        const lengths = new Uint32Array(30).fill(1)
        lengths[0] = 12
        const offsets = Uint32Array.from({length: 30}, (_, i) => (i === 0 ? 0 : i + 11))
        const plan = planSpans(source, offsets, lengths, 10)
        expect([...plan.blockStartIndexes]).toEqual([0, 1, 11, 21, 30])
        expect([...plan.packedChunkLengths]).toEqual([12, 10, 10, 9])
        expect([...plan.compressionBlockStartIndexes]).toEqual([0, 1, 2, 3, 4])
        expect([...plan.compressionSourceLengths]).toEqual([12, 10, 10, 9])
    })

    test('keeps fragmented descriptors without allocating speculative staging', () => {
        const source = new Uint8Array(new SharedArrayBuffer(8192))
        const offsets = Uint32Array.from({length: 4096}, (_, i) => i * 2)
        const lengths = new Uint32Array(offsets.length).fill(1)
        const plan = planSpans(source, offsets, lengths, 512)
        expect(plan.compressionSourceOffsets).toBe(offsets)
        expect(plan.compressionSourceLengths).toBe(lengths)
        expect(plan.compressionBlockStartIndexes).toBe(plan.blockStartIndexes)
        expect([...plan.blockStartIndexes]).toEqual([0, 512, 1024, 1536, 2048, 2560, 3072, 3584, 4096])
        expect([...plan.packedChunkLengths]).toEqual(new Array(8).fill(512))
    })

    test.each(['shared', 'resizable', 'subclass', 'accessor'])('retains %s input descriptors', (kind) => {
        class DerivedColumn extends Uint32Array {}
        /** @type {Uint32Array} */
        let offsets = Uint32Array.from({length: 30}, (_, i) => i)
        switch (kind) {
            case 'shared':
                offsets = new Uint32Array(new SharedArrayBuffer(120))
                for (let i = 0; i < offsets.length; ++i) { offsets[i] = i }
                break
            case 'resizable': {
                const buffer = /** @type {ArrayBuffer} */ (Reflect.construct(ArrayBuffer, [120, {maxByteLength: 240}]))
                const values = offsets
                offsets = new Uint32Array(buffer)
                offsets.set(values)
                break
            }
            case 'subclass':
                offsets = new DerivedColumn(offsets)
                break
            default:
                Object.defineProperty(offsets, 'length', {get: () => 30})
                break
        }
        const lengths = new Uint32Array(30).fill(1)
        const plan = planSpans(new Uint8Array(new SharedArrayBuffer(64)), offsets, lengths, 10)
        expect(plan.compressionSourceOffsets).toBe(offsets)
        expect(plan.compressionSourceLengths).toBe(lengths)
        expect([...plan.blockStartIndexes]).toEqual([0, 10, 20, 30])
    })

    test('keeps the original validation and snapshot reads for proxy columns and sources', () => {
        const values = Uint32Array.from({length: 30}, (_, i) => i)
        const lengths = new Uint32Array(30).fill(1)
        const sharedSource = new Uint8Array(new SharedArrayBuffer(64))
        const source = new Proxy(sharedSource, {get: (target, key) => Reflect.get(target, key, target)})
        for (const bytes of [sharedSource, source]) {
            let reads = 0
            let prototypeReads = 0
            const offsets = new Proxy(values, {
                get(target, key) {
                    if (typeof key === 'string' && /^\d+$/.test(key)) {
                        const value = target[Number(key)] + Math.floor(reads / 30)
                        ++reads
                        return value
                    }
                    return Reflect.get(target, key, target)
                },
                getPrototypeOf() {
                    ++prototypeReads
                    return Uint32Array.prototype
                },
            })
            const plan = planSpans(bytes, offsets, lengths, 10)
            expect(plan.compressionSourceOffsets).toBe(offsets)
            expect(reads).toBe(30)
            expect(prototypeReads).toBe(1)
            const snapshot = new Uint32Array(30)
            snapshot.set(offsets)
            expect(reads).toBe(60)
            expect(snapshot).toEqual(values.map((value) => value + 1))
        }
    })

    test.each([
        {name: 'unequal column lengths', offsets: [0, 1], lengths: [1], error: 'equally sized'},
        {name: 'negative Uint32 input', offsets: [-1], lengths: [0], error: 'out of bounds'},
        {name: 'offset near Uint32 maximum', offsets: [0xfffffffe], lengths: [1], error: 'out of bounds'},
        {name: 'length beyond source view', offsets: [7], lengths: [2], error: 'out of bounds'},
        {name: 'empty span beyond source view', offsets: [9], lengths: [0], error: 'out of bounds'},
    ])('preserves validation failure for $name', ({offsets, lengths, error}) => {
        const source = new Uint8Array(new SharedArrayBuffer(24), 7, 8)
        expect(() => planSpans(source, Uint32Array.from(offsets), Uint32Array.from(lengths), 4)).toThrow(error)
    })

    test('allocates no compression columns for a single block', () => {
        const source = new Uint8Array(new SharedArrayBuffer(30))
        const offsets = Uint32Array.from({length: 30}, (_, i) => i)
        const lengths = new Uint32Array(30).fill(1)
        const plan = planSpans(source, offsets, lengths, 30)
        expect(plan.compressionSourceOffsets).toBe(offsets)
        expect(plan.compressionSourceLengths).toBe(lengths)
        expect(plan.compressionBlockStartIndexes).toBe(plan.blockStartIndexes)
    })

    test.each(['byteOffset', 'length', 'subarray'])('does not inspect or compact an overridden source %s', (property) => {
        const source = new Uint8Array(new SharedArrayBuffer(30))
        Object.defineProperty(source, property, {get() { throw new Error('Source override must remain unobserved during planning') }})
        const offsets = Uint32Array.from({length: 30}, (_, i) => i)
        const lengths = new Uint32Array(30).fill(1)
        const plan = planSpans(source, offsets, lengths, 10)
        expect(plan.compressionSourceOffsets).toBe(offsets)
        expect(plan.compressionSourceLengths).toBe(lengths)
    })

    test('rejects stale run counts if private columns change before planning', () => {
        const source = new Uint8Array(new SharedArrayBuffer(128))
        const offsets = Uint32Array.from({length: 30}, (_, i) => i)
        const lengths = new Uint32Array(30).fill(1)
        const validation = validateTermContentSpans(source, offsets, lengths, 10)
        offsets[5] = 70
        expect(() => planTermContentCompressionSpans(offsets, lengths, 10, validation)).toThrow('span plan changed')
    })

    test('uses intrinsic buffer identity and resizability for admission', () => {
        const source = new Uint8Array(new SharedArrayBuffer(64))
        const lengths = new Uint32Array(30).fill(1)
        const shared = new SharedArrayBuffer(120)
        const offsets = new Uint32Array(shared)
        for (let i = 0; i < offsets.length; ++i) { offsets[i] = i }
        Object.setPrototypeOf(shared, ArrayBuffer.prototype)
        const sharedPlan = planSpans(source, offsets, lengths, 10)
        expect(sharedPlan.compressionSourceOffsets).toBe(offsets)

        const resizable = /** @type {ArrayBuffer} */ (Reflect.construct(ArrayBuffer, [120, {maxByteLength: 240}]))
        Object.defineProperty(resizable, 'resizable', {value: false})
        const mutableOffsets = new Uint32Array(resizable)
        mutableOffsets.set(offsets)
        const resizablePlan = planSpans(source, mutableOffsets, lengths, 10)
        expect(resizablePlan.compressionSourceOffsets).toBe(mutableOffsets)
    })

    test('keeps array-like objects with a typed-array prototype on the original path', () => {
        const offsets = /** @type {Uint32Array} */ (Object.create(Uint32Array.prototype))
        Object.defineProperties(offsets, {
            length: {value: 30}, byteLength: {value: 120}, buffer: {value: new ArrayBuffer(120)},
        })
        for (let i = 0; i < 30; ++i) { Object.defineProperty(offsets, i, {value: i}) }
        const lengths = new Uint32Array(30).fill(1)
        const plan = planSpans(new Uint8Array(new SharedArrayBuffer(64)), offsets, lengths, 10)
        expect(plan.compressionSourceOffsets).toBe(offsets)
        expect(plan.compressionSourceLengths).toBe(lengths)
        const snapshot = new Uint32Array(30)
        snapshot.set(offsets)
        expect(snapshot).toEqual(Uint32Array.from({length: 30}, (_, i) => i))
    })

    test('preserves empty, overlapping and backward ranges without changing gathered bytes', () => {
        const source = new Uint8Array(new SharedArrayBuffer(128))
        for (let i = 0; i < source.length; ++i) { source[i] = i }
        const offsets = new Uint32Array(30)
        const lengths = new Uint32Array(30)
        let cursor = 0
        for (let i = 0; i < 30; ++i) {
            if (i === 10) { cursor = 3 }
            if (i === 20) { cursor = 50 }
            offsets[i] = cursor
            lengths[i] = i % 4 === 0 ? 0 : 2
            cursor += lengths[i]
        }
        const plan = planSpans(source, offsets, lengths, 20)
        expect(plan.compressionSourceOffsets.length).toBeLessThan(offsets.length)
        expect(gatherBlocks(source, plan.compressionSourceOffsets, plan.compressionSourceLengths, plan.compressionBlockStartIndexes)).toEqual(gatherBlocks(source, offsets, lengths, plan.blockStartIndexes))
        const empty = planSpans(source, new Uint32Array(0), new Uint32Array(0), 10)
        expect([...empty.blockStartIndexes]).toEqual([0])
        expect([...empty.packedChunkLengths]).toEqual([])
    })
})
