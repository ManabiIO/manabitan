/*
 * Copyright (C) 2026  Yomitan Authors
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

import {TextReader, Uint8ArrayWriter, ZipWriter} from '@zip.js/zip.js'
import {afterEach, describe, expect, test, vi} from 'vitest'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js'
import {TermBankSourcePipeline} from '../ext/js/dictionary/term-bank-source-pipeline.js'
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js'

afterEach(() => { vi.restoreAllMocks() })

describe('terminal source cache eligibility', () => {
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader())
    test.each([
        [0, 1, 1, {chunkIndex: 1, chunkCount: 1}, false],
        [0, 3, 3, {chunkIndex: 3, chunkCount: 3}, false],
        [2, 1, 3, {chunkIndex: 2, chunkCount: 2}, false],
        [0, 1, 3, {chunkIndex: 2, chunkCount: 2}, true],
        [2, 1, 3, {chunkIndex: 1, chunkCount: 2}, true],
        [0, 3, 3, {chunkIndex: 2, chunkCount: 3}, true],
        [0, 1, 1, null, true],
        [0, 1, 1, undefined, true],
        [0, 1, 1, {chunkIndex: 0, chunkCount: 0}, true],
        [0, 1, 1, {chunkIndex: 1.5, chunkCount: 1.5}, true],
        [0, 1, 1, {chunkIndex: Infinity, chunkCount: Infinity}, true],
        [0, 1, 1, {chunkIndex: 3, chunkCount: 2}, true],
        [-1, 2, 1, {chunkIndex: 1, chunkCount: 1}, true],
        [1, 0, 1, {chunkIndex: 1, chunkCount: 1}, true],
    ])('retention for source %s + %s / %s and progress %j', (start, count, total, progress, expected) => {
        const retain = Reflect.get(importer, '_shouldRetainRecentTermContentSource')
        expect(retain.call(importer, start, count, total, progress)).toBe(expected)
    })
})

/** @returns {Promise<Uint8Array>} */
async function archive() {
    const writer = new ZipWriter(new Uint8ArrayWriter(), {level: 0})
    const options = {useWebWorkers: false}
    await writer.add('index.json', new TextReader(JSON.stringify({title: 'Terminal sources', revision: '1', format: 3})), options)
    for (let bank = 1; bank <= 2; ++bank) {
        await writer.add(`term_bank_${bank}.json`, new TextReader(JSON.stringify([
            ['entry', '', '', '', 1, ['definition'], bank, ''],
        ])), options)
    }
    return Uint8Array.from(await writer.close())
}

/** @returns {object} */
function chunk() {
    return {
        dictionary: 'Terminal sources',
        rowCount: 1,
        expressionBytesList: [Uint8Array.of(65)],
        readingBytesList: [new Uint8Array()],
        readingEqualsExpressionList: Uint8Array.of(1),
        scoreList: Int32Array.of(0),
        sequenceList: Int32Array.of(1),
        contentBytesList: [],
        contentDictNameList: null,
    }
}

/** @returns {object} */
function database() {
    return {
        isPrepared: () => true,
        setImportOptimizationFlags() {},
        setTermEntryContentDedupEnabled() {},
        setImportDebugLogging() {},
        dictionaryExists: async () => false,
        addWithResult: vi.fn(async () => 1),
        startBulkImport: vi.fn(async () => 'terminal-session'),
        finishBulkImport: vi.fn(async () => ({})),
        abortBulkImport: vi.fn(async () => {}),
        deleteDictionaryImportPlaceholder: vi.fn(async () => {}),
        getLastBulkAddTermsMetrics: () => null,
        queuePendingTermContentImportWrites: async () => {},
        bulkAdd: vi.fn(async () => {}),
        bulkAddArtifactTermsChunk: vi.fn(async () => {}),
    }
}

