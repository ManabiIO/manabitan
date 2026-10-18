/* Dictionary-row ownership regression: numeric row binding must survive a queued reorder. */
import {describe, expect, test, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';
import {SettingsController} from '../ext/js/pages/settings/settings-controller.js';
import {GenericSettingController} from '../ext/js/pages/settings/generic-setting-controller.js';
import {DictionaryController} from '../ext/js/pages/settings/dictionary-controller.js';
import {SecondarySearchDictionaryController} from '../ext/js/pages/settings/secondary-search-dictionary-controller.js';
import {CollapsibleDictionaryController} from '../ext/js/pages/settings/collapsible-dictionary-controller.js';
import {EventListenerCollection} from '../ext/js/core/event-listener-collection.js';
import {createDomTest} from './fixtures/dom-test.js';

const domTest = createDomTest();

describe('row ownership audit', () => {
    domTest('DOMDataBinder writes the captured checkbox row through the serialized RPC boundary after reorder', async ({window}) => {
        vi.stubGlobal('chrome', {permissions: {}});
        window.document.body.innerHTML = `
            <div id="dictionary-list"><div class="dictionary-item-bottom"></div></div>
            <div id="secondary-search-dictionary-list"></div>
            <div id="collapsible-dictionary-list"></div>
            <template id="dictionary-row-template">
                <div class="dictionary-item-title-container"><strong class="dictionary-alias"></strong><span class="dictionary-revision"></span></div>
                <input class="dictionary-enabled" type="checkbox">
                <button id="dictionary-move-up"></button><button id="dictionary-move-down"></button>
                <button class="dictionary-menu-button"></button>
                <button class="dictionary-outdated-button"></button>
                <button class="dictionary-integrity-button-check"></button>
                <button class="dictionary-integrity-button-warning"></button>
                <button class="dictionary-integrity-button-error"></button>
                <button class="dictionary-update-available"></button>
            </template>
            <template id="secondary-row-template"><div><span class="dictionary-title"></span><span class="dictionary-revision"></span><input class="dictionary-allow-secondary-searches" type="checkbox"></div></template>
            <template id="collapsible-row-template"><div><span class="dictionary-title"></span><span class="dictionary-revision"></span><select class="definitions-collapsible"><option value="not-collapsible">No</option><option value="always">Always</option></select></div></template>
        `;
        const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
        const options = /** @type {import('settings').Options} */ (/** @type {unknown} */ ({
            profileCurrent: 0,
            profiles: [{id: 'profile-a',
                name: 'A',
                conditionGroups: [],
                options: {
                    dictionaries: [
                        {name: 'A', alias: 'A', enabled: true, allowSecondarySearches: false, definitionsCollapsible: 'not-collapsible'},
                        {name: 'B', alias: 'B', enabled: true, allowSecondarySearches: false, definitionsCollapsible: 'not-collapsible'},
                    ],
                    general: {mainDictionary: '', sortFrequencyDictionary: null},
                }}],
        }));
        Reflect.set(backend, '_options', options);
        Reflect.set(backend, '_optionsUtil', {createValidatingProxy: (/** @type {unknown} */ value) => value});
        Reflect.set(backend, '_profileConditionsSchemaCache', []);
        Reflect.set(backend, '_applyOptions', vi.fn());
        Reflect.set(backend, '_clearProfileConditionsSchemaCache', vi.fn());
        Reflect.set(backend, '_saveOptions', async (_source, nextOptions) => { Reflect.set(backend, '_options', nextOptions); });
        const sender = /** @type {chrome.runtime.MessageSender} */ (/** @type {unknown} */ ({}));
        const modifySettings = vi.fn(async (/** @type {import('settings-modifications').ScopedModification[]} */ targets, /** @type {string} */ source) => structuredClone(await backend._onApiModifySettings({targets: structuredClone(targets), source}, sender)));
        const application = {
            on: vi.fn(),
            api: {
                optionsGetFull: async () => structuredClone(await backend._onApiOptionsGetFull(undefined, sender)),
                optionsGet: async (/** @type {import('settings').OptionsContext} */ optionsContext) => structuredClone(await backend._onApiOptionsGet({optionsContext: structuredClone(optionsContext)}, sender)),
                getSettings: async (/** @type {import('settings-modifications').ScopedRead[]} */ targets) => structuredClone(await backend._onApiGetSettings({targets: structuredClone(targets)}, sender)),
                modifySettings,
            },
        };
        const settingsController = new SettingsController(/** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ (application)));
        Reflect.set(settingsController, '_templates', {loadFromFiles: vi.fn()});
        Reflect.set(settingsController, '_source', 'row-ownership-dom-audit');
        await settingsController.prepare();
        Reflect.set(settingsController, 'instantiateTemplateFragment', () => /** @type {HTMLTemplateElement} */ (window.document.querySelector('#dictionary-row-template')).content.cloneNode(true));
        Reflect.set(settingsController, 'instantiateTemplate', (/** @type {string} */ name) => {
            const id = name === 'secondary-search-dictionary' ? '#secondary-row-template' : '#collapsible-row-template';
            return /** @type {HTMLTemplateElement} */ (/** @type {unknown} */ (window.document.querySelector(id))).content.firstElementChild?.cloneNode(true);
        });
        const dictionaryInfo = /** @type {import('dictionary-importer').Summary} */ (/** @type {unknown} */ ({title: 'A', revision: '1', sequenced: true, version: 3, importDate: 0, prefixWildcardsSupported: false, styles: '', importSuccess: true, storageHealth: 'healthy', counts: {terms: {total: 1}}}));
        const dictionaryController = /** @type {DictionaryController} */ (Object.create(DictionaryController.prototype));
        Reflect.set(dictionaryController, '_settingsController', settingsController);
        Reflect.set(dictionaryController, '_dictionaryEntries', []);
        Reflect.set(dictionaryController, '_dictionaryEntryContainer', window.document.querySelector('#dictionary-list'));
        Reflect.set(dictionaryController, '_updateDictionaryEntryCount', vi.fn());
        Reflect.set(dictionaryController, '_updateDictionariesEnabledWarnings', vi.fn());
        Reflect.set(dictionaryController, '_noDictionariesEnabledWarnings', []);
        Reflect.set(dictionaryController, '_dictionaries', [{title: 'A'}]);
        Reflect.set(dictionaryController, '_dictionaries', null);
        dictionaryController._createDictionaryEntry(0, 'profile-a', options.profiles[0].options.dictionaries[0], dictionaryInfo, null, null);
        const input = /** @type {HTMLInputElement} */ (window.document.querySelector('.dictionary-enabled'));
        const optionsContext = settingsController.getOptionsContext();
        const secondaryController = /** @type {SecondarySearchDictionaryController} */ (Object.create(SecondarySearchDictionaryController.prototype));
        Reflect.set(secondaryController, '_settingsController', settingsController);
        Reflect.set(secondaryController, '_dictionaryInfoMap', new Map([['A', dictionaryInfo]]));
        Reflect.set(secondaryController, '_eventListeners', new EventListenerCollection());
        Reflect.set(secondaryController, '_container', window.document.querySelector('#secondary-search-dictionary-list'));
        Reflect.set(secondaryController, '_optionsRenderRequest', 0);
        Reflect.set(secondaryController, '_getDictionaryInfoToken', null);
        secondaryController._onOptionsChanged({options: options.profiles[0].options, optionsContext});
        const secondaryToggle = /** @type {HTMLInputElement} */ (window.document.querySelector('.dictionary-allow-secondary-searches'));
        const collapsibleController = /** @type {CollapsibleDictionaryController} */ (Object.create(CollapsibleDictionaryController.prototype));
        Reflect.set(collapsibleController, '_settingsController', settingsController);
        Reflect.set(collapsibleController, '_dictionaryInfoMap', new Map([['A', dictionaryInfo]]));
        Reflect.set(collapsibleController, '_eventListeners', new EventListenerCollection());
        Reflect.set(collapsibleController, '_container', window.document.querySelector('#collapsible-dictionary-list'));
        Reflect.set(collapsibleController, '_selects', []);
        Reflect.set(collapsibleController, '_allSelect', null);
        Reflect.set(collapsibleController, '_optionsRenderRequest', 0);
        Reflect.set(collapsibleController, '_allSelectRefreshRequest', 0);
        collapsibleController._onOptionsChanged({options: options.profiles[0].options, optionsContext});
        const collapsibleSelect = /** @type {HTMLSelectElement} */ (window.document.querySelector('.definitions-collapsible'));
        await new Promise((resolve) => { setTimeout(resolve, 0); });
        const generic = new GenericSettingController(settingsController);
        await generic.prepare();
        expect(generic._createElementMetadata(input)?.dictionaryRowOwnership).toMatchObject({profileId: 'profile-a', index: 0});

        const reorder = settingsController.modifyProfileSettings([{
            action: 'moveDictionary',
            path: 'dictionaries',
            currentIndex: 0,
            targetIndex: 1,
            expectedNames: ['A', 'B'],
            expectedEntries: structuredClone(options.profiles[0].options.dictionaries),
        }]);
        input.checked = false;
        input.dispatchEvent(new window.Event('change'));
        secondaryToggle.checked = true;
        secondaryToggle.dispatchEvent(new window.Event('change'));
        await vi.waitFor(() => { expect(modifySettings).toHaveBeenCalled(); });
        await reorder;
        await vi.waitFor(() => {
            expect(/** @type {import('settings').Options} */ (Reflect.get(backend, '_options')).profiles[0].options.dictionaries).toEqual([
                {name: 'B', alias: 'B', enabled: true, allowSecondarySearches: false, definitionsCollapsible: 'not-collapsible'},
                {name: 'A', alias: 'A', enabled: true, allowSecondarySearches: false, definitionsCollapsible: 'not-collapsible'},
            ]);
        });
        generic._dataBinder.disconnect();
    });

    test('generic settings producer leaves the captured row unchanged after queued reorder', async () => {
        const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
        const options = /** @type {import('settings').Options} */ (/** @type {unknown} */ ({
            profileCurrent: 0,
            profiles: [{id: 'profile-a',
                name: 'A',
                conditionGroups: [],
                options: {
                    dictionaries: [
                        {name: 'A', alias: 'A', enabled: true},
                        {name: 'B', alias: 'B', enabled: true},
                    ],
                    general: {mainDictionary: '', sortFrequencyDictionary: null},
                }}],
        }));
        Reflect.set(backend, '_options', options);
        Reflect.set(backend, '_optionsUtil', {createValidatingProxy: (/** @type {unknown} */ value) => value});
        Reflect.set(backend, '_profileConditionsSchemaCache', []);
        Reflect.set(backend, '_applyOptions', vi.fn());
        Reflect.set(backend, '_clearProfileConditionsSchemaCache', vi.fn());
        Reflect.set(backend, '_saveOptions', async (_source, nextOptions) => { Reflect.set(backend, '_options', nextOptions); });
        const application = {
            api: {
                optionsGet: async (/** @type {{index: number}} */ {index}) => structuredClone((await backend._onApiOptionsGet({optionsContext: {index}}, /** @type {chrome.runtime.MessageSender} */ (/** @type {unknown} */ ({}))))),
                modifySettings: async (/** @type {import('settings-modifications').ScopedModification[]} */ targets, /** @type {string} */ source) => structuredClone(await backend._onApiModifySettings({targets: structuredClone(targets), source}, /** @type {chrome.runtime.MessageSender} */ (/** @type {unknown} */ ({})))),
            },
        };
        const settingsController = new SettingsController(/** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ (application)));
        Reflect.set(settingsController, '_source', 'row-ownership-audit');
        Reflect.set(settingsController, '_profileId', 'profile-a');
        const generic = /** @type {GenericSettingController} */ (Object.create(GenericSettingController.prototype));
        Reflect.set(generic, '_settingsController', settingsController);
        Reflect.set(generic, '_defaultScope', 'profile');

        const reorder = settingsController.modifyProfileSettings([{
            action: 'moveDictionary',
            path: 'dictionaries',
            currentIndex: 0,
            targetIndex: 1,
            expectedNames: ['A', 'B'],
            expectedEntries: structuredClone(options.profiles[0].options.dictionaries),
        }]);
        const aliasEdit = generic._setValues([{
            metadata: {
                path: 'dictionaries[0].alias',
                scope: 'profile',
                transforms: [],
                transformRaw: void 0,
                dictionaryRowOwnership: {id: 'test:1', profileId: 'profile-a', index: 0, expectedEntry: structuredClone(options.profiles[0].options.dictionaries[0])},
            },
            value: 'Renamed A',
            element: /** @type {HTMLElement} */ (/** @type {unknown} */ ({})),
        }]);
        await Promise.all([reorder, aliasEdit]);

        expect(/** @type {import('settings').Options} */ (Reflect.get(backend, '_options')).profiles[0].options.dictionaries).toEqual([
            {name: 'B', alias: 'B', enabled: true},
            {name: 'A', alias: 'A', enabled: true},
        ]);
    });

    test('two guarded field writes for one row advance the staged row snapshot', async () => {
        const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
        const options = /** @type {import('settings').Options} */ (/** @type {unknown} */ ({
            profileCurrent: 0,
            profiles: [{id: 'profile-a',
                name: 'A',
                conditionGroups: [],
                options: {
                    dictionaries: [{name: 'A', alias: 'old', enabled: false}],
                    general: {mainDictionary: '', sortFrequencyDictionary: null},
                }}],
        }));
        Reflect.set(backend, '_options', options);
        Reflect.set(backend, '_optionsUtil', {createValidatingProxy: (/** @type {unknown} */ value) => value});
        Reflect.set(backend, '_profileConditionsSchemaCache', []);
        Reflect.set(backend, '_applyOptions', vi.fn());
        Reflect.set(backend, '_clearProfileConditionsSchemaCache', vi.fn());
        Reflect.set(backend, '_saveOptions', async (_source, nextOptions) => { Reflect.set(backend, '_options', nextOptions); });
        const target = (/** @type {import('settings-modifications').Modification} */ modification) => /** @type {import('settings-modifications').ScopedModification} */ ({...modification, scope: 'profile', optionsContext: {index: 0}});
        const expectedEntry = structuredClone(options.profiles[0].options.dictionaries[0]);
        const results = await backend._modifySettings([
            target({action: 'setDictionaryField', profileId: 'profile-a', index: 0, expectedEntry, field: 'alias', value: 'new'}),
            target({action: 'setDictionaryField', profileId: 'profile-a', index: 0, expectedEntry, field: 'enabled', value: true}),
        ], 'two row fields');
        expect(results.map(({error}) => error)).toEqual([undefined, undefined]);
        expect(/** @type {import('settings').Options} */ (Reflect.get(backend, '_options')).profiles[0].options.dictionaries).toEqual([
            {name: 'A', alias: 'new', enabled: true},
        ]);
    });

    test('a structural mutation earlier in the same batch makes the captured field write stale', async () => {
        const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
        const options = /** @type {import('settings').Options} */ (/** @type {unknown} */ ({
            profileCurrent: 0,
            profiles: [{id: 'profile-a',
                name: 'A',
                conditionGroups: [],
                options: {
                    dictionaries: [
                        {name: 'A', alias: 'first', enabled: false},
                        {name: 'B', alias: 'bee', enabled: true},
                    ],
                    general: {mainDictionary: '', sortFrequencyDictionary: null},
                }}],
        }));
        Reflect.set(backend, '_options', options);
        Reflect.set(backend, '_optionsUtil', {createValidatingProxy: (/** @type {unknown} */ value) => value});
        Reflect.set(backend, '_profileConditionsSchemaCache', []);
        Reflect.set(backend, '_applyOptions', vi.fn());
        Reflect.set(backend, '_clearProfileConditionsSchemaCache', vi.fn());
        Reflect.set(backend, '_saveOptions', async (_source, nextOptions) => { Reflect.set(backend, '_options', nextOptions); });
        const target = (/** @type {import('settings-modifications').Modification} */ modification) => /** @type {import('settings-modifications').ScopedModification} */ ({...modification, scope: 'profile', optionsContext: {index: 0}});
        const firstEntry = structuredClone(options.profiles[0].options.dictionaries[0]);
        const originalOrder = structuredClone(options.profiles[0].options.dictionaries);
        const results = await backend._modifySettings([
            target({action: 'moveDictionary', path: 'dictionaries', currentIndex: 0, targetIndex: 1, expectedNames: ['A', 'B'], expectedEntries: originalOrder}),
            target({action: 'setDictionaryField', profileId: 'profile-a', index: 0, expectedEntry: firstEntry, field: 'alias', value: 'renamed'}),
        ], 'move then stale row field');
        expect(results[1]?.result).toMatchObject({stale: true});
        expect(/** @type {import('settings').Options} */ (Reflect.get(backend, '_options')).profiles[0].options.dictionaries).toEqual([
            {name: 'B', alias: 'bee', enabled: true},
            {name: 'A', alias: 'first', enabled: false},
        ]);
    });

    test('same-index targets with distinct snapshots fail closed for the stale second target', async () => {
        const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
        const options = /** @type {import('settings').Options} */ (/** @type {unknown} */ ({profileCurrent: 0, profiles: [{id: 'profile-a', name: 'A', conditionGroups: [], options: {dictionaries: [{name: 'A', alias: 'a'}, {name: 'B', alias: 'b'}], general: {mainDictionary: '', sortFrequencyDictionary: null}}}]}));
        Reflect.set(backend, '_options', options);
        Reflect.set(backend, '_optionsUtil', {createValidatingProxy: (/** @type {unknown} */ value) => value});
        Reflect.set(backend, '_profileConditionsSchemaCache', []);
        Reflect.set(backend, '_applyOptions', vi.fn());
        Reflect.set(backend, '_clearProfileConditionsSchemaCache', vi.fn());
        Reflect.set(backend, '_saveOptions', async (_source, nextOptions) => { Reflect.set(backend, '_options', nextOptions); });
        const target = (/** @type {Record<string, unknown>} */ expectedEntry, /** @type {string} */ value) => /** @type {import('settings-modifications').ScopedModification} */ ({action: 'setDictionaryField', profileId: 'profile-a', index: 0, expectedEntry, field: 'alias', value, scope: 'profile', optionsContext: {index: 0}});
        await backend._modifySettings([target({name: 'A', alias: 'a'}, 'changed A'), target({name: 'B', alias: 'b'}, 'changed B')], 'collision');
        expect(/** @type {import('settings').Options} */ (Reflect.get(backend, '_options')).profiles[0].options.dictionaries).toEqual([{name: 'A', alias: 'changed A'}, {name: 'B', alias: 'b'}]);
    });

    test('duplicate identical rows allow an ordinary edit at the captured index', async () => {
        const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
        const row = {name: 'A', alias: 'same', enabled: true};
        const options = /** @type {import('settings').Options} */ (/** @type {unknown} */ ({profileCurrent: 0, profiles: [{id: 'profile-a', name: 'A', conditionGroups: [], options: {dictionaries: [structuredClone(row), structuredClone(row)], general: {mainDictionary: '', sortFrequencyDictionary: null}}}]}));
        Reflect.set(backend, '_options', options);
        Reflect.set(backend, '_optionsUtil', {createValidatingProxy: (/** @type {unknown} */ value) => value});
        Reflect.set(backend, '_profileConditionsSchemaCache', []);
        Reflect.set(backend, '_applyOptions', vi.fn());
        Reflect.set(backend, '_clearProfileConditionsSchemaCache', vi.fn());
        Reflect.set(backend, '_saveOptions', async (_source, nextOptions) => { Reflect.set(backend, '_options', nextOptions); });
        await backend._modifySettings([{action: 'setDictionaryField', profileId: 'profile-a', index: 1, expectedEntry: row, field: 'enabled', value: false, scope: 'profile', optionsContext: {index: 0}}], 'duplicate row');
        expect(/** @type {import('settings').Options} */ (Reflect.get(backend, '_options')).profiles[0].options.dictionaries).toEqual([row, {...row, enabled: false}]);
    });
});
