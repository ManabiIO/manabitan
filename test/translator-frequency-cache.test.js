/*
 * Copyright (C) 2023-2025  Yomitan Authors
 * Copyright (C) 2020-2022  Yomichan Authors
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
import {Translator} from '../ext/js/language/translator.js';
import {deferPromise} from '../ext/js/core/utilities.js';

/**
 * @param {ReturnType<typeof vi.fn>} getDictionaryInfo
 * @returns {Translator}
 */
function createTranslator(getDictionaryInfo) {
    return new Translator(/** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ ({getDictionaryInfo})));
}

/**
 * @param {Translator} translator
 * @returns {Promise<Map<string, import('dictionary-importer').Summary['frequencyMode']>>}
 */
function load(translator) {
    return Reflect.get(translator, '_getDictionaryFrequencyModeMap').call(translator);
}

describe('Translator frequency metadata cache', () => {
    test('coalesces reads and retries after a failed read', async () => {
        const getDictionaryInfo = vi.fn().mockRejectedValueOnce(new Error('temporary failure')).mockResolvedValue([{title: 'frequency', frequencyMode: 'rank'}]);
        const translator = createTranslator(getDictionaryInfo);
        await expect(load(translator)).rejects.toThrow('temporary failure');
        const [first, second] = await Promise.all([load(translator), load(translator)]);
        expect(first.get('frequency')).toBe('rank');
        expect(second).toBe(first);
        expect(await load(translator)).toBe(first);
        expect(getDictionaryInfo).toHaveBeenCalledTimes(2);
    });

    test('does not publish an invalidated read over a new generation', async () => {
        const oldRead = deferPromise();
        const newRead = deferPromise();
        const getDictionaryInfo = vi.fn().mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
        const translator = createTranslator(getDictionaryInfo);
        const oldResult = load(translator);
        translator.clearDatabaseCaches();
        const newResult = load(translator);
        oldRead.resolve([{title: 'frequency', frequencyMode: 'rank'}]);
        await oldResult;
        const coalesced = load(translator);
        newRead.resolve([{title: 'frequency', frequencyMode: 'occurrence'}]);
        expect((await newResult).get('frequency')).toBe('occurrence');
        expect(await coalesced).toBe(await newResult);
        expect(await load(translator)).toBe(await newResult);
        expect(getDictionaryInfo).toHaveBeenCalledTimes(2);
    });
});
