/*
 * Copyright (C) 2026  Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {readFileSync} from 'node:fs';
import {describe, expect, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';
import {JsonSchema} from '../ext/js/data/json-schema.js';
import {OptionsUtil} from '../ext/js/data/options-util.js';
import {GenericSettingController} from '../ext/js/pages/settings/generic-setting-controller.js';
import {KeyboardShortcutController} from '../ext/js/pages/settings/keyboard-shortcuts-controller.js';
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
 * @returns {Promise<{backend: Backend, settings: SettingsController, api: Record<string, import('vitest').Mock>, controller: KeyboardShortcutController, generic: GenericSettingController, dispose: () => Promise<void>}>}
 */
async function createHarness(window, prepareController = true) {
    const {document} = window;
    vi.stubGlobal('Node', window.Node);
    vi.stubGlobal('NodeFilter', window.NodeFilter);
    vi.stubGlobal('chrome', {runtime: {getURL: vi.fn((path) => path)}, permissions: {}});

    const modalTemplates = new window.DOMParser().parseFromString(readFileSync(new URL('../ext/templates-modals.html', import.meta.url), 'utf8'), 'text/html');
    for (const template of modalTemplates.querySelectorAll('template')) {
        document.body.appendChild(document.importNode(template.content, true));
    }
    const modal = document.querySelector('#keyboard-shortcuts-modal');
    if (modal === null) { throw new Error('Missing keyboard shortcut modal'); }

    const optionsUtil = new OptionsUtil();
    Reflect.set(optionsUtil, '_optionsSchema', new JsonSchema(JSON.parse(readFileSync(new URL('../ext/data/schemas/options-schema.json', import.meta.url), 'utf8'))));
    const options = optionsUtil.getDefault();
    options.profiles[0].id = 'profile-a';
    options.profiles[0].options.inputs.hotkeys = [
        {action: 'close', argument: '', key: 'A', modifiers: ['ctrl'], scopes: ['popup'], enabled: true},
        {action: 'close', argument: '', key: 'B', modifiers: ['ctrl'], scopes: ['popup'], enabled: true},
    ];
    const profileB = structuredClone(options.profiles[0]);
    profileB.id = 'profile-b';
    profileB.options.inputs.hotkeys = [
        {action: 'close', argument: '', key: 'X', modifiers: ['ctrl'], scopes: ['popup'], enabled: true},
    ];
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
    const api = {
        optionsGetFull: vi.fn(async () => structuredClone(backend._onApiOptionsGetFull(undefined, sender))),
        optionsGet: vi.fn(async (context) => structuredClone(backend._onApiOptionsGet({optionsContext: structuredClone(context)}, sender))),
        modifySettings: vi.fn(async (targets, source) => structuredClone(await backend._onApiModifySettings({targets: structuredClone(targets), source}, sender))),
        getSettings: vi.fn(async (targets) => structuredClone(backend._onApiGetSettings({targets: structuredClone(targets)}, sender))),
        getEnvironmentInfo: vi.fn(async () => ({platform: {os: 'mac'}})),
    };
    const application = {on: vi.fn(), api};
    const settings = new SettingsController(/** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ (application)));
    Reflect.set(settings._templates, 'loadFromFiles', vi.fn(async () => {
        const source = new window.DOMParser().parseFromString(readFileSync(new URL('../ext/templates-settings.html', import.meta.url), 'utf8'), 'text/html');
        settings._templates.load(source);
    }));
    await settings.prepare();
    const generic = new GenericSettingController(settings);
    await generic.prepare();
    const controller = new KeyboardShortcutController(settings);
    if (prepareController) {
        await controller.prepare();
        await generic.refresh();
    }
    return {backend,
        settings,
        api,
        controller,
        generic,
        dispose: async () => {
            Reflect.get(generic, '_dataBinder').disconnect();
            await settle();
            vi.unstubAllGlobals();
        }};
}

/**
 * @param {Backend} backend
 * @param {number} [profileIndex]
 * @returns {import('settings').InputsHotkeyOptions[]}
 */
function hotkeys(backend, profileIndex = 0) {
    return /** @type {import('settings').Options} */ (Reflect.get(backend, '_options')).profiles[profileIndex].options.inputs.hotkeys;
}

/**
 * @param {import('jsdom').DOMWindow} window
 * @returns {HTMLElement[]}
 */
function rows(window) {
    return /** @type {HTMLElement[]} */ ([...window.document.querySelectorAll('#hotkey-list .hotkey-list-item')]);
}

/** @param {KeyboardShortcutController} [controller] */
async function settle(controller) {
    if (typeof controller !== 'undefined') { await Reflect.get(controller, '_mutationTail'); }
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    if (typeof controller !== 'undefined') { await Reflect.get(controller, '_mutationTail'); }
}

/**
 * Captures the real method's promise from UI dispatch, including product errors.
 * @param {object} target
 * @param {string} name
 * @returns {{last: () => Promise<void>, errors: unknown[]}}
 */
function captureOperation(target, name) {
    const invoke = Reflect.get(target, name).bind(target);
    /** @type {Promise<void>[]} */
    const calls = [];
    /** @type {unknown[]} */
    const errors = [];
    /**
     * @param {...unknown} args
     * @returns {Promise<void>}
     */
    function captured(...args) {
        const promise = Promise.resolve(invoke(...args));
        calls.push(promise);
        void promise.catch((error) => { errors.push(error); });
        return promise;
    }
    Reflect.set(target, name, captured);
    let nextCall = 0;
    return {last: async () => {
        const index = nextCall++;
        await vi.waitFor(() => expect(calls.length).toBeGreaterThan(index));
        await calls[index];
    },
    errors};
}

/**
 * @param {KeyboardShortcutController} controller
 * @param {number} [index]
 * @returns {NonNullable<KeyboardShortcutController['_entries'][number]>}
 */
function entryAt(controller, index = 0) {
    const entry = Reflect.get(controller, '_entries')[index];
    if (entry === null || typeof entry === 'undefined') { throw new Error('Missing shortcut entry'); }
    return entry;
}

/**
 * @param {import('jsdom').DOMWindow} window
 * @param {number} [index]
 * @returns {HTMLSelectElement}
 */
function actionInput(window, index = 0) {
    return /** @type {HTMLSelectElement} */ (rows(window)[index].querySelector('.hotkey-list-item-action'));
}

/**
 * @param {import('jsdom').DOMWindow} window
 * @param {number} [index]
 * @returns {HTMLInputElement}
 */
function argumentInput(window, index = 0) {
    return /** @type {HTMLInputElement} */ (rows(window)[index].querySelector('.hotkey-argument-input'));
}

describe('keyboard shortcut editor real settings integration regressions', () => {
    test('ordinary action and argument edits persist to the visible row', async ({window}) => {
        const h = await createHarness(window);
        try {
            const action = /** @type {HTMLSelectElement} */ (rows(window)[0].querySelector('.hotkey-list-item-action'));
            action.value = 'nextEntry';
            action.dispatchEvent(new window.Event('change'));
            await vi.waitFor(() => expect(hotkeys(h.backend)[0]).toMatchObject({action: 'nextEntry', argument: '1'}));
            const argument = /** @type {HTMLInputElement} */ (rows(window)[0].querySelector('.hotkey-argument-input'));
            argument.value = '3';
            argument.dispatchEvent(new window.Event('change'));
            await vi.waitFor(() => expect(hotkeys(h.backend)[0].argument).toBe('3'));
            expect(argumentInput(window).value).toBe('3');
        } finally { await h.dispose(); }
    });

    test('a delayed initial options read cannot repaint profile B with profile A rows', async ({window}) => {
        const h = await createHarness(window, false);
        const entered = deferred();
        const release = deferred();
        const read = h.api.optionsGet.getMockImplementation();
        if (typeof read !== 'function') { throw new Error('Missing options read'); }
        h.api.optionsGet.mockImplementationOnce(async (context) => {
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
            await vi.waitFor(() => expect(rows(window).map((row) => /** @type {HTMLInputElement} */ (row.querySelector('.hotkey-list-item-input')).value)).toEqual(['Ctrl + X']));
        } finally {
            release.resolve();
            try {
                await preparing;
                await settle();
            } finally { await h.dispose(); }
        }
        expect(h.settings.getOptionsContext()).toMatchObject({index: 0, profileId: 'profile-b'});
        expect(rows(window).map((row) => /** @type {HTMLInputElement} */ (row.querySelector('.hotkey-list-item-input')).value)).toEqual(['Ctrl + X']);
    });

    test('a delayed enabled-checkbox save cannot mutate the row shifted into its old index', async ({window}) => {
        const h = await createHarness(window);
        const entered = deferred();
        const release = deferred();
        const modify = h.api.modifySettings.getMockImplementation();
        if (typeof modify !== 'function') { throw new Error('Missing settings writer'); }
        h.api.modifySettings.mockImplementationOnce(async (targets, source) => {
            entered.resolve();
            await release.promise;
            return await modify(targets, source);
        });
        try {
            const enabled = /** @type {HTMLInputElement} */ (rows(window)[0].querySelector('.hotkey-list-item-enabled'));
            enabled.checked = false;
            enabled.dispatchEvent(new window.Event('change', {bubbles: true}));
            await entered.promise;
            expect(hotkeys(h.backend).map(({key, enabled: isEnabled}) => [key, isEnabled])).toEqual([['A', true], ['B', true]]);
            await h.settings.modifyProfileSettings([{action: 'splice', path: 'inputs.hotkeys', start: 0, deleteCount: 1, items: []}]);
        } finally {
            release.resolve();
            try {
                await vi.waitFor(() => expect(hotkeys(h.backend).map(({key}) => key)).toEqual(['B']));
                await settle();
            } finally { await h.dispose(); }
        }
        expect(hotkeys(h.backend)).toEqual([{action: 'close', argument: '', key: 'B', modifiers: ['ctrl'], scopes: ['popup'], enabled: true}]);
    });
});

for (const change of ['profile', 'newer-key']) {
    test(`a delayed row reset cannot overwrite ${change} input`, async ({window}) => {
        const h = await createHarness(window);
        const entered = deferred();
        const release = deferred();
        const operation = captureOperation(entryAt(h.controller), '_resetInput');
        vi.spyOn(h.controller, 'getDefaultHotkeys').mockImplementationOnce(async () => {
            entered.resolve();
            await release.promise;
            return [{action: 'close', argument: '', key: 'KeyD', modifiers: [], scopes: ['popup'], enabled: true}];
        });
        const button = /** @type {HTMLElement} */ (rows(window)[0].querySelector('.hotkey-list-item-button'));
        button.dispatchEvent(new window.CustomEvent('menuClose', {detail: {action: 'resetInput'}}));
        try {
            await entered.promise;
            if (change === 'profile') {
                h.settings.setProfileSelection(1, 'profile-b');
                await vi.waitFor(() => expect(keyInput(window).value).toBe('Ctrl + X'));
            } else {
                const input = /** @type {HTMLInputElement} */ (rows(window)[0].querySelector('.hotkey-list-item-input'));
                input.dispatchEvent(new window.KeyboardEvent('keydown', {key: 'q', code: 'KeyQ'}));
                await vi.waitFor(() => expect(hotkeys(h.backend)[0].key).toBe('KeyQ'));
            }
        } finally { release.resolve(); }
        try {
            await operation.last().catch(() => {});
            await settle(h.controller);
            expect(hotkeys(h.backend, change === 'profile' ? 1 : 0)[0].key).toBe(change === 'profile' ? 'X' : 'KeyQ');
            expect(operation.errors).toEqual([]);
        } finally { await h.dispose(); }
    });
}

test('a malformed toggle-option path is shown invalid without rejecting validation', async ({window}) => {
    const h = await createHarness(window);
    try {
        actionInput(window).value = 'toggleOption';
        actionInput(window).dispatchEvent(new window.Event('change'));
        await vi.waitFor(() => expect(argumentInput(window)?.dataset.invalid).toBe('false'));
        const operation = captureOperation(entryAt(h.controller), '_updateArgumentInputValidity');
        const input = argumentInput(window);
        input.value = 'general[';
        input.dispatchEvent(new window.Event('change'));
        await operation.last().catch(() => {});
        await settle(h.controller);
        expect(input.dataset.invalid).toBe('true');
        expect(operation.errors).toEqual([]);
    } finally { await h.dispose(); }
});

test('older valid-path validation cannot overwrite the newest invalid path marker', async ({window}) => {
    const h = await createHarness(window);
    const entered = deferred();
    const release = deferred();
    try {
        actionInput(window).value = 'toggleOption';
        actionInput(window).dispatchEvent(new window.Event('change'));
        await vi.waitFor(() => expect(argumentInput(window)?.dataset.invalid).toBe('false'));
        const operation = captureOperation(entryAt(h.controller), '_updateArgumentInputValidity');
        const read = h.api.optionsGet.getMockImplementation();
        if (typeof read !== 'function') { throw new Error('Missing read'); }
        h.api.optionsGet.mockImplementationOnce(async (context) => {
            const snapshot = await read(context);
            entered.resolve();
            await release.promise;
            return snapshot;
        });
        const input = argumentInput(window);
        input.value = 'general.enable';
        input.dispatchEvent(new window.Event('change'));
        const older = operation.last();
        try {
            await entered.promise;
            input.value = 'scanning.length';
            input.dispatchEvent(new window.Event('change'));
            await operation.last();
            expect(input.dataset.invalid).toBe('true');
        } finally { release.resolve(); }
        await older;
        expect(input.dataset.invalid).toBe('true');
        expect(operation.errors).toEqual([]);
    } finally { release.resolve(); await h.dispose(); }
});

test('a delayed card-format argument cannot reappear after switching to an action without arguments', async ({window}) => {
    const h = await createHarness(window);
    const entered = deferred();
    const release = deferred();
    const operation = captureOperation(entryAt(h.controller), '_setAction');
    const read = h.api.optionsGet.getMockImplementation();
    if (typeof read !== 'function') { throw new Error('Missing read'); }
    h.api.optionsGet.mockImplementationOnce(async (context) => {
        const snapshot = await read(context);
        entered.resolve();
        await release.promise;
        return snapshot;
    });
    actionInput(window).value = 'addNote';
    actionInput(window).dispatchEvent(new window.Event('change'));
    const older = operation.last();
    try {
        await Promise.race([entered.promise, older]);
        actionInput(window).value = 'playAudio';
        actionInput(window).dispatchEvent(new window.Event('change'));
        await operation.last();
    } finally { release.resolve(); }
    try {
        await older;
        await settle(h.controller);
        expect(hotkeys(h.backend)[0].action).toBe('playAudio');
        expect(rows(window)[0].querySelectorAll('.hotkey-argument-input')).toHaveLength(0);
        expect(operation.errors).toEqual([]);
    } finally { await h.dispose(); }
});

test('a failed action save restores the acknowledged action and argument controls', async ({window}) => {
    const h = await createHarness(window);
    const operation = captureOperation(entryAt(h.controller), '_setAction');
    h.api.modifySettings.mockRejectedValueOnce(new Error('injected storage failure'));
    try {
        actionInput(window).value = 'nextEntry';
        actionInput(window).dispatchEvent(new window.Event('change'));
        await operation.last().catch(() => {});
        await settle(h.controller);
        expect(hotkeys(h.backend)[0].action).toBe('close');
        expect(actionInput(window).value).toBe('close');
        expect(rows(window)[0].querySelectorAll('.hotkey-argument-input')).toHaveLength(0);
    } finally { await h.dispose(); }
});

test('global reset still loading defaults cannot overwrite a newer key edit', async ({window}) => {
    const h = await createHarness(window);
    const entered = deferred();
    const release = deferred();
    const operation = captureOperation(h.controller, '_reset');
    vi.spyOn(h.controller, 'getDefaultHotkeys').mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return [{action: 'close', argument: '', key: 'KeyD', modifiers: [], scopes: ['popup'], enabled: true}];
    });
    const button = /** @type {HTMLElement} */ (window.document.querySelector('#hotkey-list-reset'));
    button.dispatchEvent(new window.MouseEvent('click', {bubbles: true}));
    try {
        await entered.promise;
        const input = /** @type {HTMLInputElement} */ (rows(window)[0].querySelector('.hotkey-list-item-input'));
        input.dispatchEvent(new window.KeyboardEvent('keydown', {key: 'q', code: 'KeyQ'}));
        await vi.waitFor(() => expect(hotkeys(h.backend)[0].key).toBe('KeyQ'));
    } finally { release.resolve(); }
    try {
        await operation.last();
        await settle(h.controller);
        expect(hotkeys(h.backend)[0].key).toBe('KeyQ');
    } finally { await h.dispose(); }
});

test('an older row render cannot append phantom rows after a profile change', async ({window}) => {
    const h = await createHarness(window, false);
    hotkeys(h.backend)[0].action = 'addNote';
    hotkeys(h.backend)[0].argument = '0';
    const entered = deferred();
    const release = deferred();
    const read = h.api.optionsGet.getMockImplementation();
    if (typeof read !== 'function') { throw new Error('Missing read'); }
    let readsA = 0;
    h.api.optionsGet.mockImplementation(async (context) => {
        const snapshot = await read(context);
        if (context.profileId === 'profile-a' && ++readsA === 2) {
            entered.resolve();
            await release.promise;
        }
        return snapshot;
    });
    const preparing = h.controller.prepare();
    try {
        await Promise.race([entered.promise, preparing]);
        const full = /** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options'));
        full.profiles.splice(0, 1);
        h.settings.setProfileSelection(0, 'profile-b');
        await vi.waitFor(() => expect(rows(window).map((row) => /** @type {HTMLInputElement} */ (row.querySelector('.hotkey-list-item-input')).value)).toEqual(['Ctrl + X']));
    } finally { release.resolve(); }
    try {
        await preparing;
        await settle(h.controller);
        expect(rows(window).map((row) => /** @type {HTMLInputElement} */ (row.querySelector('.hotkey-list-item-input')).value)).toEqual(['Ctrl + X']);
    } finally { await h.dispose(); }
});

