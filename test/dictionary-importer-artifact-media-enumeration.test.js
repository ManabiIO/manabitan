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

describe('DictionaryImporter artifact media enumeration', () => {
    test('retains media order, type, path, and entry identity', () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const png = {filename: 'images/a.png'};
        const json = {filename: 'term_bank_1.json'};
        const jpeg = {filename: 'images/b.JPEG'};
        const css = {filename: 'styles.css'};
        const webp = {filename: 'images/c.webp'};
        const fileMap = new Map([
            [png.filename, png],
            [json.filename, json],
            [jpeg.filename, jpeg],
            [css.filename, css],
            [webp.filename, webp],
        ]);

        const rows = Reflect.get(importer, '_getArchiveImageMediaFiles').call(importer, fileMap);

        expect(rows).toEqual([
            {path: 'images/a.png', mediaType: 'image/png', fileEntry: png},
            {path: 'images/b.JPEG', mediaType: 'image/jpeg', fileEntry: jpeg},
            {path: 'images/c.webp', mediaType: 'image/webp', fileEntry: webp},
        ]);
        expect(rows[0].fileEntry).toBe(png);
        expect(rows[1].fileEntry).toBe(jpeg);
        expect(rows[2].fileEntry).toBe(webp);
    });

    test('returns an empty list when the archive has no image media', () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const fileMap = new Map([
            ['index.json', {filename: 'index.json'}],
            ['term_bank_1.json', {filename: 'term_bank_1.json'}],
            ['styles.css', {filename: 'styles.css'}],
        ]);

        expect(Reflect.get(importer, '_getArchiveImageMediaFiles').call(importer, fileMap)).toEqual([]);
    });
});
