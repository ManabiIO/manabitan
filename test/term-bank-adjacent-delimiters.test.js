/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {beforeAll, describe, expect, test} from 'vitest'

/** @typedef {{memory: WebAssembly.Memory, wasm_reset_heap: () => void, wasm_alloc: (size: number) => number, parse_term_bank_with_media_hints: (...args: number[]) => number}} Exports */
/** @type {Exports} */
let wasm
const encoder = new TextEncoder()
const decoder = new TextDecoder()

beforeAll(async () => {
    const bytes = await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))
    wasm = /** @type {Exports} */ (/** @type {unknown} */ ((await WebAssembly.instantiate(bytes)).instance.exports))
})

/**
 * Guard output and make bytes beyond logical EOF look like valid punctuation.
 * @param {string[]} banks
 * @param {number} [alignment]
 * @param {boolean} [physicalEnd]
 * @returns {{count: number, metadata: number[], bytes: Uint8Array}}
 */
function parse(banks, alignment = 0, physicalEnd = false) {
    wasm.wasm_reset_heap()
    const bytes = encoder.encode(banks.join(''))
    const spanPointer = wasm.wasm_alloc(Math.max(8, banks.length * 8))
    const guard = wasm.wasm_alloc(100)
    const output = guard + 16
    const allocation = wasm.wasm_alloc(bytes.length + 96)
    const heap = new Uint8Array(wasm.memory.buffer)
    const input = physicalEnd ? heap.length - bytes.length : allocation + alignment
    heap.fill(0x3a, allocation, allocation + bytes.length + 96)
    heap.set(bytes, input)
    heap.fill(0xa5, guard, output + 84)
    const spans = new Uint32Array(wasm.memory.buffer, spanPointer, banks.length * 2)
    let cursor = 0
    for (const [i, bank] of banks.entries()) {
        const length = encoder.encode(bank).length
        spans[i * 2] = cursor
        spans[i * 2 + 1] = length
        cursor += length
    }
    const count = wasm.parse_term_bank_with_media_hints(input, bytes.length, output, 1, banks.length > 1 ? spanPointer : 0, banks.length > 1 ? banks.length : 0)
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
 * The native path must agree with the independent JSON parser, including token
 * termination. This generator only supplies arrays and objects as glossaries.
 * @param {string} glossary
 * @param {number} [alignment]
 * @returns {void}
 */
function check(glossary, alignment = 0) {
    let valid = true
    /** @type {unknown} */
    let expected
    try {
        expected = JSON.parse(glossary)
    } catch {
        valid = false
    }
    const actual = parse([bank(glossary)], alignment)
    expect(actual.count > 0).toBe(valid)
    if (!valid) { return }
    const [start, length] = actual.metadata.slice(9, 11)
    expect(start + length).toBeLessThanOrEqual(actual.bytes.length)
    const retained = decoder.decode(actual.bytes.subarray(start, start + length))
    expect(retained).toBe(glossary)
    expect(JSON.parse(retained)).toEqual(expected)
}

const valueTokens = ['""', '"value"', JSON.stringify('escaped",:[]{}'), '0', '-1.2e+3', 'true', 'false', 'null', '[]', '{}', '[{"x":"y"}]']
const spaces = ['', ' ', '\t', '\r\n', ' \n\t']

describe('adjacent JSON delimiter state transitions', () => {
    test.each(Array.from({length: 16}, (_, i) => i))('preserves string/key delimiters and whitespace at alignment %i', (alignment) => {
        for (const before of spaces) {
            for (const after of spaces) {
                for (const token of valueTokens) {
                    check(`{"key"${before}:${after}${token},"next":"last"}`, alignment)
                    check(`["first"${before},${after}${token},"last"]`, alignment)
                    check(`{"first":"value"${before},${after}"next":${token}}`, alignment)
                }
            }
        }
    })

    test('rejects missing, doubled and misplaced separators after strings', () => {
        const malformed = [
            '["a",]',
            '["a",,0]',
            '["a":0]',
            '["a""b"]',
            '{"a":}',
            '{"a"::0}',
            '{"a",0}',
            '{"a":0,}',
            '{"a":"b",}',
            '{"a":"b",,"c":0}',
            '{"a":"b":"c"}',
            '{"a":"b""c":0}',
            '{"a":"b",true:0}',
            '[{"a":"b",}]',
            '{"a":{"b":"c"},:0}',
        ]
        for (const text of malformed) { check(text, 7) }
    })

    test('agrees on every ASCII character immediately after keys and string values', () => {
        for (let byte = 0; byte < 128; ++byte) {
            const token = String.fromCharCode(byte)
            for (const json of [`{"key"${token}:0}`, `{"key": "v"${token},"next":0}`, `["v"${token},0]`]) {
                check(json, byte % 16)
            }
        }
    })

    test('keeps delimiter lookahead inside logical and physical source bounds', () => {
        for (const text of ['{"key":"value","next":["",{"x":"y"}]}', '["",{"type":"text","text":"日🙂"}]']) {
            const source = bank(text)
            for (let length = 1; length < source.length; ++length) {
                expect(parse([source.slice(0, length)], length % 16).count).toBeLessThan(0)
                expect(parse([source.slice(0, length)], 0, true).count).toBeLessThan(0)
            }
            expect(parse([source], 0, true).count).toBe(1)
        }
    })

    test('never uses a delimiter from the next independently bounded bank', () => {
        const source = bank('[{"key":"value","another":""},"last"]')
        for (let split = 1; split < source.length; ++split) {
            expect(parse([source.slice(0, split), source.slice(split)]).count).toBeLessThan(0)
        }
    })

    test('preserves conservative media and normalization hints', () => {
        for (const [text, flags] of /** @type {Array<[string, number[]]>} */ ([
            ['[{"tag":"img","path":"a.png"}]', [1, 0, 0]],
            ['[{"type":"text","text":"hello"}]', [0, 1, 1]],
            ['[ {"tag": "span", "content": "plain"} ]', [0, 1, 0]],
            ['[{"nested":{"type":"text","text":"x"},"tag":"img"}]', [1, 1, 1]],
            ['[{"x":"ordinary","y":["","last"]}]', [0, 0, 0]],
        ])) {
            const result = parse([bank(text)])
            expect(result.count).toBe(1)
            expect(result.metadata.slice(14)).toEqual(flags)
        }
    })

    test('preserves suspended parent states up to the existing nesting limit', () => {
        for (const depth of [1, 2, 3, 63, 127, 255, 256]) {
            let text = '"leaf"'
            for (let i = 0; i < depth; ++i) { text = i % 2 ? `{"k":${text},"tail":""}` : `["first",${text},"last"]` }
            check(text)
        }
        const excessive = '['.repeat(257) + '"x"' + ']'.repeat(257)
        expect(parse([bank(excessive)]).count).toBeLessThan(0)
    })

    test('matches JSON validity under 2,000 deterministic nested-value mutations', () => {
        let state = 0x19e4c631
        const random = () => {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0
            return state
        }
        const punctuation = ['[', ']', '{', '}', ':', ',', '"', ' ', '\t', '\\', '0', 'n']
        for (let trial = 0; trial < 2000; ++trial) {
            const valid = JSON.stringify([{key: [trial, `text ${random()}`, {nested: [true, null, 'a",:[]{}']}], tail: ''}, 'last'])
            const offset = 1 + random() % (valid.length - 2)
            const token = punctuation[random() % punctuation.length]
            check(valid.slice(0, offset) + token + valid.slice(offset + 1), trial % 16)
            check(valid.slice(0, offset) + valid.slice(offset + 1), trial % 16)
        }
    })
})
