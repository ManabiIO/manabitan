/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {afterEach, describe, expect, test, vi} from 'vitest';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';

afterEach(() => {
    vi.restoreAllMocks();
});

/**
 * @param {unknown} index
 * @returns {Promise<import('dictionary-data').Index>}
 */
async function readIndex(index) {
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader(), () => {});
    vi.spyOn(importer, '_getData').mockResolvedValue(JSON.stringify(index));
    const fileMap = new Map([
        ['index.json', /** @type {import('@zip.js/zip.js').Entry} */ (/** @type {unknown} */ ({}))],
    ]);
    return await importer._readAndValidateIndex(fileMap);
}

describe('DictionaryImporter index runtime validation', () => {
    test.each([
        [{title: ['Dictionary'], revision: '1', format: 3}, 'title'],
        [{title: 'Dictionary', revision: 1, format: 3}, 'revision'],
        [{title: 'Dictionary', revision: '1', format: '3'}, 'format'],
        [{title: 'Dictionary', revision: '1'}, 'version'],
        [{title: 'Dictionary', revision: '1', format: 3, sequenced: 1}, 'sequenced'],
        [{title: 'Dictionary', revision: '1', format: 3, frequencyMode: 'other'}, 'frequency mode'],
        [{title: 'Dictionary', revision: '1', format: 3, sourceLanguage: 'EN'}, 'language'],
        [{title: 'Dictionary', revision: '1', format: 3, isUpdatable: false}, 'isUpdatable'],
        [{title: 'Dictionary', revision: '1', format: 3, isUpdatable: true, indexUrl: 'https://example.com/index.json'}, 'update URLs'],
        [{title: 'Dictionary', revision: '1', format: 3, tagMeta: {common: null}}, 'tag metadata object'],
        [{title: 'Dictionary', revision: '1', format: 3, tagMeta: {common: {order: '1'}}}, 'tag metadata fields'],
        [{title: 'Dictionary', revision: '1', format: 3, tagMeta: {common: {unknown: 1}}}, 'tag metadata extra fields'],
    ])('rejects malformed index metadata: %s (%s)', async (index, _label) => {
        await expect(readIndex(index)).rejects.toThrow('Invalid dictionary index');
    });

    test.each([
        {
            title: 'Dictionary',
            revision: '1',
            format: 3,
            sequenced: true,
            frequencyMode: 'rank-based',
            sourceLanguage: 'ja',
            targetLanguage: 'eng',
            tagMeta: {
                common: {
                    category: 'frequency',
                    order: 1,
                    notes: 'common',
                    score: 2,
                },
            },
        },
        {
            title: 'Legacy',
            revision: '2026-09',
            version: 1,
        },
    ])('accepts schema-conforming supported index metadata', async (index) => {
        await expect(readIndex(index)).resolves.toMatchObject({
            title: index.title,
            revision: index.revision,
            version: index.format ?? index.version,
        });
    });

    test('keeps unsupported but schema-valid version reporting distinct', async () => {
        await expect(readIndex({
            title: 'Version two',
            revision: '1',
            format: 2,
        })).rejects.toThrow('Unsupported dictionary format version: 2');
    });
});