test('validation finishing after row cleanup cannot reject or touch the replacement profile', async ({window}) => {
    const h = await createHarness(window);
    const entered = deferred();
    const release = deferred();
    try {
        actionInput(window).value = 'toggleOption';
        actionInput(window).dispatchEvent(new window.Event('change'));
        await vi.waitFor(() => expect(argumentInput(window)?.dataset.invalid).toBe('false'));
        const operation = captureOperation(entryAt(h.controller), '_updateArgumentInputValidity');
        const read = h.api.optionsGet.getMockImplementation();
        if (typeof read !== 'function') { throw new Error('Missing read'); }
        h.api.optionsGet.mockImplementationOnce(async (context) => {
            const snapshot = await read(context);
            entered.resolve();
            await release.promise;
            return snapshot;
        });
        const input = argumentInput(window);
        input.value = 'general.enable';
        input.dispatchEvent(new window.Event('change'));
        const validating = operation.last();
        try {
            await entered.promise;
            h.settings.setProfileSelection(1, 'profile-b');
            await vi.waitFor(() => expect(keyInput(window).value).toBe('Ctrl + X'));
        } finally { release.resolve(); }
        await validating.catch(() => {});
        expect(operation.errors).toEqual([]);
        expect(hotkeys(h.backend, 1)[0].key).toBe('X');
    } finally { release.resolve(); await h.dispose(); }
});

