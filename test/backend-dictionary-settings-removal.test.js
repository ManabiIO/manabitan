/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later */
import {describe, expect, test, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';

describe('backend dictionary settings removal', () => {
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
});
