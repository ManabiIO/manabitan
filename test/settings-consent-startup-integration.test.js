/*
 * Copyright (C) 2026  Yomitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {readFile} from 'node:fs/promises';
import {describe, expect, vi} from 'vitest';
import {createDomTest} from './fixtures/dom-test.js';

const state = vi.hoisted(() => ({
    values: /** @type {Record<string, unknown>} */ ({}),
    writes: /** @type {Array<Array<{path: string, value: unknown}>>} */ ([]),
    failNextWrite: false,
}));

class StubController {
    constructor() {}
    prepare() {}
    async prepareAsync() {}
    async refresh() {}
    on() {}
}

vi.mock('../ext/js/application.js', () => ({
    Application: {
        main: /** @type {(isSettings: boolean, callback: (application: {api: Record<string, never>}) => Promise<void>) => Promise<void>} */ (async (_isSettings, callback) => callback({api: {}})),
    },
}));
vi.mock('../ext/js/core/diagnostics-reporter.js', () => ({reportDiagnostics: () => {}}));
vi.mock('../ext/js/core/safe-performance.js', () => ({safePerformance: {now: () => 0}}));
vi.mock('../ext/js/dom/document-focus-controller.js', () => ({DocumentFocusController: class extends StubController {}}));
vi.mock('../ext/js/dom/query-selector.js', () => ({querySelectorNotNull: /** @type {(root: ParentNode, selector: string) => Element} */ ((root, selector) => {
    const node = root.querySelector(selector);
    if (node === null) { throw new Error(`Missing test node: ${selector}`); }
    return node;
})}));
vi.mock('../ext/js/pages/common/extension-content-controller.js', () => ({ExtensionContentController: class extends StubController {}}));

vi.mock('../ext/js/pages/settings/anki-controller.js', () => ({AnkiController: class extends StubController {}}));
vi.mock('../ext/js/pages/settings/anki-deck-generator-controller.js', () => ({AnkiDeckGeneratorController: class extends StubController {}}));
vi.mock('../ext/js/pages/settings/anki-templates-controller.js', () => ({AnkiTemplatesController: class extends StubController {}}));
vi.mock('../ext/js/pages/settings/audio-controller.js', () => ({AudioController: class extends StubController {}}));
vi.mock('../ext/js/pages/settings/backup-controller.js', () => ({BackupController: class extends StubController {}}));
vi.mock('../ext/js/pages/settings/collapsible-dictionary-controller.js', () => ({CollapsibleDictionaryController: class extends StubController {}}));
vi.mock('../ext/js/pages/settings/dictionary-controller.js', () => ({DictionaryController: class extends StubController {}}));
vi.mock('../ext/js/pages/settings/dictionary-import-controller.js', () => ({DictionaryImportController: class extends StubController {}}));
vi.mock('../ext/js/pages/settings/extension-keyboard-shortcuts-controller.js', () => ({ExtensionKeyboardShortcutController: class extends StubController {}}));
vi.mock('../ext/js/pages/settings/generic-setting-controller.js', () => ({GenericSettingController: class extends StubController {}}));
vi.mock('../ext/js/pages/settings/keyboard-shortcuts-controller.js', () => ({KeyboardShortcutController: class extends StubController {}}));
vi.mock('../ext/js/pages/settings/languages-controller.js', () => ({LanguagesController: class extends StubController {}}));
vi.mock('../ext/js/pages/settings/mecab-controller.js', () => ({MecabController: class extends StubController {}}));
vi.mock('../ext/js/pages/settings/modal-controller.js', () => ({ModalController: class {
    constructor() { this._modal = null; }
    async prepare() {
        const node = document.querySelector('#firefox-data-transmission-consent-modal');
        this._modal = node === null ? null : {setVisible: /** @param {boolean} visible */ (visible) => { /** @type {HTMLElement} */ (node).hidden = !visible; }};
    }

    getModal(/** @type {string} */ name) { return name === 'firefox-data-transmission-consent' ? this._modal : null; }
}}));
vi.mock('../ext/js/pages/settings/nested-popups-controller.js', () => ({NestedPopupsController: class extends StubController {}}));
vi.mock('../ext/js/pages/settings/permissions-toggle-controller.js', () => ({PermissionsToggleController: class extends StubController {}}));
vi.mock('../ext/js/pages/settings/persistent-storage-controller.js', () => ({PersistentStorageController: class extends StubController {}}));
vi.mock('../ext/js/pages/settings/popup-frequency-blur-controller.js', () => ({PopupFrequencyBlurController: class extends StubController {}}));
vi.mock('../ext/js/pages/settings/popup-preview-controller.js', () => ({PopupPreviewController: class extends StubController {}}));
vi.mock('../ext/js/pages/settings/popup-window-controller.js', () => ({PopupWindowController: class extends StubController {}}));
vi.mock('../ext/js/pages/settings/profile-controller.js', () => ({ProfileController: class extends StubController {}}));
vi.mock('../ext/js/pages/settings/recommended-settings-controller.js', () => ({RecommendedSettingsController: class extends StubController {}}));
vi.mock('../ext/js/pages/settings/scan-inputs-controller.js', () => ({ScanInputsController: class extends StubController {}}));
vi.mock('../ext/js/pages/settings/scan-inputs-simple-controller.js', () => ({ScanInputsSimpleController: class extends StubController {}}));
vi.mock('../ext/js/pages/settings/secondary-search-dictionary-controller.js', () => ({SecondarySearchDictionaryController: class extends StubController {}}));
vi.mock('../ext/js/pages/settings/sentence-termination-characters-controller.js', () => ({SentenceTerminationCharactersController: class extends StubController {}}));
vi.mock('../ext/js/pages/settings/settings-controller.js', () => ({SettingsController: class extends StubController {
    async prepare() {}
    getOptionsContext() { return {}; }
    async modifySettings(/** @type {Array<{path: string, value: unknown}>} */ targets) {
        state.writes.push(targets);
        if (state.failNextWrite) {
            state.failNextWrite = false;
            return targets.map((_, index) => {
                if (index === 0) { return {error: {name: 'Error', message: 'synthetic save failure', stack: ''}}; }
                return {result: null};
            });
        }
        for (const target of targets) { state.values[target.path] = target.value; }
        return targets.map(() => ({result: null}));
    }
}}));
vi.mock('../ext/js/pages/settings/settings-display-controller.js', () => ({SettingsDisplayController: class extends StubController {}}));
vi.mock('../ext/js/pages/settings/sort-frequency-dictionary-controller.js', () => ({SortFrequencyDictionaryController: class extends StubController {}}));
vi.mock('../ext/js/pages/settings/status-footer.js', () => ({StatusFooter: class extends StubController {}}));
vi.mock('../ext/js/pages/settings/storage-controller.js', () => ({StorageController: class extends StubController {}}));
vi.mock('../ext/js/pages/settings/translation-text-replacements-controller.js', () => ({TranslationTextReplacementsController: class extends StubController {}}));
vi.mock('../ext/js/pages/settings/yomitan-api-controller.js', () => ({YomitanApiController: class extends StubController {}}));

