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

/** @typedef {{memory: WebAssembly.Memory, wasm_alloc: (length: number) => number, wasm_reset_heap: () => void, parse_term_bank: (input: number, length: number, output: number, capacity: number) => number, parse_term_bank_with_media_hints: (input: number, length: number, output: number, capacity: number) => number}} ParserExports */
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
 * @returns {{count: number, metadata: number[]}}
 */
function parseGlossary(glossary, hints = true) {
    const bytes = encoder.encode(`[["entry","","","",0,${glossary},1,""]]`)
    parser.wasm_reset_heap()
    const input = parser.wasm_alloc(bytes.length)
    const output = parser.wasm_alloc(17 * 4)
    new Uint8Array(parser.memory.buffer, input, bytes.length).set(bytes)
    const count = (hints ? parser.parse_term_bank_with_media_hints : parser.parse_term_bank)(input, bytes.length, output, 1)
    return {count, metadata: Array.from(new Uint32Array(parser.memory.buffer, output, 17))}
}

/** @param {number} depth */
function nested(depth) {
    let value = '0'
    for (let i = 0; i < depth; ++i) { value = i % 2 === 0 ? `[${value}]` : `{"k":${value}}` }
    return value
}

describe('composite parser state transitions', () => {
    test.each([
        '[]', '{}', '[[]]', '[{}]', '{"k":[]}', '{"k":{}}',
        '[0,true,false,null,"",[],{}]',
        '{"a":0,"b":true,"c":null,"d":"","e":[],"f":{}}',
        '[{"a":[[],{},[1,2]],"b":{"c":false}},3,"last"]',
        '["commas, colons: and brackets [{]} inside strings","\\\"\\\\\\n\\u1234"]',
        '[ -1, 1.25, 1e+3, -0.25e-2 ]',
        nested(1), nested(2), nested(255), nested(256),
    ])('accepts complete container states: %s', (glossary) => {
        expect(parseGlossary(glossary).count).toBe(1)
        expect(parseGlossary(glossary, false).count).toBe(1)
    })

    test.each([
        '[}', '{]', '[,]', '{,}', '[1,]', '{"k":0,}',
        '[1 2]', '["a" "b"]', '[[]{}]', '[1:2]',
        '{"k"}', '{"k",0}', '{"k":}', '{"k"::0}',
        '{0:1}', '{true:1}', '{[]:1}', '{"a":1 "b":2}',
        '{"a":{}[]}', '{"a":[],false}', '{"a":0,:1}',
        '[[}]', '{"a":[}}', '[{"a":[]]}', '[{"a":0,}]',
        '[truefalse]', '[+1]', '[01]', '[1.]', '[1e]',
        '["\\q"]', '["\\u12zz"]', '["raw\ncontrol"]',
        nested(257), nested(258),
    ])('rejects malformed transitions or excessive depth: %s', (glossary) => {
        expect(parseGlossary(glossary).count).toBeLessThan(0)
        expect(parseGlossary(glossary, false).count).toBeLessThan(0)
    })

    test('preserves media and normalization hints across parent restoration', () => {
        const cases = [
            {json: '[{"a":[{"tag":"img"}],"b":0}]', flags: [1, 0, 0]},
            {json: '[{"a":[{"type":"text","text":"value"}],"b":0}]', flags: [0, 1, 1]},
            {json: '[ {"a": [1, {}], "b": "image"} ]', flags: [1, 1, 0]},
            {json: '[{"a":[1,{}],"b":"value"}]', flags: [0, 0, 0]},
        ]
        for (const {json, flags} of cases) {
            const result = parseGlossary(json)
            expect(result.count).toBe(1)
            expect(result.metadata.slice(14)).toEqual(flags)
        }
    })

    test('matches JSON validity for deterministic mutations of nested values', () => {
        let seed = 0x315ca7e1
        const random = () => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
            return seed
        }
        const tokens = ['[', ']', '{', '}', ':', ',', '"', ' ', '0', 't', '\\']
        for (let i = 0; i < 600; ++i) {
            const valid = JSON.stringify([{key: [i, `text ${random()}`, null, {tag: 'span', content: ['x', {}]}]}, false])
            const offset = random() % valid.length
            const token = tokens[random() % tokens.length]
            const mutations = [valid, valid.slice(0, offset), valid.slice(0, offset) + token + valid.slice(offset + 1)]
            for (const glossary of mutations) {
                let accepted = true
                try { JSON.parse(glossary) } catch { accepted = false }
                expect(parseGlossary(glossary).count > 0).toBe(accepted)
            }
        }
    })
})
