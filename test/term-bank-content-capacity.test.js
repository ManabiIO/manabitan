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
import {hashTermEntryContentBytesPair} from '../ext/js/dictionary/term-entry-content-hash.js'

/** @typedef {{memory: WebAssembly.Memory, wasm_reset_heap: () => void, wasm_alloc: (size: number) => number, wasm_get_last_content_capacity: () => number, parse_term_bank_with_media_hints: (...args: number[]) => number, encode_term_content_token_binary: (...args: number[]) => number}} ParserExports */
/** @type {ParserExports} */
let wasm
const encoder = new TextEncoder()

beforeAll(async () => {
    const module = await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url)))
    wasm = /** @type {ParserExports} */ (/** @type {unknown} */ ((await WebAssembly.instantiate(module)).exports))
})

/**
 * A following allocation disables growth and detects writes past capacity.
 * @param {string} source
 * @param {number} capacity
 * @param {boolean} [grow=false]
 * @param {Array<[number, number]>} [metadataPatches=[]]
 * @returns {{length: number, bytes: Uint8Array, metadata: number[], canary: number[], capacity: number}}
 */
function encode(source, capacity, grow = false, metadataPatches = []) {
    const input = encoder.encode(source)
    const rows = /** @type {unknown[]} */ (JSON.parse(source)).length
    wasm.wasm_reset_heap()
    const sourcePtr = wasm.wasm_alloc(input.length)
    const metadataPtr = wasm.wasm_alloc(rows * 68)
    const outputMetadataPtr = wasm.wasm_alloc(rows * 16)
    const outputPtr = wasm.wasm_alloc(capacity)
    const canaryPtr = grow ? 0 : wasm.wasm_alloc(32)
    let heap = new Uint8Array(wasm.memory.buffer)
    heap.set(input, sourcePtr)
    new Uint32Array(wasm.memory.buffer, outputMetadataPtr, rows * 4).fill(0x12345678)
    if (!grow) { heap.fill(0xa5, outputPtr, canaryPtr + 32) }
    expect(wasm.parse_term_bank_with_media_hints(sourcePtr, input.length, metadataPtr, rows)).toBe(rows)
    const sourceMetadata = new Uint32Array(wasm.memory.buffer, metadataPtr, rows * 17)
    for (const [index, value] of metadataPatches) { sourceMetadata[index] = value }
    const length = wasm.encode_term_content_token_binary(sourcePtr, metadataPtr, rows, outputPtr, capacity, outputMetadataPtr)
    heap = new Uint8Array(wasm.memory.buffer)
    return {
        length,
        bytes: heap.slice(outputPtr, outputPtr + Math.max(0, length)),
        metadata: [...new Uint32Array(wasm.memory.buffer, outputMetadataPtr, rows * 4)],
        canary: grow ? [] : [...heap.subarray(outputPtr + capacity, canaryPtr + 32)],
        capacity: wasm.wasm_get_last_content_capacity(),
    }
}

/**
 * @param {string} rules
 * @param {string} definitionTags
 * @param {string} termTags
 * @param {string} glossary
 * @returns {Uint8Array}
 */
function contentBytes(rules, definitionTags, termTags, glossary) {
    return encoder.encode(`MBR6${rules}\0${definitionTags}\0${termTags}\0${glossary}`)
}

const cases = [
    {name: 'empty fields', source: '["term","","","",0,[],1,""]', bytes: contentBytes('""', '""', '""', '[]')},
    {name: 'null definition tags', source: '["term","",null,"",0,["definition"],1,""]', bytes: contentBytes('""', '""', '""', '["definition"]')},
    {name: 'escaped tags and Unicode', source: '["term","","noun\\t","v5\\n",0,["日本語🙂", "escaped\\\\text"],1,"common"]', bytes: contentBytes('"v5\\n"', '"noun\\t"', '"common"', '["日本語🙂", "escaped\\\\text"]')},
    {name: 'structured content', source: '["term","","noun","",0,[{"type":"structured-content","content":{"tag":"span","content":"definition"}}],1,""]', bytes: contentBytes('""', '"noun"', '""', '[{"type":"structured-content","content":{"tag":"span","content":"definition"}}]')},
    {name: 'normalized text object fallback', source: '["term","","noun","",0,[{"type":"text","text":"definition"}],1,""]', bytes: contentBytes('""', '"noun"', '""', '["definition"]')},
]

describe('native token-content capacity', () => {
    test.each(cases)('keeps exact output and bounds for $name', ({source, bytes}) => {
        for (let capacity = 0; capacity <= bytes.length + 1; ++capacity) {
            const result = encode(`[${source}]`, capacity)
            expect(result.canary.every((value) => value === 0xa5)).toBe(true)
            if (capacity < bytes.length) {
                expect(result.length).toBe(-2)
                expect(result.metadata).toEqual([0x12345678, 0x12345678, 0x12345678, 0x12345678])
            } else {
                expect(result.length).toBe(bytes.length)
                expect(result.bytes).toEqual(bytes)
                expect(result.metadata).toEqual([0, bytes.length, ...hashTermEntryContentBytesPair(bytes)])
            }
        }
    })

    test('preserves complete earlier rows when a later row cannot fit', () => {
        const first = cases[0]
        const second = cases[3]
        const result = encode(`[${first.source},${second.source}]`, first.bytes.length + second.bytes.length - 1)
        expect(result.length).toBe(-2)
        expect(result.metadata.slice(0, 4)).toEqual([0, first.bytes.length, ...hashTermEntryContentBytesPair(first.bytes)])
        expect(result.metadata.slice(4)).toEqual([0x12345678, 0x12345678, 0x12345678, 0x12345678])
        expect(result.canary.every((value) => value === 0xa5)).toBe(true)
    })

    test('rejects a token-length sum above uint32 without crossing capacity', () => {
        const result = encode(`[${cases[0].source}]`, 64, false, [[7, 0xffffffff], [5, 0xfffffffe], [13, 0xfffffffd]])
        expect(result.length).toBe(-2)
        expect(result.metadata).toEqual([0x12345678, 0x12345678, 0x12345678, 0x12345678])
        expect(result.canary.every((value) => value === 0xa5)).toBe(true)
    })

    test.each([0, 1])('keeps the omitted-glossary fallback with normalization flag %i', (flag) => {
        const expected = cases[0].bytes
        const result = encode(`[${cases[0].source}]`, expected.length, false, [[10, 0], [16, flag]])
        expect(result.length).toBe(expected.length)
        expect(result.bytes).toEqual(expected)
        expect(result.metadata).toEqual([0, expected.length, ...hashTermEntryContentBytesPair(expected)])
        expect(result.canary.every((value) => value === 0xa5)).toBe(true)
    })

    test('retries after growing the final output allocation', () => {
        const values = cases
        const expected = new Uint8Array(values.reduce((total, value) => total + value.bytes.length, 0))
        let offset = 0
        for (const {bytes} of values) {
            expected.set(bytes, offset)
            offset += bytes.length
        }
        const result = encode(`[${values.map(({source}) => source).join(',')}]`, 1, true)
        expect(result.length).toBe(expected.length)
        expect(result.bytes).toEqual(expected)
        expect(result.capacity).toBeGreaterThanOrEqual(expected.length)
    })
})
