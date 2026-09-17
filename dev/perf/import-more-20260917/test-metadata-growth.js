/*
 * Copyright (C) 2026  Yomitan Authors
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
import {createHash} from 'node:crypto'
import {beforeAll, describe, expect, test} from 'vitest'

/** @typedef {{memory: WebAssembly.Memory, wasm_reset_heap: () => void, wasm_alloc: (size: number) => number, wasm_get_last_parse_capacity: () => number, parse_term_bank: (...args: number[]) => number, parse_term_bank_with_media_hints: (...args: number[]) => number}} Native */
/** @type {Native} */
let wasm
const encoder = new TextEncoder()
/** @param {Uint8Array} bytes @returns {string} */
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

beforeAll(async () => {
    const module = await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url)))
    expect(WebAssembly.Module.imports(module)).toEqual([])
    wasm = /** @type {Native} */ (/** @type {unknown} */ ((await WebAssembly.instantiate(module)).exports))
})

/**
 * @param {number} count
 * @param {boolean} spans
 * @returns {Uint8Array[]}
 */
function sources(count, spans) {
    const entries = Array.from({length: count}, (_, i) => JSON.stringify([`head${i % 7}`, '読み', 'tag', '', i % 31 - 15, ['definition', {type: 'structured-content', content: {tag: 'span', content: '日本語'}}], i, 'term']))
    const banks = spans ? [entries.slice(0, Math.floor(count / 2)), entries.slice(Math.floor(count / 2))] : [entries]
    return banks.map((bank) => encoder.encode(`[${bank.join(',')}]`))
}

/**
 * @param {Uint8Array[]} banks
 * @param {number} initial
 * @param {boolean} hints
 * @param {boolean} spans
 * @param {boolean} [blocked]
 * @returns {{status: number, capacity: number, digest: string, heapBytes: number}}
 */
function parse(banks, initial, hints, spans, blocked = false) {
    wasm.wasm_reset_heap()
    const total = banks.reduce((sum, bytes) => sum + bytes.length, 0)
    const input = wasm.wasm_alloc(total)
    const spansPtr = spans ? wasm.wasm_alloc(banks.length * 8) : 0
    const guard = wasm.wasm_alloc(16)
    const output = wasm.wasm_alloc(initial * 68)
    const blocker = blocked ? wasm.wasm_alloc(16) : 0
    expect(input).toBeGreaterThan(0)
    expect(output).toBeGreaterThan(0)
    let heap = new Uint8Array(wasm.memory.buffer)
    heap.fill(0xa7, guard, guard + 16)
    if (blocked) { heap.fill(0xb5, blocker, blocker + 16) }
    let offset = 0
    for (const [index, bank] of banks.entries()) {
        heap.set(bank, input + offset)
        if (spans) { new Uint32Array(wasm.memory.buffer, spansPtr + index * 8, 2).set([offset, bank.length]) }
        offset += bank.length
    }
    const sourceHash = hash(heap.subarray(input, input + total))
    const status = (hints ? wasm.parse_term_bank_with_media_hints : wasm.parse_term_bank)(input, total, output, initial, spansPtr, spans ? banks.length : 0)
    heap = new Uint8Array(wasm.memory.buffer)
    expect(hash(heap.subarray(input, input + total))).toBe(sourceHash)
    expect([...heap.subarray(guard, guard + 16)]).toEqual(new Array(16).fill(0xa7))
    if (blocked) { expect([...heap.subarray(blocker, blocker + 16)]).toEqual(new Array(16).fill(0xb5)) }
    const capacity = wasm.wasm_get_last_parse_capacity()
    if (status >= 0) {
        expect(capacity).toBeGreaterThanOrEqual(status)
        const next = wasm.wasm_alloc(8)
        expect(next).toBe(output + Math.ceil(capacity * 68 / 8) * 8)
    }
    return {status, capacity, digest: status < 0 ? '' : hash(heap.subarray(output, output + status * 68)), heapBytes: heap.byteLength}
}

const modes = [
    {hints: false, spans: false}, {hints: false, spans: true},
    {hints: true, spans: false}, {hints: true, spans: true},
]

describe('aligned metadata slab growth', () => {
    for (const {hints, spans} of modes) {
        test.each([1, 8193, 10000])(`grows through odd row capacities, hints=${hints}, spans=${spans}, initial=%i`, (initial) => {
            const count = initial === 10000 ? 100000 : initial + 1
            const banks = sources(count, spans)
            const reference = parse(banks, count, hints, spans)
            expect(reference.status).toBe(count)
            const result = parse(banks, initial, hints, spans)
            expect(result.status).toBe(count)
            expect(result.digest).toBe(reference.digest)
        })
        test(`refuses to extend over another allocation, hints=${hints}, spans=${spans}`, () => {
            const result = parse(sources(3, spans), 1, hints, spans, true)
            expect(result.status).toBe(-2)
            expect(result.capacity).toBe(1)
        })
    }
    test('crosses repeated odd/even growth steps without changing metadata', () => {
        const banks = sources(140000, false)
        const reference = parse(banks, 140000, true, false)
        const result = parse(banks, 10000, true, false)
        expect(result.status).toBe(140000)
        expect(result.digest).toBe(reference.digest)
        expect(result.heapBytes).toBeLessThan(128 * 1024 * 1024)
    })
    test('preserves malformed-input rejection and reusable arena state', () => {
        const bad = encoder.encode('[["a","","","",0,["x"],0,""],]')
        expect(parse([bad], 2, true, false).status).toBe(-1)
        const banks = sources(2, false)
        expect(parse(banks, 1, true, false).digest).toBe(parse(banks, 2, true, false).digest)
    })
})
