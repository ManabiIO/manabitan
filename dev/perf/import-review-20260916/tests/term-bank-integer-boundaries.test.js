/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {beforeAll, describe, expect, test} from 'vitest'

/** @typedef {{memory: WebAssembly.Memory, wasm_reset_heap: () => void, wasm_alloc: (size: number) => number, parse_term_bank: (...args: number[]) => number, parse_term_bank_with_media_hints: (...args: number[]) => number}} Exports */
/** @type {Exports} */
let wasm
const encoder = new TextEncoder()

beforeAll(async () => {
    const bytes = await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))
    wasm = /** @type {Exports} */ (/** @type {unknown} */ ((await WebAssembly.instantiate(bytes)).instance.exports))
})

/**
 * @param {string} score
 * @param {string} sequence
 * @param {number} [alignment]
 * @param {boolean} [physicalEnd]
 * @param {boolean} [mediaHints]
 * @returns {{count: number, score: number, sequence: number}}
 */
function parse(score, sequence, alignment = 0, physicalEnd = false, mediaHints = false) {
    wasm.wasm_reset_heap()
    const bytes = encoder.encode(`[["entry","reading","noun","",${score},["definition"],${sequence},""]]`)
    const guard = wasm.wasm_alloc(100)
    const output = guard + 16
    const allocation = wasm.wasm_alloc(bytes.length + 32)
    const heap = new Uint8Array(wasm.memory.buffer)
    const input = physicalEnd ? heap.length - bytes.length : allocation + alignment
    heap.fill(0x30, allocation, allocation + bytes.length + 32)
    heap.set(bytes, input)
    heap.fill(0xa5, guard, guard + 100)
    const parseBank = mediaHints ? wasm.parse_term_bank_with_media_hints : wasm.parse_term_bank
    const count = parseBank(input, bytes.length, output, 1, 0, 0)
    expect([...heap.subarray(guard, output)]).toEqual(new Array(16).fill(0xa5))
    expect([...heap.subarray(output + 68, output + 84)]).toEqual(new Array(16).fill(0xa5))
    const fields = new Int32Array(wasm.memory.buffer, output, 17)
    return {count, score: fields[8], sequence: fields[11]}
}

/**
 * @param {string} token
 * @returns {boolean}
 */
function isInt32(token) {
    if (token === 'null') { return true }
    if (!/^-?(?:0|[1-9]\d*)$/.test(token)) { return false }
    const value = BigInt(token)
    return value >= -2147483648n && value <= 2147483647n
}

/**
 * Compare native acceptance with an independent arbitrary-precision oracle.
 * @param {string} token
 * @param {number} [alignment]
 * @param {boolean} [physicalEnd]
 */
function check(token, alignment = 0, physicalEnd = false) {
    const valid = isInt32(token)
    for (const mediaHints of [false, true]) {
        for (const field of ['score', 'sequence']) {
            const result = parse(field === 'score' ? token : '17', field === 'sequence' ? token : '-23', alignment, physicalEnd, mediaHints)
            expect(result.count > 0, `${field}: ${token}`).toBe(valid)
            if (!valid) { continue }
            const expected = token === 'null' ? (field === 'score' ? 0 : -1) : Number(BigInt(token))
            expect(result[field === 'score' ? 'score' : 'sequence']).toBe(expected)
            expect(result[field === 'score' ? 'sequence' : 'score']).toBe(field === 'score' ? -23 : 17)
        }
    }
}

describe('native score and sequence integer boundaries', () => {
    test.each(Array.from({length: 16}, (_, i) => i))('preserves signed limits, null and zero at input alignment %i', (alignment) => {
        for (const token of ['null', '0', '-0', '1', '-1', '2147483639', '2147483640', '2147483646', '2147483647', '-2147483647', '-2147483648', '2147483648', '-2147483649']) {
            check(token, alignment)
        }
    })

    test('checks every last digit at both overflow thresholds', () => {
        for (let prefix = 214748360; prefix <= 214748368; ++prefix) {
            for (let digit = 0; digit < 10; ++digit) {
                for (const sign of ['', '-']) { check(`${sign}${prefix}${digit}`, digit) }
            }
        }
    })

    test('rejects arbitrarily long integers without accumulator wrapping', () => {
        for (const width of [10, 11, 16, 20, 64, 257, 4096]) {
            for (const sign of ['', '-']) {
                for (const token of [`${sign}${'9'.repeat(width)}`, `${sign}1${'0'.repeat(width)}`]) { check(token, width % 16, true) }
            }
        }
        for (const token of ['4294967296', '4294967297', '-4294967296', '18446744073709551616', '-18446744073709551616']) { check(token) }
    })

    test('retains strict JSON integer syntax rather than accepting prefixes or coercions', () => {
        for (const token of ['', '-', '+1', '01', '-01', '00', '-00', '1.0', '-0.0', '1e0', '1E+1', 'NaN', 'Infinity', 'true', 'false', 'undefined', '"1"', '[]', '{}', 'nUll', 'nul', 'nullx', '1x', '1 2', '--1', '0x10', '１２']) {
            check(token, 7)
            check(token, 0, true)
        }
    })

    test('agrees with arbitrary precision on deterministic signed and oversized values', () => {
        let state = 0x12345678
        for (let i = 0; i < 1000; ++i) {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0
            check(String(state | 0), i % 16)
            check(String(BigInt(state) + (i % 2 === 0 ? 2147483600n : -4294967296n)), i % 16)
        }
    })
})
