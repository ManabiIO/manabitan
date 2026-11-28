/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {Buffer} from 'node:buffer'
import {readFile} from 'node:fs/promises'
import {crc32, deflateRawSync} from 'node:zlib'
import {beforeAll, describe, expect, test, vi} from 'vitest'
import {createGenerationMediaIndex} from '../ext/js/dictionary/dictionary-generation-media-store.js'
import {preparePackedSourceZipMedia, preparePackedSourceZipMediaEntries, preparePackedSourceZipMediaIndex} from '../ext/js/dictionary/source-zip-media-pack.js'
import {setTermBankWasmModule} from '../ext/js/dictionary/term-bank-wasm-parser.js'
import {RawZipPayloadReader} from '../ext/js/dictionary/term-bank-source-pipeline.js'
import {DenseZipEntryCatalog} from '../ext/js/dictionary/dense-zip-file-map.js'

/** @typedef {Parameters<typeof preparePackedSourceZipMediaEntries>[1][number]} ZipEntry */
const FILE_COUNT = 8192
const encoder = new TextEncoder()
const image = Uint8Array.from({length: 512}, (_, i) => i & 7)
const checksum = crc32(image)

beforeAll(async () => {
    setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))))
})

/** Preserve real bounded Blob reads without storing unrelated archive padding. */
class SparseMediaArchive extends Blob {
    /** @type {Array<[number, number]>} */
    ranges = []

    /** @override */
    get size() { return super.size + 128 * 1024 * 1024 }

    /**
     * @override
     * @param {number} [start]
     * @param {number} [end]
     * @param {string} [type]
     */
    slice(start = 0, end = this.size, type = '') {
        this.ranges.push([start, end])
        if (start < 0 || start > super.size || end > super.size + 0xffff) { throw new Error('Unexpected archive range') }
        return new Blob([super.slice(start, Math.min(end, super.size)), new Uint8Array(Math.max(0, end - super.size))], {type})
    }
}

/**
 * @param {{duplicate?: boolean, badHeader?: number}} [options]
 * @returns {{archive: SparseMediaArchive, files: ZipEntry[]}}
 */
function fixture({duplicate = false, badHeader = -1} = {}) {
    const stored = new Uint8Array(image.length + 5)
    const storedView = new DataView(stored.buffer)
    stored[0] = 1
    storedView.setUint16(1, image.length, true)
    storedView.setUint16(3, image.length ^ 0xffff, true)
    stored.set(image, 5)
    const deflated = new Uint8Array(deflateRawSync(image))
    /** @type {BlobPart[]} */
    const parts = []
    /** @type {ZipEntry[]} */
    const files = []
    let offset = 0
    for (let i = 0; i < FILE_COUNT; ++i) {
        const filename = `img/cc${duplicate && i === FILE_COUNT - 1 ? 1 : i + 1}.webp`
        const rawFilename = encoder.encode(filename)
        const payload = i === 0 ? deflated : stored
        const header = new Uint8Array(30 + rawFilename.length)
        const view = new DataView(header.buffer)
        view.setUint32(0, i === badHeader ? 0 : 0x04034b50, true)
        view.setUint16(8, 8, true)
        view.setUint16(26, rawFilename.length, true)
        header.set(rawFilename, 30)
        files.push(/** @type {ZipEntry} */ (/** @type {unknown} */ ({
            filename,
            rawFilename,
            offset,
            compressionMethod: 8,
            signature: checksum,
            compressedSize: payload.length,
            uncompressedSize: image.length,
            encrypted: false,
        })))
        parts.push(header, payload)
        offset += header.length + payload.length
    }
    return {archive: new SparseMediaArchive(parts), files}
}

/**
 * @param {'entries'|'requirements'} mode
 * @param {SparseMediaArchive} archive
 * @param {ZipEntry[]} files
 * @param {() => void} [checkCancellation]
 * @returns {ReturnType<typeof preparePackedSourceZipMedia>}
 */
