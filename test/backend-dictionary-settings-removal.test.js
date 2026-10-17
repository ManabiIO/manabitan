/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later */
import {describe, expect, test, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';

describe('backend dictionary settings removal', () => {
    /**
     * @param {() => Promise<{title: string}[]>} dictionaryInfo
     * @returns {{backend: Backend, options: {profiles: {options: {dictionaries: {name: string, alias: string, enabled: boolean}[]}}[]}, save: import('vitest').Mock, getDictionaryInfo: import('vitest').Mock}}
     */
    function createBackend(dictionaryInfo) {
        const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
        const options = {profiles: [{options: {dictionaries: []}}]};
        const save = vi.fn().mockResolvedValue(void 0);
        const getDictionaryInfo = vi.fn(dictionaryInfo);
        Reflect.set(backend, '_options', options);
        Reflect.set(backend, '_optionsUtil', {save});
        Reflect.set(backend, '_applyOptions', vi.fn());
        Reflect.set(backend, '_clearProfileConditionsSchemaCache', vi.fn());
        Reflect.set(backend, '_getOptionsFull', () => Reflect.get(backend, '_options'));
        Reflect.set(backend, '_dictionaryDatabase', {getDictionaryInfo});
        Reflect.set(backend, '_ensureDictionaryDatabaseReady', vi.fn().mockResolvedValue(void 0));
        return {backend, options, save, getDictionaryInfo};
    }

    /**
     * @param {string} name
     * @param {string} [path]
     * @returns {import('settings-modifications').ScopedModificationRemoveDictionary}
     */
    function removal(name, path = 'profiles[0].options.dictionaries') {
        return {
            action: 'removeDictionary', scope: 'global', optionsContext: null, path, name,
        };
    }

    test('replayed removals from independent pages preserve the next dictionary and its aliases', async () => {
        const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
        const options = {profiles: [{options: {dictionaries: [
            {name: 'Deleted', alias: 'First', enabled: true},
            {name: 'JMdict', alias: 'Mine', enabled: true},
            {name: 'Deleted', alias: 'Second', enabled: false},
            {name: 'JMdict', alias: 'Other', enabled: false},
        ]}}]};
        Reflect.set(backend, '_options', options);
        Reflect.set(backend, '_optionsUtil', {save: vi.fn().mockResolvedValue(void 0)});
        Reflect.set(backend, '_applyOptions', vi.fn());
        Reflect.set(backend, '_clearProfileConditionsSchemaCache', vi.fn());
        Reflect.set(backend, '_getModifySettingObject', () => Reflect.get(backend, '_options'));
        Reflect.set(backend, '_dictionaryDatabase', {getDictionaryInfo: vi.fn().mockResolvedValue([])});
        Reflect.set(backend, '_ensureDictionaryDatabaseReady', vi.fn().mockResolvedValue(void 0));
        /** @type {import('settings-modifications').ScopedModificationRemoveDictionary} */
        const removal = {action: 'removeDictionary', scope: 'global', optionsContext: null, path: 'profiles[0].options.dictionaries', name: 'Deleted'};
        const results = await Promise.all([
            backend._modifySettings([removal], 'page-one'),
            backend._modifySettings([removal], 'page-two'),
        ]);
        expect(results[0][0].result).toHaveLength(2);
        expect(results[1][0].result).toEqual([]);
        expect(/** @type {typeof options} */ (Reflect.get(backend, '_options')).profiles[0].options.dictionaries).toEqual([
            {name: 'JMdict', alias: 'Mine', enabled: true},
            {name: 'JMdict', alias: 'Other', enabled: false},
        ]);
    });

    test('a stale orphan removal preserves settings for a dictionary already installed', async () => {
        const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
        const options = {profiles: [{options: {dictionaries: [
            {name: 'New', alias: 'Enabled alias', enabled: true},
            {name: 'New', alias: 'Second alias', enabled: false},
        ]}}]};
        Reflect.set(backend, '_options', options);
        const save = vi.fn().mockResolvedValue(void 0);
        Reflect.set(backend, '_optionsUtil', {save});
        Reflect.set(backend, '_applyOptions', vi.fn());
        Reflect.set(backend, '_clearProfileConditionsSchemaCache', vi.fn());
        Reflect.set(backend, '_getModifySettingObject', () => Reflect.get(backend, '_options'));
        Reflect.set(backend, '_dictionaryDatabase', {getDictionaryInfo: vi.fn().mockResolvedValue([{title: 'New'}])});
        Reflect.set(backend, '_ensureDictionaryDatabaseReady', vi.fn().mockResolvedValue(void 0));
        /** @type {import('settings-modifications').ScopedModificationRemoveDictionary} */
        const removal = {action: 'removeDictionary', scope: 'global', optionsContext: null, path: 'profiles[0].options.dictionaries', name: 'New'};

        const results = await backend._modifySettings([removal], 'stale-page');

        expect(results).toEqual([{result: []}]);
        expect(save).not.toHaveBeenCalled();
        expect(options.profiles[0].options.dictionaries).toHaveLength(2);
    });

    test('a failed installed-dictionary read fails closed without changing settings', async () => {
        const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
        const options = {profiles: [{options: {dictionaries: [{name: 'New', alias: 'Mine', enabled: true}]}}]};
        Reflect.set(backend, '_options', options);
        const save = vi.fn().mockResolvedValue(void 0);
        Reflect.set(backend, '_optionsUtil', {save});
        Reflect.set(backend, '_applyOptions', vi.fn());
        Reflect.set(backend, '_clearProfileConditionsSchemaCache', vi.fn());
        Reflect.set(backend, '_getModifySettingObject', () => Reflect.get(backend, '_options'));
        Reflect.set(backend, '_dictionaryDatabase', {getDictionaryInfo: vi.fn().mockRejectedValue(new Error('database unavailable'))});
        Reflect.set(backend, '_ensureDictionaryDatabaseReady', vi.fn().mockResolvedValue(void 0));
        /** @type {import('settings-modifications').ScopedModificationRemoveDictionary} */
        const removal = {action: 'removeDictionary', scope: 'global', optionsContext: null, path: 'profiles[0].options.dictionaries', name: 'New'};

        await expect(backend._modifySettings([removal], 'stale-page')).rejects.toThrow('database unavailable');

        expect(save).not.toHaveBeenCalled();
        expect(options.profiles[0].options.dictionaries).toEqual([{name: 'New', alias: 'Mine', enabled: true}]);
    });

    test('installed lookup runs after an earlier queued settings addition commits', async () => {
        let releaseSave = () => {};
        const saveGate = new Promise((resolve) => { releaseSave = () => resolve(void 0); });
        const {backend, save, getDictionaryInfo} = createBackend(async () => (
            /** @type {{profiles: {options: {dictionaries: {name: string}[]}}[]}} */ (Reflect.get(backend, '_options')).profiles[0].options.dictionaries.some(({name}) => name === 'Published') ?
                [{title: 'Published'}] :
                []
        ));
        save.mockImplementationOnce(async (stagedOptions) => {
            await saveGate;
            Reflect.set(backend, '_options', stagedOptions);
        });
        const addition = /** @type {import('settings-modifications').ScopedModification} */ ({action: 'push', scope: 'global', optionsContext: null, path: 'profiles[0].options.dictionaries', items: [{name: 'Published', alias: 'One', enabled: true}]});
        const first = backend._modifySettings([addition], 'import');
        const second = backend._modifySettings([removal('Published')], 'stale-page');
        await Promise.resolve();
        await Promise.resolve();
        expect(getDictionaryInfo).not.toHaveBeenCalled();
        releaseSave();
        await first;
        await expect(second).resolves.toEqual([{result: []}]);
        expect(/** @type {{profiles: {options: {dictionaries: {name: string, alias: string, enabled: boolean}[]}}[]}} */ (Reflect.get(backend, '_options')).profiles[0].options.dictionaries).toEqual([{name: 'Published', alias: 'One', enabled: true}]);
    });

    test('protected malformed removals preserve validation errors and mixed batch cardinality', async () => {
        const {backend} = createBackend(async () => [{title: 'Installed'}]);
        const results = await backend._modifySettings([
            removal('Installed'),
            removal('Installed', 'bad.path'),
            /** @type {import('settings-modifications').ScopedModification} */ ({...removal('Installed'), scope: 'profile', optionsContext: null}),
            /** @type {import('settings-modifications').ScopedModification} */ (/** @type {unknown} */ ({...removal('Installed'), name: 42})),
        ], 'page');
        expect(results).toHaveLength(4);
        expect(results[0]).toEqual({result: []});
        expect(results[1]).toMatchObject({error: {message: expect.stringContaining('Invalid dictionary settings path')}});
        expect(results[2]).toMatchObject({error: {message: expect.stringContaining('Invalid optionsContext')}});
        expect(results[3]).toMatchObject({error: {message: expect.stringContaining('Invalid dictionary name')}});
    });

    test('ordinary settings writes do not query dictionary state', async () => {
        const {backend, getDictionaryInfo} = createBackend(async () => []);
        await backend._modifySettings([
            {action: 'push', scope: 'global', optionsContext: null, path: 'profiles[0].options.dictionaries', items: [{name: 'X', alias: 'X', enabled: true}]},
        ], 'page');
        expect(getDictionaryInfo).not.toHaveBeenCalled();
    });
});
