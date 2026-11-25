/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {constants, crc32, deflateRawSync} from 'node:zlib'
import {beforeAll, describe, expect, test} from 'vitest'
import {inflateCompressedZipMediaBatchWasm, setTermBankWasmModule, validateCompressedZipMediaBatchWasm} from '../ext/js/dictionary/term-bank-wasm-parser.js'

/** @typedef {{memory: WebAssembly.Memory, wasm_reset_heap: () => void, wasm_alloc: (size: number) => number, inflate_zip_media_batch: (...args: number[]) => number}} MediaWasm */
/** @typedef {Parameters<typeof validateCompressedZipMediaBatchWasm>[0][number]} Source */

/** @type {MediaWasm} */
let wasm

beforeAll(async () => {
    const module = await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url)))
    wasm = /** @type {MediaWasm} */ ((await WebAssembly.instantiate(module)).exports)
    setTermBankWasmModule(module)
})

/**
 * @param {number} length
 * @returns {Uint8Array}
 */
function payload(length) {
    return Uint8Array.from({length}, (_, i) => (i * 31 + (i >>> 7)) & 255)
}

/**
 * @param {Uint8Array} content
 * @param {0|8} compressionMethod
 * @param {import('node:zlib').ZlibOptions} [options]
 * @returns {Source}
 */
function source(content, compressionMethod, options) {
    const data = compressionMethod === 0 ? content : deflateRawSync(content, options)
    // Real raw ZIP reads can return payload views with nonzero byte offsets.
    const backing = new Uint8Array(data.length + 29).fill(0xe7)
    backing.set(data, 11)
    return {
        bytes: backing.subarray(11, 11 + data.length),
        compressionMethod,
        compressedSize: data.length,
        uncompressedSize: content.length,
        signature: crc32(content),
    }
}

/**
 * Build the full 16-bit stored-block boundary explicitly; zlib may choose to
 * split even an admissible 65,535-byte payload across multiple blocks.
 * @param {Uint8Array} content
 * @returns {Source}
 */
function singleStoredBlock(content) {
    const value = source(content, 0)
    const bytes = new Uint8Array(content.length + 5)
    const header = new DataView(bytes.buffer)
    bytes[0] = 1
    header.setUint16(1, content.length, true)
    header.setUint16(3, content.length ^ 0xffff, true)
    bytes.set(content, 5)
    return {...value, bytes, compressedSize: bytes.length, compressionMethod: 8}
}

/**
 * Exercise the native ABI with discontiguous inputs and guarded scratch. A
 * validation call must preserve input bytes and never write past that scratch.
 * @param {Source[]} sources
 * @param {number} capacity
 * @param {{retain?: boolean, mutate?: (metadata: Uint32Array, offsets: Uint32Array) => void}} [options]
 * @returns {{status: number, scratch: Uint8Array, offsets: number[]}}
 */
function runNative(sources, capacity, {retain = false, mutate} = {}) {
    wasm.wasm_reset_heap()
    const count = sources.length
    const inputLength = 7 + sources.reduce((sum, value) => sum + value.bytes.length + 3, 0)
    const input = wasm.wasm_alloc(inputLength)
    const metadata = wasm.wasm_alloc(Math.max(4, count * 5 * 4))
    const outputOffsets = wasm.wasm_alloc(Math.max(4, count * 4))
    const guarded = wasm.wasm_alloc(capacity + 32)
    const memory = new Uint8Array(wasm.memory.buffer)
    const table = new Uint32Array(wasm.memory.buffer, metadata, count * 5)
    const offsets = new Uint32Array(wasm.memory.buffer, outputOffsets, count)
    memory.fill(0xa5, guarded, guarded + capacity + 32)
    memory.fill(0x3c, input, input + inputLength)
    let cursor = 7
    for (let i = 0; i < count; ++i) {
        const value = sources[i]
        memory.set(value.bytes, input + cursor)
        table[i] = cursor
        table[count + i] = value.compressedSize
        table[count * 2 + i] = value.uncompressedSize
        table[count * 3 + i] = value.compressionMethod
        table[count * 4 + i] = value.signature
        cursor += value.bytes.length + 3
    }
    mutate?.(table, offsets)
    const inputBefore = memory.slice(input, input + inputLength)
    const status = wasm.inflate_zip_media_batch(
        input,
        inputLength,
        metadata,
        metadata + count * 4,
        metadata + count * 8,
        metadata + count * 12,
        metadata + count * 16,
        count,
        guarded + 16,
        capacity,
        retain ? outputOffsets : 0,
    )
    expect(memory.slice(input, input + inputLength)).toEqual(inputBefore)
    expect(memory.slice(guarded, guarded + 16)).toEqual(new Uint8Array(16).fill(0xa5))
    expect(memory.slice(guarded + 16 + capacity, guarded + 32 + capacity)).toEqual(new Uint8Array(16).fill(0xa5))
    return {status, scratch: memory.slice(guarded + 16, guarded + 16 + capacity), offsets: [...offsets]}
}