/**
 * @param {import('jsdom').DOMWindow} window
 * @returns {ReturnType<typeof createHarness>}
 */
async function createArgumentHarness(window) {
    const h = await createHarness(window, false);
    for (const [index, row] of hotkeys(h.backend).entries()) {
        row.action = 'nextEntry';
        row.argument = String(index + 1);
    }
    await h.controller.prepare();
    await h.generic.refresh();
    return h;
}

for (const operation of ['add', 'delete']) {
    for (const outcome of ['success', 'reject-before', 'reject-after']) {
        for (const draft of ['unsent', 'queued']) {
            test(`late ${operation} ${outcome} preserves ${draft} arguments on a surviving revisited row`, async ({window}) => {
                const h = await createArgumentHarness(window);
                const entered = deferred();
                const release = deferred();
                const apply = h.api.modifySettings.getMockImplementation();
                if (typeof apply !== 'function') { throw new Error('Missing save'); }
                h.api.modifySettings.mockImplementationOnce(async (targets, source) => {
                    entered.resolve();
                    await release.promise;
                    if (outcome === 'reject-before') { throw new Error('injected before commit'); }
                    const result = await apply(targets, source);
                    if (outcome === 'reject-after') { throw new Error('injected after commit'); }
                    return result;
                });
                const changing = (operation === 'add' ? h.controller.addEntry({action: 'close', argument: '', key: 'KeyC', modifiers: [], scopes: ['popup'], enabled: true}) : h.controller.deleteEntry(0)).catch(() => {});
                let survivor;
                try {
                    await entered.promise;
                    h.settings.setProfileSelection(1, 'profile-b');
                    await vi.waitFor(() => expect(rows(window)).toHaveLength(1));
                    h.settings.setProfileSelection(0, 'profile-a');
                    await vi.waitFor(() => expect(rows(window)).toHaveLength(2));
                    survivor = argumentInput(window, operation === 'delete' ? 1 : 0);
                    survivor.value = '5';
                    if (draft === 'queued') { survivor.dispatchEvent(new window.Event('change')); }
                } finally { release.resolve(); }
                try {
                    await changing;
                    await settle(h.controller);
                    if (typeof survivor === 'undefined') { throw new Error('Missing surviving argument'); }
                    const persisted = outcome !== 'reject-before';
                    const index = operation === 'delete' && !persisted ? 1 : 0;
                    expect(survivor.isConnected).toBe(true);
                    expect(argumentInput(window, index).value).toBe('5');
                    expect(hotkeys(h.backend)).toHaveLength(operation === 'add' ? (persisted ? 3 : 2) : (persisted ? 1 : 2));
                    expect(hotkeys(h.backend)[index].key).toBe(operation === 'delete' ? 'B' : 'A');
                    expect(hotkeys(h.backend)[index].argument).toBe(draft === 'queued' ? '5' : (operation === 'delete' ? '2' : '1'));
                    if (draft === 'unsent') {
                        survivor.dispatchEvent(new window.Event('change'));
                        await settle(h.controller);
                        expect(hotkeys(h.backend)[index].argument).toBe('5');
                    }
                } finally { await h.dispose(); }
            });
        }
    }
}

