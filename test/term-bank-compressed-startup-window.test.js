/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {beforeAll, expect, test, vi} from 'vitest'
import {DictionarySourceIntegrityError} from '../ext/js/dictionary/dictionary-source-integrity-error.js'
import {TermBankSourcePipeline} from '../ext/js/dictionary/term-bank-source-pipeline.js'
import {
    disposeParallelTermBankParser,
    parseTermBankWithWasmColumnChunksParallelCompressedLazy,
    setTermBankWasmModule,
} from '../ext/js/dictionary/term-bank-wasm-parser.js'

beforeAll(async () => {
    const bytes = await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))
    setTermBankWasmModule(await WebAssembly.compile(bytes))
})

test.each(['complete', 'read-error', 'startup-error', 'cancel', 'pre-cancel'])(
    'keeps compressed startup reads within the ordinary lead and settles ownership on %s',
    async (outcome) => {
        await disposeParallelTermBankParser()
        const sourceCount = 33
        const initialLead = 8
        /** @type {number[]} */
        const reads = []
        /** @type {StartupWorker[]} */
        const workers = []
        let parseCalls = 0
        let abortedReads = 0
        let readCleanupFinished = false
        let cancelled = outcome === 'pre-cancel'
        const readError = new DictionarySourceIntegrityError('Compressed startup read failed')
        /** @type {PromiseWithResolvers<void>} */
        const readCleanup = Promise.withResolvers()
        class StartupWorker extends EventTarget {
            constructor() {
                super()
                this.terminated = false
                workers.push(this)
            }

            postMessage(/** @type {{type: string, id?: number}} */ message) {
                if (message.type === 'initialize') { return }
                ++parseCalls
                queueMicrotask(() => {
                    this.dispatchEvent(new MessageEvent('message', {data: {
                        type: 'result',
                        id: message.id,
                        rowCount: 0,
                        chunk: null,
                        profile: {rowCount: 0, chunkDispatchMs: 0},
                        borrowsWorkerMemory: false,
                        resultSentEpochMs: Date.now(),
                    }}))
                })
            }

            terminate() { this.terminated = true }
        }
        vi.stubGlobal('navigator', {hardwareConcurrency: 2, deviceMemory: 8})
        vi.stubGlobal('Worker', StartupWorker)
        const files = Array.from({length: sourceCount}, (_, index) => ({
            filename: `term_bank_${index + 1}.json`,
            offset: index * 32,
            compressedSize: 2,
            uncompressedSize: 24 * 1024 * 1024,
            compressionMethod: 8,
            signature: 0,
            index,
            getData() {},
        }))
        const pipeline = new TermBankSourcePipeline({
            termFiles: files,
            enabled: true,
            read: async () => { throw new Error('Unexpected uncompressed read') },
            readCompressed: async (file, signal) => {
                const index = Number(Reflect.get(file, 'index'))
                reads.push(index)
                if (outcome === 'read-error' && index === 1) { throw readError }
                if ((outcome === 'cancel' || outcome === 'startup-error') && index === 0) {
                    await new Promise((resolve) => { signal.addEventListener('abort', resolve, {once: true}) })
                    ++abortedReads
                    await readCleanup.promise
                    readCleanupFinished = true
                    signal.throwIfAborted()
                }
                return new Uint8Array([3, 0])
            },
        })
        const plan = pipeline.createCompressedImportRunPlan(0)
        expect(plan).not.toBeNull()
        if (plan === null) { throw new Error('Missing compressed source plan') }
        const parsing = parseTermBankWithWasmColumnChunksParallelCompressedLazy(
            plan.loaders,
            plan.estimatedByteLengths,
            3,
            () => { throw new Error('Empty mock groups must not emit a storage chunk') },
            {emitContentSlab: true},
            () => cancelled,
        )
        const result = parsing.then(() => null, (error) => error)
        try {
            if (outcome === 'pre-cancel') {
                await expect(result).resolves.toMatchObject({name: 'AbortError'})
                expect(reads).toEqual([])
                expect(workers).toHaveLength(0)
                return
            }
            await vi.waitFor(() => { expect(workers).toHaveLength(2) })
            expect(reads).toEqual(Array.from({length: initialLead}, (_, index) => index))
            expect(parseCalls).toBe(0)
            if (outcome === 'cancel') {
                cancelled = true
            } else if (outcome === 'startup-error') {
                workers[0].dispatchEvent(new MessageEvent('message', {data: {
                    type: 'initialization-error', error: {message: 'Startup failed'},
                }}))
            } else {
                for (const worker of workers) {
                    worker.dispatchEvent(new MessageEvent('message', {data: {type: 'ready'}}))
                }
            }
            if (outcome === 'complete') {
                await expect(parsing).resolves.toBe(true)
                expect(reads).toEqual(Array.from({length: sourceCount}, (_, index) => index))
                expect(parseCalls).toBe(sourceCount)
            } else if (outcome === 'read-error') {
                await expect(result).resolves.toMatchObject({name: readError.name, message: readError.message})
            } else {
                await expect(result).resolves.toMatchObject(outcome === 'cancel' ? {name: 'AbortError'} : {message: 'Startup failed'})
                expect(reads).toHaveLength(initialLead)
                expect(parseCalls).toBe(0)
                expect(workers.every((worker) => worker.terminated)).toBe(true)
                const disposal = pipeline.dispose()
                await vi.waitFor(() => { expect(abortedReads).toBe(1) })
                expect(readCleanupFinished).toBe(false)
                readCleanup.resolve()
                await disposal
                expect(readCleanupFinished).toBe(true)
            }
        } finally {
            readCleanup.resolve()
            for (const worker of workers) {
                worker.dispatchEvent(new MessageEvent('message', {data: {
                    type: 'initialization-error', error: {message: 'Test cleanup'},
                }}))
            }
            await result
            await pipeline.dispose()
            await disposeParallelTermBankParser()
            vi.unstubAllGlobals()
        }
    },
)
