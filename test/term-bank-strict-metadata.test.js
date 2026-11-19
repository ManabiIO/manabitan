/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {beforeAll, describe, expect, test} from 'vitest'
import {
    consumeLastTermBankWasmParseProfile,
    copyWasmBackedColumnChunk,
    parseTermBankWithWasmColumnChunks,
    setTermBankWasmModule,
} from '../ext/js/dictionary/term-bank-wasm-parser.js'

/** @typedef {{memory: WebAssembly.Memory, wasm_reset_heap: () => void, wasm_alloc: (size: number) => number, parse_term_bank: (...args: number[]) => number, parse_term_bank_with_media_hints: (...args: number[]) => number}} ParserExports */
/** @type {ParserExports} */
let parser
const encoder = new TextEncoder()

beforeAll(async () => {
    const bytes = await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))
    const module = await WebAssembly.compile(bytes)
    parser = /** @type {ParserExports} */ (/** @type {unknown} */ ((await WebAssembly.instantiate(module)).exports))
    setTermBankWasmModule(module)
})

/**
 * Keep the output at the same heap address across calls. Omitted poison leaves
 * the preceding row's metadata intact; explicit poison exercises arbitrary bytes.
 * @param {string} source
 * @param {boolean} strict
 * @param {boolean} [hints]
 * @param {number} [poison]
 * @returns {{count: number, metadata: number[]}}
 */
function parse(source, strict, hints = true, poison) {
    parser.wasm_reset_heap()
    const bytes = encoder.encode(source)
    const guard = parser.wasm_alloc(100)
    const output = guard + 16
    const input = parser.wasm_alloc(bytes.length)
    const heap = new Uint8Array(parser.memory.buffer)
    heap.fill(0xa5, guard, output)
    heap.fill(0xa5, output + 68, output + 84)
    if (typeof poison === 'number') { heap.fill(poison, output, output + 68) }
    heap.set(bytes, input)
    const count = (hints ? parser.parse_term_bank_with_media_hints : parser.parse_term_bank)(input, bytes.length, output, 1, 0, 0, strict ? 1 : 0)
    expect([...heap.subarray(guard, output)]).toEqual(new Array(16).fill(0xa5))
    expect([...heap.subarray(output + 68, output + 84)]).toEqual(new Array(16).fill(0xa5))
    return {count, metadata: [...new Uint32Array(parser.memory.buffer, output, 17)]}
}

/**
 * @param {unknown[]} row
 * @returns {string}
 */
function bank(row) { return JSON.stringify([row]) }

/** @type {unknown[][]} */
const rows = [
    ['term', 'reading', 'noun', '', -20, ['definition'], 100, 'common'],
    ['image', '', null, '', 0, [{type: 'image', path: 'image.png'}], null, ''],
    ['text', '', '', '', 1, [{type: 'text', text: 'normalized'}], 1, ''],
    ['structured', 'structured', '', '', -2, [{type: 'structured-content', content: {tag: 'span', content: 'content'}}], 2, ''],
    ['', '', '', '', 0, [], null, ''],
]

describe('strict source row metadata initialization', () => {
    test.each([true, false])('matches every initialized metadata field with hints=%s', (hints) => {
        for (const row of rows) {
            const source = bank(row)
            const expected = parse(source, false, hints, 0xcc)
            expect(expected.count).toBe(1)
            expect(parse(source, true, hints, 0xdd)).toEqual(expected)
        }
    })

    test('resets hints, null sequences and tags after reusing occupied metadata', () => {
        for (let round = 0; round < 3; ++round) {
            expect(parse(bank(rows[1]), true).metadata.slice(14)).toEqual([1, 0, 0])
            expect(parse(bank(rows[2]), true).metadata.slice(14)).toEqual([0, 1, 1])
            const result = parse(bank(rows[4]), true)
            expect(result.count).toBe(1)
            expect(result.metadata.slice(14)).toEqual([0, 0, 0])
            expect(result.metadata[11]).toBe(0xffffffff)
            expect(result.metadata[5]).toBe(2)
            expect(result.metadata[13]).toBe(2)
        }
    })

    test('retains defaults for permissive legacy rows after strict parsing', () => {
        parse(bank(rows[1]), true, true, 0xcc)
        const minimal = parse(bank(['legacy']), false)
        expect(minimal.count).toBe(1)
        expect(minimal.metadata.slice(2, 11)).toEqual(new Array(9).fill(0))
        expect(minimal.metadata[11]).toBe(0xffffffff)
        expect(minimal.metadata.slice(12)).toEqual(new Array(5).fill(0))
        const oldFormat = bank(['legacy', 'reading', 'noun', '', 0, ['definition']])
        const result = parse(oldFormat, false)
        expect(result.count).toBe(1)
        expect(result.metadata[11]).toBe(0xffffffff)
        expect(result.metadata.slice(12)).toEqual(new Array(5).fill(0))
        expect(parse(oldFormat, true).count).toBeLessThan(0)
    })

    test('rejects missing and additional strict fields after a valid populated row', () => {
        for (let length = 0; length < 8; ++length) {
            parse(bank(rows[0]), true)
            expect(parse(bank(rows[0].slice(0, length)), true).count).toBeLessThan(0)
        }
        expect(parse(bank([...rows[0], 'extra']), true).count).toBeLessThan(0)
    })

    test('rejects malformed and truncated source rows without publishing stale metadata', () => {
        const source = bank(rows[0])
        for (let length = 1; length < source.length; ++length) {
            parse(bank(rows[1]), true)
            expect(parse(source.slice(0, length), true).count).toBeLessThan(0)
        }
        for (const [index, value] of /** @type {Array<[number, unknown]>} */ ([
            [0, null], [1, false], [2, 1], [3, null], [4, '0'], [5, {}], [6, true], [7, null],
        ])) {
            const row = [...rows[0]]
            row[index] = value
            expect(parse(bank(row), true).count).toBeLessThan(0)
        }
        expect(parse(bank(rows[0]), true)).toEqual(parse(bank(rows[0]), false))
    })

    test('preserves fused columns, media and content after repeated strict heap reuse', async () => {
        /**
         * @param {boolean} strict
         * @returns {Promise<Record<string, unknown>>}
         */
        const snapshot = async (strict) => {
            /** @type {ReturnType<typeof copyWasmBackedColumnChunk>|null} */
            let owned = null
            await parseTermBankWithWasmColumnChunks(
                [encoder.encode(JSON.stringify(rows.slice(0, 3))), encoder.encode(JSON.stringify(rows.slice(3)))],
                3,
                (chunk) => { owned = copyWasmBackedColumnChunk(chunk) },
                2048,
                {singleChunk: true, emitContentSlab: true, emitTokenBinaryContent: true, mediaHintFastScan: true, validateGlossaryTypes: strict},
            )
            const profile = consumeLastTermBankWasmParseProfile()
            expect(profile?.fusedParseAttempts).toBe(1)
            expect(profile?.fusedParseFallbacks).toBe(0)
            if (owned === null) { throw new Error('Missing fused result') }
            const chunk = /** @type {ReturnType<typeof copyWasmBackedColumnChunk>} */ (owned)
            return {
                plan: chunk.termRecordPreinternedPlan,
                equals: chunk.readingEqualsExpressionList,
                scores: chunk.scoreList,
                sequences: chunk.sequenceList,
                contentMeta: chunk.contentMetaList,
                content: chunk.contentBytesBuffer,
                media: chunk.mediaRows,
            }
        }
        const expected = await snapshot(false)
        expect(await snapshot(true)).toEqual(expected)
        expect(await snapshot(true)).toEqual(expected)
    })
})
