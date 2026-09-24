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

const encoder = new TextEncoder();

/**
 * @param {string} json
 * @returns {string[]|null}
 */
function scan(json) {
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
    return Reflect.get(importer, '_extractImagePathsFromGlossaryJsonBytes')
        .call(importer, encoder.encode(json));
}

describe('DictionaryImporter fast media path scan', () => {
    test('extracts image paths while ignoring non-image paths', () => {
        expect(scan(JSON.stringify([
            {tag: 'img', path: 'media/a.png'},
            {tag: 'div', path: 'notes/readme.txt'},
            {type: 'image', path: 'media/b.webp'},
        ]))).toEqual(['media/a.png', 'media/b.webp']);
    });

    test('decodes escaped image paths', () => {
        expect(scan(String.raw`[{"tag":"img","path":"media\/a.png"}]`)).toEqual(['media/a.png']);
        expect(scan(JSON.stringify([
            {tag: 'img', path: 'media/"quoted".png'},
            {tag: 'img', path: 'media/back\\slash.jpg'},
        ]))).toEqual(['media/"quoted".png', 'media/back\\slash.jpg']);
    });

    test('returns null for unicode escapes so semantic parsing handles them', () => {
        expect(scan(String.raw`[{"tag":"img","path":"media/\u3042.png"}]`)).toBeNull();
    });

    test('does not treat path-like text as a property', () => {
        expect(scan(JSON.stringify([
            'literal "path":"media/fake.png"',
            {tag: 'span', content: 'path: media/fake.jpg'},
        ]))).toEqual([]);
    });
});
