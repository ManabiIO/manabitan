/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later */
import {describe, expect, test, vi} from 'vitest';
import {DictionaryController} from '../ext/js/pages/settings/dictionary-controller.js';
/**
 * @param {string} name
 * @returns {Function}
 */
function getDictionaryControllerMethod(name) {
    const method = /** @type {unknown} */ (Reflect.get(DictionaryController.prototype, name));
    if (typeof method !== 'function') { throw new Error(`Expected DictionaryController.${name} to be a function`); }
    return method;
}

describe('DictionaryController installed-dictionary setting reconciliation', () => {
    test('preserves intentional duplicate aliases and removes only truly missing dictionaries', async () => {
        const modifyGlobalSettings = vi.fn().mockResolvedValue([]);
        const optionsFull = {
            profiles: [{
                options: {
                    dictionaries: [
                        {name: 'JMdict', alias: 'Primary', enabled: true},
                        {name: 'Unknown', alias: 'Orphan', enabled: true},
                        {name: 'JMdict', alias: 'Secondary', enabled: false},
                    ],
                },
            }],
        };
        const dictionaries = [
            {title: 'JMdict', styles: 'old'},
            {title: 'Jitendex', styles: 'new'},
        ];
        await DictionaryController.ensureDictionarySettings(
            /** @type {any} */ ({modifyGlobalSettings}),
            /** @type {any} */ (dictionaries),
            /** @type {any} */ (optionsFull),
            true,
            false,
        );

        expect(optionsFull.profiles[0].options.dictionaries).toStrictEqual([
            {name: 'JMdict', alias: 'Primary', enabled: true},
            {name: 'JMdict', alias: 'Secondary', enabled: false},
            DictionaryController.createDefaultDictionarySettings('Jitendex', false, 'new'),
        ]);
        expect(modifyGlobalSettings).toHaveBeenCalledOnce();
        expect(modifyGlobalSettings).toHaveBeenCalledWith([
            {
                action: 'splice',
                path: 'profiles[0].options.dictionaries',
                start: 1,
                deleteCount: 1,
                items: [],
            },
            {
                action: 'push',
                path: 'profiles[0].options.dictionaries',
                items: [DictionaryController.createDefaultDictionarySettings('Jitendex', false, 'new')],
            },
        ]);
    });

    test('does not overwrite a newer enablement change from a stale options snapshot', async () => {
        /** @type {unknown[]} */
        const backendDictionaries = [
            {name: 'JMdict', alias: 'My alias', enabled: true},
            {name: 'Unknown', alias: 'Stale', enabled: true},
        ];
        const modifyGlobalSettings = vi.fn(async (/** @type {import('settings-modifications').Modification[]} */ modifications) => {
            for (const modification of modifications) {
                if (modification.action === 'splice') {
                    backendDictionaries.splice(modification.start, modification.deleteCount, ...modification.items);
                } else if (modification.action === 'push') {
                    backendDictionaries.push(...modification.items);
                } else {
                    throw new Error('Unexpected whole-array replacement');
                }
            }
            return [];
        });
        const staleOptions = {
            profiles: [{
                options: {
                    dictionaries: [
                        {name: 'JMdict', alias: 'My alias', enabled: false},
                        {name: 'Unknown', alias: 'Stale', enabled: true},
                    ],
                },
            }],
        };

        await DictionaryController.ensureDictionarySettings(
            /** @type {any} */ ({modifyGlobalSettings}),
            /** @type {any} */ ([{title: 'JMdict', styles: ''}]),
            /** @type {any} */ (staleOptions),
            true,
            false,
        );

        expect(backendDictionaries).toStrictEqual([{name: 'JMdict', alias: 'My alias', enabled: true}]);
        expect(modifyGlobalSettings).toHaveBeenCalledWith([{
            action: 'splice',
            path: 'profiles[0].options.dictionaries',
            start: 1,
            deleteCount: 1,
            items: [],
        }]);
    });

    test('does not write when all installed dictionary aliases are present', async () => {
        const modifyGlobalSettings = vi.fn().mockResolvedValue([]);
        const optionsFull = {
            profiles: [{
                options: {
                    dictionaries: [
                        {name: 'JMdict', alias: 'Primary', enabled: true},
                        {name: 'JMdict', alias: 'Secondary', enabled: false},
                    ],
                },
            }],
        };
        await DictionaryController.ensureDictionarySettings(
            /** @type {any} */ ({modifyGlobalSettings}),
            /** @type {any} */ ([{title: 'JMdict', styles: ''}]),
            /** @type {any} */ (optionsFull),
            true,
            false,
        );

        expect(modifyGlobalSettings).not.toHaveBeenCalled();
        expect(optionsFull.profiles[0].options.dictionaries).toHaveLength(2);
    });
});
