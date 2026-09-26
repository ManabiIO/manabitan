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

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * @param {number} version
 * @param {string[]} terms
 * @returns {Uint8Array}
 */
function artifact(version, terms) {
    const keys = terms.map((term) => encoder.encode(term))
    const values = terms.map((term) => encoder.encode(JSON.stringify({rules: '', definitionTags: '', termTags: '', glossary: [`definition ${term}\0日本語`]})))
    const arenaBytes = keys.reduce((sum, key) => sum + key.length, 0)
    const indexesStart = 20 + keys.length * 2 + arenaBytes
    const padding = version >= 5 ? (-indexesStart) & 3 : 0
    const headerBytes = version >= 3 ? indexesStart + padding + terms.length * 8 : 12
    const rowsBytes = values.reduce((sum, value, i) => sum + value.length + 20 + (version < 4 ? 8 + keys[i].length * 2 + (version >= 2 ? 1 : 0) : 0), 0)
    const bytes = new Uint8Array(headerBytes + rowsBytes)
    const view = new DataView(bytes.buffer)
    bytes.set(encoder.encode(`MBTB000${version}`))
    view.setUint32(8, terms.length, true)
    let cursor = 12
    if (version >= 3) {
        view.setUint32(cursor, keys.length, true)
        view.setUint32(cursor + 4, arenaBytes, true)
        cursor += 8
        for (const key of keys) {
            view.setUint16(cursor, key.length, true)
            cursor += 2
        }
        for (const key of keys) {
            bytes.set(key, cursor)
            cursor += key.length
        }
        cursor += padding
        for (let list = 0; list < 2; ++list) {
            for (let i = 0; i < terms.length; ++i) {
                view.setUint32(cursor, i, true)
                cursor += 4
            }
        }
    }
    for (let i = 0; i < terms.length; ++i) {
        if (version < 4) {
            for (let repeat = 0; repeat < 2; ++repeat) {
                view.setUint32(cursor, keys[i].length, true)
                cursor += 4
                bytes.set(keys[i], cursor)
                cursor += keys[i].length
            }
            if (version >= 2) { bytes[cursor++] = 1 }
        }
        const [hash1, hash2] = hashTermEntryContentBytesPair(values[i])
        view.setInt32(cursor, i, true)
        view.setInt32(cursor + 4, -1, true)
        view.setUint32(cursor + 8, hash1, true)
        view.setUint32(cursor + 12, hash2, true)
        view.setUint32(cursor + 16, values[i].length, true)
        cursor += 20
        bytes.set(values[i], cursor)
        cursor += values[i].length
    }
    expect(cursor).toBe(bytes.length)
    return bytes
}

/**
 * @param {Uint8Array} bytes
 * @param {Uint8Array} suffix
 * @returns {Uint8Array}
 */
function append(bytes, suffix) {
    const result = new Uint8Array(bytes.length + suffix.length)
    result.set(bytes)
    result.set(suffix, bytes.length)
    return result
}

/**
 * @param {Uint8Array} bytes
 * @param {'returned'|'streamed'|'direct'} mode
 * @returns {Promise<string[]>}
 */
async function decode(bytes, mode) {
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader())
    /** @type {string[]} */
    const terms = []
    const sink = mode === 'returned' ?
        void 0 :
        async (/** @type {import('core').SafeAny} */ chunk) => {
            await Promise.resolve()
            const keys = Array.isArray(chunk) ? chunk.map((row) => row.expressionBytes) : chunk.expressionBytesList.slice(0, chunk.rowCount)
            for (const key of keys) { terms.push(decoder.decode(key)) }
        }
    const result = await importer._decodeTermBankArtifactBytes(bytes, 'term_bank_1.mbtb', 'Consumption fixture', false, 'raw-bytes', sink, 0, 0, mode === 'direct')
    if (mode === 'returned') {
        for (const row of result.termList) { terms.push(decoder.decode(row.expressionBytes)) }
    }
    return terms
}

afterEach(() => { vi.restoreAllMocks() })

