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

/** @typedef {{memory: WebAssembly.Memory, wasm_alloc: (length: number) => number, wasm_reset_heap: () => void, parse_term_bank: (...args: number[]) => number, parse_term_bank_with_media_hints: (...args: number[]) => number, encode_term_content: (...args: number[]) => number}} ParserExports */
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
 * @param {boolean} [strict]
 * @returns {{count: number, metadata: number[], input: number, output: number}}
 */
function parseGlossary(glossary, hints = true, strict = false) {
    const bytes = encoder.encode(`[["entry","","","",0,${glossary},1,""]]`)
    parser.wasm_reset_heap()
    const input = parser.wasm_alloc(bytes.length)
    const output = parser.wasm_alloc(17 * 4)
    new Uint8Array(parser.memory.buffer, input, bytes.length).set(bytes)
    new Uint8Array(parser.memory.buffer, output, 17 * 4).fill(0xa5)
    const count = (hints ? parser.parse_term_bank_with_media_hints : parser.parse_term_bank)(input, bytes.length, output, 1, 0, 0, strict ? 1 : 0)
    return {count, metadata: [...new Uint32Array(parser.memory.buffer, output, 17)], input, output}
}

/**
 * @param {number} depth
 * @returns {string}
 */
function nested(depth) {
    let value = '0'
    for (let i = 0; i < depth; ++i) { value = i % 2 === 0 ? `[${value}]` : `{"k":${value}}` }
    return value
}

