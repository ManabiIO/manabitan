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

import {describe, expect, test, vi} from 'vitest'
import {TermBankSourcePipeline} from '../ext/js/dictionary/term-bank-source-pipeline.js'

const mib = 1024 * 1024

/**
 * @param {number} count
 * @param {number} [decodedBytes]
 */
function filesFor(count, decodedBytes = 4 * mib) {
    return Array.from({length: count}, (_, index) => ({
        filename: `term_bank_${index + 1}.json`, offset: index * 64,
        compressionMethod: 8, compressedSize: 4, uncompressedSize: decodedBytes,
        signature: index + 100, getData() {},
    }))
}

/**
 * @param {ReturnType<typeof filesFor>} files
 * @param {number} [deviceMemory]
 */
function createPipeline(files, deviceMemory = 4) {
    const read = vi.fn(async () => new Uint8Array([91, 93]))
    const readCompressed = vi.fn(async () => new Uint8Array(4))
    const pipeline = new TermBankSourcePipeline({termFiles: files, enabled: true, read, readCompressed, deviceMemory})
    return {pipeline, read, readCompressed}
}

describe('bounded compressed source plans', () => {
    test.each([0.5, 1, 2, 4])('keeps every lazy batch within both byte budgets at deviceMemory=%s', async (memory) => {
        const files = filesFor(64)
        const {pipeline, read, readCompressed} = createPipeline(files, memory)
        try {
            expect(pipeline.createImportRunPlan(0)).toBeNull()
            for (const start of [0, 16, 32, 48]) {
                const plan = pipeline.createCompressedImportRunPlan(start)
                expect(plan?.files).toEqual(files.slice(start, start + 16))
                if (plan === null) { throw new Error('Missing bounded plan') }
                expect(plan.estimatedByteLengths.reduce((a, b) => a + b, 0)).toBe(64 * mib)
                expect(readCompressed).toHaveBeenCalledTimes(start / 16)
                await expect(plan.loaders[0]()).resolves.toMatchObject({
                    filename: files[start].filename, uncompressedSize: 4 * mib, signature: files[start].signature,
                })
                pipeline.releaseBatch(plan.files)
            }
            expect(read).not.toHaveBeenCalled()
            expect(pipeline.createCompressedImportRunPlan(files.length)).toBeNull()
        } finally {
            await pipeline.dispose()
        }
    })

    test('keeps the existing import-wide plan on unconstrained devices', async () => {
        const files = filesFor(64)
        const {pipeline, readCompressed} = createPipeline(files, 8)
        try {
            expect(pipeline.createCompressedImportRunPlan(0)?.files).toEqual(files)
            expect(readCompressed).not.toHaveBeenCalled()
        } finally { await pipeline.dispose() }
    })

    test('rejects a compressed allocation budget overflow even with tiny decoded sizes', async () => {
        const files = filesFor(4, 1024)
        for (const file of files) { file.compressedSize = 17 * mib }
        const {pipeline, readCompressed} = createPipeline(files)
        try {
            expect(pipeline.createCompressedImportRunPlan(0)).toBeNull()
            expect(readCompressed).not.toHaveBeenCalled()
        } finally { await pipeline.dispose() }
    })

    test('accepts exact compressed and decoded limits without reading ahead', async () => {
        const files = filesFor(5, 16 * mib)
        for (const file of files) { file.compressedSize = 16 * mib }
        const {pipeline, readCompressed} = createPipeline(files)
        try {
            expect(pipeline.createCompressedImportRunPlan(0)?.files).toEqual(files.slice(0, 4))
            expect(readCompressed).not.toHaveBeenCalled()
        } finally { await pipeline.dispose() }
    })

    test.each([64 * mib + 1, Number.MAX_SAFE_INTEGER])('does not admit an oversized first bank: %s', async (size) => {
        const files = filesFor(4, size)
        const {pipeline, readCompressed} = createPipeline(files)
        try {
            expect(pipeline.createCompressedImportRunPlan(0)).toBeNull()
            expect(readCompressed).not.toHaveBeenCalled()
        } finally { await pipeline.dispose() }
    })

    test.each([0, -1, 1.5, Number.NaN, Infinity])('falls back for unknown or invalid decoded size %s', async (size) => {
        const files = filesFor(4, size)
        const {pipeline} = createPipeline(files)
        try { expect(pipeline.createCompressedImportRunPlan(0)).toBeNull() }
        finally { await pipeline.dispose() }
    })

    test('does not reject a valid earlier batch because a later batch has invalid metadata', async () => {
        const files = filesFor(32)
        files[17].signature = -1
        const {pipeline} = createPipeline(files)
        try {
            expect(pipeline.createCompressedImportRunPlan(0)?.files).toEqual(files.slice(0, 16))
            expect(pipeline.createCompressedImportRunPlan(16)).toBeNull()
        } finally { await pipeline.dispose() }
    })

    test('releases old reads before reopening the next bounded plan', async () => {
        const files = filesFor(4)
        const {pipeline, readCompressed} = createPipeline(files)
        try {
            const first = pipeline.createCompressedImportRunPlan(0)
            if (first === null) { throw new Error('Missing source plan') }
            const a = await first.loaders[0]()
            const b = await first.loaders[0]()
            expect(a.bytes).toBe(b.bytes)
            expect(readCompressed).toHaveBeenCalledTimes(1)
            pipeline.releaseBatch(first.files)
            const second = pipeline.createCompressedImportRunPlan(0)
            if (second === null) { throw new Error('Missing source plan') }
            const c = await second.loaders[0]()
            expect(c.bytes).not.toBe(a.bytes)
            expect(readCompressed).toHaveBeenCalledTimes(2)
        } finally { await pipeline.dispose() }
    })

    test('still cancels and joins every outstanding raw payload read', async () => {
        const files = filesFor(4)
        let aborted = 0
        const pipeline = new TermBankSourcePipeline({
            termFiles: files, enabled: true, deviceMemory: 4,
            read: async () => new Uint8Array(),
            readCompressed: (_file, signal) => new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => {
                    ++aborted
                    reject(signal.reason)
                }, {once: true})
            }),
        })
        const plan = pipeline.createCompressedImportRunPlan(0)
        if (plan === null) { throw new Error('Missing source plan') }
        const reads = plan.loaders.map((load) => load())
        const settled = Promise.allSettled(reads)
        await pipeline.abortAndJoin()
        expect(aborted).toBe(4)
        expect((await settled).map(({status}) => status)).toEqual(Array(4).fill('rejected'))
        await pipeline.dispose()
    })
})
