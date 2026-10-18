/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {beforeAll, describe, expect, test} from 'vitest'

/** @typedef {{memory: WebAssembly.Memory, wasm_reset_heap: () => void, wasm_alloc: (size: number) => number, parse_term_bank_with_media_hints: (...args: number[]) => number}} Exports */
/** @type {Exports} */
let wasm
const encoder = new TextEncoder()
const decoder = new TextDecoder()

beforeAll(async () => {
    const bytes = await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))
    wasm = /** @type {Exports} */ (/** @type {unknown} */ ((await WebAssembly.instantiate(bytes)).instance.exports))
})

/**
 * @param {string[]} banks
 * @param {number} [alignment]
 * @param {boolean} [physicalEnd]
 * @returns {{count: number, metadata: number[], bytes: Uint8Array}}
 */
function parse(banks, alignment = 0, physicalEnd = false) {
    wasm.wasm_reset_heap()
    const bytes = encoder.encode(banks.join(''))
    const spanPointer = wasm.wasm_alloc(Math.max(8, banks.length * 8))
    const guarded = wasm.wasm_alloc(100)
    const output = guarded + 16
    const allocation = wasm.wasm_alloc(bytes.length + 96)
    const heap = new Uint8Array(wasm.memory.buffer)
    const input = physicalEnd ? heap.length - bytes.length : allocation + alignment
    heap.fill(0x22, allocation, allocation + bytes.length + 96)
    heap.set(bytes, input)
    heap.fill(0xa5, guarded, output + 84)
    const spans = new Uint32Array(wasm.memory.buffer, spanPointer, banks.length * 2)
    let cursor = 0
    for (const [i, bank] of banks.entries()) {
        const length = encoder.encode(bank).length
        spans[i * 2] = cursor
        spans[i * 2 + 1] = length
        cursor += length
    }
    const count = wasm.parse_term_bank_with_media_hints(input, bytes.length, output, 1, banks.length > 1 ? spanPointer : 0, banks.length > 1 ? banks.length : 0)
    expect([...heap.subarray(guarded, output)]).toEqual(new Array(16).fill(0xa5))
    expect([...heap.subarray(output + 68, output + 84)]).toEqual(new Array(16).fill(0xa5))
    return {count, metadata: [...new Uint32Array(wasm.memory.buffer, output, 17)], bytes}
}

/**
 * @param {ReturnType<typeof parse>} result
 * @param {number} column
 * @returns {unknown}
 */
function read(result, column) {
    const start = result.metadata[column]
    const length = result.metadata[column + 1]
    expect(start + length).toBeLessThanOrEqual(result.bytes.length)
    return JSON.parse(decoder.decode(result.bytes.subarray(start, start + length)))
}

/**
 * @param {string} token
 * @returns {string}
 */
function bank(token) { return `[[${token},"reading","noun","",-12,[${token}],123,""]]` }

describe('first special byte scanning', () => {
    test.each(Array.from({length: 16}, (_, i) => i))('preserves nearest markers and Unicode at input alignment %i', (alignment) => {
        for (let width = 0; width < 65; ++width) {
            for (const tail of ['#', ']', ' ', '\\"#', '\\u0022#', '\\u005c]', '\\u001f ', '\\n', '日🙂']) {
                const token = `"${'a'.repeat(width)}${tail}"`
                const result = parse([bank(token)], alignment)
                expect(result.count).toBe(1)
                expect(read(result, 0)).toEqual(JSON.parse(token))
                expect(read(result, 9)).toEqual([JSON.parse(token)])
                expect(result.metadata[1]).toBe(encoder.encode(token).length)
            }
        }
    })

    test.each([0, 1, 7, 8, 15, 16, 31, 32, 63, 64, 127])('rejects all raw controls before the closing quote at width %i', (width) => {
        for (let control = 0; control < 32; ++control) {
            // A space immediately after the control exercises subtraction borrow.
            const token = `"${'z'.repeat(width)}${String.fromCharCode(control)} #]"`
            expect(parse([bank(token)], width % 16).count).toBe(-1)
        }
    })

    test('rejects each truncated prefix at logical and physical memory ends', () => {
        for (const token of ['"ordinary #] text"', String.raw`"\u0041\\\"#日🙂"`]) {
            const source = bank(token)
            for (let length = 1; length < source.length; ++length) {
                expect(parse([source.slice(0, length)], length % 16).count).toBe(-1)
                expect(parse([source.slice(0, length)], 0, true).count).toBe(-1)
            }
            expect(parse([source], 0, true).count).toBe(1)
        }
    })

    test('never completes a token with bytes from the next independently bounded bank', () => {
        const source = bank('"1234567\\u0022#1234567\\\\]"')
        for (let split = 1; split < source.length; ++split) {
            expect(parse([source.slice(0, split), source.slice(split)]).count).toBe(-1)
        }
    })

    test('preserves strings and metadata throughout nested object and array validation', () => {
        const glossary = ['a"#b', {type: 'text', text: '\\]'}, {type: 'structured-content', content: {tag: 'span', content: ['日🙂', '', {tag: 'img', path: 'pic.png'}]}}]
        const source = JSON.stringify([['key', 'reading', 'noun', '', 0, glossary, 1, 'common']])
        const result = parse([source], 7)
        expect(result.count).toBe(1)
        expect(read(result, 9)).toEqual(glossary)
        expect(result.metadata[14]).toBe(1)
    })

    test('rejects malformed escapes after long ordinary runs without weakening grammar', () => {
        for (const escape of ['\\q', '\\u', '\\u000', '\\u00xz', '\\u-001', '\\u 000', '\\U0001']) {
            for (const width of [0, 7, 8, 15, 16, 31, 1024, 65535]) {
                expect(parse([bank(`"${'x'.repeat(width)}${escape}"`)], 3).count).toBe(-1)
            }
        }
    })
})
