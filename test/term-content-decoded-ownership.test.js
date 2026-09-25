/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {afterAll, beforeAll, describe, expect, test, vi} from 'vitest'
import {TermContentBlockStore} from '../ext/js/dictionary/term-content-block-store.js'
import {TermContentOpfsStore} from '../ext/js/dictionary/term-content-opfs-store.js'
import * as zstd from '../ext/js/dictionary/zstd-term-content.js'

const originalFetch = globalThis.fetch
beforeAll(async () => {
    // Adapt resource loading only; use the compiled codec and real block store.
    globalThis.fetch = async (input, init) => {
        const value = String(input)
        const resource = value.startsWith('/lib/') ? new URL(`../ext${value}`, import.meta.url) : new URL(value)
        if (resource.protocol !== 'file:') { return await originalFetch(input, init) }
        return new Response(await readFile(resource), {headers: {'Content-Type': 'application/wasm'}})
    }
    await zstd.initializeTermContentZstd()
})
afterAll(() => { globalThis.fetch = originalFetch })

describe('decoded term block ownership', () => {
    for (const dictionary of [null, 'jmdict']) {
        test(`caches the already-owned decoded output without another copy (${dictionary})`, async () => {
            const content = new Uint8Array(65537).fill(71)
            const storage = new TermContentOpfsStore()
            const store = new TermContentBlockStore(storage)
            const wrapped = zstd.compressWrappedTermContentZstd(content, dictionary).bytes
            const [{offset}] = await storage.appendBatch([wrapped])
            const read = vi.spyOn(zstd, 'decompressTermContentZstd')
            try {
                const result = await store._loadBlock('ownership', {
                    blockOffset: offset,
                    blockCompressedLength: wrapped.length,
                    blockUncompressedLength: content.length,
                }, dictionary, {contentOffset: 0, contentLength: content.length, contentDictName: 'raw-block-v2'})
                expect(read).toHaveBeenCalledOnce()
                expect(result).toBe(read.mock.results[0].value)
                expect(result).not.toBeNull()
                if (result === null) { throw new Error('Expected a decoded block') }
                expect(result.buffer).toBeInstanceOf(ArrayBuffer)
                expect(result.buffer.byteLength).toBe(content.length)
                expect(Buffer.compare(result, content)).toBe(0)
                // Trigger larger native allocations and a later decompression.
                const replacement = new Uint8Array(2 * 1024 * 1024).fill(97)
                const compressed = zstd.compressTermContentZstd(replacement, dictionary)
                expect(Buffer.compare(zstd.decompressTermContentZstd(compressed, dictionary), replacement)).toBe(0)
                store.clearCache()
                wrapped.fill(0)
                expect(Buffer.compare(result, content)).toBe(0)
            } finally { read.mockRestore() }
        })
    }

    test('decompressions return separate owned buffers', () => {
        const content = new Uint8Array(8193).fill(29)
        const compressed = zstd.compressTermContentZstd(content, null)
        const first = zstd.decompressTermContentZstd(compressed, null)
        const second = zstd.decompressTermContentZstd(compressed, null)
        expect(first.buffer).not.toBe(second.buffer)
        first.fill(255)
        expect(Buffer.compare(second, content)).toBe(0)
    })
})
