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
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {Buffer} from 'node:buffer'
import {describe, expect, test} from 'vitest'
import {createTermRecordPreinternedPlanBuilder} from '../ext/js/dictionary/term-record-preinterned-plan.js'
import {encodePersistedTermLookupIndexFromPreinternedPlan} from '../ext/js/dictionary/term-lookup-index.js'

const encoder = new TextEncoder()
const binary = await readFile(new URL('../dev/data/dictionary-wasm/term-bank-parser.wasm', import.meta.url))
/** @typedef {{memory: WebAssembly.Memory, wasm_alloc: (bytes: number) => number, encode_term_lookup_index: (...args: number[]) => number}} NativeLookupWasm */

/**
 * @param {number} rowCount
 * @param {number} padding
 * @param {number} sequenceMode
 * @returns {Promise<{wasm: NativeLookupWasm, args: number[], check: (pattern: number) => void}>}
 */
async function fixture(rowCount, padding, sequenceMode) {
    const builder = createTermRecordPreinternedPlanBuilder()
    const expressions = new Uint32Array(rowCount)
    const readings = new Uint32Array(rowCount)
    const equals = new Uint8Array(rowCount)
    const sequences = new Int32Array(rowCount)
    for (let row = 0; row < rowCount; ++row) {
        const expression = encoder.encode(String.fromCharCode(97 + row % 19) + 'x'.repeat(padding))
        expressions[row] = builder.internStringBytes(expression)
        equals[row] = row % 3 === 0 ? 1 : 0
        // Explicit identical readings retain a posting despite sharing a key.
        readings[row] = row % 3 === 2 ? builder.internStringBytes(encoder.encode(`reading-${row % 11}`)) : expressions[row]
        let sequence = -1
        if (sequenceMode === 1) { sequence = 0 }
        if (sequenceMode === 2 && row % 3 !== 0) { sequence = 2147483647 - row % 7 }
        sequences[row] = sequence
    }
    const plan = builder.buildPlan(expressions, readings)
    if (!(plan.stringOffsets instanceof Uint32Array) || !(plan.stringHashes instanceof Uint32Array)) {
        throw new Error('Expected complete native string metadata')
    }
    const expected = encodePersistedTermLookupIndexFromPreinternedPlan(plan, equals, sequences, rowCount)
    const {instance} = await WebAssembly.instantiate(binary)
    const wasm = /** @type {NativeLookupWasm} */ (instance.exports)
    /** @type {Array<{pointer: number, bytes: Uint8Array}>} */
    const inputs = []
    /**
     * @param {ArrayBufferView} value
     * @returns {number}
     */
    const put = (value) => {
        const pointer = wasm.wasm_alloc(value.byteLength)
        const bytes = Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
        new Uint8Array(wasm.memory.buffer, pointer, bytes.length).set(bytes)
        inputs.push({pointer, bytes})
        return pointer
    }
    let slots = 1
    while (slots < rowCount) { slots *= 2 }
    const outputCapacity = expected.length + 32
    const allocation = wasm.wasm_alloc(outputCapacity + 16)
    const output = allocation + 8
    const args = [
        put(plan.stringsBuffer),
        plan.stringsBuffer.length,
        put(plan.stringLengths),
        put(plan.stringOffsets),
        put(plan.stringHashes),
        plan.stringLengths.length,
        put(expressions),
        put(readings),
        put(equals),
        put(sequences),
        rowCount,
        output,
        outputCapacity,
        wasm.wasm_alloc(rowCount * 4),
        wasm.wasm_alloc(rowCount * 2),
        wasm.wasm_alloc(slots * 2),
        slots,
    ]
    /** @param {number} pattern */
    const check = (pattern) => {
        new Uint8Array(wasm.memory.buffer, allocation, outputCapacity + 16).fill(pattern)
        expect(wasm.encode_term_lookup_index(...args)).toBe(expected.length)
        expect(Buffer.compare(new Uint8Array(wasm.memory.buffer, output, expected.length), expected)).toBe(0)
        expect(new Uint8Array(wasm.memory.buffer, allocation, 8)).toStrictEqual(new Uint8Array(8).fill(pattern))
        const tailLength = outputCapacity + 8 - expected.length
        expect(new Uint8Array(wasm.memory.buffer, output + expected.length, tailLength)).toStrictEqual(new Uint8Array(tailLength).fill(pattern))
        for (const input of inputs) {
            expect(Buffer.compare(new Uint8Array(wasm.memory.buffer, input.pointer, input.bytes.length), input.bytes)).toBe(0)
        }
    }
    return {wasm, args, check}
}

describe('native lookup output initialization', () => {
    const cases = [1, 2, 3, 8, 47].flatMap((rows) => [0, 1, 2, 3].flatMap((padding) => [0, 1, 2].map((sequenceMode) => ({rows, padding, sequenceMode}))))

    test.each(cases)('matches all portable bytes in reused storage: $rows rows, padding $padding, sequences $sequenceMode', async ({rows, padding, sequenceMode}) => {
        const {check} = await fixture(rows, padding, sequenceMode)
        check(0xa5)
        check(0xff)
    })

    test('initializes full posting tables below the uint16 row sentinel', async () => {
        const {wasm, args, check} = await fixture(65534, 1, 1)
        check(0xee)
        args[10] = 65535
        expect(wasm.encode_term_lookup_index(...args)).toBe(-1)
    })

    test('reinitializes reused output after invalid keys, empty strings and insufficient capacity', async () => {
        const {wasm, args, check} = await fixture(47, 1, 2)
        check(0x77)
        const expressions = new Uint32Array(wasm.memory.buffer, args[6], args[10])
        const originalExpression = expressions[46]
        expressions[46] = args[5]
        expect(wasm.encode_term_lookup_index(...args)).toBe(-2)
        expressions[46] = originalExpression
        check(0xcc)

        const lengths = new Uint16Array(wasm.memory.buffer, args[2], args[5])
        const originalLength = lengths[0]
        lengths[0] = 0
        expect(wasm.encode_term_lookup_index(...args)).toBe(-5)
        lengths[0] = originalLength
        check(0x99)

        const capacity = args[12]
        args[12] = 1
        expect(wasm.encode_term_lookup_index(...args)).toBe(-4)
        args[12] = capacity
        check(0x55)
    })
})
