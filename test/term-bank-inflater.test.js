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
import {constants, crc32, deflateRawSync, inflateRawSync} from 'node:zlib'
import {beforeAll, describe, expect, test} from 'vitest'

/** @typedef {{memory: WebAssembly.Memory, wasm_reset_heap: () => void, wasm_alloc: (size: number) => number, inflate_and_join_term_banks: (...args: number[]) => number}} Exports */
/** @type {Exports} */
let wasm
const encoder = new TextEncoder()

beforeAll(async () => {
    const bytes = await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))
    const module = await WebAssembly.compile(bytes)
    expect(WebAssembly.Module.imports(module)).toEqual([])
    wasm = /** @type {Exports} */ (/** @type {unknown} */ ((await WebAssembly.instantiate(module)).exports))
})

/**
 * Exercise the production export, not a parallel implementation. Fill output
 * with nonzero bytes and guard both edges; optionally end input at memory EOF.
 * @param {Uint8Array} compressed
 * @param {Uint8Array} expected
 * @param {{alignment?: number, physicalEnd?: boolean, size?: number, signature?: number}} [options]
 * @returns {{status: number, bytes: Uint8Array}}
 */
function decode(compressed, expected, options = {}) {
    wasm.wasm_reset_heap()
    const size = options.size ?? expected.length
    const meta = wasm.wasm_alloc(20)
    const spans = wasm.wasm_alloc(8)
    const guarded = wasm.wasm_alloc(size + 32)
    const output = guarded + 16
    const allocation = wasm.wasm_alloc(compressed.length + 65536)
    const heap = new Uint8Array(wasm.memory.buffer)
    const input = options.physicalEnd === true ? heap.length - compressed.length : allocation + (options.alignment ?? 0)
    heap.fill(0xcc, allocation, allocation + compressed.length + 65536)
    heap.set(compressed, input)
    heap.fill(0xa5, guarded, output + size + 16)
    new Uint32Array(wasm.memory.buffer, meta, 5).set([0, compressed.length, size, 8, options.signature ?? crc32(expected)])
    const status = wasm.inflate_and_join_term_banks(input, compressed.length, meta, meta + 4, meta + 8, meta + 12, meta + 16, 1, output, size, spans)
    expect([...heap.subarray(guarded, output)]).toEqual(new Array(16).fill(0xa5))
    expect([...heap.subarray(output + size, output + size + 16)]).toEqual(new Array(16).fill(0xa5))
    if (status >= 0) { expect([...new Uint32Array(wasm.memory.buffer, spans, 2)]).toEqual([0, expected.length]) }
    return {status, bytes: Uint8Array.from(heap.subarray(output, output + Math.max(status, 0)))}
}

const sizes = [0, 1, 2, 3, 7, 8, 15, 16, 17, 31, 32, 255, 256, 257, 258, 259, 4095, 4096, 32767, 32768, 65535, 65536, 131073]

describe('full-buffer DEFLATE import backend', () => {
    test.each(sizes)('matches zlib across block types and alignments at length %i', (length) => {
        const bytes = encoder.encode(JSON.stringify(['日🙂', 'abc0123456789'.repeat(Math.ceil(length / 13)).slice(0, length)]))
        for (const options of [{level: 0}, {level: 1}, {level: 6}, {level: 9}, {strategy: constants.Z_FIXED}, {strategy: constants.Z_HUFFMAN_ONLY}]) {
            const compressed = new Uint8Array(deflateRawSync(bytes, options))
            expect(inflateRawSync(compressed).equals(bytes)).toBe(true)
            for (const alignment of [0, 1, 3, 7, 15]) {
                const result = decode(compressed, bytes, {alignment})
                expect(result.status).toBe(bytes.length)
                expect(Buffer.compare(result.bytes, bytes)).toBe(0)
            }
            expect(Buffer.compare(decode(compressed, bytes, {physicalEnd: true}).bytes, bytes)).toBe(0)
        }
    })

    test('requires exact input consumption and expected output size', () => {
        const bytes = encoder.encode('["dictionary"]')
        const compressed = new Uint8Array(deflateRawSync(bytes))
        for (let extra = 1; extra <= 16; ++extra) {
            const trailing = new Uint8Array(compressed.length + extra)
            trailing.set(compressed)
            expect(decode(trailing, bytes).status).toBe(-6)
            expect(decode(trailing, bytes, {physicalEnd: true}).status).toBe(-6)
        }
        expect(decode(compressed, bytes, {size: bytes.length - 1}).status).toBeLessThan(0)
        expect(decode(compressed, bytes, {size: bytes.length + 1}).status).toBe(-3)
        expect(decode(compressed, bytes, {signature: (crc32(bytes) ^ 1) >>> 0}).status).toBe(-4)
    })

    test('rejects every truncated prefix at logical and physical input ends', () => {
        const bytes = encoder.encode('["a repeated dictionary phrase a repeated dictionary phrase"]')
        for (const options of [{level: 0}, {level: 6}, {strategy: constants.Z_FIXED}]) {
            const compressed = new Uint8Array(deflateRawSync(bytes, options))
            for (let end = 0; end < compressed.length; ++end) {
                const prefix = compressed.subarray(0, end)
                expect(decode(prefix, bytes).status).toBeLessThan(0)
                expect(decode(prefix, bytes, {physicalEnd: true}).status).toBeLessThan(0)
            }
        }
    })

    test('rejects reserved block type, stored length mismatch and invalid wrappers', () => {
        const bytes = encoder.encode('[]')
        for (const bad of [[7], [1, 2, 0, 0, 0, 91, 93], [3, 2, 0]]) {
            expect(decode(new Uint8Array(bad), bytes, {physicalEnd: true}).status).toBeLessThan(0)
        }
        const object = encoder.encode('{}')
        expect(decode(new Uint8Array(deflateRawSync(object)), object).status).toBe(-5)
    })

    test('reuses decoder safely across 2,000 mixed valid, corrupted and rejected streams', () => {
        let seed = 0x9e3779b9
        const random = () => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
            return seed >>> 8
        }
        for (let trial = 0; trial < 2000; ++trial) {
            const value = Array.from({length: random() % 513}, () => String.fromCharCode(32 + random() % 90)).join('')
            const bytes = encoder.encode(JSON.stringify([value, value, '日本語']))
            const compressed = new Uint8Array(deflateRawSync(bytes, {level: trial % 10}))
            const valid = decode(compressed, bytes, {alignment: trial % 16, physicalEnd: trial % 7 === 0})
            expect(valid.status).toBe(bytes.length)
            expect(Buffer.compare(valid.bytes, bytes)).toBe(0)
            const mutated = Uint8Array.from(compressed)
            mutated[random() % mutated.length] ^= 1 << (random() % 8)
            const result = decode(mutated, bytes, {physicalEnd: trial % 3 === 0})
            if (result.status >= 0) {
                // Mutating unused padding bits can legitimately preserve a stream.
                expect(Buffer.compare(result.bytes, bytes)).toBe(0)
                expect(inflateRawSync(mutated, {maxOutputLength: bytes.length}).equals(bytes)).toBe(true)
            }
        }
    })
})
