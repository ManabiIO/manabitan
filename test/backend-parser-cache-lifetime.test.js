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

/**
 * @param {string} reading
 * @returns {import('translator').FindTermsResult}
 */
function lookupResult(reading) {
    return {
        dictionaryEntries: [{
            type: 'term',
            isPrimary: true,
            textProcessorRuleChainCandidates: [],
            inflectionRuleChainCandidates: [],
            score: 0,
            frequencyOrder: 0,
            dictionaryIndex: 0,
            dictionaryAlias: 'test',
            sourceTermExactMatchCount: 1,
            matchPrimaryReading: true,
            maxOriginalTextLength: 2,
            headwords: [{
                index: 0,
                term: '日本',
                reading,
                headwordIndex: 0,
                sources: [{originalText: '日本', transformedText: '日本', deinflectedText: '日本', isPrimary: true, matchType: 'exact', matchSource: 'term'}],
                tags: [],
                wordClasses: [],
            }],
            definitions: [],
            frequencies: [],
            pronunciations: [],
        }],
        originalTextLength: 2,
    };
}

function createParserHarness() {
    const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
    const findTerms = vi.fn(async () => lookupResult('にほん'));
    const refresh = vi.fn(async () => {});
    Object.assign(backend, {
        _textParseCache: new Map(),
        _textParseCacheGeneration: 0,
        _dictionaryMutationPromise: null,
        _dictionaryRefreshPromise: null,
        _setDictionaryImportModePromise: null,
        _dictionaryImportModeActive: false,
        _deferredDictionaryRefreshDuringImport: false,
        _pendingDatabaseUpdatedNotifications: [],
        _ensureDictionaryDatabaseReady: async () => {},
        _refreshDictionaryDatabaseAfterUpdate: refresh,
        _sendApplicationDatabaseUpdated: vi.fn(),
        _translator: {findTerms, clearDatabaseCaches: vi.fn(async () => {})},
        _getProfileOptions: () => ({general: {enable: true}, anki: {}, parsing: {}, clipboard: {}}),
        _getTranslatorFindTermsOptions: () => ({}),
        _getOptionsFull: () => ({profiles: []}),
        _updateBadge() {},
        _setupContextMenu() {},
        _sendMessageAllTabsIgnoreResponse() {},
        _anki: {},
        _mecab: {setEnabled() {}},
        _yomitanApi: {async setEnabled() {}},
        _clipboardMonitor: {start() {}, stop() {}},
        _accessibilityController: {async update() {}},
    });
    const parse = () => backend._onApiParseText({
        text: '日本',
        optionsContext: {index: 0},
        scanLength: 20,
        useInternalParser: true,
        useMecabParser: false,
        useAllFrequencyDictionaries: false,
    }, {});
    return {backend, findTerms, refresh, parse};
}

/**
 * @param {import('api').ParseTextResultItem[]} result
 * @returns {string}
 */
function readingOf(result) {
    return result[0].content.flat().map(({reading}) => reading).join('');
}

