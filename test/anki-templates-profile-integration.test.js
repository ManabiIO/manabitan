/*
 * Copyright (C) 2026  Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {readFileSync} from 'node:fs';
import {describe, expect, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';
import {JsonSchema} from '../ext/js/data/json-schema.js';
import {OptionsUtil} from '../ext/js/data/options-util.js';
import {AnkiTemplatesController} from '../ext/js/pages/settings/anki-templates-controller.js';
import {SettingsController} from '../ext/js/pages/settings/settings-controller.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();

/**
 * @param {() => void} [onResolve]
 * @returns {{promise: Promise<void>, resolve: () => void}}
 */
function deferred(onResolve = () => {}) {
    /** @type {() => void} */
    let resolve;
    /** @type {Promise<void>} */
    const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
    return {
        promise,
        resolve: () => {
            onResolve();
            resolve();
        },
    };
}

/**
 * Creates the shipped Anki settings UI with the real settings/backend pipeline.
 * @param {import('jsdom').DOMWindow} window
 * @param {boolean} [prepareController]
 * @returns {Promise<{backend: Backend, settings: SettingsController, settingsApi: typeof settingsApi, controller: AnkiTemplatesController, textarea: HTMLTextAreaElement, setValue: (value: string) => void, saveOptions: ReturnType<typeof vi.fn>}>}
 */
