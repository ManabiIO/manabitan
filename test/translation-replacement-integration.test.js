/*
 * Copyright (C) 2026  Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {readFileSync} from 'node:fs';
import {describe, expect, vi} from 'vitest';
import {log} from '../ext/js/core/log.js';
import {Backend} from '../ext/js/background/backend.js';
import {JsonSchema} from '../ext/js/data/json-schema.js';
import {OptionsUtil} from '../ext/js/data/options-util.js';
import {GenericSettingController} from '../ext/js/pages/settings/generic-setting-controller.js';
import {TranslationTextReplacementsController} from '../ext/js/pages/settings/translation-text-replacements-controller.js';
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
 * @returns {Promise<{backend: Backend, settings: SettingsController, settingsApi: {optionsGetFull: ReturnType<typeof vi.fn>, optionsGet: ReturnType<typeof vi.fn>, modifySettings: ReturnType<typeof vi.fn>, getSettings: ReturnType<typeof vi.fn>}, controller: TranslationTextReplacementsController, generic: GenericSettingController, dispose: () => void}>}
 */
async function createHarness(window, prepareController = true) {
    const {document} = window;
    vi.stubGlobal('Node', window.Node);
    vi.stubGlobal('NodeFilter', window.NodeFilter);
    vi.stubGlobal('chrome', {runtime: {getURL: vi.fn((path) => path)}, permissions: {}});
    const modals = new window.DOMParser().parseFromString(readFileSync(new URL('../ext/templates-modals.html', import.meta.url), 'utf8'), 'text/html');
    for (const template of modals.querySelectorAll('template')) {
        document.body.appendChild(document.importNode(template.content, true));
    }
    const optionsUtil = new OptionsUtil();
    Reflect.set(optionsUtil, '_optionsSchema', new JsonSchema(JSON.parse(readFileSync(new URL('../ext/data/schemas/options-schema.json', import.meta.url), 'utf8'))));
    const options = optionsUtil.getDefault();
    options.profiles[0].id = 'profile-a';
    options.profiles[0].options.translation.textReplacements.groups = [[
        {pattern: 'a', replacement: 'alpha', ignoreCase: false},
        {pattern: 'b', replacement: 'beta', ignoreCase: false},
    ]];
    const profileB = structuredClone(options.profiles[0]);
    profileB.id = 'profile-b';
    profileB.options.translation.textReplacements.groups = [[{pattern: 'x', replacement: 'xray', ignoreCase: false}]];
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
    const controller = new TranslationTextReplacementsController(settings);
    if (prepareController) {
        await controller.prepare();
        await generic.refresh();
        await vi.waitFor(() => expect(patterns(window)).toEqual(['a', 'b']));
    }
    return {backend, settings, settingsApi, controller, generic, dispose: () => { Reflect.get(generic, '_dataBinder').disconnect(); }};
}

/**
 * @param {import('jsdom').DOMWindow} window
 * @returns {string[]}
 */
function patterns(window) {
    return [...window.document.querySelectorAll('.translation-text-replacement-pattern')].map((node) => /** @type {HTMLInputElement} */ (node).value);
}

/**
 * @param {Backend} backend
 * @param {number} index
 * @returns {import('settings').TranslationTextReplacementGroup[][]}
 */
function groups(backend, index) {
    return /** @type {import('settings').Options} */ (Reflect.get(backend, '_options')).profiles[index].options.translation.textReplacements.groups;
}

