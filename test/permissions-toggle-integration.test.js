/*
 * Copyright (C) 2026  Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {readFileSync} from 'node:fs';
import {expect, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';
import {JsonSchema} from '../ext/js/data/json-schema.js';
import {OptionsUtil} from '../ext/js/data/options-util.js';
import {GenericSettingController} from '../ext/js/pages/settings/generic-setting-controller.js';
import {PermissionsToggleController} from '../ext/js/pages/settings/permissions-toggle-controller.js';
import {SettingsController} from '../ext/js/pages/settings/settings-controller.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();

/** @returns {{promise: Promise<void>, resolve: () => void}} */
function deferred() {
    /** @type {(value?: void) => void} */
    let resolve;
    const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
    return {promise, resolve: () => { resolve(); }};
}

/**
 * @param {import('jsdom').DOMWindow} window
 * @param {boolean} [prepareController]
 * @returns {Promise<{backend: Backend, settings: SettingsController, settingsApi: {optionsGetFull: import('vitest').Mock, optionsGet: import('vitest').Mock, modifySettings: import('vitest').Mock, getSettings: import('vitest').Mock}, controller: PermissionsToggleController, generic: GenericSettingController, grant: import('vitest').Mock, dispose: () => void}>}
 */
async function createHarness(window, prepareController = true) {
    const {document} = window;
    const settingsDocument = new window.DOMParser().parseFromString(readFileSync(new URL('../ext/settings.html', import.meta.url), 'utf8'), 'text/html');
    const apiToggle = settingsDocument.querySelector('[data-permissions-setting="general.enableYomitanApi"]');
    if (apiToggle === null) { throw new Error('Missing real API toggle'); }
    document.body.innerHTML = '<div class="settings-item"></div><div id="yomitan-api-additional-options" hidden></div>';
    document.body.firstElementChild?.append(document.importNode(apiToggle, true));
    const grant = vi.fn();
    const permissions = {getAll: vi.fn((callback) => callback({permissions: []})), contains: vi.fn((_permissions, callback) => callback(false)), request: grant};
    vi.stubGlobal('Node', window.Node);
    vi.stubGlobal('NodeFilter', window.NodeFilter);
    vi.stubGlobal('chrome', {runtime: {getURL: vi.fn((path) => path)}, permissions});
    const optionsUtil = new OptionsUtil();
    Reflect.set(optionsUtil, '_optionsSchema', new JsonSchema(JSON.parse(readFileSync(new URL('../ext/data/schemas/options-schema.json', import.meta.url), 'utf8'))));
    const options = optionsUtil.getDefault();
    options.profiles[0].id = 'profile-a';
    const profileB = structuredClone(options.profiles[0]);
    profileB.id = 'profile-b';
    options.profiles.push(profileB);
    const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
    Reflect.set(backend, '_options', options);
    Reflect.set(backend, '_optionsUtil', optionsUtil);
    Reflect.set(backend, '_optionsMutationTail', null);
    Reflect.set(backend, '_profileConditionsSchemaCache', []);
    Reflect.set(backend, '_applyOptions', vi.fn());
    Reflect.set(backend, '_clearProfileConditionsSchemaCache', vi.fn());
    Reflect.set(backend, '_saveOptions', vi.fn(async (_source, nextOptions) => { Reflect.set(backend, '_options', nextOptions); }));
    const sender = /** @type {chrome.runtime.MessageSender} */ ({});
    const settingsApi = {
        optionsGetFull: vi.fn(async () => structuredClone(backend._onApiOptionsGetFull(undefined, sender))),
        optionsGet: vi.fn(async (context) => structuredClone(backend._onApiOptionsGet({optionsContext: structuredClone(context)}, sender))),
        modifySettings: vi.fn(async (targets, source) => structuredClone(await backend._onApiModifySettings({targets: structuredClone(targets), source}, sender))),
        getSettings: vi.fn(async (targets) => structuredClone(backend._onApiGetSettings({targets: structuredClone(targets)}, sender))),
    };
    const application = {on: vi.fn(), api: settingsApi};
    const settings = new SettingsController(/** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ (application)));
    Reflect.set(settings._templates, 'loadFromFiles', vi.fn(async () => {
        const source = new window.DOMParser().parseFromString(readFileSync(new URL('../ext/templates-settings.html', import.meta.url), 'utf8'), 'text/html');
        settings._templates.load(source);
    }));
    await settings.prepare();
    const generic = new GenericSettingController(settings);
    await generic.prepare();
    const controller = new PermissionsToggleController(settings);
    if (prepareController) {
        await controller.prepare();
        await generic.refresh();
    }
    return {backend, settings, settingsApi, controller, generic, grant, dispose: () => { Reflect.get(generic, '_dataBinder').disconnect(); }};
}

/**
 * @param {import('jsdom').DOMWindow} window
 * @returns {HTMLInputElement}
 */
function toggleOf(window) { return /** @type {HTMLInputElement} */ (window.document.querySelector('.permissions-toggle')); }

/**
 * @param {Backend} backend
 * @returns {import('settings').Options}
 */
function backendOptions(backend) {
    const options = Reflect.get(backend, '_options');
    if (options === null) { throw new Error('Missing harness options'); }
    return options;
}

test('generic binding cannot persist a permission setting before grant or duplicate the write', async ({window}) => {
    const h = await createHarness(window);
    /** @type {(value: boolean) => void} */
    /** @type {(value: boolean) => void} */
    let grant = (_value) => { throw new Error('Grant was not requested'); };
    h.grant.mockImplementation((_permissions, callback) => { grant = callback; });
    try {
        const toggle = toggleOf(window);
        toggle.checked = true;
        toggle.dispatchEvent(new window.Event('change'));
        expect(h.grant).toHaveBeenCalledOnce();
        await new Promise((resolve) => { window.setTimeout(resolve, 0); });
        expect(h.settingsApi.modifySettings).not.toHaveBeenCalled();
        grant(true);
        await vi.waitFor(() => expect(h.settingsApi.modifySettings).toHaveBeenCalledTimes(1));
        expect(backendOptions(h.backend).profiles[0].options.general.enableYomitanApi).toBe(true);
    } finally { h.dispose(); }
});

test('a grant resolving after same-index profile replacement cannot write or overwrite its toggle', async ({window}) => {
    const h = await createHarness(window);
    /** @type {(value: boolean) => void} */
    /** @type {(value: boolean) => void} */
    let grant = (_value) => { throw new Error('Grant was not requested'); };
    h.grant.mockImplementation((_permissions, callback) => { grant = callback; });
    const toggle = toggleOf(window);
    toggle.checked = true;
    const changing = h.controller._onPermissionsToggleChange(/** @type {Event} */ (/** @type {unknown} */ ({currentTarget: toggle})));
    try {
        backendOptions(h.backend).profiles.splice(0, 1);
        h.settings.setProfileSelection(0, 'profile-b');
        await vi.waitFor(() => expect(h.settings.getOptionsContext().profileId).toBe('profile-b'));
        await h.settings.refresh();
        grant(true);
        await changing;
        expect(h.settingsApi.modifySettings).not.toHaveBeenCalled();
        expect(toggle.checked).toBe(false);
        expect(backendOptions(h.backend).profiles[0].options.general.enableYomitanApi).toBe(false);
    } finally { h.dispose(); }
});

test('a rejected old save cannot roll back the replacement profile control', async ({window}) => {
    const h = await createHarness(window);
    const entered = deferred();
    const release = deferred();
    h.grant.mockImplementation((_permissions, callback) => callback(true));
    h.settingsApi.modifySettings.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return [{error: {name: 'Error', message: 'old save rejected'}}];
    });
    const toggle = toggleOf(window);
    toggle.checked = true;
    const changing = h.controller._onPermissionsToggleChange(/** @type {Event} */ (/** @type {unknown} */ ({currentTarget: toggle})));
    const rejected = expect(changing).rejects.toThrow('old save rejected');
    try {
        await entered.promise;
        const full = backendOptions(h.backend);
        full.profiles[1].options.general.enableYomitanApi = true;
        full.profiles.splice(0, 1);
        h.settings.setProfileSelection(0, 'profile-b');
        await h.settings.refresh();
        expect(toggle.checked).toBe(true);
        release.resolve();
        await rejected;
        expect(toggle.checked).toBe(true);
        expect(h.settingsApi.modifySettings.mock.calls[0][0][0]).toMatchObject({profileId: 'profile-a', optionsContext: {index: 0, profileId: 'profile-a'}});
    } finally { release.resolve(); h.dispose(); }
});