describe('importer owns terminality across source batches and dictionary sessions', () => {
    test('retains earlier batches and chunks and recomputes the hint in the next dictionary', async () => {
        vi.spyOn(TermBankSourcePipeline.prototype, 'createImportRunPlan').mockReturnValue(null)
        vi.spyOn(TermBankSourcePipeline.prototype, 'createCompressedImportRunPlan').mockReturnValue(null)
        const originalGetBatch = TermBankSourcePipeline.prototype.getBatch
        /**
         * @this {TermBankSourcePipeline}
         * @param {number} start
         * @returns {ReturnType<TermBankSourcePipeline['getBatch']>}
         */
        function singleSourceBatch(start) {
            return originalGetBatch.call(this, start).slice(0, 1)
        }
        vi.spyOn(TermBankSourcePipeline.prototype, 'getBatch').mockImplementation(singleSourceBatch)
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader())
        vi.spyOn(importer, '_readTermBankFileFast').mockImplementation(async (_file, _version, _title, _reverse, _media, _dedup, _mode, onChunk) => {
            if (typeof onChunk !== 'function') { throw new Error('Expected streaming sink') }
            for (let index = 1; index <= 2; ++index) {
                await Reflect.apply(onChunk, null, [chunk(), null, {processedRows: index, totalRows: 2, chunkIndex: index, chunkCount: 2}])
            }
            return {termList: [], requirements: null}
        })
        const db = database()
        const bytes = await archive()
        for (let dictionary = 0; dictionary < 2; ++dictionary) {
            const result = await importer.importDictionary(
                /** @type {DictionaryDatabase} */ (/** @type {unknown} */ (db)),
                new Blob([bytes]),
                /** @type {import('dictionary-importer').ImportDetails} */ ({zipUseWebWorkers: false, useImportSession: true}),
            )
            expect(result.errors).toEqual([])
            expect(result.result).not.toBeNull()
        }
        const writes = Reflect.get(db, 'bulkAddArtifactTermsChunk')
        expect(writes.mock.calls.map((/** @type {unknown[]} */ args) => args[1])).toEqual([
            true, true, true, false, true, true, true, false,
        ])
        expect(Reflect.get(db, 'startBulkImport')).toHaveBeenCalledTimes(2)
        expect(Reflect.get(db, 'finishBulkImport')).toHaveBeenCalledTimes(2)
        expect(Reflect.get(db, 'abortBulkImport')).not.toHaveBeenCalled()
    })
})

describe('terminal source metadata publication', () => {
    test.each([undefined, true, false])('retention %s preserves metadata and exact fallback', async (retainRecentSources) => {
        const db = new DictionaryDatabase()
        const source = Uint8Array.of(1, 2, 3, 4)
        const expected = Uint8Array.from(source)
        const spans = {buffer: source, offsets: Uint32Array.of(0), lengths: Uint32Array.of(4)}
        const stage = Reflect.get(db, '_stageArtifactTermContentMetadata').bind(db)
        const staged = stage([10], [20], [], spans)
        const metrics = {dedupRecentSourceCacheMs: 0, dedupRecentSourceCacheBytes: 0, contentMetadataIndexPublishMs: 0}
        Reflect.get(db, '_publishArtifactTermContentMetadata').call(db, {
            count: 1,
            contentOffsets: new Float64Array(1),
            contentLengths: new Uint32Array(1),
            resolvedContentDictNames: 'raw',
            pendingRowToUniqueIndex: Int32Array.of(0),
            pendingContentBytes: [],
            pendingContentHash1s: [10],
            pendingContentHash2s: [20],
            pendingOffsets: [1000],
            pendingLengths: [4],
            pendingResolvedDictNames: 'raw',
            pendingContentSpans: spans,
            stagedContentMetadata: staged,
            importMetrics: metrics,
            ...(typeof retainRecentSources === 'undefined' ? {} : {retainRecentSources}),
        })
        const meta = Reflect.get(db, '_getTermEntryContentMetaByHashPair').call(db, 10, 20)
        if (typeof meta === 'undefined') { throw new Error('Expected published metadata') }
        expect(meta).toMatchObject({offset: 1000, length: 4, dictName: 'raw'})
        expect(metrics.dedupRecentSourceCacheBytes).toBe(retainRecentSources === false ? 0 : 4)
        expect(Reflect.get(db, '_recentTermContentSourceBatches').size).toBe(retainRecentSources === false ? 0 : 1)
        source.fill(0)
        const read = vi.fn(async () => [{status: 'ok', bytes: expected}])
        Reflect.set(db, '_readTermEntryContentBytesDetailedBatch', read)
        const [result] = await Reflect.get(db, '_findMatchingPersistedTermEntryContentMetaBatch').call(db, [
            {hash1: 10, hash2: 20, contentBytes: expected, primary: meta},
        ])
        expect(result.existingMeta).toEqual(meta)
        expect(result.exactFallback).toBe(true)
        expect(read).toHaveBeenCalledTimes(retainRecentSources === false ? 1 : 0)
        Reflect.get(db, '_rollbackStagedArtifactTermContentMetadata').call(db, staged)
        expect(Reflect.get(db, '_getTermEntryContentMetaByHashPair').call(db, 10, 20)).toBeUndefined()
        expect(Reflect.get(db, '_recentTermContentSourceBatches').size).toBe(0)
    })
})
