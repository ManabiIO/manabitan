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
import {Backend} from '../ext/js/background/backend.js';

function createRefreshGate() {
    /** @type {() => void} */
    let resolve = () => {};
    const promise = new Promise((r) => {
        resolve = r;
    });
    return {promise, resolve};
}

/**
 * @returns {Promise<void>}
 */
function waitForTaskQueue() {
    return new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
}

describe('Backend lookup refresh gating', () => {
    test('terms lookup waits for dictionary mutation to settle before querying translator', async () => {
        const mutationGate = createRefreshGate();
        const findTerms = vi.fn().mockResolvedValue({dictionaryEntries: [], originalTextLength: 2});
        const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
        Reflect.set(backend, '_dictionaryMutationPromise', mutationGate.promise);
        Reflect.set(backend, '_dictionaryRefreshPromise', null);
        Reflect.set(backend, '_translator', {findTerms});
        Reflect.set(backend, '_ensureDictionaryDatabaseReady', vi.fn().mockResolvedValue(void 0));
        Reflect.set(backend, '_getProfileOptions', vi.fn().mockReturnValue({
            general: {resultOutputMode: 'group', maxResults: 32},
            dictionaries: [],
        }));
        Reflect.set(backend, '_getTranslatorFindTermsOptions', vi.fn().mockReturnValue({enabledDictionaryMap: new Map()}));
        Reflect.set(backend, '_hasInstalledDictionaries', vi.fn().mockResolvedValue(false));

        const promise = Backend.prototype._onApiTermsFind.call(backend, {
            text: '暗記',
            details: {},
            optionsContext: {depth: 0, url: 'https://example.test/'},
        });
        await Promise.resolve();

        expect(findTerms).not.toHaveBeenCalled();

        Reflect.set(backend, '_dictionaryMutationPromise', null);
        mutationGate.resolve();
        await promise;

        expect(findTerms).toHaveBeenCalledOnce();
    });

    test('terms lookup waits for dictionary refresh to settle before querying translator', async () => {
        const refreshGate = createRefreshGate();
        const findTerms = vi.fn().mockResolvedValue({dictionaryEntries: [], originalTextLength: 2});
        const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
        Reflect.set(backend, '_dictionaryRefreshPromise', refreshGate.promise);
        Reflect.set(backend, '_translator', {findTerms});
        Reflect.set(backend, '_ensureDictionaryDatabaseReady', vi.fn().mockResolvedValue(void 0));
        Reflect.set(backend, '_getProfileOptions', vi.fn().mockReturnValue({
            general: {resultOutputMode: 'group', maxResults: 32},
            dictionaries: [],
        }));
        Reflect.set(backend, '_getTranslatorFindTermsOptions', vi.fn().mockReturnValue({enabledDictionaryMap: new Map()}));
        Reflect.set(backend, '_hasInstalledDictionaries', vi.fn().mockResolvedValue(false));

        const promise = Backend.prototype._onApiTermsFind.call(backend, {
            text: '暗記',
            details: {},
            optionsContext: {depth: 0, url: 'https://example.test/'},
        });
        await Promise.resolve();

        expect(findTerms).not.toHaveBeenCalled();

        Reflect.set(backend, '_dictionaryRefreshPromise', null);
        refreshGate.resolve();
        await promise;

        expect(findTerms).toHaveBeenCalledOnce();
    });

    test('terms lookup waits for import-mode transition to settle before querying translator', async () => {
        const importModeGate = createRefreshGate();
        const findTerms = vi.fn().mockResolvedValue({dictionaryEntries: [], originalTextLength: 2});
        const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
        Reflect.set(backend, '_dictionaryMutationPromise', null);
        Reflect.set(backend, '_dictionaryRefreshPromise', null);
        Reflect.set(backend, '_setDictionaryImportModePromise', importModeGate.promise);
        Reflect.set(backend, '_dictionaryImportModeActive', false);
        Reflect.set(backend, '_deferredDictionaryRefreshDuringImport', false);
        Reflect.set(backend, '_pendingDatabaseUpdatedNotifications', []);
        Reflect.set(backend, '_translator', {findTerms});
        Reflect.set(backend, '_ensureDictionaryDatabaseReady', vi.fn().mockResolvedValue(void 0));
        Reflect.set(backend, '_getProfileOptions', vi.fn().mockReturnValue({
            general: {resultOutputMode: 'group', maxResults: 32},
            dictionaries: [],
        }));
        Reflect.set(backend, '_getTranslatorFindTermsOptions', vi.fn().mockReturnValue({enabledDictionaryMap: new Map()}));
        Reflect.set(backend, '_hasInstalledDictionaries', vi.fn().mockResolvedValue(false));

        const promise = Backend.prototype._onApiTermsFind.call(backend, {
            text: '暗記',
            details: {},
            optionsContext: {depth: 0, url: 'https://example.test/'},
        });
        await Promise.resolve();

        expect(findTerms).not.toHaveBeenCalled();

        Reflect.set(backend, '_setDictionaryImportModePromise', null);
        importModeGate.resolve();
        await promise;

        expect(findTerms).toHaveBeenCalledOnce();
    });

    test('terms lookup flushes pending dictionary refresh before querying translator', async () => {
        const findTerms = vi.fn().mockResolvedValue({dictionaryEntries: [], originalTextLength: 2});
        const refreshDictionaryDatabaseAfterUpdate = vi.fn().mockResolvedValue(void 0);
        const sendMessageAllTabsIgnoreResponse = vi.fn();
        const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
        Reflect.set(backend, '_dictionaryMutationPromise', null);
        Reflect.set(backend, '_dictionaryRefreshPromise', null);
        Reflect.set(backend, '_dictionaryImportModeActive', false);
        Reflect.set(backend, '_deferredDictionaryRefreshDuringImport', true);
        Reflect.set(backend, '_pendingDatabaseUpdatedNotifications', [{type: 'dictionary', cause: 'import'}]);
        Reflect.set(backend, '_setDictionaryImportModePromise', null);
        Reflect.set(backend, '_dictionaryRefreshRetryTimer', null);
        Reflect.set(backend, '_dictionaryRefreshRetryAttempt', 0);
        Reflect.set(backend, '_translator', {findTerms});
        Reflect.set(backend, '_ensureDictionaryDatabaseReady', vi.fn().mockResolvedValue(void 0));
        Reflect.set(backend, '_refreshDictionaryDatabaseAfterUpdate', refreshDictionaryDatabaseAfterUpdate);
        Reflect.set(backend, '_sendMessageAllTabsIgnoreResponse', sendMessageAllTabsIgnoreResponse);
        Reflect.set(backend, '_getProfileOptions', vi.fn().mockReturnValue({
            general: {resultOutputMode: 'group', maxResults: 32},
            dictionaries: [],
        }));
        Reflect.set(backend, '_getTranslatorFindTermsOptions', vi.fn().mockReturnValue({enabledDictionaryMap: new Map()}));
        Reflect.set(backend, '_hasInstalledDictionaries', vi.fn().mockResolvedValue(false));

        await Backend.prototype._onApiTermsFind.call(backend, {
            text: '暗記',
            details: {},
            optionsContext: {depth: 0, url: 'https://example.test/'},
        });

        expect(refreshDictionaryDatabaseAfterUpdate).toHaveBeenCalledOnce();
        expect(sendMessageAllTabsIgnoreResponse).toHaveBeenCalledWith({
            action: 'applicationDatabaseUpdated',
            params: {type: 'dictionary', cause: 'import'},
        });
        expect(Reflect.get(backend, '_deferredDictionaryRefreshDuringImport')).toBe(false);
        expect(Reflect.get(backend, '_pendingDatabaseUpdatedNotifications')).toStrictEqual([]);
        expect(findTerms).toHaveBeenCalledOnce();
        expect(refreshDictionaryDatabaseAfterUpdate.mock.invocationCallOrder[0]).toBeLessThan(findTerms.mock.invocationCallOrder[0]);
    });

    test('terms lookup still queries translator when pending dictionary refresh retry fails', async () => {
        vi.useFakeTimers();
        try {
            const findTerms = vi.fn().mockResolvedValue({dictionaryEntries: [], originalTextLength: 2});
            const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
            Reflect.set(backend, '_dictionaryMutationPromise', null);
            Reflect.set(backend, '_dictionaryRefreshPromise', null);
            Reflect.set(backend, '_dictionaryImportModeActive', false);
            Reflect.set(backend, '_deferredDictionaryRefreshDuringImport', true);
            Reflect.set(backend, '_pendingDatabaseUpdatedNotifications', [{type: 'dictionary', cause: 'delete'}]);
            Reflect.set(backend, '_setDictionaryImportModePromise', null);
            Reflect.set(backend, '_dictionaryRefreshRetryTimer', null);
            Reflect.set(backend, '_dictionaryRefreshRetryAttempt', 0);
            Reflect.set(backend, '_translator', {findTerms});
            Reflect.set(backend, '_ensureDictionaryDatabaseReady', vi.fn().mockResolvedValue(void 0));
            Reflect.set(backend, '_refreshDictionaryDatabaseAfterUpdate', vi.fn().mockRejectedValue(new Error('refresh failed')));
            Reflect.set(backend, '_sendMessageAllTabsIgnoreResponse', vi.fn());
            Reflect.set(backend, '_getProfileOptions', vi.fn().mockReturnValue({
                general: {resultOutputMode: 'group', maxResults: 32},
                dictionaries: [],
            }));
            Reflect.set(backend, '_getTranslatorFindTermsOptions', vi.fn().mockReturnValue({enabledDictionaryMap: new Map()}));
            Reflect.set(backend, '_hasInstalledDictionaries', vi.fn().mockResolvedValue(false));

            await Backend.prototype._onApiTermsFind.call(backend, {
                text: '暗記',
                details: {},
                optionsContext: {depth: 0, url: 'https://example.test/'},
            });

            expect(findTerms).toHaveBeenCalledOnce();
            expect(Reflect.get(backend, '_deferredDictionaryRefreshDuringImport')).toBe(true);
            expect(Reflect.get(backend, '_pendingDatabaseUpdatedNotifications')).toStrictEqual([{type: 'dictionary', cause: 'delete'}]);
            expect(Reflect.get(backend, '_dictionaryRefreshRetryTimer')).not.toBe(null);
        } finally {
            vi.clearAllTimers();
            vi.useRealTimers();
        }
    });

    test('terms lookup returns the initial result when self-heal refresh fails', async () => {
        const findTerms = vi.fn().mockResolvedValue({dictionaryEntries: [], originalTextLength: 2});
        const refreshDictionaryDatabaseAfterUpdate = vi.fn().mockRejectedValue(new Error('refresh failed'));
        const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
        Reflect.set(backend, '_dictionaryMutationPromise', null);
        Reflect.set(backend, '_dictionaryRefreshPromise', null);
        Reflect.set(backend, '_translator', {findTerms});
        Reflect.set(backend, '_dictionaryDatabase', {getDictionaryInfo: vi.fn().mockResolvedValue([{title: 'JMdict'}])});
        Reflect.set(backend, '_ensureDictionaryDatabaseReady', vi.fn().mockResolvedValue(void 0));
        Reflect.set(backend, '_refreshDictionaryDatabaseAfterUpdate', refreshDictionaryDatabaseAfterUpdate);
        Reflect.set(backend, '_getProfileOptions', vi.fn().mockReturnValue({
            general: {resultOutputMode: 'group', maxResults: 32},
            dictionaries: [{name: 'JMdict', enabled: true}],
        }));
        Reflect.set(backend, '_getTranslatorFindTermsOptions', vi.fn().mockReturnValue({
            enabledDictionaryMap: new Map([['JMdict', {
                index: 0,
                alias: 'JMdict',
                allowSecondarySearches: false,
                partsOfSpeechFilter: true,
                useDeinflections: true,
            }]]),
        }));

        const result = await Backend.prototype._onApiTermsFind.call(backend, {
            text: '暗記',
            details: {},
            optionsContext: {depth: 0, url: 'https://example.test/'},
        });

        expect(result).toStrictEqual({dictionaryEntries: [], originalTextLength: 2});
        expect(findTerms).toHaveBeenCalledOnce();
        expect(refreshDictionaryDatabaseAfterUpdate).toHaveBeenCalledOnce();
    });

    test('terms lookup does not wait for best-effort lookup cache warmup by default', async () => {
        const warmGate = createRefreshGate();
        const findTerms = vi.fn().mockResolvedValue({dictionaryEntries: [], originalTextLength: 2});
        const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
        Reflect.set(backend, '_dictionaryMutationPromise', null);
        Reflect.set(backend, '_dictionaryRefreshPromise', null);
        Reflect.set(backend, '_dictionaryLookupWarmPromise', warmGate.promise);
        Reflect.set(backend, '_translator', {findTerms});
        Reflect.set(backend, '_ensureDictionaryDatabaseReady', vi.fn().mockResolvedValue(void 0));
        Reflect.set(backend, '_getProfileOptions', vi.fn().mockReturnValue({
            general: {resultOutputMode: 'group', maxResults: 32},
            dictionaries: [],
        }));
        Reflect.set(backend, '_getTranslatorFindTermsOptions', vi.fn().mockReturnValue({enabledDictionaryMap: new Map()}));
        Reflect.set(backend, '_hasInstalledDictionaries', vi.fn().mockResolvedValue(false));

        await Backend.prototype._onApiTermsFind.call(backend, {
            text: '暗記',
            details: {},
            optionsContext: {depth: 0, url: 'https://example.test/'},
        });

        expect(findTerms).toHaveBeenCalledOnce();
        Reflect.set(backend, '_dictionaryLookupWarmPromise', null);
        warmGate.resolve();
    });

    test('terms lookup can explicitly wait for best-effort lookup cache warmup', async () => {
        const warmGate = createRefreshGate();
        const findTerms = vi.fn().mockResolvedValue({dictionaryEntries: [], originalTextLength: 2});
        const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
        Reflect.set(backend, '_dictionaryMutationPromise', null);
        Reflect.set(backend, '_dictionaryRefreshPromise', null);
        Reflect.set(backend, '_dictionaryLookupWarmPromise', warmGate.promise);
        Reflect.set(backend, '_translator', {findTerms});
        Reflect.set(backend, '_ensureDictionaryDatabaseReady', vi.fn().mockResolvedValue(void 0));
        Reflect.set(backend, '_getProfileOptions', vi.fn().mockReturnValue({
            general: {resultOutputMode: 'group', maxResults: 32},
            dictionaries: [],
        }));
        Reflect.set(backend, '_getTranslatorFindTermsOptions', vi.fn().mockReturnValue({enabledDictionaryMap: new Map()}));
        Reflect.set(backend, '_hasInstalledDictionaries', vi.fn().mockResolvedValue(false));

        const promise = Backend.prototype._onApiTermsFind.call(backend, {
            text: '暗記',
            details: {waitForLookupWarm: true},
            optionsContext: {depth: 0, url: 'https://example.test/'},
        });
        await Promise.resolve();

        expect(findTerms).not.toHaveBeenCalled();

        Reflect.set(backend, '_dictionaryLookupWarmPromise', null);
        warmGate.resolve();
        await promise;

        expect(findTerms).toHaveBeenCalledOnce();
    });

    test('lookup cache warmup reruns when another warm request arrives during active warmup', async () => {
        const firstWarmGate = createRefreshGate();
        const warmTermLookupCaches = vi.fn()
            .mockImplementationOnce(() => firstWarmGate.promise)
            .mockResolvedValue(void 0);
        const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
        Reflect.set(backend, '_options', {});
        Reflect.set(backend, '_dictionaryRefreshPromise', null);
        Reflect.set(backend, '_dictionaryLookupWarmPromise', null);
        Reflect.set(backend, '_dictionaryLookupWarmQueuedReason', null);
        Reflect.set(backend, '_ensureDictionaryDatabaseReady', vi.fn().mockResolvedValue(void 0));
        Reflect.set(backend, '_dictionaryDatabase', {warmTermLookupCaches});
        Reflect.set(backend, '_getProfileOptions', vi.fn().mockReturnValue({
            dictionaries: [
                {name: 'JMdict', enabled: true},
                {name: 'JMdict', enabled: true},
                {name: 'Jitendex', enabled: false},
                {name: 'Jitendex', enabled: true},
            ],
        }));

        Backend.prototype._warmEnabledDictionaryLookupCaches.call(backend, 'initial-refresh');
        await waitForTaskQueue();

        expect(warmTermLookupCaches).toHaveBeenCalledTimes(1);
        expect(warmTermLookupCaches).toHaveBeenLastCalledWith(['JMdict', 'Jitendex']);

        Backend.prototype._warmEnabledDictionaryLookupCaches.call(backend, 'queued-refresh');
        expect(Reflect.get(backend, '_dictionaryLookupWarmQueuedReason')).toBe('queued-refresh');

        firstWarmGate.resolve();
        await waitForTaskQueue();
        await waitForTaskQueue();

        expect(warmTermLookupCaches).toHaveBeenCalledTimes(2);
        expect(warmTermLookupCaches).toHaveBeenLastCalledWith(['JMdict', 'Jitendex']);
        expect(Reflect.get(backend, '_dictionaryLookupWarmQueuedReason')).toBe(null);
    });

    test('dictionary refresh uses proxy refreshConnection without duplicate offscreen refresh', async () => {
        const refreshConnection = vi.fn().mockResolvedValue(void 0);
        const sendMessagePromise = vi.fn().mockResolvedValue(void 0);
        const warmEnabledDictionaryLookupCaches = vi.fn();
        const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
        Reflect.set(backend, '_dictionaryImportModeActive', false);
        Reflect.set(backend, '_dictionaryRefreshPromise', null);
        Reflect.set(backend, '_dictionaryRefreshQueued', false);
        Reflect.set(backend, '_offscreen', {sendMessagePromise});
        Reflect.set(backend, '_dictionaryDatabase', {refreshConnection});
        Reflect.set(backend, '_warmEnabledDictionaryLookupCaches', warmEnabledDictionaryLookupCaches);

        await Backend.prototype._refreshDictionaryDatabaseAfterUpdate.call(backend);

        expect(sendMessagePromise).not.toHaveBeenCalled();
        expect(refreshConnection).toHaveBeenCalledOnce();
        expect(warmEnabledDictionaryLookupCaches).toHaveBeenCalledWith('dictionary-refresh-after-update');
    });

    test('dictionary refresh fallback continues when direct offscreen refresh fails', async () => {
        const sendMessagePromise = vi.fn().mockRejectedValue(new Error('offscreen refresh failed'));
        const warmEnabledDictionaryLookupCaches = vi.fn();
        const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
        Reflect.set(backend, '_dictionaryImportModeActive', false);
        Reflect.set(backend, '_dictionaryRefreshPromise', null);
        Reflect.set(backend, '_dictionaryRefreshQueued', false);
        Reflect.set(backend, '_offscreen', {sendMessagePromise});
        Reflect.set(backend, '_dictionaryDatabase', {isPrepared: vi.fn().mockReturnValue(false)});
        Reflect.set(backend, '_warmEnabledDictionaryLookupCaches', warmEnabledDictionaryLookupCaches);

        await Backend.prototype._refreshDictionaryDatabaseAfterUpdate.call(backend);

        expect(sendMessagePromise).toHaveBeenCalledWith({action: 'databaseRefreshOffscreen'});
        expect(warmEnabledDictionaryLookupCaches).toHaveBeenCalledWith('dictionary-refresh-after-update');
    });

    test('kanji lookup waits for dictionary refresh to settle before querying translator', async () => {
        const refreshGate = createRefreshGate();
        const findKanji = vi.fn().mockResolvedValue([]);
        const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
        Reflect.set(backend, '_dictionaryRefreshPromise', refreshGate.promise);
        Reflect.set(backend, '_translator', {findKanji});
        Reflect.set(backend, '_ensureDictionaryDatabaseReady', vi.fn().mockResolvedValue(void 0));
        Reflect.set(backend, '_getProfileOptions', vi.fn().mockReturnValue({
            general: {maxResults: 32},
        }));
        Reflect.set(backend, '_getTranslatorFindKanjiOptions', vi.fn().mockReturnValue({}));

        const promise = Backend.prototype._onApiKanjiFind.call(backend, {
            text: '暗',
            optionsContext: {depth: 0, url: 'https://example.test/'},
        });
        await Promise.resolve();

        expect(findKanji).not.toHaveBeenCalled();

        Reflect.set(backend, '_dictionaryRefreshPromise', null);
        refreshGate.resolve();
        await promise;

        expect(findKanji).toHaveBeenCalledOnce();
    });

    test('term frequencies wait for dictionary refresh to settle before querying translator', async () => {
        const refreshGate = createRefreshGate();
        const getTermFrequencies = vi.fn().mockResolvedValue([]);
        const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
        Reflect.set(backend, '_dictionaryRefreshPromise', refreshGate.promise);
        Reflect.set(backend, '_translator', {getTermFrequencies});
        Reflect.set(backend, '_ensureDictionaryDatabaseReady', vi.fn().mockResolvedValue(void 0));

        const promise = Backend.prototype._onApiGetTermFrequencies.call(backend, {
            termReadingList: [{term: '暗記', reading: 'あんき'}],
            dictionaries: ['JMdict'],
        });
        await Promise.resolve();

        expect(getTermFrequencies).not.toHaveBeenCalled();

        Reflect.set(backend, '_dictionaryRefreshPromise', null);
        refreshGate.resolve();
        await promise;

        expect(getTermFrequencies).toHaveBeenCalledOnce();
    });

    test('term frequencies wait for dictionary mutation to settle before querying translator', async () => {
        const mutationGate = createRefreshGate();
        const getTermFrequencies = vi.fn().mockResolvedValue([]);
        const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
        Reflect.set(backend, '_dictionaryMutationPromise', mutationGate.promise);
        Reflect.set(backend, '_dictionaryRefreshPromise', null);
        Reflect.set(backend, '_translator', {getTermFrequencies});
        Reflect.set(backend, '_ensureDictionaryDatabaseReady', vi.fn().mockResolvedValue(void 0));

        const promise = Backend.prototype._onApiGetTermFrequencies.call(backend, {
            termReadingList: [{term: '暗記', reading: 'あんき'}],
            dictionaries: ['JMdict'],
        });
        await Promise.resolve();

        expect(getTermFrequencies).not.toHaveBeenCalled();

        Reflect.set(backend, '_dictionaryMutationPromise', null);
        mutationGate.resolve();
        await promise;

        expect(getTermFrequencies).toHaveBeenCalledOnce();
    });

    test('media fetch waits for dictionary mutation to settle before querying the database', async () => {
        const mutationGate = createRefreshGate();
        const getMedia = vi.fn().mockResolvedValue([]);
        const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
        Reflect.set(backend, '_dictionaryMutationPromise', mutationGate.promise);
        Reflect.set(backend, '_dictionaryRefreshPromise', null);
        Reflect.set(backend, '_ensureDictionaryDatabaseReady', vi.fn().mockResolvedValue(void 0));
        Reflect.set(backend, '_dictionaryDatabase', {getMedia});

        const promise = Backend.prototype._onApiGetMedia.call(backend, {
            targets: [{dictionary: 'JMdict', path: 'image.png'}],
        });
        await Promise.resolve();

        expect(getMedia).not.toHaveBeenCalled();

        Reflect.set(backend, '_dictionaryMutationPromise', null);
        mutationGate.resolve();
        await promise;

        expect(getMedia).toHaveBeenCalledOnce();
    });

    test('dictionary export waits for dictionary mutation to settle before querying the database', async () => {
        const mutationGate = createRefreshGate();
        const exportDatabase = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
        const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
        Reflect.set(backend, '_dictionaryMutationPromise', mutationGate.promise);
        Reflect.set(backend, '_dictionaryRefreshPromise', null);
        Reflect.set(backend, '_ensureDictionaryDatabaseReady', vi.fn().mockResolvedValue(void 0));
        Reflect.set(backend, '_dictionaryDatabase', {exportDatabase});

        const promise = Backend.prototype._onApiExportDictionaryDatabase.call(backend);
        await Promise.resolve();

        expect(exportDatabase).not.toHaveBeenCalled();

        Reflect.set(backend, '_dictionaryMutationPromise', null);
        mutationGate.resolve();
        const result = await promise;

        expect(exportDatabase).toHaveBeenCalledOnce();
        expect(result).toBe('AQID');
    });

    test('delete dictionary refreshes the backend dictionary connection before returning', async () => {
        const deleteDictionary = vi.fn().mockResolvedValue(void 0);
        const refreshDictionaryDatabaseAfterUpdate = vi.fn().mockResolvedValue(void 0);
        const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
        Reflect.set(backend, '_dictionaryMutationPromise', null);
        Reflect.set(backend, '_ensureDictionaryDatabaseReady', vi.fn().mockResolvedValue(void 0));
        Reflect.set(backend, '_dictionaryDatabase', {deleteDictionary});
        Reflect.set(backend, '_refreshDictionaryDatabaseAfterUpdate', refreshDictionaryDatabaseAfterUpdate);

        await Backend.prototype._onApiDeleteDictionaryByTitle.call(backend, {dictionaryTitle: 'JMdict'});

        expect(deleteDictionary).toHaveBeenCalledOnce();
        expect(refreshDictionaryDatabaseAfterUpdate).toHaveBeenCalledOnce();
    });
});
