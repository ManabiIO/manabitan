/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {beforeAll, expect, test} from 'vitest'
import {hashTermKeyBytes} from '../ext/js/dictionary/term-key-hash.js'
import {encodePersistedTermLookupIndexFromPreinternedPlan} from '../ext/js/dictionary/term-lookup-index.js'

/** @typedef {{memory: WebAssembly.Memory, wasm_reset_heap: () => void, wasm_alloc: (size: number) => number, encode_term_lookup_index: (...args: number[]) => number}} NativeLookup */
/** @type {NativeLookup} */
let wasm

beforeAll(async () => {
    const bytes = await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))
    const {instance} = await WebAssembly.instantiate(bytes)
    wasm = /** @type {NativeLookup} */ (/** @type {unknown} */ (instance.exports))
})

/**
 * @param {number[]} keyLengths
 * @param {number} rowCount
 * @returns {{encode: (dirty: number) => void, equals: Uint8Array, sequences: Int32Array}}
 */
function fixture(keyLengths, rowCount) {
    wasm.wasm_reset_heap()
    const keyCount = keyLengths.length
    const stringOffsets = new Uint32Array(keyCount)
    let length = 0
    for (let i = 0; i < keyCount; ++i) {
        stringOffsets[i] = length
        length += keyLengths[i]
    }
    const stringsBuffer = new Uint8Array(length)
    for (let i = 0; i < keyCount; ++i) {
        stringsBuffer.fill(33 + i, stringOffsets[i], stringOffsets[i] + keyLengths[i])
    }
    const plan = {
        stringsBuffer,
        stringLengths: new Uint16Array(keyLengths),
        stringOffsets,
        stringHashes: Uint32Array.from(keyLengths, (size, i) => hashTermKeyBytes(stringsBuffer.subarray(stringOffsets[i], stringOffsets[i] + size))),
        expressionIndexes: Uint32Array.from({length: rowCount}, (_, i) => i % keyCount),
        readingIndexes: Uint32Array.from({length: rowCount}, (_, i) => (i + 1) % keyCount),
    }
    const equals = new Uint8Array(rowCount)
    const sequences = Int32Array.from({length: rowCount}, (_, i) => (i % 3 === 0 ? -1 : rowCount - i))
    /**
     * @param {ArrayBufferView} value
     * @returns {number}
     */
    const put = (value) => {
        const pointer = wasm.wasm_alloc(Math.max(8, value.byteLength))
        new Uint8Array(wasm.memory.buffer, pointer, value.byteLength).set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
        return pointer
    }
    const capacity = length + rowCount * 64 + keyCount * 32 + 256
    const guardedOutput = put(new Uint8Array(capacity + 32).fill(0x5a))
    let slotCount = 1
    while (slotCount < rowCount) { slotCount *= 2 }
    const args = [
        put(plan.stringsBuffer),
        length,
        put(plan.stringLengths),
        put(plan.stringOffsets),
        put(plan.stringHashes),
        keyCount,
        put(plan.expressionIndexes),
        put(plan.readingIndexes),
        put(equals),
        put(sequences),
        rowCount,
        guardedOutput + 16,
        capacity,
        put(new Int32Array(rowCount)),
        put(new Uint16Array(rowCount)),
        put(new Uint16Array(slotCount)),
        slotCount,
    ]
    return {
        equals,
        sequences,
        encode(dirty) {
            new Uint8Array(wasm.memory.buffer, args[8], rowCount).set(equals)
            new Int32Array(wasm.memory.buffer, args[9], rowCount).set(sequences)
            new Uint8Array(wasm.memory.buffer, args[11], capacity).fill(dirty)
            new Uint16Array(wasm.memory.buffer, args[15], slotCount).fill(dirty * 257)
            const expected = encodePersistedTermLookupIndexFromPreinternedPlan(plan, equals, sequences, rowCount)
            const size = wasm.encode_term_lookup_index(...args)
            expect(size).toBe(expected.length)
            expect(Buffer.compare(new Uint8Array(wasm.memory.buffer, args[11], size), expected)).toBe(0)
            expect(new Uint8Array(wasm.memory.buffer, guardedOutput, 16)).toEqual(new Uint8Array(16).fill(0x5a))
            expect(new Uint8Array(wasm.memory.buffer, args[11] + size, capacity - size)).toEqual(new Uint8Array(capacity - size).fill(dirty))
            expect(new Uint8Array(wasm.memory.buffer, args[11] + capacity, 16)).toEqual(new Uint8Array(16).fill(0x5a))
        },
    }
}

for (let keyBytesModulo = 0; keyBytesModulo < 4; ++keyBytesModulo) {
    test.each([1, 2, 7, 8, 127, 128])(`keeps exact bytes with key alignment ${keyBytesModulo} and %i rows`, (rowCount) => {
        const input = fixture([1, 2, 5 + keyBytesModulo], rowCount)
        input.encode(0xa5)
        input.equals.fill(1)
        input.sequences.fill(-1)
        input.encode(0xff)
        for (let row = 0; row < rowCount; ++row) {
            input.equals[row] = row & 1
            input.sequences[row] = row % 5
        }
        input.encode(0x3c)
    })
}

test.each([1, 2, 31, 32, 63, 64])('initializes populated and empty hash buckets with %i unique keys', (keyCount) => {
    const input = fixture(Array.from({length: keyCount}, (_, i) => 1 + i % 17), keyCount * 3)
    input.encode(0xff)
    input.sequences.fill(0x7fffffff)
    input.equals.fill(1)
    input.encode(0xa5)
})

test('keeps long keys and every alignment byte exact in dirty output storage', () => {
    fixture([1, 32767, 65534], 17).encode(0xa5)
})
