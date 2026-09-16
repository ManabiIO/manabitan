/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {beforeAll, describe, expect, test} from 'vitest'

/** @typedef {{memory: WebAssembly.Memory, wasm_reset_heap: () => void, wasm_alloc: (n: number) => number, parse_term_bank_with_media_hints: (...args: number[]) => number, parse_and_encode_term_bank_token_binary_dedup: (...args: number[]) => number}} Exports */
/** @type {Exports} */
let wasm
const encoder = new TextEncoder()
const decoder = new TextDecoder()
beforeAll(async () => {
    const {instance} = await WebAssembly.instantiate(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url)))
    wasm = /** @type {Exports} */ (/** @type {unknown} */ (instance.exports))
})

/**
 * Exercise real fused and ordinary production exports with guarded metadata.
 * All arenas are disjoint; a reset precedes each independently owned result.
 * @param {string} text
 * @param {boolean} fused
 * @param {number} [alignment]
 * @param {boolean} [physicalEnd]
 * @returns {{count: number, metadata: number[], bytes: Uint8Array}}
 */
function parse(text, fused, alignment = 0, physicalEnd = false) {
    const bytes = encoder.encode(text)
    wasm.wasm_reset_heap()
    const alloc = (/** @type {number} */ size) => wasm.wasm_alloc(Math.max(8, size))
    const capacity = 16
    const guard = alloc(capacity * 68 + 32)
    const metas = guard + 16
    const outputCapacity = bytes.length * 4 + 1024
    const output = alloc(outputCapacity)
    const rowMeta = alloc(capacity * 16)
    const hash = alloc(256 * 4)
    const uniques = alloc(capacity * 4)
    const uniqueCount = alloc(4)
    const signatures = alloc(capacity * 12)
    const rowCount = alloc(4)
    const stringCapacity = bytes.length * 2 + 64
    const strings = alloc(stringCapacity)
    const lengths = alloc(capacity * 2 * 2)
    const offsets = alloc(capacity * 2 * 4)
    const hashes = alloc(capacity * 2 * 4)
    const expressions = alloc(capacity * 4)
    const readings = alloc(capacity * 4)
    const stringTable = alloc(256 * 4)
    const stringCount = alloc(4)
    const stringBytes = alloc(4)
    const aliases = alloc(capacity)
    const scores = alloc(capacity * 4)
    const sequences = alloc(capacity * 4)
    const recent = alloc(4)
    const allocation = alloc(bytes.length + 64)
    const heap = new Uint8Array(wasm.memory.buffer)
    heap.fill(0, guard, allocation + bytes.length + 64)
    heap.fill(0xa5, guard, guard + 16)
    heap.fill(0xa5, metas + capacity * 68, metas + capacity * 68 + 16)
    heap.fill(0x5d, allocation, allocation + bytes.length + 64)
    const input = physicalEnd ? heap.length - bytes.length : allocation + alignment
    heap.set(bytes, input)
    let count
    if (fused) {
        const size = wasm.parse_and_encode_term_bank_token_binary_dedup(
            input,
            bytes.length,
            metas,
            capacity,
            output,
            outputCapacity,
            rowMeta,
            hash,
            256,
            uniques,
            uniqueCount,
            signatures,
            rowCount,
            strings,
            stringCapacity,
            lengths,
            offsets,
            hashes,
            expressions,
            readings,
            stringTable,
            256,
            stringCount,
            stringBytes,
            aliases,
            scores,
            sequences,
            recent,
            1,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
        )
        count = size >= 0 ? new Uint32Array(wasm.memory.buffer, rowCount, 1)[0] : size
    } else {
        count = wasm.parse_term_bank_with_media_hints(input, bytes.length, metas, capacity, 0, 0)
    }
    expect([...heap.subarray(guard, guard + 16)]).toEqual(new Array(16).fill(0xa5))
    expect([...heap.subarray(metas + capacity * 68, metas + capacity * 68 + 16)]).toEqual(new Array(16).fill(0xa5))
    return {count, metadata: [...new Uint32Array(wasm.memory.buffer, metas, Math.max(0, count) * 17)], bytes}
}

/**
 * @param {string} value
 * @param {number} [alignment]
 */
function checkGlossary(value, alignment = 0) {
    let valid = true
    try {
        JSON.parse(value)
    } catch {
        valid = false
    }
    const source = `[["entry","reading","noun","",-2147483648,${value},2147483647,""]]`
    const plain = parse(source, false, alignment)
    const fused = parse(source, true, alignment)
    expect(plain.count > 0).toBe(valid)
    expect(fused.count > 0).toBe(valid)
    if (!valid) { return }
    expect(fused.metadata).toEqual(plain.metadata)
    const [start, length] = fused.metadata.slice(9, 11)
    expect(decoder.decode(fused.bytes.subarray(start, start + length))).toBe(value)
}

const validScalars = ['0', '-0', '1', '-1', '1.25', '-0.25', '2e3', '2E-3', '2e+3', '1e999', 'true', 'false', 'null']
const invalidScalars = ['', '-', '+1', '00', '-01', '.1', '1.', '1e', '1e+', '1e--2', 'truefalse', 'null0', 'falsex', 'True', 'NaN', 'Infinity', '0x10']

