/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {crc32} from 'node:zlib'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js'
import {createGenerationMediaIndex} from '../ext/js/dictionary/dictionary-generation-media-store.js'
import {startSourceZipMediaPreparation} from '../ext/js/dictionary/source-zip-media-preparation.js'
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js'

/** @typedef {import('../ext/js/dictionary/source-zip-media-preparation.js').SpeculativeSourceMedia} PreparedMedia */
/** @typedef {import('../ext/js/dictionary/dictionary-generation-media-store.js').GenerationMediaIndex} MediaIndex */
/** @typedef {import('dictionary-database').MediaDataArrayBufferContent} MediaRow */

const state = vi.hoisted(() => ({
    available: true,
    cancelled: false,
    events: /** @type {string[]} */ ([]),
    prepared: /** @type {Promise<PreparedMedia|null>} */ (Promise.resolve(null)),
    settle: /** @type {(value: PreparedMedia|null) => void} */ (() => {}),
}))

// The archive adapter, speculative worker and database are external boundaries.
// The complete importer, requirement classification, selection and cleanup run.
vi.mock('../ext/js/dictionary/source-zip-media-preparation.js', () => ({
    startSourceZipMediaPreparation: vi.fn(() => {
        if (!state.available) { return null }
        return {
            result: state.prepared,
            cancel() {
                state.events.push('worker-cancel')
                state.settle(null)
            },
        }
    }),
}))

const IMAGE_COUNT = 8192
const encoder = new TextEncoder()

class LargeArchive extends Blob {
    /** @override */
    get size() { return 129 * 1024 * 1024 }
}

function fixture(/** @type {{missing?: boolean, failSeal?: boolean, rejectWrite?: boolean, onTerms?: () => void}} */ {missing = false, failSeal = false, rejectWrite = false, onTerms = () => {}} = {}) {
    /** @type {import('dictionary-importer').ArchiveFileMap} */
    const fileMap = new Map()
    /** @type {import('../ext/js/dictionary/dictionary-generation-media-store.js').SourceMediaRange[]} */
    const records = []
    /** @type {Uint8Array<ArrayBuffer>[]} */
    const images = []
    /** @type {MediaRow[]} */
    const storedMedia = []
    /** @type {MediaIndex[]} */
    const selectedPlans = []
    const readImage = vi.fn(/** @type {(index: number) => Uint8Array<ArrayBuffer>} */ ((index) => {
        state.events.push('image-read')
        return Uint8Array.from(images[index])
    }))
    const rows = []
    for (let index = 0; index < IMAGE_COUNT; ++index) {
        const path = `img/card${index + 1}.webp`
        const content = Uint8Array.of(index & 255, (index >>> 8) & 255, 255)
        images.push(content)
        records.push({path, packedOffset: index * 3, packedLength: 3, compressionMethod: 0, uncompressedLength: 3, signature: crc32(content)})
        fileMap.set(path, /** @type {import('dictionary-importer').ImportFileEntry} */ (/** @type {unknown} */ ({
            filename: path,
            uncompressedSize: content.length,
            async getData() { return readImage(index) },
        })))
        rows.push([
            `term${index + 1}`,
            `reading${index + 1}`,
            '',
            '',
            0,
            [{type: 'image', path: missing && index === IMAGE_COUNT - 1 ? 'img/missing.webp' : path}],
            index,
            '',
        ])
    }
    for (const [filename, data] of [
        ['index.json', {title: 'Speculative media test', revision: '1', format: 3}],
        ['term_bank_1.json', rows],
    ]) {
        fileMap.set(/** @type {string} */ (filename), {filename: /** @type {string} */ (filename), bytes: encoder.encode(JSON.stringify(data))})
    }
    const blob = new Blob(images)
    const plan = createGenerationMediaIndex(records, blob.size)
    if (plan === null) { throw new Error('Media fixture was not admitted') }
    const prepared = {
        blob,
        plan,
        metrics: {readMs: 1, validationMs: 1, rangeReadCount: 1, rangeReadBytes: blob.size, compressedBytes: blob.size, uncompressedBytes: blob.size},
    }
    const staged = {
        seal: vi.fn(async (/** @type {MediaIndex} */ selected) => {
            if (failSeal) { throw new Error('Staged media write failed') }
            selectedPlans.push(selected)
            state.events.push('seal')
        }),
        discard: vi.fn(async () => { state.events.push('discard') }),
    }
    const database = {
        isPrepared: () => true,
        setImportOptimizationFlags() {},
        setTermEntryContentDedupEnabled() {},
        setImportDebugLogging() {},
        dictionaryExists: async () => false,
        addWithResult: async () => 1,
        startBulkImport: vi.fn(async () => 'media-import-session'),
        finishBulkImport: vi.fn(async () => { state.events.push('commit'); return {} }),
        abortBulkImport: vi.fn(async () => { state.events.push('abort') }),
        deleteDictionaryImportPlaceholder: vi.fn(async () => {}),
        getLastBulkAddTermsMetrics: () => null,
        queuePendingTermContentImportWrites: async () => {},
        canWriteGenerationMedia: () => true,
        stageGenerationMediaPayload: vi.fn(() => staged),
        writeGenerationMedia: vi.fn(async (/** @type {Blob} */ payload, /** @type {MediaIndex} */ selected) => {
            if (rejectWrite) { return false }
            expect(payload).toBe(blob)
            selectedPlans.push(selected)
            return true
        }),
        bulkAdd: vi.fn(async (/** @type {string} */ store, /** @type {unknown[]} */ entries, /** @type {number} */ start, /** @type {number} */ count) => {
            state.events.push(store)
            if (store === 'terms') { onTerms() }
            if (store === 'media') { storedMedia.push(...(/** @type {MediaRow[]} */ (entries.slice(start, start + count)))) }
        }),
    }
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader(), void 0, () => state.cancelled)
    Reflect.set(importer, '_disableTermBankWasmFastPath', true)
    const close = vi.fn(async () => { state.events.push('archive-close') })
    vi.spyOn(importer, '_getFilesFromArchive').mockResolvedValue({
        fileMap,
        zipReader: /** @type {Awaited<ReturnType<DictionaryImporter['_getFilesFromArchive']>>['zipReader']} */ (/** @type {unknown} */ ({close})),
        catalog: 'dense-zip',
    })
    const run = async () => await importer.importDictionary(
        /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (database)),
        new LargeArchive([new Uint8Array(30)]),
        {skipImageMetadata: true, enableTermEntryContentDedup: false, zipUseWebWorkers: false},
    )
    return {run, prepared, database, staged, selectedPlans, storedMedia, images, readImage, close}
}

