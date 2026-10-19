/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {readFileSync} from 'node:fs';
import {describe, expect, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';
import {JsonSchema} from '../ext/js/data/json-schema.js';
import {OptionsUtil} from '../ext/js/data/options-util.js';
import {DictionaryImportController} from '../ext/js/pages/settings/dictionary-import-controller.js';
import {GenericSettingController} from '../ext/js/pages/settings/generic-setting-controller.js';
import {SettingsController} from '../ext/js/pages/settings/settings-controller.js';
import {createDomTest} from './fixtures/dom-test.js';

const domTest = createDomTest();
const sender = /** @type {chrome.runtime.MessageSender} */ ({});

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function copy(value) { return structuredClone(value); }

describe('dictionary import keeps an open Anki field current', () => {
    domTest('a live bound field keeps the migrated marker when the user edits it', async ({window}) => {
        vi.stubGlobal('chrome', {permissions: {}});
        vi.stubGlobal('Node', window.Node);
        vi.stubGlobal('NodeFilter', window.NodeFilter);
        const {document} = window;
        document.body.innerHTML = '<input class="anki-card-field-value" data-setting="anki.cardFormats[0].fields.Live.value">';
        const input = /** @type {HTMLInputElement} */ (document.querySelector('.anki-card-field-value'));
        /** @type {Map<string, ((details: {source: string}) => void)[]>} */
        const callbacks = new Map();
        /** @type {GenericSettingController|null} */
        let generic = null;
        try {
            const optionsUtil = new OptionsUtil();
            const schema = JSON.parse(readFileSync(new URL('../ext/data/schemas/options-schema.json', import.meta.url), 'utf8'));
            Reflect.set(optionsUtil, '_optionsSchema', new JsonSchema(schema));
            const options = optionsUtil.getDefault();
            options.profiles[0].id = 'profile-live';
            options.profiles[0].name = 'Profile Live';
            options.profiles[0].options.dictionaries = [{
                name: 'DictionaryOld',
                alias: 'DictionaryOld',
                enabled: true,
                allowSecondarySearches: false,
                definitionsCollapsible: 'not-collapsible',
                partsOfSpeechFilter: true,
                useDeinflections: true,
                styles: '',
            }];
            options.profiles[0].options.anki.cardFormats[0].fields = {
                Live: {value: '{single-glossary-dictionaryold} literal outside', overwriteMode: 'overwrite'},
            };
            const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
            Reflect.set(backend, '_options', options);
            Reflect.set(backend, '_optionsUtil', optionsUtil);
            Reflect.set(backend, '_optionsMutationTail', null);
            Reflect.set(backend, '_profileConditionsSchemaCache', []);
            Reflect.set(backend, '_dictionaryDatabase', {isPrepared: () => true, getDictionaryInfo: async () => []});
            Reflect.set(backend, '_applyOptions', vi.fn());
            Reflect.set(backend, '_clearProfileConditionsSchemaCache', vi.fn());
            Reflect.set(backend, '_saveOptions', async (/** @type {string} */ source, /** @type {import('settings').Options} */ nextOptions) => {
                Reflect.set(backend, '_options', copy(nextOptions));
                for (const callback of callbacks.get('optionsUpdated') ?? []) { callback({source}); }
            });
            const application = {
                on: (/** @type {string} */ event, /** @type {(details: {source: string}) => void} */ callback) => {
                    const handlers = callbacks.get(event) ?? [];
                    handlers.push(callback);
                    callbacks.set(event, handlers);
                },
                api: {
                    optionsGetFull: async () => copy(await backend._onApiOptionsGetFull(undefined, sender)),
                    optionsGet: async (/** @type {import('settings').OptionsContext} */ optionsContext) => copy(await backend._onApiOptionsGet({optionsContext: copy(optionsContext)}, sender)),
                    getSettings: async (/** @type {import('settings-modifications').ScopedRead[]} */ targets) => copy(await backend._onApiGetSettings({targets: copy(targets)}, sender)),
                    modifySettings: async (/** @type {import('settings-modifications').ScopedModification[]} */ targets, /** @type {string} */ source) => copy(await backend._onApiModifySettings({targets: copy(targets), source}, sender)),
                    setAllSettings: async (/** @type {import('settings').Options} */ value, /** @type {string} */ source) => copy(await backend._onApiSetAllSettings({value: copy(value), source}, sender)),
                    triggerDatabaseUpdated: async () => {},
                },
            };
            const settings = new SettingsController(/** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ (application)));
            Reflect.set(settings, '_templates', {loadFromFiles: async () => {}});
            await settings.prepare();
            generic = new GenericSettingController(settings);
            await generic.prepare();
            await generic.refresh();
            expect(input.value).toBe('{single-glossary-dictionaryold} literal outside');

            const importer = /** @type {DictionaryImportController} */ (/** @type {unknown} */ (Object.create(DictionaryImportController.prototype)));
            Reflect.set(importer, '_settingsController', settings);
            Reflect.set(importer, '_activeImportRunGeneration', 1);
            Reflect.set(importer, '_recordImportDebugSnapshot', vi.fn());
            Reflect.set(importer, '_verifyImportedDictionaryVisible', vi.fn(async () => {}));
            const result = await importer._finalizeImportedDictionaryResult({
                dictionaryTitle: 'DictionaryOld',
                importStartTime: 1,
                importDetails: {},
                importResult: {
                    result: {title: 'DictionaryNew', revision: 'test', sequenced: false, version: 3, importDate: 1, prefixWildcardsSupported: true, styles: ''},
                    errors: [],
                    debug: {phaseTimings: []},
                },
                workerImportStartTime: 1,
                workerImportEndTime: 2,
                useImportSession: false,
                finalizeImportSession: true,
                importRunGeneration: 1,
                profilesDictionarySettings: {'profile-live': [{...options.profiles[0].options.dictionaries[0], index: 0}]},
                localPhaseTimings: [],
                notifyDatabaseUpdated: true,
                showErrors: false,
            });
            expect(result).toEqual({errors: [], importedTitle: 'DictionaryNew'});
            const storedField = () => /** @type {import('settings').Options} */ (Reflect.get(backend, '_options')).profiles[0].options.anki.cardFormats[0].fields.Live.value;
            expect(storedField()).toBe('{single-glossary-dictionarynew} literal outside');

            // Let the ordinary optionsChanged/binder response settle, without
            // forcing a refresh which would conceal the regression.
            await new Promise((resolve) => { setTimeout(resolve, 0); });
            input.value += ' edited';
            input.dispatchEvent(new window.Event('change', {bubbles: true}));
            await vi.waitFor(() => expect(storedField()).toBe('{single-glossary-dictionarynew} literal outside edited'));
            expect(input.value).toBe('{single-glossary-dictionarynew} literal outside edited');
        } finally {
            generic?._dataBinder.disconnect();
            callbacks.clear();
            vi.restoreAllMocks();
            vi.unstubAllGlobals();
        }
    });
});
