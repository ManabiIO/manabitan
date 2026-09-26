/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */
import {TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter} from '@zip.js/zip.js'
import {afterEach, describe, expect, test, vi} from 'vitest'
import {ZipReader as ArchiveZipReader} from '../ext/lib/zip.js'
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js'
import {hashTermEntryContentBytesPair} from '../ext/js/dictionary/term-entry-content-hash.js'
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js'

/**
 * @param {string} term
 * @returns {Uint8Array}
 */
function artifact(term) {
    const encoder = new TextEncoder()
    const key = encoder.encode(term)
    const content = encoder.encode(JSON.stringify({rules: '', definitionTags: '', termTags: '', glossary: [`definition ${term}`]}))
    const bytes = new Uint8Array(12 + 8 + key.length * 2 + 20 + content.length)
    const view = new DataView(bytes.buffer)
    bytes.set(encoder.encode('MBTB0001'))
    view.setUint32(8, 1, true)
    let cursor = 12
    for (const value of [key, key]) {
        view.setUint32(cursor, value.length, true)
        cursor += 4
        bytes.set(value, cursor)
        cursor += value.length
    }
    const [h1, h2] = hashTermEntryContentBytesPair(content)
    view.setInt32(cursor, 0, true)
    view.setInt32(cursor + 4, -1, true)
    view.setUint32(cursor + 8, h1, true)
    view.setUint32(cursor + 12, h2, true)
    view.setUint32(cursor + 16, content.length, true)
    bytes.set(content, cursor + 20)
    return bytes
}

/**
 * @param {unknown} second
 * @param {{ordinary?: boolean, standalone?: boolean|number, replaceList?: boolean, packedSource?: boolean}} [options]
 * @returns {Promise<ArrayBuffer>}
 */
async function archive(second, {ordinary = false, standalone = false, replaceList = false, packedSource = true} = {}) {
    const banks = [artifact('first'), artifact('second')]
    const writer = new ZipWriter(new Uint8ArrayWriter(), {level: 0})
    await writer.add('index.json', new TextReader(JSON.stringify({title: 'Term manifest completeness', revision: '1', format: 3})))
    const valid = {artifact: 'term_bank_1.mbtb', packedOffset: 0, packedLength: banks[0].length, rows: 1}
    const descriptor = second === 'valid' ? {artifact: 'term_bank_2.mbtb', packedOffset: banks[0].length, packedLength: banks[1].length, rows: 1} : second
    await writer.add('manabitan-import-artifact.json', new TextReader(JSON.stringify({
        termBanks: replaceList ? descriptor : [valid, descriptor],
        packedTermArtifact: {file: 'packed.bin'},
        prunedAuxFiles: true,
    })))
    const packed = new Uint8Array(banks[0].length + banks[1].length)
    packed.set(banks[0])
    packed.set(banks[1], banks[0].length)
    if (packedSource) { await writer.add('packed.bin', new Uint8ArrayReader(packed)) }
    for (let i = 0; i < 2; ++i) {
        if (standalone === true || (typeof standalone === 'number' && i < standalone)) {
            await writer.add(`term_bank_${i + 1}.mbtb`, new Uint8ArrayReader(banks[i]))
        }
        if (ordinary) {
            await writer.add(`term_bank_${i + 1}.json`, new TextReader(JSON.stringify([
                [`source${i + 1}`, '', '', '', 0, [`source definition ${i + 1}`], -1, ''],
            ])))
        }
    }
    await writer.add('tag_bank_1.json', new TextReader(JSON.stringify([['source-tag', 'misc', 0, 'source tag', 0]])))
    return new Uint8Array(await writer.close()).buffer
}

function database() {
    /** @type {string[]} */
    const terms = []
    return {
        terms,
        isPrepared: () => true,
        setImportOptimizationFlags() {},
        setTermEntryContentDedupEnabled() {},
        setImportDebugLogging() {},
        dictionaryExists: async () => false,
        addWithResult: vi.fn(async () => 1),
        startBulkImport: vi.fn(async () => 'term-manifest-session'),
        finishBulkImport: vi.fn(async () => ({})),
        abortBulkImport: vi.fn(async () => {}),
        deleteDictionaryImportPlaceholder: vi.fn(async () => {}),
        getLastBulkAddTermsMetrics: () => null,
        queuePendingTermContentImportWrites: async () => {},
        bulkAdd: vi.fn(async (/** @type {string} */ store, /** @type {import('core').SafeAny[]} */ entries, /** @type {number} */ start, /** @type {number} */ count) => {
            if (store === 'terms') { terms.push(...entries.slice(start, start + count).map((entry) => entry.expression)) }
        }),
        bulkAddArtifactTermsChunk: vi.fn(async (/** @type {{rowCount: number, expressionBytesList: Uint8Array[]}} */ chunk) => {
            const decoder = new TextDecoder()
            terms.push(...chunk.expressionBytesList.slice(0, chunk.rowCount).map((key) => decoder.decode(key)))
        }),
    }
}

