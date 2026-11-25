/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {afterEach, beforeAll, describe, expect, test, vi} from 'vitest'
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js'
import * as parser from '../ext/js/dictionary/term-bank-wasm-parser.js'
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js'

beforeAll(async () => {
    parser.setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))))
})

afterEach(async () => {
    await parser.disposeParallelTermBankParser()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
})

// Exercise the real importer and session around controlled storage acquisition.
// Valid small banks also let a pending first source read settle during cleanup.
function createImport(/** @type {{format?: number, banks?: number, image?: boolean, artifact?: boolean, manifestMedia?: boolean, slow?: boolean, details?: import('dictionary-importer').ImportDetails, shouldCancel?: () => boolean}} */ options = {}) {
    const source = new TextEncoder().encode('[["term","","","",0,["definition"],1,""]]')
    const bankCount = options.banks ?? 4
    const fileMap = new Map(Array.from({length: bankCount}, (_, index) => {
        const filename = `term_bank_${index + 1}.${options.artifact ? 'mbtb' : 'json'}`
        return [filename, {filename, uncompressedSize: source.byteLength}]
    }))
    if (options.image) { fileMap.set('unused.png', {filename: 'unused.png', uncompressedSize: 1}) }
    if (options.manifestMedia) { fileMap.set('manabitan-import-artifact.json', {filename: 'manabitan-import-artifact.json', uncompressedSize: 27}) }
    const close = vi.fn(async () => {})
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader(), void 0, options.shouldCancel)
    importer._disableTermBankWasmFastPath = options.slow === true
    vi.spyOn(importer, '_getFilesFromArchive').mockResolvedValue(/** @type {Awaited<ReturnType<DictionaryImporter['_getFilesFromArchive']>>} */ (/** @type {unknown} */ ({fileMap, zipReader: {close}, catalog: 'zip.js'})))
    vi.spyOn(importer, '_readAndValidateIndex').mockResolvedValue(/** @type {import('dictionary-data').Index} */ ({title: 'Early parser startup', revision: '1', version: options.format ?? 3}))
    vi.spyOn(importer, '_getData').mockImplementation(async (file) => (file.filename === 'manabitan-import-artifact.json' ? '{"includesMediaFiles":true}' : source))
    const stop = new Error('Storage acquisition failed')
    const database = {
        isPrepared: () => true,
        setImportOptimizationFlags() {},
        setTermEntryContentDedupEnabled() {},
        setImportDebugLogging() {},
        dictionaryExists: async () => false,
        addWithResult: async () => 1,
        startBulkImport: vi.fn(/** @returns {Promise<string>} */ async () => { throw stop }),
        finishBulkImport: vi.fn(async () => ({})),
        abortBulkImport: vi.fn(async () => {}),
        deleteDictionaryImportPlaceholder: vi.fn(async () => {}),
        getLastBulkAddTermsMetrics: () => null,
        queuePendingTermContentImportWrites: async () => {},
        bulkAdd: vi.fn(async () => {}),
        bulkAddArtifactTermsChunk: vi.fn(async () => {}),
    }
    const run = async () => await importer.importDictionary(
        /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (database)),
        new ArrayBuffer(0),
        {zipUseWebWorkers: false, ...options.details},
    )
    return {importer, database, close, stop, run}
}

// Track the production pool's real initialization and disposal protocol.
function createParserWorkers() {
    /** @type {PendingWorker[]} */
    const workers = []
    const initialized = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers())
    class PendingWorker {
        constructor() {
            /** @type {Map<string, Set<(event: MessageEvent<unknown>) => void>>} */
            this.listeners = new Map()
            this.terminated = false
            workers.push(this)
        }

        addEventListener(/** @type {string} */ type, /** @type {(event: MessageEvent<unknown>) => void} */ listener) {
            let listeners = this.listeners.get(type)
            if (typeof listeners === 'undefined') {
                listeners = new Set()
                this.listeners.set(type, listeners)
            }
            listeners.add(listener)
        }

        removeEventListener(/** @type {string} */ type, /** @type {(event: MessageEvent<unknown>) => void} */ listener) {
            this.listeners.get(type)?.delete(listener)
        }

        postMessage(/** @type {{type: string}} */ message) {
            expect(message.type).toBe('initialize')
            initialized.resolve()
        }

        ready() {
            for (const listener of this.listeners.get('message') ?? []) {
                listener(/** @type {MessageEvent<unknown>} */ ({data: {type: 'ready'}}))
            }
        }

        terminate() { this.terminated = true }
    }
    vi.stubGlobal('Worker', PendingWorker)
    vi.stubGlobal('navigator', {hardwareConcurrency: 2, deviceMemory: 8})
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']})
    return {workers, initialized}
}

