/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {Worker} from 'node:worker_threads'
import {afterAll, beforeAll, describe, expect, test} from 'vitest'
import {compressWrappedTermContentZstd, decompressTermContentZstd, initializeTermContentZstd} from '../ext/js/dictionary/zstd-term-content.js'

/** @typedef {{id: number, type?: string, compressed?: ArrayBuffer, error?: string, witness: {retainedFields: string[], retainedEventCount: number}|null}} Reply */
/** @typedef {{source: Uint8Array, sourceOffsets: Uint32Array, sourceLengths: Uint32Array, contentBytes: number, dictName: string|null, wrap: boolean, compressionExperiments: {experimentalGenericSpanCompression: boolean}}} SpanJob */
const originalFetch = globalThis.fetch

beforeAll(async () => {
    globalThis.fetch = async (input, init) => {
        const url = new URL(String(input))
        if (url.protocol !== 'file:') { return await originalFetch(input, init) }
        return new Response(await readFile(url), {headers: {'Content-Type': 'application/wasm'}})
    }
    await initializeTermContentZstd()
})
afterAll(() => { globalThis.fetch = originalFetch })

/** @returns {Promise<Worker>} */
async function startWorker() {
    const worker = new Worker(new URL('fixtures/compression-source-release/worker-node.mjs', import.meta.url))
    try {
        /** @type {Promise<void>} */
        const ready = new Promise((resolve, reject) => {
            worker.once('error', reject)
            worker.once('message', (/** @type {{type: string, error?: string}} */ message) => {
                if (message.type === 'ready') {
                    resolve()
                } else {
                    reject(new Error(message.error))
                }
            })
        })
        await ready
        return worker
    } catch (error) {
        await worker.terminate()
        throw error
    }
}

/**
 * @param {Worker} worker
 * @param {number} id
 * @param {SpanJob|{content: Uint8Array, dictName: string|null, wrap: boolean}} job
 * @param {{overwriteOnConsumed?: boolean, failAfterConsumed?: boolean}} [control]
 * @returns {Promise<Reply[]>}
 */
function dispatch(worker, id, job, control = {}) {
    return new Promise((resolve, reject) => {
        /** @type {Reply[]} */
        const replies = []
        /** @param {Reply} message */
        const receive = (message) => {
            if (message.id !== id) { return }
            replies.push(message)
            if (message.type === 'source-consumed') { return }
            cleanup()
            resolve(replies)
        }
        /** @param {Error} error */
        const fail = (error) => {
            cleanup()
            reject(error)
        }
        const cleanup = () => {
            worker.off('message', receive)
            worker.off('error', fail)
        }
        worker.on('message', receive)
        worker.on('error', fail)
        worker.postMessage({data: {id, ...job}, control})
    })
}

/**
 * @param {string|null} [dictName]
 * @returns {{job: SpanJob, packed: Uint8Array}}
 */
function sourceJob(dictName = null) {
    const source = new Uint8Array(new SharedArrayBuffer(1024 * 1024 + 17), 17)
    for (let i = 0; i < source.length; ++i) { source[i] = 32 + (i % 83) }
    const sourceOffsets = new Uint32Array(new SharedArrayBuffer(12))
    const sourceLengths = new Uint32Array(new SharedArrayBuffer(12))
    sourceOffsets.set([3, 8195, 90011])
    sourceLengths.set([8192, 4103, 65539])
    const contentBytes = sourceLengths.reduce((sum, length) => sum + length, 0)
    const packed = new Uint8Array(contentBytes)
    let end = 0
    for (let i = 0; i < sourceOffsets.length; ++i) {
        packed.set(source.subarray(sourceOffsets[i], sourceOffsets[i] + sourceLengths[i]), end)
        end += sourceLengths[i]
    }
    return {
        job: {
            source,
            sourceOffsets,
            sourceLengths,
            contentBytes,
            dictName,
            wrap: true,
            compressionExperiments: {experimentalGenericSpanCompression: true},
        },
        packed,
    }
}

/**
 * @param {Reply[]} replies
 * @param {Uint8Array} expected
 * @param {string|null} dictName
 */
