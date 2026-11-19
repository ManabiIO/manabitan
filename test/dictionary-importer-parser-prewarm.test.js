/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter} from '@zip.js/zip.js'
import {afterEach, beforeAll, describe, expect, test, vi} from 'vitest'
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js'
import * as parser from '../ext/js/dictionary/term-bank-wasm-parser.js'
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js'

beforeAll(async () => {
    parser.setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))))
})

afterEach(() => { vi.restoreAllMocks() })

/**
 * @param {{banks?: number, format?: number, image?: boolean}} [options]
 * @returns {Promise<Blob>}
 */
async function archive({banks = 4, format = 3, image = false} = {}) {
    const writer = new ZipWriter(new Uint8ArrayWriter(), {level: 0})
    const options = {useWebWorkers: false}
    await writer.add('index.json', new TextReader(JSON.stringify({title: 'Parser prewarm', revision: '1', format})), options)
    for (let index = 0; index < banks; ++index) {
        const row = [`term-${index}`, '', '', '', 1, ['definition'], index, '']
        await writer.add(`term_bank_${index + 1}.json`, new TextReader(JSON.stringify([row])), options)
    }
    if (image) { await writer.add('unused.png', new Uint8ArrayReader(Uint8Array.of(1, 2, 3)), options) }
    return new Blob([Uint8Array.from(await writer.close())])
}

function database() {
    return {
        isPrepared: () => true,
        setImportOptimizationFlags() {},
        setTermEntryContentDedupEnabled() {},
        setImportDebugLogging() {},
        dictionaryExists: async () => false,
        addWithResult: async () => 1,
        startBulkImport: vi.fn(async () => 'prewarm-session'),
        finishBulkImport: vi.fn(async () => ({})),
        abortBulkImport: vi.fn(async () => {}),
        deleteDictionaryImportPlaceholder: vi.fn(async () => {}),
        getLastBulkAddTermsMetrics: () => null,
        queuePendingTermContentImportWrites: async () => {},
        bulkAdd: vi.fn(async () => {}),
        bulkAddArtifactTermsChunk: vi.fn(async () => {}),
    }
}

/**
 * @param {ReturnType<typeof database>} db
 * @returns {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase}
 */
function asDatabase(db) { return /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (db)) }

/** @type {import('dictionary-importer').ImportDetails} */
const details = {zipUseWebWorkers: false}

describe('session-owned parser prewarm during storage setup', () => {
    test('starts before blocked storage setup and joins cleanup after setup fails', async () => {
        const bytes = await archive()
        const setupStarted = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers())
        const releaseSetup = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers())
        const disposalStarted = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers())
        const releaseDisposal = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers())
        const prewarm = vi.spyOn(parser, 'prewarmParallelTermBankParser').mockResolvedValue(false)
        const dispose = vi.spyOn(parser, 'disposeParallelTermBankParser').mockImplementation(async () => {
            disposalStarted.resolve()
            await releaseDisposal.promise
        })
        const db = database()
        db.startBulkImport.mockImplementation(async () => {
            setupStarted.resolve()
            await releaseSetup.promise
            throw new Error('Storage setup failed')
        })
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader())
        let settled = false
        const pending = importer.importDictionary(asDatabase(db), bytes, details).then((result) => {
            settled = true
            return result
        })
        try {
            await setupStarted.promise
            expect(prewarm).toHaveBeenCalledOnce()
            expect(prewarm.mock.invocationCallOrder[0]).toBeLessThan(db.startBulkImport.mock.invocationCallOrder[0])
            releaseSetup.resolve()
            await disposalStarted.promise
            expect(settled).toBe(false)
            expect(db.finishBulkImport).not.toHaveBeenCalled()
            expect(db.abortBulkImport).not.toHaveBeenCalled()
            releaseDisposal.resolve()
            const result = await pending
            expect(result.result).toBeNull()
            expect(result.errors.some((error) => error.message === 'Storage setup failed')).toBe(true)
            expect(dispose).toHaveBeenCalledOnce()
            expect(db.deleteDictionaryImportPlaceholder).toHaveBeenCalledWith(1)
        } finally {
            releaseSetup.resolve()
            releaseDisposal.resolve()
            await pending
        }
    })

    test.each([
        {name: 'ordinary four-bank source', options: {}, slow: false, expected: true},
        {name: 'small source', options: {banks: 3}, slow: false, expected: false},
        {name: 'legacy format', options: {format: 1}, slow: false, expected: false},
        {name: 'media source', options: {image: true}, slow: false, expected: false},
        {name: 'disabled fast parser', options: {}, slow: true, expected: false},
    ])('preserves prewarm eligibility for $name', async ({options, slow, expected}) => {
        const bytes = await archive(options)
        const prewarm = vi.spyOn(parser, 'prewarmParallelTermBankParser').mockResolvedValue(false)
        const db = database()
        db.startBulkImport.mockRejectedValue(new Error('Stop after setup admission'))
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader())
        importer._disableTermBankWasmFastPath = slow
        const result = await importer.importDictionary(asDatabase(db), bytes, details)
        expect(result.errors.some((error) => error.message === 'Stop after setup admission')).toBe(true)
        expect(prewarm).toHaveBeenCalledTimes(expected ? 1 : 0)
    })

    test('retains normal source import when prewarming cannot start workers', async () => {
        const prewarm = vi.spyOn(parser, 'prewarmParallelTermBankParser').mockResolvedValue(false)
        const dispose = vi.spyOn(parser, 'disposeParallelTermBankParser')
        const db = database()
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader())
        const result = await importer.importDictionary(asDatabase(db), await archive(), details)
        expect(result.errors).toEqual([])
        expect(result.result?.counts?.terms.total).toBe(4)
        expect(prewarm).toHaveBeenCalledOnce()
        expect(dispose).toHaveBeenCalledOnce()
        expect(db.finishBulkImport).toHaveBeenCalledOnce()
        expect(db.abortBulkImport).not.toHaveBeenCalled()
    })
})