describe('ZIP media validation scratch', () => {
    test.each([0, 1, 15, 16, 17, 31, 32, 33, 65535])('validates stored payloads of %i bytes without output space', async (length) => {
        const content = payload(length)
        const stored = source(content, 0)
        const deflated = singleStoredBlock(content)
        expect(runNative([stored, deflated], 0).status).toBe(length * 2)
        const unused = runNative([stored, deflated], 19)
        expect(unused.status).toBe(length * 2)
        expect(unused.scratch).toEqual(new Uint8Array(19).fill(0xa5))
        await expect(validateCompressedZipMediaBatchWasm([stored, deflated])).resolves.toBeUndefined()
    })

    test.each(Array.from({length: 32}, (_, value) => value))('accepts ignored stored-block padding bits %i', (padding) => {
        const value = singleStoredBlock(payload(37))
        value.bytes[0] = 1 | (padding << 3)
        expect(runNative([value], 0).status).toBe(value.uncompressedSize)
    })

    test('reuses one scratch span across mixed stored, fixed, dynamic, and multiple-block sources', async () => {
        const contents = [payload(73), payload(23_179), payload(90_000), payload(44_017), payload(99)]
        const sources = [
            source(contents[0], 0),
            source(contents[1], 8, {strategy: constants.Z_FIXED}),
            source(contents[2], 8, {level: 0}),
            source(contents[3], 8, {level: 6}),
            source(contents[4], 8, {level: 0}),
        ]
        const total = contents.reduce((sum, value) => sum + value.length, 0)
        const validation = runNative(sources, Math.max(...contents.map((value) => value.length)))
        expect(validation.status).toBe(total)
        expect(validation.scratch.subarray(0, contents[3].length)).toEqual(contents[3])
        const decoded = runNative(sources, total, {retain: true})
        expect(decoded.status).toBe(total)
        for (let i = 0; i < contents.length; ++i) {
            expect(decoded.scratch.subarray(decoded.offsets[i], decoded.offsets[i] + contents[i].length)).toEqual(contents[i])
        }
        await expect(validateCompressedZipMediaBatchWasm(sources)).resolves.toBeUndefined()
        expect((await inflateCompressedZipMediaBatchWasm(sources)).sources).toEqual(contents)
    })

    test('rejects insufficient scratch for general DEFLATE without touching its guards', () => {
        const value = source(new Uint8Array(100).fill(9), 8)
        expect(runNative([value], 99).status).toBe(-1)
        expect(runNative([value], 100).status).toBe(100)
    })

    test.each([
        {name: 'checksum', mutate: (/** @type {Source} */ value) => { value.signature = (value.signature + 1) >>> 0 }},
        {name: 'decoded length', mutate: (/** @type {Source} */ value) => { ++value.uncompressedSize }},
        {name: 'decoded length too small', mutate: (/** @type {Source} */ value) => { --value.uncompressedSize }},
        {name: 'stored LEN', mutate: (/** @type {Source} */ value) => { value.bytes[1] ^= 1 }},
        {name: 'stored NLEN', mutate: (/** @type {Source} */ value) => { value.bytes[3] ^= 1 }},
        {name: 'unfinished block', mutate: (/** @type {Source} */ value) => { value.bytes[0] &= 0xfe }},
        {name: 'invalid block type', mutate: (/** @type {Source} */ value) => { value.bytes[0] = 7 }},
        {name: 'truncated bytes', mutate: (/** @type {Source} */ value) => { value.bytes = value.bytes.subarray(0, --value.compressedSize) }},
        {
            name: 'trailing bytes',
            mutate: (/** @type {Source} */ value) => {
                const bytes = new Uint8Array(value.bytes.length + 1)
                bytes.set(value.bytes)
                value.bytes = bytes
                ++value.compressedSize
            },
        },
    ])('preserves inflater errors for corrupt stored DEFLATE: $name', async ({mutate}) => {
        const value = singleStoredBlock(payload(127))
        mutate(value)
        const ordinary = runNative([value], value.uncompressedSize, {retain: true})
        expect(ordinary.status).toBeLessThan(0)
        expect(runNative([value], value.uncompressedSize).status).toBe(ordinary.status)
        await expect(validateCompressedZipMediaBatchWasm([value])).rejects.toMatchObject({name: 'DictionarySourceIntegrityError'})
    })

    test.each([0, 8])('rejects checksum corruption after a valid source (method=%i)', async (method) => {
        const first = source(payload(17), 0)
        const bad = source(payload(37), /** @type {0|8} */ (method), {level: 0})
        bad.bytes[bad.bytes.length - 1] ^= 1
        expect(runNative([first, bad], 0).status).toBe(-4)
        await expect(validateCompressedZipMediaBatchWasm([first, bad])).rejects.toThrow('CRC32')
    })

    test.each([
        {name: 'offset outside input', mutate: (/** @type {Uint32Array} */ table) => { table[0] = 0xffffffff }},
        {name: 'span beyond input', mutate: (/** @type {Uint32Array} */ table) => { table[1] = 0xffffffff }},
        {name: 'decoded total overflow', mutate: (/** @type {Uint32Array} */ table) => { table[2] = 0xffffffff }},
        {name: 'unsupported method', mutate: (/** @type {Uint32Array} */ table) => { table[3] = 9 }},
    ])('rejects invalid native descriptors: $name', ({mutate}) => {
        expect(runNative([source(payload(17), 0)], 0, {mutate}).status).toBe(-1)
    })

    test('keeps metadata and aggregate decoded-byte admission bounds for validation', async () => {
        await expect(validateCompressedZipMediaBatchWasm([])).rejects.toThrow('empty')
        const empty = source(new Uint8Array(0), 0)
        await expect(validateCompressedZipMediaBatchWasm(Array.from({length: 1024}, () => empty))).resolves.toBeUndefined()
        await expect(validateCompressedZipMediaBatchWasm(Array.from({length: 1025}, () => empty))).rejects.toThrow('source count budget')
        await expect(validateCompressedZipMediaBatchWasm([{...empty, compressedSize: 1}])).rejects.toThrow('metadata is invalid')
        const one = source(payload(1024 * 1024 + 1), 8)
        await expect(validateCompressedZipMediaBatchWasm([one, one, one, one])).rejects.toThrow('memory budget')
    })
})