describe('composite parser state transitions', () => {
    test.each([
        '[]',
        '{}',
        '[[]]',
        '[{}]',
        '{"k":[]}',
        '{"k":{}}',
        '[0,true,false,null,"",[],{}]',
        '{"a":0,"b":true,"c":null,"d":"","e":[],"f":{}}',
        '[{"a":[[],{},[1,2]],"b":{"c":false}},3,"last"]',
        '["commas, colons: and brackets [{]} inside strings","\\"\\\\\\n\\u1234"]',
        '[ -1, 1.25, 1e+3, -0.25e-2 ]',
        nested(1),
        nested(2),
        nested(255),
        nested(256),
    ])('accepts complete container states: %s', (glossary) => {
        expect(parseGlossary(glossary).count).toBe(1)
        expect(parseGlossary(glossary, false).count).toBe(1)
    })

    test.each([
        '[}',
        '{]',
        '[,]',
        '{,}',
        '[1,]',
        '{"k":0,}',
        '[1 2]',
        '["a" "b"]',
        '[[]{}]',
        '[1:2]',
        '{"k"}',
        '{"k",0}',
        '{"k":}',
        '{"k"::0}',
        '{0:1}',
        '{true:1}',
        '{[]:1}',
        '{"a":1 "b":2}',
        '{"a":{}[]}',
        '{"a":[],false}',
        '{"a":0,:1}',
        '[[}]',
        '{"a":[}}',
        '[{"a":[]]}',
        '[{"a":0,}]',
        '[truefalse]',
        '[+1]',
        '[01]',
        '[1.]',
        '[1e]',
        '["\\q"]',
        '["\\u12zz"]',
        '["raw\ncontrol"]',
        nested(257),
        nested(258),
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

    test.each([
        {json: '["first","image","last"]', flags: [1, 0, 0]},
        {json: '["first", "image",\n"last"]', flags: [1, 1, 0]},
        {json: '{"a":"first","b":"image","c":"last"}', flags: [1, 0, 0]},
        {json: '{"a":"first" , "b":"image" ,\t"c":"last"}', flags: [1, 1, 0]},
        {json: '[{"type":"text","text":"first","content":["a","b"]},"last"]', flags: [0, 1, 1]},
        {json: '["comma,inside","quote\\"","image",{"image":"value","x":"last"}]', flags: [1, 0, 0]},
        {json: '["\\u0069mage","last",["a","b"],{"a":"x","b":"y"}]', flags: [1, 0, 0]},
    ])('preserves string-value comma transitions and hints: $json', ({json, flags}) => {
        const result = parseGlossary(json)
        expect(result.count).toBe(1)
        expect(result.metadata.slice(14)).toEqual(flags)
        const withoutMediaHints = parseGlossary(json, false)
        expect(withoutMediaHints.count).toBe(1)
        expect(withoutMediaHints.metadata.slice(14)).toEqual([0, ...flags.slice(1)])
    })

    test.each([
        '["image",]',
        '["image",,"last"]',
        '["image",:"last"]',
        '["image","last" "extra"]',
        '{"a":"image",}',
        '{"a":"image",,"b":"last"}',
        '{"a":"image",:"b"}',
        '{"a","image"}',
        '{"image","a":"last"}',
        '{"a":"image","b","last"}',
        '["image", {"a","last"}]',
        '["image",\n]',
    ])('rejects malformed delimiters after strings: %s', (json) => {
        expect(parseGlossary(json).count).toBeLessThan(0)
        expect(parseGlossary(json, false).count).toBeLessThan(0)
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
                try {
                    JSON.parse(glossary)
                } catch {
                    accepted = false
                }
                expect(parseGlossary(glossary).count > 0).toBe(accepted)
            }
        }
    })

    test.each([
        {json: '[]', flags: [0, 0, 0], status: [1, 1]},
        {json: '[ "plain" ]', flags: [0, 1, 0], status: [1, 1]},
        {json: '[{"t\\u0079pe":"te\\u0078t","text":"ok"}]', flags: [0, 1, 1], status: [1, 1]},
        {json: '[{"type":"image","path":"x"}]', flags: [1, 0, 0], status: [1, 1]},
        {json: '[{"type":"structured-content","content":{"tag":"i\\u006dg","path":"x"}}]', flags: [1, 0, 0], status: [1, 1]},
        {json: '[{"type":"text","text":"ok","type":"image","path":"x"}]', flags: [1, 1, 1], status: [1, 1]},
        {json: '[{"type":"text","text":"ok","text":false}]', flags: [0, 1, 1], status: [1, -1]},
        {json: '[{"type":"image","path":"x","type":"unknown"}]', flags: [1, 0, 0], status: [1, -1]},
        {json: '[ "image", ]', flags: [1, 1, 0], status: [-1, -1]},
        {json: '[{"type":"text","text":"bad\\q"}]', flags: [0, 1, 1], status: [-1, -1]},
        {json: '[{"type":"structured-content","content":[ "image", ]}]', flags: [1, 1, 0], status: [-1, -1]},
        {json: '[{"type":"text","text":"ok","content":' + nested(256) + '}]', flags: [0, 1, 1], status: [-1, -1]},
    ])('publishes completed and partial glossary hints from dirty metadata: $json', ({json, flags, status}) => {
        for (const strict of [false, true]) {
            for (const media of [false, true]) {
                const result = parseGlossary(json, media, strict)
                expect(result.count).toBe(status[Number(strict)])
                expect(result.metadata.slice(14)).toEqual([media ? flags[0] : 0, flags[1], flags[2]])
            }
        }
        // A failed or media-bearing row must not carry hints into the next
        // parse, even when the allocator reuses the same native addresses.
        expect(parseGlossary('["plain"]', true, true).metadata.slice(14)).toEqual([0, 0, 0])
    })

    test('preserves nested values when legacy encoding reparses without hint outputs', () => {
        const content = {tag: 'span', content: ['word', {tag: 'img', path: 'x'}]}
        const glossary = [{type: 'structured-content', content}, {type: 'text', text: 'plain'}]
        const parsed = parseGlossary(JSON.stringify(glossary, null, 2), true, true)
        expect(parsed.count).toBe(1)
        expect(parsed.metadata.slice(14)).toEqual([1, 1, 1])
        const output = parser.wasm_alloc(2048)
        const metadata = parser.wasm_alloc(4 * 4)
        const length = parser.encode_term_content(parsed.input, parsed.output, 1, output, 2048, metadata)
        expect(length).toBeGreaterThan(0)
        const bytes = new Uint8Array(parser.memory.buffer, output, length)
        expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({
            rules: '',
            definitionTags: '',
            termTags: '',
            glossary: [{type: 'structured-content', content}, 'plain'],
        })
    })
})
