/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later */
import {describe, expect, test, vi} from 'vitest';
import {deferPromise} from '../ext/js/core/utilities.js';
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
                action: 'removeDictionary',
                path: 'profiles[0].options.dictionaries',
                name: 'Unknown',
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
                if (modification.action === 'removeDictionary') {
                    for (let i = backendDictionaries.length - 1; i >= 0; --i) {
                        if (Reflect.get(/** @type {object} */ (backendDictionaries[i]), 'name') === modification.name) { backendDictionaries.splice(i, 1); }
                    }
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
            action: 'removeDictionary',
            path: 'profiles[0].options.dictionaries',
            name: 'Unknown',
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


test('concurrent dictionary refreshes cannot remove the next installed entry using the same stale index', async () => {
    const options = {profiles: [{options: {dictionaries: [
        {name: 'Deleted', alias: 'Deleted', enabled: true},
        {name: 'JMdict', alias: 'Mine', enabled: true},
    ]}}]};
    /** @type {import('core').DeferredPromiseDetails<void>} */
    const entered = deferPromise();
    /** @type {import('core').DeferredPromiseDetails<void>} */
    const resume = deferPromise();
    const getOptionsFull = vi.fn(async () => structuredClone(options));
    const modifyGlobalSettings = vi.fn(async (/** @type {import('settings-modifications').Modification[]} */ modifications) => {
        entered.resolve();
        await resume.promise;
        for (const modification of modifications) {
            if (modification.action !== 'removeDictionary') { throw new Error('Unexpected modification'); }
            const dictionaries = options.profiles[0].options.dictionaries;
            for (let i = dictionaries.length - 1; i >= 0; --i) {
                if (dictionaries[i].name === modification.name) { dictionaries.splice(i, 1); }
            }
        }
        return [];
    });
    const settings = /** @type {any} */ ({getOptionsFull, modifyGlobalSettings});
    const installed = /** @type {any} */ ([{title: 'JMdict', styles: ''}]);
    const first = DictionaryController.ensureDictionarySettings(settings, installed, void 0, true, false);
    await entered.promise;
    const second = DictionaryController.ensureDictionarySettings(settings, installed, void 0, true, false);
    await Promise.resolve();
    expect(getOptionsFull).toHaveBeenCalledOnce();
    resume.resolve();
    await Promise.all([first, second]);
    expect(modifyGlobalSettings).toHaveBeenCalledOnce();
    expect(options.profiles[0].options.dictionaries).toEqual([{name: 'JMdict', alias: 'Mine', enabled: true}]);
});
