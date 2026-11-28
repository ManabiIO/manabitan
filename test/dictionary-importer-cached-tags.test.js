/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {TextReader, Uint8ArrayWriter, ZipWriter} from '@zip.js/zip.js'
import {afterEach, beforeAll, expect, test, vi} from 'vitest'
import {BlobReader, TextWriter as BundledTextWriter, Uint8ArrayWriter as BundledByteWriter, ZipReader} from '../ext/lib/zip.js'
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js'
import {DictionarySourceIntegrityError} from '../ext/js/dictionary/dictionary-source-integrity-error.js'
import {DictionaryZipReadScope} from '../ext/js/dictionary/dictionary-zip-read-scope.js'
import {RawZipPayloadReader} from '../ext/js/dictionary/term-bank-source-pipeline.js'
import * as parser from '../ext/js/dictionary/term-bank-wasm-parser.js'
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js'

// The bundle uses the installed ZIP implementation; its ambient declarations
// still describe the legacy zip.js API.
const TextWriter = /** @type {typeof import('@zip.js/zip.js').TextWriter} */ (/** @type {unknown} */ (BundledTextWriter))
const ByteWriter = /** @type {typeof import('@zip.js/zip.js').Uint8ArrayWriter} */ (/** @type {unknown} */ (BundledByteWriter))

beforeAll(async () => {
    parser.setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))))
})

afterEach(() => { vi.restoreAllMocks() })

/**
 * @param {number} level
 * @returns {Promise<{text: string, bytes: Uint8Array, reader: import('@zip.js/zip.js').ZipReader<Blob>, term: import('@zip.js/zip.js').Entry, tag: import('@zip.js/zip.js').Entry, raw: RawZipPayloadReader, importer: DictionaryImporter}>}
 */
async function fixture(level = 6) {
    const text = '\ufeff' + JSON.stringify([['日本語', 'name', 0, '意味', 0]])
    const zip = new ZipWriter(new Uint8ArrayWriter(), {level})
    await zip.add('term_bank_1.json', new TextReader('[]'), {useWebWorkers: false})
    await zip.add('tag_bank_1.json', new TextReader(text), {useWebWorkers: false})
    const bytes = Uint8Array.from(await zip.close())
    const blob = new Blob([bytes])
    const reader = /** @type {import('@zip.js/zip.js').ZipReader<Blob>} */ (/** @type {unknown} */ (new ZipReader(new BlobReader(blob))))
    const entries = await reader.getEntries()
    const term = entries.find((entry) => entry.filename === 'term_bank_1.json')
    const tag = entries.find((entry) => entry.filename === 'tag_bank_1.json')
    if (!term || !tag) { throw new Error('Missing fixture entry') }
    const raw = new RawZipPayloadReader(blob)
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader())
    Reflect.set(importer, '_zipUseWebWorkers', false)
    return {text, bytes, reader, term, tag, raw, importer}
}

test.each([0, 6])('cached tag text preserves decoding and conversion with ZIP level %i', async (level) => {
    const {reader, term, tag, raw, importer} = await fixture(level)
    try {
        const expected = await importer._readFileSequence([tag], (entry) => entry, 'test')
        await raw.read(term, new AbortController().signal)
        const ordinary = vi.spyOn(tag, 'getData').mockRejectedValue(new Error('Ordinary decoder must not run'))
        const readScope = new DictionaryZipReadScope(() => {})
        Reflect.set(importer, '_directZipReads', readScope)
        const tracked = vi.spyOn(readScope, 'read')
        await expect(importer._readFileSequence([tag], (entry) => entry, 'test', raw)).resolves.toEqual(expected)
        expect(ordinary).not.toHaveBeenCalled()
        expect(tracked).toHaveBeenCalledOnce()
        await readScope.dispose()
    } finally {
        await reader.close()
    }
})

