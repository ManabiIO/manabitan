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
            profiles: [{id: 'profile-a',
                options: {
                    dictionaries: [
                        {name: 'JMdict', alias: 'Primary', enabled: true},
                        {name: 'Unknown', alias: 'Orphan', enabled: true},
                        {name: 'JMdict', alias: 'Secondary', enabled: false},
                    ],
                }}],
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
                action: 'removeDictionaryByName',
                profileId: 'profile-a',
                name: 'Unknown',
            },
            {
                action: 'ensureDictionary',
                profileId: 'profile-a',
                item: DictionaryController.createDefaultDictionarySettings('Jitendex', false, 'new'),
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
                switch (modification.action) {
                    case 'removeDictionary':
                    case 'removeDictionaryByName': {
                        for (let i = backendDictionaries.length - 1; i >= 0; --i) {
                            if (Reflect.get(/** @type {object} */ (backendDictionaries[i]), 'name') === modification.name) { backendDictionaries.splice(i, 1); }
                        }

                        break;
                    }
                    case 'push': {
                        backendDictionaries.push(...modification.items);

                        break;
                    }
                    case 'ensureDictionary': {
                        if (!backendDictionaries.some((entry) => Reflect.get(/** @type {object} */ (entry), 'name') === modification.item.name)) {
                            backendDictionaries.push(modification.item);
                        }

                        break;
                    }
                    default: {
                        throw new Error('Unexpected whole-array replacement');
                    }
                }
            }
            return [];
        });
        const staleOptions = {
            profiles: [{id: 'profile-a',
                options: {
                    dictionaries: [
                        {name: 'JMdict', alias: 'My alias', enabled: false},
                        {name: 'Unknown', alias: 'Stale', enabled: true},
                    ],
                }}],
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
            action: 'removeDictionaryByName',
            profileId: 'profile-a',
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

describe('DictionaryController database refresh ordering', () => {
    /** @returns {DictionaryController} */
    function createRefreshController() {
        const controller = /** @type {DictionaryController} */ (Object.create(DictionaryController.prototype));
        Reflect.set(controller, '_databaseStateToken', null);
        Reflect.set(controller, '_entriesUpdateToken', null);
        Reflect.set(controller, '_dictionaries', [{title: 'Dictionary'}]);
        Reflect.set(controller, '_dictionaryEntries', []);
        Reflect.set(controller, '_dictionaryInstallCountNode', null);
        Reflect.set(controller, '_noDictionariesInstalledWarnings', []);
        Reflect.set(controller, '_updateMainDictionarySelectOptions', vi.fn());
        Reflect.set(controller, '_updateDictionaryEntryCount', vi.fn());
        Reflect.set(controller, '_updateDictionariesEnabledWarnings', vi.fn());
        Reflect.set(controller, '_createDictionaryEntry', vi.fn());
        Reflect.set(controller, '_settingsController', {
            getOptionsFull: vi.fn().mockResolvedValue({profiles: []}),
            modifyGlobalSettings: vi.fn().mockResolvedValue([]),
        });
        return controller;
    }

    test('an older options response cannot render entries after a newer database refresh', async () => {
        const olderOptions = /** @type {import('core').DeferredPromiseDetails<import('settings').ProfileOptions>} */ (deferPromise());
        const newerOptions = /** @type {import('core').DeferredPromiseDetails<import('settings').ProfileOptions>} */ (deferPromise());
        const getOptions = vi.fn()
            .mockReturnValueOnce(olderOptions.promise)
            .mockReturnValueOnce(newerOptions.promise);
        const settingsController = {
            getDictionaryInfo: vi.fn()
                .mockResolvedValueOnce([{title: 'Old dictionary'}])
                .mockResolvedValueOnce([{title: 'New dictionary'}]),
            getOptionsFull: vi.fn().mockResolvedValue({profiles: []}),
            modifyGlobalSettings: vi.fn().mockResolvedValue([]),
            getOptions,
        };
        const controller = createRefreshController();
        const createEntry = vi.fn();
        Reflect.set(controller, '_settingsController', settingsController);
        Reflect.set(controller, '_createDictionaryEntry', createEntry);

        const olderRefresh = controller._onDatabaseUpdated();
        await vi.waitFor(() => { expect(getOptions).toHaveBeenCalledOnce(); });
        const newerRefresh = controller._onDatabaseUpdated();
        await vi.waitFor(() => { expect(getOptions).toHaveBeenCalledTimes(2); });

        newerOptions.resolve(/** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({dictionaries: [{name: 'New dictionary'}]})));
        await newerRefresh;
        olderOptions.resolve(/** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({dictionaries: [{name: 'Old dictionary'}]})));
        await olderRefresh;

        expect(createEntry).toHaveBeenCalledOnce();
        expect(createEntry).toHaveBeenCalledWith(0, {title: 'New dictionary'}, null, null);
    });

    test('an older options event cannot render entries after a newer options event', async () => {
        const olderOptions = /** @type {import('core').DeferredPromiseDetails<import('settings').ProfileOptions>} */ (deferPromise());
        const newerOptions = /** @type {import('core').DeferredPromiseDetails<import('settings').ProfileOptions>} */ (deferPromise());
        const getOptions = vi.fn().mockReturnValueOnce(olderOptions.promise).mockReturnValueOnce(newerOptions.promise);
        const controller = createRefreshController();
        Reflect.set(controller, '_settingsController', {...Reflect.get(controller, '_settingsController'), getOptions});
        const createEntry = vi.fn();
        Reflect.set(controller, '_createDictionaryEntry', createEntry);

        const olderRefresh = controller._refreshEntriesAfterOptionsChanged();
        const newerRefresh = controller._refreshEntriesAfterOptionsChanged();
        newerOptions.resolve(/** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({dictionaries: [{name: 'Dictionary', alias: 'New'}]})));
        await newerRefresh;
        olderOptions.resolve(/** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({dictionaries: [{name: 'Dictionary', alias: 'Old'}]})));
        await olderRefresh;

        expect(createEntry).toHaveBeenCalledOnce();
        expect(createEntry).toHaveBeenCalledWith(0, {title: 'Dictionary'}, null, null);
    });

    test('a pending options refresh cannot render after a database refresh supersedes it', async () => {
        const olderOptions = /** @type {import('core').DeferredPromiseDetails<import('settings').ProfileOptions>} */ (deferPromise());
        const newerOptions = /** @type {import('core').DeferredPromiseDetails<import('settings').ProfileOptions>} */ (deferPromise());
        const getOptions = vi.fn().mockReturnValueOnce(olderOptions.promise).mockReturnValueOnce(newerOptions.promise);
        const controller = createRefreshController();
        Reflect.set(controller, '_settingsController', {
            getDictionaryInfo: vi.fn().mockResolvedValue([{title: 'Fresh dictionary'}]),
            getOptionsFull: vi.fn().mockResolvedValue({profiles: []}),
            modifyGlobalSettings: vi.fn().mockResolvedValue([]),
            getOptions,
        });
        const createEntry = vi.fn();
        Reflect.set(controller, '_createDictionaryEntry', createEntry);

        const olderRefresh = controller._refreshEntriesAfterOptionsChanged();
        await vi.waitFor(() => { expect(getOptions).toHaveBeenCalledOnce(); });
        const newerRefresh = controller._onDatabaseUpdated();
        await vi.waitFor(() => { expect(getOptions).toHaveBeenCalledTimes(2); });
        newerOptions.resolve(/** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({dictionaries: [{name: 'Fresh dictionary'}]})));
        await newerRefresh;
        olderOptions.resolve(/** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({dictionaries: [{name: 'Dictionary'}]})));
        await olderRefresh;

        expect(createEntry).toHaveBeenCalledOnce();
        expect(createEntry).toHaveBeenCalledWith(0, {title: 'Fresh dictionary'}, null, null);
    });

    test('a pending database refresh cannot render after a newer options refresh', async () => {
        const olderOptions = /** @type {import('core').DeferredPromiseDetails<import('settings').ProfileOptions>} */ (deferPromise());
        const newerOptions = /** @type {import('core').DeferredPromiseDetails<import('settings').ProfileOptions>} */ (deferPromise());
        const getOptions = vi.fn().mockReturnValueOnce(olderOptions.promise).mockReturnValueOnce(newerOptions.promise);
        const controller = createRefreshController();
        Reflect.set(controller, '_settingsController', {
            getDictionaryInfo: vi.fn().mockResolvedValue([{title: 'Dictionary'}]),
            getOptionsFull: vi.fn().mockResolvedValue({profiles: []}),
            modifyGlobalSettings: vi.fn().mockResolvedValue([]),
            getOptions,
        });
        const createEntry = vi.fn();
        Reflect.set(controller, '_createDictionaryEntry', createEntry);

        const olderRefresh = controller._onDatabaseUpdated();
        await vi.waitFor(() => { expect(getOptions).toHaveBeenCalledOnce(); });
        const newerRefresh = controller._refreshEntriesAfterOptionsChanged();
        await vi.waitFor(() => { expect(getOptions).toHaveBeenCalledTimes(2); });
        newerOptions.resolve(/** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({dictionaries: [{name: 'Dictionary', alias: 'New'}]})));
        await newerRefresh;
        olderOptions.resolve(/** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({dictionaries: [{name: 'Dictionary', alias: 'Old'}]})));
        await olderRefresh;

        expect(createEntry).toHaveBeenCalledOnce();
        expect(createEntry).toHaveBeenCalledWith(0, {title: 'Dictionary'}, null, null);
    });

    test('reordering replaces the entry array after cleaning each existing entry once', () => {
        const controller = createRefreshController();
        const cleanup = vi.fn();
        const oldEntry = {dictionaryTitle: 'Dictionary', updateDownloadUrl: null, databaseCounts: null, cleanup};
        Reflect.set(controller, '_dictionaryEntries', [oldEntry]);
        Reflect.set(controller, '_dictionaryModalBody', {scrollTop: 12, scroll: vi.fn()});
        Reflect.set(controller, '_createDictionaryEntry', vi.fn(() => {
            /** @type {any[]} */ (Reflect.get(controller, '_dictionaryEntries')).push({dictionaryTitle: 'Dictionary'});
        }));

        controller._updateCurrentEntries(/** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({dictionaries: [{name: 'Dictionary'}]})));

        expect(cleanup).toHaveBeenCalledOnce();
        expect(Reflect.get(controller, '_dictionaryEntries')).toHaveLength(1);
    });
});


test('concurrent dictionary refreshes cannot remove the next installed entry using the same stale index', async () => {
    const options = {profiles: [{id: 'profile-a',
        options: {dictionaries: [
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
            if (modification.action !== 'removeDictionaryByName') { throw new Error('Unexpected modification'); }
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
