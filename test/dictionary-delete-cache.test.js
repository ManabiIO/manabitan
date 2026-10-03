/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {afterEach, expect, test, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {DictionaryController} from '../ext/js/pages/settings/dictionary-controller.js';

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

/**
 * @param {'records'|'content'|'commit'|'progress'|'none'} failure
 * @param {string} [title]
 * @param {string} [storageName]
 * @returns {{database: DictionaryDatabase, exec: ReturnType<typeof vi.fn>, removeShard: import('vitest').MockInstance, resetContent: import('vitest').MockInstance, onProgress: ReturnType<typeof vi.fn>, title: string, storageName: string, healthRows: Set<string>}}
 */
function createFixture(failure, title = 'Fixture', storageName = title) {
    const database = new DictionaryDatabase();
    let committed = false;
    /** @type {Set<string>} */
    const healthRows = new Set();
    const exec = vi.fn((value) => {
        if (value === 'COMMIT') {
            if (failure === 'commit') { throw new Error('commit failed'); }
            committed = true;
        }
        if (typeof value === 'object' && value.sql === 'DELETE FROM dictionaryStorageHealth WHERE title = ?') {
            healthRows.delete(value.bind[0]);
        }
    });
    Reflect.set(database, '_db', {exec, selectValue: () => 0, selectObjects: () => []});
    database._registerTermRecordStorageName(title, storageName);
    const store = Reflect.get(database, '_termRecordStore');
    vi.spyOn(store, 'ensureDictionariesLoaded').mockResolvedValue();
    Reflect.get(store, '_recordsById').set(1, {
        id: 1,
        dictionary: storageName,
        expression: 'word',
        reading: 'word',
        expressionReverse: 'drow',
        readingReverse: 'drow',
        score: 1,
        sequence: 1,
        entryContentOffset: -1,
        entryContentLength: 0,
        entryContentDictName: 'raw',
    });
    expect(store.findTermIdMatches(storageName, 'word')).toEqual({expression: [1], reading: []});
    Reflect.get(store, '_persistentIndexLoadedDictionaryNames').add(storageName);
    const removeShard = vi.spyOn(store, '_deleteShardByDictionary').mockImplementation(async () => {
        expect(committed).toBe(true);
        expect(database._getTermRecordStorageName(title)).toBe(storageName);
        expect(database._getDictionaryNameForTermRecordStorage(storageName)).toBe(title);
        expect(Reflect.get(database, '_termExactMatchCache').size).toBe(0);
        expect(Reflect.get(database, '_termRowCache').size).toBe(0);
        expect(Reflect.get(store, '_indexByDictionary').has(storageName)).toBe(false);
        expect(Reflect.get(store, '_recordsById').get(1)).toBeUndefined();
        expect(Reflect.get(store, '_persistentIndexLoadedDictionaryNames').has(storageName)).toBe(false);
        if (failure === 'records') { throw new Error('record cleanup failed'); }
    });
    const resetContent = vi.spyOn(Reflect.get(database, '_termContentStore'), 'reset').mockImplementation(async () => {
        if (failure === 'content') { throw new Error('content cleanup failed'); }
    });
    Reflect.get(database, '_directTermIndexLoadedDictionaryNames').add(title);
    const key = database._createTermExactMatchCacheKey([title], 'word');
    Reflect.get(database, '_termExactMatchCache').set(key, {expression: [1], reading: []});
    Reflect.get(database, '_termRowCache').set(1, {
        id: 1,
        dictionary: title,
        expression: 'word',
        reading: 'word',
        score: 1,
        sequence: 1,
        rules: '',
        definitionTags: '',
        termTags: '',
        glossary: ['definition'],
    });
    const onProgress = vi.fn(() => {
        if (failure === 'progress' && !committed) { throw new Error('progress failed'); }
    });
    return {database, exec, removeShard, resetContent, onProgress, title, storageName, healthRows};
}

test.each(['records', 'content', 'none'])('committed deletion invalidates cached definitions despite %s cleanup failure', async (failure) => {
    const {database, exec, removeShard, resetContent, title, storageName} = createFixture(/** @type {'records'|'content'|'none'} */ (failure));
    expect(await database.findTermsBulk(['word'], new Set([title]), 'exact')).toHaveLength(1);
    await expect(database.deleteDictionary(title, 1000, () => {})).resolves.toBeUndefined();
    expect(exec).toHaveBeenCalledWith('COMMIT');
    expect(removeShard).toHaveBeenCalledWith(storageName);
    expect(resetContent).toHaveBeenCalledOnce();
    expect(await database.findTermsBulk(['word'], new Set([title]), 'exact')).toEqual([]);
});

test.each(['commit', 'progress'])('precommit %s failure preserves cache, mapping and OPFS', async (failure) => {
    const {database, exec, removeShard, resetContent, onProgress, title, storageName} = createFixture(/** @type {'commit'|'progress'} */ (failure), ' Fixture ', ' physical-records ');
    await expect(database.deleteDictionary(title, 1000, onProgress)).rejects.toThrow(`${failure} failed`);
    expect(removeShard).not.toHaveBeenCalled();
    expect(resetContent).not.toHaveBeenCalled();
    expect(database._getTermRecordStorageName(title)).toBe(storageName);
    expect(await database.findTermsBulk(['word'], new Set([title]), 'exact')).toHaveLength(1);
    const store = Reflect.get(database, '_termRecordStore');
    expect(store.findTermIdMatches(storageName, 'word')).toEqual({expression: [1], reading: []});
    if (failure === 'commit') { expect(exec).toHaveBeenCalledWith('ROLLBACK'); }
});

test('physical cleanup failure preserves another dictionary records, indexes and exact storage mapping', async () => {
    const {database, removeShard, title, storageName} = createFixture('records', ' Fixture ', ' records-target ');
    const siblingTitle = 'Fixture';
    const siblingStorageName = ' records-sibling ';
    database._registerTermRecordStorageName(siblingTitle, siblingStorageName);
    const store = Reflect.get(database, '_termRecordStore');
    const sourceRecord = Reflect.get(store, '_recordsById').get(1);
    if (typeof sourceRecord === 'undefined') { throw new Error('Expected fixture record'); }
    Reflect.get(store, '_recordsById').set(2, {
        ...sourceRecord,
        id: 2,
        dictionary: siblingStorageName,
    });
    const siblingIndex = store.getDictionaryIndex(siblingStorageName);
    Reflect.get(database, '_termExactMatchCache').set(database._createTermExactMatchCacheKey([siblingTitle], 'word'), {expression: [2], reading: []});
    const sourceRow = Reflect.get(database, '_termRowCache').get(1);
    if (typeof sourceRow === 'undefined') { throw new Error('Expected fixture row'); }
    Reflect.get(database, '_termRowCache').set(2, {...sourceRow, id: 2, dictionary: siblingTitle});
    // Keep a committed sibling in SQLite; content pruning itself is covered elsewhere.
    Reflect.set(database._requireDb(), 'selectValue', (/** @type {string} */ sql) => (sql === 'SELECT COUNT(*) FROM dictionaries' ? 1 : 0));
    vi.spyOn(database, '_pruneOrphanTermEntryContent').mockImplementation(() => {});
    expect(await database.findTermsBulk(['word'], new Set([siblingTitle]), 'exact')).toHaveLength(1);

    await expect(database.deleteDictionary(title, 1000, () => {})).resolves.toBeUndefined();

    expect(removeShard).toHaveBeenCalledExactlyOnceWith(storageName);
    expect(database._getTermRecordStorageName(siblingTitle)).toBe(siblingStorageName);
    expect(store.getDictionaryIndex(siblingStorageName)).toBe(siblingIndex);
    expect(store.findTermIdMatches(siblingStorageName, 'word')).toEqual({expression: [2], reading: []});
    expect(await database.findTermsBulk(['word'], new Set([title]), 'exact')).toEqual([]);
    expect(await database.findTermsBulk(['word'], new Set([siblingTitle]), 'exact')).toMatchObject([{dictionary: siblingTitle, term: 'word'}]);
});

test.each(['none', 'records'])('aliased record deletion clears persisted logical health before %s physical cleanup outcome', async (failure) => {
    const {database, exec, title, storageName, healthRows} = createFixture(/** @type {'none'|'records'} */ (failure), ' Fixture ', ' physical-records ');
    healthRows.add(title);
    healthRows.add('Other dictionary');
    const store = Reflect.get(database, '_termRecordStore');
    Reflect.get(store, '_dictionaryHealthByName').set(storageName, {status: 'reimportRequired', reason: 'old damage'});

    await expect(database.deleteDictionary(title, 1000, () => {})).resolves.toBeUndefined();

    expect(exec).toHaveBeenCalledWith({sql: 'DELETE FROM dictionaryStorageHealth WHERE title = ?', bind: [title]});
    expect(exec).not.toHaveBeenCalledWith({sql: 'DELETE FROM dictionaryStorageHealth WHERE title = ?', bind: [storageName]});
    expect(healthRows).toEqual(new Set(['Other dictionary']));
    expect(database._getTermRecordStorageName(title)).toBe(title);
    expect(store.getDictionaryHealth(storageName)).toEqual({status: 'available', reason: null});
});

test.each([
    ['records', false],
    ['content', false],
    ['commit', false],
    ['records', true],
    ['content', true],
    ['commit', true],
])('backend/settings reconcile deletion with %s failure; offscreen=%s', async (failure, offscreen) => {
    const title = ' \ufeffFixture ';
    const storageName = ' \ufeffphysical-records ';
    const {database, removeShard} = createFixture(/** @type {'records'|'content'|'commit'} */ (failure), title, storageName);
    const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
    Reflect.set(backend, '_dictionaryDatabase', database);
    if (offscreen) {
        vi.stubGlobal('self', {addEventListener: vi.fn()});
        const {OffscreenDictionaryWorkerHandler} = await import('../ext/js/background/offscreen-dictionary-worker.js');
        const worker = new OffscreenDictionaryWorkerHandler();
        Reflect.set(worker, '_dictionaryDatabase', database);
        Reflect.set(backend, '_dictionaryDatabase', {
            /**
             * @param {string} dictionaryTitle
             * @returns {Promise<unknown>}
             */
            deleteDictionary: async (dictionaryTitle) => await worker._invokeAction('deleteDictionaryOffscreen', {dictionaryTitle}, []),
        });
    }
    Reflect.set(backend, '_ensureDictionaryDatabaseReady', vi.fn().mockResolvedValue(void 0));
    Reflect.set(backend, '_dictionaryMutationPromise', null);
    const refresh = vi.fn().mockResolvedValue(void 0);
    Reflect.set(backend, '_refreshDictionaryDatabaseAfterUpdate', refresh);

    const controller = /** @type {DictionaryController} */ (Object.create(DictionaryController.prototype));
    vi.stubGlobal('document', {querySelectorAll: () => []});
    Reflect.set(controller, '_checkingIntegrity', false);
    Reflect.set(controller, '_dictionaryEntries', [{dictionaryTitle: title}]);
    Reflect.set(controller, '_statusFooter', null);
    const end = vi.fn();
    const modifyGlobalSettings = vi.fn().mockResolvedValue(void 0);
    Reflect.set(controller, '_settingsController', {
        preventPageExit: () => ({end}),
        application: {api: {
            /**
             * @param {string} dictionaryTitle
             * @returns {Promise<void>}
             */
            deleteDictionaryByTitle: async (dictionaryTitle) => await backend._onApiDeleteDictionaryByTitle({dictionaryTitle}, {}),
        }},
        getOptionsFull: async () => ({profiles: [{options: {
            dictionaries: [{name: title, enabled: true}, {name: 'Fixture', enabled: true}],
            general: {mainDictionary: title, sortFrequencyDictionary: title},
        }}]}),
        modifyGlobalSettings,
    });
    for (const method of ['_clearMutationErrors', '_setButtonsEnabled', '_triggerStorageChanged']) {
        Reflect.set(controller, method, vi.fn());
    }
    const settingsRefresh = vi.fn().mockResolvedValue(void 0);
    Reflect.set(controller, '_awaitDictionaryRefresh', settingsRefresh);

    if (failure === 'commit') {
        await expect(controller._deleteDictionary(title)).rejects.toThrow('commit failed');
        expect(removeShard).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
        expect(settingsRefresh).not.toHaveBeenCalled();
        expect(modifyGlobalSettings).not.toHaveBeenCalled();
        expect(end).toHaveBeenCalledOnce();
        return;
    }
    await expect(controller._deleteDictionary(title)).resolves.toBeUndefined();
    expect(removeShard).toHaveBeenCalledWith(storageName);
    expect(refresh).toHaveBeenCalledOnce();
    expect(settingsRefresh).toHaveBeenCalledWith(title, 'delete');
    expect(modifyGlobalSettings).toHaveBeenCalledWith([
        {action: 'splice', path: 'profiles[0].options.dictionaries', start: 0, deleteCount: 1, items: []},
        {action: 'set', path: 'profiles[0].options.general.mainDictionary', value: ''},
        {action: 'set', path: 'profiles[0].options.general.sortFrequencyDictionary', value: null},
    ]);
    expect(end).toHaveBeenCalledOnce();
});