for (const outcome of ['success', 'reject-before', 'reject-after']) {
    for (const draft of ['unsent', 'queued']) {
        test(`late field ${outcome} preserves ${draft} arguments after revisiting the profile`, async ({window}) => {
            const h = await createArgumentHarness(window);
            const entered = deferred();
            const release = deferred();
            const apply = h.api.modifySettings.getMockImplementation();
            if (typeof apply !== 'function') { throw new Error('Missing save'); }
            h.api.modifySettings.mockImplementationOnce(async (targets, source) => {
                entered.resolve();
                await release.promise;
                if (outcome === 'reject-before') { throw new Error('injected before commit'); }
                const result = await apply(targets, source);
                if (outcome === 'reject-after') { throw new Error('injected after commit'); }
                return result;
            });
            const originalOperation = captureOperation(entryAt(h.controller), '_setArgument');
            argumentInput(window).value = '4';
            argumentInput(window).dispatchEvent(new window.Event('change'));
            const changing = originalOperation.last().catch(() => {});
            let input;
            try {
                await entered.promise;
                h.settings.setProfileSelection(1, 'profile-b');
                await vi.waitFor(() => expect(rows(window)).toHaveLength(1));
                h.settings.setProfileSelection(0, 'profile-a');
                await vi.waitFor(() => expect(rows(window)).toHaveLength(2));
                input = argumentInput(window);
                input.value = '5';
                if (draft === 'queued') { input.dispatchEvent(new window.Event('change')); }
            } finally { release.resolve(); }
            try {
                await changing;
                await settle(h.controller);
                if (typeof input === 'undefined') { throw new Error('Missing argument'); }
                expect(input.isConnected).toBe(true);
                expect(input.value).toBe('5');
                expect(hotkeys(h.backend)[0].argument).toBe(draft === 'queued' ? '5' : (outcome === 'reject-before' ? '1' : '4'));
                if (draft === 'unsent') {
                    input.dispatchEvent(new window.Event('change'));
                    await settle(h.controller);
                    expect(hotkeys(h.backend)[0].argument).toBe('5');
                }
            } finally { await h.dispose(); }
        });
    }
}

