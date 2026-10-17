/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later */

import {describe, expect, test, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';
import {SettingsController} from '../ext/js/pages/settings/settings-controller.js';
import {DictionaryController} from '../ext/js/pages/settings/dictionary-controller.js';
import {DictionaryImportController} from '../ext/js/pages/settings/dictionary-import-controller.js';

/**
 * @param {string} title
 * @returns {import('dictionary-importer').Summary}
 */
function importSummary(title) {
    return /** @type {import('dictionary-importer').Summary} */ (/** @type {unknown} */ ({title, revision: '1', version: 3, importDate: 0, prefixWildcardsSupported: false, sequenced: false, styles: ''}));
}

describe('dictionary settings producers through the real options queue', () => {
    /** @returns {Promise<{backend: Backend, settingsController: SettingsController, installed: string[], dictionaryDatabase: {getDictionaryInfo: ReturnType<typeof vi.fn>}}>} */
    async function createHarness() {
        const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
        const options = /** @type {import('settings').Options} */ (/** @type {unknown} */ ({
            profileCurrent: 0,
            profiles: [
                {id: 'profile-a', name: 'A', conditionGroups: [], options: {dictionaries: [], general: {mainDictionary: 'Old', sortFrequencyDictionary: null}}},
                {id: 'profile-b', name: 'B', conditionGroups: [], options: {dictionaries: [], general: {mainDictionary: '', sortFrequencyDictionary: null}}},
            ],
        }));
        Reflect.set(backend, '_options', options);
        Reflect.set(backend, '_optionsUtil', {createValidatingProxy: (/** @type {import('settings').Options} */ value) => value});
        Reflect.set(backend, '_profileConditionsSchemaCache', []);
        Reflect.set(backend, '_applyOptions', vi.fn());
        Reflect.set(backend, '_clearProfileConditionsSchemaCache', vi.fn());
        Reflect.set(backend, '_ensureDictionaryDatabaseReady', vi.fn().mockResolvedValue(void 0));
        /** @type {string[]} */
        const installed = [];
        const dictionaryDatabase = {getDictionaryInfo: vi.fn(async () => installed.map((title) => ({title})))};
        Reflect.set(backend, '_dictionaryDatabase', dictionaryDatabase);
        Reflect.set(backend, '_saveOptions', async (_source, nextOptions) => { Reflect.set(backend, '_options', nextOptions); });
        const application = {
            on: vi.fn(),
            api: {
                optionsGetFull: async () => structuredClone(await backend._onApiOptionsGetFull(undefined, /** @type {chrome.runtime.MessageSender} */ (/** @type {unknown} */ ({})))),
                modifySettings: async (/** @type {import('settings-modifications').ScopedModification[]} */ targets, /** @type {string} */ source) => structuredClone(await backend._onApiModifySettings({targets: structuredClone(targets), source}, /** @type {chrome.runtime.MessageSender} */ (/** @type {unknown} */ ({})))),
            },
        };
        const settingsController = new SettingsController(/** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ (application)));
        Reflect.set(settingsController, '_source', 'queue-producer-test');
        Reflect.set(settingsController, '_profileId', 'profile-a');
        return {backend, settingsController, installed, dictionaryDatabase};
    }

    test('profile reorder ahead of an identity-targeted frontend producer cannot retarget the mutation', async () => {
        const {backend, settingsController, installed} = await createHarness();
        installed.push('JMdict');
        const reorder = backend._modifySettings([{
            action: 'swapProfiles', profileId1: 'profile-a', profileId2: 'profile-b', scope: 'global', optionsContext: null,
        }], 'reorder');
        const ensure = settingsController.modifyGlobalSettings([{
            action: 'ensureDictionary', profileId: 'profile-a', item: {name: 'JMdict', alias: 'JMdict', enabled: true},
        }]);
        await Promise.all([reorder, ensure]);
        const profiles = /** @type {import('settings').Options} */ (/** @type {unknown} */ (Reflect.get(backend, '_options'))).profiles;
        expect(profiles.find(({id}) => id === 'profile-a')?.options.dictionaries).toEqual([{name: 'JMdict', alias: 'JMdict', enabled: true}]);
        expect(profiles.find(({id}) => id === 'profile-b')?.options.dictionaries).toEqual([]);
    });

    test('import enablement and dictionary writes follow the selected profile ID when its index and snapshot are stale', async () => {
        const {backend, settingsController, installed} = await createHarness();
        installed.push('Imported');
        const staleOptions = await settingsController.getOptionsFull();
        await backend._modifySettings([{
            action: 'swapProfiles', profileId1: 'profile-a', profileId2: 'profile-b', scope: 'global', optionsContext: null,
        }], 'queued-reorder');
        Reflect.set(settingsController, '_profileIndex', 1);
        Reflect.set(settingsController, '_profileId', 'profile-b');
        const application = /** @type {import('../ext/js/application.js').Application} */ (Reflect.get(settingsController, '_application'));
        application.api.optionsGetFull = async () => staleOptions;

        const importer = /** @type {DictionaryImportController} */ (Object.create(DictionaryImportController.prototype));
        Reflect.set(importer, '_settingsController', settingsController);
        const addImportSettings = Reflect.get(importer, '_addDictionarySettings');
        await expect(addImportSettings.call(importer, importSummary('Imported'), null)).resolves.toEqual([]);

        const profiles = /** @type {import('settings').Options} */ (/** @type {unknown} */ (Reflect.get(backend, '_options'))).profiles;
        expect(profiles.find(({id}) => id === 'profile-b')?.options.dictionaries).toMatchObject([{name: 'Imported', enabled: true}]);
        expect(profiles.find(({id}) => id === 'profile-a')?.options.dictionaries).toMatchObject([{name: 'Imported', enabled: false}]);
    });

    test.each(/** @type {[string, unknown[]][]} */ ([
        ['missing', [{name: 'A', options: {dictionaries: [], general: {}}}, {id: 'profile-b', options: {dictionaries: [], general: {}}}]],
        ['duplicate', [{id: 'profile-a', options: {dictionaries: [], general: {}}}, {id: 'profile-a', options: {dictionaries: [], general: {}}}]],
    ]))('identity-targeted frontend producer fails closed for a %s profile ID', async (_kind, profilesValue) => {
        const {backend, settingsController, installed} = await createHarness();
        installed.push('JMdict');
        const profiles = /** @type {{id?: string, options: {dictionaries: unknown[]}}[]} */ (profilesValue);
        Reflect.set(backend, '_options', {profileCurrent: 0, profiles});
        const [result] = await settingsController.modifyGlobalSettings([{
            action: 'ensureDictionary', profileId: 'profile-a', item: {name: 'JMdict', alias: 'JMdict', enabled: true},
        }]);
        expect(result).toHaveProperty('error.message', 'Profile identity changed; reload settings and try again');
        expect(profiles.every(({options}) => options.dictionaries.length === 0)).toBe(true);
    });

    test('conditional selector updates preserve a newer user choice and enabled updates find the same alias after reorder', async () => {
        const {backend, settingsController, installed} = await createHarness();
        installed.push('Imported');
        const initial = /** @type {import('settings').Options} */ (/** @type {unknown} */ (Reflect.get(backend, '_options')));
        initial.profiles[0].options.dictionaries = [
            {...DictionaryController.createDefaultDictionarySettings('Imported', false, ''), alias: 'Keep'},
            {...DictionaryController.createDefaultDictionarySettings('Imported', true, ''), alias: 'Second'},
        ];
        const newerSelector = settingsController.modifyGlobalSettings([{
            action: 'set', path: 'profiles[0].options.general.mainDictionary', value: 'User choice',
        }]);
        const reorderedEnabled = settingsController.modifyGlobalSettings([{
            action: 'splice',
            path: 'profiles[0].options.dictionaries',
            start: 0,
            deleteCount: 2,
            items: [
                {...DictionaryController.createDefaultDictionarySettings('Imported', true, ''), alias: 'Second'},
                {...DictionaryController.createDefaultDictionarySettings('Imported', false, ''), alias: 'Keep'},
            ],
        }]);
        const conditionalSelector = settingsController.modifyGlobalSettings([{
            action: 'setDictionarySelector', profileId: 'profile-a', selector: 'mainDictionary', expectedValue: 'Old', value: 'Imported',
        }]);
        const enableByIdentity = settingsController.modifyGlobalSettings([{
            action: 'setDictionaryEnabled', profileId: 'profile-a', name: 'Imported', alias: 'Keep', value: true,
        }]);
        await Promise.all([newerSelector, reorderedEnabled, conditionalSelector, enableByIdentity]);
        const profileA = /** @type {import('settings').Options} */ (/** @type {unknown} */ (Reflect.get(backend, '_options'))).profiles[0];
        expect(profileA.options.general.mainDictionary).toBe('User choice');
        expect(profileA.options.dictionaries).toMatchObject([
            {name: 'Imported', alias: 'Second', enabled: true},
            {name: 'Imported', alias: 'Keep', enabled: true},
        ]);
    });

    test('import selector replacement does not overwrite a newer queued user choice', async () => {
        const {backend, settingsController, installed} = await createHarness();
        installed.push('Imported');
        const staleOptions = await settingsController.getOptionsFull();
        staleOptions.profiles[0].options.general.mainDictionary = 'Old';
        const application = /** @type {import('../ext/js/application.js').Application} */ (Reflect.get(settingsController, '_application'));
        application.api.optionsGetFull = async () => {
            await settingsController.modifyGlobalSettings([{
                action: 'set', path: 'profiles[0].options.general.mainDictionary', value: 'User choice',
            }]);
            return structuredClone(staleOptions);
        };
        const importer = /** @type {DictionaryImportController} */ (Object.create(DictionaryImportController.prototype));
        Reflect.set(importer, '_settingsController', settingsController);

        await expect(Reflect.get(importer, '_addDictionarySettings').call(importer, {...importSummary('Imported'), sourceTitle: 'Old'}, null))
            .resolves.toEqual([]);
        const current = /** @type {import('settings').Options} */ (/** @type {unknown} */ (Reflect.get(backend, '_options')));
        expect(current.profiles[0].options.general.mainDictionary).toBe('User choice');
    });

    test('selected import enables a disabled row inserted by an earlier queued refresh', async () => {
        const {backend, settingsController, installed} = await createHarness();
        installed.push('Queued import');
        const staleOptions = await settingsController.getOptionsFull();
        await settingsController.modifyGlobalSettings([{
            action: 'ensureDictionary',
            profileId: 'profile-a',
            item: DictionaryController.createDefaultDictionarySettings('Queued import', false, ''),
        }]);
        const application = /** @type {import('../ext/js/application.js').Application} */ (Reflect.get(settingsController, '_application'));
        application.api.optionsGetFull = async () => staleOptions;
        const importer = /** @type {DictionaryImportController} */ (Object.create(DictionaryImportController.prototype));
        Reflect.set(importer, '_settingsController', settingsController);

        await expect(Reflect.get(importer, '_addDictionarySettings').call(importer, importSummary('Queued import'), null)).resolves.toEqual([]);
        const current = /** @type {import('settings').Options} */ (/** @type {unknown} */ (Reflect.get(backend, '_options')));
        expect(current.profiles[0].options.dictionaries).toEqual([
            DictionaryController.createDefaultDictionarySettings('Queued import', true, ''),
        ]);
    });

    test('delete cleanup keeps selectors when the same title has already been reinstalled', async () => {
        const {backend, settingsController, installed, dictionaryDatabase} = await createHarness();
        installed.push('Reinstalled');
        const options = /** @type {import('settings').Options} */ (/** @type {unknown} */ (Reflect.get(backend, '_options')));
        options.profiles[0].options.dictionaries = [];
        options.profiles[0].options.general.mainDictionary = 'Reinstalled';
        options.profiles[0].options.general.sortFrequencyDictionary = 'Reinstalled';
        const controller = /** @type {DictionaryController} */ (Object.create(DictionaryController.prototype));
        Reflect.set(controller, '_settingsController', settingsController);

        await expect(controller._deleteDictionarySettings('Reinstalled')).resolves.toBeUndefined();
        const current = /** @type {import('settings').Options} */ (/** @type {unknown} */ (Reflect.get(backend, '_options')));
        expect(current.profiles[0].options.dictionaries).toEqual([]);
        expect(current.profiles[0].options.general.mainDictionary).toBe('Reinstalled');
        expect(current.profiles[0].options.general.sortFrequencyDictionary).toBe('Reinstalled');
        expect(dictionaryDatabase.getDictionaryInfo).toHaveBeenCalledOnce();
    });

    test('import cleanup keeps selector-only references when the same title has already been reinstalled', async () => {
        const {backend, settingsController, installed, dictionaryDatabase} = await createHarness();
        installed.push('Reinstalled');
        const options = /** @type {import('settings').Options} */ (/** @type {unknown} */ (Reflect.get(backend, '_options')));
        options.profiles[0].options.dictionaries = [];
        options.profiles[0].options.general.mainDictionary = 'Reinstalled';
        options.profiles[0].options.general.sortFrequencyDictionary = 'Reinstalled';
        const importer = /** @type {DictionaryImportController} */ (Object.create(DictionaryImportController.prototype));
        Reflect.set(importer, '_settingsController', settingsController);

        await expect(importer._removeDictionarySettingsByName('Reinstalled')).resolves.toEqual([]);
        const current = /** @type {import('settings').Options} */ (/** @type {unknown} */ (Reflect.get(backend, '_options')));
        expect(current.profiles[0].options.dictionaries).toEqual([]);
        expect(current.profiles[0].options.general.mainDictionary).toBe('Reinstalled');
        expect(current.profiles[0].options.general.sortFrequencyDictionary).toBe('Reinstalled');
        expect(dictionaryDatabase.getDictionaryInfo).toHaveBeenCalledOnce();
    });

    test('delete producer surfaces errors for ambiguous profile IDs without clearing either selector', async () => {
        const {backend, settingsController} = await createHarness();
        const options = /** @type {import('settings').Options} */ (/** @type {unknown} */ ({
            profileCurrent: 0,
            profiles: [
                {id: 'profile-a', name: 'A', conditionGroups: [], options: {dictionaries: [], general: {mainDictionary: 'Deleted', sortFrequencyDictionary: null}}},
                {id: 'profile-a', name: 'A duplicate', conditionGroups: [], options: {dictionaries: [], general: {mainDictionary: 'Deleted', sortFrequencyDictionary: null}}},
            ],
        }));
        Reflect.set(backend, '_options', options);
        const controller = /** @type {DictionaryController} */ (Object.create(DictionaryController.prototype));
        Reflect.set(controller, '_settingsController', settingsController);
        await expect(controller._deleteDictionarySettings('Deleted')).rejects.toThrow('Profile identity changed');
        expect(options.profiles.every(({options: profileOptions}) => profileOptions.general.mainDictionary === 'Deleted')).toBe(true);
    });

    test('reconciliation propagates ambiguous profile target errors', async () => {
        const {backend, settingsController, installed} = await createHarness();
        installed.push('JMdict');
        Reflect.set(backend, '_options', {
            profileCurrent: 0,
            profiles: [
                {id: 'profile-a', name: 'A', conditionGroups: [], options: {dictionaries: [], general: {mainDictionary: '', sortFrequencyDictionary: null}}},
                {id: 'profile-a', name: 'A duplicate', conditionGroups: [], options: {dictionaries: [], general: {mainDictionary: '', sortFrequencyDictionary: null}}},
            ],
        });
        const optionsSnapshot = await settingsController.getOptionsFull();
        await expect(DictionaryController.ensureDictionarySettings(settingsController, [importSummary('JMdict')], optionsSnapshot, true, false))
            .rejects.toThrow('Profile identity changed');
    });

    test('stale installed snapshot cannot recreate settings after the dictionary was deleted', async () => {
        const {backend, settingsController, installed} = await createHarness();
        installed.push('Removed');
        const staleOptions = structuredClone(await settingsController.getOptionsFull());
        const staleInstalled = [importSummary('Removed')];
        installed.splice(0);

        await settingsController.modifyGlobalSettings([{
            action: 'removeDictionaryByName', profileId: 'profile-a', name: 'Removed',
        }]);
        await DictionaryController.ensureDictionarySettings(settingsController, staleInstalled, staleOptions, true, false);

        const current = /** @type {import('settings').Options} */ (/** @type {unknown} */ (Reflect.get(backend, '_options')));
        expect(current.profiles.every(({options}) => options.dictionaries.every(({name}) => name !== 'Removed'))).toBe(true);
    });

    test('replacement restores captured rows only when pruned, keeps live preferences, and is repeatable', async () => {
        const {backend, settingsController, installed} = await createHarness();
        installed.push('Fresh title');
        const options = /** @type {import('settings').Options} */ (/** @type {unknown} */ (Reflect.get(backend, '_options')));
        options.profiles[0].options.dictionaries = /** @type {import('settings').DictionaryOptions[]} */ (/** @type {unknown} */ ([
            {name: 'Unrelated', alias: 'Unrelated', enabled: true},
            {name: 'Fresh title', alias: 'Keep', enabled: true, custom: 'newer target'},
            {name: 'Fresh title', alias: 'Added later', enabled: false, custom: 'new alias'},
        ]));
        options.profiles[1].options.dictionaries = /** @type {import('settings').DictionaryOptions[]} */ (/** @type {unknown} */ ([
            {name: 'Old title', alias: 'Old title', enabled: false, custom: 'newer live'},
            {name: 'Fresh title', alias: 'Keep live', enabled: true, custom: 'preserve live'},
        ]));
        Reflect.set(settingsController, '_profileId', 'profile-b');
        const importer = /** @type {DictionaryImportController} */ (Object.create(DictionaryImportController.prototype));
        Reflect.set(importer, '_settingsController', settingsController);
        const addImportSettings = Reflect.get(importer, '_addDictionarySettings');
        const captured = /** @type {import('settings-controller').ProfilesDictionarySettings} */ (/** @type {unknown} */ ({
            'profile-a': [
                {name: 'Old title', alias: 'Old title', enabled: false, custom: 'captured primary', index: 1},
                {name: 'Old title', alias: 'Keep', enabled: false, custom: 'stale alias', index: 2},
            ],
            'profile-b': [
                {name: 'Old title', alias: 'Old title', enabled: false, custom: 'stale live', index: 0},
            ],
        }));

        await expect(addImportSettings.call(importer, importSummary('Fresh title'), captured)).resolves.toEqual([]);
        await expect(addImportSettings.call(importer, importSummary('Fresh title'), captured)).resolves.toEqual([]);

        const result = /** @type {import('settings').Options} */ (/** @type {unknown} */ (Reflect.get(backend, '_options')));
        expect(result.profiles[0].options.dictionaries).toEqual([
            {name: 'Unrelated', alias: 'Unrelated', enabled: true},
            {name: 'Fresh title', alias: 'Fresh title', enabled: false, custom: 'captured primary', styles: ''},
            {name: 'Fresh title', alias: 'Keep', enabled: true, custom: 'newer target'},
            {name: 'Fresh title', alias: 'Added later', enabled: false, custom: 'new alias'},
        ]);
        expect(result.profiles[1].options.dictionaries).toEqual([
            {name: 'Fresh title', alias: 'Fresh title', enabled: false, custom: 'newer live', styles: ''},
            {name: 'Fresh title', alias: 'Keep live', enabled: true, custom: 'preserve live'},
        ]);
        expect(result.profiles.flatMap(({options: profileOptions}) => profileOptions.dictionaries.map(({name}) => name)))
            .toEqual(['Unrelated', 'Fresh title', 'Fresh title', 'Fresh title', 'Fresh title', 'Fresh title']);
    });

    test.each(['live', 'pruned'])('replacement preserves repeated same-alias source rows when %s', async (sourceState) => {
        const {backend, settingsController, installed} = await createHarness();
        installed.push('Exact Fresh Title');
        const options = /** @type {import('settings').Options} */ (/** @type {unknown} */ (Reflect.get(backend, '_options')));
        const sourceRows = /** @type {import('settings').DictionaryOptions[]} */ (/** @type {unknown} */ ([
            {...DictionaryController.createDefaultDictionarySettings('Old Title', false, ''), alias: 'Shared alias', custom: 'first'},
            {...DictionaryController.createDefaultDictionarySettings('Old Title', true, ''), alias: 'Shared alias', custom: 'second'},
        ]));
        options.profiles[0].options.dictionaries = sourceState === 'live' ? structuredClone(sourceRows) : [];
        const importer = /** @type {DictionaryImportController} */ (Object.create(DictionaryImportController.prototype));
        Reflect.set(importer, '_settingsController', settingsController);
        const captured = /** @type {import('settings-controller').ProfilesDictionarySettings} */ (/** @type {unknown} */ ({
            'profile-a': sourceRows.map((item, index) => ({...item, index})),
        }));
        const addImportSettings = Reflect.get(importer, '_addDictionarySettings');

        await expect(addImportSettings.call(importer, importSummary('Exact Fresh Title'), captured)).resolves.toEqual([]);
        await expect(addImportSettings.call(importer, importSummary('Exact Fresh Title'), captured)).resolves.toEqual([]);

        const rows = /** @type {import('settings').Options} */ (/** @type {unknown} */ (Reflect.get(backend, '_options')))
            .profiles[0].options.dictionaries;
        expect(rows.filter(({name}) => name === 'Exact Fresh Title')).toEqual([
            {...sourceRows[0], name: 'Exact Fresh Title', styles: ''},
            {...sourceRows[1], name: 'Exact Fresh Title', styles: ''},
        ]);
    });

    test('pruned replacement keeps captured multiplicity beyond one initial target occurrence', async () => {
        const {backend, settingsController, installed} = await createHarness();
        installed.push('Exact Fresh Title');
        const options = /** @type {import('settings').Options} */ (/** @type {unknown} */ (Reflect.get(backend, '_options')));
        options.profiles[0].options.dictionaries = /** @type {import('settings').DictionaryOptions[]} */ (/** @type {unknown} */ ([
            {...DictionaryController.createDefaultDictionarySettings('Exact Fresh Title', true, ''), alias: 'Shared alias', custom: 'newer target'},
        ]));
        const sourceRows = /** @type {import('settings-controller').ProfileDictionarySettings[]} */ (/** @type {unknown} */ ([
            {...DictionaryController.createDefaultDictionarySettings('Old Title', false, ''), alias: 'Shared alias', custom: 'first', index: 1},
            {...DictionaryController.createDefaultDictionarySettings('Old Title', false, ''), alias: 'Shared alias', custom: 'second', index: 2},
        ]));
        const importer = /** @type {DictionaryImportController} */ (Object.create(DictionaryImportController.prototype));
        Reflect.set(importer, '_settingsController', settingsController);
        const addImportSettings = Reflect.get(importer, '_addDictionarySettings');
        await expect(addImportSettings.call(importer, importSummary('Exact Fresh Title'), {
            'profile-a': sourceRows,
        })).resolves.toEqual([]);

        const rows = /** @type {import('settings').Options} */ (/** @type {unknown} */ (Reflect.get(backend, '_options')))
            .profiles[0].options.dictionaries;
        expect(rows).toEqual([
            {...DictionaryController.createDefaultDictionarySettings('Exact Fresh Title', true, ''), alias: 'Shared alias', custom: 'newer target'},
            ...[sourceRows[1]].map(({index: _index, ...item}) => ({...item, name: 'Exact Fresh Title', styles: ''})),
        ]);
    });

    test('stale reconciliation queued behind import does not insert a duplicate', async () => {
        const options = /** @type {import('settings').Options} */ (/** @type {unknown} */ ({
            profileCurrent: 0,
            profiles: [{
                id: 'profile-a',
                name: 'A',
                conditionGroups: [],
                options: {dictionaries: [], general: {mainDictionary: '', sortFrequencyDictionary: null}},
            }],
        }));
        const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
        Reflect.set(backend, '_options', options);
        Reflect.set(backend, '_optionsUtil', {createValidatingProxy: (/** @type {import('settings').Options} */ value) => value});
        Reflect.set(backend, '_profileConditionsSchemaCache', []);
        Reflect.set(backend, '_applyOptions', vi.fn());
        Reflect.set(backend, '_clearProfileConditionsSchemaCache', vi.fn());
        let saveCount = 0;
        Reflect.set(backend, '_dictionaryDatabase', {getDictionaryInfo: vi.fn().mockResolvedValue([{title: 'Imported'}])});
        Reflect.set(backend, '_saveOptions', async (_source, nextOptions) => {
            ++saveCount;
            Reflect.set(backend, '_options', nextOptions);
        });

        const application = {
            on: vi.fn(),
            api: {
                optionsGetFull: () => backend._onApiOptionsGetFull(undefined, /** @type {chrome.runtime.MessageSender} */ (/** @type {unknown} */ ({}))),
                modifySettings: (/** @type {import('settings-modifications').ScopedModification[]} */ targets, /** @type {string} */ source) => backend._onApiModifySettings({targets, source}, /** @type {chrome.runtime.MessageSender} */ (/** @type {unknown} */ ({}))),
            },
        };
        const settingsController = new SettingsController(/** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ (application)));
        Reflect.set(settingsController, '_source', 'settings-test');
        Reflect.set(settingsController, '_profileId', 'profile-a');
        const staleOptions = await settingsController.getOptionsFull();

        const importer = /** @type {DictionaryImportController} */ (Object.create(DictionaryImportController.prototype));
        Reflect.set(importer, '_settingsController', settingsController);
        const addImportSettings = Reflect.get(importer, '_addDictionarySettings');
        const importErrors = await addImportSettings.call(importer, importSummary('Imported'), null);

        // This is the actual database refresh reconciliation producer, given
        // an options snapshot captured before the import producer committed.
        const reconciliation = DictionaryController.ensureDictionarySettings(
            settingsController,
            [importSummary('Imported')],
            staleOptions,
            true,
            false,
        );
        await reconciliation;

        const result = /** @type {typeof options} */ (Reflect.get(backend, '_options'));
        expect({saveCount, importErrors}).toEqual({saveCount: 1, importErrors: []});
        expect(result.profiles[0].options.dictionaries.filter(({name}) => name === 'Imported')).toHaveLength(1);
    });
});
