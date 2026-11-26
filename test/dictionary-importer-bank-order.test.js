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

import {describe, expect, test} from 'vitest';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {DictionaryImporterMediaLoader} from '../ext/js/dictionary/dictionary-importer-media-loader.js';
import {DenseZipFileMap} from '../ext/js/dictionary/dense-zip-file-map.js';

/** @type {import('dictionary-importer').QueryDetails} */
const queryDetails = [['termFiles', /^term_bank_(\d+)\.json$/]];

/**
 * @param {string[]} filenames
 * @returns {string[]}
 */
function sortBanks(filenames) {
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
    const fileMap = /** @type {import('dictionary-importer').ArchiveFileMap} */ (
        /** @type {unknown} */ (new Map(filenames.map((filename) => [filename, {filename}])))
    );
    return (Reflect.get(importer, '_getArchiveFiles').call(importer, fileMap, queryDetails).get('termFiles') ?? [])
        .map(({filename}) => filename);
}

/**
 * @param {string[]} filenames
 * @returns {string[]}
 */
function sortPackedArtifacts(filenames) {
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
    const manifest = new Map(filenames.map((filename) => [filename, {packedOffset: 0, packedLength: 1, rows: 1}]));
    return Reflect.get(importer, '_createPackedTermArtifactFiles').call(importer, manifest)
        .map(({filename}) => filename);
}

describe('DictionaryImporter archive bank ordering', () => {
    test('sorts bank indexes exactly beyond Number.MAX_SAFE_INTEGER', () => {
        expect(sortBanks([
            'term_bank_9007199254740993.json',
            'term_bank_9007199254740992.json',
            'term_bank_9007199254740995.json',
            'term_bank_9007199254740994.json',
        ])).toEqual([
            'term_bank_9007199254740992.json',
            'term_bank_9007199254740993.json',
            'term_bank_9007199254740994.json',
            'term_bank_9007199254740995.json',
        ]);
    });

    test('preserves stable ordering for numerically equal indexes with leading zeros', () => {
        expect(sortBanks([
            'term_bank_0002.json',
            'term_bank_2.json',
            'term_bank_02.json',
            'term_bank_10.json',
            'term_bank_1.json',
        ])).toEqual([
            'term_bank_1.json',
            'term_bank_0002.json',
            'term_bank_2.json',
            'term_bank_02.json',
            'term_bank_10.json',
        ]);
    });

    test('sorts arbitrarily long indexes without numeric conversion', () => {
        expect(sortBanks([
            'term_bank_10000000000000000000000000000000000000000.json',
            'term_bank_9999999999999999999999999999999999999999.json',
            'term_bank_3.json',
        ])).toEqual([
            'term_bank_3.json',
            'term_bank_9999999999999999999999999999999999999999.json',
            'term_bank_10000000000000000000000000000000000000000.json',
        ]);
    });

    test('sorts packed artifact manifest banks without precision loss', () => {
        expect(sortPackedArtifacts([
            'term_bank_9007199254740993.mbtb',
            'term_bank_9007199254740992.mbtb',
            'term_bank_10000000000000000000000000000000000000000.mbtb',
            'term_bank_9999999999999999999999999999999999999999.mbtb',
            'metadata.mbtb',
        ])).toEqual([
            'term_bank_9007199254740992.mbtb',
            'term_bank_9007199254740993.mbtb',
            'term_bank_9999999999999999999999999999999999999999.mbtb',
            'term_bank_10000000000000000000000000000000000000000.mbtb',
            'metadata.mbtb',
        ]);
    });
});

/* eslint-disable @stylistic/semi */
test('classifies dense bank names without materializing unrelated media', () => {
    const names = ['img/cc1.webp', 'term_bank_10.json', 'img/cc2.webp', 'term_bank_2.json', 'nested/index.json', 'term_bank_2.mbtb']
    const map = new DenseZipFileMap(names.length, new TextEncoder().encode(names.join('')), async () => null)
    let position = 0
    for (let row = 0; row < names.length; ++row) {
        map.addDirectoryEntry(row, names[row], position, row * 100, 10, 10, 0, row)
        position += names[row].length
    }
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader())
    expect(importer._findRedundantDirectories(map)).toBe('nested/')
    const entries = /** @type {Map<string, unknown>} */ (Reflect.get(map, '_entries'))
    expect([...entries.values()].every((entry) => typeof entry === 'number')).toBe(true)
    const files = importer._getArchiveFiles(map, queryDetails).get('termFiles')
    expect(files?.map(({filename}) => filename)).toEqual(['term_bank_2.json', 'term_bank_10.json'])
    expect(typeof entries.get('img/cc1.webp')).toBe('number')
    expect(typeof entries.get('img/cc2.webp')).toBe('number')
    expect(typeof entries.get('nested/index.json')).toBe('number')
    expect(importer._hasUsableArtifactTermSource({
        termBanksByArtifact: new Map([
            ['term_bank_2.mbtb', {packedOffset: 0, packedLength: 1, rows: 1}],
            ['term_bank_10.mbtb', {packedOffset: 1, packedLength: 1, rows: 1}],
        ]),
        packedFileName: null,
    }, map)).toBe(false)
    expect(typeof entries.get('img/cc1.webp')).toBe('number')
    expect(typeof entries.get('img/cc2.webp')).toBe('number')
    expect(typeof entries.get('term_bank_2.mbtb')).toBe('number')
})
/* eslint-enable @stylistic/semi */
