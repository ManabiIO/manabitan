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
import {crc32, deflateRawSync, inflateRawSync} from 'node:zlib'
import {beforeAll, describe, expect, test} from 'vitest'

/** @typedef {{memory: WebAssembly.Memory, wasm_reset_heap: () => void, wasm_alloc: (size: number) => number, inflate_and_join_term_banks: (...args: number[]) => number}} InflateExports */
/** @type {InflateExports} */
let wasm
beforeAll(async () => {
    const module = await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url)))
    wasm = /** @type {InflateExports} */ (/** @type {unknown} */ ((await WebAssembly.instantiate(module)).exports))
})

/**
 * Hand-build a fixed-Huffman block so the match distance/length, including
 * self-overlapping expansion, are known rather than chosen by a compressor.
 * @param {number} distance
 * @param {number} length
 * @param {number} padding
 * @returns {{compressed: Uint8Array, expected: Uint8Array}}
 */
function fixedMatch(distance, length, padding) {
    /** @type {number[]} */
    const output = []
    /** @type {number[]} */
    const compressed = []
    let byte = 0
    let bitCount = 0
    /**
     * @param {number} value
     * @param {number} count
     */
    const bits = (value, count) => {
        for (let i = 0; i < count; ++i) {
            byte |= ((value >>> i) & 1) << bitCount
            if (++bitCount === 8) {
                compressed.push(byte)
                byte = bitCount = 0
            }
        }
    }
    /**
     * @param {number} code
     * @param {number} count
     */
    const codeBits = (code, count) => {
        for (let i = count - 1; i >= 0; --i) { bits(code >>> i, 1) }
    }
    /** @param {number} symbol */
    const symbol = (symbol) => {
        if (symbol <= 143) {
            codeBits(0x30 + symbol, 8)
        } else if (symbol <= 255) {
            codeBits(0x190 + symbol - 144, 9)
        } else if (symbol <= 279) {
            codeBits(symbol - 256, 7)
        } else {
            codeBits(0xc0 + symbol - 280, 8)
        }
    }
    /** @param {number} value */
    const literal = (value) => {
        output.push(value)
        symbol(value)
    }
    bits(3, 3) // Final block, fixed Huffman coding.
    literal(91)
    literal(34)
    for (let i = 0; i < distance + padding; ++i) { literal(97 + i % 26) }
    const bases = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
    const extras = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
    let code = bases.length - 1
    while (length < bases[code]) { --code }
    symbol(257 + code)
    bits(length - bases[code], extras[code])
    code = 29
    const distanceBase = (/** @type {number} */ value) => (value < 4 ? value + 1 : ((2 + (value & 1)) << ((value >>> 1) - 1)) + 1)
    while (distance < distanceBase(code)) { --code }
    codeBits(code, 5)
    bits(distance - distanceBase(code), code < 4 ? 0 : (code >>> 1) - 1)
    for (let i = 0; i < length; ++i) { output.push(output[output.length - distance]) }
    literal(34)
    literal(93)
    symbol(256)
    if (bitCount !== 0) { compressed.push(byte) }
    return {compressed: Uint8Array.from(compressed), expected: Uint8Array.from(output)}
}

/**
 * @param {Uint8Array} compressed
 * @param {Uint8Array} expected
 * @param {{crc?: number, capacity?: number}} [options]
 * @returns {{status: number, output: Uint8Array}}
 */
function inflate(compressed, expected, options = {}) {
    wasm.wasm_reset_heap()
    const input = wasm.wasm_alloc(compressed.length)
    const metadata = wasm.wasm_alloc(24)
    const capacity = options.capacity ?? expected.length + 2
    const output = wasm.wasm_alloc(capacity + 32)
    const heap = new Uint8Array(wasm.memory.buffer)
    heap.set(compressed, input)
    heap.fill(0xa5, output, output + capacity + 32)
    new Uint32Array(wasm.memory.buffer, metadata, 6).set([
        0, compressed.length, expected.length, 8, options.crc ?? crc32(expected),
    ])
    const status = wasm.inflate_and_join_term_banks(
        input,
        compressed.length,
        metadata,
        metadata + 4,
        metadata + 8,
        metadata + 12,
        metadata + 16,
        1,
        output,
        capacity,
    )
    expect([...heap.subarray(output + capacity, output + capacity + 32)]).toEqual(new Array(32).fill(0xa5))
    return {status, output: heap.slice(output, output + Math.max(0, status))}
}

const distances = [1, 2, 3, 4, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 65, 127, 128, 129, 255, 256, 257, 258, 259, 512, 1024, 4096, 32768]
const lengths = [3, 8, 9, 15, 16, 17, 31, 32, 63, 64, 127, 128, 255, 256, 257, 258]
describe('WASM DEFLATE history and bit buffers', () => {
    test.each(distances)('preserves known match distance %i across lengths and alignments', (distance) => {
        for (const length of lengths) {
            for (const padding of [0, 1, 7, 15]) {
                const fixture = fixedMatch(distance, length, padding)
                expect(inflateRawSync(fixture.compressed).equals(Buffer.from(fixture.expected))).toBe(true)
                const result = inflate(fixture.compressed, fixture.expected)
                expect(result.status).toBe(fixture.expected.length)
                expect(Buffer.from(result.output).equals(Buffer.from(fixture.expected))).toBe(true)
            }
        }
    })

    test.each([0, 1, 6, 9])('preserves compressor-produced blocks at level %i', (level) => {
        const text = JSON.stringify([Array.from({length: 4096}, (_, i) => `${i % 37}:日本語と🙂:${'abc'.repeat(i % 19)}`)])
        const expected = new TextEncoder().encode(text)
        const compressed = deflateRawSync(expected, {level})
        const result = inflate(compressed, expected)
        expect(result.status).toBe(expected.length)
        expect(Buffer.from(result.output).equals(Buffer.from(expected))).toBe(true)
    })

    test('still rejects CRC errors, truncated data, and insufficient capacity', () => {
        const {compressed, expected} = fixedMatch(257, 258, 7)
        expect(inflate(compressed, expected, {crc: crc32(expected) ^ 1}).status).toBeLessThan(0)
        expect(inflate(compressed.subarray(0, -2), expected).status).toBeLessThan(0)
        expect(inflate(compressed, expected, {capacity: expected.length}).status).toBeLessThan(0)
    })
})
