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

import {describe, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';

/**
 * @param {Record<string, unknown>[]} dictionaryRows
 * @returns {{selectObjects: ReturnType<typeof vi.fn>, selectValue: ReturnType<typeof vi.fn>}}
 */
function createDatabaseConnection(dictionaryRows) {
    return {
        selectObjects: vi.fn(() => dictionaryRows),
        selectValue: vi.fn(() => 0),
    };
}

describe('DictionaryDatabase dictionary counts', () => {
    test('uses committed summary counts without materializing term shards', async () => {
        const database = new DictionaryDatabase();
        const ensureDictionariesLoaded = vi.fn(async () => {});
        Reflect.set(database, '_db', createDatabaseConnection([
            {title: 'JMdict', summaryJson: JSON.stringify({counts: {terms: {total: 10}}})},
            {title: 'Jitendex', summaryJson: JSON.stringify({counts: {terms: {total: 20}}})},
        ]));
        Reflect.set(database, '_termRecordStore', {
            ensureDictionariesLoaded,
            getDictionaryRecordCount: vi.fn(() => { throw new Error('unexpected shard materialization'); }),
        });

        await expect(database.getDictionaryCounts(['JMdict'], true)).resolves.toMatchObject({
            total: {terms: 30},
            counts: [{terms: 10}],
        });
        expect(ensureDictionariesLoaded).not.toHaveBeenCalled();
    });

    test('loads only dictionaries whose committed summary count is unavailable', async () => {
        const database = new DictionaryDatabase();
        const ensureDictionariesLoaded = vi.fn(async () => {});
        const getDictionaryRecordCount = vi.fn((dictionaryName) => dictionaryName === 'Jitendex' ? 7 : 0);
        Reflect.set(database, '_db', createDatabaseConnection([
            {title: 'JMdict', summaryJson: JSON.stringify({counts: {terms: {total: 10}}})},
            {title: 'Jitendex', summaryJson: '{invalid'},
        ]));
        Reflect.set(database, '_termRecordStore', {ensureDictionariesLoaded, getDictionaryRecordCount});

        await expect(database.getDictionaryCounts(['Jitendex'], true)).resolves.toMatchObject({
            total: {terms: 17},
            counts: [{terms: 7}],
        });
        expect(ensureDictionariesLoaded).toHaveBeenCalledOnce();
        expect([...ensureDictionariesLoaded.mock.calls[0][0]]).toEqual(['Jitendex']);
        expect(getDictionaryRecordCount).toHaveBeenCalledWith('Jitendex');
    });
});
