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

/** @typedef {{memory: WebAssembly.Memory, wasm_reset_heap: () => void, wasm_alloc: (size: number) => number, inflate_and_join_term_banks: (...args: number[]) => number, term_bank_crc32_test: (input: number, length: number) => number, term_bank_crc32_combine_test: (first: number, second: number, length: number) => number}} Exports */
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
        '-Wl,--export=term_bank_crc32_combine_test',
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

/**
 * Apply an independent GF(2) matrix, whose columns are CRC states for single bits.
 * @param {Uint32Array} matrix
 * @param {number} vector
 * @returns {number}
 */
function matrixTimes(matrix, vector) {
    let result = 0
    for (let bit = 0; vector !== 0; vector >>>= 1, ++bit) {
        if ((vector & 1) !== 0) { result ^= matrix[bit] }
    }
    return result >>> 0
}

/**
 * @param {Uint32Array} matrix
 * @returns {Uint32Array}
 */
function matrixSquare(matrix) {
    return Uint32Array.from(matrix, (column) => matrixTimes(matrix, column))
}

describe('term bank CRC32', () => {
    test('combines exact source spans with the independent zlib CRC', () => {
        const first = randomBytes(8192, 0x51a73b92)
        for (const length of [0, 1, 2, 3, 4, 7, 8, 15, 16, 17, 31, 32, 63, 64, 255, 256, 257, 511, 512, 1023, 1024, 65535, 65536, 1048577]) {
            const second = randomBytes(length, 0x4d595df4 ^ length)
            for (const prefix of [0, 1, 13, 256, first.length]) {
                const firstCrc = crc32(first.subarray(0, prefix))
                expect(wasm.term_bank_crc32_combine_test(firstCrc, crc32(second), length) >>> 0)
                    .toBe(crc32(second, firstCrc))
            }
        }
    })

    test('matches an independent matrix shift for every length bit and uint32 boundary', () => {
        const oneBit = new Uint32Array(32)
        oneBit[0] = 0xedb88320
        for (let bit = 1; bit < 32; ++bit) { oneBit[bit] = 2 ** (bit - 1) }
        const bytePowers = [matrixSquare(matrixSquare(matrixSquare(oneBit)))]
        for (let bit = 1; bit < 32; ++bit) { bytePowers.push(matrixSquare(bytePowers[bit - 1])) }
        const lengths = new Set([0, 0xffffffff, 0xfffffffe, 0x80000001, 0xabcdef01, 0x12345678])
        for (let bit = 0; bit < 32; ++bit) {
            lengths.add(2 ** bit)
            lengths.add(2 ** bit - 1)
        }
        for (const length of lengths) {
            for (const first of [0, 1, 0x80000000, 0xffffffff, 0x13579bdf, 0xcbf43926]) {
                let shifted = first
                for (let remaining = length >>> 0, bit = 0; remaining !== 0; remaining >>>= 1, ++bit) {
                    if ((remaining & 1) !== 0) { shifted = matrixTimes(bytePowers[bit], shifted) }
                }
                for (const second of [0, 0xffffffff, 0xa55a12ef]) {
                    expect(wasm.term_bank_crc32_combine_test(first, second, length) >>> 0)
                        .toBe((shifted ^ second) >>> 0)
                }
            }
        }
    })

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
