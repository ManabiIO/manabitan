/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {crc32} from 'node:zlib'
import {afterEach, beforeAll, describe, expect, test, vi} from 'vitest'
import {DenseZipFileMap} from '../ext/js/dictionary/dense-zip-file-map.js'
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js'
import {RawZipPayloadReader} from '../ext/js/dictionary/term-bank-source-pipeline.js'
import {setTermBankWasmModule} from '../ext/js/dictionary/term-bank-wasm-parser.js'
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js'

vi.mock('../ext/js/dictionary/source-zip-media-preparation.js', () => ({
    startSourceZipMediaPreparation: vi.fn(() => ({result: Promise.resolve(null), cancel() {}})),
}))

const IMAGE_COUNT = 8192
const encoder = new TextEncoder()

/** Expose the large-archive read policy while retaining only actual local data. */
class SparseArchive extends Blob {
    /** @override */
    get size() { return 129 * 1024 * 1024 }
}

/*
 * Only the archive catalog, speculative worker and database are adapters.
 * Local ZIP headers, raw range reads, WASM validation and payload output run.
 */
function fixture(/** @type {{corrupt?: boolean, inline?: boolean}} */ {corrupt = false, inline = false} = {}) {
    const paths = Array.from({length: IMAGE_COUNT}, (_, i) => `img/card${i + 1}.webp`)
    const unexpectedEntryRead = vi.fn(async () => { throw new Error('Expected a checked raw ZIP read') })
    const map = new DenseZipFileMap(IMAGE_COUNT, encoder.encode(paths.join('')), unexpectedEntryRead)
    /** @type {BlobPart[]} */
    const parts = []
    /** @type {Uint8Array<ArrayBuffer>[]} */
    const images = []
    const rows = []
    let offset = 0
    let filenameOffset = 0
    for (let i = 0; i < paths.length; ++i) {
        const path = paths[i]
        const rawName = encoder.encode(path)
        const image = Uint8Array.of(i & 255, (i >>> 8) & 255, 255)
        const checksum = crc32(image)
        const header = new Uint8Array(30 + rawName.length)
        const view = new DataView(header.buffer)
        view.setUint32(0, 0x04034b50, true)
        view.setUint16(4, 20, true)
        view.setUint32(14, checksum, true)
        view.setUint32(18, image.length, true)
        view.setUint32(22, image.length, true)
        view.setUint16(26, rawName.length, true)
        header.set(rawName, 30)
        map.addDirectoryMetadata(i, filenameOffset, offset, image.length, image.length, 0, checksum)
        images.push(image)
        parts.push(header, corrupt && i === 0 ? Uint8Array.of(0, 0, 0) : image)
        offset += header.length + image.length
        filenameOffset += rawName.length
        rows.push([`term${i + 1}`, `reading${i + 1}`, '', '', 0, [{type: 'image', path}], i, ''])
    }
    expect(map.finishDirectory()).toBeNull()
    // The raw reader reserves at most this much local extra-field slack.
    // No archive-sized padding is allocated or read.
    parts.push(new Uint8Array(0xffff))
    if (inline) {
        images[0] = Uint8Array.of(9, 8, 7, 6)
        map.set(paths[0], {filename: paths[0], bytes: images[0]})
    }
    for (const [filename, value] of [
        ['index.json', {title: 'Compact raw media', revision: '1', format: 3}],
        ['term_bank_1.json', rows],
    ]) {
        const path = /** @type {string} */ (filename)
        map.set(path, {filename: path, bytes: encoder.encode(JSON.stringify(value))})
    }
    /** @type {import('dictionary-database').MediaDataArrayBufferContent[]} */
    const media = []
    const database = {
        isPrepared: () => true,
        setImportOptimizationFlags() {},
        setTermEntryContentDedupEnabled() {},
        setImportDebugLogging() {},
        dictionaryExists: async () => false,
        addWithResult: async () => 1,
        startBulkImport: vi.fn(async () => 'raw-media-session'),
        finishBulkImport: vi.fn(async () => ({})),
        abortBulkImport: vi.fn(async () => {}),
        deleteDictionaryImportPlaceholder: vi.fn(async () => {}),
        getLastBulkAddTermsMetrics: () => null,
        queuePendingTermContentImportWrites: async () => {},
        queuePendingTermRecordImportWrites: async () => {},
        canWriteGenerationMedia: () => true,
        stageGenerationMediaPayload: vi.fn(() => { throw new Error('Declined preparation cannot stage') }),
        writeGenerationMedia: vi.fn(async () => { throw new Error('Sparse payloads cannot be packed') }),
        bulkAdd: vi.fn(async (/** @type {string} */ store, /** @type {unknown[]} */ entries, /** @type {number} */ start, /** @type {number} */ count) => {
            if (store === 'terms') {
                // Deferral must retain compact entries until the genuine raw
                // reader needs their metadata after the term sink completes.
                expect(paths.slice(inline ? 1 : 0).every((path) => map.hasUnmaterializedEntry(path))).toBe(true)
            }
            if (store === 'media') { media.push(...(/** @type {import('dictionary-database').MediaDataArrayBufferContent[]} */ (entries.slice(start, start + count)))) }
        }),
    }
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader())
    Reflect.set(importer, '_disableTermBankWasmFastPath', true)
    const close = vi.fn(async () => {})
    vi.spyOn(importer, '_getFilesFromArchive').mockResolvedValue({
        fileMap: map,
        zipReader: /** @type {Awaited<ReturnType<DictionaryImporter['_getFilesFromArchive']>>['zipReader']} */ (/** @type {unknown} */ ({close})),
        catalog: 'dense-zip',
    })
    const run = async () => await importer.importDictionary(
        /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (database)),
        new SparseArchive(parts),
        {skipImageMetadata: true, enableTermEntryContentDedup: false, zipUseWebWorkers: false},
    )
    return {run, paths, images, media, map, database, close, unexpectedEntryRead}
}

