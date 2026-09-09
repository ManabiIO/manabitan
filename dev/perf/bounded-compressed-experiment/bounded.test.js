/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2020-2022  Yomichan Authors
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

import {describe, expect, test, vi} from 'vitest'
import {TermBankSourcePipeline} from '../ext/js/dictionary/term-bank-source-pipeline.js'

const MiB = 1024 * 1024

/**
 * Sizes describe metadata only: tests do not allocate the uncompressed banks.
 * @param {number[]} sizes
 * @returns {{filename: string, offset: number, compressionMethod: number, compressedSize: number, uncompressedSize: number, signature: number, getData: () => void}[]}
 */
function filesFor(sizes) {
    return sizes.map((size, index) => ({
        filename: `term_bank_${index + 1}.json`,
        offset: index * 64,
        compressionMethod: 8,
        compressedSize: 4,
        uncompressedSize: size,
        signature: index + 100,
        getData() {},
    }))
}

/**
 * @param {ReturnType<typeof filesFor>} files
 * @param {number} [deviceMemory=4]
 */
function setup(files, deviceMemory = 4) {
    const read = vi.fn(async () => new Uint8Array([91, 93]))
    const readCompressed = vi.fn(async () => new Uint8Array(4))
    const pipeline = new TermBankSourcePipeline({termFiles: files, enabled: true, read, readCompressed, deviceMemory})
    return {pipeline, read, readCompressed}
}