function prepare(mode, archive, files, checkCancellation = () => {}) {
    const reader = new RawZipPayloadReader(archive)
    if (mode === 'entries') { return preparePackedSourceZipMediaEntries(archive, files, reader, checkCancellation) }
    const requirements = files.map(({filename}, i) => ({
        type: ['image', 'structured-content-image', 'image-reference'][i % 3], source: {path: filename},
    }))
    return preparePackedSourceZipMedia(archive, requirements, new Map(files.map((file) => [file.filename, file])), reader, checkCancellation)
}

/**
 * @param {ZipEntry[]} files
 * @returns {DenseZipEntryCatalog}
 */
function compactCatalog(files) {
    const filenames = new Uint8Array(files.reduce((sum, {rawFilename}) => sum + rawFilename.length, 0))
    const catalog = new DenseZipEntryCatalog(files.length, filenames)
    let filenameOffset = 0
    for (let row = 0; row < files.length; ++row) {
        const file = files[row]
        filenames.set(file.rawFilename, filenameOffset)
        catalog.addDirectoryMetadata(row, filenameOffset, file.offset, file.compressedSize, file.uncompressedSize, /** @type {0|8} */ (file.compressionMethod), file.signature)
        filenameOffset += file.rawFilename.length
    }
    catalog.finishDirectory()
    return catalog
}

describe('compact source ZIP media catalog', () => {
    test('materializes bounded batches with identical payload reads, sealed index and source bytes', async () => {
        const {archive, files} = fixture()
        const expected = await preparePackedSourceZipMediaIndex(archive, files, new RawZipPayloadReader(archive), () => {})
        if (expected === null) { throw new Error('Expected an indexed source span') }
        const ranges = [...archive.ranges]
        archive.ranges.length = 0
        const catalog = compactCatalog(files)
        const materialize = vi.spyOn(catalog, 'getEntries')
        const actual = await preparePackedSourceZipMediaIndex(archive, catalog, new RawZipPayloadReader(archive), () => {})
        if (actual === null) { throw new Error('Expected a compact indexed source span') }
        expect(materialize.mock.calls).toEqual(Array.from({length: 8}, (_, i) => [i * 1024, (i + 1) * 1024]))
        expect(actual.plan).toEqual(expected.plan)
        expect(archive.ranges).toEqual(ranges)
        expect(Buffer.from(await actual.blob.arrayBuffer()).equals(Buffer.from(await expected.blob.arrayBuffer()))).toBe(true)
        for (const key of /** @type {const} */ (['rangeReadCount', 'rangeReadBytes', 'compressedBytes', 'uncompressedBytes'])) {
            expect(actual[key]).toBe(expected[key])
        }
    })

    test.each(['duplicate-name', 'duplicate-offset', 'wrong-namespace', 'sparse-namespace', 'payload-limit'])('rejects %s before any payload read or entry allocation', async (mode) => {
        const {archive, files} = fixture({duplicate: mode === 'duplicate-name'})
        if (mode === 'duplicate-offset') { files[1].offset = files[0].offset }
        if (mode === 'payload-limit') { files[files.length - 1].uncompressedSize = 4 * 1024 * 1024 + 1 }
        if (mode === 'wrong-namespace' || mode === 'sparse-namespace') {
            const file = files[files.length - 1]
            file.filename = mode === 'wrong-namespace' ? 'different/cc8192.webp' : 'img/cc100000.webp'
            file.rawFilename = encoder.encode(file.filename)
        }
        const catalog = compactCatalog(files)
        const materialize = vi.spyOn(catalog, 'getEntries')
        expect(await preparePackedSourceZipMediaIndex(archive, catalog, new RawZipPayloadReader(archive), () => {})).toBeNull()
        expect(archive.ranges).toEqual([])
        expect(materialize).not.toHaveBeenCalled()
    })

    test('preserves an earlier CRC failure before a later invalid local header', async () => {
        const {archive, files} = fixture({badHeader: FILE_COUNT - 1})
        files[0].signature = (checksum ^ 1) >>> 0
        await expect(preparePackedSourceZipMediaIndex(archive, compactCatalog(files), new RawZipPayloadReader(archive), () => {})).rejects.toMatchObject({
            name: 'DictionarySourceIntegrityError', message: expect.stringContaining('CRC32'),
        })
        expect(archive.ranges).toHaveLength(1)
    })

    test('joins a cancelled read without materializing the next batch', async () => {
        const {archive, files} = fixture()
        const catalog = compactCatalog(files)
        const materialize = vi.spyOn(catalog, 'getEntries')
        const error = new DOMException('Cancelled compact source media', 'AbortError')
        await expect(preparePackedSourceZipMediaIndex(archive, catalog, new RawZipPayloadReader(archive), () => {
            if (archive.ranges.length > 0) { throw error }
        })).rejects.toBe(error)
        expect(archive.ranges).toHaveLength(1)
        expect(materialize).toHaveBeenCalledTimes(1)
    })

    test('retains local filename validation after directory selection', async () => {
        const {archive, files} = fixture()
        files[0].rawFilename[6] = 0x32
        files[1].rawFilename[6] = 0x31
        const catalog = compactCatalog(files)
        await expect(preparePackedSourceZipMediaIndex(archive, catalog, new RawZipPayloadReader(archive), () => {})).rejects.toMatchObject({
            name: 'DictionarySourceIntegrityError', message: expect.stringContaining('local filename'),
        })
        expect(archive.ranges).toHaveLength(1)
    })
})

