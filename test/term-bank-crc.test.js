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
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {crc32, deflateRawSync} from 'node:zlib'
import {afterAll, beforeAll, describe, expect, test} from 'vitest'

/** @typedef {{memory: WebAssembly.Memory, wasm_reset_heap: () => void, wasm_alloc: (size: number) => number, inflate_and_join_term_banks: (...args: number[]) => number, term_bank_crc32_test: (input: number, length: number) => number, term_bank_crc32_combine_test: (first: number, second: number, length: number) => number, term_bank_crc32_shift_test: (crc: number, length: number) => number}} Exports */
/** @type {Exports} */
let wasm
/** @type {string | undefined} */
let outputDirectory
const sourceDirectory = path.resolve('ext/js/dictionary/wasm')

/**
 * @param {string} outputDirectoryPath
 * @returns {{command: string, args: string[]}}
 */
function findCompiler(outputDirectoryPath) {
    const candidates = [
        process.env.MANABITAN_CLANG,
        process.env.CLANG,
        'clang',
        'clang-18',
        'clang-17',
        'zig',
        '/opt/homebrew/opt/llvm/bin/clang',
        '/usr/bin/clang',
        ...(process.platform === 'win32' && process.env.LOCALAPPDATA ?
            (() => {
                const packagesDir = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages')
                if (!existsSync(packagesDir)) { return [] }
                return readdirSync(packagesDir, {withFileTypes: true})
                    .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().startsWith('zig.zig'))
                    .flatMap((entry) => readdirSync(path.join(packagesDir, entry.name), {withFileTypes: true})
                        .filter((version) => version.isDirectory())
                        .map((version) => path.join(packagesDir, entry.name, version.name, 'zig.exe')))
            })() :
[]),
    ].filter((value) => typeof value === 'string' && value.length > 0).map((value) => /** @type {string} */ (value))
    for (const command of candidates) {
        const args = /(^|[\\/])zig(?:\.exe)?$/i.test(command) ? ['cc'] : []
        try {
            execFileSync(command, [...args, '--version'], {stdio: 'ignore'})
            const probeSource = path.join(outputDirectoryPath, 'wasm-compiler-probe.c')
            const probeOutput = path.join(outputDirectoryPath, 'wasm-compiler-probe.wasm')
            writeFileSync(probeSource, 'void probe(void) {}\n', 'utf8')
            execFileSync(command, [...args, '--target=wasm32-freestanding', '-matomics', '-mbulk-memory', '-nostdlib', '-Wl,--no-entry', '-Wl,--shared-memory', '-Wl,--max-memory=4294967296', '-Wl,--export=probe', '-Wl,--strip-all', '-o', probeOutput, probeSource], {stdio: 'ignore'})
            return {command, args}
        } catch { /* Try the next repository-supported compiler. */ }
    }
    throw new Error('No supported wasm compiler found; set MANABITAN_CLANG or CLANG')
}

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
        '-Wl,--export=term_bank_crc32_shift_test',
        '-DTERM_BANK_CRC_TEST',
        '-Wl,--strip-all',
        '-o',
        outputPath,
        path.join(sourceDirectory, 'term-bank-parser.c'),
        path.join(sourceDirectory, 'term-bank-inflate.c')], {stdio: 'inherit'})
    const module = await WebAssembly.compile(readFileSync(outputPath))
    expect(WebAssembly.Module.imports(module)).toEqual([])
    wasm = /** @type {Exports} */ (/** @type {unknown} */ ((await WebAssembly.instantiate(module)).exports))
})

afterAll(() => {
    if (!outputDirectory || !existsSync(outputDirectory)) { return }
    const trashDirectory = path.join(process.env.HOME ?? tmpdir(), '.Trash')
    mkdirSync(trashDirectory, {recursive: true})
    let destination = path.join(trashDirectory, `manabitan-term-bank-crc-${Date.now()}-${process.pid}`)
    while (existsSync(destination)) { destination += '-1' }
    renameSync(outputDirectory, destination)
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
 * Independent bit-at-a-time zero-byte operator used to validate every CRC basis bit.
 * @param {number} crc
 * @param {number} length
 * @returns {number}
 */
function referenceShift(crc, length) {
    for (let i = 0; i < length; ++i) {
        for (let bit = 0; bit < 8; ++bit) {
            crc = (crc >>> 1) ^ ((crc & 1) !== 0 ? 0xedb88320 : 0)
        }
    }
    return crc >>> 0
}

describe('term bank CRC32', () => {
    test('matches published, short, alignment, threshold, and large-buffer vectors', () => {
        expect(candidateCrc(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
        expect(candidateCrc(new Uint8Array())).toBe(0)
        for (let length = 0; length <= 256; ++length) {
            const bytes = randomBytes(length, 0x4d595df4 ^ length)
            expect(candidateCrc(bytes)).toBe(crc32(bytes) >>> 0)
        }
        for (const length of [63, 64, 65, 127, 128, 129, 65535, 65536, 65537, 131071, 131072, 131073, 262143, 262144, 262145, 1048576]) {
            const bytes = randomBytes(length, 0x9e3779b9 ^ length)
            const expected = crc32(bytes) >>> 0
            for (let alignment = 0; alignment < 16; ++alignment) {
                expect(candidateCrc(bytes, alignment)).toBe(expected)
            }
        }
    })

    test('combines independent CRCs for arbitrary split lengths and zero-length suffixes', () => {
        const bytes = randomBytes(1048576, 0x12345678)
        const splits = [0, 1, 2, 15, 16, 63, 64, 65, 255, 256, 4095, 4096, 65535, 65536, 65537, bytes.length]
        const next = makeRandom(0xabcdef01)
        for (let i = 0; i < 96; ++i) { splits.push(next() * 4097 % (bytes.length + 1)) }
        for (const split of splits) {
            const first = bytes.subarray(0, split)
            const second = bytes.subarray(split)
            const combined = wasm.term_bank_crc32_combine_test(crc32(first), crc32(second), second.length) >>> 0
            expect(combined).toBe(crc32(bytes) >>> 0)
            expect(wasm.term_bank_crc32_combine_test(0x12345678, 0xffffffff, 0) >>> 0).toBe(0x12345678)
        }
    })

    test('shifts all 32 CRC basis bits and their complements with the IEEE polynomial', () => {
        for (const length of [0, 1, 2, 3, 15, 16, 64, 65536]) {
            for (let bit = 0; bit < 32; ++bit) {
                const value = (1 << bit) >>> 0
                expect(wasm.term_bank_crc32_shift_test(value, length) >>> 0).toBe(referenceShift(value, length))
                const complement = (~value) >>> 0
                expect(wasm.term_bank_crc32_shift_test(complement, length) >>> 0).toBe(referenceShift(complement, length))
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
            0,
        )
        expect(decode()).toBe(bytes.length)
        values[4] = expectedCrc ^ 1
        expect(decode()).toBe(-4)
    }

    test.each([
        {label: 'small', bytes: new TextEncoder().encode('["日本語","crc"]')},
        {
            label: 'large four-span',
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
