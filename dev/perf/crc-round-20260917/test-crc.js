/*
 * Copyright (C) 2026  Manabitan authors
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
import {crc32, deflateRawSync, constants} from 'node:zlib'
import {beforeAll, describe, expect, test} from 'vitest'
import {snapshotTermBankExperiments} from '../ext/js/dictionary/term-bank-experiments.js'
import {inflateCompressedTermBankSourcesWasm, setTermBankWasmModule} from '../ext/js/dictionary/term-bank-wasm-parser.js'

/** @typedef {import('dictionary-importer').ImportExperiments} Experiments */
/** @typedef {{memory: WebAssembly.Memory, wasm_reset_heap: () => void, wasm_alloc: (size: number) => number, inflate_and_join_term_banks: (...args: number[]) => number}} Exports */
/** @type {Exports} */
let wasm
/** @type {Array<[keyof Experiments, number]>} */
const candidates = Object.entries({experimentalCrcSlicing16: 16, experimentalCrcSlicing32: 32, experimentalCrcBraided16: 64})
    .filter(([key]) => Object.hasOwn(snapshotTermBankExperiments(), key))
    .map(([key, value]) => [/** @type {keyof Experiments} */ (key), value])
const encoder = new TextEncoder()
beforeAll(async () => {
    const module = await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url)))
    expect(WebAssembly.Module.imports(module)).toEqual([])
    wasm = /** @type {Exports} */ (/** @type {unknown} */ ((await WebAssembly.instantiate(module)).exports))
    setTermBankWasmModule(module)
    expect(candidates.length).toBeGreaterThan(0)
})

/**
 * @param {Uint8Array} decoded
 * @param {number} mode
 * @param {{method?: number, backend?: number, signature?: number, physicalEnd?: string, alignment?: number, compression?: import('node:zlib').ZlibOptions}} [options]
 * @returns {number}
 */
function run(decoded, mode, options = {}) {
    wasm.wasm_reset_heap()
    const method = options.method ?? 0
    const compressed = method === 0 ? decoded : new Uint8Array(deflateRawSync(decoded, options.compression))
    const meta = wasm.wasm_alloc(20)
    const spans = wasm.wasm_alloc(8)
    let output = wasm.wasm_alloc(decoded.length + 32) + 16
    let input = wasm.wasm_alloc(compressed.length + 32) + (options.alignment ?? 0)
    if (options.physicalEnd === 'source') {
        wasm.wasm_alloc(compressed.length + 65536)
        input = wasm.memory.buffer.byteLength - compressed.length
    }
    if (options.physicalEnd === 'output') {
        wasm.wasm_alloc(decoded.length + 65536)
        output = wasm.memory.buffer.byteLength - decoded.length
    }
    const heap = new Uint8Array(wasm.memory.buffer)
    heap.fill(0xa5, output - 16, Math.min(output + decoded.length + 16, heap.length))
    heap.set(compressed, input)
    new Uint32Array(heap.buffer, meta, 5).set([0, compressed.length, decoded.length, method, options.signature ?? crc32(decoded)])
    const status = wasm.inflate_and_join_term_banks(input, compressed.length, meta, meta + 4, meta + 8, meta + 12, meta + 16, 1, output, decoded.length, spans, options.backend ?? 0, mode)
    expect([...heap.subarray(output - 16, output)]).toEqual(new Array(16).fill(0xa5))
    if (options.physicalEnd !== 'output') {
        expect([...heap.subarray(output + decoded.length, output + decoded.length + 16)]).toEqual(new Array(16).fill(0xa5))
    }
    if (status >= 0) {
        expect(status).toBe(decoded.length)
        expect(Buffer.compare(heap.subarray(output, output + decoded.length), decoded)).toBe(0)
    }
    return status
}

/** @param {number} length @returns {Uint8Array} */
function makeData(length) {
    const bytes = new Uint8Array(length)
    let seed = 0x43524332
    for (let i = 0; i < length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        bytes[i] = seed >>> 24
    }
    bytes[0] = 91
    bytes[length - 1] = 93
    return bytes
}

