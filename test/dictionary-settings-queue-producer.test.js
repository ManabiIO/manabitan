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

    test('settings-read exhaustion during replacement recovers captured preferences before cleanup and refresh', async () => {
        const {backend, settingsController, installed} = await createHarness();
        installed.push('Old title');
        const options = /** @type {import('settings').Options} */ (/** @type {unknown} */ (Reflect.get(backend, '_options')));
        options.profiles[0].options.dictionaries = [
            {name: 'Old title', alias: 'Jitendex', enabled: true, allowSecondarySearches: true, definitionsCollapsible: 'collapsed', partsOfSpeechFilter: false, useDeinflections: true},
            {name: 'Old title', alias: 'Second copy', enabled: false, allowSecondarySearches: false, definitionsCollapsible: 'expanded', partsOfSpeechFilter: false, useDeinflections: true},
        ];
        options.profiles[0].options.general.mainDictionary = 'Old title';
        options.profiles[1].options.dictionaries = [
            {name: 'Old title', alias: 'Quiet copy', enabled: false, allowSecondarySearches: false, definitionsCollapsible: 'expanded', partsOfSpeechFilter: false, useDeinflections: true},
        ];
        options.profiles[1].options.general.sortFrequencyDictionary = 'Old title';
        for (const profile of options.profiles) {
            profile.options.anki = /** @type {import('settings').AnkiOptions} */ (/** @type {unknown} */ ({cardFormats: []}));
        }
        Reflect.set(Reflect.get(backend, '_optionsUtil'), 'validate', vi.fn());

        const captured = /** @type {import('settings-controller').ProfilesDictionarySettings} */ (/** @type {unknown} */ ({
            'profile-a': [
                {name: 'Old title', alias: 'Jitendex', enabled: true, allowSecondarySearches: true, definitionsCollapsible: 'collapsed', partsOfSpeechFilter: false, useDeinflections: true, index: 0},
                {name: 'Old title', alias: 'Second copy', enabled: false, allowSecondarySearches: false, definitionsCollapsible: 'expanded', partsOfSpeechFilter: false, useDeinflections: true, index: 1},
            ],
            'profile-b': [{name: 'Old title', alias: 'Quiet copy', enabled: false, allowSecondarySearches: false, definitionsCollapsible: 'expanded', partsOfSpeechFilter: false, useDeinflections: true, index: 0}],
        }));
        let injectedReadFailures = 0;
        let fallbackQueued = false;
        /** @type {string[]} */
        const operationSequence = [];
        const originalModifyGlobalSettings = settingsController.modifyGlobalSettings.bind(settingsController);
        vi.spyOn(settingsController, 'modifyGlobalSettings').mockImplementation(async (targets) => {
            if (targets.some(({action}) => action === 'replaceDictionaryName')) {
                fallbackQueued = true;
                operationSequence.push('replacement-fallback');
            }
            return await originalModifyGlobalSettings(targets);
        });
        vi.spyOn(settingsController, 'getOptionsFull').mockImplementation(async () => {
            if (!fallbackQueued) {
                ++injectedReadFailures;
                throw new Error(`transient options read failure ${injectedReadFailures}`);
            }
            return await backend._onApiOptionsGetFull(undefined, /** @type {chrome.runtime.MessageSender} */ (/** @type {unknown} */ ({})));
        });

        const replacementCutover = vi.fn(async () => {
            // Model the completed storage title cutover: only the new title is
            // installed by the time settings publication begins.
            installed.splice(installed.indexOf('Old title'), 1, 'Fresh title');
        });
        const databaseRefresh = vi.fn(async () => {
            operationSequence.push('refresh');
            await DictionaryController.ensureDictionarySettings(
                settingsController,
                [importSummary('Fresh title')],
                undefined,
                true,
                false,
            );
        });
        const application = /** @type {import('../ext/js/application.js').Application} */ (Reflect.get(settingsController, '_application'));
        application.api.replaceDictionaryTitle = replacementCutover;
        application.api.triggerDatabaseUpdated = databaseRefresh;
        application.api.setAllSettings = async (value, source) => await backend._onApiSetAllSettings({value, source}, /** @type {chrome.runtime.MessageSender} */ (/** @type {unknown} */ ({})));

        const importer = /** @type {DictionaryImportController} */ (Object.create(DictionaryImportController.prototype));
        Reflect.set(importer, '_settingsController', settingsController);
        Reflect.set(importer, '_recordImportLocalPhase', vi.fn());
        Reflect.set(importer, '_recordImportDebugSnapshot', vi.fn());
        Reflect.set(importer, '_isImportRunCurrent', () => true);
        Reflect.set(importer, '_verifyImportedDictionaryVisible', vi.fn().mockResolvedValue(void 0));
        const removeOldSettings = vi.spyOn(importer, '_removeDictionarySettingsByName');
        removeOldSettings.mockImplementation(async (title) => {
            operationSequence.push('cleanup');
            return await DictionaryImportController.prototype._removeDictionarySettingsByName.call(importer, title);
        });
        const finalize = Reflect.get(importer, '_finalizeImportedDictionaryResult');
        const result = await finalize.call(importer, {
            dictionaryTitle: 'Old title',
            importStartTime: 0,
            importDetails: {replacementDictionaryTitle: 'Old title'},
            importResult: {
                result: /** @type {import('dictionary-importer').Summary} */ (/** @type {unknown} */ ({...importSummary('Fresh title staged'), sourceTitle: 'Fresh title', styles: ''})),
                errors: [],
                debug: /** @type {import('dictionary-importer').ImportDebug} */ (/** @type {unknown} */ ({importerDebug: {phaseTimings: []}})),
            },
            workerImportStartTime: 0,
            workerImportEndTime: 0,
            useImportSession: false,
            finalizeImportSession: false,
            importRunGeneration: 1,
            profilesDictionarySettings: captured,
            localPhaseTimings: [],
            showErrors: false,
        });

        const finalOptions = /** @type {import('settings').Options} */ (/** @type {unknown} */ (Reflect.get(backend, '_options')));
        const profileA = finalOptions.profiles.find(({id}) => id === 'profile-a');
        const profileB = finalOptions.profiles.find(({id}) => id === 'profile-b');
        expect({
            cutoverCalls: replacementCutover.mock.calls.length,
            injectedReadFailures,
            fallbackQueued,
            cleanupCalled: removeOldSettings.mock.calls.length,
            refreshCalls: databaseRefresh.mock.calls.length,
            resultErrors: result.errors.map(({message}) => message),
            importedTitle: result.importedTitle,
        }).toEqual({
            cutoverCalls: 1,
            injectedReadFailures: 10,
            fallbackQueued: true,
            cleanupCalled: 1,
            refreshCalls: 1,
            resultErrors: [],
            importedTitle: 'Fresh title',
        });
        expect(operationSequence).toEqual(['replacement-fallback', 'cleanup', 'refresh']);
        expect({
            profileADictionaries: profileA?.options.dictionaries,
            profileAMainDictionary: profileA?.options.general.mainDictionary,
            profileBDictionaries: profileB?.options.dictionaries,
            profileBSortFrequencyDictionary: profileB?.options.general.sortFrequencyDictionary,
        }).toEqual({
            profileADictionaries: [
                expect.objectContaining({
                    name: 'Fresh title', alias: 'Jitendex', enabled: true, allowSecondarySearches: true, definitionsCollapsible: 'collapsed',
                }),
                expect.objectContaining({
                    name: 'Fresh title', alias: 'Second copy', enabled: false, allowSecondarySearches: false, definitionsCollapsible: 'expanded',
                }),
            ],
            profileAMainDictionary: 'Fresh title',
            profileBDictionaries: [expect.objectContaining({
                name: 'Fresh title', alias: 'Quiet copy', enabled: false, allowSecondarySearches: false, definitionsCollapsible: 'expanded',
            })],
            profileBSortFrequencyDictionary: 'Fresh title',
        });
    });

    test('replacement fallback queues captured rows through persistent options-read failures and preserves newer target choices', async () => {
        const {backend, settingsController, installed} = await createHarness();
        installed.push('Fresh title');
        const options = /** @type {import('settings').Options} */ (/** @type {unknown} */ (Reflect.get(backend, '_options')));
        options.profiles[0].options.dictionaries = [
            {name: 'Old title', alias: 'Source', enabled: true, allowSecondarySearches: true, definitionsCollapsible: 'collapsed', partsOfSpeechFilter: false, useDeinflections: true},
            {name: 'Fresh title', alias: 'Keep', enabled: false, allowSecondarySearches: false, definitionsCollapsible: 'expanded', partsOfSpeechFilter: false, useDeinflections: true},
        ];
        options.profiles[0].options.general.mainDictionary = 'Old title';
        options.profiles[0].options.general.sortFrequencyDictionary = 'Old title';
        const captured = /** @type {import('settings-controller').ProfilesDictionarySettings} */ (/** @type {unknown} */ ({
            'profile-a': [{name: 'Old title', alias: 'Source', enabled: true, allowSecondarySearches: true, definitionsCollapsible: 'collapsed', partsOfSpeechFilter: false, useDeinflections: true, index: 0}],
        }));
        const originalGetOptionsFull = settingsController.getOptionsFull.bind(settingsController);
        let injectedReadFailures = 0;
        vi.spyOn(settingsController, 'getOptionsFull').mockImplementation(async () => {
            if (injectedReadFailures === 0) {
                await settingsController.modifyGlobalSettings([
                    {action: 'set', path: 'profiles[0].options.general.mainDictionary', value: 'User main choice'},
                    {action: 'set', path: 'profiles[0].options.general.sortFrequencyDictionary', value: 'User frequency choice'},
                    {action: 'set', path: 'profiles[0].options.dictionaries[1].definitionsCollapsible', value: 'not-collapsible'},
                ]);
            }
            ++injectedReadFailures;
            throw new Error('persistent options read failure');
        });
        const importer = /** @type {DictionaryImportController} */ (Object.create(DictionaryImportController.prototype));
        Reflect.set(importer, '_settingsController', settingsController);

        await expect(Reflect.get(importer, '_addDictionarySettings').call(importer, importSummary('Fresh title'), captured)).resolves.toEqual([]);

        const profile = /** @type {import('settings').Options} */ (/** @type {unknown} */ (Reflect.get(backend, '_options'))).profiles[0];
        expect(injectedReadFailures).toBeGreaterThan(0);
        expect(profile.options.dictionaries).toEqual([
            {name: 'Fresh title', alias: 'Source', enabled: true, allowSecondarySearches: true, definitionsCollapsible: 'collapsed', partsOfSpeechFilter: false, useDeinflections: true, styles: ''},
            {name: 'Fresh title', alias: 'Keep', enabled: false, allowSecondarySearches: false, definitionsCollapsible: 'not-collapsible', partsOfSpeechFilter: false, useDeinflections: true},
        ]);
        expect(profile.options.general.mainDictionary).toBe('User main choice');
        expect(profile.options.general.sortFrequencyDictionary).toBe('User frequency choice');
        settingsController.getOptionsFull = originalGetOptionsFull;
    });

    test('new import keeps the original settings error when options reads fail', async () => {
        const {settingsController} = await createHarness();
        vi.spyOn(settingsController, 'getOptionsFull').mockRejectedValue(new Error('persistent options read failure'));
        const importer = /** @type {DictionaryImportController} */ (Object.create(DictionaryImportController.prototype));
        Reflect.set(importer, '_settingsController', settingsController);

        const errors = await Reflect.get(importer, '_addDictionarySettings').call(importer, importSummary('New import'), null);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toBe('Failed to automatically set dictionary settings. A page refresh and manual enabling of the dictionary may be required.');
    });

    test('replacement with no captured profile rows keeps the original settings error', async () => {
        const {settingsController} = await createHarness();
        vi.spyOn(settingsController, 'getOptionsFull').mockRejectedValue(new Error('persistent options read failure'));
        const importer = /** @type {DictionaryImportController} */ (Object.create(DictionaryImportController.prototype));
        Reflect.set(importer, '_settingsController', settingsController);

        const emptyCapture = /** @type {import('settings-controller').ProfilesDictionarySettings} */ (/** @type {unknown} */ ({}));
        const errors = await Reflect.get(importer, '_addDictionarySettings').call(importer, importSummary('Fresh title'), emptyCapture);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toBe('Failed to automatically set dictionary settings. A page refresh and manual enabling of the dictionary may be required.');
    });

    test.each([
        ['missing', [{id: 'profile-b', name: 'B', conditionGroups: [], options: {dictionaries: [], general: {mainDictionary: 'Old title', sortFrequencyDictionary: null}}}]],
        ['duplicate', [
            {id: 'profile-a', name: 'A', conditionGroups: [], options: {dictionaries: [{name: 'Old title', alias: 'A', enabled: true}], general: {mainDictionary: 'Old title', sortFrequencyDictionary: null}}},
            {id: 'profile-a', name: 'A duplicate', conditionGroups: [], options: {dictionaries: [{name: 'Old title', alias: 'B', enabled: true}], general: {mainDictionary: 'Old title', sortFrequencyDictionary: null}}},
        ]],
    ])('replacement fallback reports a %s captured profile identity without mutating its rows', async (_kind, profiles) => {
        const {backend, settingsController, installed} = await createHarness();
        installed.push('Fresh title');
        Reflect.set(backend, '_options', {profileCurrent: 0, profiles});
        vi.spyOn(settingsController, 'getOptionsFull').mockRejectedValue(new Error('persistent options read failure'));
        const importer = /** @type {DictionaryImportController} */ (Object.create(DictionaryImportController.prototype));
        Reflect.set(importer, '_settingsController', settingsController);
        const captured = /** @type {import('settings-controller').ProfilesDictionarySettings} */ (/** @type {unknown} */ ({
            'profile-a': [{name: 'Old title', alias: 'Captured', enabled: true, index: 0}],
        }));

        const errors = await Reflect.get(importer, '_addDictionarySettings').call(importer, importSummary('Fresh title'), captured);
        expect(errors.map(({message}) => message).join('; ')).toContain('Profile identity changed');
        expect(profiles.every(({options}) => options.dictionaries.every(({name}) => name === 'Old title'))).toBe(true);
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
