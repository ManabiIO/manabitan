/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {beforeAll, describe, expect, test} from 'vitest'
import {hashTermKeyBytes} from '../ext/js/dictionary/term-key-hash.js'
import {
    encodePersistedTermLookupIndexFromPreinternedPlan,
    findSequenceRows,
    getPersistedTermSequence,
    parsePersistedTermLookupIndex,
} from '../ext/js/dictionary/term-lookup-index.js'

/** @typedef {{memory: WebAssembly.Memory, wasm_reset_heap: () => void, wasm_alloc: (size: number) => number, encode_term_lookup_index: (...args: number[]) => number}} NativeLookup */
/** @type {NativeLookup} */
let wasm

beforeAll(async () => {
    const bytes = await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))
    const {instance} = await WebAssembly.instantiate(bytes)
    wasm = /** @type {NativeLookup} */ (/** @type {unknown} */ (instance.exports))
})

/**
 * @param {number[]|Int32Array} values
 * @param {boolean} reuseOutput
 * @returns {{args: number[], plan: import('../ext/js/dictionary/term-record-preinterned-plan.js').PreinternedTermRecordPlan, equals: Uint8Array, values: Int32Array, encode: () => {status: number, bytes: Uint8Array}, slots: () => Uint16Array}}
 */
function fixture(values, reuseOutput) {
    wasm.wasm_reset_heap()
    const count = values.length
    const keyCount = Math.min(count, 2)
    const stringsBuffer = new Uint8Array([97, 98].slice(0, keyCount))
    const plan = {
        stringsBuffer,
        stringLengths: new Uint16Array(keyCount).fill(1),
        stringOffsets: Uint32Array.from({length: keyCount}, (_, i) => i),
        stringHashes: Uint32Array.from({length: keyCount}, (_, i) => hashTermKeyBytes(stringsBuffer.subarray(i, i + 1))),
        expressionIndexes: Uint32Array.from({length: count}, (_, i) => i % keyCount),
        readingIndexes: Uint32Array.from({length: count}, (_, i) => (i + 1) % keyCount),
    }
    const equals = Uint8Array.from({length: count}, (_, i) => Number(i % 3 === 0))
    const sequences = new Int32Array(values)
    /**
     * @param {ArrayBufferView} value
     * @returns {number}
     */
    const put = (value) => {
        const pointer = wasm.wasm_alloc(Math.max(8, value.byteLength))
        new Uint8Array(wasm.memory.buffer, pointer, value.byteLength).set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
        return pointer
    }
    let slotCount = 1
    while (slotCount < count) { slotCount *= 2 }
    const outputCapacity = count * 48 + 256
    const output = put(new Uint8Array(outputCapacity + 16).fill(0xa5))
    const args = [
        put(plan.stringsBuffer),
        plan.stringsBuffer.length,
        put(plan.stringLengths),
        put(plan.stringOffsets),
        put(plan.stringHashes),
        keyCount,
        put(plan.expressionIndexes),
        put(plan.readingIndexes),
        put(equals),
        put(sequences),
        count,
        output,
        outputCapacity,
        put(new Int32Array(count).fill(-123)),
        put(new Uint16Array(count).fill(0xabcd)),
        reuseOutput ? output + outputCapacity - ((slotCount * 2 + 3) & ~3) : put(new Uint16Array(slotCount).fill(0xcafe)),
        slotCount,
    ]
    return {
        args,
        plan,
        equals,
        values: sequences,
        encode: () => {
            const status = wasm.encode_term_lookup_index(...args)
            expect(new Uint8Array(wasm.memory.buffer, output + outputCapacity, 16)).toEqual(new Uint8Array(16).fill(0xa5))
            return {status, bytes: status > 0 ? new Uint8Array(new Uint8Array(wasm.memory.buffer, output, status)) : new Uint8Array()}
        },
        slots: () => new Uint16Array(wasm.memory.buffer, args[15], slotCount),
    }
}

