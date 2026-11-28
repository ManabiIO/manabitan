/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {TextReader, Uint8ArrayWriter, ZipWriter} from '@zip.js/zip.js'
import {expect, test, vi} from 'vitest'
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js'
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js'

test('releases the compact score plan after the awaited artifact sink', async () => {
    const title = 'Score plan lifetime'
    const count = 16
    const buffer = new ArrayBuffer(4 + count * 2)
    const values = new Int32Array(buffer, 0, 1)
    values[0] = 17
    const scorePlan = {values, keys: new Uint16Array(buffer, 4, count)}
    const term = new TextEncoder().encode('term')
    /** @type {Parameters<import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase['bulkAddArtifactTermsChunk']>[0]} */
    const chunk = {
        dictionary: title,
        rowCount: count,
        expressionBytesList: Array.from({length: count}, () => term),
        readingBytesList: Array.from({length: count}, () => term),
        readingEqualsExpressionList: new Uint8Array(count).fill(1),
        scoreList: null,
        scorePlan,
        sequenceList: new Int32Array(count).fill(-1),
        contentBytesList: Array.from({length: count}, () => new Uint8Array()),
        contentDictNameList: null,
    }
    const sink = vi.fn(async () => {
        expect(chunk.scorePlan).toBe(scorePlan)
        expect(chunk.scoreList).toBeNull()
        await Promise.resolve()
        expect(chunk.scorePlan).toBe(scorePlan)
    })
    const database = {
        isPrepared: () => true,
        setImportOptimizationFlags() {},
        setTermEntryContentDedupEnabled() {},
        setImportDebugLogging() {},
        dictionaryExists: async () => false,
        addWithResult: async () => 1,
        startBulkImport: async () => 'score-plan-lifetime',
        finishBulkImport: async () => ({}),
        abortBulkImport: vi.fn(async () => {}),
        deleteDictionaryImportPlaceholder: async () => {},
        getLastBulkAddTermsMetrics: () => null,
        queuePendingTermContentImportWrites: async () => {},
        bulkAdd: vi.fn(async () => {}),
        bulkAddArtifactTermsChunk: sink,
    }
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader())
    const parse = vi.spyOn(importer, '_readTermBankFileFast').mockImplementation(async (...args) => {
        const onChunk = args[7]
        if (typeof onChunk !== 'function') { throw new Error('Expected the awaited import chunk callback') }
        await onChunk(/** @type {import('dictionary-database').DatabaseTermEntry[]} */ (/** @type {unknown} */ (chunk)), null, {
            processedRows: count, totalRows: count, chunkIndex: 0, chunkCount: 1,
        })
        expect(chunk).not.toHaveProperty('scorePlan')
        expect(chunk.scoreList).toEqual(new Int32Array(0))
        return {termList: [], requirements: null}
    })
    const writer = new ZipWriter(new Uint8ArrayWriter(), {level: 0, useWebWorkers: false})
    await writer.add('index.json', new TextReader(JSON.stringify({title, format: 3, revision: '1'})))
    await writer.add('term_bank_1.json', new TextReader(JSON.stringify(
        Array.from({length: count}, () => ['term', '', '', '', 17, ['definition'], -1, '']),
    )))
    try {
        const outcome = await importer.importDictionary(
            /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (database)),
            new Blob([Uint8Array.from(await writer.close())]),
            {termContentStorageMode: 'raw-bytes', zipUseWebWorkers: false},
        )
        expect(outcome.errors).toEqual([])
        expect(outcome.result?.counts?.terms.total).toBe(count)
        expect(sink).toHaveBeenCalledOnce()
        expect(parse).toHaveBeenCalledOnce()
        expect(database.abortBulkImport).not.toHaveBeenCalled()
    } finally { parse.mockRestore() }
})