/**
 * @param {ReturnType<typeof database>} db
 * @param {ArrayBuffer} bytes
 * @returns {ReturnType<DictionaryImporter['importDictionary']>}
 */
async function importArchive(db, bytes) {
    return await new DictionaryImporter(new DictionaryImporterMediaLoader()).importDictionary(
        /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (db)),
        bytes,
        {zipUseWebWorkers: false},
    )
}

afterEach(() => { vi.restoreAllMocks() })

describe('packed term manifest completeness through public ZIP import', () => {
    test.each([
        null,
        {artifact: 'term_bank_2.mbtb', packedOffset: -1, packedLength: 10},
        {artifact: 'term_bank_2.mbtb', packedOffset: 0, packedLength: 0},
        {artifact: 'term_bank_2.mbtb', packedOffset: Number.MAX_SAFE_INTEGER + 1, packedLength: 10},
        {artifact: 'term_bank_2.mbtb', packedOffset: 0, packedLength: 0.5},
        {artifact: 2, packedOffset: 0, packedLength: 10},
        {artifact: '', packedOffset: 0, packedLength: 10},
    ])('does not publish only the accepted part of a damaged manifest: %j', async (second) => {
        const db = database()
        const close = vi.spyOn(ArchiveZipReader.prototype, 'close')
        await expect(importArchive(db, await archive(second))).rejects.toThrow(/incomplete.*term.*artifact.*manifest/i)
        expect(db.terms).toEqual([])
        expect(close).toHaveBeenCalledOnce()
        expect(db.startBulkImport).not.toHaveBeenCalled()
        expect(db.addWithResult).not.toHaveBeenCalled()
        expect(db.finishBulkImport).not.toHaveBeenCalled()
    })

    test.each([null, {}, 'invalid'])('does not publish an empty packed dictionary for a non-array list: %j', async (second) => {
        const db = database()
        await expect(importArchive(db, await archive(second, {replaceList: true}))).rejects.toThrow(/incomplete.*term.*artifact.*manifest/i)
        expect(db.finishBulkImport).not.toHaveBeenCalled()
    })

    test('a complete packed manifest imports every bank', async () => {
        const db = database()
        const result = await importArchive(db, await archive('valid'))
        expect(result.errors).toEqual([])
        expect(result.result?.counts?.terms.total).toBe(2)
        expect(db.terms).toEqual(['first', 'second'])
        expect(db.finishBulkImport).toHaveBeenCalledOnce()
    })

    test.each([false, true])('damaged optimization metadata falls back to ordinary banks and tags (standalone=%s)', async (standalone) => {
        const db = database()
        const result = await importArchive(db, await archive(null, {ordinary: true, standalone}))
        expect(result.errors).toEqual([])
        expect(result.result?.counts?.terms.total).toBe(2)
        expect(result.result?.counts?.tagMeta.total).toBe(1)
        expect(db.terms).toEqual(['source1', 'source2'])
        expect(db.bulkAddArtifactTermsChunk).not.toHaveBeenCalled()
        expect(db.finishBulkImport).toHaveBeenCalledOnce()
    })

    test.each([0, 1])('does not publish %s of two declared banks when the packed file is missing', async (standalone) => {
        const db = database()
        const close = vi.spyOn(ArchiveZipReader.prototype, 'close')
        await expect(importArchive(db, await archive('valid', {packedSource: false, standalone})))
            .rejects.toThrow(/missing.*term.*artifact/i)
        expect(db.terms).toEqual([])
        expect(close).toHaveBeenCalledOnce()
        expect(db.startBulkImport).not.toHaveBeenCalled()
        expect(db.finishBulkImport).not.toHaveBeenCalled()
    })

    test('a complete standalone replacement remains valid when the packed file is missing', async () => {
        const db = database()
        const result = await importArchive(db, await archive('valid', {packedSource: false, standalone: true}))
        expect(result.errors).toEqual([])
        expect(result.result?.counts?.terms.total).toBe(2)
        expect(db.terms).toEqual(['first', 'second'])
        expect(db.finishBulkImport).toHaveBeenCalledOnce()
    })

    test('missing packed and partial standalone sources still permit ordinary source fallback', async () => {
        const db = database()
        const result = await importArchive(db, await archive('valid', {packedSource: false, standalone: 1, ordinary: true}))
        expect(result.errors).toEqual([])
        expect(result.result?.counts?.terms.total).toBe(2)
        expect(result.result?.counts?.tagMeta.total).toBe(1)
        expect(db.terms).toEqual(['source1', 'source2'])
        expect(db.bulkAddArtifactTermsChunk).not.toHaveBeenCalled()
    })
})
