/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test} from 'vitest'
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js'
import {DictionaryImporterMediaLoader} from '../ext/js/dictionary/dictionary-importer-media-loader.js'
import {DenseZipFileMap} from '../ext/js/dictionary/dense-zip-file-map.js'

/**
 * @param {string[]} names
 * @returns {import('dictionary-importer').ArchiveFileMap}
 */
function createFileMap(names) {
    return new Map(names.map((filename) => [
        filename,
        /** @type {import('dictionary-importer').ImportFileEntry} */ (/** @type {unknown} */ ({filename})),
    ]))
}

/**
 * @param {import('dictionary-importer').QueryResult} result
 * @returns {Record<string, string[]>}
 */
function filenames(result) {
    return Object.fromEntries([...result].map(([type, entries]) => [type, entries.map(({filename}) => filename)]))
}

describe('DictionaryImporter built-in bank prefix filtering', () => {
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader())

    test('retains every bank kind, exact numeric ordering, and stable leading-zero ties', () => {
        const fileMap = createFileMap([
            'index.json',
            'img/cc1.webp',
            'term_bank_9007199254740993.json',
            'term_bank_0002.json',
            'term_bank_2.json',
            'term_bank_02.json',
            'term_bank_9007199254740992.json',
            'term_bank_9999999999999999999999999999999999999999.json',
            'term_bank_10000000000000000000000000000000000000000.json',
            'term_bank_10.mbtb',
            'term_bank_2.mbtb',
            'term_meta_bank_2.json',
            'term_meta_bank_1.json',
            'kanji_bank_10.json',
            'kanji_bank_1.json',
            'kanji_meta_bank_1.json',
            'tag_bank_0.json',
        ])

        const selected = filenames(importer._getArchiveFiles(fileMap))
        expect(filenames(importer._getArchiveFiles(fileMap, void 0))).toEqual(selected)
        expect(selected).toEqual({
            termFiles: [
                'term_bank_0002.json',
                'term_bank_2.json',
                'term_bank_02.json',
                'term_bank_9007199254740992.json',
                'term_bank_9007199254740993.json',
                'term_bank_9999999999999999999999999999999999999999.json',
                'term_bank_10000000000000000000000000000000000000000.json',
            ],
            termArtifactFiles: ['term_bank_2.mbtb', 'term_bank_10.mbtb'],
            termMetaFiles: ['term_meta_bank_1.json', 'term_meta_bank_2.json'],
            kanjiFiles: ['kanji_bank_1.json', 'kanji_bank_10.json'],
            kanjiMetaFiles: ['kanji_meta_bank_1.json'],
            tagFiles: ['tag_bank_0.json'],
        })
    })

    test('leaves full filename acceptance to the original case-sensitive bank patterns', () => {
        const names = [
            '',
            't',
            'k',
            'TERM_BANK_1.JSON',
            'Kanji_bank_1.json',
            'nested/term_bank_1.json',
            'img/kanji_bank_1.json',
            '\ufeffterm_bank_1.json',
            'term_bank_１.json',
            'term_bank_-1.json',
            'term_bank_1e2.json',
            'term_bank_.json',
            'term_bank_1.json.bak',
            'term_bank_1.JSON',
            'term_bank_1.mbtb.bak',
            'tag_bank_1.json/',
            'kanji_meta_bank_1.mbtb',
            ...['\n', '\r', '\r\n', '\u2028', '\u2029'].map((suffix) => `term_bank_1.json${suffix}`),
        ]
        expect(filenames(importer._getArchiveFiles(createFileMap(names)))).toEqual({
            termFiles: [],
            termArtifactFiles: [],
            termMetaFiles: [],
            kanjiFiles: [],
            kanjiMetaFiles: [],
            tagFiles: [],
        })
    })

    test('preserves dense catalog laziness for unrelated files', () => {
        const names = ['img/cc1.webp', 'term_bank_10.json', 'img/cc2.webp', 'term_bank_2.json', 'kanji_bank_1.json', 'index.json']
        const map = new DenseZipFileMap(names.length, new TextEncoder().encode(names.join('')), async () => null)
        let position = 0
        for (const [row, name] of names.entries()) {
            map.addDirectoryEntry(row, name, position, row * 100, 10, 10, 0, row)
            position += name.length
        }

        const result = filenames(importer._getArchiveFiles(map))
        expect(result.termFiles).toEqual(['term_bank_2.json', 'term_bank_10.json'])
        expect(result.kanjiFiles).toEqual(['kanji_bank_1.json'])
        const entries = /** @type {Map<string, unknown>} */ (Reflect.get(map, '_entries'))
        for (const name of ['img/cc1.webp', 'img/cc2.webp', 'index.json']) {
            expect(typeof entries.get(name)).toBe('number')
        }
    })

    test('keeps custom patterns, flags and non-bank prefixes on the generic path', () => {
        const fileMap = createFileMap(['image_3.webp', 'image_1.webp', 'TERM_BANK_2.JSON', 'nested\nterm_bank_4.json'])
        const result = importer._getArchiveFiles(fileMap, [
            ['termFiles', /^image_(\d+)\.webp$/],
            ['termArtifactFiles', /^term_bank_(\d+)\.json$/i],
            ['termMetaFiles', /^term_bank_(\d+)\.json$/m],
        ])
        expect(filenames(result)).toEqual({
            termFiles: ['image_1.webp', 'image_3.webp'],
            termArtifactFiles: ['TERM_BANK_2.JSON'],
            termMetaFiles: ['nested\nterm_bank_4.json'],
        })
    })

    test.each(['g', 'y'])('preserves custom %s regex state across filtering, sorting and repeated queries', (flag) => {
        const pattern = new RegExp('^image_(\\d+)\\.webp$', flag)
        /** @type {import('dictionary-importer').QueryDetails} */
        const customQueries = [['termFiles', pattern]]
        const fileMap = createFileMap(['image_1.webp', 'image_2.webp', 'image_3.webp'])

        expect(filenames(importer._getArchiveFiles(fileMap, customQueries))).toEqual({termFiles: ['image_1.webp', 'image_3.webp']})
        expect(pattern.lastIndex).toBe(12)
        expect(filenames(importer._getArchiveFiles(fileMap, customQueries))).toEqual({termFiles: ['image_2.webp']})
        expect(pattern.lastIndex).toBe(0)
    })

    test('does not replace non-global custom regex state or add unrequested bank types', () => {
        const pattern = /^kanji_bank_(\d+)\.json$/
        pattern.lastIndex = 9
        const result = importer._getArchiveFiles(createFileMap(['kanji_bank_2.json', 'term_bank_1.json', 'kanji_bank_1.json']), [['kanjiFiles', pattern]])
        expect(filenames(result)).toEqual({kanjiFiles: ['kanji_bank_1.json', 'kanji_bank_2.json']})
        expect(pattern.lastIndex).toBe(9)
        expect(filenames(importer._getArchiveFiles(createFileMap(['term_bank_1.json']), []))).toEqual({})
    })
})
