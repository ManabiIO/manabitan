/*
 * Copyright (C) 2026 Manabitan authors
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

import {describe, expect, test, vi} from 'vitest'
import {DictionaryImporter, isNativeImageProjectionSourceSizeEligible} from '../ext/js/dictionary/dictionary-importer.js'
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js'

const GIB = 1024 * 1024 * 1024

describe('native single-image projection admission', () => {
    test.each([
        [null, false],
        [-1, false],
        [GIB - 1, false],
        [GIB, true],
        [GIB + 37, true],
        [Number.MAX_SAFE_INTEGER + 1, false],
    ])('source total %s -> %s', (bytes, expected) => {
        expect(isNativeImageProjectionSourceSizeEligible(bytes)).toBe(expected)
    })
})

/**
 * @param {Array<{filename: string, uncompressedSize?: unknown}>} files
 * @returns {number|null}
 */
function sourceBytes(files) {
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader())
    return importer._getRawTermBankSourceBytes(/** @type {Parameters<DictionaryImporter['_getRawTermBankSourceBytes']>[0]} */ (/** @type {unknown} */ (files)))
}

/**
 * Capture source selection after the real bank classifier has run, then stop
 * before import-side writes or term-bank decoding.
 * @param {Array<{filename: string, uncompressedSize?: unknown}>} files
 * @param {Map<string, string|Uint8Array>} [contents]
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function captureFlags(files, contents = new Map()) {
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader())
    const stop = new Error('stop after selected-source flags')
    const fileMap = new Map(files.map((file) => [file.filename, file]))
    Reflect.set(importer, '_getFilesFromArchive', async () => ({fileMap, zipReader: {close: async () => {}}, catalog: 'test'}))
    Reflect.set(importer, '_readAndValidateIndex', async () => ({title: 'Index worker eligibility', revision: '1', version: 3}))
    Reflect.set(importer, '_getData', async (/** @type {{filename: string}} */ file) => {
        const value = contents.get(file.filename)
        if (typeof value === 'undefined') { throw new Error(`Unexpected source read: ${file.filename}`) }
        return value
    })
    /** @type {Record<string, unknown>[]} */
    const flags = []
    const database = {
        isPrepared: () => true,
        dictionaryExists: async () => false,
        setImportDebugLogging() {},
        setTermEntryContentDedupEnabled() {},
        setImportOptimizationFlags: (/** @type {Record<string, unknown>} */ value) => {
            flags.push(value)
            if (flags.length === 2) { throw stop }
        },
    }
    await expect(importer.importDictionary(
        /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (database)),
        new ArrayBuffer(0),
        {zipUseWebWorkers: false},
    )).rejects.toBe(stop)
    return flags
}

describe('raw term-bank source bytes for index worker eligibility', () => {
    test.each([
        [[], 0],
        [[0], 0],
        [[GIB - 1], GIB - 1],
        [[GIB], GIB],
        [[GIB + 1], GIB + 1],
        [[GIB - 1, 0, 1], GIB],
        [[0xffffffff, 1], 0x100000000],
        [[Number.MAX_SAFE_INTEGER], Number.MAX_SAFE_INTEGER],
        [[Number.MAX_SAFE_INTEGER - 7, 7], Number.MAX_SAFE_INTEGER],
    ])('sums safe sizes %j exactly to %s', (sizes, expected) => {
        const values = /** @type {number[]} */ (sizes)
        expect(sourceBytes(values.map((uncompressedSize, index) => ({filename: `term_bank_${index + 1}.json`, uncompressedSize})))).toBe(expected)
    })

    test.each([void 0, null, '1073741824', -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])('declines invalid metadata %s even after reaching the eligibility threshold', (size) => {
        expect(sourceBytes([
            {filename: 'term_bank_1.json', uncompressedSize: GIB},
            {filename: 'term_bank_2.json', uncompressedSize: size},
        ])).toBeNull()
    })

    test('declines missing metadata', () => {
        expect(sourceBytes([{filename: 'term_bank_1.json'}])).toBeNull()
    })

    test.each([[Number.MAX_SAFE_INTEGER, 1], [2 ** 52, 2 ** 52]])('declines overflowing sum %j', (...sizes) => {
        expect(sourceBytes(sizes.map((uncompressedSize, index) => ({filename: `term_bank_${index + 1}.json`, uncompressedSize})))).toBeNull()
    })

    test('reads trailing metadata and declines getter failures without failing import', () => {
        const read = vi.fn(() => { throw new Error('metadata unavailable') })
        expect(sourceBytes([
            {filename: 'term_bank_1.json', uncompressedSize: GIB},
            {filename: 'term_bank_2.json', get uncompressedSize() { return read() }},
        ])).toBeNull()
        expect(read).toHaveBeenCalledOnce()
    })
})

describe('index worker source hint follows importer source selection', () => {
    test('counts only ordinary term banks and resets the initial session flags', async () => {
        const flags = await captureFlags([
            {filename: 'term_bank_1.json', uncompressedSize: GIB},
            {filename: 'term_bank_2.json', uncompressedSize: 37},
            {filename: 'term_meta_bank_1.json', uncompressedSize: Number.MAX_SAFE_INTEGER},
            {filename: 'kanji_bank_1.json', uncompressedSize: Number.MAX_SAFE_INTEGER},
            {filename: 'images/large.png', uncompressedSize: Number.MAX_SAFE_INTEGER},
        ])
        expect(flags[0]).not.toHaveProperty('rawTermBankSourceBytes')
        expect(flags[1].rawTermBankSourceBytes).toBe(GIB + 37)
    })

    test('omits the hint when one selected raw bank has unknown size', async () => {
        const flags = await captureFlags([
            {filename: 'term_bank_1.json', uncompressedSize: GIB},
            {filename: 'term_bank_2.json'},
        ])
        expect(flags[1]).not.toHaveProperty('rawTermBankSourceBytes')
    })

    test('does not count unused raw banks when a complete standalone artifact is selected', async () => {
        const flags = await captureFlags([
            {filename: 'term_bank_1.json', uncompressedSize: GIB},
            {filename: 'term_bank_1.mbtb', uncompressedSize: 64},
        ])
        expect(flags[1]).not.toHaveProperty('rawTermBankSourceBytes')
    })

    test('does not count unused raw banks when a complete packed artifact is selected', async () => {
        const manifest = JSON.stringify({
            termBanks: [{artifact: 'term_bank_1.mbtb', packedOffset: 0, packedLength: 64, rows: 1}],
            packedTermArtifact: {file: 'packed.bin'},
        })
        const flags = await captureFlags([
            {filename: 'term_bank_1.json', uncompressedSize: GIB},
            {filename: 'manabitan-import-artifact.json', uncompressedSize: manifest.length},
            {filename: 'packed.bin', uncompressedSize: 64},
        ], new Map(/** @type {[string, string|Uint8Array][]} */ ([
            ['manabitan-import-artifact.json', manifest],
            ['packed.bin', new Uint8Array(64)],
        ])))
        expect(flags[1]).not.toHaveProperty('rawTermBankSourceBytes')
    })

    test('keeps an empty raw source ineligible', async () => {
        const flags = await captureFlags([{filename: 'images/large.png', uncompressedSize: GIB}])
        expect(flags[1].rawTermBankSourceBytes).toBe(0)
    })
})
