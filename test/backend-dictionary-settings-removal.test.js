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
});