describe('parser prewarm before storage acquisition', () => {
    test.each([
        {name: 'raw format-3 source', options: {}, expected: true},
        {name: 'ignored source images', options: {image: true, details: {skipMediaImport: true}}, expected: true},
        {name: 'image requirements', options: {image: true}, expected: false},
        {name: 'manifest media without selected artifacts', options: {manifestMedia: true}, expected: false},
        {name: 'three banks', options: {banks: 3}, expected: false},
        {name: 'legacy format', options: {format: 1}, expected: false},
        {name: 'disabled WASM', options: {slow: true}, expected: false},
        {name: 'artifact source', options: {artifact: true}, expected: false},
        {name: 'disabled content deduplication', options: {details: {enableTermEntryContentDedup: false}}, expected: false},
        {name: 'baseline content storage', options: {details: {termContentStorageMode: 'baseline'}}, expected: false},
    ])('retains eligibility for $name', async ({options, expected}) => {
        const prewarm = vi.spyOn(parser, 'prewarmParallelTermBankParser').mockResolvedValue(false)
        const setup = createImport(/** @type {Parameters<typeof createImport>[0]} */ (options))
        setup.database.startBulkImport.mockImplementation(async () => {
            expect(prewarm).toHaveBeenCalledTimes(expected ? 1 : 0)
            throw setup.stop
        })
        const result = await setup.run()
        expect(result.errors).toContain(setup.stop)
        expect(setup.database.startBulkImport).toHaveBeenCalledOnce()
        expect(setup.database.abortBulkImport).not.toHaveBeenCalled()
        expect(setup.database.finishBulkImport).not.toHaveBeenCalled()
        expect(setup.database.deleteDictionaryImportPlaceholder).toHaveBeenCalledOnce()
        expect(setup.close).toHaveBeenCalledOnce()
    })

    test('starts workers while storage acquisition is pending and completes the import after both become ready', async () => {
        const {workers, initialized} = createParserWorkers()
        const setup = createImport()
        const storageStarted = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers())
        const storageReady = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers())
        const prewarm = vi.spyOn(parser, 'prewarmParallelTermBankParser')
        setup.database.startBulkImport.mockImplementation(async () => {
            storageStarted.resolve()
            await storageReady.promise
            return 'overlapped-prewarm-session'
        })
        const pending = setup.run()
        try {
            await storageStarted.promise
            expect(prewarm).toHaveBeenCalledOnce()
            await initialized.promise
            expect(workers.length).toBeGreaterThanOrEqual(2)
            expect(setup.database.bulkAdd).not.toHaveBeenCalled()
            expect(setup.database.bulkAddArtifactTermsChunk).not.toHaveBeenCalled()
            for (const worker of workers) { worker.ready() }
        } finally {
            storageReady.resolve()
        }
        const result = await pending
        expect(result.errors).toEqual([])
        expect(result.result?.counts?.terms.total).toBe(4)
        expect(setup.database.finishBulkImport).toHaveBeenCalledOnce()
        expect(setup.database.abortBulkImport).not.toHaveBeenCalled()
        expect(workers.every(({terminated}) => terminated)).toBe(true)
        expect(vi.getTimerCount()).toBe(0)
    })

    test('does not start workers or storage when cancelled before session setup', async () => {
        let cancelled = false
        const setup = createImport({shouldCancel: () => cancelled})
        const prewarm = vi.spyOn(parser, 'prewarmParallelTermBankParser').mockResolvedValue(false)
        setup.database.addWithResult = async () => {
            cancelled = true
            return 1
        }
        const result = await setup.run()
        expect(result.result).toBeNull()
        expect(result.errors.some(({message}) => /cancel/i.test(message))).toBe(true)
        expect(prewarm).not.toHaveBeenCalled()
        expect(setup.database.startBulkImport).not.toHaveBeenCalled()
        expect(setup.database.abortBulkImport).not.toHaveBeenCalled()
        expect(setup.close).toHaveBeenCalledOnce()
    })

    test.each([false, true])('declines speculative prewarm while another run owns the pool (different options=%s)', async (differentOptions) => {
        const {workers, initialized} = createParserWorkers()
        vi.stubGlobal('navigator', {hardwareConcurrency: 4, deviceMemory: 8})
        let cancelled = false
        const source = new TextEncoder().encode('[]')
        const sink = vi.fn()
        const pendingRun = parser.parseTermBankWithWasmColumnChunksParallelLazy(
            Array.from({length: 4}, () => async () => source),
            [2, 2, 2, 2],
            3,
            sink,
            {emitContentSlab: true, experimentalParserWorkers3: false},
            () => cancelled,
        )
        const cancelledRun = expect(pendingRun).rejects.toMatchObject({name: 'AbortError'})
        await initialized.promise
        const workerCount = workers.length
        const speculative = parser.prewarmParallelTermBankParser({experimentalParserWorkers3: differentOptions})
        try {
            // Promise reactions settle before a later event-loop task. A warmup
            // must not wait for the owner to finish or alter its ready waiters.
            const result = await Promise.race([
                speculative,
                new Promise((resolve) => { setImmediate(() => resolve('owner-blocked')) }),
            ])
            expect(result).toBe(false)
            expect(workers).toHaveLength(workerCount)
            expect(workers.every(({terminated}) => !terminated)).toBe(true)
            expect(workers.every(({listeners}) => (listeners.get('message')?.size ?? 0) > 0)).toBe(true)
            expect(sink).not.toHaveBeenCalled()
        } finally {
            cancelled = true
            await vi.advanceTimersByTimeAsync(250)
            await cancelledRun
            await speculative
        }
        expect(workers.every(({terminated}) => terminated)).toBe(true)
        expect(vi.getTimerCount()).toBe(0)
    })

    test.each(['failure', 'cancellation'])('retires a never-ready pool after storage %s without a late worker generation', async (outcome) => {
        let cancelled = false
        const {workers, initialized} = createParserWorkers()
        const setup = createImport({shouldCancel: () => cancelled})
        const prewarm = vi.spyOn(parser, 'prewarmParallelTermBankParser')
        setup.database.startBulkImport.mockImplementation(async () => {
            expect(prewarm).toHaveBeenCalledOnce()
            await initialized.promise
            cancelled = outcome === 'cancellation'
            if (!cancelled) { throw setup.stop }
            return 'early-prewarm-session'
        })
        const result = await setup.run()
        expect(result.result).toBeNull()
        if (cancelled) {
            expect(result.errors.some(({message}) => /cancel/i.test(message))).toBe(true)
            expect(setup.database.abortBulkImport).toHaveBeenCalledWith('early-prewarm-session')
        } else {
            expect(result.errors).toContain(setup.stop)
            expect(setup.database.abortBulkImport).not.toHaveBeenCalled()
        }
        expect(setup.database.finishBulkImport).not.toHaveBeenCalled()
        expect(setup.close).toHaveBeenCalledOnce()
        expect(workers.length).toBeGreaterThanOrEqual(2)
        expect(workers.every(({terminated}) => terminated)).toBe(true)
        expect(workers.every(({listeners}) => [...listeners.values()].every((set) => set.size === 0))).toBe(true)
        expect(vi.getTimerCount()).toBe(0)
        const startup = prewarm.mock.results[0].value
        await expect(startup).resolves.toBe(false)
        expect(workers.every(({terminated}) => terminated)).toBe(true)
    })
})
