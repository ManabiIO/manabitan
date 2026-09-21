/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {beforeAll, describe, expect, test, vi} from 'vitest';
import {Frontend} from '../ext/js/app/frontend.js';
import {Backend} from '../ext/js/background/backend.js';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';

/** @type {typeof import('../ext/js/background/offscreen-dictionary-worker.js').OffscreenDictionaryWorkerHandler} */
let OffscreenHandler;
beforeAll(async () => {
    vi.stubGlobal('self', {addEventListener: vi.fn()});
    try {
        ({OffscreenDictionaryWorkerHandler: OffscreenHandler} = await import('../ext/js/background/offscreen-dictionary-worker.js'));
    } finally {
        vi.unstubAllGlobals();
    }
});

/**
 * Keep actual database probe selection and backend verification methods. Only
 * the storage and translator boundaries are controlled, with exact identities.
 * @param {string} title
 * @param {string} expression
 * @param {string} reading
 * @returns {{backend: Backend, database: DictionaryDatabase, getByIdsAsync: ReturnType<typeof vi.fn>, findTerms: ReturnType<typeof vi.fn>, findTermsBulk: ReturnType<typeof vi.fn>, getDictionaryCounts: ReturnType<typeof vi.fn>}}
 */
function fixture(title, expression, reading) {
    const physical = `${title} [records]`;
    const record = {id: 7, dictionary: physical, expression, reading};
    const getByIdsAsync = vi.fn().mockResolvedValue(new Map([[7, record]]));
    const database = new DictionaryDatabase();
    Reflect.set(database, '_termRecordStore', {
        ensureDictionariesLoaded: vi.fn().mockResolvedValue(void 0),
        getByIdsAsync,
    });
    Reflect.set(database, '_getTermRecordStorageName', (name) => name === title ? physical : name);
    Reflect.set(database, '_getDirectDictionarySampleIds', (name) => name === title ? [7] : []);
    Reflect.set(database, 'getDictionaryInfo', vi.fn().mockResolvedValue([{title}]));
    const getDictionaryCounts = vi.fn().mockImplementation(async (names) => ({
        counts: names.map((name) => ({terms: name === title ? 1 : 0})),
    }));
    const findTermsBulk = vi.fn().mockImplementation(async (terms, names) => (
        names.has(title) && terms.some((term) => term === expression || term === reading) ?
            [{dictionary: title, term: expression, reading}] :
            []
    ));
    Reflect.set(database, 'getDictionaryCounts', getDictionaryCounts);
    Reflect.set(database, 'findTermsBulk', findTermsBulk);
    const findTerms = vi.fn().mockImplementation(async (_mode, text, options) => ({
        dictionaryEntries: text === (expression.length > 0 ? expression : reading) && options.enabledDictionaryMap.has(title) ?
            [{dictionary: title}] :
            [],
    }));
    const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
    Reflect.set(backend, '_dictionaryDatabase', database);
    Reflect.set(backend, '_translator', {findTerms});
    for (const method of ['_awaitDictionaryMutationSettled', '_awaitDictionaryRefreshSettled', '_ensureDictionaryDatabaseReady']) {
        Reflect.set(backend, method, vi.fn().mockResolvedValue(void 0));
    }
    Reflect.set(backend, '_getProfileOptions', () => ({dictionaries: [{name: title, enabled: true}]}));
    Reflect.set(backend, '_getTranslatorPreparedProfileOptions', () => ({enabledDictionaryMap: new Map([[title, {}]])}));
    Reflect.set(backend, '_getTranslatorFindTermsOptions', () => ({}));
    return {backend, database, getByIdsAsync, findTerms, findTermsBulk, getDictionaryCounts};
}

