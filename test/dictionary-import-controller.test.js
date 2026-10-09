/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later */
import {describe, expect, test, vi} from 'vitest';
import {DictionaryImportController} from '../ext/js/pages/settings/dictionary-import-controller.js';
import {DictionaryController} from '../ext/js/pages/settings/dictionary-controller.js';
/**
 * @param {string} name
 * @returns {Function}
 */
function getDictionaryImportControllerMethod(name) {
    const method = /** @type {unknown} */ (Reflect.get(DictionaryImportController.prototype, name));
    if (typeof method !== 'function') { throw new Error(`Expected DictionaryImportController.${name} to be a function`); }
    return method;
}

describe('Dictionary import profile visibility', () => {
    const addDictionarySettings = /** @type {(this: DictionaryImportController, summary: import('dictionary-importer').Summary, profilesDictionarySettings: import('settings-controller').ProfilesDictionarySettings) => Promise<Error[]>} */ (
        getDictionaryImportControllerMethod('_addDictionarySettings')
    );
    const verifyImportedDictionaryVisible = /** @type {(this: DictionaryImportController, title: string, requireEnabled: boolean) => Promise<void>} */ (
        getDictionaryImportControllerMethod('_verifyImportedDictionaryVisible')
    );

    test('enables an auto-created disabled entry without adding a duplicate', async () => {
        const modifyGlobalSettings = vi.fn().mockResolvedValue([]);
        const optionsFull = {
            profiles: [
                {
                    id: 'selected',
                    options: {
                        dictionaries: [{
                            name: 'Jitendex', alias: 'Jitendex', enabled: false,
                        }],
                        general: {mainDictionary: '', sortFrequencyDictionary: null},
                    },
                },
                {
                    id: 'other',
                    options: {
                        dictionaries: [{
                            name: 'Jitendex', alias: 'My custom alias', enabled: false,
                        }],
                        general: {mainDictionary: '', sortFrequencyDictionary: null},
                    },
                },
            ],
        };
        const controller = /** @type {DictionaryImportController} */ (/** @type {unknown} */ ({
            _settingsController: {
                profileIndex: 0,
                getOptionsFull: vi.fn().mockResolvedValue(optionsFull),
            },
            _modifyGlobalSettings: modifyGlobalSettings,
        }));

        const errors = await addDictionarySettings.call(controller, /** @type {import('dictionary-importer').Summary} */ ({
            title: 'Jitendex', sequenced: false, styles: '',
        }), null);

        expect(errors).toStrictEqual([]);
        expect(modifyGlobalSettings).toHaveBeenCalledOnce();
        expect(modifyGlobalSettings.mock.calls[0][0]).toStrictEqual([{
            action: 'set',
            path: 'profiles[0].options.dictionaries[0].enabled',
            value: true,
        }]);
    });

    test('preserves an explicitly disabled existing dictionary during an update', async () => {
        const modifyGlobalSettings = vi.fn().mockResolvedValue([]);
        const controller = /** @type {DictionaryImportController} */ (/** @type {unknown} */ ({
            _settingsController: {
                profileIndex: 0,
                getOptionsFull: vi.fn().mockResolvedValue({
                    profiles: [{
                        id: 'selected',
                        options: {
                            dictionaries: [{name: 'JMdict', enabled: false, alias: 'Disabled by user'}],
                            general: {mainDictionary: '', sortFrequencyDictionary: null},
                        },
                    }],
                }),
            },
            _modifyGlobalSettings: modifyGlobalSettings,
        }));

        await addDictionarySettings.call(controller, /** @type {import('dictionary-importer').Summary} */ ({
            title: 'JMdict', sequenced: false, styles: '',
        }), {
            'another-profile': [{...DictionaryController.createDefaultDictionarySettings('JMdict-old', true, ''), alias: 'Another profile', index: 0}],
        });

        expect(modifyGlobalSettings).toHaveBeenCalledWith([]);
    });

    test('does not add another entry if the dictionary is already enabled', async () => {
        const modifyGlobalSettings = vi.fn().mockResolvedValue([]);
        const controller = /** @type {DictionaryImportController} */ (/** @type {unknown} */ ({
            _settingsController: {
                profileIndex: 0,
                getOptionsFull: vi.fn().mockResolvedValue({
                    profiles: [{
                        id: 'selected',
                        options: {
                            dictionaries: [{name: 'JMdict', enabled: true, alias: 'Mine'}],
                            general: {mainDictionary: '', sortFrequencyDictionary: null},
                        },
                    }],
                }),
            },
            _modifyGlobalSettings: modifyGlobalSettings,
        }));

        await addDictionarySettings.call(controller, /** @type {import('dictionary-importer').Summary} */ ({
            title: 'JMdict', sequenced: false, styles: '',
        }), null);

        expect(modifyGlobalSettings).toHaveBeenCalledWith([]);
    });

    test('throws when a completed import is disabled in the selected profile', async () => {
        const controller = /** @type {DictionaryImportController} */ (/** @type {unknown} */ ({
            _settingsController: {
                profileIndex: 0,
                getOptionsFull: vi.fn().mockResolvedValue({
                    profiles: [{
                        id: 'selected',
                        options: {dictionaries: [{name: 'Jitendex', enabled: false}]},
                    }],
                }),
            },
            _emitImportedDictionaryProfileEnablementDiagnostics: vi.fn(),
        }));

        await expect(verifyImportedDictionaryVisible.call(controller, 'Jitendex', true))
            .rejects.toThrow('not enabled for the active profile');
        await expect(verifyImportedDictionaryVisible.call(controller, 'Jitendex', false))
            .resolves.toBeUndefined();
    });

    test('accepts an enabled dictionary in the selected profile', async () => {
        const controller = /** @type {DictionaryImportController} */ (/** @type {unknown} */ ({
            _settingsController: {
                profileIndex: 0,
                getOptionsFull: vi.fn().mockResolvedValue({
                    profiles: [{
                        id: 'selected',
                        options: {dictionaries: [{name: 'Jitendex', enabled: true}]},
                    }],
                }),
            },
            _emitImportedDictionaryProfileEnablementDiagnostics: vi.fn(),
        }));

        await expect(verifyImportedDictionaryVisible.call(controller, 'Jitendex', true))
            .resolves.toBeUndefined();
    });
});
