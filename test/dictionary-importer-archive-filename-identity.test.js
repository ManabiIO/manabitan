/*
 * Copyright (C) 2026 Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test} from 'vitest';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {DictionaryImporterMediaLoader} from '../ext/js/dictionary/dictionary-importer-media-loader.js';

const encoder = new TextEncoder();

/**
 * @param {string} filename
 * @param {string|null} rawUtf8Filename
 * @returns {import('@zip.js/zip.js').Entry}
 */
function entry(filename, rawUtf8Filename = null) {
    return /** @type {import('@zip.js/zip.js').Entry} */ (/** @type {unknown} */ ({
        filename,
        rawFilename: rawUtf8Filename === null ? void 0 : encoder.encode(rawUtf8Filename),
    }));
}

/**
 * @param {import('@zip.js/zip.js').Entry[]} entries
 * @returns {import('dictionary-importer').ArchiveFileMap}
 */
function createFileMap(entries) {
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
    return Reflect.get(importer, '_createArchiveFileMap').call(importer, entries);
}

describe('dictionary archive UTF-8 filename aliases', () => {
    test('preserves a leading U+FEFF as filename data', () => {
        const source = entry('legacy-decoded-name.png', '\ufeffmedia/image.png');
        const fileMap = createFileMap([source]);

        expect(fileMap.get('\ufeffmedia/image.png')).toBe(source);
        expect(fileMap.has('media/image.png')).toBe(false);
    });

    test('does not collapse BOM-prefixed and ordinary filenames into an ambiguity', () => {
        const bomPrefixed = entry('legacy-decoded-name.png', '\ufeffmedia.png');
        const ordinary = entry('media.png');

        const fileMap = createFileMap([bomPrefixed, ordinary]);

        expect(fileMap.get('\ufeffmedia.png')).toBe(bomPrefixed);
        expect(fileMap.get('media.png')).toBe(ordinary);
    });

    test('continues to provide a UTF-8 alias when no BOM is present', () => {
        const source = entry('legacy-decoded-name.png', 'media/画像.png');
        const fileMap = createFileMap([source]);

        expect(fileMap.get('media/画像.png')).toBe(source);
        expect(fileMap.get('legacy-decoded-name.png')).toBe(source);
    });
});
