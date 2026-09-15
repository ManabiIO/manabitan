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
import {crc32, deflateRawSync} from 'node:zlib'
import {beforeAll, describe, expect, test} from 'vitest'

/** @typedef {{memory: WebAssembly.Memory, wasm_reset_heap: () => void, wasm_alloc: (size: number) => number, inflate_and_join_term_banks: (...args: number[]) => number}} Exports */
/** @typedef {{bytes: Uint8Array, decodedBytes: number, method: number, signature: number}} Source */
/** @type {Exports} */
let wasm
const encoder = new TextEncoder()
const decoder = new TextDecoder()

beforeAll(async () => {
    const module = await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url)))
    wasm = /** @type {Exports} */ (/** @type {unknown} */ ((await WebAssembly.instantiate(module)).exports))
})

/**
 * @param {string} text
 * @param {number} method
 * @returns {Source}
 */
function source(text, method) {
    const bytes = encoder.encode(text)
    return {bytes: method === 8 ? new Uint8Array(deflateRawSync(bytes)) : bytes,
        decodedBytes: bytes.length,
        method,
        signature: crc32(bytes)}
}

/**
 * Exercise the production export against dirty, guarded output. Metadata and
 * payload are outside the guarded destination, as in the production wrapper.
 * @param {Source[]} sources
 * @param {boolean} [spans]
 * @param {number} [capacityOverride]
 * @returns {{length: number, bytes: Uint8Array, spans: number[]}}
 */
function join(sources, spans = false, capacityOverride) {
    wasm.wasm_reset_heap()
    const inputLength = sources.reduce((n, entry) => n + entry.bytes.length, 0)
    const capacity = capacityOverride ?? sources.reduce((n, entry) => n + entry.decodedBytes, 2)
    const input = wasm.wasm_alloc(Math.max(1, inputLength))
    const meta = wasm.wasm_alloc(Math.max(4, sources.length * 5 * 4))
    const spanPointer = wasm.wasm_alloc(Math.max(8, sources.length * 8))
    const guarded = wasm.wasm_alloc(capacity + 32)
    const output = guarded + 16
    const heap = new Uint8Array(wasm.memory.buffer)
    const words = new Uint32Array(wasm.memory.buffer)
    heap.fill(0xa5, guarded, guarded + capacity + 32)
    heap.fill(0x5a, spanPointer, spanPointer + sources.length * 8)
    let offset = 0
    for (const [i, entry] of sources.entries()) {
        heap.set(entry.bytes, input + offset)
        words[meta / 4 + i] = offset
        words[meta / 4 + sources.length + i] = entry.bytes.length
        words[meta / 4 + sources.length * 2 + i] = entry.decodedBytes
        words[meta / 4 + sources.length * 3 + i] = entry.method
        words[meta / 4 + sources.length * 4 + i] = entry.signature
        offset += entry.bytes.length
    }
    const length = wasm.inflate_and_join_term_banks(
        input,
        inputLength,
        meta,
        meta + sources.length * 4,
        meta + sources.length * 8,
        meta + sources.length * 12,
        meta + sources.length * 16,
        sources.length,
        output,
        capacity,
spans ? spanPointer : 0,
    )
    expect(heap.subarray(guarded, output)).toEqual(new Uint8Array(16).fill(0xa5))
    expect(heap.subarray(output + capacity, output + capacity + 16)).toEqual(new Uint8Array(16).fill(0xa5))
    return {length,
        bytes: heap.slice(output, output + Math.max(0, length)),
        spans: [...new Uint32Array(wasm.memory.buffer, spanPointer, sources.length * 2)]}
}

/**
 * Independent byte-level oracle: do not parse/stringify the interior, which
 * would silently normalize whitespace or escapes that the join must preserve.
 * @param {string[]} texts
 * @returns {string}
 */
function expectedJoin(texts) {
    return `[${texts.map((text) => text.trim().slice(1, -1).trim()).filter(Boolean).join(',')}]`
}

