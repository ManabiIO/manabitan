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
import {crc32, deflateRawSync} from 'node:zlib'
import {beforeAll, describe, expect, test} from 'vitest'

/** @typedef {{memory: WebAssembly.Memory, wasm_reset_heap: () => void, wasm_alloc: (size: number) => number, parse_term_bank_with_media_hints: (...args: number[]) => number, inflate_and_join_term_banks: (...args: number[]) => number}} ParserExports */
/** @type {ParserExports} */
let wasm
const encoder = new TextEncoder()
const decoder = new TextDecoder()

beforeAll(async () => {
    const module = await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url)))
    const instance = await WebAssembly.instantiate(module)
    wasm = /** @type {ParserExports} */ (/** @type {unknown} */ (instance.exports))
})

/**
 * The adjacent allocation deliberately contains quotes/brackets. A truncated
 * input must not accidentally become valid by scanning beyond its logical end.
 * @param {string} source
 * @returns {{count: number, spans: number[], bytes: Uint8Array}}
 */
function parse(source) {
    const bytes = encoder.encode(source)
    wasm.wasm_reset_heap()
    const input = wasm.wasm_alloc(bytes.length)
    const adjacent = wasm.wasm_alloc(64)
    const output = wasm.wasm_alloc(68)
    const heap = new Uint8Array(wasm.memory.buffer)
    heap.fill(0x22, input, adjacent + 64)
    heap.set(bytes, input)
    const count = wasm.parse_term_bank_with_media_hints(input, bytes.length, output, 1)
    return {count, spans: [...new Uint32Array(wasm.memory.buffer, output, 17)], bytes}
}

/**
 * @param {ReturnType<typeof parse>} result
 * @param {number} offset
 * @returns {unknown}
 */
function readSpan(result, offset) {
    const start = result.spans[offset]
    return JSON.parse(decoder.decode(result.bytes.subarray(start, start + result.spans[offset + 1])))
}

const alignments = Array.from({length: 64}, (_, index) => index)

describe('term-bank string scanning', () => {
    test.each(alignments)('preserves string spans at byte alignment %i', (padding) => {
        const values = [
            '',
            'a',
            'a'.repeat(15),
            'a'.repeat(16),
            'a'.repeat(17),
            'a'.repeat(64),
            '日本語と🙂',
            '\\"/\b\f\n\r\t',
            '\u0000\u001f',
            'é\u0080\u07ff\u0800',
        ]
        for (const value of values) {
            const word = `${'x'.repeat(padding)}${value}`
            const row = [word, value, 'noun', '', -42, [value, {type: 'text', text: word}], 99, 'common']
            const result = parse(`${' '.repeat(padding)}${JSON.stringify([row])}`)
            expect(result.count).toBe(1)
            expect(readSpan(result, 0)).toBe(word)
            expect(readSpan(result, 2)).toBe(value)
            expect(readSpan(result, 9)).toEqual(row[5])
        }
    })

    test.each(alignments)('handles escaped Unicode and quotes across boundary %i', (padding) => {
        const prefix = 'x'.repeat(padding)
        const token = `"${prefix}\\u65e5\\u672c\\uD83D\\uDE42\\\\\\"end"`
        const result = parse(`[[${token},"","","",0,[${token}],1,""]]`)
        expect(result.count).toBe(1)
        expect(readSpan(result, 0)).toBe(`${prefix}日本🙂\\"end`)
        expect(readSpan(result, 9)).toEqual([`${prefix}日本🙂\\"end`])
    })

    test.each(alignments)('rejects unescaped controls at boundary %i', (padding) => {
        for (let control = 0; control < 32; ++control) {
            const source = `[["${'a'.repeat(padding)}${String.fromCharCode(control)}b","","","",0,["x"],1,""]]`
            expect(parse(source).count).toBeLessThan(0)
        }
    })

    test.each(alignments)('rejects truncated and invalid escapes at boundary %i', (padding) => {
        const prefix = `[["${'x'.repeat(padding)}`
        for (const ending of ['', '\\', '\\u', '\\u0', '\\u00', '\\u000']) {
            expect(parse(prefix + ending).count).toBeLessThan(0)
        }
        for (const escape of ['\\q', '\\u00xz', '\\u-001', '\\u 000', '\\U0001']) {
            expect(parse(`${prefix}${escape}","","","",0,[],1,""]]`).count).toBeLessThan(0)
        }
    })
})

/**
 * @param {string[]} sources
 * @param {number} method
 * @returns {string}
 */
function inflateAndJoin(sources, method) {
    const buffers = sources.map((source) => encoder.encode(source))
    const payloads = buffers.map((bytes) => (method === 8 ? deflateRawSync(bytes) : bytes))
    const inputLength = payloads.reduce((sum, bytes) => sum + bytes.length, 0)
    const capacity = buffers.reduce((sum, bytes) => sum + bytes.length, 2)
    wasm.wasm_reset_heap()
    const input = wasm.wasm_alloc(inputLength)
    const offsets = wasm.wasm_alloc(sources.length * 4)
    const compressedLengths = wasm.wasm_alloc(sources.length * 4)
    const uncompressedLengths = wasm.wasm_alloc(sources.length * 4)
    const methods = wasm.wasm_alloc(sources.length * 4)
    const checksums = wasm.wasm_alloc(sources.length * 4)
    const output = wasm.wasm_alloc(capacity)
    const heap = new Uint8Array(wasm.memory.buffer)
    const words = new Uint32Array(wasm.memory.buffer)
    let cursor = 0
    for (let i = 0; i < sources.length; ++i) {
        heap.set(payloads[i], input + cursor)
        words[offsets / 4 + i] = cursor
        words[compressedLengths / 4 + i] = payloads[i].length
        words[uncompressedLengths / 4 + i] = buffers[i].length
        words[methods / 4 + i] = method
        words[checksums / 4 + i] = crc32(buffers[i])
        cursor += payloads[i].length
    }
    const length = wasm.inflate_and_join_term_banks(
        input,
        inputLength,
        offsets,
        compressedLengths,
        uncompressedLengths,
        methods,
        checksums,
        sources.length,
        output,
        capacity,
    )
    expect(length).toBeGreaterThanOrEqual(2)
    return decoder.decode(new Uint8Array(wasm.memory.buffer, output, length))
}

describe('overlapping term-bank join', () => {
    test.each([0, 8])('preserves bytes and source order for compression method %i', (method) => {
        for (const padding of alignments) {
            const value = JSON.stringify(['x'.repeat(padding), '日本語', '\\"'])
            const whitespace = ' '.repeat(padding)
            const sources = ['[]', `${whitespace}[ ${value} ]\n`, '[ ]', `[${value}]`, '[]']
            expect(inflateAndJoin(sources, method)).toBe(`[${value},${value}]`)
        }
    })

    test.each([0, 8])('handles all-empty arrays for compression method %i', (method) => {
        expect(inflateAndJoin(['[]', ' \n[ \t ]\r', '[]'], method)).toBe('[]')
    })
})