const test = createDomTest();

describe('Settings page consent startup wiring', () => {
    test('settings startup installs consent actions that persist acceptance and decline', async ({window}) => {
        vi.resetModules();
        state.values = {};
        state.writes = [];
        state.failNextWrite = false;
        window.document.body.innerHTML = '<div class="status-footer-container"></div>';
        const modalHtml = await readFile(new URL('../ext/templates-modals.html', import.meta.url), 'utf8');
        const container = window.document.createElement('div');
        // eslint-disable-next-line no-unsanitized/property -- Parse the trusted shipped settings modal template.
        container.innerHTML = modalHtml;
        const template = container.querySelector('#settings-modals-template');
        if (!(template instanceof window.HTMLTemplateElement)) { throw new Error('Missing shipped settings modal template'); }
        window.document.body.appendChild(template.content.cloneNode(true));
        window.history.replaceState({}, '', '/settings.html');
        await import('../ext/js/pages/settings/settings-main.js');

        const accept = /** @type {HTMLButtonElement} */ (window.document.querySelector('#accept-data-transmission'));
        const decline = /** @type {HTMLButtonElement} */ (window.document.querySelector('#decline-data-transmission'));
        const modal = /** @type {HTMLElement} */ (window.document.querySelector('#firefox-data-transmission-consent-modal'));
        expect(accept).not.toBeNull();
        expect(modal.hidden).toBe(true);

        modal.hidden = false;
        accept.click();
        await vi.waitFor(() => expect(modal.hidden).toBe(true));
        expect(state.values['global.dataTransmissionConsentState']).toBe('accepted');
        expect(state.values['audio.enabled']).toBe(true);

        modal.hidden = false;
        decline.click();
        await vi.waitFor(() => expect(modal.hidden).toBe(true));
        expect(state.values['global.dataTransmissionConsentState']).toBe('declined');
        expect(state.values['audio.enabled']).toBe(false);
        expect(state.writes).toHaveLength(4);

        modal.hidden = false;
        state.failNextWrite = true;
        accept.click();
        await vi.waitFor(() => expect(/** @type {HTMLElement} */ (window.document.querySelector('#data-transmission-consent-save-error')).hidden).toBe(false));
        expect(modal.hidden).toBe(false);
        expect(state.values['global.dataTransmissionConsentState']).toBe('declined');
        expect(state.values['audio.enabled']).toBe(false);

        const writeCount = state.writes.length;
        accept.click();
        accept.click();
        await vi.waitFor(() => expect(modal.hidden).toBe(true));
        expect(state.writes).toHaveLength(writeCount + 2);
        expect(state.values['global.dataTransmissionConsentState']).toBe('accepted');
        expect(state.values['audio.enabled']).toBe(true);
    });
});
