/*
 * Copyright (C) 2026  Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {readFileSync} from 'node:fs';
import {vi} from 'vitest';
import {Backend} from '../../ext/js/background/backend.js';
import {JsonSchema} from '../../ext/js/data/json-schema.js';
import {OptionsUtil} from '../../ext/js/data/options-util.js';
import {HtmlTemplateCollection} from '../../ext/js/dom/html-template-collection.js';
import {DictionaryController} from '../../ext/js/pages/settings/dictionary-controller.js';
import {SettingsController} from '../../ext/js/pages/settings/settings-controller.js';
import {GenericSettingController} from '../../ext/js/pages/settings/generic-setting-controller.js';
import {SecondarySearchDictionaryController} from '../../ext/js/pages/settings/secondary-search-dictionary-controller.js';
import {CollapsibleDictionaryController} from '../../ext/js/pages/settings/collapsible-dictionary-controller.js';

/**
 * @param {string} name
 * @param {Partial<import('settings').DictionaryOptions>} [overrides]
 * @returns {import('settings').DictionaryOptions}
 */
export function dictionaryRow(name, overrides = {}) {
    return {name, alias: name, enabled: true, allowSecondarySearches: false, definitionsCollapsible: 'not-collapsible', partsOfSpeechFilter: true, useDeinflections: true, ...overrides};
}

/**
 * Use shipped renderers and the real validating proxy; stub storage and transport.
 * Each API request and response crosses a structured-clone boundary.
 * @param {import('jsdom').DOMWindow} window
 * @param {import('settings').DictionaryOptions[]} rows
 * @returns {Promise<{
 *   backend: Backend,
 *   settings: SettingsController,
 *   dictionary: DictionaryController,
 *   secondary: SecondarySearchDictionaryController,
 *   collapsible: CollapsibleDictionaryController,
 *   generic: GenericSettingController,
 *   application: object,
 *   modifySettings: ReturnType<typeof vi.fn>,
 *   readOptions: (optionsContext: import('settings').OptionsContext) => Promise<import('settings').ProfileOptions>,
 *   modals: Map<string, {node: HTMLElement; setVisible: (visible: boolean) => void}>,
 *   getRows: () => import('settings').DictionaryOptions[],
 *   cleanup: () => void
 * }>}
 */