test('a click on the previous profile view cannot write while the next profile is loading', async ({window}) => {
    const h = await createHarness(window);
    const entered = deferred();
    const release = deferred();
    const originalRead = h.settingsApi.optionsGet.getMockImplementation();
    h.settingsApi.optionsGet.mockImplementationOnce(async (context) => {
        entered.resolve();
        await release.promise;
        return await originalRead?.(context);
    });
    h.grant.mockImplementation((_permissions, callback) => callback(true));
    try {
        h.settings.setProfileSelection(1, 'profile-b');
        await entered.promise;
        const toggle = toggleOf(window);
        toggle.checked = true;
        await h.controller._onPermissionsToggleChange(/** @type {Event} */ (/** @type {unknown} */ ({currentTarget: toggle})));
        expect(h.grant).not.toHaveBeenCalled();
        expect(h.settingsApi.modifySettings).not.toHaveBeenCalled();
        expect(backendOptions(h.backend).profiles[1].options.general.enableYomitanApi).toBe(false);
    } finally {
        release.resolve();
        await h.settings.refresh();
        h.dispose();
    }
});


test('a same-profile refresh invalidates a pending grant before its options read completes', async ({window}) => {
    const h = await createHarness(window);
    const entered = deferred();
    const release = deferred();
    /** @type {(value: boolean) => void} */
    let grant = (_value) => { throw new Error('Grant was not requested'); };
    h.grant.mockImplementation((_permissions, callback) => { grant = callback; });
    const toggle = toggleOf(window);
    toggle.checked = true;
    const changing = h.controller._onPermissionsToggleChange(/** @type {Event} */ (/** @type {unknown} */ ({currentTarget: toggle})));
    const originalRead = h.settingsApi.optionsGetFull.getMockImplementation();
    h.settingsApi.optionsGetFull.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return await originalRead?.();
    });
    const refresh = h.settings.refresh();
    try {
        await entered.promise;
        grant(true);
        await changing;
        expect(h.settingsApi.modifySettings).not.toHaveBeenCalled();
        expect(backendOptions(h.backend).profiles[0].options.general.enableYomitanApi).toBe(false);
    } finally {
        release.resolve();
        await refresh;
        h.dispose();
    }
});