/**
 * @param {ReturnType<typeof fixture>} input
 * @returns {import('../ext/js/dictionary/term-lookup-index.js').PersistedTermLookupIndex}
 */
function check(input) {
    const expected = encodePersistedTermLookupIndexFromPreinternedPlan(input.plan, input.equals, input.values, input.values.length)
    const actual = input.encode()
    expect(actual.status).toBe(expected.byteLength)
    expect(Buffer.compare(actual.bytes, expected)).toBe(0)
    const parsed = parsePersistedTermLookupIndex(actual.bytes)
    expect([...parsed.sequenceKeys]).toEqual([...new Set([...input.values].filter((value) => value >= 0))])
    for (let row = 0; row < input.values.length; ++row) {
        expect(getPersistedTermSequence(parsed, row)).toBe(input.values[row] < 0 ? null : input.values[row])
    }
    return parsed
}

/**
 * @param {number} value
 * @returns {number}
 */
function sequenceHash(value) {
    let hash = 0x811c9dc5
    for (let shift = 0; shift < 32; shift += 8) { hash = Math.imul(hash ^ ((value >>> shift) & 0xff), 0x01000193) }
    return hash >>> 0
}

describe.each([false, true])('native lookup sequence interning with output tail scratch: %s', (reuseOutput) => {
    test.each([
        ['zero', [0]],
        ['maximum int32', [0x7fffffff]],
        ['absent', [-1, -2, -0x80000000]],
        ['increasing', [0, 1, 17, 1000, 0x7fffffff]],
        ['repeated', [0, 0, 1, 1, 1, 0x7fffffff, 0x7fffffff]],
        ['missing between repeats', [-1, 0, -2, 0, 10, -0x80000000, 10, 20, -1]],
    ])('preserves %s sequences with dirty hash scratch', (_name, values) => {
        const input = fixture(/** @type {number[]} */ (values), reuseOutput)
        check(input)
    })

    test.each([
        ['immediate decrease', [7, 3, 7, 9]],
        ['decrease to existing key', [0, 3, 7, 3, 7, 0, 10]],
        ['decrease to new key', [2, 4, 8, 6, 10, 4, 6, 0]],
        ['absent across first decrease', [0, 5, 9, -1, -0x80000000, 5, -1, 0, 7]],
        ['descending', [0x7fffffff, 10000, 10, 9, 8, 1, 0]],
        ['repeated decreases', [3, 4, 5, 2, 3, 1, 0, 5, 4, 3, 2, 1, 0]],
    ])('backfills first-seen keys on %s', (_name, values) => {
        const input = fixture(/** @type {number[]} */ (values), reuseOutput)
        const index = check(input)
        for (const value of new Set(input.values)) {
            const rows = [...input.values.keys()].filter((row) => input.values[row] === value && value >= 0).reverse()
            expect([...findSequenceRows(index, value)]).toEqual(rows)
        }
    })

    test('backfills colliding keys and probes new colliding keys after a decrease', () => {
        const collisions = []
        for (let value = 0; collisions.length < 6; ++value) {
            if ((sequenceHash(value) & 15) === 3) { collisions.push(value) }
        }
        const [a, b, c, d, e, f] = collisions
        const input = fixture([a, b, c, d, b, e, a, f, d], reuseOutput)
        expect(input.args[16]).toBe(16)
        check(input)
    })

    test.each([2, 64, 1024, 32768])('fills a %i-slot table after a final new decreasing key', (count) => {
        const input = fixture(Int32Array.from({length: count}, (_, i) => (i === count - 1 ? 0 : i + 1)), reuseOutput)
        check(input)
    })

    test('retains the maximum supported row and sequence-key cardinality', () => {
        const input = fixture(Int32Array.from({length: 0xfffe}, (_, i) => i), reuseOutput)
        check(input)
        input.args[10] = 0xffff
        expect(input.encode().status).toBe(-1)
    })

    test('backfills a nearly full prefix after absent rows and retains the final maximum int32 key', () => {
        const values = Int32Array.from({length: 0xfffe}, (_, i) => i)
        values.set([-1, -0x80000000, 0, 0x7fffffff], values.length - 4)
        check(fixture(values, reuseOutput))
    })

    test('retains exact indexes across repeated calls using populated and dirty scratch', () => {
        const input = fixture([0, 3, 7, 9, 0x7fffffff, 0x7fffffff], reuseOutput)
        check(input)
        input.values.set([0, 0x7fffffff, -1, 0x7fffffff, 0, 0x7fffffff])
        new Int32Array(wasm.memory.buffer, input.args[9], input.values.length).set(input.values)
        check(input)
        input.values.set([-1, 2, 2, -1, 0x7fffffff, 0x7fffffff])
        new Int32Array(wasm.memory.buffer, input.args[9], input.values.length).set(input.values)
        check(input)
        input.slots().fill(0xcafe)
        input.values.set([0x7fffffff, 5, -1, 2, 5, 0x7fffffff])
        new Int32Array(wasm.memory.buffer, input.args[9], input.values.length).set(input.values)
        check(input)
    })

    test.each([false, true])('preserves validation and recovery with a decreasing prefix: %s', (decreasing) => {
        const input = fixture(decreasing ? [0, 3, 7, 3, 9, 10] : [0, 3, 7, 7, 9, 10], reuseOutput)
        const expressions = new Uint32Array(wasm.memory.buffer, input.args[6], input.values.length)
        const readings = new Uint32Array(wasm.memory.buffer, input.args[7], input.values.length)
        const equals = new Uint8Array(wasm.memory.buffer, input.args[8], input.values.length)
        expressions[5] = 2
        expect(input.encode().status).toBe(-2)
        expressions[5] = input.plan.expressionIndexes[5]
        equals[5] = 2
        expect(input.encode().status).toBe(-2)
        equals[5] = input.equals[5]
        readings[5] = 2
        expect(input.encode().status).toBe(-2)
        readings[5] = input.plan.readingIndexes[5]
        const capacity = input.args[12]
        input.args[12] = 16
        expect(input.encode().status).toBe(-4)
        input.args[12] = capacity
        const lengths = new Uint16Array(wasm.memory.buffer, input.args[2], 2)
        lengths[1] = 0
        expect(input.encode().status).toBe(-5)
        lengths[1] = 1
        check(input)
    })
})

