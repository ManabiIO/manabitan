/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {readFileSync} from 'node:fs';
import {expect, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';
import {log} from '../ext/js/core/log.js';
import {HtmlTemplateCollection} from '../ext/js/dom/html-template-collection.js';
import {AnkiController} from '../ext/js/pages/settings/anki-controller.js';
import {BackupController} from '../ext/js/pages/settings/backup-controller.js';
import {GenericSettingController} from '../ext/js/pages/settings/generic-setting-controller.js';
import {SettingsController} from '../ext/js/pages/settings/settings-controller.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest('./ext/templates-settings.html');
const modalHtml = readFileSync('./ext/templates-modals.html', 'utf8');

/** @returns {Promise<{controller: AnkiController, backend: Backend, settings: SettingsController, api: any, cleanup: () => void}>} */
async function createHarness() {
    vi.stubGlobal('chrome', {permissions: {}});
    const templates = new HtmlTemplateCollection();
    templates.load(document);
    const modalDocument = new DOMParser().parseFromString(modalHtml, 'text/html');
    const modalTemplate = /** @type {HTMLTemplateElement} */ (modalDocument.querySelector('#settings-modals-template'));
    document.body.innerHTML = `
        <div id="anki-error-message"></div>
        <div id="anki-error-message-details"></div>
        <div id="anki-error-message-details-container"></div>
        <button id="anki-error-message-details-toggle"></button>
        <div id="anki-error-invalid-response-info"></div>
        <select data-setting="anki.duplicateBehavior"><option value="prevent">Prevent</option></select>
        <div id="anki-overwrite-warning"></div>
        <input id="anki-api-key-input">
        <button id="anki-error-log"></button>
        <button data-modal-action="show,anki-cards"></button>
    `;
    for (const id of ['anki-cards', 'anki-card-format-remove', 'anki-add-card-format-maximum']) {
        const modal = /** @type {HTMLElement} */ (modalTemplate.content.querySelector(`#${id}-modal`));
        document.body.appendChild(document.importNode(modal, true));
    }
    const options = /** @type {import('settings').Options} */ (/** @type {unknown} */ ({
        profileCurrent: 0,
        profiles: ['profile-a', 'profile-b'].map((id) => ({
            id,
            name: id,
            conditionGroups: [],
            options: {
                anki: {
                    server: 'http://127.0.0.1:8765',
                    apiKey: '',
                    enable: false,
                    duplicateBehavior: 'prevent',
                    cardFormats: ['Words', 'Other'].map((name) => ({
                        name,
                        type: 'term',
                        icon: 'big-circle',
                        deck: 'Deck',
                        model: 'Basic',
                        fields: {Front: {value: '{expression}', overwriteMode: 'coalesce'}, Back: {value: '{glossary}', overwriteMode: 'coalesce'}},
                    })),
                },
                dictionaries: [],
                general: {language: 'ja'},
            },
        })),
    }));
    const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
    Reflect.set(backend, '_options', options);
    Reflect.set(backend, '_optionsUtil', {createValidatingProxy: (/** @type {unknown} */ value) => value, validate: vi.fn()});
    vi.spyOn(backend, '_saveOptions').mockImplementation(async (_source, value) => { Reflect.set(backend, '_options', value); });
    const api = {
        optionsGetFull: vi.fn(async () => structuredClone(Reflect.get(backend, '_options'))),
        optionsGet: vi.fn(async (/** @type {import('settings').OptionsContext2} */ context) => {
            const full = /** @type {import('settings').Options} */ (Reflect.get(backend, '_options'));
            return structuredClone(full.profiles.find(({id}) => id === context.profileId)?.options);
        }),
        getSettings: vi.fn(async (targets) => structuredClone(backend._onApiGetSettings({targets}, /** @type {chrome.runtime.MessageSender} */ ({})))),
        modifySettings: vi.fn(async (targets, source) => structuredClone(await backend._modifySettings(targets, source))),
        setAllSettings: vi.fn(async (value, source) => backend._onApiSetAllSettings({value, source}, /** @type {chrome.runtime.MessageSender} */ ({}))),
        getDictionaryInfo: vi.fn(async () => []),
    };
    const application = /** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({api, on: vi.fn()}));
    const settings = new SettingsController(application);
    Reflect.set(settings, '_templates', templates);
    vi.spyOn(templates, 'loadFromFiles').mockResolvedValue();
    await settings.prepare();

    const generic = new GenericSettingController(settings);
    await generic.prepare();
    const controller = new AnkiController(settings, application, /** @type {any} */ ({
        getModal: (/** @type {string} */ name) => {
            const node = /** @type {HTMLElement} */ (document.querySelector(`#${name}-modal`));
            return {node, setVisible: (/** @type {boolean} */ value) => { node.hidden = !value; }};
        },
    }));
    vi.spyOn(controller, 'getAnkiData').mockResolvedValue({deckNames: ['Deck', 'New Deck'], modelNames: ['Basic', 'New Model']});
    vi.spyOn(controller, 'getModelFieldNames').mockImplementation(async (model) => (model === 'New Model' ? ['Front', 'Back', 'Extra'] : ['Front', 'Back']));
    vi.spyOn(controller, 'getRequiredPermissions').mockReturnValue([]);
    const cleanup = () => {
        controller._selectorObserver.disconnect();
        generic._dataBinder.disconnect();
        generic._globalDataBinder.disconnect();
    };
    try {
        await controller.prepare();
        await generic.refresh();
        await vi.waitFor(() => {
            expect(/** @type {HTMLInputElement} */ (document.querySelector('.anki-card-name')).value).toBe('Words');
            expect(document.querySelectorAll('.anki-card-field-value')).toHaveLength(2);
        });
        return {controller, backend, settings, api, cleanup};
    } catch (error) {
        cleanup();
        throw error;
    }
}

