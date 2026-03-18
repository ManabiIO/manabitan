/*
 * Copyright (C) 2023-2026  Yomitan Authors
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

import {afterEach, describe, expect, test, vi} from 'vitest';

vi.mock('../ext/lib/kanji-processor.js', () => ({
    /**
     * @param {string} text
     * @returns {string}
     */
    convertVariants: (text) => text,
}));

vi.mock('../ext/js/comm/yomitan-api.js', () => ({
    YomitanApi: class {},
}));

vi.mock('../ext/js/dictionary/dictionary-database.js', () => ({
    DictionaryDatabase: class {},
}));

const {Backend} = await import('../ext/js/background/backend.js');

afterEach(() => {
    vi.restoreAllMocks();
});

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

/**
 * @param {Partial<import('dictionary-importer').Summary>} [overrides]
 * @returns {import('dictionary-importer').Summary}
 */
function createDictionarySummary(overrides = {}) {
    return /** @type {import('dictionary-importer').Summary} */ ({
        title: 'Test Dictionary',
        revision: '1',
        sequenced: false,
        version: 3,
        importDate: 0,
        prefixWildcardsSupported: false,
        styles: '',
        counts: {
            terms: {total: 1},
            termMeta: {total: 0},
            kanji: {total: 0},
            kanjiMeta: {total: 0},
            tagMeta: {total: 0},
            media: {total: 0},
        },
        isUpdatable: true,
        indexUrl: 'https://example.invalid/index.json',
        downloadUrl: 'https://example.invalid/dictionary.zip',
        importSuccess: true,
        ...overrides,
    });
}

/**
 * @param {Partial<import('backend').DictionaryUpdateCheckResult>} [overrides]
 * @returns {import('backend').DictionaryUpdateCheckResult}
 */
function createCheckResult(overrides = {}) {
    return {
        dictionaryTitle: 'Test Dictionary',
        hasUpdate: true,
        currentRevision: '1',
        latestRevision: '2',
        downloadUrl: 'https://example.invalid/dictionary-v2.zip',
        error: null,
        ...overrides,
    };
}

