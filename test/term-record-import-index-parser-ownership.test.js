/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFileSync} from 'node:fs'
import {Worker as ThreadWorker} from 'node:worker_threads'
import {afterEach, beforeAll, describe, expect, test, vi} from 'vitest'
import * as parser from '../ext/js/dictionary/term-bank-wasm-parser.js'
import {getImportIndexChunkParts} from './util/import-index-chunk-fixture.js'
import {createArtifactTermRecordChunkWithResolvedContent, TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js'

/** @type {ParserWorker[]} */
const workers = []
let rejectOwnership = false

class ParserWorker extends EventTarget {
    /** @param {URL} url */
    constructor(url) {
        super()
        this.thread = new ThreadWorker(new URL('fixtures/parser-settlement/worker-node.mjs', import.meta.url), {workerData: {url: url.href}})
        /** @type {Promise<number>|null} */
        this.terminated = null
        this.thread.on('message', (data) => {
            if (rejectOwnership && data.type === 'result') {
                Object.defineProperty(data.chunk, 'preparedLookupIndexes', {
                    get() { throw new Error('Ownership registration witness') },
                })
            }
            this.dispatchEvent(new MessageEvent('message', {data}))
        })
        this.thread.on('error', (error) => {
            this.dispatchEvent(Object.assign(new Event('error'), {message: error.message}))
        })
        this.thread.on('messageerror', () => { this.dispatchEvent(new MessageEvent('messageerror')) })
        workers.push(this)
    }

    /**
     * @param {unknown} value
     * @param {import('node:worker_threads').TransferListItem[]} transfer
     */
    postMessage(value, transfer) { this.thread.postMessage(value, transfer) }

    terminate() { this.terminated ??= this.thread.terminate() }
}

beforeAll(async () => {
    parser.setTermBankWasmModule(await WebAssembly.compile(readFileSync(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))))
})

