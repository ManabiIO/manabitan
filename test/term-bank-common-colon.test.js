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

/** @typedef {{memory: WebAssembly.Memory, wasm_alloc: (length: number) => number, wasm_reset_heap: () => void, parse_term_bank: (...args: number[]) => number, parse_term_bank_with_media_hints: (...args: number[]) => number}} ParserExports */
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
 * @param {boolean} [validateTypes]
 * @returns {{count: number, metadata: number[]}}
 */
function parseGlossary(glossary, hints = true, validateTypes = false) {
    const bytes = encoder.encode(`[["entry","","","",0,${glossary},1,""]]`)
    parser.wasm_reset_heap()
    const input = parser.wasm_alloc(bytes.length)
    const output = parser.wasm_alloc(17 * 4)
    new Uint8Array(parser.memory.buffer, input, bytes.length).set(bytes)
    const count = (hints ? parser.parse_term_bank_with_media_hints : parser.parse_term_bank)(input, bytes.length, output, 1, 0, 0, Number(validateTypes))
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

describe('complete neutral metadata objects', () => {
    const patterns = [
        {key: 'data', childKey: 'content', value: 'glossary'},
        {key: 'style', childKey: 'listStyleType', value: 'circle'},
    ]

    test.each(patterns)('preserves parent transitions and whitespace around $key', ({key, childKey, value}) => {
        for (const outer of ['', ' ', '\t', '\r\n', '  ']) {
            for (const inner of ['', ' ', '\t', '\r\n', '  ']) {
                const glossary = `[{"before":"value","${key}":${outer}{"${childKey}":${inner}"${value}"},"after":{"tag":"img"}}]`
                for (const hints of [false, true]) {
                    const result = parseGlossary(glossary, hints)
                    expect(result.count).toBe(1)
                    expect(result.metadata[10]).toBe(encoder.encode(glossary).length)
                    expect(result.metadata.slice(14)).toEqual([Number(hints), Number(outer.length + inner.length > 0), 0])
                }
            }
        }
        for (const child of [`{ "${childKey}":"${value}"}`, `{"${childKey}" :"${value}"}`, `{"${childKey}":"${value}" }`]) {
            const result = parseGlossary(`[{"${key}" :${child}}]`)
            expect(result.count).toBe(1)
            expect(result.metadata.slice(14)).toEqual([0, 1, 0])
        }
    })

    test.each(patterns)('keeps escaped, extra, duplicate, and unrelated $key values on the general path', ({key, childKey, value}) => {
        const escapedParent = `\\u${key.charCodeAt(0).toString(16).padStart(4, '0')}${key.slice(1)}`
        const escapedChild = `\\u${childKey.charCodeAt(0).toString(16).padStart(4, '0')}${childKey.slice(1)}`
        const escapedValue = `\\u${value.charCodeAt(0).toString(16).padStart(4, '0')}${value.slice(1)}`
        const cases = [
            [`[{"${escapedParent}":{"${childKey}":"${value}"}}]`, [0, 0, 0]],
            [`[{"${key}":{"${escapedChild}":"${value}"}}]`, [0, 0, 0]],
            [`[{"${key}":{"${childKey}":"${escapedValue}"}}]`, [0, 0, 0]],
            [`[{"${key}":{"${childKey}":"${value}x"}}]`, [0, 0, 0]],
            [`[{"${key}":{"${childKey}":"image"}}]`, [1, 0, 0]],
            [`[{"${key}":{"${childKey}":"${value}","extra":"image"}}]`, [1, 0, 0]],
            [`[{"${key}":{"${childKey}":"${value}","${childKey}":"image"}}]`, [1, 0, 0]],
            [`[{"${key}":{"type":"text","text":"value"}}]`, [0, 1, 1]],
            [`[{"${key}":{"${childKey}":"${value}","type":"text","text":"value"}}]`, [0, 1, 1]],
            [`[{"${key}":{"img":"${value}"}}]`, [1, 0, 0]],
            [`[{"${key}":["image"]}]`, [1, 0, 0]],
            [`[{"${key}":null}]`, [0, 0, 0]],
        ]
        for (const [glossary, flags] of /** @type {Array<[string, number[]]>} */ (cases)) {
            const result = parseGlossary(glossary)
            expect(result.count).toBe(1)
            expect(result.metadata.slice(14)).toEqual(flags)
        }
        for (const ending of [',}', ',"extra":}', ',"extra":01}', 'x}', ':0}', '}}']) {
            expect(parseGlossary(`[{"${key}":{"${childKey}":"${value}"${ending}}]`).count).toBeLessThan(0)
        }
        for (const separator of [';', ',', '!', ']']) {
            expect(parseGlossary(`[{"${key}":{"${childKey}"${separator}"${value}"}}]`).count).toBeLessThan(0)
        }
    })

    test.each(patterns)('retains required-field and duplicate-type state around $key', ({key, childKey, value}) => {
        const metadata = `"${key}":{"${childKey}":"${value}"}`
        for (const [type, field] of [['text', 'text'], ['image', 'path'], ['structured-content', 'content']]) {
            for (const hints of [false, true]) {
                expect(parseGlossary(`[{"type":"${type}","${field}":"value",${metadata}}]`, hints, true).count).toBe(1)
                expect(parseGlossary(`[{${metadata},"type":"${type}","${field}":"value"}]`, hints, true).count).toBe(1)
                expect(parseGlossary(`[{"type":"${type}",${metadata}}]`, hints, true).count).toBeLessThan(0)
                expect(parseGlossary(`[{"type":"${type}","${field}":"value",${metadata},"${field}":null}]`, hints, true).count).toBeLessThan(0)
                expect(parseGlossary(`[{"type":"${type}","${field}":"value",${metadata},"type":"invalid"}]`, hints, true).count).toBeLessThan(0)
            }
        }
    })

    test.each(patterns)('enforces the same nesting limit for a recognized $key child', ({key, childKey, value}) => {
        for (const depth of [254, 255, 256, 257]) {
            for (const space of ['', ' ', '\t']) {
                const glossary = `${'['.repeat(depth - 1)}{"${key}":${space}{"${childKey}":${space}"${value}"}}${']'.repeat(depth - 1)}`
                expect(parseGlossary(glossary).count > 0).toBe(depth < 256)
                expect(parseGlossary(glossary, false).count > 0).toBe(depth < 256)
            }
        }
    })

    test.each(patterns)('bounds every $key pattern byte to logical and physical input ends', ({key, childKey, value}) => {
        for (const space of ['', ' ']) {
            const bank = `[["entry","","","",0,[{"${key}":${space}{"${childKey}":${space}"${value}"}}],1,""]]`
            const bytes = encoder.encode(bank)
            for (let length = 1; length < bytes.length; ++length) {
                parser.wasm_reset_heap()
                const output = parser.wasm_alloc(17 * 4)
                const spans = parser.wasm_alloc(16)
                const input = parser.wasm_alloc(bytes.length)
                const heap = new Uint8Array(parser.memory.buffer)
                heap.set(bytes, input)
                const physicalInput = heap.length - length
                heap.set(bytes.subarray(0, length), physicalInput)
                new Uint32Array(parser.memory.buffer, spans, 4).set([0, length, length, bytes.length - length])
                for (const parse of [parser.parse_term_bank, parser.parse_term_bank_with_media_hints]) {
                    expect(parse(input, length, output, 1)).toBeLessThan(0)
                    expect(parse(physicalInput, length, output, 1)).toBeLessThan(0)
                    expect(parse(input, bytes.length, output, 1, spans, 2)).toBeLessThan(0)
                }
            }
        }
    })
})