/** @param {ReturnType<typeof fixture>} f */
function verifyFallback(f) {
    expect(f.storedMedia).toHaveLength(IMAGE_COUNT)
    expect(f.readImage).toHaveBeenCalledTimes(IMAGE_COUNT)
    expect(new Set(f.storedMedia.map(({path}) => path)).size).toBe(IMAGE_COUNT)
    for (let i = 0; i < IMAGE_COUNT; ++i) {
        const row = f.storedMedia[i]
        expect(row.path).toBe(`img/card${i + 1}.webp`)
        expect(new Uint8Array(row.content)).toEqual(f.images[i])
    }
}

beforeEach(() => {
    state.available = true
    state.cancelled = false
    state.events = []
    state.prepared = new Promise((resolve) => { state.settle = resolve })
})

afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
})

describe('speculative packed media import ownership', () => {
    test('publishes every verified reference without duplicate decoding or SQLite media', async () => {
        const f = fixture({onTerms() { state.settle(f.prepared) }})
        const result = await f.run()
        expect(result.errors).toEqual([])
        expect(result.result?.counts?.media.total).toBe(IMAGE_COUNT)
        expect(result.result?.generationMedia).toEqual(f.prepared.plan.descriptor)
        expect(startSourceZipMediaPreparation).toHaveBeenCalledOnce()
        expect(f.readImage).not.toHaveBeenCalled()
        expect(f.storedMedia).toEqual([])
        expect(f.selectedPlans).toHaveLength(1)
        expect(f.selectedPlans[0].index).toBe(f.prepared.plan.index)
        expect(f.staged.seal).toHaveBeenCalledOnce()
        expect(f.database.writeGenerationMedia).not.toHaveBeenCalled()
        expect(f.database.finishBulkImport).toHaveBeenCalledOnce()
        expect(f.close).toHaveBeenCalledOnce()
    })

    test('retains individual prefetch when a speculative worker cannot start', async () => {
        state.available = false
        const f = fixture()
        const result = await f.run()
        expect(result.errors).toEqual([])
        expect(result.result?.counts?.media.total).toBe(IMAGE_COUNT)
        expect(result.result?.generationMedia).toBeUndefined()
        expect(state.events.indexOf('image-read')).toBeLessThan(state.events.indexOf('terms'))
        expect(f.database.stageGenerationMediaPayload).not.toHaveBeenCalled()
        verifyFallback(f)
    })

    test('drains every deferred reference when the worker declines its source', async () => {
        const f = fixture({onTerms() { state.settle(null) }})
        const result = await f.run()
        expect(result.errors).toEqual([])
        expect(result.result?.counts?.media.total).toBe(IMAGE_COUNT)
        expect(result.result?.generationMedia).toBeUndefined()
        expect(state.events.indexOf('terms')).toBeLessThan(state.events.indexOf('image-read'))
        expect(f.database.stageGenerationMediaPayload).not.toHaveBeenCalled()
        verifyFallback(f)
    })

    test('rereads all payloads when retrying after a deferred media write fails', async () => {
        const f = fixture()
        state.settle(null)
        const write = f.database.bulkAdd.getMockImplementation()
        if (typeof write === 'undefined') { throw new Error('Missing database fixture') }
        let failOnce = true
        f.database.bulkAdd.mockImplementation(async (...args) => {
            if (args[0] === 'media' && failOnce) {
                failOnce = false
                throw new Error('Deferred media write failed')
            }
            await write(...args)
        })
        const first = await f.run()
        expect(first.result).toBeNull()
        expect(first.errors.map(({message}) => message)).toEqual(['Deferred media write failed'])
        expect(f.database.abortBulkImport).toHaveBeenCalledOnce()
        expect(f.readImage).toHaveBeenCalled()
        f.readImage.mockClear()
        const retry = await f.run()
        expect(retry.errors).toEqual([])
        expect(retry.result?.counts?.media.total).toBe(IMAGE_COUNT)
        expect(f.database.finishBulkImport).toHaveBeenCalledOnce()
        verifyFallback(f)
    })

    test('preserves every payload if staged and ordinary packed publication both fail', async () => {
        const f = fixture({failSeal: true, rejectWrite: true})
        state.settle(f.prepared)
        const result = await f.run()
        expect(result.errors).toEqual([])
        expect(result.result?.counts?.media.total).toBe(IMAGE_COUNT)
        expect(result.result?.generationMedia).toBeUndefined()
        expect(f.staged.seal).toHaveBeenCalledOnce()
        expect(f.staged.discard).toHaveBeenCalledOnce()
        expect(f.database.writeGenerationMedia).toHaveBeenCalledOnce()
        verifyFallback(f)
    })

    test('does not hide a missing reference behind the speculative index', async () => {
        const f = fixture({missing: true})
        state.settle(f.prepared)
        const result = await f.run()
        expect(result.result).toBeNull()
        expect(result.errors.map(({message}) => message)).toEqual([
            'Could not find image at path "img/missing.webp" for term8192 (reading8192) in Speculative media test',
        ])
        expect(f.staged.seal).not.toHaveBeenCalled()
        expect(f.database.writeGenerationMedia).not.toHaveBeenCalled()
        expect(f.database.abortBulkImport).toHaveBeenCalledOnce()
        expect(f.database.finishBulkImport).not.toHaveBeenCalled()
        expect(f.close).toHaveBeenCalledOnce()
    })

    test('cancels pending speculative preparation before aborting a failed term sink', async () => {
        const f = fixture({onTerms() { throw new Error('Term sink failed') }})
        const result = await f.run()
        expect(result.result).toBeNull()
        expect(result.errors.map(({message}) => message)).toEqual(['Term sink failed'])
        expect(f.readImage).not.toHaveBeenCalled()
        expect(f.database.stageGenerationMediaPayload).not.toHaveBeenCalled()
        expect(f.database.finishBulkImport).not.toHaveBeenCalled()
        expect(f.database.abortBulkImport).toHaveBeenCalledOnce()
        expect(state.events.indexOf('worker-cancel')).toBeLessThan(state.events.indexOf('archive-close'))
        expect(state.events.indexOf('archive-close')).toBeLessThan(state.events.indexOf('abort'))
        expect(f.close).toHaveBeenCalledOnce()
    })

    test('discards staged media when the user cancels after preparation', async () => {
        const f = fixture({onTerms() { state.cancelled = true }})
        state.settle(f.prepared)
        const result = await f.run()
        expect(result.result).toBeNull()
        expect(result.errors.map(({message}) => message)).toEqual(['Dictionary import was cancelled'])
        expect(f.database.stageGenerationMediaPayload).toHaveBeenCalledOnce()
        expect(f.staged.seal).not.toHaveBeenCalled()
        expect(f.staged.discard).toHaveBeenCalledOnce()
        expect(f.readImage).not.toHaveBeenCalled()
        expect(f.database.finishBulkImport).not.toHaveBeenCalled()
        expect(f.database.abortBulkImport).toHaveBeenCalledOnce()
        expect(state.events.indexOf('discard')).toBeLessThan(state.events.indexOf('archive-close'))
        expect(state.events.indexOf('archive-close')).toBeLessThan(state.events.indexOf('abort'))
        expect(f.close).toHaveBeenCalledOnce()
    })
})