describe('persisted identity through runtime verification', () => {
    test.each(['Dictionary', ' Dictionary ', '\ufeffDictionary', '\tDictionary\t', ' '])('keeps title %j through the public probe and visibility APIs', async (title) => {
        const {backend, database, getDictionaryCounts} = fixture(title, '猫', 'ねこ');
        const probe = await Reflect.get(backend, '_onApiGetDictionaryTermProbe').call(backend, {dictionaryTitle: title});
        expect(probe).toEqual({expression: '猫', reading: 'ねこ'});
        const result = await Reflect.get(backend, '_onApiVerifyDictionaryVisibility').call(backend, {
            dictionaryTitle: title, requireEnabledForActiveProfile: true,
        });
        expect(result).toMatchObject({ok: true, dictionaryTitle: title, installed: true, enabled: true, directMatch: true, translatorMatch: true});
        expect(getDictionaryCounts).toHaveBeenCalledWith([title], false);
        expect(Reflect.get(database, '_termRecordStore').ensureDictionariesLoaded).toHaveBeenCalledWith([`${title} [records]`]);
    });

    test.each(['猫', ' 猫 ', '\ufeff猫', '\ufeff\ufeff猫', '\t猫\t', ' '])('preserves field %j across the real database probe and both lookup verifiers', async (expression) => {
        const reading = '\ufeffねこ ';
        const {backend, database, findTerms, findTermsBulk} = fixture('Dictionary', expression, reading);
        expect(await database.getDictionaryTermProbe('Dictionary')).toEqual({expression, reading});
        const result = await Reflect.get(backend, '_onApiVerifyDictionaryVisibility').call(backend, {
            dictionaryTitle: 'Dictionary', requireEnabledForActiveProfile: true,
        });
        expect(result).toMatchObject({ok: true, directMatch: true, translatorMatch: true});
        expect(findTermsBulk).toHaveBeenCalledWith([expression, reading], new Set(['Dictionary']), 'exact');
        expect(findTerms).toHaveBeenCalledWith('split', expression, expect.objectContaining({mainDictionary: 'Dictionary'}));
    });

    test('empty expression falls back to the exact reading; identical fields remain deduplicated', async () => {
        for (const expression of ['', '\ufeffねこ ']) {
            const reading = '\ufeffねこ ';
            const {backend, findTerms, findTermsBulk} = fixture('Dictionary', expression, reading);
            const result = await Reflect.get(backend, '_onApiVerifyDictionaryVisibility').call(backend, {
                dictionaryTitle: 'Dictionary', requireEnabledForActiveProfile: true,
            });
            expect(result.ok).toBe(true);
            expect(findTermsBulk).toHaveBeenCalledWith([reading], new Set(['Dictionary']), 'exact');
            expect(findTerms).toHaveBeenCalledWith('split', reading, expect.any(Object));
        }
    });

    test('missing padded sibling cannot verify successfully through an installed canonical title', async () => {
        const {backend} = fixture('Dictionary', '猫', 'ねこ');
        const result = await Reflect.get(backend, '_onApiVerifyDictionaryVisibility').call(backend, {
            dictionaryTitle: ' Dictionary ', requireEnabledForActiveProfile: true,
        });
        expect(result).toMatchObject({ok: false, dictionaryTitle: ' Dictionary ', installed: false, reason: 'dictionary-not-installed'});
        expect(await Reflect.get(backend, '_onApiGetDictionaryTermProbe').call(backend, {dictionaryTitle: ' Dictionary '})).toBeNull();
    });

    test('empty identifiers and empty fields retain their existing rejection behavior', async () => {
        const {backend, database, getByIdsAsync} = fixture('Dictionary', '', '');
        expect(await Reflect.get(backend, '_onApiGetDictionaryTermProbe').call(backend, {dictionaryTitle: ''})).toBeNull();
        expect(getByIdsAsync).not.toHaveBeenCalled();
        const result = await Reflect.get(backend, '_onApiVerifyDictionaryVisibility').call(backend, {
            dictionaryTitle: '', requireEnabledForActiveProfile: true,
        });
        expect(result).toMatchObject({ok: false, reason: 'missing-dictionary-title'});
        expect(await database.getDictionaryTermProbe('Dictionary')).toBeNull();
    });

    test('database cache warming preserves exact persisted probe text', async () => {
        const {database, findTermsBulk} = fixture(' Dictionary ', '\ufeff猫 ', ' ねこ ');
        await Reflect.get(database, '_warmLookupProbeTerms').call(database, [' Dictionary ']);
        expect(findTermsBulk).toHaveBeenCalledWith(expect.arrayContaining(['\ufeff猫 ', ' ねこ ']), new Set([' Dictionary ']), 'exact');
    });

    test('frontend prewarm preserves probe identity through collection and final normalization', async () => {
        vi.useFakeTimers();
        try {
            const frontend = /** @type {Frontend} */ (Object.create(Frontend.prototype));
            const getDictionaryTermProbe = vi.fn().mockResolvedValue({expression: '\ufeff猫 ', reading: ' ねこ '});
            Reflect.set(frontend, '_application', {api: {getDictionaryTermProbe}});
            Reflect.set(frontend, '_getPageLookupPrewarmTerms', () => []);
            const options = {dictionaries: [{name: ' Dictionary ', enabled: true}]};
            expect(await Reflect.get(frontend, '_getLookupPrewarmTerms').call(frontend, options)).toEqual([
                '日本', 'する', 'ある', '見る', '\ufeff猫 ', ' ねこ ',
            ]);
            expect(getDictionaryTermProbe).toHaveBeenCalledWith(' Dictionary ');
        } finally {
            vi.clearAllTimers();
            vi.useRealTimers();
        }
    });

    test.each(['backend', 'offscreen'])('%s diagnostics keep exact SQL and index selection', async (kind) => {
        const titles = ['Dictionary', ' Dictionary ', '\ufeffDictionary', ' '];
        const findDirectTermIds = vi.fn().mockReturnValue([]);
        const selectObjects = vi.fn().mockReturnValue([]);
        const database = {
            _findDirectTermIds: findDirectTermIds,
            _fetchTermRowsByIds: vi.fn().mockResolvedValue(new Map()),
            _ensureDirectTermIndexesLoaded: vi.fn().mockResolvedValue(void 0),
            _termRecordStore: {},
            _termContentStore: {},
            _requireDb: () => ({selectObjects}),
            getTermContentDiagnostics: vi.fn().mockReturnValue({}),
        };
        const owner = Object.create(kind === 'backend' ? Backend.prototype : OffscreenHandler.prototype);
        Reflect.set(owner, '_dictionaryDatabase', database);
        const method = kind === 'backend' ? '_debugDictionaryLookupStateLocal' : '_debugDictionaryLookupState';
        const result = await Reflect.get(owner, method).call(owner, '\ufeff猫 ', [...titles, '']);
        expect(result.directHits.map(({dictionary}) => dictionary)).toEqual(titles);
        for (const title of titles) {
            expect(findDirectTermIds).toHaveBeenCalledWith(title, '\ufeff猫 ', 'expression');
            expect(findDirectTermIds).toHaveBeenCalledWith(title, '\ufeff猫 ', 'reading');
            if (kind === 'offscreen') {
                expect(selectObjects).toHaveBeenCalledWith(expect.any(String), {$dictionary: title, $text: '\ufeff猫 '});
            }
        }
        expect(findDirectTermIds).toHaveBeenCalledTimes(titles.length * 2);
    });
});