describe('native parser control-flow equivalence', () => {
    test.each(Array.from({length: 16}, (_, i) => i))('preserves scalar and container transitions at alignment %i', (alignment) => {
        for (const scalar of [...validScalars, ...invalidScalars]) {
            for (const whitespace of ['', ' ', '\t\r\n']) {
                checkGlossary(`[${whitespace}${scalar}${whitespace}]`, alignment)
                checkGlossary(`{"key":${whitespace}${scalar}${whitespace}}`, alignment)
            }
        }
    })

    test('rejects valid scalar prefixes followed by any invalid ASCII suffix', () => {
        for (const scalar of ['0', '12', '1.2e-3', 'true', 'false', 'null']) {
            for (let byte = 0; byte < 128; ++byte) {
                checkGlossary(`[${scalar}${String.fromCharCode(byte)},"tail"]`, byte % 16)
            }
        }
    })

    test('preserves missing optional fields, extra fields and defaults', () => {
        const row = ['entry', 'reading', 'noun', '', null, ['meaning'], null, 'common', {extra: [true, null]}, 'last']
        for (let fields = 2; fields <= row.length; ++fields) {
            for (const indent of [undefined, 1, 4]) {
                const source = JSON.stringify([row.slice(0, fields)], null, indent)
                const a = parse(source, false)
                const b = parse(source, true)
                expect(a.count).toBe(1)
                expect(b.count).toBe(1)
                expect(b.metadata).toEqual(a.metadata)
                expect(b.metadata[8]).toBe(0)
                expect(b.metadata[11]).toBe(0xffffffff)
            }
        }
    })

    test('does not accept trailing commas or stop validating extra fields', () => {
        for (const source of [
            '[["entry","reading",]]',
            '[["entry","reading","","",0,[],1,"",truefalse]]',
            '[["entry","reading","","",0,[],1,"",{"x":}]]',
            '[["entry","reading","","",0,[],1,""],]',
        ]) {
            expect(parse(source, true).count).toBeLessThan(0)
            expect(parse(source, false).count).toBeLessThan(0)
        }
    })

    test('retains logical and physical end bounds at every truncated prefix', () => {
        const source = '[["entry","reading","","",-1,[{"a":[true,false,null,1.2e3]},"x"],123,"",{"extra":0}]]'
        for (let length = 1; length < source.length; ++length) {
            for (const fused of [false, true]) {
                expect(parse(source.slice(0, length), fused, length % 16).count).toBeLessThan(0)
                expect(parse(source.slice(0, length), fused, 0, true).count).toBeLessThan(0)
            }
        }
    })

    test('keeps parent states valid through deep nested values and later siblings', () => {
        for (const depth of [1, 2, 16, 63, 127, 255, 256]) {
            let value = 'null'
            for (let i = 0; i < depth; ++i) { value = i % 2 ? `{"k":${value},"tail":true}` : `[false,${value},"end"]` }
            checkGlossary(value)
        }
        const source = `[["entry","reading","","",0,${'['.repeat(257)}0${']'.repeat(257)},1,""]]`
        expect(parse(source, true).count).toBeLessThan(0)
        expect(parse(source, false).count).toBeLessThan(0)
    })

    test('agrees with independent JSON validity for 1,000 deterministic mutations', () => {
        let state = 0x736cd420
        const random = () => {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0
            return state
        }
        const tokens = ['[', ']', '{', '}', ':', ',', '"', ' ', '-', '0', 'e', 't', '\\']
        for (let trial = 0; trial < 1000; ++trial) {
            const value = JSON.stringify([{k: [trial, true, false, null, 1.25, {nested: ['text', 0]}], next: ''}])
            const position = 1 + random() % (value.length - 2)
            checkGlossary(value.slice(0, position) + tokens[random() % tokens.length] + value.slice(position + 1), trial % 16)
        }
    })
    test('preserves string prefixes when arrays become mixed, nested or malformed', () => {
        const prefixes = [[], [''], ['one'], ['a', 'b'], ['img', 'image', 'escaped\\"'], Array.from({length: 40}, (_, i) => `value ${i}`)]
        const tails = [[], [null], [false, 1.25], [{type: 'text', text: 'meaning'}], [[{tag: 'img', path: 'x.png'}]], [{x: [1, true, '']}]]
        for (const prefix of prefixes) {
            for (const tail of tails) {
                for (const indent of [undefined, 1]) {
                    const value = JSON.stringify([...prefix, ...tail, 'last'], null, indent)
                    checkGlossary(value, prefix.length % 16)
                }
            }
        }
        for (const value of ['["x",]', '["x",,null]', '["x":1]', '["x"null]', '["x",{"bad":}]', '["x",[1,]]', '["x",truefalse]']) {
            checkGlossary(value)
        }
    })

    test('retains exact media and normalization hints across string-prefix handoff', () => {
        for (const [value, hints] of /** @type {Array<[string, number[]]>} */ ([
            ['["plain","last"]', [0, 0, 0]],
            ['["plain", "last"]', [0, 1, 0]],
            ['["img","last"]', [1, 0, 0]],
            ['["image",{"type":"text","text":"x"}]', [1, 1, 1]],
            ['["first",{"nested":[{"type":"text","text":"x"}],"tag":"img"}]', [1, 1, 1]],
            ['["first",{"tag":"span","content":"x"}]', [0, 0, 0]],
            ['["first", {"tag":"span","content":"x"}]', [0, 1, 0]],
        ])) {
            const source = `[ ["entry","reading","noun","",0,${value},1,""] ]`
            for (const fused of [false, true]) {
                const result = parse(source, fused)
                expect(result.count).toBe(1)
                expect(result.metadata.slice(14, 17)).toEqual(hints)
            }
        }
    })
})