/**
 * @param {Backend} backend
 * @returns {import('settings').AnkiCardFormat[]}
 */
function getCardFormats(backend) {
    return /** @type {import('settings').Options} */ (Reflect.get(backend, '_options')).profiles[0].options.anki.cardFormats;
}

for (const [setting, selector, value] of [
    ['name', '.anki-card-name', 'Renamed words'],
    ['field', '.anki-card-field-value', '{reading}'],
    ['deck', '.anki-card-deck', 'New Deck'],
    ['model', '.anki-card-model', 'New Model'],
    ['icon', '.anki-card-icon', 'big-diamond'],
]) {
    test(`a saved ${setting} edit can be followed by deleting that format without reopening settings`, async ({window}) => {
        const {controller, backend, api, cleanup} = await createHarness();
        try {
            const input = /** @type {HTMLInputElement|HTMLSelectElement} */ (document.querySelector(selector));
            input.value = value;
            input.dispatchEvent(new window.Event('input', {bubbles: true}));
            input.dispatchEvent(new window.Event('change', {bubbles: true}));
            await vi.waitFor(() => {
                const card = getCardFormats(backend)[0];
                expect(setting === 'field' ? card.fields.Front.value : Reflect.get(card, setting)).toBe(value);
            });
            const beforeDelete = structuredClone(getCardFormats(backend));
            api.modifySettings.mockClear();
            document.querySelector('.anki-card-delete-format-button')?.dispatchEvent(new window.MouseEvent('click', {bubbles: true}));
            expect(document.querySelector('#anki-card-format-remove-name')?.textContent).toBe(beforeDelete[0].name);
            document.querySelector('#anki-card-format-remove-confirm-button')?.dispatchEvent(new window.MouseEvent('click', {bubbles: true}));

            await vi.waitFor(() => { expect(getCardFormats(backend)).toEqual([beforeDelete[1]]); });
            expect(api.modifySettings).toHaveBeenCalledWith([
                expect.objectContaining({path: 'anki.cardFormats', expectedValue: beforeDelete, value: [beforeDelete[1]]}),
            ], expect.any(String));
            expect(controller._cardFormatIndex).toBe(0);
        } finally {
            cleanup();
        }
    });
}

test('changing a format to Kanji keeps its Kanji field menu after switching tabs', async ({window}) => {
    const {backend, cleanup} = await createHarness();
    try {
        const type = /** @type {HTMLSelectElement} */ (document.querySelector('.anki-card-type'));
        type.value = 'kanji';
        type.dispatchEvent(new window.Event('change', {bubbles: true}));
        await vi.waitFor(() => { expect(getCardFormats(backend)[0].type).toBe('kanji'); });

        for (const index of [1, 0]) {
            const tab = /** @type {HTMLInputElement} */ (document.querySelector(`#anki-cards-tabs input[data-card-format-index="${index}"]`));
            tab.checked = true;
            tab.dispatchEvent(new window.Event('change', {bubbles: true}));
            await vi.waitFor(() => {
                expect(/** @type {HTMLInputElement} */ (document.querySelector('.anki-card-name')).value).toBe(index === 0 ? 'Words' : 'Other');
            });
        }
        expect(/** @type {HTMLElement} */ (document.querySelector('#anki-card-primary')).dataset.ankiCardMenu).toBe('anki-card-kanji-field-menu');
        expect(/** @type {HTMLInputElement} */ (document.querySelector('#anki-cards-tabs input[data-card-format-index="0"]')).dataset.ankiCardMenu).toBe('anki-card-kanji-field-menu');
    } finally {
        cleanup();
    }
});

