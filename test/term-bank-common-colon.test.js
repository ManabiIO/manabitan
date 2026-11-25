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
import {beforeAll, describe, expect, test} from 'vitest'

/** @typedef {{memory: WebAssembly.Memory, wasm_alloc: (length: number) => number, wasm_reset_heap: () => void, parse_term_bank: (input: number, length: number, output: number, capacity: number, spans: number, spanCount: number, validateTypes: number) => number, parse_term_bank_with_media_hints: (input: number, length: number, output: number, capacity: number, spans: number, spanCount: number, validateTypes: number) => number}} ParserExports */
/** @type {ParserExports} */
let parser
const encoder = new TextEncoder()
const commonKeys = ['content', 'tag', 'data', 'class', 'title', 'href', 'code', 'lang', 'style']

beforeAll(async () => {
    const bytes = await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))
    const {instance} = await WebAssembly.instantiate(bytes)
    parser = /** @type {ParserExports} */ (/** @type {unknown} */ (instance.exports))
})

/**
 * @param {string} glossary
 * @param {boolean} [hints]
 * @param {boolean} [validateTypes]
 * @returns {{count: number, metadata: number[]}}
 */
function parseGlossary(glossary, hints = true, validateTypes = false) {
    const bytes = encoder.encode(`[["entry","","","",0,${glossary},1,""]]`)
    parser.wasm_reset_heap()
    const input = parser.wasm_alloc(bytes.length)
    const output = parser.wasm_alloc(17 * 4)
    new Uint8Array(parser.memory.buffer, input, bytes.length).set(bytes)
    const count = (hints ? parser.parse_term_bank_with_media_hints : parser.parse_term_bank)(input, bytes.length, output, 1, 0, 0, validateTypes ? 1 : 0)
    return {count, metadata: [...new Uint32Array(parser.memory.buffer, output, 17)]}
}

describe('adjacent common-key colons', () => {
    test.each(commonKeys)('accepts every JSON value after %s', (key) => {
        for (const value of ['null', 'true', 'false', '0', '-1.25e2', '""', '"text"', '[]', '{}', '["a",{}]', '{"type":"text","text":"value"}']) {
            const glossary = '[{"' + key + '":' + value + ',"after":["next"]}]'
            expect(parseGlossary(glossary).count).toBe(1)
            expect(parseGlossary(glossary, false).count).toBe(1)
        }
    })

    test.each(commonKeys)('preserves whitespace and escaped %s fallbacks', (key) => {
        for (const ws of [' ', '\t', '\n', '\r']) {
            const glossary = '[{"' + key + '"' + ws + ':' + ws + '"image"}]'
            const result = parseGlossary(glossary)
            expect(result.count).toBe(1)
            expect(result.metadata.slice(14)).toEqual([1, 1, 0])
        }
        for (const index of [0, key.length - 1]) {
            const escapedKey = `${key.slice(0, index)}\\u${key.charCodeAt(index).toString(16).padStart(4, '0')}${key.slice(index + 1)}`
            const result = parseGlossary('[{"' + escapedKey + '":"image"}]')
            expect(result.count).toBe(1)
            expect(result.metadata.slice(14)).toEqual([1, 0, 0])
        }
    })

    test.each([
        '[{"content"::0}]',
        '[{"tag":0:1}]',
        '[{"content":,}]',
        '[{"tag":]}]',
        '[{"content":"" "after":0}]',
        '[{"tag":truefalse}]',
        '[{"content"x:0}]',
        '[{"content":',
        '[{"tag":',
    ])('rejects an invalid value or separator: %s', (glossary) => {
        expect(parseGlossary(glossary).count).toBeLessThan(0)
        expect(parseGlossary(glossary, false).count).toBeLessThan(0)
    })

    test.each(['a', 'div', 'li', 'rt', 'ruby', 'span', 'ul'])('preserves the next field after a literal %s tag', (tag) => {
        for (const space of ['', ' ', '\t']) {
            const glossary = `[{"tag":${space}"${tag}",${space}"content":{"tag":"img"}}]`
            const result = parseGlossary(glossary)
            expect(result.count).toBe(1)
            expect(result.metadata.slice(14)).toEqual([1, space.length === 0 ? 0 : 1, 0])
        }
        expect(parseGlossary(`[{"tag":"${tag}",}]`).count).toBeLessThan(0)
    })

    test('keeps nested media and text normalization hints', () => {
        const result = parseGlossary('[{"content":[{"tag":"img"},{"content":{"type":"text","text":"value"}}]}]')
        expect(result.count).toBe(1)
        expect(result.metadata.slice(14)).toEqual([1, 1, 1])
    })

    test.each(commonKeys)('bounds %s and its colon to the logical bank end', (key) => {
        const bank = '[["word","","","",0,[{"' + key + '":"image"}],1,""]]'
        const bytes = encoder.encode(bank)
        const keyStart = bank.indexOf('"' + key + '"')
        for (let length = keyStart; length <= keyStart + key.length + 3; ++length) {
            parser.wasm_reset_heap()
            const input = parser.wasm_alloc(bytes.length)
            const output = parser.wasm_alloc(17 * 4)
            new Uint8Array(parser.memory.buffer, input, bytes.length).set(bytes)
            // The remaining valid source bytes are physically accessible but
            // cannot complete a token or colon outside this logical bank.
            expect(parser.parse_term_bank_with_media_hints(input, length, output, 1, 0, 0, 0)).toBeLessThan(0)
            expect(parser.parse_term_bank(input, length, output, 1, 0, 0, 0)).toBeLessThan(0)
        }
    })

    test.each(commonKeys)('requires the complete %s literal and a valid separator', (key) => {
        for (const invalid of [
            `[{"${key}"x:0}]`,
            `[{"${key}:0}]`,
            `[{"${key}\\":0}]`,
            `[{"${key}"::0}]`,
            `[{"${key}":,}]`,
            `[{"${key}":0 "next":0}]`,
            `[{"${key}":0,}]`,
        ]) {
            expect(parseGlossary(invalid).count).toBeLessThan(0)
            expect(parseGlossary(invalid, false).count).toBeLessThan(0)
        }
        for (const nearMatch of [key.slice(0, -1), `${key}x`, `${key}\\u0061`, `${key.slice(0, -1)}x`]) {
            const result = parseGlossary(`[{"${nearMatch}":"image"}]`)
            expect(result.count).toBe(1)
            expect(result.metadata.slice(14)).toEqual([1, 0, 0])
        }
    })

    test.each(['data', 'class', 'title', 'href', 'code', 'lang', 'style'])('keeps %s distinct from required glossary fields', (key) => {
        for (const value of ['null', '0', 'true', '"text"', '[]', '{"tag":"img"}']) {
            for (const hints of [false, true]) {
                expect(parseGlossary(`[{"type":"image","path":"image.png","${key}":${value}}]`, hints, true).count).toBe(1)
                expect(parseGlossary(`[{"type":"image","${key}":${value}}]`, hints, true).count).toBeLessThan(0)
                expect(parseGlossary(`[{"type":"text","${key}":${value}}]`, hints, true).count).toBeLessThan(0)
                expect(parseGlossary(`[{"type":"structured-content","${key}":${value}}]`, hints, true).count).toBeLessThan(0)
            }
        }
        const result = parseGlossary(`[{"type":"structured-content","content":{"${key}":[{"tag":"img"},{"type":"text","text":"value"}]}}]`, true, true)
        expect(result.count).toBe(1)
        expect(result.metadata.slice(14)).toEqual([1, 1, 1])
    })
})
