/*
 * Copyright (C) 2026  Yomitan Authors
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
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';

/**
 * Resolve import flags before deliberately aborting archive setup.
 * @param {import('dictionary-importer').ImportDetails} details
 * @returns {Promise<Record<string, unknown>>}
 */
async function captureImportFlags(details) {
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
    Reflect.set(importer, '_getFilesFromArchive', async () => {
        throw new Error('stop after import flags');
    });
    let flags = null;
    const database = {
        isPrepared: () => true,
        setImportOptimizationFlags: (/** @type {Record<string, unknown>} */ value) => { flags = value; },
    };

    const result = await importer.importDictionary(
        /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (database)),
        new ArrayBuffer(0),
        details,
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toBe('stop after import flags');
    expect(flags).not.toBeNull();
    return /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (flags));
}

describe('DictionaryImporter term-content storage mode', () => {
    test('honors an explicit baseline request', async () => {
        const flags = await captureImportFlags({termContentStorageMode: 'baseline'});
        expect(flags.termContentStorageMode).toBe('baseline');
    });

    test('keeps raw-bytes as the default', async () => {
        const flags = await captureImportFlags({});
        expect(flags.termContentStorageMode).toBe('raw-bytes');
    });

    test('honors an explicit raw-bytes request', async () => {
        const flags = await captureImportFlags({termContentStorageMode: 'raw-bytes'});
        expect(flags.termContentStorageMode).toBe('raw-bytes');
    });
});
