/* SPDX-License-Identifier: GPL-3.0-or-later */
import {afterEach, expect, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';
import {SettingsController} from '../ext/js/pages/settings/settings-controller.js';
import {GenericSettingController} from '../ext/js/pages/settings/generic-setting-controller.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/** @returns {PromiseWithResolvers<void>} */
function deferred() {
    return /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
}

/**
 * @param {import('jsdom').DOMWindow} window
 * @returns {Promise<{api: {optionsGetFull: () => Promise<import('settings').Options>, optionsGet: (optionsContext: import('settings').OptionsContext) => Promise<import('settings').ProfileOptions>, getSettings: (targets: import('settings-modifications').ScopedRead[]) => Promise<import('settings-controller').ModifyResult[]>, modifySettings: (targets: import('settings-modifications').ScopedModification[], source: string) => Promise<import('settings-controller').ModifyResult[]>}, settings: SettingsController, generic: GenericSettingController, profile: HTMLInputElement, global: HTMLInputElement, options: () => import('settings').Options, close: () => void}>}
 */
async function fixture(window) {
    vi.stubGlobal('chrome', {permissions: {}});
    vi.stubGlobal('Node', window.Node);
    window.document.body.innerHTML = '<input id="profile" data-setting="general.showAdvanced" type="checkbox"><input id="global" data-setting="global.dataTransmissionConsentShown" data-scope="global" type="checkbox">';
    const profile = /** @type {HTMLInputElement} */ (window.document.querySelector('#profile'));
    profile.dataset.transform = JSON.stringify([{type: 'setAttribute', selector: ':root', attribute: 'data-advanced'}]);
    const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
    for (const [key, value] of Object.entries({
        _options: {profileCurrent: 0,
            global: {dataTransmissionConsentShown: false},
            profiles: [
                {id: 'a', name: 'A', conditionGroups: [], options: {general: {showAdvanced: false}}},
                {id: 'b', name: 'B', conditionGroups: [], options: {general: {showAdvanced: false}}},
            ]},
        _optionsUtil: {createValidatingProxy: (/** @type {unknown} */ value) => value},
        _profileConditionsSchemaCache: [],
        _applyOptions: vi.fn(),
        _clearProfileConditionsSchemaCache: vi.fn(),
    })) { Reflect.set(backend, key, value); }
    Reflect.set(backend, '_saveOptions', async (_source, value) => { Reflect.set(backend, '_options', value); });
    const sender = {};
    const api = {
        optionsGetFull: async () => structuredClone(await backend._onApiOptionsGetFull(void 0, sender)),
        optionsGet: async (/** @type {import('settings').OptionsContext} */ optionsContext) => structuredClone(await backend._onApiOptionsGet({optionsContext}, sender)),
        getSettings: async (/** @type {import('settings-modifications').ScopedRead[]} */ targets) => structuredClone(await backend._onApiGetSettings({targets}, sender)),
        modifySettings: async (/** @type {import('settings-modifications').ScopedModification[]} */ targets, /** @type {string} */ source) => structuredClone(await backend._onApiModifySettings({targets, source}, sender)),
    };
    const settings = new SettingsController(/** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({on: vi.fn(), api})));
    Reflect.set(settings, '_templates', {loadFromFiles: vi.fn()});
    Reflect.set(settings, '_source', 'generic-view-regression');
    await settings.prepare();
    const generic = new GenericSettingController(settings);
    await generic.prepare();
    await generic.refresh();
    return {
        api,
        settings,
        generic,
        profile,
        global: /** @type {HTMLInputElement} */ (window.document.querySelector('#global')),
        options: () => /** @type {import('settings').Options} */ (Reflect.get(backend, '_options')),
        close: () => { generic._dataBinder.disconnect(); generic._globalDataBinder.disconnect(); },
    };
}

/**
 * @param {SettingsController} settings
 * @returns {Promise<void>}
 */
function switchToB(settings) {
    const ready = deferred();
    settings.on('optionsChanged', ({optionsContext}) => {
        if ('profileId' in optionsContext && optionsContext.profileId === 'b') { ready.resolve(); }
    });
    settings.profileIndex = 1;
    return ready.promise;
}

test('a pending global save keeps its displayed value across a ready profile switch', async ({window}) => {
    const h = await fixture(window);
    const started = deferred();
    const release = deferred();
    const original = h.api.modifySettings;
    h.api.modifySettings = async (...args) => {
        started.resolve();
        await release.promise;
        return await original(...args);
    };
    h.global.checked = true;
    h.global.dispatchEvent(new window.Event('change'));
    const write = h.generic._globalDataBinder._assignTasks._deferPromise;
    try {
        await started.promise;
        await switchToB(h.settings);
        await h.generic.refresh();
        const displayedWhilePending = h.global.checked;
        release.resolve();
        await write;
        expect(h.options().global.dataTransmissionConsentShown).toBe(true);
        expect(displayedWhilePending).toBe(true);
        expect(h.global.checked).toBe(true);
    } finally {
        release.resolve();
        await write;
        h.close();
    }
});

test('a queued old-profile edit preserves its value without applying UI transforms to the new view', async ({window}) => {
    const h = await fixture(window);
    const firstStarted = deferred();
    const secondStarted = deferred();
    const firstRelease = deferred();
    const secondRelease = deferred();
    const original = h.api.modifySettings;
    let writes = 0;
    h.api.modifySettings = async (...args) => {
        if (++writes === 1) {
            firstStarted.resolve();
            await firstRelease.promise;
        } else {
            secondStarted.resolve();
            await secondRelease.promise;
        }
        return await original(...args);
    };
    const binder = h.generic._dataBinder;
    h.profile.checked = false;
    h.profile.dispatchEvent(new window.Event('change'));
    const first = binder._assignTasks._deferPromise;
    await firstStarted.promise;
    h.profile.checked = true;
    h.profile.dispatchEvent(new window.Event('change'));
    const queued = binder._assignTasks._deferPromise;
    try {
        await switchToB(h.settings);
        await h.generic.refresh();
        expect(window.document.documentElement.dataset.advanced).toBe('false');
        firstRelease.resolve();
        await secondStarted.promise;
        const newViewAttribute = window.document.documentElement.dataset.advanced;
        secondRelease.resolve();
        await Promise.all([first, queued]);
        expect(h.options().profiles[0].options.general.showAdvanced).toBe(true);
        expect(h.options().profiles[1].options.general.showAdvanced).toBe(false);
        expect(newViewAttribute).toBe('false');
        expect(window.document.documentElement.dataset.advanced).toBe('false');
    } finally {
        firstRelease.resolve();
        secondRelease.resolve();
        await Promise.all([first, queued]);
        h.close();
    }
});
