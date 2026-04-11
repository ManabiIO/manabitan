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