const widths = [0, 1, 2, 3, 7, 8, 15, 16, 17, 31, 32, 33, 63, 64, 65, 4095, 4096, 65535, 131071]

describe('native join byte and ownership boundaries', () => {
    test.each(widths)('preserves self-copy and overlapping shifts at interior width %i', (width) => {
        const value = JSON.stringify(['日🙂', 'x'.repeat(width), '\\"'])
        const texts = ['[]',
            `[${value}]`,
            '[ ]',
            `[${value}]`,
            ` \n[ \t${value}\r ]\n`,
            `[${value}]`,
            '[]']
        const result = join(texts.map((text, i) => source(text, i % 2 === 0 ? 8 : 0)))
        expect(result.length).toBe(encoder.encode(expectedJoin(texts)).length)
        expect(decoder.decode(result.bytes)).toBe(expectedJoin(texts))
    })

    test.each([0, 8])('preserves all CRC tail lengths with compression method %i', (method) => {
        for (let width = 0; width < 64; ++width) {
            const texts = ['[0]', `["${'a'.repeat(width)}"]`, '[1]']
            expect(decoder.decode(join(texts.map((text) => source(text, method))).bytes)).toBe(expectedJoin(texts))
        }
    })

    test('matches an independent oracle over 1,000 deterministic uneven bank layouts', () => {
        let state = 0x91e10da5
        const random = () => {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0
            return state >>> 8
        }
        for (let trial = 0; trial < 1000; ++trial) {
            const count = 1 + random() % 13
            const texts = Array.from({length: count}, () => {
                const values = Array.from({length: random() % 4}, () => ['日本語', '\\', 'q'.repeat(random() % 257)])
                const interior = values.map((value) => JSON.stringify(value)).join(', \n')
                return `${' '.repeat(random() % 17)}[${'\t'.repeat(random() % 9)}${interior} ]\r\n`
            })
            const result = join(texts.map((text) => source(text, random() % 2 === 0 ? 0 : 8)))
            expect(decoder.decode(result.bytes)).toBe(expectedJoin(texts))
        }
    })

    test('keeps independently bounded span output byte-identical after ordinary joins', () => {
        const texts = [' \n[]\t', '["first"]', ' \n[ "last" ]\r']
        const sources = texts.map((text, i) => source(text, i % 2 === 0 ? 8 : 0))
        const ordinary = join(sources)
        const saved = [...ordinary.bytes]
        const result = join(sources, true)
        expect(decoder.decode(result.bytes)).toBe(texts.join(''))
        let offset = 0
        for (const [i, text] of texts.entries()) {
            const length = encoder.encode(text).length
            expect(result.spans.slice(i * 2, i * 2 + 2)).toEqual([offset, length])
            offset += length
        }
        expect(ordinary.bytes).toEqual(saved)
    })

    test.each([0, 8])('validates an in-place later bank before skipping its copy, method %i', (method) => {
        const sources = [source('["first"]', method), source('["second"]', method)]
        sources[1].signature = (sources[1].signature ^ 1) >>> 0
        expect(join(sources).length).toBe(-4)
    })

    test('retains decoded-size, exact-consumption, truncation, array and output bounds checks', () => {
        const stored = source('[0]', 0)
        expect(join([{...stored, decodedBytes: stored.decodedBytes + 1}]).length).toBe(-3)
        const compressed = source('["payload"]', 8)
        const trailing = new Uint8Array(compressed.bytes.length + 1)
        trailing.set(compressed.bytes)
        expect(join([{...compressed, bytes: trailing}]).length).toBe(-6)
        expect(join([{...compressed, bytes: compressed.bytes.slice(0, -1)}]).length).toBe(-2)
        expect(join([source('{}', 0)]).length).toBe(-5)
        expect(join([stored], false, 1).length).toBe(-1)
        expect(join([{...stored, method: 99}]).length).toBe(-1)
        expect(join([]).length).toBe(-1)
    })
})