function expectSuccess(replies, expected, dictName) {
    expect(replies).toHaveLength(2)
    expect(replies[0].type).toBe('source-consumed')
    expect(replies.map((reply) => reply.witness?.retainedFields)).toEqual([[], []])
    const compressed = replies[1].compressed
    if (!(compressed instanceof ArrayBuffer)) { throw new Error(replies[1].error ?? 'Missing worker output') }
    const bytes = new Uint8Array(compressed)
    expect(Buffer.compare(bytes, compressWrappedTermContentZstd(expected, dictName).bytes)).toBe(0)
    expect(Buffer.compare(decompressTermContentZstd(bytes.subarray(12), dictName), expected)).toBe(0)
}

describe('production compression worker source ownership', () => {
    test.each([null, 'jmdict'])('drops retained event references before acknowledgement and survives source overwrite (%s)', async (dictName) => {
        const worker = await startWorker()
        try {
            const {job, packed} = sourceJob(dictName)
            const replies = await dispatch(worker, 1, job, {overwriteOnConsumed: true})
            expectSuccess(replies, packed, dictName)
            expect(job.source[0]).toBe(255)
            expect([...job.sourceOffsets]).toEqual([0xffffffff, 0xffffffff, 0xffffffff])
            expect([...job.sourceLengths]).toEqual([0xffffffff, 0xffffffff, 0xffffffff])
            expect(job.source.byteLength).toBe(1024 * 1024)
        } finally { await worker.terminate() }
    })

    test('releases each queued event without changing a shared slab still needed by later jobs', async () => {
        const worker = await startWorker()
        try {
            const {job, packed} = sourceJob()
            const original = Uint8Array.from(job.source)
            const results = await Promise.all(Array.from({length: 6}, (_, id) => dispatch(worker, id + 1, job)))
            for (const replies of results) { expectSuccess(replies, packed, null) }
            expect(Buffer.compare(job.source, original)).toBe(0)
            expect(results.at(-1)?.at(-1)?.witness?.retainedEventCount).toBe(6)
        } finally { await worker.terminate() }
    })

    test('a gather failure does not acknowledge or clear input and does not poison a queued valid job', async () => {
        const worker = await startWorker()
        try {
            const {job, packed} = sourceJob()
            const invalid = {...job, sourceOffsets: Uint32Array.of(job.source.length - 1), sourceLengths: Uint32Array.of(2), contentBytes: 2}
            const [failed, recovered] = await Promise.all([dispatch(worker, 1, invalid), dispatch(worker, 2, job)])
            expect(failed).toHaveLength(1)
            expect(failed[0].error).toContain('out of bounds')
            expect(failed[0].witness?.retainedFields).toEqual(['source', 'sourceOffsets', 'sourceLengths'])
            expectSuccess(recovered, packed, null)
        } finally { await worker.terminate() }
    })

    test('preserves an acknowledgement followed by an error and permits the next compression', async () => {
        const worker = await startWorker()
        try {
            const {job, packed} = sourceJob()
            const failed = await dispatch(worker, 1, job, {failAfterConsumed: true})
            expect(failed).toHaveLength(2)
            expect(failed[0].type).toBe('source-consumed')
            expect(failed[1].error).toContain('injected failure after source acknowledgement')
            expect(failed.map((reply) => reply.witness?.retainedFields)).toEqual([[], []])
            expectSuccess(await dispatch(worker, 2, job), packed, null)
        } finally { await worker.terminate() }
    })

    test('preserves the packed-input branch and its single completion message', async () => {
        const worker = await startWorker()
        try {
            const {packed} = sourceJob()
            const replies = await dispatch(worker, 1, {content: packed, dictName: null, wrap: true})
            expect(replies).toHaveLength(1)
            expect(replies[0].type).toBeUndefined()
            const compressed = replies[0].compressed
            if (!(compressed instanceof ArrayBuffer)) { throw new Error(replies[0].error ?? 'Missing worker output') }
            expect(Buffer.compare(new Uint8Array(compressed), compressWrappedTermContentZstd(packed, null).bytes)).toBe(0)
        } finally { await worker.terminate() }
    })
})