for (const version of [1, 2, 3, 4, 5]) {
    describe(`MBTB v${version} exact payload consumption`, () => {
        for (const mode of /** @type {const} */ (['returned', 'streamed', 'direct'])) {
            test(`${mode}: valid offset view preserves both terms and source bytes`, async () => {
                const expected = ['first', 'second 日本語']
                const bytes = artifact(version, expected)
                const parent = new Uint8Array(bytes.length + 19).fill(0x7f)
                parent.set(bytes, 7)
                const before = Uint8Array.from(parent)
                await expect(decode(parent.subarray(7, 7 + bytes.length), mode)).resolves.toEqual(expected)
                expect(parent).toEqual(before)
            })
            test(`${mode}: rejects a trailing byte instead of silently discarding it`, async () => {
                const bytes = append(artifact(version, ['first']), Uint8Array.of(0))
                await expect(decode(bytes, mode)).rejects.toThrow(/trailing bytes/)
            })
            test(`${mode}: rejects a zero-row header hiding a payload`, async () => {
                const bytes = append(artifact(version, []), encoder.encode('unconsumed row bytes'))
                await expect(decode(bytes, mode)).rejects.toThrow(/trailing bytes/)
            })
            test(`${mode}: accepts an exactly empty artifact`, async () => {
                await expect(decode(artifact(version, []), mode)).resolves.toEqual([])
            })
        }
    })
}

/** @returns {import('core').SafeAny} */
function database() {
    /** @type {unknown[]} */
    const pending = []
    return {
        pending,
        isPrepared: () => true,
        setImportOptimizationFlags() {},
        setTermEntryContentDedupEnabled() {},
        setImportDebugLogging() {},
        dictionaryExists: async () => false,
        addWithResult: vi.fn(async () => 1),
        startBulkImport: vi.fn(async () => 'consumption-session'),
        finishBulkImport: vi.fn(async () => ({})),
        abortBulkImport: vi.fn(async () => { pending.length = 0 }),
        deleteDictionaryImportPlaceholder: vi.fn(async () => {}),
        getLastBulkAddTermsMetrics: () => null,
        queuePendingTermContentImportWrites: async () => {},
        bulkAdd: vi.fn(async (/** @type {string} */ store, /** @type {unknown[]} */ entries, /** @type {number} */ start, /** @type {number} */ count) => {
            if (store === 'terms') { pending.push(...entries.slice(start, start + count)) }
        }),
        bulkAddArtifactTermsChunk: vi.fn(async (/** @type {{expressionBytesList: Uint8Array[], rowCount: number}} */ chunk) => { pending.push(...chunk.expressionBytesList.slice(0, chunk.rowCount)) }),
    }
}

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<ArrayBuffer>}
 */
async function archive(bytes) {
    const writer = new ZipWriter(new Uint8ArrayWriter(), {level: 0})
    await writer.add('index.json', new TextReader(JSON.stringify({title: 'Consumption fixture', revision: '1', format: 3})))
    await writer.add('term_bank_1.mbtb', new Uint8ArrayReader(bytes))
    return new Uint8Array(await writer.close()).buffer
}

for (const version of [1, 2, 3, 4, 5]) {
    test(`public ZIP v${version}: trailing data aborts the session instead of publishing a partial dictionary`, async () => {
        const db = database()
        const close = vi.spyOn(ArchiveZipReader.prototype, 'close')
        const bytes = await archive(append(artifact(version, ['first']), artifact(version, ['second'])))
        const result = await new DictionaryImporter(new DictionaryImporterMediaLoader()).importDictionary(db, bytes, {zipUseWebWorkers: false})
        expect(result.result).toBeNull()
        expect(result.errors).toHaveLength(1)
        expect(result.errors[0].message).toMatch(/trailing bytes/)
        expect(db.finishBulkImport).not.toHaveBeenCalled()
        expect(db.abortBulkImport).toHaveBeenCalledOnce()
        expect(db.deleteDictionaryImportPlaceholder).toHaveBeenCalledOnce()
        expect(db.pending).toEqual([])
        expect(close).toHaveBeenCalledOnce()
    })
}

for (const version of [1, 5]) {
    test(`public ZIP v${version}: failure after a completed streaming chunk still rolls back every row`, async () => {
        const db = database()
        const terms = Array.from({length: 75001}, (_, i) => `term-${i}`)
        const bytes = await archive(append(artifact(version, terms), Uint8Array.of(0)))
        const result = await new DictionaryImporter(new DictionaryImporterMediaLoader()).importDictionary(db, bytes, {zipUseWebWorkers: false})
        expect(result.result).toBeNull()
        expect(result.errors).toHaveLength(1)
        expect(result.errors[0].message).toMatch(/trailing bytes/)
        expect(db.bulkAddArtifactTermsChunk).toHaveBeenCalledOnce()
        expect(db.bulkAddArtifactTermsChunk.mock.calls[0][0].rowCount).toBe(75000)
        expect(db.finishBulkImport).not.toHaveBeenCalled()
        expect(db.abortBulkImport).toHaveBeenCalledOnce()
        expect(db.deleteDictionaryImportPlaceholder).toHaveBeenCalledOnce()
        expect(db.pending).toEqual([])
    })
}