beforeAll(async () => {
    setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))))
})

afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
})

describe('compact media fallback through checked raw ZIP batches', () => {
    test.each([false, true])('preserves every payload after preparation declines (inline replacement=%s)', async (inline) => {
        const f = fixture({inline})
        const rawReads = vi.spyOn(RawZipPayloadReader.prototype, 'readBatch')
        const result = await f.run()
        expect(result.errors).toEqual([])
        expect(result.result?.counts?.media.total).toBe(IMAGE_COUNT)
        expect(result.result?.generationMedia).toBeUndefined()
        expect(rawReads).toHaveBeenCalledTimes(8)
        expect(rawReads.mock.calls.flatMap(([files]) => files).some(({filename}) => filename === f.paths[0])).toBe(!inline)
        expect(f.media).toHaveLength(IMAGE_COUNT)
        for (let i = 0; i < IMAGE_COUNT; ++i) {
            expect(f.media[i].path).toBe(f.paths[i])
            expect(new Uint8Array(f.media[i].content)).toEqual(f.images[i])
        }
        expect(f.unexpectedEntryRead).not.toHaveBeenCalled()
        expect(f.database.stageGenerationMediaPayload).not.toHaveBeenCalled()
        expect(f.database.writeGenerationMedia).not.toHaveBeenCalled()
        expect(f.database.finishBulkImport).toHaveBeenCalledOnce()
        expect(f.database.abortBulkImport).not.toHaveBeenCalled()
        expect(f.close).toHaveBeenCalledOnce()
    })

    test('rejects changed payload bytes through native CRC validation before publication', async () => {
        const f = fixture({corrupt: true})
        const result = await f.run()
        expect(result.result).toBeNull()
        expect(result.errors.map(({message}) => message)).toEqual([expect.stringContaining('CRC32')])
        expect(f.media).toEqual([])
        expect(f.unexpectedEntryRead).not.toHaveBeenCalled()
        expect(f.database.finishBulkImport).not.toHaveBeenCalled()
        expect(f.database.abortBulkImport).toHaveBeenCalledOnce()
        expect(f.close).toHaveBeenCalledOnce()
    })
})