describe('bounded compressed term-bank plans', () => {
    test.each([0.5, 1, 2, 4])('keeps every lazy run within the existing source budget; deviceMemory=%s', async (memory) => {
        const files = filesFor(Array(64).fill(4 * MiB))
        const {pipeline, read, readCompressed} = setup(files, memory)
        for (let start = 0; start < files.length; start += 16) {
            const plan = pipeline.createCompressedImportRunPlan(start)
            expect(plan?.files).toEqual(files.slice(start, start + 16))
            expect(plan?.estimatedByteLengths.reduce((sum, size) => sum + size, 0)).toBe(64 * MiB)
            expect(plan?.loaders).toHaveLength(16)
        }
        expect(pipeline.createCompressedImportRunPlan(files.length)).toBeNull()
        expect(read).not.toHaveBeenCalled()
        expect(readCompressed).not.toHaveBeenCalled()
        expect(pipeline.prefetchMaxBytes).toBe(24 * MiB)
        await pipeline.dispose()
    })

    test('accepts exactly the limit and splits the next byte into another batch', async () => {
        const sizes = [16 * MiB, 16 * MiB, 16 * MiB, 16 * MiB, 2, 2, 2, 2]
        const files = filesFor(sizes)
        const {pipeline} = setup(files)
        expect(pipeline.createCompressedImportRunPlan(0)?.files).toEqual(files.slice(0, 4))
        expect(pipeline.createCompressedImportRunPlan(4)?.files).toEqual(files.slice(4))
        await pipeline.dispose()
    })

    test.each([0, Number.NaN, Infinity, -1, 64 * MiB + 1, Number.MAX_SAFE_INTEGER])('does not bypass the budget for an invalid or oversized first bank: %s', async (size) => {
        const {pipeline, readCompressed} = setup(filesFor([size, 2, 2, 2, 2]))
        expect(pipeline.createCompressedImportRunPlan(0)).toBeNull()
        expect(readCompressed).not.toHaveBeenCalled()
        await pipeline.dispose()
    })

    test('also bounds compressed input when it is larger than the claimed output', async () => {
        const files = filesFor([2, 2, 2, 2])
        for (const file of files) { file.compressedSize = 16 * MiB }
        const {pipeline, readCompressed} = setup(files)
        expect(pipeline.createCompressedImportRunPlan(0)?.files).toEqual(files)
        files[0].compressedSize += 1
        expect(pipeline.createCompressedImportRunPlan(0)).toBeNull()
        expect(readCompressed).not.toHaveBeenCalled()
        await pipeline.dispose()
    })

    test('retains ordinary fallback for fewer than four banks and no raw reader', async () => {
        const files = filesFor([2, 2, 2])
        const {pipeline} = setup(files)
        expect(pipeline.createCompressedImportRunPlan(0)).toBeNull()
        await pipeline.dispose()
        const noRaw = new TermBankSourcePipeline({termFiles: filesFor([2, 2, 2, 2]), enabled: true, read: async () => new Uint8Array(2), deviceMemory: 4})
        expect(noRaw.createCompressedImportRunPlan(0)).toBeNull()
        await noRaw.dispose()
    })

    test.each([8, Number.NaN])('does not change the larger/unknown-memory import-wide policy: %s', async (memory) => {
        const files = filesFor(Array(100).fill(4 * MiB))
        const {pipeline} = setup(files, memory)
        expect(pipeline.createCompressedImportRunPlan(0)?.files).toEqual(files)
        expect(pipeline.createCompressedImportRunPlan(16)?.files).toEqual(files.slice(16))
        await pipeline.dispose()
    })

    test('keeps the file-count cap and preserves ordering even for tiny banks', async () => {
        const files = filesFor(Array(164).fill(2))
        const {pipeline} = setup(files)
        for (const start of [0, 80, 160]) {
            expect(pipeline.createCompressedImportRunPlan(start)?.files).toEqual(files.slice(start, start + 80))
        }
        await pipeline.dispose()
    })

    test('validates the current batch without eagerly reading later invalid metadata', async () => {
        const files = filesFor(Array(32).fill(4 * MiB))
        files[20].compressionMethod = 12
        const {pipeline, readCompressed} = setup(files)
        expect(pipeline.createCompressedImportRunPlan(0)?.files).toEqual(files.slice(0, 16))
        expect(pipeline.createCompressedImportRunPlan(16)).toBeNull()
        expect(readCompressed).not.toHaveBeenCalled()
        await pipeline.dispose()
    })

    test('shares reads within a run and releases ownership before a later retry', async () => {
        const files = filesFor(Array(32).fill(4 * MiB))
        const {pipeline, read, readCompressed} = setup(files)
        const plan = pipeline.createCompressedImportRunPlan(0)
        if (plan === null) { throw new Error('Expected bounded plan') }
        await Promise.all([plan.loaders[0](), plan.loaders[0]()])
        expect(readCompressed).toHaveBeenCalledTimes(1)
        pipeline.releaseBatch(plan.files)
        await plan.loaders[0]()
        expect(readCompressed).toHaveBeenCalledTimes(2)
        expect(read).not.toHaveBeenCalled()
        await pipeline.dispose()
        await expect(plan.loaders[0]()).rejects.toThrow('disposed')
    })

    test('joins cancelled raw reads before fallback without starting unclaimed loaders', async () => {
        const files = filesFor(Array(32).fill(4 * MiB))
        /** @type {AbortSignal[]} */
        const signals = []
        /** @type {Array<() => void>} */
        const finish = []
        const pipeline = new TermBankSourcePipeline({
            termFiles: files, enabled: true, deviceMemory: 4,
            read: async () => new Uint8Array([91, 93]),
            readCompressed: async (_file, signal) => {
                signals.push(signal)
                await new Promise((resolve) => { finish.push(() => resolve(void 0)) })
                signal.throwIfAborted()
                return new Uint8Array(4)
            },
        })
        const plan = pipeline.createCompressedImportRunPlan(0)
        if (plan === null) { throw new Error('Expected bounded plan') }
        const reading = expect(plan.loaders[0]()).rejects.toThrow()
        let joined = false
        const aborting = pipeline.abortAndJoin().then(() => { joined = true })
        expect(signals).toHaveLength(1)
        expect(signals[0].aborted).toBe(true)
        await Promise.resolve()
        expect(joined).toBe(false)
        finish[0]()
        await Promise.all([reading, aborting])
        expect(joined).toBe(true)
        await expect(pipeline.read(files[0])).resolves.toEqual(new Uint8Array([91, 93]))
        await pipeline.dispose()
    })

    test('never exceeds byte or file limits across deterministic uneven source plans', async () => {
        let seed = 0x91271215
        const random = () => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
            return seed
        }
        for (let trial = 0; trial < 100; ++trial) {
            const files = filesFor(Array.from({length: 200}, () => 2 + random() % (25 * MiB)))
            const {pipeline} = setup(files)
            for (let start = 0; start < files.length;) {
                const ordinary = pipeline.getBatch(start)
                const compressed = pipeline.createCompressedImportRunPlan(start)
                if (compressed !== null) {
                    expect(compressed.files).toEqual(ordinary)
                    expect(compressed.files.length).toBeGreaterThanOrEqual(4)
                    expect(compressed.files.length).toBeLessThanOrEqual(80)
                    expect(compressed.estimatedByteLengths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(64 * MiB)
                } else {
                    expect(ordinary.length).toBeLessThan(4)
                }
                start += ordinary.length
            }
            await pipeline.dispose()
        }
    })
})