test('an initial options read cannot publish a view after a newer refresh starts', async ({window}) => {
    const h = await createHarness(window, false);
    h.grant.mockImplementation((_permissions, callback) => callback(true));
    const entered = deferred();
    const release = deferred();
    const fullEntered = deferred();
    const fullRelease = deferred();
    const originalRead = h.settingsApi.optionsGet.getMockImplementation();
    h.settingsApi.optionsGet.mockImplementationOnce(async (context) => {
        const options = await originalRead?.(context);
        entered.resolve();
        await release.promise;
        return options;
    });
    const preparing = h.controller.prepare();
    await entered.promise;
    const originalFullRead = h.settingsApi.optionsGetFull.getMockImplementation();
    h.settingsApi.optionsGetFull.mockImplementationOnce(async () => {
        fullEntered.resolve();
        await fullRelease.promise;
        return await originalFullRead?.();
    });
    const refresh = h.settings.refresh();
    try {
        await fullEntered.promise;
        release.resolve();
        await preparing;
        const toggle = toggleOf(window);
        toggle.checked = true;
        await h.controller._onPermissionsToggleChange(/** @type {Event} */ (/** @type {unknown} */ ({currentTarget: toggle})));
        expect(h.grant).not.toHaveBeenCalled();
        expect(h.settingsApi.modifySettings).not.toHaveBeenCalled();
    } finally {
        release.resolve();
        fullRelease.resolve();
        await preparing;
        await refresh;
        h.dispose();
    }
});


test('permission control owns API visibility on initial load, pending grant, enable and disable', async ({window}) => {
    const h = await createHarness(window, false);
    const toggle = toggleOf(window);
    const additionalOptions = /** @type {HTMLElement} */ (window.document.querySelector('#yomitan-api-additional-options'));
    backendOptions(h.backend).profiles[0].options.general.enableYomitanApi = true;
    try {
        await h.controller.prepare();
        expect(additionalOptions.hidden).toBe(false);
        toggle.checked = false;
        await h.controller._onPermissionsToggleChange(/** @type {Event} */ (/** @type {unknown} */ ({currentTarget: toggle})));
        expect(additionalOptions.hidden).toBe(true);
        /** @type {(value: boolean) => void} */
        let grant = (_value) => { throw new Error('Grant was not requested'); };
        h.grant.mockImplementation((_permissions, callback) => { grant = callback; });
        toggle.checked = true;
        const changing = h.controller._onPermissionsToggleChange(/** @type {Event} */ (/** @type {unknown} */ ({currentTarget: toggle})));
        expect(additionalOptions.hidden).toBe(true);
        grant(true);
        await changing;
        expect(additionalOptions.hidden).toBe(false);
        expect(backendOptions(h.backend).profiles[0].options.general.enableYomitanApi).toBe(true);
    } finally { h.dispose(); }
});