async function createHarness(window, prepareController = true) {
    const {document} = window;
    vi.stubGlobal('Node', window.Node);
    vi.stubGlobal('NodeFilter', window.NodeFilter);
    vi.stubGlobal('chrome', {runtime: {getURL: vi.fn((path) => path)}, permissions: {}});
    const modalDocument = new window.DOMParser().parseFromString(readFileSync(new URL('../ext/templates-modals.html', import.meta.url), 'utf8'), 'text/html');
    for (const template of modalDocument.querySelectorAll('template')) { document.body.appendChild(document.importNode(template.content, true)); }
    const settingsDocument = new window.DOMParser().parseFromString(readFileSync(new URL('../ext/settings.html', import.meta.url), 'utf8'), 'text/html');
    const opener = settingsDocument.querySelector('[data-modal-action="show,anki-card-templates"]');
    if (opener === null) { throw new Error('Shipped Anki templates opener missing'); }
    document.body.appendChild(document.importNode(opener, true));

    const optionsUtil = new OptionsUtil();
    const schema = JSON.parse(readFileSync(new URL('../ext/data/schemas/options-schema.json', import.meta.url), 'utf8'));
    Reflect.set(optionsUtil, '_optionsSchema', new JsonSchema(schema));
    const options = optionsUtil.getDefault();
    const defaultFieldTemplates = 'default templates';
    options.profiles[0].id = 'profile-a';
    const profileB = structuredClone(options.profiles[0]);
    profileB.id = 'profile-b';
    profileB.options.anki.fieldTemplates = 'profile B saved';
    options.profiles.push(profileB);
    options.profiles[0].options.anki.fieldTemplates = 'profile A saved';
    const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
    Reflect.set(backend, '_options', options);
    Reflect.set(backend, '_optionsUtil', optionsUtil);
    Reflect.set(backend, '_optionsMutationTail', null);
    Reflect.set(backend, '_profileConditionsSchemaCache', []);
    Reflect.set(backend, '_applyOptions', vi.fn());
    Reflect.set(backend, '_clearProfileConditionsSchemaCache', vi.fn());
    const saveOptions = vi.fn(async (_source, nextOptions) => { Reflect.set(backend, '_options', nextOptions); });
    Reflect.set(backend, '_saveOptions', saveOptions);
    const sender = /** @type {chrome.runtime.MessageSender} */ ({});
    const settingsApi = {
        optionsGetFull: vi.fn(async () => structuredClone(backend._onApiOptionsGetFull(undefined, sender))),
        optionsGet: vi.fn(async (optionsContext) => structuredClone(backend._onApiOptionsGet({optionsContext: structuredClone(optionsContext)}, sender))),
        modifySettings: vi.fn(async (targets, source) => structuredClone(await backend._onApiModifySettings({targets: structuredClone(targets), source}, sender))),
        getLanguageSummaries: vi.fn(async () => [{iso: 'ja', exampleText: 'sample'}]),
        getDefaultAnkiFieldTemplates: vi.fn(async () => defaultFieldTemplates),
        termsFind: vi.fn(async () => ({dictionaryEntries: []})),
    };
    const application = {on: vi.fn(), api: settingsApi};
    const settings = new SettingsController(/** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ (application)));
    Reflect.set(settings._templates, 'loadFromFiles', vi.fn());
    await settings.prepare();
    const resetNode = /** @type {HTMLElement} */ (document.querySelector('#anki-card-templates-reset-modal'));
    const modalController = {getModal: vi.fn(() => ({node: resetNode, setVisible: (/** @type {boolean} */ visible) => { resetNode.hidden = !visible; }}))};
    const controller = new AnkiTemplatesController(
        /** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ (application)),
        settings,
        /** @type {import('../ext/js/pages/settings/modal-controller.js').ModalController} */ (/** @type {unknown} */ (modalController)),
        /** @type {import('../ext/js/pages/settings/anki-controller.js').AnkiController} */ (/** @type {unknown} */ ({})),
    );
    vi.spyOn(controller, '_onValidateCompile').mockImplementation(() => {});
    if (prepareController) {
        await controller.prepare();
    }
    const textarea = /** @type {HTMLTextAreaElement} */ (document.querySelector('#anki-card-templates-textarea'));
    const setValue = (/** @type {string} */ value) => {
        textarea.value = value;
        textarea.dispatchEvent(new window.Event('change'));
    };
    return {backend, settings, settingsApi, controller, textarea, setValue, saveOptions};
}

describe('Anki template profile integration ownership', () => {
    test('does not acknowledge or retain a draft after its profile is deleted before backend dispatch', async ({window}) => {
        const h = await createHarness(window);
        const originalProfile = /** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options')).profiles[0];
        h.textarea.value = 'captured draft';
        const transportGate = deferred();
        h.settingsApi.modifySettings.mockImplementationOnce(async (targets, source) => {
            await transportGate.promise;
            return structuredClone(await h.backend._onApiModifySettings({targets: structuredClone(targets), source}, /** @type {chrome.runtime.MessageSender} */ ({})));
        });
        const pending = h.controller._onChanged(/** @type {Event} */ (/** @type {unknown} */ ({currentTarget: h.textarea})));
        const observed = pending.catch((error) => error);
        const actualOptions = /** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options'));
        actualOptions.profiles.splice(0, 1);
        await h.backend._saveOptions('external-profile-delete', actualOptions);
        transportGate.resolve();
        const failure = await observed;
        const response = await h.settingsApi.modifySettings.mock.results[0].value;
        expect(failure).toBeInstanceOf(Error);
        expect(response[0].error).toBeDefined();
        expect(h.textarea.value).toBe(originalProfile.options.anki.fieldTemplates);
        expect(h.textarea.dataset.value).toBe(originalProfile.options.anki.fieldTemplates);
        expect(/** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options')).profiles.some(({id}) => id === 'profile-a')).toBe(false);
    });

    test('a delayed failed profile A write cannot overwrite the fully selected profile B textarea', async ({window}) => {
        const h = await createHarness(window);
        const gate = deferred();
        h.settingsApi.modifySettings.mockImplementationOnce(async () => {
            await gate.promise;
            throw new Error('delayed transport failure');
        });
        h.textarea.value = 'A draft';
        const pending = h.controller._onChanged(/** @type {Event} */ (/** @type {unknown} */ ({currentTarget: h.textarea})));
        h.settings.setProfileSelection(1, 'profile-b');
        await vi.waitFor(() => expect(h.textarea.value).toBe('profile B saved'));
        gate.resolve();
        await expect(pending).rejects.toThrow('delayed transport failure');
        expect(h.textarea.value).toBe('profile B saved');
        expect(h.textarea.dataset.value).toBe('profile B saved');
    });

    test('a textarea change during a same-index profile identity switch cannot write into the new profile', async ({window}) => {
        const h = await createHarness(window);
        const bOptionsGate = deferred();
        const realOptionsGet = h.settingsApi.optionsGet.getMockImplementation();
        h.settingsApi.optionsGet.mockImplementation(async (optionsContext) => {
            if (optionsContext.profileId === 'profile-b') { await bOptionsGate.promise; }
            return /** @type {typeof h.settingsApi.optionsGet} */ (realOptionsGet)(optionsContext);
        });
        const fullOptions = /** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options'));
        fullOptions.profiles.splice(0, 1);
        Reflect.set(h.backend, '_options', fullOptions);
        h.settings.setProfileSelection(0, 'profile-b');
        h.textarea.value = 'stale A edit';
        h.textarea.dispatchEvent(new window.Event('change'));
        bOptionsGate.resolve();
        await vi.waitFor(() => expect(h.textarea.value).toBe('profile B saved'));
        expect(h.settingsApi.modifySettings).not.toHaveBeenCalled();
        expect(/** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options')).profiles.find(({id}) => id === 'profile-b')?.options.anki.fieldTemplates).toBe('profile B saved');
    });

    test('a failed newer edit restores the last acknowledged rapid edit', async ({window}) => {
        const h = await createHarness(window);
        const firstGate = deferred();
        const secondGate = deferred();
        const apply = h.settingsApi.modifySettings.getMockImplementation();
        if (typeof apply !== 'function') { throw new Error('Missing production transport'); }
        h.settingsApi.modifySettings
            .mockImplementationOnce(async (targets, source) => { await firstGate.promise; return await apply(targets, source); })
            .mockImplementationOnce(async () => { await secondGate.promise; throw new Error('second save failed'); });
        h.textarea.value = 'first acknowledged edit';
        const first = h.controller._onChanged(/** @type {Event} */ (/** @type {unknown} */ ({currentTarget: h.textarea})));
        h.textarea.value = 'second failed edit';
        const second = h.controller._onChanged(/** @type {Event} */ (/** @type {unknown} */ ({currentTarget: h.textarea}))).catch((error) => error);
        firstGate.resolve();
        await first;
        secondGate.resolve();
        expect(await second).toBeInstanceOf(Error);
        expect(h.textarea.value).toBe('first acknowledged edit');
        expect(h.textarea.dataset.value).toBe('first acknowledged edit');
        expect(/** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options')).profiles[0].options.anki.fieldTemplates).toBe('first acknowledged edit');
    });

    test('an older failed edit cannot replace a newer acknowledged edit', async ({window}) => {
        const h = await createHarness(window);
        const oldGate = deferred();
        h.settingsApi.modifySettings.mockImplementationOnce(async () => {
            await oldGate.promise;
            throw new Error('old save failed');
        });
        h.textarea.value = 'old failed edit';
        const old = h.controller._onChanged(/** @type {Event} */ (/** @type {unknown} */ ({currentTarget: h.textarea}))).catch((error) => error);
        h.textarea.value = 'new saved edit';
        await h.controller._onChanged(/** @type {Event} */ (/** @type {unknown} */ ({currentTarget: h.textarea})));
        oldGate.resolve();
        expect(await old).toBeInstanceOf(Error);
        expect(h.textarea.value).toBe('new saved edit');
        expect(h.textarea.dataset.value).toBe('new saved edit');
        expect(/** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options')).profiles[0].options.anki.fieldTemplates).toBe('new saved edit');
    });

    test('a late failed save preserves typing that has not dispatched another change', async ({window}) => {
        const h = await createHarness(window);
        const gate = deferred();
        h.settingsApi.modifySettings.mockImplementationOnce(async () => {
            await gate.promise;
            throw new Error('save failed');
        });
        h.textarea.value = 'submitted draft';
        const observed = h.controller._onChanged(/** @type {Event} */ (/** @type {unknown} */ ({currentTarget: h.textarea}))).catch((error) => error);
        h.textarea.value = 'newer unsent typing';
        gate.resolve();
        expect(await observed).toBeInstanceOf(Error);
        expect(h.textarea.value).toBe('newer unsent typing');
        expect(h.textarea.dataset.value).toBe('profile A saved');
        expect(/** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options')).profiles[0].options.anki.fieldTemplates).toBe('profile A saved');
    });


    test('an initial same-index profile read cannot replace newer rendered options', async ({window}) => {
        const h = await createHarness(window, false);
        const initialRead = deferred();
        const releaseInitial = deferred();
        const read = h.settingsApi.optionsGet.getMockImplementation();
        if (typeof read !== 'function') { throw new Error('Missing options transport'); }
        h.settingsApi.optionsGet.mockImplementationOnce(async (context) => {
            const options = await read(context);
            initialRead.resolve();
            await releaseInitial.promise;
            return options;
        });
        const preparing = h.controller.prepare();
        await initialRead.promise;
        const full = /** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options'));
        full.profiles.splice(0, 1);
        h.settings.setProfileSelection(0, 'profile-b');
        await vi.waitFor(() => expect(h.textarea.value).toBe('profile B saved'));
        releaseInitial.resolve();
        await preparing;
        expect(h.textarea.value).toBe('profile B saved');
        expect(h.textarea.dataset.value).toBe('profile B saved');
    });

    test('a reset opened in profile A cannot reset profile B', async ({window}) => {
        const h = await createHarness(window);
        const reset = /** @type {HTMLButtonElement} */ (window.document.querySelector('#anki-card-templates-reset-button'));
        const confirm = /** @type {HTMLButtonElement} */ (window.document.querySelector('#anki-card-templates-reset-button-confirm'));
        reset.click();
        h.settings.setProfileSelection(1, 'profile-b');
        await vi.waitFor(() => expect(h.textarea.value).toBe('profile B saved'));
        const changed = vi.spyOn(h.controller, '_onChanged');
        confirm.click();
        await Promise.allSettled(changed.mock.results.map((result) => result.value));
        expect(h.textarea.value).toBe('profile B saved');
        expect(h.settingsApi.modifySettings).not.toHaveBeenCalled();
        expect(/** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options')).profiles[1].options.anki.fieldTemplates).toBe('profile B saved');
    });


    test('a delayed example read cannot replace the current profile example', async ({window}) => {
        const h = await createHarness(window);
        const input = /** @type {HTMLInputElement} */ (window.document.querySelector('#anki-card-templates-test-text-input'));
        await vi.waitFor(() => expect(input.value).toBe('sample'));
        const entered = deferred();
        const release = deferred();
        const read = h.settingsApi.optionsGet.getMockImplementation();
        if (typeof read !== 'function') { throw new Error('Missing options transport'); }
        h.settingsApi.optionsGet.mockImplementationOnce(async (context) => {
            const options = await read(context);
            entered.resolve();
            await release.promise;
            return options;
        });
        const old = h.controller._updateExampleText();
        await entered.promise;
        const full = /** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options'));
        full.profiles[1].options.general.language = 'en';
        h.settingsApi.getLanguageSummaries.mockResolvedValue([{iso: 'ja', exampleText: 'Japanese sample'}, {iso: 'en', exampleText: 'English sample'}]);
        h.settings.setProfileSelection(1, 'profile-b');
        await vi.waitFor(() => expect(h.textarea.value).toBe('profile B saved'));
        await h.controller._updateExampleText();
        expect(input.value).toBe('English sample');
        release.resolve();
        await old;
        expect(input.value).toBe('English sample');
        expect(input.lang).toBe('en');
    });

    test('a pending example update preserves text typed by the user', async ({window}) => {
        const h = await createHarness(window);
        const input = /** @type {HTMLInputElement} */ (window.document.querySelector('#anki-card-templates-test-text-input'));
        await vi.waitFor(() => expect(input.value).toBe('sample'));
        const gate = deferred();
        h.settingsApi.getLanguageSummaries.mockImplementationOnce(async () => {
            await gate.promise;
            return [{iso: 'ja', exampleText: 'sample'}];
        });
        const updating = h.controller._updateExampleText();
        input.value = 'new user example';
        gate.resolve();
        await updating;
        expect(input.value).toBe('new user example');
    });


    test('the Render button cannot use profile A templates while profile B options are pending', async ({window}) => {
        const h = await createHarness(window);
        const entered = deferred();
        const release = deferred();
        const read = h.settingsApi.optionsGet.getMockImplementation();
        if (typeof read !== 'function') { throw new Error('Missing options transport'); }
        h.settingsApi.optionsGet.mockImplementationOnce(async (context) => {
            entered.resolve();
            await release.promise;
            return await read(context);
        });
        const termsFind = vi.spyOn(h.settingsApi, 'termsFind');
        const preparing = h.settings.setProfileSelection(1, 'profile-b');
        try {
            await entered.promise;
            const validation = vi.spyOn(h.controller, '_validate');
            const render = /** @type {HTMLButtonElement} */ (window.document.querySelector('#anki-card-templates-test-render-button'));
            render.click();
            await vi.waitFor(() => expect(validation).toHaveBeenCalled());
            await validation.mock.results[0].value;
            expect(termsFind).not.toHaveBeenCalled();
        } finally {
            release.resolve();
            await preparing;
        }
        await vi.waitFor(() => expect(h.textarea.value).toBe('profile B saved'));
        expect(termsFind).not.toHaveBeenCalled();
    });

    test('Test Render uses the visible template while its profile save is pending', async ({window}) => {
        const h = await createHarness(window);
        h.settingsApi.termsFind.mockResolvedValue(/** @type {any} */ ({dictionaryEntries: [{id: 'entry'}]}));
        const createNote = /** @type {any} */ (vi.fn(async () => ({note: {fields: {field: 'rendered'}}, errors: [], requirements: {}})));
        h.controller._ankiNoteBuilder.createNote = /** @type {any} */ (createNote);
        h.controller._ankiNoteBuilder.getDictionaryStylesMap = () => new Map();
        Reflect.set(h.settingsApi, 'getDictionaryInfo', vi.fn().mockResolvedValue([]));
        const entered = deferred();
        const release = deferred();
        const apply = h.settingsApi.modifySettings.getMockImplementation();
        if (typeof apply !== 'function') { throw new Error('Missing production transport'); }
        h.settingsApi.modifySettings.mockImplementationOnce(async (targets, source) => {
            entered.resolve();
            await release.promise;
            return await apply(targets, source);
        });
        h.textarea.value = 'pending visible templates';
        const saving = h.controller._onChanged(/** @type {Event} */ (/** @type {unknown} */ ({currentTarget: h.textarea})));
        try {
            await entered.promise;
            const result = /** @type {HTMLElement} */ (window.document.querySelector('#anki-card-templates-render-result'));
            const validation = vi.spyOn(h.controller, '_validate');
            /** @type {HTMLButtonElement} */ (window.document.querySelector('#anki-card-templates-test-render-button')).click();
            await vi.waitFor(() => expect(validation).toHaveBeenCalled());
            await validation.mock.results[0].value;
            expect(h.settingsApi.termsFind).toHaveBeenCalled();
            expect(createNote).toHaveBeenCalledTimes(1);
            expect(createNote.mock.calls[0]?.[0]?.template).toContain('pending visible templates');
            expect(result.textContent).toBe('rendered');
        } finally {
            release.resolve();
            await saving;
        }
    });
});