test('a rejected icon edit does not corrupt the deletion expectation', async ({window}) => {
    const {backend, api, cleanup} = await createHarness();
    try {
        const original = structuredClone(getCardFormats(backend));
        api.modifySettings.mockResolvedValueOnce([{error: {name: 'Error', message: 'storage unavailable', stack: ''}}]);
        const input = /** @type {HTMLSelectElement} */ (document.querySelector('.anki-card-icon'));
        input.value = 'big-diamond';
        input.dispatchEvent(new window.Event('change', {bubbles: true}));
        await vi.waitFor(() => { expect(api.modifySettings).toHaveBeenCalledOnce(); });
        expect(getCardFormats(backend)).toEqual(original);

        document.querySelector('.anki-card-delete-format-button')?.dispatchEvent(new window.MouseEvent('click', {bubbles: true}));
        document.querySelector('#anki-card-format-remove-confirm-button')?.dispatchEvent(new window.MouseEvent('click', {bubbles: true}));
        await vi.waitFor(() => { expect(getCardFormats(backend)).toEqual([original[1]]); });
    } finally {
        cleanup();
    }
});

test('an acknowledged edit still cannot authorize deleting a subsequently reordered format', async ({window}) => {
    const {backend, cleanup} = await createHarness();
    const logError = vi.spyOn(log, 'error').mockImplementation(() => {});
    try {
        const input = /** @type {HTMLInputElement} */ (document.querySelector('.anki-card-name'));
        input.value = 'Renamed words';
        input.dispatchEvent(new window.Event('change', {bubbles: true}));
        await vi.waitFor(() => { expect(getCardFormats(backend)[0].name).toBe('Renamed words'); });
        document.querySelector('.anki-card-delete-format-button')?.dispatchEvent(new window.MouseEvent('click', {bubbles: true}));

        // A second settings page replaces the order before this confirmation.
        getCardFormats(backend).reverse();
        const reordered = structuredClone(getCardFormats(backend));
        document.querySelector('#anki-card-format-remove-confirm-button')?.dispatchEvent(new window.MouseEvent('click', {bubbles: true}));
        await vi.waitFor(() => { expect(logError).toHaveBeenCalledOnce(); });
        expect(logError.mock.calls[0][0]).toMatchObject({message: 'Setting value changed before update'});
        expect(getCardFormats(backend)).toEqual(reordered);
    } finally {
        cleanup();
    }
});

test('a failed backup replacement leaves the existing card format editable', async ({window}) => {
    const {backend, settings, api, cleanup} = await createHarness();
    try {
        const original = structuredClone(await settings.getOptionsFull());
        const imported = structuredClone(original);
        imported.profiles[0].options.anki.cardFormats[0].deck = 'Imported deck';
        const failure = new Error('settings storage is full');
        vi.mocked(backend._saveOptions).mockRejectedValueOnce(failure);
        const backup = new BackupController(settings, null);

        await expect(backup._settingsImportSetOptionsFull(imported)).rejects.toBe(failure);
        expect(await settings.getOptionsFull()).toEqual(original);
        // Let the normal options subscribers finish rebuilding the displayed controls.
        await new Promise((resolve) => { window.setTimeout(resolve, 0); });
        api.modifySettings.mockClear();
        const deck = /** @type {HTMLSelectElement} */ (document.querySelector('.anki-card-deck'));
        deck.value = 'New Deck';
        deck.dispatchEvent(new window.Event('change', {bubbles: true}));

        await vi.waitFor(() => { expect(getCardFormats(backend)[0].deck).toBe('New Deck'); });
        expect(api.modifySettings).toHaveBeenCalledOnce();
        expect(settings.getOptionsContext().profileId).toBe('profile-a');
    } finally {
        cleanup();
    }
});
