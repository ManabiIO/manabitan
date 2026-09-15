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
 * Guard the metadata destination and put misleading quotes beyond logical EOF.
 * Physical-end fixtures instead place the last input byte at the end of memory.
 * @param {string[]} banks
 * @param {number} [alignment]
 * @param {boolean} [physicalEnd]
 * @returns {{count: number, metadata: number[], bytes: Uint8Array}}
 */
function parse(banks, alignment = 0, physicalEnd = false) {
    wasm.wasm_reset_heap()
    const parts = banks.map((bank) => encoder.encode(bank))
    const bytes = encoder.encode(banks.join(''))
    const spanPointer = wasm.wasm_alloc(Math.max(8, banks.length * 8))
    const guarded = wasm.wasm_alloc(32 + 68)
    const output = guarded + 16
    const allocated = wasm.wasm_alloc(bytes.length + 128)
    const heap = new Uint8Array(wasm.memory.buffer)
    const input = physicalEnd ? heap.length - bytes.length : allocated + alignment
    heap.fill(0x22, allocated, allocated + bytes.length + 128)
    heap.set(bytes, input)
    heap.fill(0xa5, guarded, output + 68 + 16)
    const spans = new Uint32Array(wasm.memory.buffer, spanPointer, banks.length * 2)
    let offset = 0
    for (const [i, part] of parts.entries()) {
        spans[i * 2] = offset
        spans[i * 2 + 1] = part.length
        offset += part.length
    }
    const count = wasm.parse_term_bank_with_media_hints(
        input, bytes.length, output, 1, banks.length > 1 ? spanPointer : 0, banks.length > 1 ? banks.length : 0,
    )
    expect([...heap.subarray(guarded, output)]).toEqual(new Array(16).fill(0xa5))
    expect([...heap.subarray(output + 68, output + 68 + 16)]).toEqual(new Array(16).fill(0xa5))
    return {count, metadata: [...new Uint32Array(wasm.memory.buffer, output, 17)], bytes}
}

/**
 * Decode only the span the native parser returned; JSON.parse is the oracle.
 * @param {ReturnType<typeof parse>} result
 * @param {number} field
 * @returns {unknown}
 */
function fieldValue(result, field) {
    const start = result.metadata[field]
    const length = result.metadata[field + 1]
    expect(start + length).toBeLessThanOrEqual(result.bytes.length)
    return JSON.parse(decoder.decode(result.bytes.subarray(start, start + length)))
}

/**
 * @param {string} token
 * @returns {string}
 */
function sourceWithToken(token) { return `[[${token},"","","",0,[""],-1,""]]` }

const fields = [0, 2, 4, 6, 9, 12]

describe('empty string parser boundaries', () => {
    test.each(Array.from({length: 16}, (_, i) => i))('preserves all empty/nonempty field combinations at alignment %i', (alignment) => {
        for (let mask = 0; mask < 64; ++mask) {
            const values = Array.from({length: 6}, (_, i) => (mask & (1 << i)) === 0 ? '' : '日🙂"\\')
            const row = [values[0], values[1], values[2], values[3], 0, [values[4]], -1, values[5]]
            const source = `${' '.repeat(alignment)}${JSON.stringify([row])}`
            const result = parse([source], alignment)
            expect(result.count).toBe(1)
            for (const [i, field] of fields.entries()) {
                expect(fieldValue(result, field)).toEqual(i === 4 ? [values[i]] : values[i])
                if (i !== 4 && values[i] === '') { expect(result.metadata[field + 1]).toBe(2) }
            }
        }
    })

    test('rejects every truncated prefix even with quote-filled adjacent memory', () => {
        const source = sourceWithToken('""')
        for (let length = 1; length < source.length; ++length) {
            expect(parse([source.slice(0, length)], length % 16).count).toBe(-1)
            expect(parse([source.slice(0, length)], 0, true).count).toBe(-1)
        }
    })

    test('does not combine quotes across independently bounded bank documents', () => {
        const source = sourceWithToken('""')
        expect(parse([source]).count).toBe(1)
        for (let split = 1; split < source.length; ++split) {
            expect(parse([source.slice(0, split), source.slice(split)]).count).toBe(-1)
        }
    })

    test.each(['"""', '""x', '""0', '""null', '""[]', '""{}', '""\\', '""\u0000'])('rejects empty token with invalid suffix %j', (token) => {
        expect(parse([sourceWithToken(token)]).count).toBe(-1)
    })

    test('preserves escaped and nonempty strings rather than treating them as empty', () => {
        for (const token of ['""', '"\\""', '"\\\\"', '"\\u0000"', '"\\u0022"', '"\\u65e5"', '" "', '"🙂"']) {
            const result = parse([sourceWithToken(token)], 7, true)
            expect(result.count).toBe(1)
            expect(fieldValue(result, 0)).toEqual(JSON.parse(token))
            expect(result.metadata[1]).toBe(encoder.encode(token).length)
        }
    })

    test('preserves empty strings in nested glossary keys and values', () => {
        const glossary = ['', {type: 'text', text: ''}, {type: 'structured-content', content: {tag: 'span', content: ['', {tag: 'span', content: ''}], data: {'': ''}}}]
        const source = JSON.stringify([['', '', '', '', 0, glossary, 1, '']])
        const result = parse([source], 3)
        expect(result.count).toBe(1)
        expect(fieldValue(result, 9)).toEqual(glossary)
    })

    test('accepts empty and whitespace-only banks without creating empty rows', () => {
        for (const banks of [['[]'], [' [ ] '], ['[]', '[ ]'], ['[]', sourceWithToken('""')]]) {
            expect(parse(banks).count).toBe(banks.some((bank) => bank.includes('"')) ? 1 : 0)
        }
    })
})
