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
 * @param {string} title
 * @param {string} [expression]
 * @param {string} [reading]
 * @returns {{backend: Backend, probe: import('dictionary-database').DictionaryTermProbe, options: import('settings').ProfileOptions, getProbe: ReturnType<typeof vi.fn>, counts: ReturnType<typeof vi.fn>, findBulk: ReturnType<typeof vi.fn>, findTerms: ReturnType<typeof vi.fn>}}
 */
function createFixture(title, expression = '猫', reading = 'ねこ') {
    const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
    const probe = {expression, reading};
    const getProbe = vi.fn().mockResolvedValue(probe);
    const counts = vi.fn().mockResolvedValue({counts: [{terms: 1}]});
    const findBulk = vi.fn().mockResolvedValue([{dictionary: title, term: expression, reading}]);
    const findTerms = vi.fn().mockResolvedValue({dictionaryEntries: [{}]});
    const options = /** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({dictionaries: [{name: title, enabled: true}]}));
    Reflect.set(backend, '_awaitDictionaryMutationSettled', vi.fn().mockResolvedValue(void 0));
    Reflect.set(backend, '_awaitDictionaryRefreshSettled', vi.fn().mockResolvedValue(void 0));
    Reflect.set(backend, '_ensureDictionaryDatabaseReady', vi.fn().mockResolvedValue(void 0));
    Reflect.set(backend, '_dictionaryDatabase', {
        getDictionaryInfo: vi.fn().mockResolvedValue([{title}]),
        getDictionaryCounts: counts,
        getDictionaryTermProbe: getProbe,
        findTermsBulk: findBulk,
    });
    Reflect.set(backend, '_translator', {findTerms});
    Reflect.set(backend, '_getProfileOptions', vi.fn().mockReturnValue(options));
    Reflect.set(backend, '_getTranslatorPreparedProfileOptions', vi.fn().mockReturnValue({enabledDictionaryMap: new Map([[title, {}]])}));
    Reflect.set(backend, '_getTranslatorFindTermsOptions', vi.fn().mockReturnValue({}));
    return {backend, probe, options, getProbe, counts, findBulk, findTerms};
}

describe('Backend exact dictionary identity boundaries', () => {
    for (const title of ['Dictionary', ' Dictionary ', '\ufeffDictionary', ' ']) {
        test(`probe API preserves ${JSON.stringify(title)}`, async () => {
            const {backend, probe, getProbe} = createFixture(title);
            expect(await backend._onApiGetDictionaryTermProbe({dictionaryTitle: title})).toEqual(probe);
            expect(getProbe).toHaveBeenCalledWith(title);
        });
        test(`visibility verifies exactly ${JSON.stringify(title)}`, async () => {
            const {backend, probe, getProbe, counts, findBulk, findTerms} = createFixture(title);
            expect(await backend._verifyDictionaryVisibilityInternal(title, true)).toMatchObject({
                ok: true,
                dictionaryTitle: title,
                installed: true,
                enabled: true,
                probe,
                directMatch: true,
                translatorMatch: true,
                reason: null,
            });
            expect(counts).toHaveBeenCalledWith([title], false);
            expect(getProbe).toHaveBeenCalledWith(title);
            expect(findBulk).toHaveBeenCalledWith(['猫', 'ねこ'], new Set([title]), 'exact');
            expect(findTerms).toHaveBeenCalledWith('split', '猫', expect.objectContaining({mainDictionary: title}));
        });
    }

    test('an installed trimmed sibling cannot satisfy exact title verification', async () => {
        const {backend, counts, getProbe} = createFixture('Dictionary');
        counts.mockResolvedValue({counts: [{terms: 0}]});
        expect(await backend._verifyDictionaryVisibilityInternal(' Dictionary ', true)).toMatchObject({
            ok: false,
            dictionaryTitle: ' Dictionary ',
            installed: false,
            enabled: false,
            reason: 'dictionary-not-installed',
        });
        expect(getProbe).not.toHaveBeenCalled();
    });

    for (const [expression, reading] of [['\ufeff猫', '\ufeffねこ'], [' 猫 ', ''], ['', ' ねこ ']]) {
        test(`verification keeps exact probe fields ${JSON.stringify([expression, reading])}`, async () => {
            const {backend, probe, options, findBulk, findTerms} = createFixture('Dictionary', expression, reading);
            const candidates = [...new Set([expression, reading].filter((value) => value.length > 0))];
            expect(await backend._probeDictionaryVisibilityDirect('Dictionary', probe)).toBe(true);
            expect(findBulk).toHaveBeenCalledWith(candidates, new Set(['Dictionary']), 'exact');
            expect(await backend._probeDictionaryVisibilityTranslator('Dictionary', probe, options)).toBe(true);
            expect(findTerms).toHaveBeenCalledWith('split', expression.length > 0 ? expression : reading, expect.objectContaining({mainDictionary: 'Dictionary'}));
        });
    }

    test('empty title and empty probe fields remain rejected without lookup', async () => {
        const {backend, probe, options, getProbe, findBulk, findTerms} = createFixture('Dictionary', '', '');
        expect(await backend._onApiGetDictionaryTermProbe({dictionaryTitle: ''})).toBeNull();
        expect(await backend._verifyDictionaryVisibilityInternal('', true)).toMatchObject({ok: false, reason: 'missing-dictionary-title'});
        expect(await backend._probeDictionaryVisibilityDirect('Dictionary', probe)).toBe(false);
        expect(await backend._probeDictionaryVisibilityTranslator('Dictionary', probe, options)).toBe(false);
        expect(getProbe).not.toHaveBeenCalled();
        expect(findBulk).not.toHaveBeenCalled();
        expect(findTerms).not.toHaveBeenCalled();
    });

    for (const offscreen of [false, true]) {
        test(`diagnostics retain exact SQL and index identity, offscreen=${offscreen}`, async () => {
            const names = ['Dictionary', ' Dictionary ', '\ufeffDictionary', ' '];
            const findIds = vi.fn().mockReturnValue([]);
            const selectObjects = vi.fn().mockReturnValue([]);
            const database = {
                _findDirectTermIds: findIds,
                _fetchTermRowsByIds: vi.fn().mockResolvedValue(new Map()),
                _ensureDirectTermIndexesLoaded: vi.fn().mockResolvedValue(void 0),
                _requireDb: vi.fn().mockReturnValue({selectObjects}),
                _termRecordStore: {},
                getTermContentDiagnostics: vi.fn().mockReturnValue({}),
            };
            const selfDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'self');
            try {
                let result;
                if (offscreen) {
                    Object.defineProperty(globalThis, 'self', {configurable: true, value: {addEventListener: vi.fn()}});
                    const {OffscreenDictionaryWorkerHandler} = await import('../ext/js/background/offscreen-dictionary-worker.js');
                    const worker = /** @type {OffscreenDictionaryWorkerHandler} */ (Object.create(OffscreenDictionaryWorkerHandler.prototype));
                    Reflect.set(worker, '_dictionaryDatabase', database);
                    result = await worker._debugDictionaryLookupState('猫', names);
                } else {
                    const {backend} = createFixture('Dictionary');
                    Reflect.set(backend, '_dictionaryDatabase', database);
                    result = await backend._debugDictionaryLookupStateLocal('猫', names);
                }
                expect(result).toMatchObject({
                    ok: true,
                    dictionaryNames: names,
                    directHits: names.map((dictionary) => ({dictionary, expressionHitCount: 0, readingHitCount: 0})),
                });
                expect(findIds.mock.calls).toEqual(names.flatMap((name) => [[name, '猫', 'expression'], [name, '猫', 'reading']]));
                if (offscreen) {
                    expect(selectObjects).toHaveBeenCalledTimes(names.length);
                    for (const [i, name] of names.entries()) {
                        expect(selectObjects.mock.calls[i][1]).toEqual({$dictionary: name, $text: '猫'});
                    }
                }
            } finally {
                if (typeof selfDescriptor === 'undefined') {
                    Reflect.deleteProperty(globalThis, 'self');
                } else {
                    Object.defineProperty(globalThis, 'self', selfDescriptor);
                }
            }
        });
    }
});
