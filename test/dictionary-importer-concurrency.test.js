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

/**
 * @param {number} concurrency
 * @returns {Promise<number[]>}
 */
async function run(concurrency) {
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
    /** @type {number[]} */
    const processed = [];
    const runWithConcurrencyLimit = /** @type {(items: number[], concurrency: number, fn: (item: number) => Promise<void>) => Promise<void>} */ (
        Reflect.get(importer, '_runWithConcurrencyLimit').bind(importer)
    );
    await runWithConcurrencyLimit(
        [0, 1, 2, 3],
        concurrency,
        async (value) => {
            processed.push(value);
        },
    );
    processed.sort((a, b) => a - b);
    return processed;
}

describe('DictionaryImporter concurrency limits', () => {
    test('does not silently skip work for non-finite concurrency', async () => {
        await expect(run(Number.NaN)).resolves.toEqual([0, 1, 2, 3]);
        await expect(run(Number.POSITIVE_INFINITY)).resolves.toEqual([0, 1, 2, 3]);
    });

    test('clamps non-positive concurrency to one worker', async () => {
        await expect(run(0)).resolves.toEqual([0, 1, 2, 3]);
        await expect(run(-5)).resolves.toEqual([0, 1, 2, 3]);
    });
});
