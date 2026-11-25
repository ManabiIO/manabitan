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

import {readFile} from 'node:fs/promises'
import {beforeAll, describe, expect, test} from 'vitest'
import {hashTermKeyBytes} from '../ext/js/dictionary/term-key-hash.js'
import {encodePersistedTermLookupIndexFromPreinternedPlan, parsePersistedTermLookupIndex} from '../ext/js/dictionary/term-lookup-index.js'

/** @typedef {{memory: WebAssembly.Memory, wasm_reset_heap: () => void, wasm_alloc: (size: number) => number, encode_term_lookup_index: (...args: number[]) => number}} NativeLookup */
/** @type {NativeLookup} */
let wasm
const encoder = new TextEncoder()

beforeAll(async () => {
    const bytes = await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))
    const {instance} = await WebAssembly.instantiate(bytes)
    wasm = /** @type {NativeLookup} */ (/** @type {unknown} */ (instance.exports))
})

/**
 * @param {ArrayBufferView} value
 * @returns {number}
 */
function put(value) {
    const pointer = wasm.wasm_alloc(Math.max(8, value.byteLength))
    new Uint8Array(wasm.memory.buffer, pointer, value.byteLength).set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
    return pointer
}

/**
 * @param {string[]} keys
 * @param {number[]} sequences
 * @param {number} output
 * @param {number} capacity
 * @param {boolean} alias
 * @returns {{args: number[], expected: Uint8Array, encode: () => number}}
 */
function input(keys, sequences, output, capacity, alias) {
    const encodedKeys = keys.map((key) => encoder.encode(key))
    const lengths = Uint16Array.from(encodedKeys, (key) => key.byteLength)
    const offsets = new Uint32Array(keys.length)
    let total = 0
    for (let key = 0; key < keys.length; ++key) {
        offsets[key] = total
        total += lengths[key]
    }
    const strings = new Uint8Array(total)
    for (let key = 0; key < keys.length; ++key) { strings.set(encodedKeys[key], offsets[key]) }
    const rowCount = sequences.length
    const plan = {
        stringLengths: lengths,
        stringOffsets: offsets,
        stringHashes: Uint32Array.from(encodedKeys, hashTermKeyBytes),
        stringsBuffer: strings,
        expressionIndexes: Uint32Array.from({length: rowCount}, (_, row) => row % keys.length),
        readingIndexes: Uint32Array.from({length: rowCount}, (_, row) => (row + 1) % keys.length),
    }
    const equals = Uint8Array.from({length: rowCount}, (_, row) => Number(row % 3 === 0))
    const values = Int32Array.from(sequences)
    let slotCount = 1
    while (slotCount < rowCount) { slotCount *= 2 }
    const stringsPointer = alias ? output + 48 : put(strings)
    const args = [
        stringsPointer,
        total,
        put(lengths),
        put(offsets),
        put(plan.stringHashes),
        keys.length,
        put(plan.expressionIndexes),
        put(plan.readingIndexes),
        put(equals),
        put(values),
        rowCount,
        output,
        capacity,
        put(new Int32Array(rowCount).fill(-123)),
        put(new Uint16Array(rowCount).fill(0xabcd)),
        put(new Uint16Array(slotCount).fill(0xcafe)),
        slotCount,
    ]
    new Uint8Array(wasm.memory.buffer, stringsPointer, total).set(strings)
    return {
        args,
        expected: encodePersistedTermLookupIndexFromPreinternedPlan(plan, equals, values, rowCount),
        encode: () => wasm.encode_term_lookup_index(...args),
    }
}

describe('native lookup keys in the final output buffer', () => {
    test.each([0, 1, 2, 3])('preserves staged keys and clears dirty padding at alignment %i', (padding) => {
        wasm.wasm_reset_heap()
        const capacity = 8192
        const allocation = put(new Uint8Array(capacity + 32).fill(0xa5))
        const output = allocation + 16
        const testInput = input(['単語', `a${'b'.repeat(padding)}`], [0, -1, 2, 2, 1, -1, 0], output, capacity, true)
        const length = testInput.encode()
        expect(length).toBe(testInput.expected.byteLength)
        expect(Buffer.compare(new Uint8Array(wasm.memory.buffer, output, length), testInput.expected)).toBe(0)
        expect([...new Uint8Array(wasm.memory.buffer, allocation, 16)]).toEqual(new Array(16).fill(0xa5))
        expect([...new Uint8Array(wasm.memory.buffer, output + capacity, 16)]).toEqual(new Array(16).fill(0xa5))
        expect([...new Uint8Array(wasm.memory.buffer, output + length, capacity - length)]).toEqual(new Array(capacity - length).fill(0xa5))
    })

    test('reuses dirty output across smaller, larger, aliased and separate source keys', () => {
        wasm.wasm_reset_heap()
        const capacity = 180000
        const output = put(new Uint8Array(capacity).fill(0xa5))
        for (const [keys, values, alias] of /** @type {Array<[string[], number[], boolean]>} */ ([
            [['語'.repeat(20000), '長'.repeat(10000)], [2, 3, 5, 7, 5, -1, 2], true],
            [['x'], [-1, -2, -0x80000000], true],
            [['日本語', 'reading', 'other'], [0, 1, 0x7fffffff, 0, 0, -1, 3], false],
            [['smaller', '字'], [4, 4, 4, -1, 2], true],
        ])) {
            const testInput = input(keys, values, output, capacity, alias)
            const length = testInput.encode()
            expect(length).toBe(testInput.expected.byteLength)
            const bytes = new Uint8Array(wasm.memory.buffer, output, length)
            expect(Buffer.compare(bytes, testInput.expected)).toBe(0)
            expect(parsePersistedTermLookupIndex(bytes).expressionKeys.length).toBe(values.length)
        }
    })

    test('keeps staged bytes intact on capacity failure and validates all key spans on retry', () => {
        wasm.wasm_reset_heap()
        const capacity = 1024
        const output = put(new Uint8Array(capacity).fill(0xa5))
        const testInput = input(['first', 'unused'], [0], output, capacity, true)
        const keyBytes = new Uint8Array(new Uint8Array(wasm.memory.buffer, output + 48, 11))
        testInput.args[12] = testInput.expected.byteLength - 1
        expect(testInput.encode()).toBe(-4)
        expect(new Uint8Array(wasm.memory.buffer, output + 48, 11)).toEqual(keyBytes)
        testInput.args[12] = capacity
        new Uint32Array(wasm.memory.buffer, testInput.args[3], 2)[1] = 4
        expect(testInput.encode()).toBe(-5)
        expect(new Uint8Array(wasm.memory.buffer, output + 48, 11)).toEqual(keyBytes)
        new Uint32Array(wasm.memory.buffer, testInput.args[3], 2)[1] = 5
        expect(testInput.encode()).toBe(testInput.expected.byteLength)
        expect(Buffer.compare(new Uint8Array(wasm.memory.buffer, output, testInput.expected.byteLength), testInput.expected)).toBe(0)
    })
})
