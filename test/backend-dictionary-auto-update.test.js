/*
 * Copyright (C) 2023-2025  Yomitan Authors
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

const {Backend} = await import('../ext/js/background/backend.js');

const DICTIONARY_AUTO_UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const DICTIONARY_AUTO_UPDATE_DAY_MS = 24 * DICTIONARY_AUTO_UPDATE_INTERVAL_MS;
const DICTIONARY_AUTO_UPDATE_WEEK_MS = 7 * DICTIONARY_AUTO_UPDATE_DAY_MS;

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
        autoUpdate: {
            schedule: 'manual',
            lastUpdatedAt: 0,
            nextUpdateAt: null,
        },
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

describe('Backend dictionary auto-update helpers', () => {
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

    test('Prunes stale auto-update settings and runtime state', async () => {
        const saveOptions = vi.fn(async () => {});
        const setState = vi.fn(async () => {});
        const context = {
            _options: {
                global: {
                    dictionaryAutoUpdates: [
                        'https://example.invalid/keep.json',
                        'https://example.invalid/remove.json',
                    ],
                },
            },
            _ensureDictionaryDatabaseReady: async () => {},
            _dictionaryDatabase: {
                getDictionaryInfo: async () => [
                    createDictionarySummary({indexUrl: 'https://example.invalid/keep.json'}),
                    createDictionarySummary({title: 'Static Dictionary', isUpdatable: false, indexUrl: 'https://example.invalid/static.json'}),
                ],
            },
            _saveOptions: saveOptions,
            _getDictionaryAutoUpdateState: async () => ({
                'https://example.invalid/keep.json': {lastAttemptAt: 1},
                'https://example.invalid/remove.json': {lastAttemptAt: 2},
            }),
            _setDictionaryAutoUpdateState: setState,
        };

        await getBackendMethod('_pruneStaleDictionaryAutoUpdates').call(context);

        expect(context._options.global.dictionaryAutoUpdates).toStrictEqual(['https://example.invalid/keep.json']);
        expect(saveOptions).toHaveBeenCalledTimes(1);
        expect(setState).toHaveBeenCalledTimes(1);
        expect(setState).toHaveBeenCalledWith({
            'https://example.invalid/keep.json': {lastAttemptAt: 1},
        });
    });

    test('Backfills hourly schedule metadata for dictionaries already enabled in global auto-update settings', async () => {
        let currentDictionaries = /** @type {import('dictionary-importer').Summary[]} */ ([
            createDictionarySummary({
                autoUpdate: void 0,
                importDate: 500,
            }),
            createDictionarySummary({
                title: 'Other Dictionary',
                indexUrl: 'https://example.invalid/other.json',
                autoUpdate: {
                    schedule: 'daily',
                    lastUpdatedAt: 250,
                    nextUpdateAt: 250 + DICTIONARY_AUTO_UPDATE_DAY_MS,
                },
            }),
        ]);
        const updateDictionarySummaryByTitle = vi.fn(async (dictionaryTitle, summary) => {
            currentDictionaries = currentDictionaries.map((dictionary) => (dictionary.title === dictionaryTitle ? summary : dictionary));
            return summary;
        });
        const context = {
            _options: {
                global: {
                    dictionaryAutoUpdates: ['https://example.invalid/index.json'],
                },
            },
            _runWithDictionaryMutationLock: vi.fn(async (callback) => await callback()),
            _ensureDictionaryDatabaseReady: async () => {},
            _dictionaryDatabase: {
                getDictionaryInfo: async () => currentDictionaries,
                updateDictionarySummaryByTitle,
            },
            _setDictionarySummaryByTitle: getBackendMethod('_setDictionarySummaryByTitle'),
        };

        await getBackendMethod('_backfillDictionaryAutoUpdateSummarySchedules').call(context);

        expect(updateDictionarySummaryByTitle).toHaveBeenCalledTimes(1);
        expect(currentDictionaries[0].autoUpdate).toStrictEqual({
            schedule: 'hourly',
            lastUpdatedAt: 500,
            nextUpdateAt: 500 + DICTIONARY_AUTO_UPDATE_INTERVAL_MS,
        });
        expect(currentDictionaries[1].autoUpdate).toStrictEqual({
            schedule: 'daily',
            lastUpdatedAt: 250,
            nextUpdateAt: 250 + DICTIONARY_AUTO_UPDATE_DAY_MS,
        });
    });

    test('Global hourly auto-update settings sync dictionary summary schedules between hourly and manual', async () => {
        let currentDictionaries = /** @type {import('dictionary-importer').Summary[]} */ ([
            createDictionarySummary({
                autoUpdate: {
                    schedule: 'manual',
                    lastUpdatedAt: 10,
                    nextUpdateAt: null,
                },
            }),
            createDictionarySummary({
                title: 'Daily Dictionary',
                indexUrl: 'https://example.invalid/daily.json',
                autoUpdate: {
                    schedule: 'daily',
                    lastUpdatedAt: 20,
                    nextUpdateAt: 20 + DICTIONARY_AUTO_UPDATE_DAY_MS,
                },
            }),
        ]);
        const updateDictionarySummaryByTitle = vi.fn(async (dictionaryTitle, summary) => {
            currentDictionaries = currentDictionaries.map((dictionary) => (dictionary.title === dictionaryTitle ? summary : dictionary));
            return summary;
        });
        const context = {
            _options: {
                global: {
                    dictionaryAutoUpdates: ['https://example.invalid/index.json'],
                },
            },
            _runWithDictionaryMutationLock: vi.fn(async (callback) => await callback()),
            _ensureDictionaryDatabaseReady: async () => {},
            _dictionaryDatabase: {
                getDictionaryInfo: async () => currentDictionaries,
                updateDictionarySummaryByTitle,
            },
            _setDictionarySummaryByTitle: getBackendMethod('_setDictionarySummaryByTitle'),
        };

        await getBackendMethod('_syncDictionaryAutoUpdateSummarySchedulesWithGlobalSettings').call(context);

        expect(updateDictionarySummaryByTitle).toHaveBeenCalledTimes(2);
        expect(currentDictionaries[0].autoUpdate).toStrictEqual({
            schedule: 'hourly',
            lastUpdatedAt: 10,
            nextUpdateAt: 10 + DICTIONARY_AUTO_UPDATE_INTERVAL_MS,
        });
        expect(currentDictionaries[1].autoUpdate).toStrictEqual({
            schedule: 'manual',
            lastUpdatedAt: 20,
            nextUpdateAt: null,
        });
    });

    test('setDictionaryUpdateSchedule persists schedules and syncs the hourly compatibility list', async () => {
        let currentDictionary = createDictionarySummary({
            importDate: 100,
            autoUpdate: {
                schedule: 'manual',
                lastUpdatedAt: 100,
                nextUpdateAt: null,
            },
        });
        const saveOptions = vi.fn(async () => {});
        const updateDictionarySummaryByTitle = vi.fn(async (_dictionaryTitle, summary) => {
            currentDictionary = summary;
            return summary;
        });
        const context = {
            _options: {
                global: {
                    dictionaryAutoUpdates: [],
                },
            },
            _runWithDictionaryMutationLock: vi.fn(async (callback) => await callback()),
            _ensureDictionaryDatabaseReady: async () => {},
            _dictionaryDatabase: {
                getDictionaryInfo: async () => [currentDictionary],
                updateDictionarySummaryByTitle,
            },
            _saveOptions: saveOptions,
            _setDictionarySummaryByTitle: getBackendMethod('_setDictionarySummaryByTitle'),
            _syncGlobalDictionaryAutoUpdateOptionsFromSummaries: getBackendMethod('_syncGlobalDictionaryAutoUpdateOptionsFromSummaries'),
            _getSortedDictionaryAutoUpdateIndexUrls: getBackendMethod('_getSortedDictionaryAutoUpdateIndexUrls'),
        };

        const hourlySummary = /** @type {import('dictionary-importer').Summary} */ (
            await getBackendMethod('_setDictionaryUpdateSchedule').call(context, 'Test Dictionary', 'hourly')
        );
        expect(hourlySummary.autoUpdate).toStrictEqual({
            schedule: 'hourly',
            lastUpdatedAt: 100,
            nextUpdateAt: 100 + DICTIONARY_AUTO_UPDATE_INTERVAL_MS,
        });
        expect(context._options.global.dictionaryAutoUpdates).toStrictEqual(['https://example.invalid/index.json']);

        const dailySummary = /** @type {import('dictionary-importer').Summary} */ (
            await getBackendMethod('_setDictionaryUpdateSchedule').call(context, 'Test Dictionary', 'daily')
        );
        expect(dailySummary.autoUpdate).toStrictEqual({
            schedule: 'daily',
            lastUpdatedAt: 100,
            nextUpdateAt: 100 + DICTIONARY_AUTO_UPDATE_DAY_MS,
        });
        expect(context._options.global.dictionaryAutoUpdates).toStrictEqual([]);

        const weeklySummary = /** @type {import('dictionary-importer').Summary} */ (
            await getBackendMethod('_setDictionaryUpdateSchedule').call(context, 'Test Dictionary', 'weekly')
        );
        expect(weeklySummary.autoUpdate).toStrictEqual({
            schedule: 'weekly',
            lastUpdatedAt: 100,
            nextUpdateAt: 100 + DICTIONARY_AUTO_UPDATE_WEEK_MS,
        });
        expect(context._options.global.dictionaryAutoUpdates).toStrictEqual([]);
        expect(updateDictionarySummaryByTitle).toHaveBeenCalledTimes(3);
        expect(saveOptions).toHaveBeenCalledTimes(2);
    });

    test('setDictionaryUpdateSchedule rejects non-manual schedules for non-updatable dictionaries', async () => {
        const dictionary = createDictionarySummary({
            isUpdatable: false,
            indexUrl: void 0,
            downloadUrl: void 0,
            autoUpdate: {
                schedule: 'manual',
                lastUpdatedAt: 50,
                nextUpdateAt: null,
            },
        });
        const context = {
            _options: {
                global: {
                    dictionaryAutoUpdates: [],
                },
            },
            _runWithDictionaryMutationLock: vi.fn(async (callback) => await callback()),
            _ensureDictionaryDatabaseReady: async () => {},
            _dictionaryDatabase: {
                getDictionaryInfo: async () => [dictionary],
                updateDictionarySummaryByTitle: vi.fn(async () => dictionary),
            },
            _saveOptions: vi.fn(async () => {}),
            _setDictionarySummaryByTitle: getBackendMethod('_setDictionarySummaryByTitle'),
            _syncGlobalDictionaryAutoUpdateOptionsFromSummaries: getBackendMethod('_syncGlobalDictionaryAutoUpdateOptionsFromSummaries'),
            _getSortedDictionaryAutoUpdateIndexUrls: getBackendMethod('_getSortedDictionaryAutoUpdateIndexUrls'),
        };

        await expect(getBackendMethod('_setDictionaryUpdateSchedule').call(context, 'Test Dictionary', 'daily')).rejects.toThrow('Dictionary is not updatable');
    });

    test('HEAD 304 check updates validators without fetching the index body', async () => {
        const dictionary = createDictionarySummary();
        /** @type {Record<string, {etag?: string, lastModified?: string, lastAttemptAt?: number, lastSuccessfulCheckAt?: number, lastSeenRevision?: string, lastError?: string|null}>} */
        const state = {
            'https://example.invalid/index.json': {
                etag: '"old-etag"',
                lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
            },
        };
        const fetchAnonymous = vi.fn(async () => new Response(null, {
            status: 304,
            headers: {
                ETag: '"new-etag"',
                'Last-Modified': 'Tue, 02 Jan 2024 00:00:00 GMT',
            },
        }));
        const context = {
            _requestBuilder: {fetchAnonymous},
            _getDictionaryIndexSchema: async () => ({isValid: () => true}),
        };

        const result = await getBackendMethod('_checkDictionaryUpdate').call(context, dictionary, state);

        expect(result).toStrictEqual({
            dictionaryTitle: 'Test Dictionary',
            hasUpdate: false,
            currentRevision: '1',
            latestRevision: null,
            downloadUrl: 'https://example.invalid/dictionary.zip',
            error: null,
        });
        expect(fetchAnonymous).toHaveBeenCalledTimes(1);
        expect(fetchAnonymous).toHaveBeenCalledWith('https://example.invalid/index.json', expect.objectContaining({
            method: 'HEAD',
            headers: {
                'If-None-Match': '"old-etag"',
                'If-Modified-Since': 'Mon, 01 Jan 2024 00:00:00 GMT',
            },
        }));
        expect(state['https://example.invalid/index.json']).toMatchObject({
            etag: '"new-etag"',
            lastModified: 'Tue, 02 Jan 2024 00:00:00 GMT',
            lastSeenRevision: '1',
            lastError: null,
        });
        expect(state['https://example.invalid/index.json'].lastAttemptAt).toEqual(expect.any(Number));
        expect(state['https://example.invalid/index.json'].lastSuccessfulCheckAt).toEqual(expect.any(Number));
    });

    test('HEAD success falls through to GET and reports newer revisions', async () => {
        const dictionary = createDictionarySummary();
        /** @type {Record<string, {etag?: string, lastModified?: string|null, lastAttemptAt?: number, lastSuccessfulCheckAt?: number, lastSeenRevision?: string, lastError?: string|null}>} */
        const state = {'https://example.invalid/index.json': {}};
        const fetchAnonymous = vi
            .fn()
            .mockResolvedValueOnce(new Response(null, {
                status: 200,
                headers: {
                    ETag: '"head-etag"',
                    'Last-Modified': 'Tue, 02 Jan 2024 00:00:00 GMT',
                },
            }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                revision: '2',
                downloadUrl: 'https://example.invalid/dictionary-v2.zip',
            }), {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    ETag: '"get-etag"',
                },
            }));
        const context = {
            _requestBuilder: {fetchAnonymous},
            _getDictionaryIndexSchema: async () => ({isValid: () => true}),
        };

        const result = await getBackendMethod('_checkDictionaryUpdate').call(context, dictionary, state);

        expect(fetchAnonymous).toHaveBeenCalledTimes(2);
        expect(fetchAnonymous.mock.calls[0][1]).toEqual(expect.objectContaining({method: 'HEAD'}));
        expect(fetchAnonymous.mock.calls[1][1]).toEqual(expect.objectContaining({method: 'GET', headers: {}}));
        expect(result).toStrictEqual({
            dictionaryTitle: 'Test Dictionary',
            hasUpdate: true,
            currentRevision: '1',
            latestRevision: '2',
            downloadUrl: 'https://example.invalid/dictionary-v2.zip',
            error: null,
        });
        expect(state['https://example.invalid/index.json']).toMatchObject({
            etag: '"get-etag"',
            lastModified: null,
            lastSeenRevision: '2',
            lastError: null,
        });
    });

    test('GET fallback reuses validators when HEAD fails', async () => {
        const dictionary = createDictionarySummary();
        /** @type {Record<string, {etag?: string, lastModified?: string, lastAttemptAt?: number, lastSuccessfulCheckAt?: number, lastSeenRevision?: string, lastError?: string|null}>} */
        const state = {
            'https://example.invalid/index.json': {
                etag: '"old-etag"',
                lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
            },
        };
        const fetchAnonymous = vi
            .fn()
            .mockRejectedValueOnce(new Error('HEAD unsupported'))
            .mockResolvedValueOnce(new Response(JSON.stringify({revision: '1'}), {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    ETag: '"get-etag"',
                },
            }));
        const context = {
            _requestBuilder: {fetchAnonymous},
            _getDictionaryIndexSchema: async () => ({isValid: () => true}),
        };

        const result = await getBackendMethod('_checkDictionaryUpdate').call(context, dictionary, state);

        expect(fetchAnonymous).toHaveBeenCalledTimes(2);
        expect(fetchAnonymous.mock.calls[0][1]).toEqual(expect.objectContaining({method: 'HEAD'}));
        expect(fetchAnonymous.mock.calls[1][1]).toEqual(expect.objectContaining({
            method: 'GET',
            headers: {
                'If-None-Match': '"old-etag"',
                'If-Modified-Since': 'Mon, 01 Jan 2024 00:00:00 GMT',
            },
        }));
        expect(result).toStrictEqual({
            dictionaryTitle: 'Test Dictionary',
            hasUpdate: false,
            currentRevision: '1',
            latestRevision: '1',
            downloadUrl: 'https://example.invalid/dictionary.zip',
            error: null,
        });
        expect(state['https://example.invalid/index.json']).toMatchObject({
            etag: '"get-etag"',
            lastSeenRevision: '1',
            lastError: null,
        });
    });

    test('Auto-update pass only checks enabled dictionaries that are due', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(2 * DICTIONARY_AUTO_UPDATE_INTERVAL_MS);
        const checkDictionaryUpdates = vi.fn(async () => [createCheckResult()]);
        const updateDictionaryByTitle = vi.fn(async () => ({status: 'updated'}));
        const context = {
            _dictionaryAutoUpdatePassPromise: null,
            _dictionaryImportModeActive: false,
            _options: {
                global: {
                    dictionaryAutoUpdates: [
                        'https://example.invalid/due.json',
                        'https://example.invalid/recent.json',
                    ],
                },
            },
            _ensureDictionaryDatabaseReady: async () => {},
            _dictionaryDatabase: {
                getDictionaryInfo: async () => [
                    createDictionarySummary({title: 'Recent', indexUrl: 'https://example.invalid/recent.json'}),
                    createDictionarySummary({title: 'Due', indexUrl: 'https://example.invalid/due.json'}),
                    createDictionarySummary({
                        title: 'Daily Metadata Only',
                        indexUrl: 'https://example.invalid/daily.json',
                        autoUpdate: {
                            schedule: 'daily',
                            lastUpdatedAt: 0,
                            nextUpdateAt: DICTIONARY_AUTO_UPDATE_DAY_MS,
                        },
                    }),
                    createDictionarySummary({title: 'Static', isUpdatable: false, indexUrl: 'https://example.invalid/static.json'}),
                ],
            },
            _getDictionaryAutoUpdateState: async () => ({
                'https://example.invalid/due.json': {lastAttemptAt: 0},
                'https://example.invalid/recent.json': {lastAttemptAt: (2 * DICTIONARY_AUTO_UPDATE_INTERVAL_MS) - 1},
                'https://example.invalid/daily.json': {lastAttemptAt: 0},
            }),
            _checkDictionaryUpdates: checkDictionaryUpdates,
            _updateDictionaryByTitle: updateDictionaryByTitle,
        };

        await getBackendMethod('_runDictionaryAutoUpdatePass').call(context, 'alarm');

        expect(checkDictionaryUpdates).toHaveBeenCalledTimes(1);
        expect(checkDictionaryUpdates).toHaveBeenCalledWith(['Due']);
        expect(updateDictionaryByTitle).toHaveBeenCalledTimes(1);
        expect(updateDictionaryByTitle).toHaveBeenCalledWith('Due', false, expect.objectContaining({
            dictionaryTitle: 'Test Dictionary',
            hasUpdate: true,
        }));
        expect(context._dictionaryAutoUpdatePassPromise).toBeNull();
    });

    test('Auto-update update skips when the mutation lock is busy', async () => {
        const dictionary = createDictionarySummary();
        const fetchAnonymous = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {status: 200}));
        const performDictionaryUpdate = vi.fn(async () => ({status: 'updated'}));
        const context = {
            _options: {
                global: {
                    dictionaryAutoUpdates: ['https://example.invalid/index.json'],
                },
            },
            _ensureDictionaryDatabaseReady: async () => {},
            _dictionaryDatabase: {
                getDictionaryInfo: async () => [dictionary],
            },
            _requestBuilder: {fetchAnonymous},
            _setDictionaryAutoUpdateError: vi.fn(async () => {}),
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

    test('Auto-update update aborts when hourly updates were disabled before commit', async () => {
        const dictionary = createDictionarySummary();
        const performDictionaryUpdate = vi.fn(async () => ({status: 'updated'}));
        const context = {
            _options: {
                global: {
                    dictionaryAutoUpdates: [],
                },
            },
            _ensureDictionaryDatabaseReady: async () => {},
            _dictionaryDatabase: {
                getDictionaryInfo: vi.fn(async () => [dictionary]),
            },
            _requestBuilder: {
                fetchAnonymous: vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {status: 200})),
            },
            _setDictionaryAutoUpdateError: vi.fn(async () => {}),
            _runWithDictionaryMutationLock: vi.fn(async (callback) => await callback()),
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
        expect(performDictionaryUpdate).not.toHaveBeenCalled();
    });

    test('Headless import details include global defaults for dictionary updates', () => {
        vi.stubGlobal('chrome', {
            runtime: {
                getManifest: () => ({version: '9.9.9.9'}),
            },
        });
        const context = {
            _options: {
                global: {
                    database: {
                        prefixWildcardsSupported: true,
                    },
                },
            },
        };

        const importDetails = getBackendMethod('_createDictionaryImportDetails').call(context);

        expect(importDetails).toStrictEqual({
            prefixWildcardsSupported: true,
            yomitanVersion: '9.9.9.9',
        });
    });

    test('Dictionary updates re-import using default headless import details', async () => {
        vi.stubGlobal('chrome', {
            runtime: {
                getManifest: () => ({version: '9.9.9.9'}),
            },
        });

        const dictionary = createDictionarySummary({title: 'Custom Title'});
        const archiveContent = new Uint8Array([1, 2, 3, 4]);
        const context = {
            _options: {
                global: {
                    database: {
                        prefixWildcardsSupported: true,
                    },
                },
            },
            _captureDictionaryUpdateSettings: vi.fn(() => ({profilesDictionarySettings: {}, mainDictionaryProfileIds: new Set(), sortFrequencyDictionaryProfileIds: new Set()})),
            _dictionaryDatabase: {
                deleteDictionary: vi.fn(async () => {}),
                updateDictionarySummaryByTitle: vi.fn(async (_dictionaryTitle, summary) => summary),
            },
            _setDictionaryImportMode: vi.fn(async () => {}),
            _importDictionaryArchiveHeadless: vi.fn(async () => ({
                result: createDictionarySummary({
                    title: 'Custom Title',
                    revision: '2026.03',
                }),
                errors: [],
            })),
            _setDictionarySummaryByTitle: getBackendMethod('_setDictionarySummaryByTitle'),
            _createUpdatedDictionarySummaryAfterImport: getBackendMethod('_createUpdatedDictionarySummaryAfterImport'),
            _applyImportedDictionarySettings: vi.fn(async () => {}),
            _updateDictionaryAutoUpdateStateAfterSuccess: vi.fn(async () => {}),
            _setDictionaryAutoUpdateError: vi.fn(async () => {}),
            _handleDatabaseUpdated: vi.fn(async () => {}),
            _pruneStaleProfileDictionaryOptions: vi.fn(async () => {}),
            _pruneStaleDictionaryAutoUpdates: vi.fn(async () => {}),
        };
        const createDictionaryImportDetails = vi.fn(getBackendMethod('_createDictionaryImportDetails').bind(context));
        Reflect.set(context, '_createDictionaryImportDetails', createDictionaryImportDetails);

        const result = await getBackendMethod('_performDictionaryUpdate').call(context, dictionary, archiveContent, '2026.03');

        expect(result).toStrictEqual({
            dictionaryTitle: 'Custom Title',
            status: 'updated',
            latestRevision: '2026.03',
            error: null,
        });
        expect(createDictionaryImportDetails).toHaveBeenCalledWith();
        expect(context._importDictionaryArchiveHeadless).toHaveBeenCalledWith(
            archiveContent.buffer.slice(archiveContent.byteOffset, archiveContent.byteOffset + archiveContent.byteLength),
            {
                prefixWildcardsSupported: true,
                yomitanVersion: '9.9.9.9',
            },
        );
        expect(context._applyImportedDictionarySettings).toHaveBeenCalledWith(
            dictionary,
            expect.objectContaining({title: 'Custom Title'}),
            expect.any(Object),
        );
        expect(context._setDictionaryAutoUpdateError).not.toHaveBeenCalled();
    });

    test('Dictionary updates preserve stored schedule metadata and refresh lastUpdatedAt', async () => {
        const dictionary = createDictionarySummary({
            title: 'Custom Title',
            importDate: 25,
            autoUpdate: {
                schedule: 'weekly',
                lastUpdatedAt: 25,
                nextUpdateAt: 25 + DICTIONARY_AUTO_UPDATE_WEEK_MS,
            },
        });
        const archiveContent = new Uint8Array([1, 2, 3, 4]);
        /** @type {import('dictionary-importer').Summary[]} */
        const persistedSummaries = [];
        const updateDictionarySummaryByTitle = vi.fn(async (_dictionaryTitle, summary) => {
            persistedSummaries.push(summary);
            return summary;
        });
        const context = {
            _captureDictionaryUpdateSettings: vi.fn(() => ({profilesDictionarySettings: {}, mainDictionaryProfileIds: new Set(), sortFrequencyDictionaryProfileIds: new Set()})),
            _dictionaryDatabase: {
                deleteDictionary: vi.fn(async () => {}),
                updateDictionarySummaryByTitle,
            },
            _createDictionaryImportDetails: vi.fn(() => ({prefixWildcardsSupported: false, yomitanVersion: '0.0.0.0'})),
            _setDictionaryImportMode: vi.fn(async () => {}),
            _importDictionaryArchiveHeadless: vi.fn(async () => ({
                result: createDictionarySummary({
                    title: 'Custom Title',
                    revision: '2026.03',
                    importDate: 500,
                }),
                errors: [],
            })),
            _setDictionarySummaryByTitle: getBackendMethod('_setDictionarySummaryByTitle'),
            _createUpdatedDictionarySummaryAfterImport: getBackendMethod('_createUpdatedDictionarySummaryAfterImport'),
            _applyImportedDictionarySettings: vi.fn(async () => {}),
            _updateDictionaryAutoUpdateStateAfterSuccess: vi.fn(async () => {}),
            _setDictionaryAutoUpdateError: vi.fn(async () => {}),
            _handleDatabaseUpdated: vi.fn(async () => {}),
            _pruneStaleProfileDictionaryOptions: vi.fn(async () => {}),
            _pruneStaleDictionaryAutoUpdates: vi.fn(async () => {}),
        };

        const result = await getBackendMethod('_performDictionaryUpdate').call(context, dictionary, archiveContent, '2026.03');

        expect(result).toStrictEqual({
            dictionaryTitle: 'Custom Title',
            status: 'updated',
            latestRevision: '2026.03',
            error: null,
        });
        expect(updateDictionarySummaryByTitle).toHaveBeenCalledTimes(1);
        expect(persistedSummaries[0]?.autoUpdate).toStrictEqual({
            schedule: 'weekly',
            lastUpdatedAt: 500,
            nextUpdateAt: 500 + DICTIONARY_AUTO_UPDATE_WEEK_MS,
        });
    });

    test('Dictionary updates reset stored schedule metadata when the imported dictionary is no longer updatable', async () => {
        const dictionary = createDictionarySummary({
            title: 'Custom Title',
            autoUpdate: {
                schedule: 'hourly',
                lastUpdatedAt: 75,
                nextUpdateAt: 75 + DICTIONARY_AUTO_UPDATE_INTERVAL_MS,
            },
        });
        const archiveContent = new Uint8Array([1, 2, 3, 4]);
        /** @type {import('dictionary-importer').Summary[]} */
        const persistedSummaries = [];
        const context = {
            _captureDictionaryUpdateSettings: vi.fn(() => ({profilesDictionarySettings: {}, mainDictionaryProfileIds: new Set(), sortFrequencyDictionaryProfileIds: new Set()})),
            _dictionaryDatabase: {
                deleteDictionary: vi.fn(async () => {}),
                updateDictionarySummaryByTitle: vi.fn(async (_dictionaryTitle, summary) => {
                    persistedSummaries.push(summary);
                    return summary;
                }),
            },
            _createDictionaryImportDetails: vi.fn(() => ({prefixWildcardsSupported: false, yomitanVersion: '0.0.0.0'})),
            _setDictionaryImportMode: vi.fn(async () => {}),
            _importDictionaryArchiveHeadless: vi.fn(async () => ({
                result: createDictionarySummary({
                    title: 'Custom Title',
                    revision: '2026.03',
                    importDate: 800,
                    isUpdatable: false,
                    indexUrl: void 0,
                    downloadUrl: void 0,
                }),
                errors: [],
            })),
            _setDictionarySummaryByTitle: getBackendMethod('_setDictionarySummaryByTitle'),
            _createUpdatedDictionarySummaryAfterImport: getBackendMethod('_createUpdatedDictionarySummaryAfterImport'),
            _applyImportedDictionarySettings: vi.fn(async () => {}),
            _updateDictionaryAutoUpdateStateAfterSuccess: vi.fn(async () => {}),
            _setDictionaryAutoUpdateError: vi.fn(async () => {}),
            _handleDatabaseUpdated: vi.fn(async () => {}),
            _pruneStaleProfileDictionaryOptions: vi.fn(async () => {}),
            _pruneStaleDictionaryAutoUpdates: vi.fn(async () => {}),
        };

        await getBackendMethod('_performDictionaryUpdate').call(context, dictionary, archiveContent, '2026.03');

        expect(persistedSummaries[0]?.autoUpdate).toStrictEqual({
            schedule: 'manual',
            lastUpdatedAt: 800,
            nextUpdateAt: null,
        });
    });

    test('Imported dictionary settings migrate aliases, Anki fields, and auto-update preferences', async () => {
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
                    dictionaryAutoUpdates: ['https://example.invalid/old-index.json'],
                },
            },
            _saveOptions: saveOptions,
            _ensureDictionaryDatabaseReady: async () => {},
            _dictionaryDatabase: {
                getDictionaryInfo: async () => [importedSummary],
            },
            _syncGlobalDictionaryAutoUpdateOptionsFromSummaries: getBackendMethod('_syncGlobalDictionaryAutoUpdateOptionsFromSummaries'),
            _getSortedDictionaryAutoUpdateIndexUrls: getBackendMethod('_getSortedDictionaryAutoUpdateIndexUrls'),
        };
        const previousSummary = createDictionarySummary({
            title: 'Old Dictionary',
            indexUrl: 'https://example.invalid/old-index.json',
            styles: 'old-style',
            autoUpdate: {
                schedule: 'hourly',
                lastUpdatedAt: 10,
                nextUpdateAt: 10 + DICTIONARY_AUTO_UPDATE_INTERVAL_MS,
            },
        });
        const importedSummary = createDictionarySummary({
            title: 'New Dictionary',
            indexUrl: 'https://example.invalid/new-index.json',
            styles: 'new-style',
            autoUpdate: {
                schedule: 'hourly',
                lastUpdatedAt: 10,
                nextUpdateAt: 10 + DICTIONARY_AUTO_UPDATE_INTERVAL_MS,
            },
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
        expect(context._options.global.dictionaryAutoUpdates).toStrictEqual(['https://example.invalid/new-index.json']);
        expect(saveOptions).toHaveBeenCalledTimes(2);
        expect(saveOptions).toHaveBeenCalledWith('background');
    });
});
