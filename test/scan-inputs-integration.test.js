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
import {ScanInputsController} from '../ext/js/pages/settings/scan-inputs-controller.js';
import {ScanInputsSimpleController} from '../ext/js/pages/settings/scan-inputs-simple-controller.js';
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
 * @param {boolean} [prepareControllers]
 * @returns {Promise<{backend: Backend, settings: SettingsController, api: Record<string, ReturnType<typeof vi.fn>>, detailed: ScanInputsController, simple: ScanInputsSimpleController, generic: GenericSettingController, dispose: () => Promise<void>}>}
 */
async function createHarness(window, prepareControllers = true) {
    const {document} = window;
    vi.stubGlobal('Node', window.Node);
    vi.stubGlobal('NodeFilter', window.NodeFilter);
    vi.stubGlobal('chrome', {runtime: {getURL: vi.fn((path) => path)}, permissions: {}});
    const parser = new window.DOMParser();
    const modals = parser.parseFromString(readFileSync(new URL('../ext/templates-modals.html', import.meta.url), 'utf8'), 'text/html');
    for (const template of modals.querySelectorAll('template')) { document.body.appendChild(document.importNode(template.content, true)); }
    const settingsPage = parser.parseFromString(readFileSync(new URL('../ext/settings.html', import.meta.url), 'utf8'), 'text/html');
    for (const id of ['middle-mouse-button-scan', 'main-scan-modifier-key']) {
        const control = settingsPage.getElementById(id);
        if (control === null) { throw new Error('Missing shipped scan control'); }
        document.body.appendChild(document.importNode(control, true));
    }
    const optionsUtil = new OptionsUtil();
    Reflect.set(optionsUtil, '_optionsSchema', new JsonSchema(JSON.parse(readFileSync(new URL('../ext/data/schemas/options-schema.json', import.meta.url), 'utf8'))));
    const options = optionsUtil.getDefault();
    options.profiles[0].id = 'profile-a';
    options.profiles[0].options.scanning.inputs = [ScanInputsController.createDefaultMouseInput('ctrl', 'mouse0'), ScanInputsController.createDefaultMouseInput('alt', 'mouse0')];
    const b = structuredClone(options.profiles[0]);
    b.id = 'profile-b';
    b.options.scanning.inputs = [ScanInputsController.createDefaultMouseInput('shift', 'mouse0')];
    options.profiles.push(b);
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
    const settings = new SettingsController(/** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({on: vi.fn(), api})));
    Reflect.set(settings._templates, 'loadFromFiles', vi.fn(async () => {
        settings._templates.load(parser.parseFromString(readFileSync(new URL('../ext/templates-settings.html', import.meta.url), 'utf8'), 'text/html'));
    }));
    await settings.prepare();
    const generic = new GenericSettingController(settings);
    await generic.prepare();
    const detailed = new ScanInputsController(settings);
    const simple = new ScanInputsSimpleController(settings);
    if (prepareControllers) {
        await detailed.prepare();
        await simple.prepare();
        await generic.refresh();
    }
    return {backend,
        settings,
        api,
        detailed,
        simple,
        generic,
        dispose: async () => {
            Reflect.get(generic, '_dataBinder').disconnect();
            await settle();
            vi.unstubAllGlobals();
        }};
}

/**
 * @param {Backend} backend
 * @param {number} [index]
 * @returns {import('settings').ScanningInput[]}
 */
function inputs(backend, index = 0) { return /** @type {import('settings').Options} */ (Reflect.get(backend, '_options')).profiles[index].options.scanning.inputs; }
/**
 * @param {import('jsdom').DOMWindow} window
 * @returns {Element[]}
 */
function scanRows(window) { return [...window.document.querySelectorAll('#scan-input-list .scan-input')]; }
/**
 * @param {import('jsdom').DOMWindow} window
 * @param {number} [index]
 * @param {string} [property]
 * @returns {HTMLInputElement}
 */
function field(window, index = 0, property = 'include') { return /** @type {HTMLInputElement} */ (scanRows(window)[index].querySelector(`[data-property="${property}"].scan-input-field`)); }
/**
 * @param {import('jsdom').DOMWindow} window
 * @param {number} [index]
 * @param {string} [property]
 * @returns {HTMLInputElement}
 */
function checkbox(window, index = 0, property = 'types.touch') { return /** @type {HTMLInputElement} */ (scanRows(window)[index].querySelector(`input[data-property="${property}"]`)); }
/**
 * @param {import('jsdom').DOMWindow} window
 * @returns {HTMLSelectElement}
 */
function mainControl(window) { return /** @type {HTMLSelectElement} */ (window.document.getElementById('main-scan-modifier-key')); }
/**
 * @param {import('jsdom').DOMWindow} window
 * @returns {HTMLInputElement}
 */
function middleControl(window) { return /** @type {HTMLInputElement} */ (window.document.getElementById('middle-mouse-button-scan')); }
/**
 * @param {import('jsdom').DOMWindow} window
 * @param {Element} input
 */
function change(window, input) { input.dispatchEvent(new window.Event('change', {bubbles: true})); }
/**
 * @param {{detailed: ScanInputsController, simple: ScanInputsSimpleController}} [h]
 */
async function settle(h) {
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    if (h) {
        await Reflect.get(h.detailed, '_mutationTail');
        await Reflect.get(h.simple, '_mutationTail');
    }
    await new Promise((resolve) => { setTimeout(resolve, 0); });
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


describe('scan inputs shipped controls and real settings pipeline', () => {
    test('ordinary advanced and simple controls persist and synchronize', async ({window}) => {
        const h = await createHarness(window);
        try {
            checkbox(window).checked = true;
            change(window, checkbox(window));
            await vi.waitFor(() => expect(inputs(h.backend)[0].types.touch).toBe(true));
            mainControl(window).value = 'shift';
            change(window, mainControl(window));
            await vi.waitFor(() => expect(inputs(h.backend)[0].include).toBe('shift'));
            await vi.waitFor(() => expect(field(window).value).toBe('Shift'));
            middleControl(window).checked = true;
            change(window, middleControl(window));
            await vi.waitFor(() => expect(inputs(h.backend).filter((row) => row.include === 'mouse2')).toHaveLength(1));
        } finally { await h.dispose(); }
    });

    for (const editor of /** @type {('detailed'|'simple')[]} */ (['detailed', 'simple'])) {
        test(`late initial ${editor} read cannot repaint same-index replacement profile`, async ({window}) => {
            const h = await createHarness(window, false);
            const entered = deferred();
            const release = deferred();
            const read = h.api.optionsGet.getMockImplementation();
            if (!read) { throw new Error('Missing read'); }
            h.api.optionsGet.mockImplementationOnce(async (context) => {
                const snapshot = await read(context);
                entered.resolve();
                await release.promise;
                return snapshot;
            });
            const preparing = h[editor].prepare();
            try {
                await entered.promise;
                const full = /** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options'));
                full.profiles.splice(0, 1);
                h.settings.setProfileSelection(0, 'profile-b');
                await vi.waitFor(() => expect(editor === 'detailed' ? field(window).value : mainControl(window).value).toBe(editor === 'detailed' ? 'Shift' : 'shift'));
            } finally {
                release.resolve();
                await preparing;
            }
            try {
                await settle(h);
                expect(editor === 'detailed' ? field(window).value : mainControl(window).value).toBe(editor === 'detailed' ? 'Shift' : 'shift');
            } finally { await h.dispose(); }
        });
    }

    test('visible old-profile checkbox cannot edit replacement profile while refresh waits', async ({window}) => {
        const h = await createHarness(window);
        const old = checkbox(window);
        const entered = deferred();
        const release = deferred();
        const read = h.api.optionsGet.getMockImplementation();
        if (!read) { throw new Error('Missing read'); }
        h.api.optionsGet.mockImplementationOnce(async (context) => {
            const snapshot = await read(context);
            entered.resolve();
            await release.promise;
            return snapshot;
        });
        try {
            h.settings.setProfileSelection(1, 'profile-b');
            await entered.promise;
            old.checked = true;
            change(window, old);
            await settle();
        } finally { release.resolve(); }
        try {
            await vi.waitFor(() => expect(field(window).value).toBe('Shift'));
            await settle(h);
            expect(inputs(h.backend, 1)[0].types.touch).toBe(false);
        } finally { await h.dispose(); }
    });

    test('held indexed checkbox save cannot edit the row shifted into a deleted index', async ({window}) => {
        const h = await createHarness(window);
        const entered = deferred();
        const release = deferred();
        const modify = h.api.modifySettings.getMockImplementation();
        if (!modify) { throw new Error('Missing writer'); }
        h.api.modifySettings.mockImplementationOnce(async (targets, source) => {
            entered.resolve();
            await release.promise;
            return await modify(targets, source);
        });
        checkbox(window).checked = true;
        change(window, checkbox(window));
        try {
            await entered.promise;
            await h.settings.modifyProfileSettings([{action: 'splice', path: 'scanning.inputs', start: 0, deleteCount: 1, items: []}]);
        } finally { release.resolve(); }
        try {
            await settle(h);
            expect(inputs(h.backend)).toHaveLength(1);
            expect(inputs(h.backend)[0]).toMatchObject({include: 'alt', types: {touch: false}});
        } finally { await h.dispose(); }
    });

    test('rapid middle-mouse enable disable enable does not create duplicate rules', async ({window}) => {
        const h = await createHarness(window);
        const op = captureOperation(h.simple, '_handleMiddleMouseButtonScanChange');
        try {
            const operations = [];
            for (const value of [true, false, true]) {
                middleControl(window).checked = value;
                change(window, middleControl(window));
                operations.push(op.last());
            }
            await Promise.all(operations);
            await settle(h);
            expect(inputs(h.backend).filter((row) => row.include === 'mouse2')).toHaveLength(1);
            expect(middleControl(window).checked).toBe(true);
        } finally { await h.dispose(); }
    });

    test('a delayed older modifier read cannot override the newer modifier intent', async ({window}) => {
        const h = await createHarness(window);
        const entered = deferred();
        const release = deferred();
        const read = h.api.optionsGet.getMockImplementation();
        if (!read) { throw new Error('Missing read'); }
        h.api.optionsGet.mockImplementationOnce(async (context) => {
            const snapshot = await read(context);
            entered.resolve();
            await release.promise;
            return snapshot;
        });
        const op = captureOperation(h.simple, '_handleMainScanModifierKeyInputChange');
        mainControl(window).value = 'alt';
        change(window, mainControl(window));
        const first = op.last();
        try {
            await Promise.race([entered.promise, first]);
            mainControl(window).value = 'shift';
            change(window, mainControl(window));
            const second = op.last();
            await settle();
            release.resolve();
            await Promise.all([first, second]);
            await settle(h);
            expect(inputs(h.backend)[0].include).toBe('shift');
            expect(mainControl(window).value).toBe('shift');
        } finally {
            release.resolve();
            await h.dispose();
        }
    });

    test('older failed modifier save cannot restore over a newer choice', async ({window}) => {
        const h = await createHarness(window);
        const entered = deferred();
        const release = deferred();
        h.api.modifySettings.mockImplementationOnce(async () => {
            entered.resolve();
            await release.promise;
            throw new Error('injected save failure');
        });
        const op = captureOperation(h.simple, '_handleMainScanModifierKeyInputChange');
        mainControl(window).value = 'alt';
        change(window, mainControl(window));
        const first = op.last().catch(() => {});
        try {
            await entered.promise;
            mainControl(window).value = 'shift';
            change(window, mainControl(window));
            const second = op.last().catch(() => {});
            await settle();
            release.resolve();
            await Promise.all([first, second]);
            await settle(h);
            expect(inputs(h.backend)[0].include).toBe('shift');
            expect(mainControl(window).value).toBe('shift');
        } finally { release.resolve(); await h.dispose(); }
    });

    test('a serialized backend error restores the acknowledged middle-mouse control', async ({window}) => {
        const h = await createHarness(window);
        h.api.modifySettings.mockResolvedValueOnce([{error: {name: 'Error', message: 'injected validation failure'}}]);
        const op = captureOperation(h.simple, '_handleMiddleMouseButtonScanChange');
        try {
            middleControl(window).checked = true;
            change(window, middleControl(window));
            await op.last().catch(() => {});
            await settle(h);
            expect(inputs(h.backend).filter((row) => row.include === 'mouse2')).toHaveLength(0);
            expect(middleControl(window).checked).toBe(false);
        } finally { await h.dispose(); }
    });

    test('changing an advanced mouse type updates the simple modifier summary', async ({window}) => {
        const h = await createHarness(window);
        // Make the first row the only simple main input while keeping the other row installed.
        await h.settings.modifyProfileSettings([{action: 'set', path: 'scanning.inputs[1].exclude', value: ''}]);
        await h.detailed.refresh();
        try {
            checkbox(window, 0, 'types.mouse').checked = false;
            change(window, checkbox(window, 0, 'types.mouse'));
            await vi.waitFor(() => expect(inputs(h.backend)[0].types.mouse).toBe(false));
            await settle(h);
            expect(mainControl(window).value).toBe('other');
        } finally { await h.dispose(); }
    });

    test('a broken first row template cannot make the healthy second row undeletable', async ({window}) => {
        const h = await createHarness(window, false);
        const instantiate = h.settings.instantiateTemplate.bind(h.settings);
        let first = true;
        vi.spyOn(h.settings, 'instantiateTemplate').mockImplementation((name) => {
            if (name === 'scan-input' && first) {
                first = false;
                return window.document.createElement('div');
            }
            return instantiate(name);
        });
        try {
            await h.detailed.prepare();
            await h.generic.refresh();
            expect(scanRows(window)).toHaveLength(1);
            const menu = /** @type {HTMLElement} */ (scanRows(window)[0].querySelector('.scanning-input-menu-button'));
            menu.dispatchEvent(new window.CustomEvent('menuClose', {detail: {action: 'remove'}}));
            await settle(h);
            expect(inputs(h.backend).map((row) => row.include)).toEqual(['ctrl']);
        } finally { await h.dispose(); }
    });
});

describe('scan input acknowledgement and cross-editor boundaries', () => {
    for (const editor of /** @type {('detailed'|'simple')[]} */ (['detailed', 'simple'])) {
        test(`an older ${editor} refresh cannot repaint a newer acknowledged save`, async ({window}) => {
            const h = await createHarness(window);
            const entered = deferred();
            const release = deferred();
            const read = h.api.optionsGet.getMockImplementation();
            if (!read) { throw new Error('Missing read'); }
            h.api.optionsGet.mockImplementationOnce(async (context) => {
                const snapshot = await read(context);
                entered.resolve();
                await release.promise;
                return snapshot;
            });
            const refreshing = h[editor].refresh();
            try {
                await entered.promise;
                if (editor === 'detailed') {
                    checkbox(window).checked = true;
                    change(window, checkbox(window));
                    await vi.waitFor(() => expect(inputs(h.backend)[0].types.touch).toBe(true));
                } else {
                    mainControl(window).value = 'shift';
                    change(window, mainControl(window));
                    await vi.waitFor(() => expect(inputs(h.backend)[0].include).toBe('shift'));
                }
            } finally {
                release.resolve();
                await refreshing;
            }
            try {
                await settle(h);
                expect(editor === 'detailed' ? checkbox(window).checked : mainControl(window).value).toBe(editor === 'detailed' ? true : 'shift');
            } finally { await h.dispose(); }
        });
    }

    test('a simple modifier edit retries against an advanced change without losing it', async ({window}) => {
        const h = await createHarness(window);
        const entered = deferred();
        const release = deferred();
        const modify = h.api.modifySettings.getMockImplementation();
        if (!modify) { throw new Error('Missing writer'); }
        h.api.modifySettings.mockImplementationOnce(async (targets, source) => {
            entered.resolve();
            await release.promise;
            return await modify(targets, source);
        });
        const op = captureOperation(h.simple, '_handleMainScanModifierKeyInputChange');
        mainControl(window).value = 'shift';
        change(window, mainControl(window));
        const saving = op.last();
        try {
            await entered.promise;
            checkbox(window).checked = true;
            change(window, checkbox(window));
            await vi.waitFor(() => expect(inputs(h.backend)[0].types.touch).toBe(true));
        } finally { release.resolve(); }
        try {
            await saving;
            await settle(h);
            expect(inputs(h.backend)[0]).toMatchObject({include: 'shift', types: {touch: true}});
        } finally { await h.dispose(); }
    });

    for (const editor of /** @type {('detailed'|'simple')[]} */ (['detailed', 'simple'])) {
        test(`a lost ${editor} acknowledgement recovers committed data before the next edit`, async ({window}) => {
            const h = await createHarness(window);
            const modify = h.api.modifySettings.getMockImplementation();
            if (!modify) { throw new Error('Missing writer'); }
            h.api.modifySettings.mockImplementationOnce(async (targets, source) => {
                await modify(targets, source);
                throw new Error('injected lost acknowledgement');
            });
            const op = captureOperation(editor === 'detailed' ? h.detailed : h.simple, editor === 'detailed' ? 'setProperty' : '_handleMiddleMouseButtonScanChange');
            try {
                if (editor === 'detailed') {
                    checkbox(window).checked = true;
                    change(window, checkbox(window));
                } else {
                    middleControl(window).checked = true;
                    change(window, middleControl(window));
                }
                await op.last().catch(() => {});
                await settle(h);
                if (editor === 'detailed') {
                    expect(checkbox(window).checked).toBe(true);
                    checkbox(window, 0, 'types.pen').checked = true;
                    change(window, checkbox(window, 0, 'types.pen'));
                    await op.last();
                    expect(inputs(h.backend)[0].types).toMatchObject({touch: true, pen: true});
                } else {
                    expect(middleControl(window).checked).toBe(true);
                    middleControl(window).checked = false;
                    change(window, middleControl(window));
                    await op.last();
                    expect(inputs(h.backend).filter((row) => row.include === 'mouse2')).toHaveLength(0);
                }
            } finally { await h.dispose(); }
        });
    }

    test('an older failed advanced checkbox edit cannot undo a newer ABA sequence', async ({window}) => {
        const h = await createHarness(window);
        const entered = deferred();
        const release = deferred();
        h.api.modifySettings.mockImplementationOnce(async () => {
            entered.resolve();
            await release.promise;
            throw new Error('injected checkbox save failure');
        });
        const op = captureOperation(h.detailed, 'setProperty');
        checkbox(window).checked = true;
        change(window, checkbox(window));
        const first = op.last().catch(() => {});
        try {
            await entered.promise;
            checkbox(window).checked = false;
            change(window, checkbox(window));
            const second = op.last();
            checkbox(window).checked = true;
            change(window, checkbox(window));
            const third = op.last();
            release.resolve();
            await Promise.all([first, second, third]);
            await settle(h);
            expect(inputs(h.backend)[0].types.touch).toBe(true);
            expect(checkbox(window).checked).toBe(true);
        } finally {
            release.resolve();
            await h.dispose();
        }
    });

    test('empty advanced numeric input displays the normalized stored value', async ({window}) => {
        const h = await createHarness(window);
        const input = /** @type {HTMLInputElement} */ (scanRows(window)[0].querySelector('[data-property="options.minimumTouchTime"]'));
        const op = captureOperation(h.detailed, 'setProperty');
        try {
            input.value = '';
            change(window, input);
            await op.last();
            expect(inputs(h.backend)[0].options.minimumTouchTime).toBe(0);
            expect(input.value).toBe('0');
        } finally { await h.dispose(); }
    });

    for (const editor of /** @type {('detailed'|'simple')[]} */ (['detailed', 'simple'])) {
        test(`failed ${editor} recovery blocks writes until a verified refresh`, async ({window}) => {
            const h = await createHarness(window);
            h.api.modifySettings.mockRejectedValueOnce(new Error('primary storage failure'));
            h.api.optionsGet.mockRejectedValueOnce(new Error('recovery read failure'));
            const op = captureOperation(editor === 'detailed' ? h.detailed : h.simple, editor === 'detailed' ? 'setProperty' : '_handleMiddleMouseButtonScanChange');
            const send = () => {
                if (editor === 'detailed') {
                    checkbox(window).checked = true;
                    change(window, checkbox(window));
                } else {
                    middleControl(window).checked = true;
                    change(window, middleControl(window));
                }
            };
            try {
                send();
                await op.last().catch(() => {});
                const writes = h.api.modifySettings.mock.calls.length;
                send();
                await op.last();
                expect(h.api.modifySettings).toHaveBeenCalledTimes(writes);
                await h[editor].refresh();
                send();
                await op.last();
                expect(h.api.modifySettings).toHaveBeenCalledTimes(writes + 1);
            } finally { await h.dispose(); }
        });
    }

    for (const control of ['main', 'middle']) {
        test(`visible old-profile simple ${control} control cannot write while profile B refresh waits`, async ({window}) => {
            const h = await createHarness(window);
            const entered = deferred();
            const release = deferred();
            const read = h.api.optionsGet.getMockImplementation();
            if (!read) { throw new Error('Missing read'); }
            h.api.optionsGet.mockImplementationOnce(async (context) => {
                const snapshot = await read(context);
                entered.resolve();
                await release.promise;
                return snapshot;
            });
            try {
                h.settings.setProfileSelection(1, 'profile-b');
                await entered.promise;
                if (control === 'main') {
                    mainControl(window).value = 'alt';
                    change(window, mainControl(window));
                } else {
                    middleControl(window).checked = true;
                    change(window, middleControl(window));
                }
                await settle();
            } finally { release.resolve(); }
            try {
                await vi.waitFor(() => expect(mainControl(window).value).toBe('shift'));
                await settle(h);
                expect(inputs(h.backend, 1).map((row) => row.include)).toEqual(['shift']);
            } finally { await h.dispose(); }
        });
    }
});

describe('scan input review follow-ups', () => {
    for (const inserting of [true, false]) {
        test(`known simple ${inserting ? 'insertion' : 'deletion'} retains queued advanced edits and unsent drafts`, async ({window}) => {
            const h = await createHarness(window);
            if (!inserting) {
                const rows = structuredClone(inputs(h.backend));
                rows.splice(1, 0, ScanInputsController.createDefaultMouseInput('mouse2', ''));
                await h.settings.modifyProfileSettings([{action: 'set', path: 'scanning.inputs', value: rows}]);
                await h.detailed.refresh();
                await h.simple.refresh();
            }
            const index = inserting ? 1 : 2;
            const survivor = scanRows(window)[index];
            const draft = field(window, index, 'exclude');
            draft.value = 'unsent draft';
            const entered = deferred();
            const release = deferred();
            const modify = h.api.modifySettings.getMockImplementation();
            if (!modify) { throw new Error('Missing writer'); }
            h.api.modifySettings.mockImplementationOnce(async (targets, source) => {
                entered.resolve();
                await release.promise;
                return await modify(targets, source);
            });
            const op = captureOperation(h.detailed, 'setProperty');
            checkbox(window, index).checked = true;
            change(window, checkbox(window, index));
            const first = op.last();
            try {
                await entered.promise;
                checkbox(window, index, 'types.pen').checked = true;
                change(window, checkbox(window, index, 'types.pen'));
                const second = op.last();
                const simpleOp = captureOperation(h.simple, '_handleMiddleMouseButtonScanChange');
                middleControl(window).checked = inserting;
                change(window, middleControl(window));
                await simpleOp.last();
                const newIndex = inserting ? 2 : 1;
                expect(scanRows(window)[newIndex]).toBe(survivor);
                expect(field(window, newIndex, 'exclude')).toBe(draft);
                expect(draft.value).toBe('unsent draft');
                release.resolve();
                await Promise.all([first, second]);
                await settle(h);
                expect(inputs(h.backend)[newIndex]).toMatchObject({include: 'alt', exclude: 'mouse0', types: {touch: true, pen: true}});
                expect(draft.value).toBe('unsent draft');
            } finally { release.resolve(); await h.dispose(); }
        });
    }

    test('an earlier queued advanced modifier cannot overwrite a later simple modifier', async ({window}) => {
        const h = await createHarness(window);
        const entered = deferred();
        const release = deferred();
        const modify = h.api.modifySettings.getMockImplementation();
        if (!modify) { throw new Error('Missing writer'); }
        h.api.modifySettings.mockImplementationOnce(async (targets, source) => {
            entered.resolve();
            await release.promise;
            return await modify(targets, source);
        });
        const op = captureOperation(h.detailed, 'setProperty');
        checkbox(window).checked = true;
        change(window, checkbox(window));
        const first = op.last();
        try {
            await entered.promise;
            field(window).dispatchEvent(new window.KeyboardEvent('keydown', {key: 'Alt', code: 'AltLeft', altKey: true, bubbles: true}));
            const second = op.last();
            mainControl(window).value = 'shift';
            change(window, mainControl(window));
            await vi.waitFor(() => expect(inputs(h.backend)[0].include).toBe('shift'));
            await settle();
            release.resolve();
            await Promise.all([first, second]);
            await settle(h);
            expect(inputs(h.backend)[0]).toMatchObject({include: 'shift', types: {touch: true}});
            expect(field(window).value).toBe('Shift');
        } finally { release.resolve(); await h.dispose(); }
    });

    for (const structural of [false, true]) {
        test(`a delayed committed advanced ${structural ? 'add' : 'field'} acknowledgement preserves the later simple mutation and queued edit`, async ({window}) => {
            const h = await createHarness(window);
            const entered = deferred();
            const release = deferred();
            const modify = h.api.modifySettings.getMockImplementation();
            if (!modify) { throw new Error('Missing writer'); }
            h.api.modifySettings.mockImplementationOnce(async (targets, source) => {
                const result = await modify(targets, source);
                entered.resolve();
                await release.promise;
                return result;
            });
            const op = captureOperation(h.detailed, 'setProperty');
            let first;
            if (structural) {
                first = h.detailed.addInput();
            } else {
                checkbox(window).checked = true;
                change(window, checkbox(window));
                first = op.last();
            }
            try {
                await entered.promise;
                checkbox(window, 0, 'types.pen').checked = true;
                change(window, checkbox(window, 0, 'types.pen'));
                const second = op.last();
                const simpleOp = captureOperation(h.simple, '_handleMainScanModifierKeyInputChange');
                mainControl(window).value = 'shift';
                change(window, mainControl(window));
                await simpleOp.last();
                release.resolve();
                await Promise.all([first, second]);
                await settle(h);
                expect(inputs(h.backend)[0]).toMatchObject({include: 'shift', types: {touch: !structural, pen: true}});
                expect(scanRows(window)).toHaveLength(structural ? 3 : 2);
                expect(field(window).value).toBe('Shift');
                expect(checkbox(window, 0, 'types.pen').checked).toBe(true);
            } finally { release.resolve(); await h.dispose(); }
        });
    }

    test('a delayed simple acknowledgement cannot repaint a later advanced change', async ({window}) => {
        const h = await createHarness(window);
        const entered = deferred();
        const release = deferred();
        const modify = h.api.modifySettings.getMockImplementation();
        if (!modify) { throw new Error('Missing writer'); }
        h.api.modifySettings.mockImplementationOnce(async (targets, source) => {
            const result = await modify(targets, source);
            entered.resolve();
            await release.promise;
            return result;
        });
        const op = captureOperation(h.simple, '_handleMainScanModifierKeyInputChange');
        mainControl(window).value = 'shift';
        change(window, mainControl(window));
        const first = op.last();
        try {
            await entered.promise;
            await h.detailed.refresh();
            checkbox(window, 0, 'types.mouse').checked = false;
            change(window, checkbox(window, 0, 'types.mouse'));
            await vi.waitFor(() => expect(inputs(h.backend)[0].types.mouse).toBe(false));
            await settle();
            release.resolve();
            await first;
            await settle(h);
            expect(inputs(h.backend)[0]).toMatchObject({include: 'shift', types: {mouse: false}});
            expect(mainControl(window).value).toBe('alt');
            expect(checkbox(window, 0, 'types.mouse').checked).toBe(false);
        } finally { release.resolve(); await h.dispose(); }
    });

    test('a simple change preserves queued advanced edits on the known surviving row', async ({window}) => {
        const h = await createHarness(window);
        const entered = deferred();
        const release = deferred();
        const modify = h.api.modifySettings.getMockImplementation();
        if (!modify) { throw new Error('Missing writer'); }
        h.api.modifySettings.mockImplementationOnce(async (targets, source) => {
            entered.resolve();
            await release.promise;
            return await modify(targets, source);
        });
        const op = captureOperation(h.detailed, 'setProperty');
        checkbox(window).checked = true;
        change(window, checkbox(window));
        const first = op.last();
        try {
            await entered.promise;
            checkbox(window, 0, 'types.pen').checked = true;
            change(window, checkbox(window, 0, 'types.pen'));
            const second = op.last();
            mainControl(window).value = 'shift';
            change(window, mainControl(window));
            await vi.waitFor(() => expect(inputs(h.backend)[0].include).toBe('shift'));
            await settle();
            release.resolve();
            await Promise.all([first, second]);
            await settle(h);
            expect(inputs(h.backend)[0]).toMatchObject({include: 'shift', types: {touch: true, pen: true}});
            expect(checkbox(window, 0, 'types.pen').checked).toBe(true);
        } finally {
            release.resolve();
            await h.dispose();
        }
    });

    test('turning middle-mouse scanning off removes all pre-existing matching duplicate rules', async ({window}) => {
        const h = await createHarness(window);
        try {
            const duplicate = ScanInputsController.createDefaultMouseInput('mouse2', '');
            const inserted = await h.settings.modifyProfileSettings([{action: 'set', path: 'scanning.inputs', value: [inputs(h.backend)[0], duplicate, structuredClone(duplicate), ...inputs(h.backend).slice(1)]}]);
            expect(inserted[0]?.error).toBeUndefined();
            expect(inputs(h.backend).filter((row) => row.include === 'mouse2')).toHaveLength(2);
            await h.simple.refresh();
            const op = captureOperation(h.simple, '_handleMiddleMouseButtonScanChange');
            expect({checked: middleControl(window).checked, saved: Reflect.get(h.simple, '_savedInputs'), rows: inputs(h.backend)}).toMatchObject({checked: true});
            middleControl(window).checked = false;
            change(window, middleControl(window));
            await op.last();
            await settle(h);
            expect(inputs(h.backend).filter((row) => row.include === 'mouse2')).toHaveLength(0);
            expect(middleControl(window).checked).toBe(false);
            expect(inputs(h.backend).map((row) => row.include)).toEqual(['ctrl', 'alt']);
        } finally { await h.dispose(); }
    });
});
