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

import {execFileSync} from 'node:child_process'
import {existsSync, mkdirSync, mkdtempSync, readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {crc32, deflateRawSync} from 'node:zlib'
import {afterAll, beforeAll, describe, expect, test} from 'vitest'
import {moveFixtureToTrash} from './util/move-fixture-to-trash.js'
import {findCompiler} from './util/wasm-compiler.js'

/** @typedef {{memory: WebAssembly.Memory, wasm_reset_heap: () => void, wasm_alloc: (size: number) => number, inflate_and_join_term_banks: (...args: number[]) => number, term_bank_crc32_test: (input: number, length: number) => number}} Exports */
/** @type {Exports} */
let wasm
/** @type {string | undefined} */
let outputDirectory
const sourceDirectory = path.resolve('ext/js/dictionary/wasm')
const compilerTimeoutMs = 60_000

beforeAll(async () => {
    outputDirectory = mkdtempSync(path.join(tmpdir(), 'manabitan-term-bank-crc-'))
    const compiler = findCompiler(outputDirectory)
    const outputPath = path.join(outputDirectory, 'term-bank-crc-test.wasm')
    execFileSync(compiler.command, [...compiler.args,
        '--target=wasm32-freestanding',
        '-O3',
        '-matomics',
        '-mbulk-memory',
        '-msimd128',
        '-nostdlib',
        '-Wl,--no-entry',
        '-Wl,--shared-memory',
        '-Wl,--max-memory=4294967296',
        '-Wl,--export=wasm_reset_heap',
        '-Wl,--export=wasm_alloc',
        '-Wl,--export=inflate_and_join_term_banks',
        '-Wl,--export=term_bank_crc32_test',
        '-DTERM_BANK_CRC_TEST',
        '-Wl,--strip-all',
        '-o',
        outputPath,
        path.join(sourceDirectory, 'term-bank-parser.c'),
        path.join(sourceDirectory, 'term-bank-inflate.c')], {stdio: 'inherit', timeout: compilerTimeoutMs})
    const module = await WebAssembly.compile(readFileSync(outputPath))
    expect(WebAssembly.Module.imports(module)).toEqual([])
    wasm = /** @type {Exports} */ (/** @type {unknown} */ ((await WebAssembly.instantiate(module)).exports))
}, 90_000)

afterAll(() => {
    if (!outputDirectory || !existsSync(outputDirectory)) { return }
    const trashDirectory = path.join(process.env.HOME ?? tmpdir(), '.Trash')
    mkdirSync(trashDirectory, {recursive: true})
    let destination = path.join(trashDirectory, `manabitan-term-bank-crc-${Date.now()}-${process.pid}`)
    while (existsSync(destination)) { destination += '-1' }
    moveFixtureToTrash(outputDirectory, destination)
})

/**
 * @param {Uint8Array} bytes
 * @param {number} [alignment]
 * @returns {number}
 */
function writeBytes(bytes, alignment = 0) {
    const base = wasm.wasm_alloc(bytes.length + alignment + 1)
    const pointer = base + alignment
    new Uint8Array(wasm.memory.buffer, pointer, bytes.length).set(bytes)
    return pointer
}

/**
 * @param {number} seed
 * @returns {() => number}
 */
function makeRandom(seed) {
    return () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        return seed >>> 24
    }
}

/**
 * @param {number} length
 * @param {number} seed
 * @returns {Uint8Array}
 */
function randomBytes(length, seed) {
    const next = makeRandom(seed)
    const bytes = new Uint8Array(length)
    for (let i = 0; i < length; ++i) { bytes[i] = next() }
    return bytes
}

/**
 * @param {Uint8Array} bytes
 * @param {number} [alignment]
 * @returns {number}
 */
function candidateCrc(bytes, alignment = 0) {
    wasm.wasm_reset_heap()
    return wasm.term_bank_crc32_test(writeBytes(bytes, alignment), bytes.length) >>> 0
}

describe('term bank CRC32', () => {
    test('matches published, short, alignment, threshold, and large-buffer vectors', () => {
        expect(candidateCrc(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
        expect(candidateCrc(new Uint8Array())).toBe(0)
        for (let length = 0; length <= 256; ++length) {
            const bytes = randomBytes(length, 0x4d595df4 ^ length)
            expect(candidateCrc(bytes)).toBe(crc32(bytes) >>> 0)
        }
        for (const length of [63, 64, 65, 127, 128, 129, 65535, 65536, 65537, 131071, 131072, 131073, 262143, 262144, 262145, 262207, 262208, 262209, 1048576, 1048639]) {
            const bytes = randomBytes(length, 0x9e3779b9 ^ length)
            const expected = crc32(bytes) >>> 0
            for (let alignment = 0; alignment < 16; ++alignment) {
                expect(candidateCrc(bytes, alignment)).toBe(expected)
            }
        }
    })

    test('preserves every braided tail at unaligned and physical memory ends', () => {
        for (let tail = 0; tail < 64; ++tail) {
            const bytes = randomBytes(262144 + tail, 0x81b4e761 ^ tail)
            const expected = crc32(bytes) >>> 0
            for (const alignment of [0, 1, 3, 7]) {
                expect(candidateCrc(bytes, alignment)).toBe(expected)
            }
            wasm.wasm_reset_heap()
            wasm.wasm_alloc(bytes.length)
            const input = wasm.memory.buffer.byteLength - bytes.length
            new Uint8Array(wasm.memory.buffer, input, bytes.length).set(bytes)
            expect(wasm.term_bank_crc32_test(input, bytes.length) >>> 0).toBe(expected)
        }
    })

    /**
     * @param {Uint8Array} bytes
     */
    function expectInflatedCrcFault(bytes) {
        const compressed = new Uint8Array(deflateRawSync(bytes))
        const input = wasm.wasm_alloc(compressed.length)
        const metadata = wasm.wasm_alloc(20)
        const spans = wasm.wasm_alloc(8)
        const output = wasm.wasm_alloc(bytes.length)
        new Uint8Array(wasm.memory.buffer, input, compressed.length).set(compressed)
        const expectedCrc = crc32(bytes) >>> 0
        const values = new Uint32Array(wasm.memory.buffer, metadata, 5)
        values.set([0, compressed.length, bytes.length, 8, expectedCrc])
        const decode = () => wasm.inflate_and_join_term_banks(
            input,
            compressed.length,
            metadata,
            metadata + 4,
            metadata + 8,
            metadata + 12,
            metadata + 16,
            1,
            output,
            bytes.length,
            spans,
        )
        expect(decode()).toBe(bytes.length)
        values[4] = expectedCrc ^ 1
        expect(decode()).toBe(-4)
    }

    test.each([
        {label: 'small', bytes: new TextEncoder().encode('["日本語","crc"]')},
        {
            label: 'large braided',
            bytes: (() => {
                const bytes = new Uint8Array(262144).fill(0x20)
                bytes[0] = 0x5b
                bytes[bytes.length - 1] = 0x5d
                return bytes
            })(),
        },
    ])('rejects a corrupted $label bank CRC after DEFLATE decoding', ({bytes}) => {
        wasm.wasm_reset_heap()
        expectInflatedCrcFault(bytes)
    })
})