describe('Backend dictionary update helpers', () => {
    test('setDictionaryImportMode(true) clears the import-mode flag when suspension activation fails', async () => {
        const failure = new Error('suspend failed');
        const setSuspended = vi.fn(async (suspended) => {
            if (suspended) {
                throw failure;
            }
        });
        const clearDatabaseCaches = vi.fn(async () => {});
        const context = {
            _setDictionaryImportModePromise: null,
            _dictionaryImportModeActive: false,
            _dictionaryDatabasePreparePromise: null,
            _dictionaryDatabase: {setSuspended},
            _translator: {clearDatabaseCaches},
        };

        await expect(getBackendMethod('_setDictionaryImportMode').call(context, true)).rejects.toBe(failure);

        expect(context._dictionaryImportModeActive).toBe(false);
        expect(context._setDictionaryImportModePromise).toBe(null);
        expect(setSuspended).toHaveBeenCalledTimes(1);
        expect(setSuspended).toHaveBeenCalledWith(true);
        expect(clearDatabaseCaches).not.toHaveBeenCalled();
    });

    test('setDictionaryImportMode(true) resumes the database if activation fails after suspension', async () => {
        const failure = new Error('cache clear failed');
        const setSuspended = vi.fn()
            .mockImplementationOnce(async () => {})
            .mockImplementationOnce(async () => {});
        const clearDatabaseCaches = vi.fn(async () => {
            throw failure;
        });
        const context = {
            _setDictionaryImportModePromise: null,
            _dictionaryImportModeActive: false,
            _dictionaryDatabasePreparePromise: null,
            _dictionaryDatabase: {setSuspended},
            _translator: {clearDatabaseCaches},
            _ensureDictionaryDatabaseReady: vi.fn(async () => {}),
        };

        await expect(getBackendMethod('_setDictionaryImportMode').call(context, true)).rejects.toBe(failure);

        expect(context._dictionaryImportModeActive).toBe(false);
        expect(context._setDictionaryImportModePromise).toBe(null);
        expect(setSuspended.mock.calls).toStrictEqual([[true], [false]]);
        expect(context._ensureDictionaryDatabaseReady).not.toHaveBeenCalled();
    });

    test('GET check reports newer revisions', async () => {
        const dictionary = createDictionarySummary();
        const fetchAnonymous = vi.fn(async () => new Response(JSON.stringify({
            revision: '2',
            downloadUrl: 'https://example.invalid/dictionary-v2.zip',
        }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
            },
        }));
        const context = {
            _requestBuilder: {fetchAnonymous},
            _getDictionaryIndexSchema: async () => ({isValid: () => true}),
        };

        const result = await getBackendMethod('_checkDictionaryUpdate').call(context, dictionary);

        expect(fetchAnonymous).toHaveBeenCalledTimes(1);
        expect(fetchAnonymous).toHaveBeenCalledWith('https://example.invalid/index.json', expect.objectContaining({
            method: 'GET',
            cache: 'no-store',
        }));
        expect(result).toStrictEqual({
            dictionaryTitle: 'Test Dictionary',
            hasUpdate: true,
            currentRevision: '1',
            latestRevision: '2',
            downloadUrl: 'https://example.invalid/dictionary-v2.zip',
            error: null,
        });
    });

    test('checkDictionaryUpdate reports HTTP errors', async () => {
        const dictionary = createDictionarySummary();
        const fetchAnonymous = vi.fn(async () => new Response(null, {status: 500}));
        const context = {
            _requestBuilder: {fetchAnonymous},
            _getDictionaryIndexSchema: async () => ({isValid: () => true}),
        };

        const result = await getBackendMethod('_checkDictionaryUpdate').call(context, dictionary);

        expect(result).toStrictEqual({
            dictionaryTitle: 'Test Dictionary',
            hasUpdate: false,
            currentRevision: '1',
            latestRevision: null,
            downloadUrl: 'https://example.invalid/dictionary.zip',
            error: 'HTTP 500',
        });
    });

    test('updateDictionaryByTitle skips when the mutation lock is busy', async () => {
        const dictionary = createDictionarySummary();
        const fetchAnonymous = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {status: 200}));
        const performDictionaryUpdate = vi.fn(async () => ({status: 'updated'}));
        const context = {
            _ensureDictionaryDatabaseReady: async () => {},
            _dictionaryDatabase: {
                getDictionaryInfo: async () => [dictionary],
            },
            _requestBuilder: {fetchAnonymous},
            _runWithDictionaryMutationLock: vi.fn(async () => void 0),
            _performDictionaryUpdate: performDictionaryUpdate,
        };

        const result = await getBackendMethod('_updateDictionaryByTitle').call(
            context,
            'Test Dictionary',
            false,
            createCheckResult(),
        );

        expect(result).toStrictEqual({
            dictionaryTitle: 'Test Dictionary',
            status: 'skipped',
            latestRevision: '2',
            error: null,
        });
        expect(fetchAnonymous).toHaveBeenCalledTimes(1);
        expect(performDictionaryUpdate).not.toHaveBeenCalled();
    });

    test('updateDictionaryOnStartup returns true only when an update is applied', async () => {
        const updateDictionaryByTitle = vi
            .fn()
            .mockResolvedValueOnce({status: 'updated', error: null})
            .mockResolvedValueOnce({status: 'skipped', error: null});
        const context = {
            _updateDictionaryByTitle: updateDictionaryByTitle,
        };

        await expect(getBackendMethod('_updateDictionaryOnStartup').call(context, 'Test Dictionary', createCheckResult())).resolves.toBe(true);
        await expect(getBackendMethod('_updateDictionaryOnStartup').call(context, 'Test Dictionary', createCheckResult())).resolves.toBe(false);
        expect(updateDictionaryByTitle).toHaveBeenNthCalledWith(1, 'Test Dictionary', false, expect.objectContaining({hasUpdate: true}));
        expect(updateDictionaryByTitle).toHaveBeenNthCalledWith(2, 'Test Dictionary', false, expect.objectContaining({hasUpdate: true}));
    });

    test('Imported dictionary settings migrate aliases, Anki fields, and related dictionary references', async () => {
        const saveOptions = vi.fn(async () => {});
        const context = {
            _options: {
                profileCurrent: 0,
                profiles: [
                    {
                        id: 'profile-1',
                        options: {
                            dictionaries: [
                                {
                                    name: 'Old Dictionary',
                                    alias: 'Custom Alias',
                                    enabled: true,
                                    allowSecondarySearches: true,
                                    definitionsCollapsible: 'not-collapsible',
                                    partsOfSpeechFilter: false,
                                    useDeinflections: false,
                                    styles: 'old-style',
                                },
                                {
                                    name: 'Other Dictionary',
                                    alias: 'Other Dictionary',
                                    enabled: false,
                                    allowSecondarySearches: false,
                                    definitionsCollapsible: 'not-collapsible',
                                    partsOfSpeechFilter: true,
                                    useDeinflections: true,
                                    styles: '',
                                },
                            ],
                            general: {
                                mainDictionary: 'Old Dictionary',
                                sortFrequencyDictionary: 'Old Dictionary',
                            },
                            anki: {
                                cardFormats: [
                                    {
                                        fields: {
                                            expression: {
                                                value: 'old-dictionary-term old-dictionary-reading',
                                            },
                                        },
                                    },
                                ],
                            },
                        },
                    },
                ],
                global: {
                    database: {
                        prefixWildcardsSupported: false,
                        maxHeadwordLength: 0,
                        autoUpdateDictionariesOnStartup: false,
                    },
                    dataTransmissionConsentShown: false,
                },
            },
            _saveOptions: saveOptions,
        };
        const previousSummary = createDictionarySummary({
            title: 'Old Dictionary',
            styles: 'old-style',
        });
        const importedSummary = createDictionarySummary({
            title: 'New Dictionary',
            styles: 'new-style',
        });
        const updateContext = {
            profilesDictionarySettings: {
                'profile-1': {
                    index: 0,
                    name: 'Old Dictionary',
                    alias: 'Custom Alias',
                    enabled: true,
                    allowSecondarySearches: true,
                    definitionsCollapsible: 'not-collapsible',
                    partsOfSpeechFilter: false,
                    useDeinflections: false,
                    styles: 'old-style',
                },
            },
            mainDictionaryProfileIds: new Set(['profile-1']),
            sortFrequencyDictionaryProfileIds: new Set(['profile-1']),
        };

        await getBackendMethod('_applyImportedDictionarySettings').call(context, previousSummary, importedSummary, updateContext);

        const profile = context._options.profiles[0];
        expect(profile.options.dictionaries).toStrictEqual([
            {
                name: 'New Dictionary',
                alias: 'Custom Alias',
                enabled: true,
                allowSecondarySearches: true,
                definitionsCollapsible: 'not-collapsible',
                partsOfSpeechFilter: false,
                useDeinflections: false,
                styles: 'new-style',
            },
            {
                name: 'Other Dictionary',
                alias: 'Other Dictionary',
                enabled: false,
                allowSecondarySearches: false,
                definitionsCollapsible: 'not-collapsible',
                partsOfSpeechFilter: true,
                useDeinflections: true,
                styles: '',
            },
        ]);
        expect(profile.options.general.mainDictionary).toBe('New Dictionary');
        expect(profile.options.general.sortFrequencyDictionary).toBe('New Dictionary');
        expect(profile.options.anki.cardFormats[0].fields.expression.value).toBe('new-dictionary-term new-dictionary-reading');
        expect(saveOptions).toHaveBeenCalledTimes(1);
        expect(saveOptions).toHaveBeenCalledWith('background');
    });
});