describe('complete-bank CRC experiments', () => {
    test.each(candidates)('%s defaults off and only literal true enables it', (key) => {
        expect(snapshotTermBankExperiments()[key]).toBe(false)
        for (const value of [false, 0, 1, null, undefined, 'true', {}]) {
            const input = /** @type {Experiments} */ (/** @type {unknown} */ ({[key]: value}))
            expect(snapshotTermBankExperiments(input)[key]).toBe(false)
        }
        expect(snapshotTermBankExperiments({[key]: true})[key]).toBe(true)
    })
    test.each(candidates)('%s checks every byte across block tails and alignments', (_key, mode) => {
        const sizes = [...Array.from({length: 64}, (_, i) => i + 2), 127, 128, 129, 255, 256, 257, 1023, 1024, 1025, 4095, 4096, 4097, 65535, 65536, 65537]
        for (const size of sizes) {
            const bytes = makeData(size)
            for (const alignment of [0, 1, 3, 7, 15]) {
                expect(run(bytes, mode, {alignment})).toBe(size)
            }
            expect(run(bytes, mode, {physicalEnd: 'source'})).toBe(size)
            expect(run(bytes, mode, {physicalEnd: 'output'})).toBe(size)
            expect(run(bytes, mode, {signature: (crc32(bytes) ^ 1) >>> 0})).toBe(-4)
        }
    })
    test.each(candidates)('%s detects a mutation in each byte position and recovers', (_key, mode) => {
        const bytes = makeData(1031)
        const signature = crc32(bytes)
        for (let i = 1; i < bytes.length - 1; i++) {
            bytes[i] ^= 1 << (i % 8)
            expect(run(bytes, mode, {signature})).toBe(-4)
            bytes[i] ^= 1 << (i % 8)
        }
        for (const selected of [mode, 0, 0, mode]) {
            expect(run(bytes, selected, {signature})).toBe(bytes.length)
        }
    })
    test.each(candidates)('%s preserves both DEFLATE backends and all block types', (_key, mode) => {
        for (const backend of [0, 1]) {
            for (const compression of [{level: 0}, {level: 1}, {level: 6}, {level: 9}, {strategy: constants.Z_FIXED}, {strategy: constants.Z_HUFFMAN_ONLY}]) {
                const bytes = encoder.encode(JSON.stringify(['日本語', 'abcd'.repeat(32771)]))
                expect(run(bytes, mode, {method: 8, backend, compression, physicalEnd: 'source'})).toBe(bytes.length)
                expect(run(bytes, mode, {method: 8, backend, compression, signature: (crc32(bytes) ^ 1) >>> 0})).toBe(-4)
            }
        }
    })
    test.each(candidates)('%s reaches the real wrapper with per-call isolation', async (key) => {
        const data = [encoder.encode('["日本語",123]'), encoder.encode('["tail"]')]
        const sources = data.map((bytes) => ({bytes: new Uint8Array(deflateRawSync(bytes)), compressionMethod: 8, compressedSize: deflateRawSync(bytes).length, uncompressedSize: bytes.length, signature: crc32(bytes)}))
        for (const experimentalLibdeflate of [false, true]) {
            for (const experimentalTermBankSpans of [false, true]) {
                let original
                for (const active of [false, true, true, false]) {
                    const result = await inflateCompressedTermBankSourcesWasm(sources, {[key]: active, experimentalLibdeflate, experimentalTermBankSpans})
                    const bytes = Uint8Array.from(new Uint8Array(result.wasm.memory.buffer, result.jsonPtr, result.jsonLength))
                    if (typeof original === 'undefined') { original = bytes }
                    expect(bytes).toEqual(original)
                }
                await expect(inflateCompressedTermBankSourcesWasm([{...sources[0], signature: 0}], {[key]: true, experimentalLibdeflate, experimentalTermBankSpans})).rejects.toThrow('CRC32')
            }
        }
    })
})