test('a failed old enabled edit cannot undo a newer checkbox ABA sequence', async ({window}) => {
    const h = await createHarness(window);
    const entered = deferred();
    const release = deferred();
    h.api.modifySettings.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return [{error: {name: 'Error', message: 'injected rejection'}}];
    });
    const toggle = /** @type {HTMLInputElement} */ (rows(window)[0].querySelector('.hotkey-list-item-enabled'));
    toggle.checked = false;
    toggle.dispatchEvent(new window.Event('change'));
    try {
        await entered.promise;
        toggle.checked = true;
        toggle.dispatchEvent(new window.Event('change'));
        toggle.checked = false;
        toggle.dispatchEvent(new window.Event('change'));
    } finally { release.resolve(); }
    try {
        await settle(h.controller);
        expect(hotkeys(h.backend)[0].enabled).toBe(false);
        expect(toggle.checked).toBe(false);
    } finally { await h.dispose(); }
});

test('a newer key and modifiers stay atomic after an older key save fails', async ({window}) => {
    const h = await createHarness(window);
    const entered = deferred();
    const release = deferred();
    h.api.modifySettings.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return [{error: {name: 'Error', message: 'injected rejection'}}];
    });
    const input = /** @type {HTMLInputElement} */ (rows(window)[0].querySelector('.hotkey-list-item-input'));
    input.dispatchEvent(new window.KeyboardEvent('keydown', {key: 'q', code: 'KeyQ'}));
    try {
        await entered.promise;
        input.dispatchEvent(new window.KeyboardEvent('keydown', {key: 'r', code: 'KeyR', ctrlKey: true}));
    } finally { release.resolve(); }
    try {
        await settle(h.controller);
        expect(hotkeys(h.backend)[0]).toMatchObject({key: 'KeyR', modifiers: ['ctrl']});
        expect(input.value).toBe('Ctrl + R');
    } finally { await h.dispose(); }
});

