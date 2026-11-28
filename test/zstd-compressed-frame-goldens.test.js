/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {readFile} from 'node:fs/promises'
import {afterAll, beforeAll, describe, expect, test} from 'vitest'

import createZstdModule from '../dev/lib/zstd-simd-module.js'
import {createRawZstdFrameDictionary, createZstdFrameInput} from './util/zstd-frame-cases.js'

/** @typedef {import('./util/zstd-frame-cases.js').ZstdFrameCase} ZstdFrameCase */
/** @typedef {import('../dev/lib/zstd-simd-module.js').ZstdModule} ZstdModule */

// These expected frames were captured from the original checked-in compressor.
// The fixture retains its source/module identity; the current module may change
// only while preserving these frame bytes. The suite never rewrites goldens.
const fixture = /** @type {{dictionaries: Record<string, {bytes: number, sha256: string}>, cases: ZstdFrameCase[]}} */ (
    JSON.parse(readFileSync(new URL('data/zstd-compressed-frame-goldens.json', import.meta.url), 'utf8'))
)

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex')
}

/**
 * The public native API is used directly so an unaligned JavaScript view is
 * also unaligned inside WASM, rather than being copied into an aligned buffer
 * by the handwritten adapter.
 * @param {ZstdModule} module
 * @param {number} encoder
 * @param {number} decoder
 * @param {ZstdFrameCase} specification
 * @param {Uint8Array} source
 * @param {Uint8Array} dictionary
 * @param {number} sourceOffset
 * @param {number} dictionaryOffset
 */
function checkFrame(module, encoder, decoder, specification, source, dictionary, sourceOffset, dictionaryOffset) {
    const allocations = /** @type {number[]} */ ([])
    /**
     * @param {number} size
     * @returns {number}
     */
    const allocate = (size) => {
        const pointer = module._malloc(size)
        expect(pointer).not.toBe(0)
        allocations.push(pointer)
        return pointer
    }
    try {
        const input = allocate(source.byteLength + sourceOffset + 1) + sourceOffset
        const bound = module._ZSTD_compressBound(source.byteLength)
        const output = allocate(bound + 3) + 3
        const decoded = allocate(source.byteLength + 1) + 1
        const dict = dictionary.byteLength === 0 ? 0 : allocate(dictionary.byteLength + dictionaryOffset) + dictionaryOffset
        module.HEAPU8.set(source, input)
        if (dictionary.byteLength > 0) { module.HEAPU8.set(dictionary, dict) }
        expect(input % 8).toBe(sourceOffset % 8)
        if (dict !== 0) { expect(dict % 8).toBe(dictionaryOffset % 8) }

        const frameBytes = specification.api === 'plain' ?
            module._ZSTD_compress(output, bound, input, source.byteLength, specification.level) :
            module._ZSTD_compress_usingDict(encoder, output, bound, input, source.byteLength, dict, dictionary.byteLength, specification.level)
        expect(module._ZSTD_isError(frameBytes)).toBe(0)
        expect(frameBytes).toBe(specification.frameBytes)
        const frame = module.HEAPU8.slice(output, output + frameBytes)
        expect(sha256(frame)).toBe(specification.frameSha256)
        expect(module._ZSTD_getFrameContentSize(output, frameBytes)).toBe(BigInt(source.byteLength))

        if (specification.requiresDictionary) {
            const withoutDictionary = module._ZSTD_decompress(decoded, source.byteLength, output, frameBytes)
            expect(module._ZSTD_isError(withoutDictionary)).toBe(1)
        }
        const decodedBytes = specification.api === 'plain' ?
            module._ZSTD_decompress(decoded, source.byteLength, output, frameBytes) :
            module._ZSTD_decompress_usingDict(decoder, decoded, source.byteLength, output, frameBytes, dict, dictionary.byteLength)
        expect(module._ZSTD_isError(decodedBytes)).toBe(0)
        expect(decodedBytes).toBe(source.byteLength)
        expect(Buffer.from(module.HEAPU8.subarray(decoded, decoded + decodedBytes)).equals(source)).toBe(true)
        expect(Buffer.from(module.HEAPU8.subarray(input, input + source.byteLength)).equals(source)).toBe(true)
        if (dictionary.byteLength > 0) {
            expect(Buffer.from(module.HEAPU8.subarray(dict, dict + dictionary.byteLength)).equals(dictionary)).toBe(true)
        }
    } finally {
        for (const pointer of allocations.reverse()) { module._free(pointer) }
    }
}

describe('native Zstd compressed-frame compatibility', () => {
    /** @type {ZstdModule} */
    let module
    let encoder = 0
    let decoder = 0
    /** @type {Record<string, Uint8Array>} */
    const dictionaries = {none: new Uint8Array(0), raw: createRawZstdFrameDictionary()}

    beforeAll(async () => {
        const [wasmBinary, dictionary] = await Promise.all([
            readFile(new URL('../dev/data/zstd-simd.wasm', import.meta.url)),
            readFile(new URL('../dev/data/zstd-dicts/jmdict.zdict', import.meta.url)),
        ])
        dictionaries.jmdict = dictionary
        for (const [name, bytes] of Object.entries(dictionaries)) {
            expect(bytes.byteLength).toBe(fixture.dictionaries[name].bytes)
            expect(sha256(bytes)).toBe(fixture.dictionaries[name].sha256)
        }
        module = await createZstdModule({wasmBinary})
        encoder = module._ZSTD_createCCtx()
        decoder = module._ZSTD_createDCtx()
        expect(encoder).not.toBe(0)
        expect(decoder).not.toBe(0)
    })

    afterAll(() => {
        if (encoder !== 0) { module._ZSTD_freeCCtx(encoder) }
        if (decoder !== 0) { module._ZSTD_freeDCtx(decoder) }
    })

    test.each(fixture.cases)('preserves baseline frame bytes and roundtrips $name', (specification) => {
        const dictionary = dictionaries[specification.dictionary]
        const source = createZstdFrameInput(specification, dictionary)
        expect(source.byteLength).toBe(specification.sourceBytes)
        expect(sha256(source)).toBe(specification.sourceSha256)
        checkFrame(module, encoder, decoder, specification, source, dictionary, 0, 0)
        checkFrame(module, encoder, decoder, specification, source, dictionary, 7, 5)
    })
})
