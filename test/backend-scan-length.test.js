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

vi.mock('../ext/lib/kanji-processor.js', () => ({
    /**
     * @param {string} text
     * @returns {string}
     */
    convertVariants: (text) => text,
}));

const {Backend} = await import('../ext/js/background/backend.js');

/**
 * @param {string} name
 * @returns {(this: unknown, ...args: unknown[]) => unknown}
 * @throws {Error}
 */
function getBackendMethod(name) {
    const method = Reflect.get(Backend.prototype, name);
    if (typeof method !== 'function') {
        throw new Error(`Expected ${name} method`);
    }
    return method;
}

describe('Backend hover scan length', () => {
    test('optionsGet returns the raw stored scan length', async () => {
        const rawProfileOptions = {scanning: {length: 16}};
        const context = {
            _getProfileOptions: vi.fn(() => rawProfileOptions),
        };

        const result = await getBackendMethod('_onApiOptionsGet').call(context, {optionsContext: {current: true}});

        expect(result).toStrictEqual({scanning: {length: 16}});
        expect(result).not.toBe(rawProfileOptions);
        expect(rawProfileOptions).toStrictEqual({scanning: {length: 16}});
    });

    test('getEffectiveHoverScanLength caps enabled dictionaries by the stored scan length and caches the result', async () => {
        const rawProfileOptions = {
            scanning: {length: 32},
            dictionaries: [
                {name: 'Enabled B', enabled: true},
                {name: 'Disabled', enabled: false},
                {name: 'Enabled A', enabled: true},
            ],
        };
        const getMaxHeadwordLength = vi.fn(async (dictionaryNames) => {
            expect(dictionaryNames).toStrictEqual(['Enabled A', 'Enabled B']);
            return 21;
        });
        const context = {
            _effectiveScanLengthMaxHeadwordLengthCache: new Map(),
            _dictionaryDatabase: {getMaxHeadwordLength},
            _dictionaryImportModeActive: false,
            _ensureDictionaryDatabaseReady: vi.fn(async () => {}),
            _getProfileOptions: vi.fn(() => rawProfileOptions),
            _getEffectiveHoverScanLength: getBackendMethod('_getEffectiveHoverScanLength'),
            _computeMaxHeadwordLengthFromDatabase: getBackendMethod('_computeMaxHeadwordLengthFromDatabase'),
            _getEnabledDictionaryNames: getBackendMethod('_getEnabledDictionaryNames'),
            _getDictionarySetCacheKey: getBackendMethod('_getDictionarySetCacheKey'),
            _getStoredGlobalMaxHeadwordLength: getBackendMethod('_getStoredGlobalMaxHeadwordLength'),
            _setGlobalMaxHeadwordLength: vi.fn(async () => false),
            _options: {
                global: {
                    database: {
                        maxHeadwordLength: 0,
                    },
                },
            },
        };

        const first = await getBackendMethod('_onApiGetEffectiveHoverScanLength').call(context, {optionsContext: {current: true}});
        const second = await getBackendMethod('_onApiGetEffectiveHoverScanLength').call(context, {optionsContext: {current: true}});

        expect(first).toBe(29);
        expect(second).toBe(29);
        expect(getMaxHeadwordLength).toHaveBeenCalledTimes(1);
    });

    test('getEffectiveHoverScanLength falls back to the stored scan length when the database returns 0', async () => {
        const rawProfileOptions = {
            scanning: {length: 16},
            dictionaries: [{name: 'Enabled', enabled: true}],
        };
        const context = {
            _effectiveScanLengthMaxHeadwordLengthCache: new Map(),
            _dictionaryDatabase: {getMaxHeadwordLength: vi.fn(async () => 0)},
            _dictionaryImportModeActive: false,
            _ensureDictionaryDatabaseReady: vi.fn(async () => {}),
            _getProfileOptions: vi.fn(() => rawProfileOptions),
            _getEffectiveHoverScanLength: getBackendMethod('_getEffectiveHoverScanLength'),
            _computeMaxHeadwordLengthFromDatabase: getBackendMethod('_computeMaxHeadwordLengthFromDatabase'),
            _getEnabledDictionaryNames: getBackendMethod('_getEnabledDictionaryNames'),
            _getDictionarySetCacheKey: getBackendMethod('_getDictionarySetCacheKey'),
            _getStoredGlobalMaxHeadwordLength: getBackendMethod('_getStoredGlobalMaxHeadwordLength'),
            _setGlobalMaxHeadwordLength: vi.fn(async () => false),
            _options: {
                global: {
                    database: {
                        maxHeadwordLength: 0,
                    },
                },
            },
        };

        const result = await getBackendMethod('_onApiGetEffectiveHoverScanLength').call(context, {optionsContext: {current: true}});

        expect(result).toBe(16);
    });

    test('getEffectiveHoverScanLength falls back to the stored scan length when the database is unavailable', async () => {
        const rawProfileOptions = {
            scanning: {length: 16},
            dictionaries: [{name: 'Enabled', enabled: true}],
        };
        const context = {
            _effectiveScanLengthMaxHeadwordLengthCache: new Map(),
            _dictionaryDatabase: {getMaxHeadwordLength: vi.fn(async () => 21)},
            _dictionaryImportModeActive: false,
            _ensureDictionaryDatabaseReady: vi.fn(async () => {
                throw new Error('database unavailable');
            }),
            _getProfileOptions: vi.fn(() => rawProfileOptions),
            _getEffectiveHoverScanLength: getBackendMethod('_getEffectiveHoverScanLength'),
            _computeMaxHeadwordLengthFromDatabase: getBackendMethod('_computeMaxHeadwordLengthFromDatabase'),
            _getEnabledDictionaryNames: getBackendMethod('_getEnabledDictionaryNames'),
            _getDictionarySetCacheKey: getBackendMethod('_getDictionarySetCacheKey'),
            _getStoredGlobalMaxHeadwordLength: getBackendMethod('_getStoredGlobalMaxHeadwordLength'),
            _setGlobalMaxHeadwordLength: vi.fn(async () => false),
            _options: {
                global: {
                    database: {
                        maxHeadwordLength: 0,
                    },
                },
            },
        };

        const result = await getBackendMethod('_onApiGetEffectiveHoverScanLength').call(context, {optionsContext: {current: true}});

        expect(result).toBe(16);
        expect(context._dictionaryDatabase.getMaxHeadwordLength).not.toHaveBeenCalled();
    });

    test('dictionary updates clear the cached hover scan lengths', async () => {
        const refreshCachedMaxHeadwordLength = vi.fn(async () => 21);
        const triggerDatabaseUpdated = vi.fn(async () => {});
        const cache = new Map([['Enabled', 21]]);
        const context = {
            _effectiveScanLengthMaxHeadwordLengthCache: cache,
            _refreshCachedMaxHeadwordLength: refreshCachedMaxHeadwordLength,
            _triggerDatabaseUpdated: triggerDatabaseUpdated,
            _dictionaryMutationActive: false,
        };

        await getBackendMethod('_handleDatabaseUpdated').call(context, 'dictionary', 'import');

        expect(cache.size).toBe(0);
        expect(refreshCachedMaxHeadwordLength).toHaveBeenCalledWith('background', {allowDuringMutation: false});
        expect(triggerDatabaseUpdated).toHaveBeenCalledWith('dictionary', 'import');
    });

    test('optionsGetFull still returns the raw stored options object', () => {
        const rawOptions = {profiles: [], profileCurrent: 0, version: 76, global: {}};
        const getOptionsFull = vi.fn(() => rawOptions);

        const result = getBackendMethod('_onApiOptionsGetFull').call({_getOptionsFull: getOptionsFull});

        expect(result).toBe(rawOptions);
        expect(getOptionsFull).toHaveBeenCalledWith(false);
    });
});