test('a later action derives scopes from acknowledged state after an earlier action fails', async ({window}) => {
    const h = await createHarness(window);
    const entered = deferred();
    const release = deferred();
    h.api.modifySettings.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return [{error: {name: 'Error', message: 'injected rejection'}}];
    });
    actionInput(window).value = 'scanSelectedText';
    actionInput(window).dispatchEvent(new window.Event('change'));
    try {
        await entered.promise;
        actionInput(window).value = 'profileNext';
        actionInput(window).dispatchEvent(new window.Event('change'));
    } finally { release.resolve(); }
    try {
        await settle(h.controller);
        expect(hotkeys(h.backend)[0]).toMatchObject({action: 'profileNext', argument: '', scopes: ['popup']});
        expect(actionInput(window).value).toBe('profileNext');
    } finally { await h.dispose(); }
});

test('an obsolete argument widget cannot write into a newly selected action', async ({window}) => {
    const h = await createArgumentHarness(window);
    const entered = deferred();
    const release = deferred();
    const apply = h.api.modifySettings.getMockImplementation();
    if (typeof apply !== 'function') { throw new Error('Missing save'); }
    h.api.modifySettings.mockImplementationOnce(async (targets, source) => {
        entered.resolve();
        await release.promise;
        return await apply(targets, source);
    });
    const oldArgument = argumentInput(window);
    actionInput(window).value = 'toggleOption';
    actionInput(window).dispatchEvent(new window.Event('change'));
    try {
        await entered.promise;
        oldArgument.value = '4';
        oldArgument.dispatchEvent(new window.Event('change'));
    } finally { release.resolve(); }
    try {
        await settle(h.controller);
        expect(hotkeys(h.backend)[0]).toMatchObject({action: 'toggleOption', argument: ''});
        expect(argumentInput(window).value).toBe('');
    } finally { await h.dispose(); }
});

test('failed recovery blocks writes until a verified settings refresh', async ({window}) => {
    const h = await createArgumentHarness(window);
    const operation = captureOperation(entryAt(h.controller), '_setArgument');
    h.api.modifySettings.mockRejectedValueOnce(new Error('primary storage failure'));
    h.api.optionsGet.mockRejectedValueOnce(new Error('recovery read failure'));
    try {
        let input = argumentInput(window);
        input.value = '4';
        input.dispatchEvent(new window.Event('change'));
        await operation.last().catch(() => {});
        await settle(h.controller);
        input.value = '5';
        input.dispatchEvent(new window.Event('change'));
        await settle(h.controller);
        expect(h.api.modifySettings).toHaveBeenCalledTimes(1);
        expect(hotkeys(h.backend)[0].argument).toBe('1');
        await h.settings.refresh();
        input = argumentInput(window);
        input.value = '5';
        input.dispatchEvent(new window.Event('change'));
        await settle(h.controller);
        expect(hotkeys(h.backend)[0].argument).toBe('5');
    } finally { await h.dispose(); }
});

test('unknown structural recovery never copies an old argument draft to another row', async ({window}) => {
    const h = await createArgumentHarness(window);
    const entered = deferred();
    const release = deferred();
    const apply = h.api.modifySettings.getMockImplementation();
    if (typeof apply !== 'function') { throw new Error('Missing save'); }
    h.api.modifySettings.mockImplementationOnce(async (targets, source) => {
        entered.resolve();
        await release.promise;
        return await apply(targets, source);
    });
    const operation = captureOperation(entryAt(h.controller), '_setArgument');
    const input = argumentInput(window);
    input.value = '4';
    input.dispatchEvent(new window.Event('change'));
    try {
        await entered.promise;
        input.value = '5';
        await h.settings.modifyProfileSettings([{action: 'splice', path: 'inputs.hotkeys', start: 0, deleteCount: 1, items: []}]);
    } finally { release.resolve(); }
    try {
        await operation.last().catch(() => {});
        await settle(h.controller);
        expect(hotkeys(h.backend)).toHaveLength(1);
        expect(hotkeys(h.backend)[0]).toMatchObject({key: 'B', argument: '2'});
        expect(input.isConnected).toBe(false);
        expect(argumentInput(window).value).toBe('2');
    } finally { await h.dispose(); }
});

test('a malformed acknowledgement is reconciled before another argument edit', async ({window}) => {
    const h = await createArgumentHarness(window);
    const operation = captureOperation(entryAt(h.controller), '_setArgument');
    h.api.modifySettings.mockResolvedValueOnce([{}]);
    try {
        const input = argumentInput(window);
        input.value = '4';
        input.dispatchEvent(new window.Event('change'));
        await operation.last().catch(() => {});
        await settle(h.controller);
        expect(hotkeys(h.backend)[0].argument).toBe('1');
        expect(input.value).toBe('1');
        input.value = '5';
        input.dispatchEvent(new window.Event('change'));
        await settle(h.controller);
        expect(hotkeys(h.backend)[0].argument).toBe('5');
    } finally { await h.dispose(); }
});

test('a broken first row template does not shift a healthy shortcut backend index', async ({window}) => {
    const h = await createHarness(window, false);
    const instantiate = h.settings.instantiateTemplate.bind(h.settings);
    let count = 0;
    vi.spyOn(h.settings, 'instantiateTemplate').mockImplementation((name) => {
        const node = instantiate(name);
        if (name === 'hotkey-list-item' && ++count === 1) { node.querySelector('.hotkey-list-item-input')?.remove(); }
        return node;
    });
    try {
        await h.controller.prepare();
        expect(rows(window)).toHaveLength(1);
        const input = /** @type {HTMLInputElement} */ (rows(window)[0].querySelector('.hotkey-list-item-input'));
        input.dispatchEvent(new window.KeyboardEvent('keydown', {key: 'q', code: 'KeyQ'}));
        await settle(h.controller);
        expect(hotkeys(h.backend).map(({key}) => key)).toEqual(['A', 'KeyQ']);
    } finally { await h.dispose(); }
});

