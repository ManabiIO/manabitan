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
    test.each([0, 1024])('classifies all built-in bank types with %s unrelated media entries', (mediaCount) => {
        const filenames = [
            'index.json',
            'img/cc1.webp',
            'nested/term_bank_1.json',
            'term_bank_9007199254740993.json',
            'term_bank_9007199254740992.json',
            'term_bank_02.json',
            'term_bank_2.json',
            'term_bank_0002.json',
            'term_bank_2.mbtb',
            'term_bank_1.mbtb',
            'term_meta_bank_1.json',
            'kanji_bank_1.json',
            'kanji_meta_bank_1.json',
            'tag_bank_1.json',
            'kanji_bank_1.mbtb',
            'term_bank_1.json.png',
            'tag_bank_.json',
        ];
        for (let i = 0; i < mediaCount; ++i) { filenames.push(`img/unused${i}.webp`); }
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const fileMap = /** @type {import('dictionary-importer').ArchiveFileMap} */ (
            /** @type {unknown} */ (new Map(filenames.map((filename) => [filename, {filename}])))
        );
        const result = importer._getArchiveFiles(fileMap);
        expect([...result].map(([type, files]) => [type, files.map(({filename}) => filename)])).toEqual([
            ['termFiles', ['term_bank_02.json', 'term_bank_2.json', 'term_bank_0002.json', 'term_bank_9007199254740992.json', 'term_bank_9007199254740993.json']],
            ['termArtifactFiles', ['term_bank_1.mbtb', 'term_bank_2.mbtb']],
            ['termMetaFiles', ['term_meta_bank_1.json']],
            ['kanjiFiles', ['kanji_bank_1.json']],
            ['kanjiMetaFiles', ['kanji_meta_bank_1.json']],
            ['tagFiles', ['tag_bank_1.json']],
        ]);
    });

    test.each([0, 1024])('keeps aliases and custom query ordering with %s unrelated media entries', (mediaCount) => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const first = {filename: 'term_bank_2.json'};
        const second = {filename: 'term_bank_10.json'};
        const unmatched = {filename: 'other.json'};
        const fileMap = /** @type {import('dictionary-importer').ArchiveFileMap} */ (
            /** @type {unknown} */ (new Map([
                ['term_bank_1.json', second],
                ['term_bank_20.json', first],
                ['term_bank_3.json', unmatched],
                ['image_1.png', second],
                ['image_2.png', first],
            ]))
        );
        for (let i = 0; i < mediaCount; ++i) {
            const filename = `img/unused${i}.webp`;
            fileMap.set(filename, /** @type {import('dictionary-importer').ImportFileEntry} */ (/** @type {unknown} */ ({filename})));
        }
        expect(importer._getArchiveFiles(fileMap).get('termFiles')).toEqual([first, second, unmatched]);
        const custom = importer._getArchiveFiles(fileMap, [['images', /^image_(\d+)\.png$/]]);
        expect([...custom]).toEqual([['images', [second, first]]]);
    });

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
