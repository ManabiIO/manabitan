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

import {describe, expect, test, vi} from 'vitest';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';

describe('DictionaryImporter media concurrency', () => {
    test('scheduler still processes every item when given NaN concurrency', async () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const run = Reflect.get(importer, '_runWithConcurrencyLimit');
        /** @type {number[]} */
        const processed = [];

        await run.call(importer, [1, 2, 3], Number.NaN, async (/** @type {number} */ value) => {
            processed.push(value);
        });

        expect(processed).toEqual([1, 2, 3]);
    });

    test('invalid mediaResolutionConcurrency falls back to the normal default', async () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        Reflect.set(importer, '_getFilesFromArchive', vi.fn(async () => {
            throw new Error('stop after option normalization');
        }));
        const database = /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ ({
            isPrepared: () => true,
            setImportOptimizationFlags() {},
        }));

        const result = await importer.importDictionary(
            database,
            new ArrayBuffer(0),
            {mediaResolutionConcurrency: Number.NaN},
        );

        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]?.message).toBe('stop after option normalization');
        expect(Reflect.get(importer, '_mediaResolutionConcurrency')).toBe(16);
    });
});
