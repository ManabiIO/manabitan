/* Copyright (C) 2026 Manabitan authors; SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */
import {readFile} from 'node:fs/promises'
import {beforeAll, describe, expect, test, vi} from 'vitest'
import * as zstd from '../../../dev/lib/zstd-wasm.js'

// Only supply browser module bytes to the Node test host. All compression and
// decompression below execute the actual built WASM, not a substitute codec.
vi.mock('../../../dev/lib/zstd-simd-module.js', async (importOriginal) => {
    const actual = await importOriginal()
    return {default: async (options) => actual.default({...options,
        wasmBinary: new Uint8Array(await readFile(new URL('../../data/zstd-simd.wasm', import.meta.url)))})}
})
beforeAll(async () => { await zstd.init() })

const encoder = new TextEncoder()
const widths = [1, 7, 8, 15, 16, 63, 64, 1023, 4096, 65535, 131073, 4194304]

describe('real dictionary compression context conformance', () => {
    test.each(widths)('round-trips plain and gathered envelopes at source width %i', async (width) => {
        const trained = new Uint8Array(await readFile(new URL('../../data/zstd-dicts/jmdict.zdict', import.meta.url)))
        const source = encoder.encode('日本語0123456789'.repeat(Math.ceil(width / 22))).subarray(0, width)
        const cctx = zstd.createCCtx()
        const dctx = zstd.createDCtx()
        try {
            for (const level of [-1, 1, 3]) {
                for (let repeat = 0; repeat < 3; ++repeat) {
                    const output = zstd.compressUsingDictWithPrefix(cctx, source, trained, 12, level, true)
                    expect(output[0]).not.toBe(0)
                    expect(Buffer.compare(zstd.decompressUsingDict(dctx, output.subarray(12), trained), source)).toBe(0)
                    const split = Math.floor(source.length / 2)
                    const prepared = zstd.prepareSpanCompression(cctx, source, Uint32Array.of(0, split),
                        Uint32Array.of(split, source.length - split), source.length, trained, 12, level, true)
                    const gathered = zstd.finishPreparedSpanCompression(prepared)
                    expect(Buffer.compare(gathered, output)).toBe(0)
                }
            }
        } finally { zstd.freeCCtx(cctx); zstd.freeDCtx(dctx) }
    })
    test('does not reuse stale dictionary bytes, levels, contexts or output ownership', () => {
        const dictionary = encoder.encode('dictionary training sample '.repeat(256))
        const source = encoder.encode('dictionary training sample 日本語 '.repeat(1000))
        const dctx = zstd.createDCtx()
        try {
            for (let round = 0; round < 20; ++round) {
                const cctx = zstd.createCCtx()
                try {
                    for (const level of [-1, 3, 1, -1]) {
                        const first = zstd.compressUsingDict(cctx, source, dictionary, level)
                        const retained = Uint8Array.from(first)
                        dictionary[round % dictionary.length] ^= 1
                        const second = zstd.compressUsingDict(cctx, source, dictionary, level)
                        expect(Buffer.compare(zstd.decompressUsingDict(dctx, second, dictionary), source)).toBe(0)
                        expect(Buffer.compare(first, retained)).toBe(0)
                    }
                } finally { zstd.freeCCtx(cctx) }
            }
        } finally { zstd.freeDCtx(dctx) }
    })
})
