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

/** @typedef {{memory: WebAssembly.Memory, wasm_alloc: (length: number) => number, wasm_reset_heap: () => void, parse_term_bank: (input: number, length: number, output: number, capacity: number, spans?: number, spanCount?: number, validateGlossaryTypes?: number) => number, parse_term_bank_with_media_hints: (input: number, length: number, output: number, capacity: number, spans?: number, spanCount?: number, validateGlossaryTypes?: number) => number}} ParserExports */
/** @type {ParserExports} */
let parser
const encoder = new TextEncoder()

beforeAll(async () => {
    const bytes = await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))
    const {instance} = await WebAssembly.instantiate(bytes)
    parser = /** @type {ParserExports} */ (/** @type {unknown} */ (instance.exports))
})

/**
 * @param {string} glossary
 * @param {boolean} [hints]
 * @param {boolean} [validateGlossaryTypes]
 * @returns {{count: number, metadata: number[]}}
 */
function parseGlossary(glossary, hints = true, validateGlossaryTypes = false) {
    const bytes = encoder.encode(`[["entry","","","",0,${glossary},1,""]]`)
    parser.wasm_reset_heap()
    const input = parser.wasm_alloc(bytes.length)
    const output = parser.wasm_alloc(17 * 4)
    new Uint8Array(parser.memory.buffer, input, bytes.length).set(bytes)
    const count = (hints ? parser.parse_term_bank_with_media_hints : parser.parse_term_bank)(input, bytes.length, output, 1, 0, 0, validateGlossaryTypes ? 1 : 0)
    return {count, metadata: [...new Uint32Array(parser.memory.buffer, output, 17)]}
}

describe('adjacent common-key colons', () => {
    test.each(['content', 'tag'])('accepts every JSON value after %s', (key) => {
        for (const value of ['null', 'true', 'false', '0', '-1.25e2', '""', '"text"', '[]', '{}', '["a",{}]', '{"type":"text","text":"value"}']) {
            const glossary = '[{"' + key + '":' + value + ',"after":["next"]}]'
            expect(parseGlossary(glossary).count).toBe(1)
            expect(parseGlossary(glossary, false).count).toBe(1)
        }
    })

    test.each(['content', 'tag'])('preserves whitespace and escaped %s fallbacks', (key) => {
        for (const ws of [' ', '\t', '\n', '\r']) {
            const glossary = '[{"' + key + '"' + ws + ':' + ws + '"image"}]'
            const result = parseGlossary(glossary)
            expect(result.count).toBe(1)
            expect(result.metadata.slice(14)).toEqual([1, 1, 0])
        }
        const escapedKey = key === 'content' ? 'cont\\u0065nt' : 't\\u0061g'
        const result = parseGlossary('[{"' + escapedKey + '":"image"}]')
        expect(result.count).toBe(1)
        expect(result.metadata.slice(14)).toEqual([1, 0, 0])
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

    test.each(['a', 'div', 'li', 'rt', 'ruby', 'span', 'ul'])('preserves parent frames and media after a final %s tag', (tag) => {
        for (const space of ['', ' ', '\t', '\n']) {
            const glossary = `[{"type":"structured-content","content":[{"content":{"tag":${space}"${tag}"},"tag":${space}"${tag}"},{"tag":"img","path":"image.png"}],"tag":${space}"${tag}"}]`
            const result = parseGlossary(glossary, true, true)
            expect(result.count).toBe(1)
            expect(result.metadata.slice(14)).toEqual([1, space.length === 0 ? 0 : 1, 0])
            expect(parseGlossary(glossary, false, true).count).toBe(1)
        }
    })

    test.each(['a', 'div', 'li', 'rt', 'ruby', 'span', 'ul'])('validates required fields before closing a final %s tag', (tag) => {
        for (const fields of [
            '"type":"text","text":"value"',
            '"type":"image","path":"image.png"',
            '"type":"structured-content","content":[]',
        ]) {
            expect(parseGlossary(`[{${fields},"tag":"${tag}"}]`, true, true).count).toBe(1)
        }
        for (const fields of [
            '"type":"text"',
            '"type":"text","text":"value","text":null',
            '"type":"image","path":true',
            '"type":"structured-content","content":null',
            '"type":"unsupported","content":[]',
        ]) {
            const glossary = `[{${fields},"tag":"${tag}"}]`
            expect(parseGlossary(glossary, true, true).count).toBeLessThan(0)
            expect(parseGlossary(glossary, false, true).count).toBeLessThan(0)
        }
    })

    test.each(['a', 'div', 'li', 'rt', 'ruby', 'span', 'ul'])('does not admit malformed final %s tag delimiters', (tag) => {
        for (const glossary of [
            `[{"tag":"${tag}" "content":0}]`,
            `[{"tag":"${tag}",}]`,
            `[{"tag":"${tag}"]}]`,
            `[{"tag":"${tag}"x}]`,
        ]) {
            expect(parseGlossary(glossary).count).toBeLessThan(0)
            expect(parseGlossary(glossary, false).count).toBeLessThan(0)
        }
    })

    test.each(['a', 'div', 'li', 'rt', 'ruby', 'span', 'ul'])('bounds the final %s tag to the logical bank end', (tag) => {
        const bank = `[["word","","","",0,[{"content":{"tag":"${tag}"},"type":"structured-content"}],1,""]]`
        const bytes = encoder.encode(bank)
        const valueStart = bank.indexOf(`"${tag}"`)
        for (let length = valueStart; length <= valueStart + tag.length + 3; ++length) {
            parser.wasm_reset_heap()
            const input = parser.wasm_alloc(bytes.length)
            const output = parser.wasm_alloc(17 * 4)
            new Uint8Array(parser.memory.buffer, input, bytes.length).set(bytes)
            expect(parser.parse_term_bank_with_media_hints(input, length, output, 1, 0, 0, 1)).toBeLessThan(0)
            expect(parser.parse_term_bank(input, length, output, 1, 0, 0, 1)).toBeLessThan(0)
        }
    })

    test('keeps nested media and text normalization hints', () => {
        const result = parseGlossary('[{"content":[{"tag":"img"},{"content":{"type":"text","text":"value"}}]}]')
        expect(result.count).toBe(1)
        expect(result.metadata.slice(14)).toEqual([1, 1, 1])
    })

    test.each(['content', 'tag'])('bounds %s and its colon to the logical bank end', (key) => {
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
            expect(parser.parse_term_bank_with_media_hints(input, length, output, 1)).toBeLessThan(0)
            expect(parser.parse_term_bank(input, length, output, 1)).toBeLessThan(0)
        }
    })
})