describe('Backend parsed-reading cache lifetime', () => {
    test('unchanged dictionaries reuse cached parsed readings', async () => {
        const {findTerms, parse} = createParserHarness();
        expect(readingOf(await parse())).toBe('にほん');
        expect(readingOf(await parse())).toBe('にほん');
        expect(findTerms).toHaveBeenCalledTimes(1);
    });

    test('a stable profile ID with an outdated index cannot contaminate the new occupant', async () => {
        const {backend} = createParserHarness();
        const profiles = [
            {id: 'profile-b', options: {general: {language: 'ja'}}},
            {id: 'profile-a', options: {general: {language: 'ja'}}},
        ];
        Reflect.set(backend, '_getOptionsFull', () => ({profileCurrent: 0, profiles}));
        Reflect.set(backend, '_getProfileOptions', Backend.prototype._getProfileOptions);
        Reflect.set(backend, '_getTranslatorFindTermsOptions', (/** @type {unknown} */ _mode, /** @type {unknown} */ _details, /** @type {unknown} */ options) => options);
        const findTerms = vi.fn(async (/** @type {unknown} */ _mode, /** @type {unknown} */ _text, /** @type {unknown} */ options) => lookupResult(options === profiles[1].options ? 'にほん' : 'にっぽん'));
        Reflect.set(backend._translator, 'findTerms', findTerms);
        /**
         * @param {import('settings').OptionsContext} optionsContext
         * @returns {Promise<import('api').ParseTextResultItem[]>}
         */
        const parse = async (optionsContext) => await backend._onApiParseText({
            text: '日本', optionsContext, scanLength: 20, useInternalParser: true, useMecabParser: false, useAllFrequencyDictionaries: false,
        }, {});

        // A retained page still addresses profile A at its former index. The
        // backend resolves the ID correctly after B moves into that slot.
        expect(readingOf(await parse({index: 0, profileId: 'profile-a'}))).toBe('にほん');
        expect(readingOf(await parse({index: 0, profileId: 'profile-b'}))).toBe('にっぽん');
        expect(readingOf(await parse({index: 0}))).toBe('にっぽん');
    });

    test.each(/** @type {const} */ (['import', 'edit', 'delete', 'purge']))('a dictionary %s invalidates cached readings', async (cause) => {
        const {backend, findTerms, parse} = createParserHarness();
        expect(readingOf(await parse())).toBe('にほん');
        findTerms.mockResolvedValue(lookupResult('にっぽん'));
        await backend._triggerDatabaseUpdated('dictionary', cause);
        expect(readingOf(await parse())).toBe('にっぽん');
        expect(findTerms).toHaveBeenCalledTimes(2);
    });

    test.each(/** @type {const} */ (['delete', 'edit']))('a committed %s invalidates before the page sends its notification', async (cause) => {
        const {backend, findTerms, parse} = createParserHarness();
        await parse();
        findTerms.mockResolvedValue(lookupResult('にっぽん'));
        await backend._refreshDictionaryDatabaseAfterCommittedMutation(cause);
        expect(readingOf(await parse())).toBe('にっぽん');
    });

    test.each(['dictionary', 'settings'])('an old lookup cannot repopulate the cache after a %s update', async (change) => {
        const {backend, findTerms, parse} = createParserHarness();
        /** @type {PromiseWithResolvers<import('translator').FindTermsResult>} */
        const oldLookup = Promise.withResolvers();
        findTerms.mockImplementationOnce(() => oldLookup.promise);
        const oldParse = parse();
        await vi.waitFor(() => expect(findTerms).toHaveBeenCalledTimes(1));
        if (change === 'dictionary') {
            await backend._triggerDatabaseUpdated('dictionary', 'import');
        } else {
            backend._applyOptions('test');
        }
        findTerms.mockResolvedValue(lookupResult('にっぽん'));
        expect(readingOf(await parse())).toBe('にっぽん');
        oldLookup.resolve(lookupResult('にほん'));
        await oldParse;
        expect(readingOf(await parse())).toBe('にっぽん');
        expect(findTerms).toHaveBeenCalledTimes(2);
    });

    test.each(['mutation', 'refresh'])('parsing waits for an in-progress dictionary %s', async (operation) => {
        const {backend, findTerms, parse} = createParserHarness();
        const gate = Promise.withResolvers();
        const field = operation === 'mutation' ? '_dictionaryMutationPromise' : '_dictionaryRefreshPromise';
        Reflect.set(backend, field, gate.promise);
        const pending = parse();
        await new Promise((resolve) => { setTimeout(resolve, 0); });
        const startedEarly = findTerms.mock.calls.length;
        Reflect.set(backend, field, null);
        gate.resolve(void 0);
        await pending;
        expect(startedEarly).toBe(0);
        expect(findTerms).toHaveBeenCalledTimes(1);
    });

    test('a published import whose page closes invalidates existing parsed readings', async () => {
        const {backend, findTerms, parse} = createParserHarness();
        expect(readingOf(await parse())).toBe('にほん');
        Object.assign(backend, {
            _dictionaryImportModeActive: true,
            _dictionaryImportOwners: new Set(['owner']),
            _dictionaryImportOwnerPublications: new Set(['owner']),
            _ownedDictionaryImports: new Map(),
            _dictionaryDatabasePreparePromise: null,
            _clearDictionaryRefreshRetry() {},
        });
        findTerms.mockResolvedValue(lookupResult('にっぽん'));

        await backend._setDictionaryImportMode(false, 'owner');

        expect(backend._sendApplicationDatabaseUpdated).toHaveBeenCalledExactlyOnceWith('dictionary', 'import');
        expect(readingOf(await parse())).toBe('にっぽん');
        expect(findTerms).toHaveBeenCalledTimes(2);
    });

    test('readings cached during active import do not survive its final connection refresh', async () => {
        const {backend, findTerms, parse} = createParserHarness();
        Object.assign(backend, {
            _dictionaryImportModeActive: true,
            _dictionaryImportOwners: new Set(['owner']),
            _ownedDictionaryImports: new Map(),
            _dictionaryDatabasePreparePromise: null,
            _clearDictionaryRefreshRetry() {},
        });
        await backend._triggerDatabaseUpdated('dictionary', 'import');
        expect(readingOf(await parse())).toBe('にほん');
        findTerms.mockResolvedValue(lookupResult('にっぽん'));

        await backend._setDictionaryImportMode(false, 'owner');

        expect(readingOf(await parse())).toBe('にっぽん');
        expect(findTerms).toHaveBeenCalledTimes(2);
    });
});
