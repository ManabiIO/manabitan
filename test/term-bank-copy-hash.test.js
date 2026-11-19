/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */
import {readFile} from 'node:fs/promises'
import {beforeAll, expect, test} from 'vitest'
import {hashTermEntryContentBytesPair} from '../ext/js/dictionary/term-entry-content-hash.js'

/** @typedef {{memory: WebAssembly.Memory, wasm_reset_heap: () => void, wasm_alloc: (size: number) => number, wasm_get_last_content_capacity: () => number, parse_term_bank: (...args: number[]) => number, encode_term_content_token_binary: (...args: number[]) => number}} Exports */
/** @typedef {{source: string, expected: Uint8Array}} Case */
/** @type {Exports} */
let wasm
const encoder = new TextEncoder()

beforeAll(async () => {
    const module = await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url)))
    wasm = /** @type {Exports} */ (/** @type {unknown} */ ((await WebAssembly.instantiate(module)).exports))
})

/**
 * @param {string} glossary
 * @param {string} tags
 * @param {string} [rules]
 * @param {string} [termTags]
 * @param {string} [normalized]
 * @returns {Case}
 */
function fixture(glossary, tags, rules = '""', termTags = '""', normalized = glossary) {
    return {
        source: `["head","",${tags},${rules},1,${glossary},2,${termTags}]`,
        expected: encoder.encode(`MBR6${rules}\0${tags === 'null' ? '""' : tags}\0${termTags === 'null' ? '""' : termTags}\0${normalized}`),
    }
}

/**
 * @param {Case[]} cases
 * @param {number} capacity
 * @param {boolean} [blockGrowth]
 */
function verify(cases, capacity, blockGrowth = false) {
    wasm.wasm_reset_heap()
    const source = encoder.encode(`[${cases.map((entry) => entry.source).join(',')}]`)
    const input = wasm.wasm_alloc(source.length)
    const rows = wasm.wasm_alloc(cases.length * 68)
    const metadata = wasm.wasm_alloc(cases.length * 16)
    const output = wasm.wasm_alloc(capacity)
    const guard = blockGrowth ? wasm.wasm_alloc(64) : 0
    new Uint8Array(wasm.memory.buffer).set(source, input)
    if (guard) { new Uint8Array(wasm.memory.buffer, guard, 64).fill(0xa7) }
    expect(wasm.parse_term_bank(input, source.length, rows, cases.length)).toBe(cases.length)
    const result = wasm.encode_term_content_token_binary(input, rows, cases.length, output, capacity, metadata)
    expect(new Uint8Array(wasm.memory.buffer, input, source.length)).toEqual(source)
    if (blockGrowth) {
        expect(result).toBe(-2)
        expect([...new Uint8Array(wasm.memory.buffer, guard, 64)]).toEqual(new Array(64).fill(0xa7))
        return
    }
    expect(result).toBe(cases.reduce((sum, entry) => sum + entry.expected.length, 0))
    const meta = new Uint32Array(wasm.memory.buffer, metadata, cases.length * 4)
    let position = 0
    for (let index = 0; index < cases.length; ++index) {
        const expected = cases[index].expected
        expect(meta[index * 4]).toBe(position)
        expect(meta[index * 4 + 1]).toBe(expected.length)
        expect(new Uint8Array(wasm.memory.buffer, output + position, expected.length)).toEqual(expected)
        expect([meta[index * 4 + 2], meta[index * 4 + 3]]).toEqual(hashTermEntryContentBytesPair(expected))
        position += expected.length
    }
    expect(wasm.wasm_get_last_content_capacity()).toBeGreaterThanOrEqual(result)
}

test('copies exact raw tokens and both hashes at every prefix remainder, block and SIMD boundary', () => {
    /** @type {Case[]} */
    const cases = []
    for (const base of [13, 61, 509]) {
        for (let remainder = 0; remainder < 16; ++remainder) {
            const prefixLength = base + remainder
            const tags = JSON.stringify('t'.repeat(prefixLength - 13))
            const lengths = new Set([2, 3, 4, 5, 15, 16, 17, 31, 32, 33, 63, 64, 65, 511, 512, 513, 1023])
            for (const total of [15, 16, 17, 63, 64, 65, 511, 512, 513, 514, 1023, 1024, 1025]) {
                if (total - prefixLength >= 2) { lengths.add(total - prefixLength) }
            }
            for (const length of lengths) {
                const glossary = length === 2 ? '[]' : (length === 3 ? '[ ]' : `["${'x'.repeat(length - 4)}"]`)
                cases.push(fixture(glossary, tags))
            }
        }
    }
    verify(cases, cases.reduce((sum, entry) => sum + entry.expected.length, 0))
})

test('preserves escapes, UTF-8, null tags and normalization fallback in mixed records', () => {
    const cases = [
        fixture(String.raw`["猫😀","\\u0061","\u0062", {"type":"structured-content","content":{"tag":"span","content":"語"}}]`, '"é猫"', String.raw`"\u0076"`, '"😀"'),
        fixture('["raw whitespace" , "kept"]', 'null', '"v1"'),
        fixture('[{"text":"猫😀","type":"text"}, {"type":"text","text":"kept","extra":true}]', '"tag"', '"rule"', '"term"', '["猫😀",{"type":"text","text":"kept","extra":true}]'),
        fixture('[]', '""'),
    ]
    verify(cases, 32)
    verify(cases, cases.reduce((sum, entry) => sum + entry.expected.length, 0))
})

test('capacity retries and failed growth preserve source, guards and later reset results', () => {
    const cases = [
        fixture('[]', '""'),
        fixture(`["${'x'.repeat(4097)}"]`, JSON.stringify('t'.repeat(79))),
        fixture('[{"type":"text","text":"normalized"}]', '""', '""', '""', '["normalized"]'),
    ]
    for (const capacity of [4, 13, 14, 15, 16, 63, 64, 511, 512, 513]) {
        verify(cases, capacity, true)
        verify(cases, capacity)
    }
    verify([fixture('["after reset"]', '""')], 64)
})