/**
 * @param {import('jsdom').DOMWindow} window
 * @param {number} [index]
 * @returns {HTMLInputElement}
 */
function keyInput(window, index = 0) {
    return /** @type {HTMLInputElement} */ (rows(window)[index].querySelector('.hotkey-list-item-input'));
}

describe('shortcut reset and normalization contracts', () => {
    test('empty numeric arguments display the normalized stored value', async ({window}) => {
        const h = await createArgumentHarness(window);
        try {
            const input = argumentInput(window);
            input.value = '';
            input.dispatchEvent(new window.Event('change'));
            await settle(h.controller);
            expect(input.value).toBe(hotkeys(h.backend)[0].argument);
            expect(input.value).not.toBe('');
        } finally { await h.dispose(); }
    });

    test('reset argument visibly restores the acknowledged default', async ({window}) => {
        const h = await createArgumentHarness(window);
        try {
            const input = argumentInput(window);
            input.value = '3';
            input.dispatchEvent(new window.Event('change'));
            await settle(h.controller);
            const operation = captureOperation(entryAt(h.controller), '_resetArgument');
            const button = /** @type {HTMLElement} */ (rows(window)[0].querySelector('.hotkey-list-item-button'));
            button.dispatchEvent(new window.CustomEvent('menuClose', {detail: {action: 'resetArgument'}}));
            await operation.last();
            await settle(h.controller);
            expect(hotkeys(h.backend)[0].argument).toBe('1');
            expect(input.value).toBe('1');
        } finally { await h.dispose(); }
    });

    test('global reset remains ordered after an edit already waiting for acknowledgement', async ({window}) => {
        const h = await createHarness(window);
        const entered = deferred();
        const release = deferred();
        const apply = h.api.modifySettings.getMockImplementation();
        if (typeof apply !== 'function') { throw new Error('Missing save'); }
        h.api.modifySettings.mockImplementationOnce(async (targets, source) => {
            entered.resolve();
            await release.promise;
            return await apply(targets, source);
        });
        vi.spyOn(h.controller, 'getDefaultHotkeys').mockResolvedValueOnce([{action: 'close', argument: '', key: 'KeyD', modifiers: [], scopes: ['popup'], enabled: true}]);
        const reset = captureOperation(h.controller, '_reset');
        keyInput(window).dispatchEvent(new window.KeyboardEvent('keydown', {key: 'q', code: 'KeyQ'}));
        try {
            await entered.promise;
            const button = /** @type {HTMLElement} */ (window.document.querySelector('#hotkey-list-reset'));
            button.dispatchEvent(new window.MouseEvent('click', {bubbles: true}));
            await new Promise((resolve) => { setTimeout(resolve, 0); });
        } finally { release.resolve(); }
        try {
            await reset.last();
            await settle(h.controller);
            expect(hotkeys(h.backend)).toHaveLength(1);
            expect(hotkeys(h.backend)[0].key).toBe('KeyD');
            expect(keyInput(window).value).toBe('D');
        } finally { await h.dispose(); }
    });

    test('scope selection and action changes retain the established all-scope behavior', async ({window}) => {
        const h = await createHarness(window);
        try {
            await entryAt(h.controller)._setScopeEnabled('search', true);
            expect(hotkeys(h.backend)[0].scopes).toEqual(['popup', 'search']);
            actionInput(window).value = 'profileNext';
            actionInput(window).dispatchEvent(new window.Event('change'));
            await settle(h.controller);
            expect(hotkeys(h.backend)[0].scopes).toEqual(['popup', 'search', 'web']);
            await entryAt(h.controller)._setScopeEnabled('web', false);
            actionInput(window).value = 'close';
            actionInput(window).dispatchEvent(new window.Event('change'));
            await settle(h.controller);
            expect(hotkeys(h.backend)[0].scopes).toEqual(['popup', 'search']);
        } finally { await h.dispose(); }
    });

    test('row reset finishing after its row is deleted cannot alter the surviving row', async ({window}) => {
        const h = await createHarness(window);
        const entered = deferred();
        const release = deferred();
        const reset = captureOperation(entryAt(h.controller), '_resetInput');
        vi.spyOn(h.controller, 'getDefaultHotkeys').mockImplementationOnce(async () => {
            entered.resolve();
            await release.promise;
            return [{action: 'close', argument: '', key: 'KeyD', modifiers: [], scopes: ['popup'], enabled: true}];
        });
        const button = /** @type {HTMLElement} */ (rows(window)[0].querySelector('.hotkey-list-item-button'));
        button.dispatchEvent(new window.CustomEvent('menuClose', {detail: {action: 'resetInput'}}));
        try {
            await entered.promise;
            await h.controller.deleteEntry(0);
        } finally { release.resolve(); }
        try {
            await reset.last();
            await settle(h.controller);
            expect(hotkeys(h.backend).map(({key}) => key)).toEqual(['B']);
            expect(reset.errors).toEqual([]);
        } finally { await h.dispose(); }
    });

    test('failed argument save preserves and validates a newer unsent path', async ({window}) => {
        const h = await createHarness(window, false);
        hotkeys(h.backend)[0].action = 'toggleOption';
        hotkeys(h.backend)[0].argument = 'general.enable';
        await h.controller.prepare();
        await vi.waitFor(() => expect(argumentInput(window).dataset.invalid).toBe('false'));
        const entered = deferred();
        const release = deferred();
        h.api.modifySettings.mockImplementationOnce(async () => {
            entered.resolve();
            await release.promise;
            return [{error: {name: 'Error', message: 'injected rejection'}}];
        });
        const operation = captureOperation(entryAt(h.controller), '_setArgument');
        const input = argumentInput(window);
        input.value = 'general[';
        input.dispatchEvent(new window.Event('change'));
        try {
            await entered.promise;
            input.value = 'scanning.length';
        } finally { release.resolve(); }
        try {
            await operation.last();
            await settle(h.controller);
            await vi.waitFor(() => expect(input.dataset.invalid).toBe('true'));
            expect(input.value).toBe('scanning.length');
            expect(hotkeys(h.backend)[0].argument).toBe('general.enable');
        } finally { await h.dispose(); }
    });
});

