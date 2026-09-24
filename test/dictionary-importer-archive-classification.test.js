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
const queryDetails = [
    ['termFiles', /^term_bank_(\d+)\.json$/],
    ['termArtifactFiles', /^term_bank_(\d+)\.mbtb$/],
    ['termMetaFiles', /^term_meta_bank_(\d+)\.json$/],
    ['kanjiFiles', /^kanji_bank_(\d+)\.json$/],
    ['kanjiMetaFiles', /^kanji_meta_bank_(\d+)\.json$/],
    ['tagFiles', /^tag_bank_(\d+)\.json$/],
];

/**
 * @param {boolean} prefilter
 * @returns {import('dictionary-importer').QueryResult}
 */
function classify(prefilter) {
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
    /** @type {Array<[string, {filename: string}]>} */
    const entries = [
        ['term_bank_2.json', {filename: 'term_bank_2.json'}],
        ['term_bank_1.json', {filename: 'term_bank_1.json'}],
        ['term_bank_2.mbtb', {filename: 'term_bank_2.mbtb'}],
        ['term_meta_bank_1.json', {filename: 'term_meta_bank_1.json'}],
        ['kanji_bank_1.json', {filename: 'kanji_bank_1.json'}],
        ['kanji_meta_bank_1.json', {filename: 'kanji_meta_bank_1.json'}],
        ['tag_bank_1.json', {filename: 'tag_bank_1.json'}],
        ['unrelated.json', {filename: 'unrelated.json'}],
        ['term_bank_99.JSON', {filename: 'term_bank_99.JSON'}],
    ];
    for (let i = 0; i < 600; ++i) {
        entries.push([`media/${i}.png`, {filename: `media/${i}.png`}]);
    }
    const fileMap = /** @type {import('dictionary-importer').ArchiveFileMap} */ (
        /** @type {unknown} */ (new Map(entries))
    );
    return Reflect.get(importer, '_getArchiveFiles').call(importer, fileMap, queryDetails, prefilter);
}

describe('DictionaryImporter archive bank classification prefilter', () => {
    test('preserves bank classification and numeric sorting', () => {
        const baseline = classify(false);
        const filtered = classify(true);

        expect(filtered).toEqual(baseline);
        expect(filtered.get('termFiles')?.map((entry) => entry.filename)).toEqual([
            'term_bank_1.json',
            'term_bank_2.json',
        ]);
        expect(filtered.get('termArtifactFiles')?.map((entry) => entry.filename)).toEqual([
            'term_bank_2.mbtb',
        ]);
        expect(filtered.get('termMetaFiles')).toHaveLength(1);
        expect(filtered.get('kanjiFiles')).toHaveLength(1);
        expect(filtered.get('kanjiMetaFiles')).toHaveLength(1);
        expect(filtered.get('tagFiles')).toHaveLength(1);
    });
});