describe('replacement editor real settings integration regressions', () => {
    test('a delayed add started in A cannot insert into a same-index replacement profile', async ({window}) => {
        const h = await createHarness(window);
        const entered = deferred();
        const release = deferred();
        const read = h.settingsApi.optionsGet.getMockImplementation();
        if (typeof read !== 'function') { throw new Error('Missing read'); }
        h.settingsApi.optionsGet.mockImplementationOnce(async (context) => {
            const snapshot = await read(context);
            entered.resolve();
            await release.promise;
            return snapshot;
        });
        const adding = h.controller.addGroup();
        try {
            // A verified local implementation may complete without a new read.
            // If it does read, change the profile while that snapshot is held.
            await Promise.race([entered.promise, adding]);
            const full = /** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options'));
            full.profiles.splice(0, 1);
            h.settings.setProfileSelection(0, 'profile-b');
        } finally {
            release.resolve();
            await adding;
        }
        try {
            await vi.waitFor(() => expect(patterns(window)).toEqual(['x']));
            expect(groups(h.backend, 0)).toEqual([[{pattern: 'x', replacement: 'xray', ignoreCase: false}]]);
        } finally { h.dispose(); }
    });

    test('a late initial A read cannot recreate phantom rows over B', async ({window}) => {
        const h = await createHarness(window, false);
        const entered = deferred();
        const release = deferred();
        const read = h.settingsApi.optionsGet.getMockImplementation();
        if (typeof read !== 'function') { throw new Error('Missing read'); }
        h.settingsApi.optionsGet.mockImplementationOnce(async (context) => {
            const snapshot = await read(context);
            entered.resolve();
            await release.promise;
            return snapshot;
        });
        const preparing = h.controller.prepare();
        try {
            await entered.promise;
            const full = /** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options'));
            full.profiles.splice(0, 1);
            h.settings.setProfileSelection(0, 'profile-b');
            await vi.waitFor(() => expect(patterns(window)).toEqual(['x']));
        } finally {
            release.resolve();
            await preparing;
        }
        try {
            await h.generic.refresh();
            expect(patterns(window)).toEqual(['x']);
        } finally { h.dispose(); }
    });

    test('a delayed bound pattern write cannot mutate a replacement row after deletion', async ({window}) => {
        const h = await createHarness(window);
        const entered = deferred();
        const release = deferred();
        const completed = deferred();
        const apply = h.settingsApi.modifySettings.getMockImplementation();
        if (typeof apply !== 'function') { throw new Error('Missing save'); }
        h.settingsApi.modifySettings.mockImplementationOnce(async (targets, source) => {
            entered.resolve();
            await release.promise;
            try {
                return await apply(targets, source);
            } finally {
                completed.resolve();
            }
        });
        const input = /** @type {HTMLInputElement} */ (window.document.querySelector('.translation-text-replacement-pattern'));
        input.value = 'Q';
        input.dispatchEvent(new window.Event('change'));
        try {
            await entered.promise;
            await h.settings.modifyProfileSettings([{action: 'splice', path: 'translation.textReplacements.groups[0]', start: 0, deleteCount: 1, items: []}]);
        } finally {
            release.resolve();
            await completed.promise;
            await new Promise((resolve) => { setTimeout(resolve, 0); });
            h.dispose();
        }
        expect(groups(h.backend, 0)[0].map(({pattern}) => pattern)).toEqual(['b']);
    });

    test('an invalid pattern clears the previous successful test result', async ({window}) => {
        const h = await createHarness(window);
        try {
            const button = /** @type {HTMLElement} */ (window.document.querySelector('.translation-text-replacement-button'));
            const input = /** @type {HTMLInputElement} */ (window.document.querySelector('.translation-text-replacement-test-input'));
            const output = /** @type {HTMLInputElement} */ (window.document.querySelector('.translation-text-replacement-test-output'));
            const pattern = /** @type {HTMLInputElement} */ (window.document.querySelector('.translation-text-replacement-pattern'));
            input.value = 'a';
            button.dispatchEvent(new window.CustomEvent('menuClose', {detail: {action: 'showTest'}}));
            expect(output.value).toBe('alpha');
            pattern.value = '[';
            pattern.dispatchEvent(new window.Event('change'));
            await vi.waitFor(() => expect(pattern.dataset.invalid).toBe('true'));
            expect(output.value).toBe('');
        } finally { h.dispose(); }
    });
});

/**
 * @param {import('jsdom').DOMWindow} window
 * @param {number} [index]
 * @returns {HTMLInputElement}
 */
function patternInput(window, index = 0) {
    const input = window.document.querySelectorAll('.translation-text-replacement-pattern')[index];
    if (!(input instanceof window.HTMLInputElement)) { throw new Error('Missing replacement pattern input'); }
    return input;
}

/**
 * @param {TranslationTextReplacementsController} controller
 * @returns {Promise<void>}
 */
async function settle(controller) {
    await Reflect.get(controller, '_mutationTail');
    await new Promise((resolve) => { setTimeout(resolve, 0); });
}

describe('replacement editor mutation ownership and recovery', () => {
    test('replacement and ignore-case edits persist and update the visible preview', async ({window}) => {
        const h = await createHarness(window);
        try {
            const button = /** @type {HTMLElement} */ (window.document.querySelector('.translation-text-replacement-button'));
            const input = /** @type {HTMLInputElement} */ (window.document.querySelector('.translation-text-replacement-test-input'));
            const output = /** @type {HTMLInputElement} */ (window.document.querySelector('.translation-text-replacement-test-output'));
            const replacement = /** @type {HTMLInputElement} */ (window.document.querySelector('.translation-text-replacement-replacement'));
            const toggle = /** @type {HTMLInputElement} */ (window.document.querySelector('.translation-text-replacement-pattern-ignore-case'));
            input.value = 'A';
            button.dispatchEvent(new window.CustomEvent('menuClose', {detail: {action: 'showTest'}}));
            replacement.value = 'new';
            replacement.dispatchEvent(new window.Event('change'));
            toggle.checked = true;
            toggle.dispatchEvent(new window.Event('change'));
            await settle(h.controller);
            expect(groups(h.backend, 0)[0][0]).toEqual({pattern: 'a', replacement: 'new', ignoreCase: true});
            expect(output.value).toBe('new');
        } finally { h.dispose(); }
    });

    test('an edit queued behind a deletion follows the surviving logical row', async ({window}) => {
        const h = await createHarness(window);
        const entered = deferred();
        const release = deferred();
        const apply = h.settingsApi.modifySettings.getMockImplementation();
        if (typeof apply !== 'function') { throw new Error('Missing save'); }
        h.settingsApi.modifySettings.mockImplementationOnce(async (targets, source) => {
            entered.resolve();
            await release.promise;
            return await apply(targets, source);
        });
        const removing = h.controller.deleteGroup(0);
        try {
            await entered.promise;
            const survivor = patternInput(window, 1);
            survivor.value = 'Q';
            survivor.dispatchEvent(new window.Event('change'));
        } finally { release.resolve(); }
        try {
            await removing;
            await settle(h.controller);
            expect(groups(h.backend, 0)[0].map(({pattern}) => pattern)).toEqual(['Q']);
            expect(patterns(window)).toEqual(['Q']);
        } finally { h.dispose(); }
    });

    test('removing the last first-group row preserves and renders the next group', async ({window}) => {
        const h = await createHarness(window);
        try {
            await h.settings.setProfileSetting('translation.textReplacements.groups', [
                [{pattern: 'a', replacement: 'alpha', ignoreCase: false}],
                [{pattern: 'later', replacement: 'kept', ignoreCase: true}],
            ]);
            await h.settings.refresh();
            await vi.waitFor(() => expect(patterns(window)).toEqual(['a']));
            await h.controller.deleteGroup(0);
            expect(groups(h.backend, 0)).toEqual([[{pattern: 'later', replacement: 'kept', ignoreCase: true}]]);
            expect(patterns(window)).toEqual(['later']);
            const input = patternInput(window);
            input.value = 'changed';
            input.dispatchEvent(new window.Event('change'));
            await settle(h.controller);
            expect(groups(h.backend, 0)[0][0].pattern).toBe('changed');
        } finally { h.dispose(); }
    });

    for (const persisted of [false, true]) {
        test(`transport failure preserves unsent text (persisted=${persisted})`, async ({window}) => {
            const h = await createHarness(window);
            vi.spyOn(log, 'error').mockImplementation(() => {});
            const entered = deferred();
            const release = deferred();
            const apply = h.settingsApi.modifySettings.getMockImplementation();
            if (typeof apply !== 'function') { throw new Error('Missing save'); }
            h.settingsApi.modifySettings.mockImplementationOnce(async (targets, source) => {
                if (persisted) { await apply(targets, source); }
                entered.resolve();
                await release.promise;
                throw new Error('injected response transport failure');
            });
            const input = patternInput(window);
            input.value = 'Q';
            input.dispatchEvent(new window.Event('change'));
            try {
                await entered.promise;
                input.value = 'R';
            } finally { release.resolve(); }
            try {
                await settle(h.controller);
                expect(groups(h.backend, 0)[0][0].pattern).toBe(persisted ? 'Q' : 'a');
                expect(patterns(window)).toEqual(['R', 'b']);
            } finally { h.dispose(); }
        });
    }

    test('a failed older checkbox edit cannot undo a newer ABA edit', async ({window}) => {
        const h = await createHarness(window);
        const entered = deferred();
        const release = deferred();
        h.settingsApi.modifySettings.mockImplementationOnce(async () => {
            entered.resolve();
            await release.promise;
            return [{error: {name: 'Error', message: 'injected rejection'}}];
        });
        const toggle = /** @type {HTMLInputElement} */ (window.document.querySelector('.translation-text-replacement-pattern-ignore-case'));
        toggle.checked = true;
        toggle.dispatchEvent(new window.Event('change'));
        try {
            await entered.promise;
            toggle.checked = false;
            toggle.dispatchEvent(new window.Event('change'));
            toggle.checked = true;
            toggle.dispatchEvent(new window.Event('change'));
        } finally { release.resolve(); }
        try {
            await settle(h.controller);
            expect(groups(h.backend, 0)[0][0].ignoreCase).toBe(true);
            expect(toggle.checked).toBe(true);
        } finally { h.dispose(); }
    });

    test('failed recovery blocks further writes until a verified refresh', async ({window}) => {
        const h = await createHarness(window);
        vi.spyOn(log, 'error').mockImplementation(() => {});
        h.settingsApi.modifySettings.mockRejectedValueOnce(new Error('primary save failure'));
        h.settingsApi.optionsGet.mockRejectedValueOnce(new Error('recovery read failure'));
        try {
            let input = patternInput(window);
            input.value = 'Q';
            input.dispatchEvent(new window.Event('change'));
            await settle(h.controller);
            input.value = 'R';
            input.dispatchEvent(new window.Event('change'));
            await settle(h.controller);
            expect(h.settingsApi.modifySettings).toHaveBeenCalledTimes(1);
            expect(groups(h.backend, 0)[0][0].pattern).toBe('a');
            await h.settings.refresh();
            input = patternInput(window);
            input.value = 'R';
            input.dispatchEvent(new window.Event('change'));
            await settle(h.controller);
            expect(groups(h.backend, 0)[0][0].pattern).toBe('R');
        } finally { h.dispose(); }
    });

    test('a malformed save response is reconciled before accepting another edit', async ({window}) => {
        const h = await createHarness(window);
        vi.spyOn(log, 'error').mockImplementation(() => {});
        h.settingsApi.modifySettings.mockResolvedValueOnce([{}]);
        try {
            const input = patternInput(window);
            input.value = 'Q';
            input.dispatchEvent(new window.Event('change'));
            await settle(h.controller);
            expect(groups(h.backend, 0)[0][0].pattern).toBe('a');
            expect(input.value).toBe('a');
            input.value = 'R';
            input.dispatchEvent(new window.Event('change'));
            await settle(h.controller);
            expect(groups(h.backend, 0)[0][0].pattern).toBe('R');
        } finally { h.dispose(); }
    });

    for (const draft of ['none', 'unsent', 'queued-original']) {
        test(`a revisited profile reconciles an old save while preserving ${draft} input`, async ({window}) => {
            const h = await createHarness(window);
            const entered = deferred();
            const release = deferred();
            const apply = h.settingsApi.modifySettings.getMockImplementation();
            if (typeof apply !== 'function') { throw new Error('Missing save'); }
            h.settingsApi.modifySettings.mockImplementationOnce(async (targets, source) => {
                entered.resolve();
                await release.promise;
                return await apply(targets, source);
            });
            let input = patternInput(window);
            input.value = 'Q';
            input.dispatchEvent(new window.Event('change'));
            try {
                await entered.promise;
                h.settings.setProfileSelection(1, 'profile-b');
                await vi.waitFor(() => expect(patterns(window)).toEqual(['x']));
                h.settings.setProfileSelection(0, 'profile-a');
                await vi.waitFor(() => expect(patterns(window)).toEqual(['a', 'b']));
                input = patternInput(window);
                if (draft === 'unsent') { input.value = 'R'; }
                if (draft === 'queued-original') { input.dispatchEvent(new window.Event('change')); }
            } finally { release.resolve(); }
            try {
                await settle(h.controller);
                expect(groups(h.backend, 0)[0][0].pattern).toBe(draft === 'queued-original' ? 'a' : 'Q');
                expect(input.value).toBe(draft === 'none' ? 'Q' : (draft === 'unsent' ? 'R' : 'a'));
            } finally { h.dispose(); }
        });
    }

    test('a late structural save refreshes a revisited profile and retires old controls', async ({window}) => {
        const h = await createHarness(window);
        const entered = deferred();
        const release = deferred();
        const apply = h.settingsApi.modifySettings.getMockImplementation();
        if (typeof apply !== 'function') { throw new Error('Missing save'); }
        h.settingsApi.modifySettings.mockImplementationOnce(async (targets, source) => {
            entered.resolve();
            await release.promise;
            return await apply(targets, source);
        });
        const removing = h.controller.deleteGroup(0);
        let staleInput;
        try {
            await entered.promise;
            h.settings.setProfileSelection(1, 'profile-b');
            await vi.waitFor(() => expect(patterns(window)).toEqual(['x']));
            h.settings.setProfileSelection(0, 'profile-a');
            await vi.waitFor(() => expect(patterns(window)).toEqual(['a', 'b']));
            staleInput = patternInput(window);
        } finally { release.resolve(); }
        try {
            await removing;
            expect(patterns(window)).toEqual(['b']);
            if (typeof staleInput === 'undefined') { throw new Error('Missing old control'); }
            staleInput.value = 'Q';
            staleInput.dispatchEvent(new window.Event('change'));
            await settle(h.controller);
            expect(groups(h.backend, 0)[0].map(({pattern}) => pattern)).toEqual(['b']);
        } finally { h.dispose(); }
    });

    test('a broken first template does not shift a healthy row backend index', async ({window}) => {
        const h = await createHarness(window, false);
        vi.spyOn(log, 'error').mockImplementation(() => {});
        const instantiate = h.settings.instantiateTemplate.bind(h.settings);
        let count = 0;
        vi.spyOn(h.settings, 'instantiateTemplate').mockImplementation((name) => {
            const node = instantiate(name);
            if (name === 'translation-text-replacement-entry' && ++count === 1) {
                node.querySelector('.translation-text-replacement-pattern')?.remove();
            }
            return node;
        });
        try {
            await h.controller.prepare();
            await h.generic.refresh();
            expect(patterns(window)).toEqual(['b']);
            const input = patternInput(window);
            input.value = 'Q';
            input.dispatchEvent(new window.Event('change'));
            await settle(h.controller);
            expect(groups(h.backend, 0)[0].map(({pattern}) => pattern)).toEqual(['a', 'Q']);
        } finally { h.dispose(); }
    });

    test('unknown structural recovery never copies drafts onto replacement rows', async ({window}) => {
        const h = await createHarness(window);
        const entered = deferred();
        const release = deferred();
        const apply = h.settingsApi.modifySettings.getMockImplementation();
        if (typeof apply !== 'function') { throw new Error('Missing save'); }
        h.settingsApi.modifySettings.mockImplementationOnce(async (targets, source) => {
            entered.resolve();
            await release.promise;
            return await apply(targets, source);
        });
        const input = patternInput(window);
        input.value = 'Q';
        input.dispatchEvent(new window.Event('change'));
        try {
            await entered.promise;
            input.value = 'R';
            await h.settings.modifyProfileSettings([{action: 'splice', path: 'translation.textReplacements.groups[0]', start: 0, deleteCount: 1, items: []}]);
        } finally { release.resolve(); }
        try {
            await settle(h.controller);
            expect(groups(h.backend, 0)[0].map(({pattern}) => pattern)).toEqual(['b']);
            expect(patterns(window)).toEqual(['b']);
        } finally { h.dispose(); }
    });
});

test('a failed pattern save restores its validation marker and visible preview', async ({window}) => {
    const h = await createHarness(window);
    vi.spyOn(log, 'error').mockImplementation(() => {});
    try {
        const input = /** @type {HTMLInputElement} */ (window.document.querySelector('.translation-text-replacement-test-input'));
        const output = /** @type {HTMLInputElement} */ (window.document.querySelector('.translation-text-replacement-test-output'));
        const button = /** @type {HTMLElement} */ (window.document.querySelector('.translation-text-replacement-button'));
        const pattern = patternInput(window);
        input.value = 'a';
        button.dispatchEvent(new window.CustomEvent('menuClose', {detail: {action: 'showTest'}}));
        expect(output.value).toBe('alpha');
        h.settingsApi.modifySettings.mockRejectedValueOnce(new Error('storage unavailable'));
        pattern.value = '[';
        pattern.dispatchEvent(new window.Event('change'));
        await settle(h.controller);
        expect(pattern.value).toBe('a');
        expect(pattern.dataset.invalid).toBe('false');
        expect(output.value).toBe('alpha');
    } finally { h.dispose(); }
});

for (const operation of ['add', 'delete']) {
    for (const draft of ['unsent', 'queued']) {
        test(`late structural ${operation} preserves ${draft} edits on a surviving revisited row`, async ({window}) => {
            const h = await createHarness(window);
            const entered = deferred();
            const release = deferred();
            const apply = h.settingsApi.modifySettings.getMockImplementation();
            if (typeof apply !== 'function') { throw new Error('Missing save'); }
            h.settingsApi.modifySettings.mockImplementationOnce(async (targets, source) => {
                entered.resolve();
                await release.promise;
                return await apply(targets, source);
            });
            const changing = operation === 'add' ? h.controller.addGroup() : h.controller.deleteGroup(0);
            let survivor;
            try {
                await entered.promise;
                h.settings.setProfileSelection(1, 'profile-b');
                await vi.waitFor(() => expect(patterns(window)).toEqual(['x']));
                h.settings.setProfileSelection(0, 'profile-a');
                await vi.waitFor(() => expect(patterns(window)).toEqual(['a', 'b']));
                survivor = /** @type {HTMLInputElement} */ (window.document.querySelectorAll('.translation-text-replacement-pattern')[operation === 'add' ? 0 : 1]);
                survivor.value = 'draft';
                if (draft === 'queued') { survivor.dispatchEvent(new window.Event('change')); }
            } finally { release.resolve(); }
            try {
                await changing;
                await settle(h.controller);
                if (typeof survivor === 'undefined') { throw new Error('Missing surviving row'); }
                expect(survivor.isConnected).toBe(true);
                expect(patterns(window)).toEqual(operation === 'add' ? ['draft', 'b', ''] : ['draft']);
                expect(groups(h.backend, 0)[0][0].pattern).toBe(draft === 'queued' ? 'draft' : (operation === 'add' ? 'a' : 'b'));
                if (draft === 'unsent') {
                    survivor.dispatchEvent(new window.Event('change'));
                    await settle(h.controller);
                    expect(groups(h.backend, 0)[0][0].pattern).toBe('draft');
                }
            } finally { h.dispose(); }
        });
    }
}

for (const operation of ['add', 'delete', 'field']) {
    for (const persisted of [false, true]) {
        for (const draft of ['unsent', 'queued']) {
            test(`a rejected late ${operation} response recovers a revisited profile (persisted=${persisted}, draft=${draft})`, async ({window}) => {
                const h = await createHarness(window);
                vi.spyOn(log, 'error').mockImplementation(() => {});
                const entered = deferred();
                const release = deferred();
                const apply = h.settingsApi.modifySettings.getMockImplementation();
                if (typeof apply !== 'function') { throw new Error('Missing save'); }
                h.settingsApi.modifySettings.mockImplementationOnce(async (targets, source) => {
                    entered.resolve();
                    await release.promise;
                    if (persisted) { await apply(targets, source); }
                    throw new Error('injected late transport failure');
                });
                let changing;
                if (operation === 'field') {
                    const replacement = /** @type {HTMLInputElement} */ (window.document.querySelector('.translation-text-replacement-replacement'));
                    replacement.value = 'saved';
                    replacement.dispatchEvent(new window.Event('change'));
                    changing = settle(h.controller);
                } else {
                    changing = (operation === 'add' ? h.controller.addGroup() : h.controller.deleteGroup(0)).catch(() => {});
                }
                let survivor;
                try {
                    await entered.promise;
                    h.settings.setProfileSelection(1, 'profile-b');
                    await vi.waitFor(() => expect(patterns(window)).toEqual(['x']));
                    h.settings.setProfileSelection(0, 'profile-a');
                    await vi.waitFor(() => expect(patterns(window)).toEqual(['a', 'b']));
                    survivor = /** @type {HTMLInputElement} */ (window.document.querySelectorAll('.translation-text-replacement-pattern')[operation === 'delete' ? 1 : 0]);
                    survivor.value = 'draft';
                    if (draft === 'queued') { survivor.dispatchEvent(new window.Event('change')); }
                } finally { release.resolve(); }
                try {
                    await changing;
                    await settle(h.controller);
                    if (typeof survivor === 'undefined') { throw new Error('Missing surviving row'); }
                    expect(survivor.isConnected).toBe(true);
                    const expectedPatterns = operation === 'delete' ? (persisted ? ['draft'] : ['a', 'draft']) : ['draft', 'b', ...(persisted && operation === 'add' ? [''] : [])];
                    expect(patterns(window)).toEqual(expectedPatterns);
                    if (operation === 'field') {
                        const replacement = /** @type {HTMLInputElement} */ (window.document.querySelector('.translation-text-replacement-replacement'));
                        expect(replacement.value).toBe(persisted ? 'saved' : 'alpha');
                    }
                    if (draft === 'unsent') {
                        survivor.dispatchEvent(new window.Event('change'));
                        await settle(h.controller);
                    }
                    const rowIndex = operation === 'delete' && !persisted ? 1 : 0;
                    expect(groups(h.backend, 0)[0][rowIndex].pattern).toBe('draft');
                } finally { h.dispose(); }
            });
        }
    }
}
