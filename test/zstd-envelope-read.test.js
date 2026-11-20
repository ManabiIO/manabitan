/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {beforeEach, describe, expect, test, vi} from 'vitest'
import {wrapCompressedTermContentBlock, writeCompressedTermContentBlockEnvelope} from '../ext/js/dictionary/term-content-block-envelope.js'
import {hashTermEntryContentBytesPair} from '../ext/js/dictionary/term-entry-content-hash.js'

const state = vi.hoisted(() => ({create: vi.fn()}))
vi.mock('../dev/lib/zstd-simd-module.js', () => ({default: state.create}))

beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    state.create.mockReset()
    vi.doMock('../ext/lib/zstd-wasm.js', async () => await import('../dev/lib/zstd-wasm.js'))
})

/** @returns {import('core').SafeAny} */
function fakeModule() {
    const heap = new Uint8Array(8192)
    let pointer = 64
    const decode = vi.fn((destination) => {
        heap.set([1, 2, 3], destination)
        return 3
    })
    return {
        HEAPU8: heap,
        _malloc: vi.fn((size) => {
            const result = pointer
            pointer += size + 16
            return result
        }),
        _free: vi.fn(),
        _ZSTD_isError: vi.fn(() => 0),
        _ZSTD_getFrameContentSize: vi.fn(() => 3),
        _ZSTD_decompress: decode,
        _ZSTD_decompress_usingDict: vi.fn((_context, destination) => decode(destination)),
        _manabitan_write_block_envelope: vi.fn((start, length) => {
            writeCompressedTermContentBlockEnvelope(heap.subarray(start, start + length))
            return 1
        }),
    }
}

/** @returns {Uint8Array} */
function sampleEnvelope() {
    const bytes = new Uint8Array(20)
    bytes.set([11, 12, 13, 14, 15, 16, 17, 18], 12)
    writeCompressedTermContentBlockEnvelope(bytes)
    return bytes
}

/**
 * @param {Uint8Array} bytes
 * @returns {(hashes: [number, number]|null) => void}
 */
function validator(bytes) {
    const expected = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return (hashes) => {
        const actual = hashes ?? hashTermEntryContentBytesPair(bytes.subarray(12))
        if (actual[0] !== expected.getUint32(4, true) || actual[1] !== expected.getUint32(8, true)) {
            throw new Error('checksum rejected')
        }
    }
}

