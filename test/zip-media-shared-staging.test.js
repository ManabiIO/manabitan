/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {Buffer} from 'node:buffer'
import {readFile} from 'node:fs/promises'
import {crc32, deflateRawSync} from 'node:zlib'
import {beforeAll, describe, expect, test} from 'vitest'
import {inflateCompressedZipMediaBatchWasm, setTermBankWasmModule, validateCompressedZipMediaBatchWasm} from '../ext/js/dictionary/term-bank-wasm-parser.js'

/** @typedef {Parameters<typeof validateCompressedZipMediaBatchWasm>[0][number]} Source */

beforeAll(async () => {
    setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))))
})

/**
 * @param {number} length
 * @returns {Uint8Array}
 */
function content(length) {
    return Uint8Array.from({length}, (_, i) => (i * 17 + (i >>> 8)) & 255)
}

/**
 * @param {Uint8Array} value
 * @param {0|8} compressionMethod
 * @returns {Source}
 */
function source(value, compressionMethod) {
    const bytes = compressionMethod === 0 ? value : Uint8Array.from(deflateRawSync(value, {level: 0}))
    return {bytes, compressionMethod, compressedSize: bytes.length, uncompressedSize: value.length, signature: crc32(value)}
}

/**
 * Real borrowed ZIP batches include local headers between payloads, and can
 * begin at an offset into the bounded range. Neither guard belongs to a file.
 * @param {Source[]} sources
 * @param {number} gap
 * @param {'ordinary'|'shared'|'resizable'} [kind]
 * @returns {Source[]}
 */
function borrow(sources, gap, kind = 'ordinary') {
    const size = 29 + sources.reduce((sum, value) => sum + value.bytes.length + gap, 0)
    /** @type {ArrayBuffer|SharedArrayBuffer} */
    let buffer = new ArrayBuffer(size)
    if (kind === 'shared') { buffer = new SharedArrayBuffer(size) }
    if (kind === 'resizable') { buffer = /** @type {ArrayBuffer} */ (Reflect.construct(ArrayBuffer, [size, {maxByteLength: size + 4096}])) }
    const bytes = new Uint8Array(buffer).fill(0xf7)
    let offset = 11
    return sources.map((value) => {
        bytes.set(value.bytes, offset)
        const result = {...value, bytes: bytes.subarray(offset, offset + value.bytes.length)}
        offset += value.bytes.length + gap
        return result
    })
}

/**
 * Compare validation with independent retained decoding and exact source bytes.
 * @param {Source[]} sources
 * @param {Uint8Array[]} expected
 */
async function verify(sources, expected) {
    const before = sources.map(({bytes}) => Buffer.from(bytes))
    await expect(validateCompressedZipMediaBatchWasm(sources)).resolves.toBeUndefined()
    const result = await inflateCompressedZipMediaBatchWasm(sources)
    expect(result.sources).toHaveLength(expected.length)
    expect(result.compressedBytes).toBe(sources.reduce((sum, value) => sum + value.compressedSize, 0))
    expect(result.uncompressedBytes).toBe(expected.reduce((sum, value) => sum + value.length, 0))
    for (let i = 0; i < expected.length; ++i) {
        expect(Buffer.from(result.sources[i]).equals(expected[i])).toBe(true)
        expect(Buffer.from(sources[i].bytes).equals(before[i])).toBe(true)
    }
}

describe('shared ZIP media input staging', () => {
    test.each([0, 43])('preserves exact mixed-method bytes and offsets with %i-byte gaps', async (gap) => {
        const values = [content(1297), content(0), content(4001), content(771)]
        const sources = values.map((value, i) => source(value, i % 2 === 0 ? 0 : 8))
        await verify(borrow(sources, gap), values)
    })

    test.each(['reverse', 'duplicate', 'separate', 'sparse', 'shared', 'resizable'])('preserves the compact fallback for %s sources', async (layout) => {
        const values = [content(263), content(389)]
        let sources = values.map((value, i) => source(value, i === 0 ? 0 : 8))
        if (layout !== 'separate') { sources = borrow(sources, layout === 'sparse' ? 4096 : 0, layout === 'shared' || layout === 'resizable' ? layout : 'ordinary') }
        if (layout === 'resizable') { expect(Reflect.get(sources[0].bytes.buffer, 'resizable')).toBe(true) }
        if (layout === 'reverse') {
            sources.reverse()
            values.reverse()
        }
        if (layout === 'duplicate') {
            sources = [sources[0], sources[0]]
            values[1] = values[0]
        }
        await verify(sources, values)
    })

    test('keeps the existing input budget when compact payloads fill it but their shared range is larger', async () => {
        const values = [content(2 * 1024 * 1024), content(2 * 1024 * 1024)]
        await verify(borrow(values.map((value) => source(value, 0)), 43), values)
    })

    test('keeps empty shared spans and subsequent calls independent', async () => {
        const values = [content(0), content(0)]
        await verify(borrow(values.map((value) => source(value, 0)), 0), values)
        const next = [content(211), content(311)]
        await verify(borrow(next.map((value) => source(value, 8)), 7), next)
    })

    test.each(['crc-first', 'deflate-first'])('preserves the first failing member for %s shared media', async (order) => {
        const first = source(content(1001), 0)
        first.signature = (first.signature ^ 1) >>> 0
        const second = source(content(1001), 8)
        second.bytes[0] = 7
        const ordered = order === 'crc-first' ? [first, second] : [second, first]
        const sources = borrow(ordered, 43)
        const message = order === 'crc-first' ? 'CRC32' : 'DEFLATE decoding failed'
        await expect(validateCompressedZipMediaBatchWasm(sources)).rejects.toMatchObject({
            name: 'DictionarySourceIntegrityError', message: expect.stringContaining(message),
        })
        await expect(inflateCompressedZipMediaBatchWasm(sources)).rejects.toMatchObject({
            name: 'DictionarySourceIntegrityError', message: expect.stringContaining(message),
        })
        const values = [content(257), content(353)]
        await verify(borrow(values.map((value) => source(value, 8)), 23), values)
    })
})