describe('direct source ZIP media entries', () => {
    test.each(['physical', 'reverse', 'rotated'])('writes the same sealed index and source span for %s input without retaining media records', async (order) => {
        const {archive, files} = fixture()
        if (order === 'reverse') { files.reverse() }
        if (order === 'rotated') { files.push(...files.splice(0, 100)) }
        const packed = await prepare('entries', archive, files)
        if (packed === null) { throw new Error('Expected packed source media') }
        const ranges = [...archive.ranges]
        archive.ranges.length = 0
        for (const file of files) { Object.freeze(file) }
        Object.freeze(files)
        const indexed = await preparePackedSourceZipMediaIndex(archive, files, new RawZipPayloadReader(archive), () => {})
        if (indexed === null) { throw new Error('Expected directly indexed source media') }
        expect(indexed).not.toHaveProperty('records')
        expect(indexed.plan).toEqual(createGenerationMediaIndex(packed.records, packed.blob.size))
        expect(archive.ranges).toEqual(ranges)
        expect(Buffer.from(await indexed.blob.arrayBuffer()).equals(Buffer.from(await packed.blob.arrayBuffer()))).toBe(true)
        expect(indexed.rangeReadBytes).toBe(packed.rangeReadBytes)
        expect(indexed.rangeReadCount).toBe(packed.rangeReadCount)
        expect(indexed.compressedBytes).toBe(packed.compressedBytes)
        expect(indexed.uncompressedBytes).toBe(packed.uncompressedBytes)
    })

    test.each(['duplicate-name', 'duplicate-offset', 'wrong-namespace', 'sparse-namespace'])('declines a %s direct index before payload reads', async (mode) => {
        const {archive, files} = fixture({duplicate: mode === 'duplicate-name'})
        if (mode === 'duplicate-offset') { files[1].offset = files[0].offset }
        if (mode === 'wrong-namespace' || mode === 'sparse-namespace') {
            const file = files[files.length - 1]
            file.filename = mode === 'wrong-namespace' ? 'different/cc8192.webp' : 'img/cc100000.webp'
            file.rawFilename = encoder.encode(file.filename)
        }
        expect(await preparePackedSourceZipMediaIndex(archive, files, new RawZipPayloadReader(archive), () => {})).toBeNull()
        expect(archive.ranges).toEqual([])
    })

    test('preserves an earlier CRC failure before a later invalid header on the direct path', async () => {
        const {archive, files} = fixture({badHeader: FILE_COUNT - 1})
        files[0].signature = (checksum ^ 1) >>> 0
        await expect(preparePackedSourceZipMediaIndex(archive, files, new RawZipPayloadReader(archive), () => {})).rejects.toMatchObject({
            name: 'DictionarySourceIntegrityError', message: expect.stringContaining('CRC32'),
        })
        expect(archive.ranges).toHaveLength(1)
    })

    test('joins a cancelled direct-index read without starting another batch', async () => {
        const {archive, files} = fixture()
        const error = new DOMException('Cancelled direct source media', 'AbortError')
        await expect(preparePackedSourceZipMediaIndex(archive, files, new RawZipPayloadReader(archive), () => {
            if (archive.ranges.length > 0) { throw error }
        })).rejects.toBe(error)
        expect(archive.ranges).toHaveLength(1)
    })

    test('does not associate a replaced batch path with a reserved numeric index slot', async () => {
        const {archive, files} = fixture()
        const reader = new RawZipPayloadReader(archive)
        const readBatch = reader.readBatch.bind(reader)
        vi.spyOn(reader, 'readBatch').mockImplementation(async (...args) => {
            const result = await readBatch(...args)
            if (result !== null) { result.sources[0].filename = 'img/cc2.webp' }
            return result
        })
        expect(await preparePackedSourceZipMediaIndex(archive, files, reader, () => {})).toBeNull()
        expect(archive.ranges).toHaveLength(1)
    })

    test('preserves every record, byte and index slot in nonphysical request order', async () => {
        const {archive, files} = fixture()
        const selected = files.reverse()
        const baseline = await prepare('requirements', archive, selected)
        const ranges = [...archive.ranges]
        archive.ranges.length = 0
        const candidate = await prepare('entries', archive, selected)
        if (baseline === null || candidate === null) { throw new Error('Expected packed source media') }
        expect(candidate.records).toEqual(baseline.records)
        expect(candidate.records).toHaveLength(FILE_COUNT)
        expect(candidate.records[0].path).toBe('img/cc8192.webp')
        expect(candidate.records.at(-1)?.compressionMethod).toBe(8)
        expect(archive.ranges).toEqual(ranges)
        expect(Buffer.from(await candidate.blob.arrayBuffer()).equals(Buffer.from(await baseline.blob.arrayBuffer()))).toBe(true)
        const candidateIndex = createGenerationMediaIndex(candidate.records, candidate.blob.size)
        const baselineIndex = createGenerationMediaIndex(baseline.records, baseline.blob.size)
        if (candidateIndex === null || baselineIndex === null) { throw new Error('Expected packed media indexes') }
        expect(candidateIndex.descriptor).toEqual(baselineIndex.descriptor)
        expect(Buffer.from(candidateIndex.index).equals(Buffer.from(baselineIndex.index))).toBe(true)
        expect(candidate.compressedBytes).toBe(baseline.compressedBytes)
        expect(candidate.uncompressedBytes).toBe(image.length * FILE_COUNT)
        expect(candidate.rangeReadCount).toBe(baseline.rangeReadCount)
        expect(candidate.rangeReadBytes).toBe(baseline.rangeReadBytes)
    })

    test.each(['entries', 'requirements'])('declines duplicate names before payload I/O (%s)', async (mode) => {
        const {archive, files} = fixture({duplicate: true})
        expect(await prepare(/** @type {'entries'|'requirements'} */ (mode), archive, files)).toBeNull()
        expect(archive.ranges).toEqual([])
    })

    test.each(['encrypted', 'method', 'offset', 'raw-name', 'inline', 'mdict'])('preserves metadata admission for %s', async (kind) => {
        const {archive, files} = fixture()
        const file = files.at(-1)
        if (typeof file === 'undefined') { throw new Error('Missing test image') }
        if (kind === 'encrypted') { file.encrypted = true }
        if (kind === 'method') { file.compressionMethod = 99 }
        if (kind === 'offset') { file.offset = archive.size }
        if (kind === 'raw-name') { file.rawFilename[0] = 0xff }
        if (kind === 'inline') { Object.assign(file, {bytes: new Uint8Array(0)}) }
        if (kind === 'mdict') {
            file.filename = 'mdict-media/test.webp'
            file.rawFilename = encoder.encode(file.filename)
        }
        for (const mode of /** @type {const} */ (['entries', 'requirements'])) {
            expect(await prepare(mode, archive, files)).toBeNull()
            expect(archive.ranges).toEqual([])
        }
    })

    test('preserves generic request type, missing-path and exact-name admission', async () => {
        const {archive, files} = fixture()
        const map = new Map(files.map((file) => [file.filename, file]))
        const requirements = files.map(({filename}) => ({type: 'image', source: {path: filename}}))
        requirements[0].type = 'audio'
        expect(await preparePackedSourceZipMedia(archive, requirements, map, new RawZipPayloadReader(archive), () => {})).toBeNull()
        requirements[0].type = 'image'
        requirements[0].source.path = 'alias.webp'
        expect(await preparePackedSourceZipMedia(archive, requirements, map, new RawZipPayloadReader(archive), () => {})).toBeNull()
        map.set('alias.webp', files[0])
        expect(await preparePackedSourceZipMedia(archive, requirements, map, new RawZipPayloadReader(archive), () => {})).toBeNull()
        expect(archive.ranges).toEqual([])
    })

    test('preserves the requested path when a central entry exposes later diagnostic aliases', async () => {
        const {archive, files} = fixture()
        const map = new Map(files.map((file) => [file.filename, file]))
        const requirements = files.map(({filename}) => ({type: 'image', source: {path: filename}}))
        const requestedPath = files[0].filename
        let reads = 0
        Object.defineProperty(files[0], 'filename', {get() { return ++reads === 1 ? requestedPath : 'diagnostic-alias.webp' }})
        const result = await preparePackedSourceZipMedia(archive, requirements, map, new RawZipPayloadReader(archive), () => {})
        expect(result?.records[0].path).toBe(requestedPath)
        expect(reads).toBeGreaterThan(1)
    })

    test('rejects an unsupported requested extension before reading its entry name', async () => {
        const {archive, files} = fixture()
        const requirements = files.map(({filename}) => ({type: 'image', source: {path: filename}}))
        const map = new Map(files.map((file) => [file.filename, file]))
        requirements[0].source.path = 'not-an-image.json'
        map.set('not-an-image.json', files[0])
        Object.defineProperty(files[0], 'filename', {get() { throw new Error('Unsupported media must decline before reading the name') }})
        await expect(preparePackedSourceZipMedia(archive, requirements, map, new RawZipPayloadReader(archive), () => {})).resolves.toBeNull()
        expect(archive.ranges).toEqual([])
    })

    test.each(['entries', 'requirements'])('keeps an earlier CRC failure ahead of a later malformed header (%s)', async (mode) => {
        const {archive, files} = fixture({badHeader: FILE_COUNT - 1})
        files[0].signature = (checksum ^ 1) >>> 0
        await expect(prepare(/** @type {'entries'|'requirements'} */ (mode), archive, files.reverse())).rejects.toMatchObject({
            name: 'DictionarySourceIntegrityError', message: expect.stringContaining('CRC32'),
        })
        expect(archive.ranges).toHaveLength(1)
    })

    test.each(['entries', 'requirements'])('joins a cancelled read and starts no later payload batch (%s)', async (mode) => {
        const {archive, files} = fixture()
        const error = new DOMException('Cancelled source media', 'AbortError')
        await expect(prepare(/** @type {'entries'|'requirements'} */ (mode), archive, files, () => {
            if (archive.ranges.length > 0) { throw error }
        })).rejects.toBe(error)
        expect(archive.ranges).toHaveLength(1)
    })

    test.each(['entries', 'requirements'])('preserves entry-count admission before any read (%s)', async (mode) => {
        const {archive, files} = fixture()
        expect(await prepare(/** @type {'entries'|'requirements'} */ (mode), archive, files.slice(1))).toBeNull()
        expect(archive.ranges).toEqual([])
    })
})