describe('native envelope verification during decompression', () => {
    test('checks copied bytes before reading a frame and passes only its payload to the decoder', async () => {
        const module = fakeModule()
        state.create.mockResolvedValue(module)
        const api = await import('../dev/lib/zstd-wasm.js')
        await api.init()
        const bytes = sampleEnvelope()
        const before = Uint8Array.from(bytes)
        /** @type {(hashes: [number, number]|null) => void} */
        const checkEnvelope = (hashes) => {
            expect(module._ZSTD_getFrameContentSize).not.toHaveBeenCalled()
            expect(module._ZSTD_decompress_usingDict).not.toHaveBeenCalled()
            validator(bytes)(hashes)
        }
        const validate = vi.fn(checkEnvelope)
        const output = api.decompressUsingDictWithEnvelope(7, bytes, new Uint8Array([9]), validate, {maxOutputSize: 3})
        expect(validate).toHaveBeenCalledOnce()
        expect(validate).not.toHaveBeenCalledWith(null)
        expect(module._malloc.mock.calls.map((/** @type {[number]} */ [size]) => size)).toEqual([20, 3, 1])
        expect(module._ZSTD_getFrameContentSize).toHaveBeenCalledWith(76, 8)
        const call = module._ZSTD_decompress_usingDict.mock.calls[0]
        expect(call.slice(3, 5)).toEqual([76, 8])
        expect(output).toEqual(new Uint8Array([1, 2, 3]))
        module.HEAPU8.fill(0)
        expect(output).toEqual(new Uint8Array([1, 2, 3]))
        expect(bytes).toEqual(before)
        expect(module._free).toHaveBeenCalledTimes(3)
    })

    test('supports a null dictionary without changing the plain decoder route', async () => {
        const module = fakeModule()
        state.create.mockResolvedValue(module)
        const api = await import('../dev/lib/zstd-wasm.js')
        await api.init()
        const bytes = sampleEnvelope()
        expect(api.decompressUsingDictWithEnvelope(7, bytes, null, validator(bytes))).toEqual(new Uint8Array([1, 2, 3]))
        expect(module._ZSTD_decompress).toHaveBeenCalledOnce()
        expect(module._ZSTD_decompress_usingDict).not.toHaveBeenCalled()
        expect(module._malloc).toHaveBeenCalledTimes(2)
        expect(module._free).toHaveBeenCalledTimes(2)
    })

    test('does not inspect or allocate decoded output when native checksum validation rejects', async () => {
        const module = fakeModule()
        state.create.mockResolvedValue(module)
        const api = await import('../dev/lib/zstd-wasm.js')
        await api.init()
        const bytes = sampleEnvelope()
        bytes[19] ^= 1
        expect(() => api.decompressUsingDictWithEnvelope(7, bytes, null, validator(bytes))).toThrow('checksum rejected')
        expect(module._ZSTD_getFrameContentSize).not.toHaveBeenCalled()
        expect(module._ZSTD_decompress).not.toHaveBeenCalled()
        expect(module._malloc).toHaveBeenCalledOnce()
        expect(module._free).toHaveBeenCalledWith(64)
    })

    test.each(['zero', 'throw'])('preserves corruption precedence when input allocation fails: %s', async (failure) => {
        const module = fakeModule()
        if (failure === 'zero') {
            module._malloc.mockReturnValue(0)
        } else {
            module._malloc.mockImplementation(() => { throw new WebAssembly.RuntimeError('out of memory') })
        }
        state.create.mockResolvedValue(module)
        const api = await import('../dev/lib/zstd-wasm.js')
        await api.init()
        const bytes = sampleEnvelope()
        bytes[4] ^= 1
        expect(() => api.decompressUsingDictWithEnvelope(7, bytes, null, validator(bytes))).toThrow('checksum rejected')
        writeCompressedTermContentBlockEnvelope(bytes)
        expect(() => api.decompressUsingDictWithEnvelope(7, bytes, null, validator(bytes))).toThrow(
            failure === 'zero' ? 'Failed to allocate Zstd input buffer' : 'out of memory',
        )
        expect(module._ZSTD_getFrameContentSize).not.toHaveBeenCalled()
        expect(module._ZSTD_decompress).not.toHaveBeenCalled()
        expect(module._free).not.toHaveBeenCalled()
    })

    test('preserves corruption precedence before low-level module initialization', async () => {
        const api = await import('../dev/lib/zstd-wasm.js')
        const bytes = sampleEnvelope()
        bytes[8] ^= 1
        expect(() => api.decompressUsingDictWithEnvelope(7, bytes, null, validator(bytes))).toThrow('checksum rejected')
        writeCompressedTermContentBlockEnvelope(bytes)
        expect(() => api.decompressUsingDictWithEnvelope(7, bytes, null, validator(bytes))).toThrow('Zstd WASM is not initialized')
    })

    test('preserves corruption precedence before the dictionary decoder is initialized', async () => {
        const {decompressWrappedTermContentZstd} = await import('../ext/js/dictionary/zstd-term-content.js')
        const bytes = sampleEnvelope()
        bytes[8] ^= 1
        expect(() => decompressWrappedTermContentZstd(bytes, 'jmdict', validator(bytes))).toThrow('checksum rejected')
        writeCompressedTermContentBlockEnvelope(bytes)
        expect(() => decompressWrappedTermContentZstd(bytes, 'jmdict', validator(bytes))).toThrow('Term content zstd not initialized')
    })

    test('checks output bounds after integrity and frees the input on rejection', async () => {
        const module = fakeModule()
        state.create.mockResolvedValue(module)
        const api = await import('../dev/lib/zstd-wasm.js')
        await api.init()
        const bytes = sampleEnvelope()
        const validate = vi.fn(validator(bytes))
        expect(() => api.decompressUsingDictWithEnvelope(7, bytes, null, validate, {maxOutputSize: 2})).toThrow('exceeds configured output limit')
        expect(validate).toHaveBeenCalledOnce()
        expect(module._ZSTD_decompress).not.toHaveBeenCalled()
        expect(module._malloc).toHaveBeenCalledOnce()
        expect(module._free).toHaveBeenCalledWith(64)
    })

    test('matches the real dictionary codec and preserves ownership and both checksum words', async () => {
        const {default: create} = /** @type {typeof import('../dev/lib/zstd-simd-module.js')} */ (await vi.importActual('../dev/lib/zstd-simd-module.js'))
        const module = await create({wasmBinary: await readFile(new URL('../dev/data/zstd-simd.wasm', import.meta.url))})
        state.create.mockResolvedValue(module)
        const api = await import('../dev/lib/zstd-wasm.js')
        await api.init()
        const dictionary = await readFile(new URL('../dev/data/zstd-dicts/jmdict.zdict', import.meta.url))
        const cctx = api.createCCtx()
        const dctx = api.createDCtx()
        try {
            const source = new TextEncoder().encode(JSON.stringify(['日本語', 'dictionary definition', 'noun']).repeat(3000))
            const stored = api.compressUsingDictWithPrefix(cctx, source, dictionary, 12, -1, true)
            const before = Uint8Array.from(stored)
            const output = api.decompressUsingDictWithEnvelope(dctx, stored, dictionary, validator(stored), {maxOutputSize: source.length})
            expect(output).toEqual(source)
            expect(output).toEqual(api.decompressUsingDict(dctx, stored.subarray(12), dictionary))
            const decode = vi.spyOn(module, '_ZSTD_decompress_usingDict')
            for (const index of [4, 8, stored.length - 1]) {
                const corrupt = Uint8Array.from(stored)
                corrupt[index] ^= 1
                decode.mockClear()
                expect(() => api.decompressUsingDictWithEnvelope(dctx, corrupt, dictionary, validator(corrupt))).toThrow('checksum rejected')
                expect(decode).not.toHaveBeenCalled()
            }
            const malformed = Uint8Array.from(stored)
            malformed[12] ^= 255
            writeCompressedTermContentBlockEnvelope(malformed)
            expect(() => api.decompressUsingDictWithEnvelope(dctx, malformed, dictionary, validator(malformed))).toThrow()
            api.compressUsingDict(cctx, new Uint8Array(source.length), dictionary, -1)
            expect(output).toEqual(source)
            expect(stored).toEqual(before)
        } finally {
            api.freeCCtx(cctx)
            api.freeDCtx(dctx)
        }
    })

    test.each(['jmdict', 'generic'])('reads real %s blocks after reopen and preserves corruption and generation fences', async (kind) => {
        const {default: create} = /** @type {typeof import('../dev/lib/zstd-simd-module.js')} */ (await vi.importActual('../dev/lib/zstd-simd-module.js'))
        const module = await create({wasmBinary: await readFile(new URL('../dev/data/zstd-simd.wasm', import.meta.url))})
        state.create.mockResolvedValue(module)
        const api = await import('../dev/lib/zstd-wasm.js')
        await api.init()
        const dictionary = await readFile(new URL('../dev/data/zstd-dicts/jmdict.zdict', import.meta.url))
        vi.stubGlobal('fetch', vi.fn(async () => new Response(Uint8Array.from(dictionary))))
        const {decompressWrappedTermContentZstd, initializeTermContentZstd} = await import('../ext/js/dictionary/zstd-term-content.js')
        await initializeTermContentZstd()
        const {TermContentOpfsStore} = await import('../ext/js/dictionary/term-content-opfs-store.js')
        const {TermContentBlockStore} = await import('../ext/js/dictionary/term-content-block-store.js')
        const {createRawTermContentCompactBlockDictName, encodeRawTermContentCompactBlockReference} = await import('../ext/js/dictionary/raw-term-content.js')
        const {createNodeOpfs} = await import('./fixtures/opfs-continuation/node-opfs-adapter.mjs')
        const env = await createNodeOpfs()
        vi.stubGlobal('navigator', {storage: {getDirectory: async () => env.root}})
        const cctx = api.createCCtx()
        try {
            const source = new TextEncoder().encode(JSON.stringify(['日本語', 'real stored definition']).repeat(1000))
            const dictName = kind === 'jmdict' ? 'jmdict' : null
            const contentDictName = createRawTermContentCompactBlockDictName(dictName)
            const stored = dictName === 'jmdict' ?
                api.compressUsingDictWithPrefix(cctx, source, dictionary, 12, -1, true) :
                wrapCompressedTermContentBlock(api.compress(source, -1))
            const before = Uint8Array.from(stored)
            const corrupted = [4, 8, stored.length - 1].map((index) => {
                const bytes = Uint8Array.from(stored)
                bytes[index] ^= 1
                return bytes
            })
            const writer = new TermContentOpfsStore()
            await writer.prepare()
            await writer.beginImportSession()
            const spans = await writer.appendBatch([stored, ...corrupted])
            const references = await writer.appendBatch(spans.map(({offset, length}) => encodeRawTermContentCompactBlockReference(offset, length, source.length, 0)))
            await writer.endImportSession()
            const reopened = new TermContentOpfsStore()
            await reopened.prepare()
            const blockStore = new TermContentBlockStore(reopened)
            const decode = vi.spyOn(module, dictName === 'jmdict' ? '_ZSTD_decompress_usingDict' : '_ZSTD_decompress')
            expect(() => decompressWrappedTermContentZstd(stored, dictName, validator(stored), {maxOutputSize: source.length - 1})).toThrow('exceeds configured output limit')
            expect(decode).not.toHaveBeenCalled()
            expect(stored).toEqual(before)
            const diagnostics = vi.spyOn(blockStore, '_recordError')
            expect(await blockStore.read(references[0].offset, source.length, contentDictName)).toEqual(source)
            expect(decode).toHaveBeenCalledOnce()
            expect(await blockStore.read(references[0].offset, source.length, contentDictName)).toEqual(source)
            expect(decode).toHaveBeenCalledOnce()
            blockStore.clearCache()
            expect(await blockStore.read(references[0].offset, source.length, contentDictName)).toEqual(source)
            expect(decode).toHaveBeenCalledTimes(2)
            expect(await reopened.readSlice(spans[0].offset, stored.length)).toEqual(before)
            for (let i = 1; i < references.length; ++i) {
                diagnostics.mockClear()
                await expect(blockStore.readDetailed(references[i].offset, source.length, contentDictName)).resolves.toMatchObject({
                    status: 'corrupt', reason: 'Term content block checksum does not match its stored payload',
                })
                expect(decode).toHaveBeenCalledTimes(2)
                expect(diagnostics).toHaveBeenCalledOnce()
                expect(diagnostics.mock.calls[0][0]).toBe('term-content-block-checksum-mismatch')
                expect(await reopened.readSlice(spans[i].offset, stored.length)).toEqual(corrupted[i - 1])
            }
            blockStore.clearCache()
            const read = reopened.readSlice.bind(reopened)
            /** @type {((bytes: Uint8Array) => void)|undefined} */
            let release
            /** @type {Promise<Uint8Array>} */
            const gate = new Promise((resolve) => { release = resolve })
            const readSpy = vi.spyOn(reopened, 'readSlice').mockImplementation((offset, length) => (offset === spans[0].offset ? gate : read(offset, length)))
            const pending = blockStore.readDetailed(references[0].offset, source.length, contentDictName)
            await vi.waitFor(() => { expect(readSpy).toHaveBeenCalledWith(spans[0].offset, stored.length) })
            blockStore.clearCache()
            release?.(stored)
            await expect(pending).resolves.toMatchObject({status: 'temporarilyUnavailable', reason: 'Term content changed during read'})
            expect(decode).toHaveBeenCalledTimes(2)
            expect(stored).toEqual(before)
        } finally {
            api.freeCCtx(cctx)
            await env.dispose()
        }
    })
})
