/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {beforeAll, describe, expect, test} from 'vitest'

/** @typedef {{memory: WebAssembly.Memory, wasm_reset_heap: () => void, wasm_alloc: (size: number) => number, parse_term_bank: (...args: number[]) => number, parse_term_bank_with_media_hints: (...args: number[]) => number}} Exports */
/** @typedef {{hints?: boolean, validate?: boolean, alignment?: number, logicalLength?: number, physicalEnd?: boolean}} ParseOptions */
/** @type {Exports} */
let wasm
const encoder = new TextEncoder()
const decoder = new TextDecoder()

beforeAll(async () => {
    const bytes = await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))
    wasm = /** @type {Exports} */ (/** @type {unknown} */ ((await WebAssembly.instantiate(bytes)).instance.exports))
})

/**
 * Keep valid bytes beyond logical EOF and guards around the metadata output.
 * @param {string[]} banks
 * @param {ParseOptions} [options]
 * @returns {{count: number, metadata: number[], bytes: Uint8Array}}
 */
function parse(banks, options = {}) {
    wasm.wasm_reset_heap()
    const bytes = encoder.encode(banks.join(''))
    const spansPointer = wasm.wasm_alloc(Math.max(8, banks.length * 8))
    const guard = wasm.wasm_alloc(100)
    const output = guard + 16
    const allocation = wasm.wasm_alloc(bytes.length + 64)
    const heap = new Uint8Array(wasm.memory.buffer)
    const input = options.physicalEnd === true ? heap.length - bytes.length : allocation + (options.alignment ?? 0)
    heap.fill(0x3a, allocation, allocation + bytes.length + 64)
    heap.set(bytes, input)
    heap.fill(0xa5, guard, output + 84)
    const spans = new Uint32Array(wasm.memory.buffer, spansPointer, banks.length * 2)
    let cursor = 0
    for (const [index, source] of banks.entries()) {
        const length = encoder.encode(source).length
        spans[index * 2] = cursor
        spans[index * 2 + 1] = length
        cursor += length
    }
    const parseBank = options.hints === false ? wasm.parse_term_bank : wasm.parse_term_bank_with_media_hints
    const count = parseBank(
        input,
        options.logicalLength ?? bytes.length,
        output,
        1,
        banks.length > 1 ? spansPointer : 0,
        banks.length > 1 ? banks.length : 0,
        options.validate === false ? 0 : 1,
    )
    expect([...heap.subarray(guard, output)]).toEqual(new Array(16).fill(0xa5))
    expect([...heap.subarray(output + 68, output + 84)]).toEqual(new Array(16).fill(0xa5))
    return {count, metadata: [...new Uint32Array(wasm.memory.buffer, output, 17)], bytes}
}

/**
 * @param {string} glossary
 * @returns {string}
 */
function bank(glossary) { return `[["entry","reading","noun","",0,${glossary},1,""]]` }

/**
 * @param {string} glossary
 * @param {ParseOptions} [options]
 * @returns {ReturnType<typeof parse>}
 */
function check(glossary, options = {}) {
    const result = parse([bank(glossary)], options)
    expect(result.count).toBe(1)
    const [start, length] = result.metadata.slice(9, 11)
    const retained = decoder.decode(result.bytes.subarray(start, start + length))
    expect(retained).toBe(glossary)
    expect(JSON.parse(retained)).toEqual(JSON.parse(glossary))
    return result
}

