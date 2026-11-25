/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {crc32} from 'node:zlib'
import {beforeAll, describe, expect, test} from 'vitest'

const encoder = new TextEncoder()
/** @type {WebAssembly.Module} */
let module

beforeAll(async () => {
    module = await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url)))
})

/**
 * Exercise the verifier ABI directly so malformed metadata cannot be hidden by
 * a successful parser. These banks contain glossary values rather than rows;
 * the verifier consumes only their exact source ranges and prior witnesses.
 * @param {string[][]} values
 * @param {number[]} witnessValues
 * @returns {Promise<{verify: () => number|undefined, metas: Uint32Array, rows: {start: number, length: number}[], stats: Uint32Array, witnesses: Uint32Array, signatures: Uint32Array, heap: Uint8Array, jsonPtr: number, totalLength: number}>}
 */
async function fixture(values, witnessValues) {
    const instance = await WebAssembly.instantiate(module)
    const wasm = /** @type {import('../ext/js/dictionary/term-bank-wasm-parser.js').TermBankWasmExports} */ (instance.exports)
    /** @type {{start: number, length: number}[]} */
    const rows = []
    let totalLength = 0
    const banks = values.map((bank) => {
        let text = '[\n'
        for (const value of bank) {
            if (text.length > 2) { text += ', ' }
            const start = totalLength + encoder.encode(text).length
            rows.push({start, length: encoder.encode(value).length})
            text += value
        }
        text += '\n]\t'
        const bytes = encoder.encode(text)
        totalLength += bytes.length
        return bytes
    })
    expect(rows.length).toBe(witnessValues.length)
    const jsonPtr = wasm.wasm_alloc(totalLength)
    const spansPtr = wasm.wasm_alloc(banks.length * 8)
    const signaturesPtr = wasm.wasm_alloc(banks.length * 4)
    const metasPtr = wasm.wasm_alloc(Math.max(1, rows.length) * 17 * 4)
    const witnessesPtr = wasm.wasm_alloc(Math.max(1, rows.length) * 4)
    const statsPtr = wasm.wasm_alloc(12)
    const heap = new Uint8Array(wasm.memory.buffer)
    const spans = new Uint32Array(wasm.memory.buffer, spansPtr, banks.length * 2)
    const signatures = new Uint32Array(wasm.memory.buffer, signaturesPtr, banks.length)
    let start = 0
    for (const [index, bytes] of banks.entries()) {
        heap.set(bytes, jsonPtr + start)
        spans.set([start, bytes.length], index * 2)
        signatures[index] = crc32(bytes)
        start += bytes.length
    }
    const metas = new Uint32Array(wasm.memory.buffer, metasPtr, rows.length * 17)
    for (const [index, row] of rows.entries()) { metas.set([row.start, row.length], index * 17 + 9) }
    const witnesses = new Uint32Array(wasm.memory.buffer, witnessesPtr, rows.length)
    witnesses.set(witnessValues)
    const stats = new Uint32Array(wasm.memory.buffer, statsPtr, 3)
    const verify = () => wasm.verify_term_bank_source_crcs?.(jsonPtr, totalLength, spansPtr, banks.length, signaturesPtr, metasPtr, rows.length, witnessesPtr, statsPtr)
    return {verify, metas, rows, stats, witnesses, signatures, heap, jsonPtr, totalLength}
}

describe('contiguous unique source CRC runs', () => {
    test('preserves chained and interleaved roots across empty banks and long unique gaps', async () => {
        const long = JSON.stringify(['日本語'.repeat(40000)])
        const first = JSON.stringify(['first glossary'.repeat(80)])
        const second = JSON.stringify(['second glossary'.repeat(90)])
        const value = await fixture(
            [[long, first, second, first, second, first], [], [first, long, second]],
            [-1, -1, -1, 1, 2, 3, 5, -1, 4],
        )
        expect(value.verify()).toBe(0)
        expect([...value.stats]).toEqual([
            value.totalLength - 3 * encoder.encode(first).length - 2 * encoder.encode(second).length,
            3 * encoder.encode(first).length + 2 * encoder.encode(second).length,
            5,
        ])
    })

    test.each([15, 16, 17, 262143, 262144, 262145])('matches independent CRC with a %i-byte unique run after a reused root', async (length) => {
        const repeated = JSON.stringify(['same'])
        // The continued scan includes a two-byte separator and three-byte bank
        // tail, in addition to the four-byte JSON array/string envelope.
        const unique = JSON.stringify(['x'.repeat(length - 9)])
        expect(encoder.encode(`, ${unique}\n]\t`).length).toBe(length)
        const value = await fixture([[repeated, repeated, unique], [unique]], [-1, 0, -1, -1])
        expect(value.verify()).toBe(0)
        expect(value.stats[1]).toBe(encoder.encode(repeated).length)
        expect(value.stats[2]).toBe(1)
    })

    test('scans every byte when no glossary has a witness', async () => {
        const value = await fixture([[JSON.stringify(['a'.repeat(300000)]), '["short"]'], [], ['["last"]']], [-1, -1, -1])
        expect(value.verify()).toBe(0)
        expect([...value.stats]).toEqual([value.totalLength, 0, 0])
    })

    test.each(['overlap', 'backward', 'zero-length', 'cross-bank'])('rejects %s unique metadata even when a whole-source CRC would match', async (kind) => {
        const value = await fixture([['["first"]', '["second"]'], ['["last"]']], [-1, -1, -1])
        if (kind === 'overlap') { value.metas[17 + 9] = value.rows[0].start + 1 }
        if (kind === 'backward') { value.metas[17 + 9] = value.rows[0].start - 1 }
        if (kind === 'zero-length') { value.metas[17 + 10] = 0 }
        if (kind === 'cross-bank') { value.metas[17 + 10] = value.totalLength - value.rows[1].start }
        expect(value.verify()).toBe(-1)
    })

    test.each(['future', 'different-length'])('rejects a %s raw witness', async (kind) => {
        const value = await fixture([['["first"]', '["second"]']], [-1, kind === 'future' ? 1 : 0])
        expect(value.verify()).toBe(-1)
    })

    test('does not omit unreferenced source bytes from CRC verification', async () => {
        const value = await fixture([['["first"]', '["second"]'], ['["first"]']], [-1, -1, 0])
        value.heap[value.jsonPtr + value.rows[1].start + 2] ^= 1
        expect(value.verify()).toBe(-4)
    })
})