test('global reset still loading defaults cannot discard newer unsent argument typing', async ({window}) => {
    const h = await createArgumentHarness(window);
    const entered = deferred();
    const release = deferred();
    const reset = captureOperation(h.controller, '_reset');
    vi.spyOn(h.controller, 'getDefaultHotkeys').mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return [{action: 'close', argument: '', key: 'KeyD', modifiers: [], scopes: ['popup'], enabled: true}];
    });
    const input = argumentInput(window);
    const button = /** @type {HTMLElement} */ (window.document.querySelector('#hotkey-list-reset'));
    button.dispatchEvent(new window.MouseEvent('click', {bubbles: true}));
    try {
        await entered.promise;
        input.value = '5';
        input.dispatchEvent(new window.Event('input'));
    } finally { release.resolve(); }
    try {
        await reset.last();
        await settle(h.controller);
        expect(input.isConnected).toBe(true);
        expect(input.value).toBe('5');
        expect(hotkeys(h.backend)).toHaveLength(2);
        expect(hotkeys(h.backend)[0].argument).toBe('1');
    } finally { await h.dispose(); }
});

for (const action of ['addNote', 'viewNotes']) {
    test(`card-format choices for ${action} reflect same-window rename add and removal`, async ({window}) => {
        const h = await createHarness(window);
        try {
            const options = await h.settings.getOptions();
            const first = structuredClone(options.anki.cardFormats[0]);
            first.name = 'Renamed format';
            const added = structuredClone(first);
            added.name = 'New format';
            await h.settings.modifyProfileSettings([{action: 'set', path: 'anki.cardFormats', value: [first, added]}]);
            actionInput(window).value = action;
            actionInput(window).dispatchEvent(new window.Event('change'));
            await vi.waitFor(() => expect([...rows(window)[0].querySelectorAll('.anki-card-format-select option')].map((option) => option.textContent)).toEqual(['Renamed format', 'New format']));
            actionInput(window).value = 'close';
            actionInput(window).dispatchEvent(new window.Event('change'));
            await vi.waitFor(() => expect(hotkeys(h.backend)[0].action).toBe('close'));
            await h.settings.modifyProfileSettings([{action: 'splice', path: 'anki.cardFormats', start: 0, deleteCount: 1, items: []}]);
            actionInput(window).value = action;
            actionInput(window).dispatchEvent(new window.Event('change'));
            await vi.waitFor(() => expect([...rows(window)[0].querySelectorAll('.anki-card-format-select option')].map((option) => option.textContent)).toEqual(['New format']));
        } finally { await h.dispose(); }
    });
}

test('a card-format response held across a failed action change retries the restored widget', async ({window}) => {
    const h = await createHarness(window);
    const readEntered = deferred();
    const releaseRead = deferred();
    const saveEntered = deferred();
    const releaseSave = deferred();
    const read = h.api.optionsGet.getMockImplementation();
    if (typeof read !== 'function') { throw new Error('Missing options read'); }
    const entry = entryAt(h.controller);
    const actions = captureOperation(entry, '_setAction');
    const widgets = captureOperation(entry, '_updateActionArgument');
    h.api.optionsGet.mockImplementationOnce(async (context) => {
        const snapshot = await read(context);
        readEntered.resolve();
        await releaseRead.promise;
        return snapshot;
    });
    try {
        actionInput(window).value = 'addNote';
        actionInput(window).dispatchEvent(new window.Event('change'));
        await actions.last();
        await readEntered.promise;
        h.api.modifySettings.mockImplementationOnce(async () => {
            saveEntered.resolve();
            await releaseSave.promise;
            throw new Error('injected action save failure');
        });
        actionInput(window).value = 'playAudio';
        actionInput(window).dispatchEvent(new window.Event('change'));
        await saveEntered.promise;
        releaseRead.resolve();
        await widgets.last();
        expect(rows(window)[0].querySelectorAll('.hotkey-argument-input')).toHaveLength(0);
        releaseSave.resolve();
        await actions.last().catch(() => {});
        await vi.waitFor(() => expect([...rows(window)[0].querySelectorAll('.anki-card-format-select option')].map((option) => option.textContent)).toEqual(['Expression', 'Reading', 'Kanji']));
        expect(actionInput(window).value).toBe('addNote');
        expect(argumentInput(window).value).toBe('0');
        expect(hotkeys(h.backend)[0]).toMatchObject({action: 'addNote', argument: '0'});
        expect(widgets.errors).toEqual([]);
    } finally {
        releaseRead.resolve();
        releaseSave.resolve();
        await settle(h.controller);
        await h.dispose();
    }
});
