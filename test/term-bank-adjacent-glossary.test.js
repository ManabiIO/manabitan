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

/** @typedef {{memory: WebAssembly.Memory, wasm_reset_heap: () => void, wasm_alloc: (size: number) => number, parse_term_bank: (...args: number[]) => number, parse_term_bank_with_media_hints: (...args: number[]) => number}} ParserExports */
/** @type {ParserExports} */
let wasm
const encoder = new TextEncoder()
const decoder = new TextDecoder()

beforeAll(async () => {
    const module = await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url)))
    wasm = /** @type {ParserExports} */ (/** @type {unknown} */ ((await WebAssembly.instantiate(module)).exports))
})

/**
 * @param {string} source
 * @param {boolean} [media=true]
 */
function parse(source, media = true) {
    const bytes = encoder.encode(source)
    wasm.wasm_reset_heap()
    const input = wasm.wasm_alloc(bytes.length)
    const adjacent = wasm.wasm_alloc(64)
    const output = wasm.wasm_alloc(4 * 68)
    const heap = new Uint8Array(wasm.memory.buffer)
    heap.fill(0x22, input, adjacent + 64)
    heap.set(bytes, input)
    const count = (media ? wasm.parse_term_bank_with_media_hints : wasm.parse_term_bank)(input, bytes.length, output, 4)
    const rows = []
    for (let i = 0; i < Math.max(0, count); ++i) {
        rows.push([...new Uint32Array(wasm.memory.buffer, output + i * 68, 17)])
    }
    return {count, rows, bytes}
}

/**
 * @param {string} first
 * @param {string} second
 */
function sourcePair(first, second) {
    return `[["first","first","tag","",1,${first},10,""],["second","second","other","v1",2,${second},20,"x"]]`
}

/**
 * @param {ReturnType<typeof parse>} result
 * @param {number} row
 */
function glossary(result, row) {
    const meta = result.rows[row]
    return decoder.decode(result.bytes.subarray(meta[9], meta[9] + meta[10]))
}

describe('reuse of an exactly matching adjacent glossary', () => {
    test.each([0, 1, 7, 8, 9, 15, 16, 17, 63, 64, 255, 256])('preserves actual source spans around length %i', (length) => {
        const token = JSON.stringify(['日'.repeat(length), '\\"', '🙂'])
        const result = parse(sourcePair(token, token))
        expect(result.count).toBe(2)
        expect(glossary(result, 0)).toBe(token)
        expect(glossary(result, 1)).toBe(token)
        expect(result.rows[1][9]).toBeGreaterThan(result.rows[0][9])
        expect(result.rows[1][8]).toBe(2)
        expect(result.rows[1][11]).toBe(20)
    })

    test.each([false, true])('preserves media and normalization hints with media=%s', (media) => {
        const token = '[ {"type":"text", "text":"literal"}, {"type":"image", "path":"x.png"} ]'
        const result = parse(sourcePair(token, token), media)
        expect(result.count).toBe(2)
        expect(result.rows[0].slice(14)).toEqual([media ? 1 : 0, 1, 1])
        expect(result.rows[1].slice(14)).toEqual(result.rows[0].slice(14))
    })

    test('does not treat matching tails or equal lengths as proof of equality', () => {
        const first = '[{"type":"text","text":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]'
        const second = '[{"type":"note","text":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]'
        expect(first.length).toBe(second.length)
        expect(first.slice(-8)).toBe(second.slice(-8))
        const result = parse(sourcePair(first, second))
        expect(result.count).toBe(2)
        expect(glossary(result, 1)).toBe(second)
        expect(result.rows[0][16]).toBe(1)
        expect(result.rows[1][16]).toBe(0)
    })

    test.each(['\u0000', '\n', '\t'])('still rejects a control byte inside a nearly identical glossary: %j', (control) => {
        const first = JSON.stringify(['prefix-'.repeat(20) + 'tail'.repeat(20)])
        const second = first.slice(0, 25) + control + first.slice(26)
        expect(second.length).toBe(first.length)
        expect(second.slice(-8)).toBe(first.slice(-8))
        expect(parse(sourcePair(first, second)).count).toBeLessThan(0)
    })

    test('validates delimiters after an identical glossary prefix', () => {
        for (const token of ['[]', '["x"]', '[{"nested":[1,2,3]}]']) {
            for (const suffix of ['x', '[1]', ':', ',']) {
                expect(parse(sourcePair(token, token + suffix)).count).toBeLessThan(0)
            }
        }
    })

    test('rejects every truncation of the second repeated glossary without reading adjacent memory', () => {
        const token = JSON.stringify([{type: 'text', text: 'long 日本語 '.repeat(8)}, {type: 'image', path: 'image.png'}])
        const source = sourcePair(token, token)
        const start = source.lastIndexOf(token)
        for (let length = 0; length < token.length; ++length) {
            expect(parse(source.slice(0, start + length)).count).toBeLessThan(0)
        }
    })

    test('does not retain a prior invocation as validation authority', () => {
        const token = JSON.stringify(['x'.repeat(80)])
        expect(parse(sourcePair(token, token)).count).toBe(2)
        const invalid = token.slice(0, 40) + '\u0000' + token.slice(41)
        expect(parse(sourcePair(invalid, invalid)).count).toBeLessThan(0)
    })
})