test('output tail scratch preserves live prefix keys through a decrease, failure and retry', () => {
    const input = fixture([0, 3, 7, 3, 9, 10], true)
    const output = input.args[11]
    const separateStrings = input.args[0]
    const keyBytesOffset = 16 + 32
    const keyBytes = new Uint8Array(wasm.memory.buffer, output + keyBytesOffset, input.plan.stringsBuffer.byteLength)
    keyBytes.set(input.plan.stringsBuffer)
    input.args[0] = keyBytes.byteOffset
    const prefix = new Uint8Array(wasm.memory.buffer, output, keyBytesOffset + keyBytes.byteLength)
    const expectedPrefix = new Uint8Array(prefix)
    expect(input.args[15] % 4).toBe(0)
    expect(input.args[15]).toBeGreaterThanOrEqual(prefix.byteOffset + prefix.byteLength)
    expect(input.args[15] + input.args[16] * 2).toBeLessThanOrEqual(output + input.args[12])

    // A late invalid row fails after the first decrease initialized the slots,
    // but before output initialization. Live key input must still be intact.
    const expressions = new Uint32Array(wasm.memory.buffer, input.args[6], input.values.length)
    expressions[5] = input.args[5]
    expect(input.encode().status).toBe(-2)
    expect(prefix).toEqual(expectedPrefix)
    expressions[5] = input.plan.expressionIndexes[5]

    const capacity = input.args[12]
    input.args[12] = 16
    expect(input.encode().status).toBe(-4)
    expect(prefix).toEqual(expectedPrefix)
    input.args[12] = capacity
    input.args[0] = separateStrings
    check(input)
})