describe('literal structured-content type pairs', () => {
    test.each(Array.from({length: 16}, (_, index) => index))('preserves complete values and closing frames at alignment %i', (alignment) => {
        for (const content of ['""', '"日🙂"', '[]', '{}', '["first",{"tag":"span","content":"last"}]']) {
            for (const glossary of [
                `[{"type":"structured-content","content":${content}}]`,
                `[{"content":${content},"type":"structured-content"}]`,
                `[{"content":${content},"type":"structured-content","after":[{},[]]}]`,
            ]) {
                for (const hints of [false, true]) {
                    const result = check(glossary, {alignment, hints})
                    expect(result.metadata.slice(14)).toEqual([0, 0, 0])
                }
            }
        }
    })

    test('keeps whitespace normalization and generic separator fallbacks', () => {
        for (const beforeColon of ['', ' ', '\t', '\r\n']) {
            for (const afterColon of ['', ' ', '  ', '\t', '\n']) {
                for (const afterValue of ['', ' ', '\t', '\r\n']) {
                    for (const tail of [',"content":[]', '']) {
                        const glossary = `[{"content":[],"type"${beforeColon}:${afterColon}"structured-content"${afterValue}${tail}}]`
                        const result = check(glossary)
                        expect(result.metadata.slice(14)).toEqual([0, beforeColon || afterColon || afterValue ? 1 : 0, 0])
                    }
                }
            }
        }
    })

    test('retains escaped key/value spellings and equivalent decoded glossary values', () => {
        const expected = JSON.parse('[{"type":"structured-content","content":[]}]')
        for (const pair of [
            '"type":"structured-content"',
            '"ty\\u0070e":"structured-content"',
            '"\\u0074ype":"structured-content"',
            '"type":"structured-\\u0063ontent"',
            '"type":"\\u0073tructured-content"',
        ]) {
            const glossary = `[{${pair},"content":[]}]`
            const result = check(glossary)
            expect(JSON.parse(glossary)).toEqual(expected)
            expect(result.metadata.slice(14)).toEqual([0, 0, 0])
        }
    })

    test.each([
        '[{"type":"structured-content",}]',
        '[{"type":"structured-content",,"content":[]}]',
        '[{"type":"structured-content":"content"}]',
        '[{"type":"structured-content""content":[]}]',
        '[{"type":"structured-content"]}]',
        '[{"type":"structured-content",true:[]}]',
        '[{"type"::"structured-content","content":[]}]',
        '[{"type":"structured-content"x,"content":[]}]',
    ])('rejects malformed punctuation without accepting a literal prefix: %s', (glossary) => {
        for (const validate of [false, true]) {
            for (const hints of [false, true]) {
                expect(parse([bank(glossary)], {validate, hints}).count).toBeLessThan(0)
            }
        }
    })

    test.each([
        '{"type":"structured-content"}',
        '{"content":null,"type":"structured-content"}',
        '{"type":"structured-content","content":false}',
        '{"type":"structured-content","content":0}',
        '{"content":[],"type":"structured-contentx"}',
        '{"content":[],"type":"structured-content\\u0020"}',
        '{"content":[],"type":"structured-content","type":"text"}',
        '{"content":[],"type":"structured-content","ty\\u0070e":"image"}',
        '{"content":[],"type":"structured-content","type":null}',
        '{"type":"structured-content","content":[],"content":false}',
    ])('validates required fields and the last duplicate value: %s', (object) => {
        const glossary = `[${object}]`
        for (const hints of [false, true]) {
            expect(parse([bank(glossary)], {hints}).count).toBeLessThan(0)
            check(glossary, {hints, validate: false})
        }
    })

    test.each([
        '{"type":null,"type":"structured-content","content":[]}',
        '{"type":"unknown","content":{},"type":"structured-content"}',
        '{"ty\\u0070e":"image","content":[],"type":"structured-content"}',
        '{"type":"structured-content","type":"image","path":"a.png"}',
        '{"type":"structured-content","content":false,"content":[]}',
        '{"content":null,"content":"value","type":"structured-content"}',
    ])('accepts a valid final type or required field: %s', (object) => {
        check(`[${object}]`)
    })

    test('keeps nested types separate from top-level required fields and parent states', () => {
        for (const depth of [0, 1, 2, 8, 32, 127]) {
            let nested = '{"type":"structured-content"}'
            for (let i = 0; i < depth; ++i) { nested = i % 2 ? `{"nested":${nested},"tail":[]}` : `[${nested},"last"]` }
            check(`[{"type":"structured-content","content":${nested}}]`)
            check(`[{"type":"image","path":"a.png","nested":${nested}}]`)
        }
        const media = check('[{"type":"structured-content","content":{"tag":"img","path":"a.png"}},{"content":[],"type":"structured-content"}]')
        expect(media.metadata.slice(14)).toEqual([1, 0, 0])
        const text = check('[{"type":"structured-content","content":{"type":"text","text":"value"}}]')
        expect(text.metadata.slice(14)).toEqual([0, 1, 1])
        check('{"type":"structured-content"}', {validate: false})
    })

    test('never accepts a key/value pair outside the logical or physical source end', () => {
        for (const glossary of ['[{"content":[],"type":"structured-content"}]', '[{"type": "structured-content", "content":[]}]']) {
            const source = bank(glossary)
            const start = source.indexOf('"type"')
            for (let length = start; length < source.length; ++length) {
                expect(parse([source], {logicalLength: length, alignment: length % 16}).count).toBeLessThan(0)
                expect(parse([source.slice(0, length)], {physicalEnd: true}).count).toBeLessThan(0)
            }
            expect(parse([source], {physicalEnd: true}).count).toBe(1)
        }
    })

    test('does not borrow a literal suffix from another independently bounded bank', () => {
        const source = bank('[{"type":"structured-content","content":[]}]')
        const start = source.indexOf('"type"')
        for (let split = start; split < source.length; ++split) {
            expect(parse([source.slice(0, split), source.slice(split)]).count).toBeLessThan(0)
        }
    })
})