export async function createDictionarySettingsHarness(window, rows) {
    vi.stubGlobal('chrome', {permissions: {}});
    vi.stubGlobal('Node', window.Node);
    vi.stubGlobal('NodeFilter', window.NodeFilter);
    const {document} = window;
    document.body.textContent = '';
    const modalDocument = new window.DOMParser().parseFromString(readFileSync(new URL('../../ext/templates-modals.html', import.meta.url), 'utf8'), 'text/html');
    for (const template of modalDocument.querySelectorAll('template')) { document.body.appendChild(document.importNode(template.content, true)); }
    const templateDocument = new window.DOMParser().parseFromString(readFileSync(new URL('../../ext/templates-settings.html', import.meta.url), 'utf8'), 'text/html');
    const templates = new HtmlTemplateCollection();
    templates.load(templateDocument);
    const optionsUtil = new OptionsUtil();
    const schema = JSON.parse(readFileSync(new URL('../../ext/data/schemas/options-schema.json', import.meta.url), 'utf8'));
    Reflect.set(optionsUtil, '_optionsSchema', new JsonSchema(schema));
    const options = optionsUtil.getDefault();
    options.profiles[0].id = 'profile-a';
    options.profiles[0].options.dictionaries = structuredClone(rows);
    const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
    Reflect.set(backend, '_options', options);
    Reflect.set(backend, '_optionsUtil', optionsUtil);
    Reflect.set(backend, '_profileConditionsSchemaCache', []);
    Reflect.set(backend, '_applyOptions', vi.fn());
    Reflect.set(backend, '_clearProfileConditionsSchemaCache', vi.fn());
    Reflect.set(backend, '_saveOptions', async (_source, nextOptions) => { Reflect.set(backend, '_options', nextOptions); });
    const sender = /** @type {chrome.runtime.MessageSender} */ ({});
    const readOptions = async (/** @type {import('settings').OptionsContext} */ optionsContext) => structuredClone(await backend._onApiOptionsGet({optionsContext: structuredClone(optionsContext)}, sender));
    const modifySettings = vi.fn(async (/** @type {import('settings-modifications').ScopedModification[]} */ targets, /** @type {string} */ source) => structuredClone(await backend._onApiModifySettings({targets: structuredClone(targets), source}, sender)));
    const application = {
        on: vi.fn(),
        api: {
            optionsGetFull: async () => structuredClone(await backend._onApiOptionsGetFull(undefined, sender)),
            optionsGet: readOptions,
            getSettings: async (/** @type {import('settings-modifications').ScopedRead[]} */ targets) => structuredClone(await backend._onApiGetSettings({targets: structuredClone(targets)}, sender)),
            modifySettings,
        },
    };
    const settings = new SettingsController(/** @type {import('../../ext/js/application.js').Application} */ (/** @type {unknown} */ (application)));
    Reflect.set(templates, 'loadFromFiles', vi.fn());
    Reflect.set(settings, '_templates', templates);
    await settings.prepare();
    const installed = [...new Set(rows.map(({name}) => name))].map((title) => /** @type {import('dictionary-importer').Summary} */ (/** @type {unknown} */ ({
        title,
        revision: '1',
        version: 3,
        importSuccess: true,
        sequenced: true,
        prefixWildcardsSupported: true,
        counts: {terms: {total: 1}, kanji: {total: 0}, termMeta: {total: 0}, kanjiMeta: {total: 0}},
    })));
    const modals = new Map(['dictionary-set-alias', 'dictionary-move-location', 'dictionary-details'].map((name) => {
        const node = /** @type {HTMLElement} */ (document.querySelector('#' + name + '-modal'));
        return [name, {node, setVisible: (/** @type {boolean} */ visible) => { node.hidden = !visible; }}];
    }));
    const dictionary = /** @type {DictionaryController} */ (Object.create(DictionaryController.prototype));
    Reflect.set(dictionary, '_settingsController', settings);
    Reflect.set(dictionary, '_dictionaryEntries', []);
    Reflect.set(dictionary, '_dictionaryTaskQueue', []);
    Reflect.set(dictionary, '_dictionaryEntryContainer', document.querySelector('#dictionary-list'));
    Reflect.set(dictionary, '_dictionaryModalBody', {scrollTop: 0, scroll: vi.fn()});
    Reflect.set(dictionary, '_modalController', {getModal: (/** @type {string} */ name) => modals.get(name) ?? null});
    Reflect.set(dictionary, '_dictionaries', installed);
    Reflect.set(dictionary, '_updateDictionariesEnabledWarnings', vi.fn());
    dictionary._updateCurrentEntries(await settings.getOptions());
    const secondary = new SecondarySearchDictionaryController(settings);
    const collapsible = new CollapsibleDictionaryController(settings);
    for (const controller of [secondary, collapsible]) {
        Reflect.set(controller, '_dictionaryInfoMap', new Map(installed.map((entry) => [entry.title, entry])));
        controller._onOptionsChanged({options: await settings.getOptions(), optionsContext: settings.getOptionsContext()});
    }
    const generic = new GenericSettingController(settings);
    await generic.prepare();
    await generic.refresh();
    return {
        backend,
        settings,
        dictionary,
        secondary,
        collapsible,
        generic,
        application,
        modifySettings,
        readOptions,
        modals,
        getRows: () => structuredClone(/** @type {import('settings').Options} */ (Reflect.get(backend, '_options')).profiles[0].options.dictionaries),
        cleanup: () => {
            generic._dataBinder.disconnect();
            for (const entry of dictionary._dictionaryEntries) { entry.cleanup(); }
            secondary._eventListeners.removeAllEventListeners();
            collapsible._eventListeners.removeAllEventListeners();
        },
    };
}