test.each(['cold-cache', 'oversized', 'unsupported', 'binary'])('retains ordinary decoding for %s input', async (mode) => {
    const {reader, term, tag, raw, importer} = await fixture()
    try {
        if (mode !== 'cold-cache') { await raw.read(term, new AbortController().signal) }
        if (mode === 'oversized') { Reflect.set(tag, 'uncompressedSize', 64 * 1024 + 1) }
        if (mode === 'unsupported') { Reflect.set(tag, 'compressionMethod', 99) }
        const ordinary = vi.spyOn(tag, 'getData').mockResolvedValue('ordinary')
        const batchRead = vi.spyOn(raw, 'readBatch')
        const writer = mode === 'binary' ? new ByteWriter() : new TextWriter()
        await expect(importer._getData(tag, writer, void 0, raw)).resolves.toBe('ordinary')
        expect(ordinary).toHaveBeenCalledOnce()
        if (mode !== 'unsupported') { expect(batchRead).not.toHaveBeenCalled() }
        if (mode === 'cold-cache') { expect(raw.supportsCachedBatchReads()).toBe(false) }
    } finally {
        await reader.close()
    }
})

test.each(['crc', 'size', 'filename'])('cached tags reject %s corruption without decoded fallback', async (kind) => {
    const {reader, term, tag, raw, importer} = await fixture()
    try {
        await raw.read(term, new AbortController().signal)
        if (kind === 'crc') { Reflect.set(tag, 'signature', (tag.signature ^ 1) >>> 0) }
        if (kind === 'size') { Reflect.set(tag, 'uncompressedSize', tag.uncompressedSize + 1) }
        if (kind === 'filename') {
            const wrong = Uint8Array.from(tag.rawFilename)
            wrong[0] ^= 1
            Reflect.set(tag, 'rawFilename', wrong)
        }
        const ordinary = vi.spyOn(tag, 'getData').mockRejectedValue(new Error('Forbidden integrity fallback'))
        await expect(importer._getData(tag, new TextWriter(), void 0, raw)).rejects.toBeInstanceOf(DictionarySourceIntegrityError)
        expect(ordinary).not.toHaveBeenCalled()
    } finally {
        await reader.close()
    }
})

test('a native asset failure retains the ZIP decoder and pre-cancel starts no read', async () => {
    const {reader, term, tag, raw, importer} = await fixture()
    try {
        await raw.read(term, new AbortController().signal)
        vi.spyOn(parser, 'inflateCompressedZipMediaBatchWasm').mockRejectedValue(new Error('Native asset unavailable'))
        const ordinary = vi.spyOn(tag, 'getData').mockResolvedValue('ordinary')
        await expect(importer._getData(tag, new TextWriter(), void 0, raw)).resolves.toBe('ordinary')
        expect(ordinary).toHaveBeenCalledOnce()
        ordinary.mockClear()
        const batchRead = vi.spyOn(raw, 'readBatch')
        const aborted = AbortSignal.abort()
        await expect(importer._getData(tag, new TextWriter(), aborted, raw)).rejects.toMatchObject({name: 'AbortError'})
        expect(batchRead).not.toHaveBeenCalled()
        expect(ordinary).not.toHaveBeenCalled()
    } finally {
        await reader.close()
    }
})

test.each(['resolve', 'reject'])('scope disposal joins pending native %s and exposes no fallback', async (completion) => {
    const {reader, term, tag, raw, importer} = await fixture()
    const admitted = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers())
    const resume = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers())
    const readScope = new DictionaryZipReadScope(() => {})
    const inflate = parser.inflateCompressedZipMediaBatchWasm
    Reflect.set(importer, '_directZipReads', readScope)
    try {
        await raw.read(term, new AbortController().signal)
        vi.spyOn(parser, 'inflateCompressedZipMediaBatchWasm').mockImplementation(async (sources) => {
            const result = await inflate(sources)
            admitted.resolve()
            await resume.promise
            if (completion === 'reject') { throw new Error('Native asset unavailable') }
            return result
        })
        const ordinary = vi.spyOn(tag, 'getData').mockRejectedValue(new Error('Cancelled read must not fall back'))
        const pending = importer._getData(tag, new TextWriter(), void 0, raw)
        const rejection = expect(pending).rejects.toMatchObject({name: 'AbortError'})
        await admitted.promise
        let disposed = false
        const disposal = readScope.dispose().then(() => { disposed = true })
        await Promise.resolve()
        expect(disposed).toBe(false)
        resume.resolve()
        await Promise.all([rejection, disposal])
        expect(disposed).toBe(true)
        expect(ordinary).not.toHaveBeenCalled()
    } finally {
        resume.resolve()
        await readScope.dispose()
        await reader.close()
    }
})