afterEach(async () => {
    await parser.disposeParallelTermBankParser()
    for (const worker of workers) { worker.terminate() }
    await Promise.all(workers.splice(0).map((worker) => worker.terminated))
    rejectOwnership = false
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

/**
 * @param {number} [banks=24]
 * @param {number} [rows=16]
 * @returns {Uint8Array[]}
 */
function sources(banks = 24, rows = 16) {
    const encoder = new TextEncoder()
    return Array.from({length: banks}, (_, bank) => encoder.encode(JSON.stringify(
        Array.from({length: rows}, (_, row) => [`語${bank}-${row}`, `よみ${bank}-${row}`, '', '', row, ['definition'], row, '']),
    )))
}

const options = {
    emitContentSlab: true,
    emitTokenBinaryContent: true,
    emitTermByteLists: false,
    prepareLookupIndexes: true,
    registerLookupIndexOwnership: true,
    validateGlossaryTypes: true,
}

describe('production parser-worker heavy lookup ownership', () => {
    test.each([
        {dictionaryTotalRows: 384, registerOwnership: true, expectedAdoptions: 0},
        {dictionaryTotalRows: 6_648_310, registerOwnership: true, expectedAdoptions: 12},
        {dictionaryTotalRows: 6_648_310, registerOwnership: false, expectedAdoptions: 0},
    ])('actual transferred results preserve ownership for dictionary size $dictionaryTotalRows with registration $registerOwnership', async ({dictionaryTotalRows, registerOwnership, expectedAdoptions}) => {
        vi.stubGlobal('Worker', ParserWorker)
        vi.stubGlobal('navigator', {hardwareConcurrency: 4, deviceMemory: 8})
        const store = new TermRecordOpfsStore()
        store.setRawTermBankSourceBytes(1024 ** 3)
        Reflect.set(store, '_recordsDirectoryHandle', {async getFileHandle() { return {} }})
        await store.beginImportSession()
        const original = store._createPendingLookupIndexChunk.bind(store)
        let adopted = 0
        vi.spyOn(store, '_createPendingLookupIndexChunk').mockImplementation((...args) => {
            const [firstId, count, base, payload, fields, format] = args
            const expected = store._createLookupIndexChunk(firstId, count, base, payload, fields, format)
            const pending = original(...args)
            if (expectedAdoptions === 0) {
                expect(pending).toBeInstanceOf(Uint8Array)
            } else {
                expect(pending).not.toBeInstanceOf(Uint8Array)
                ++adopted
            }
            const parts = getImportIndexChunkParts([pending])
            expect(Buffer.concat(parts)).toEqual(Buffer.from(expected))
            return pending
        })
        let rows = 0
        const used = await parser.parseTermBankWithWasmColumnChunksParallel(sources(), 3, async (chunk) => {
            expect(chunk.contentBytesBuffer?.buffer).toBeInstanceOf(SharedArrayBuffer)
            const keys = Uint8Array.from(chunk.termRecordPreinternedPlan.stringsBuffer)
            const consumer = createArtifactTermRecordChunkWithResolvedContent(
                {dictionary: 'Worker ownership', dictionaryTotalRows, ...chunk},
                Uint32Array.from({length: chunk.rowCount}, (_, row) => row),
                Float64Array.from({length: chunk.rowCount}, (_, row) => row * 16),
                new Uint32Array(chunk.rowCount).fill(8),
            )
            await store.appendBatchFromArtifactChunkResolvedContent(consumer, new Float64Array(0), new Uint32Array(0), 'raw')
            expect(chunk.termRecordPreinternedPlan.stringsBuffer).toEqual(keys)
            rows += chunk.rowCount
        }, {...options, registerLookupIndexOwnership: registerOwnership})
        expect(used).toBe(true)
        expect(rows).toBe(384)
        expect(adopted).toBe(expectedAdoptions)
    })

    test('native segmented runs retain their key aliases and preserve every envelope', async () => {
        vi.stubGlobal('Worker', ParserWorker)
        vi.stubGlobal('navigator', {hardwareConcurrency: 2, deviceMemory: 8})
        const store = new TermRecordOpfsStore()
        store.setRawTermBankSourceBytes(1024 ** 3)
        Reflect.set(store, '_recordsDirectoryHandle', {async getFileHandle() { return {} }})
        await store.beginImportSession()
        // Real I/O transport and short writes are covered by store tests.
        // This checks parser/run lifetimes and borrowed segment fallback.
        vi.spyOn(store, '_flushPendingLookupIndexChunks').mockResolvedValue()
        const original = store._createPendingLookupIndexChunk.bind(store)
        let adopted = 0
        let aliased = 0
        vi.spyOn(store, '_createPendingLookupIndexChunk').mockImplementation((...args) => {
            const [firstId, count, base, payload, fields, format, prepared] = args
            const expected = store._createLookupIndexChunk(firstId, count, base, payload, fields, format)
            const pending = original(...args)
            if (prepared?.preinternedPlan.stringsBuffer.buffer === payload.buffer) {
                expect(pending).toBeInstanceOf(Uint8Array)
                expect(payload.byteLength).toBeGreaterThan(0)
                ++aliased
            } else {
                expect(pending).not.toBeInstanceOf(Uint8Array)
                ++adopted
            }
            expect(Buffer.concat(getImportIndexChunkParts([pending])).equals(Buffer.from(expected))).toBe(true)
            return pending
        })
        let rows = 0
        const used = await parser.parseTermBankWithWasmColumnChunksParallel(sources(24, 8500), 3, async (chunk) => {
            const keys = Uint8Array.from(chunk.termRecordPreinternedPlan.stringsBuffer)
            const prepared = chunk.preparedLookupIndexes
            if (!(prepared instanceof Map)) { throw new Error('Missing native segment plans') }
            const plans = [...prepared.values()].map(({preinternedPlan}) => ({
                bytes: preinternedPlan.stringsBuffer,
                expected: Uint8Array.from(preinternedPlan.stringsBuffer),
            }))
            const consumer = createArtifactTermRecordChunkWithResolvedContent(
                {dictionary: 'Segment ownership', dictionaryTotalRows: 6_648_310, ...chunk},
                Uint32Array.from({length: chunk.rowCount}, (_, row) => row),
                Float64Array.from({length: chunk.rowCount}, (_, row) => row * 16),
                new Uint32Array(chunk.rowCount).fill(8),
            )
            await store.appendBatchFromArtifactChunkResolvedContent(consumer, new Float64Array(0), new Uint32Array(0), 'raw')
            expect(Buffer.from(chunk.termRecordPreinternedPlan.stringsBuffer).equals(Buffer.from(keys))).toBe(true)
            for (const {bytes, expected} of plans) { expect(Buffer.from(bytes).equals(Buffer.from(expected))).toBe(true) }
            rows += chunk.rowCount
        }, {...options, mediaHintFastScan: true})
        expect(used).toBe(true)
        expect(rows).toBe(204000)
        expect(aliased).toBe(12)
        expect(adopted).toBe(0)
        expect(parser.consumeLastTermBankWasmParseProfile()?.nativeSegmentedLookupSegments).toBe(12)
    })

    test('actual projected media results move lookup bytes while retained paths and keys remain usable', async () => {
        vi.stubGlobal('Worker', ParserWorker)
        vi.stubGlobal('navigator', {hardwareConcurrency: 4, deviceMemory: 8})
        const store = new TermRecordOpfsStore()
        store.setRawTermBankSourceBytes(1024 ** 3)
        Reflect.set(store, '_recordsDirectoryHandle', {async getFileHandle() { return {} }})
        await store.beginImportSession()
        const encoder = new TextEncoder()
        const banks = Array.from({length: 24}, (_, bank) => encoder.encode(JSON.stringify(
            Array.from({length: 16}, (_, row) => [
                `語${bank}-${row}`,
                `よみ${bank}-${row}`,
                '',
                '',
                row,
                [{type: 'image', path: `images/${bank}-${row}.webp`}],
                row,
                '',
            ]),
        )))
        let mediaCount = 0
        let movedCount = 0
        const used = await parser.parseTermBankWithWasmColumnChunksParallel(banks, 3, async (chunk) => {
            expect(chunk.mediaRows.length).toBeGreaterThan(0)
            const retained = chunk.mediaRows.map(({row, imagePaths}) => ({
                row,
                imagePaths,
                expression: new Uint8Array(row.expressionBytes ?? []),
                reading: new Uint8Array(row.readingBytes ?? []),
            }))
            const prepared = [...(chunk.preparedLookupIndexes?.values() ?? [])]
            expect(prepared).toHaveLength(1)
            const {mediaRows, ...columns} = chunk
            const consumer = createArtifactTermRecordChunkWithResolvedContent(
                {dictionary: 'Projected ownership', dictionaryTotalRows: 6_648_310, ...columns},
                Uint32Array.from({length: chunk.rowCount}, (_, row) => row),
                Float64Array.from({length: chunk.rowCount}, (_, row) => row * 16),
                new Uint32Array(chunk.rowCount).fill(8),
            )
            await store.appendBatchFromArtifactChunkResolvedContent(consumer, new Float64Array(0), new Uint32Array(0), 'raw')
            expect(prepared[0].bytes.byteLength).toBe(0)
            ++movedCount
            mediaCount += mediaRows.length
            for (const {row, imagePaths, expression, reading} of retained) {
                expect(row.termEntryContentBytes).toHaveLength(0)
                expect(row.glossaryJsonBytes).toBeUndefined()
                expect(imagePaths).toHaveLength(1)
                expect(row.expressionBytes).toEqual(expression)
                expect(row.readingBytes).toEqual(reading)
            }
        }, {...options, projectImagePaths: true, mediaHintFastScan: true})
        expect(used).toBe(true)
        expect(mediaCount).toBe(384)
        expect(movedCount).toBeGreaterThan(0)
    })

    test('a registration exception rejects the cleaned-up worker request without hanging', async () => {
        vi.stubGlobal('Worker', ParserWorker)
        vi.stubGlobal('navigator', {hardwareConcurrency: 4, deviceMemory: 8})
        rejectOwnership = true
        const sink = vi.fn()
        await expect(parser.parseTermBankWithWasmColumnChunksParallel(sources(), 3, sink, options))
            .rejects.toThrow('Ownership registration witness')
        expect(sink).not.toHaveBeenCalled()
    })
})
