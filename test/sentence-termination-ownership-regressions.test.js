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
import {SentenceTerminationCharactersController} from '../ext/js/pages/settings/sentence-termination-characters-controller.js';
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
 * @returns {Promise<{backend: Backend, settings: SettingsController, settingsApi: {optionsGetFull: import('vitest').Mock, optionsGet: import('vitest').Mock, modifySettings: import('vitest').Mock, getSettings: import('vitest').Mock}, controller: SentenceTerminationCharactersController, saveOptions: import('vitest').Mock}>}
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
    if (document.querySelector('#sentence-termination-characters-modal') === null) { throw new Error('Shipped sentence modal missing'); }

    const optionsUtil = new OptionsUtil();
    const schema = JSON.parse(readFileSync(new URL('../ext/data/schemas/options-schema.json', import.meta.url), 'utf8'));
    Reflect.set(optionsUtil, '_optionsSchema', new JsonSchema(schema));
    const options = optionsUtil.getDefault();
    options.profiles[0].id = 'profile-a';
    options.profiles[0].options.sentenceParsing.terminationCharacters = [
        {enabled: true, character1: 'A', character2: null, includeCharacterAtStart: false, includeCharacterAtEnd: false},
        {enabled: true, character1: 'B', character2: null, includeCharacterAtStart: false, includeCharacterAtEnd: false},
    ];
    const profileB = structuredClone(options.profiles[0]);
    profileB.id = 'profile-b';
    profileB.options.sentenceParsing.terminationCharacters = [
        {enabled: true, character1: 'X', character2: null, includeCharacterAtStart: false, includeCharacterAtEnd: false},
        {enabled: true, character1: 'Y', character2: null, includeCharacterAtStart: false, includeCharacterAtEnd: false},
    ];
    options.profiles.push(profileB);

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
    const controller = new SentenceTerminationCharactersController(settings);
    if (prepareController) { await controller.prepare(); }
    return {backend, settings, settingsApi, controller, saveOptions};
}


/**
 * @param {import('jsdom').DOMWindow} window
 * @returns {string[]}
 */
function visibleCharacters(window) {
    return [...window.document.querySelectorAll('.sentence-termination-character-input1')].map((node) => /** @type {HTMLInputElement} */ (node).value);
}

describe('sentence editor confirmed production ownership regressions', () => {
    test('a delayed initial A read cannot replace B at the same selected index', async ({window}) => {
        const h = await createHarness(window, false);
        const entered = deferred();
        const release = deferred();
        const read = h.settingsApi.optionsGet.getMockImplementation();
        if (typeof read !== 'function') { throw new Error('Missing options transport'); }
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
            await vi.waitFor(() => expect(visibleCharacters(window)).toEqual(['X', 'Y']));
        } finally {
            release.resolve();
            await preparing;
        }
        expect(visibleCharacters(window)).toEqual(['X', 'Y']);
    });

    test('visible A controls cannot write into B while its same-index refresh is pending', async ({window}) => {
        const h = await createHarness(window);
        const input = /** @type {HTMLInputElement} */ (window.document.querySelector('.sentence-termination-character-input1'));
        const entry = h.controller.getEntry(0);
        if (entry === null) { throw new Error('First row was not prepared'); }
        const changed = vi.spyOn(/** @type {any} */ (entry), '_setCharacterValue');
        const entered = deferred();
        const release = deferred();
        const read = h.settingsApi.optionsGet.getMockImplementation();
        if (typeof read !== 'function') { throw new Error('Missing options transport'); }
        h.settingsApi.optionsGet.mockImplementationOnce(async (context) => {
            const snapshot = await read(context);
            entered.resolve();
            await release.promise;
            return snapshot;
        });
        const full = /** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options'));
        full.profiles.splice(0, 1);
        h.settings.setProfileSelection(0, 'profile-b');
        try {
            await entered.promise;
            input.value = 'Q';
            input.dispatchEvent(new window.Event('change'));
            await Promise.allSettled(changed.mock.results.map((result) => result.value));
            const saved = /** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options'));
            expect(saved.profiles[0].options.sentenceParsing.terminationCharacters.map(({character1}) => character1)).toEqual(['X', 'Y']);
            expect(h.settingsApi.modifySettings).not.toHaveBeenCalled();
        } finally {
            release.resolve();
        }
        await vi.waitFor(() => expect(visibleCharacters(window)).toEqual(['X', 'Y']));
    });

    test('a delayed row write cannot mutate the row which replaces it after deletion', async ({window}) => {
        const h = await createHarness(window);
        const entered = deferred();
        const release = deferred();
        const apply = h.settingsApi.modifySettings.getMockImplementation();
        if (typeof apply !== 'function') { throw new Error('Missing mutation transport'); }
        h.settingsApi.modifySettings.mockImplementationOnce(async (targets, source) => {
            entered.resolve();
            await release.promise;
            return await apply(targets, source);
        });
        const entry = h.controller.getEntry(0);
        if (entry === null) { throw new Error('First row was not prepared'); }
        const changed = vi.spyOn(/** @type {any} */ (entry), '_setCharacterValue');
        const input = /** @type {HTMLInputElement} */ (window.document.querySelector('.sentence-termination-character-input1'));
        input.value = 'Q';
        input.dispatchEvent(new window.Event('change'));
        try {
            await entered.promise;
            await h.settings.modifyProfileSettings([{action: 'splice', path: 'sentenceParsing.terminationCharacters', start: 0, deleteCount: 1, items: []}]);
        } finally {
            release.resolve();
        }
        await Promise.allSettled(changed.mock.results.map((result) => result.value));
        const saved = /** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options'));
        expect(saved.profiles[0].options.sentenceParsing.terminationCharacters.map(({character1}) => character1)).toEqual(['B']);
    });

    test('a late old success cannot replace a newer acknowledged character', async ({window}) => {
        const h = await createHarness(window);
        const entered = deferred();
        const release = deferred();
        const apply = h.settingsApi.modifySettings.getMockImplementation();
        if (typeof apply !== 'function') { throw new Error('Missing mutation transport'); }
        h.settingsApi.modifySettings.mockImplementationOnce(async (targets, source) => {
            const response = await apply(targets, source);
            entered.resolve();
            await release.promise;
            return response;
        });
        const entry = h.controller.getEntry(0);
        if (entry === null) { throw new Error('First row was not prepared'); }
        const changed = vi.spyOn(/** @type {any} */ (entry), '_setCharacterValue');
        const input = /** @type {HTMLInputElement} */ (window.document.querySelector('.sentence-termination-character-input1'));
        input.value = 'Q';
        input.dispatchEvent(new window.Event('change'));
        try {
            await entered.promise;
            input.value = 'R';
            input.dispatchEvent(new window.Event('change'));
            await new Promise((resolve) => { setTimeout(resolve, 0); });
        } finally {
            release.resolve();
        }
        await changed.mock.results[0].value;
        await h.controller._mutationTail;
        const saved = /** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options'));
        expect(saved.profiles[0].options.sentenceParsing.terminationCharacters[0].character1).toBe('R');
        expect(input.value).toBe('R');
        expect(entry.data.character1).toBe('R');
    });

    test('a rejected empty character save preserves newer unsent typing', async ({window}) => {
        const h = await createHarness(window);
        const entered = deferred();
        const release = deferred();
        const apply = h.settingsApi.modifySettings.getMockImplementation();
        if (typeof apply !== 'function') { throw new Error('Missing mutation transport'); }
        h.settingsApi.modifySettings.mockImplementationOnce(async (targets, source) => {
            const response = await apply(targets, source);
            entered.resolve();
            await release.promise;
            return response;
        });
        const entry = h.controller.getEntry(0);
        if (entry === null) { throw new Error('First row was not prepared'); }
        const changed = vi.spyOn(/** @type {any} */ (entry), '_setCharacterValue');
        const input = /** @type {HTMLInputElement} */ (window.document.querySelector('.sentence-termination-character-input1'));
        input.value = '';
        input.dispatchEvent(new window.Event('change'));
        try {
            await entered.promise;
            input.value = 'R';
        } finally {
            release.resolve();
        }
        await changed.mock.results[0].value;
        const saved = /** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options'));
        expect(saved.profiles[0].options.sentenceParsing.terminationCharacters[0].character1).toBe('A');
        expect(input.value).toBe('R');
    });

    test('checkbox edits use the guarded sentence rows and persist their field', async ({window}) => {
        const h = await createHarness(window);
        const checkbox = /** @type {HTMLInputElement} */ (window.document.querySelector('.sentence-termination-character-enabled'));
        checkbox.checked = false;
        checkbox.dispatchEvent(new window.Event('change'));
        await h.controller._mutationTail;
        const rows = /** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options')).profiles[0].options.sentenceParsing.terminationCharacters;
        expect(rows[0].enabled).toBe(false);
        expect(h.settingsApi.modifySettings.mock.calls[0][0][0]).toMatchObject({expectedValue: expect.any(Array), profileId: 'profile-a'});
    });

    test('a transport failure triggers a verified refresh and allows a later edit', async ({window}) => {
        const h = await createHarness(window);
        h.settingsApi.modifySettings.mockRejectedValueOnce(new Error('transport unavailable'));
        const entry = h.controller.getEntry(0);
        if (entry === null) { throw new Error('First row was not prepared'); }
        await expect(h.controller.setField(entry, 'character1', 'Q')).rejects.toThrow('transport unavailable');
        await vi.waitFor(() => expect(visibleCharacters(window)[0]).toBe('A'));
        const refreshedEntry = h.controller.getEntry(0);
        if (refreshedEntry === null) { throw new Error('First row was not prepared'); }
        await expect(h.controller.setField(refreshedEntry, 'character1', 'R')).resolves.toBe(true);
        expect(/** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options')).profiles[0].options.sentenceParsing.terminationCharacters[0].character1).toBe('R');
    });

    test('reset queued behind a pending edit does not write to a newly selected profile', async ({window}) => {
        const h = await createHarness(window);
        const entered = deferred();
        const release = deferred();
        const apply = h.settingsApi.modifySettings.getMockImplementation();
        if (typeof apply !== 'function') { throw new Error('Missing mutation transport'); }
        h.settingsApi.modifySettings.mockImplementationOnce(async (targets, source) => {
            entered.resolve();
            await release.promise;
            return await apply(targets, source);
        });
        const entry = h.controller.getEntry(0);
        if (entry === null) { throw new Error('First row was not prepared'); }
        const edit = h.controller.setField(entry, 'character1', 'Q');
        await entered.promise;
        h.settings.setProfileSelection(1, 'profile-b');
        const reset = h.controller._reset();
        release.resolve();
        await Promise.all([edit, reset]);
        const saved = /** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options'));
        expect(saved.profiles[0].options.sentenceParsing.terminationCharacters[0].character1).toBe('Q');
        expect(saved.profiles[1].options.sentenceParsing.terminationCharacters.map(({character1}) => character1)).toEqual(['X', 'Y']);
    });

    test('backend expectedValue set compares atomically and leaves default unconditional sets intact', async ({window}) => {
        const h = await createHarness(window);
        const target = /** @type {import('settings-modifications').ScopedModificationSet} */ ({
            action: 'set',
            path: 'sentenceParsing.terminationCharacters',
            value: [{enabled: true, character1: 'Z', character2: null, includeCharacterAtStart: false, includeCharacterAtEnd: false}],
            expectedValue: [{enabled: true, character1: 'A', character2: null, includeCharacterAtStart: false, includeCharacterAtEnd: false}, {enabled: true, character1: 'B', character2: null, includeCharacterAtStart: false, includeCharacterAtEnd: false}],
            scope: 'profile',
            profileId: 'profile-a',
            optionsContext: {index: 0, profileId: 'profile-a'},
        });
        const success = await h.backend._modifySettings([target], 'CAS success');
        expect(success[0].result).toBeDefined();
        const beforeMismatch = h.saveOptions.mock.calls.length;
        const mismatch = await h.backend._modifySettings([{...target, expectedValue: []}], 'CAS mismatch');
        expect(mismatch[0].error).toBeDefined();
        expect(h.saveOptions).toHaveBeenCalledTimes(beforeMismatch);
        const {expectedValue: _expectedValue, ...unconditionalTarget} = target;
        const unconditional = await h.backend._modifySettings([{...unconditionalTarget, value: []}], 'unconditional set');
        expect(unconditional[0].result).toBeDefined();
        expect(/** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options')).profiles[0].options.sentenceParsing.terminationCharacters).toEqual([]);
    });
});

describe('sentence editor recovery and row identity', () => {
    for (const persistFirst of [false, true]) {
        test(`transport failure preserves newer unsent text (persisted=${persistFirst})`, async ({window}) => {
            const h = await createHarness(window);
            vi.spyOn(log, 'error').mockImplementation(() => {});
            const entered = deferred();
            const release = deferred();
            const apply = h.settingsApi.modifySettings.getMockImplementation();
            if (typeof apply !== 'function') { throw new Error('Missing mutation transport'); }
            h.settingsApi.modifySettings.mockImplementationOnce(async (targets, source) => {
                if (persistFirst) { await apply(targets, source); }
                entered.resolve();
                await release.promise;
                throw new Error('response transport failed');
            });
            const entry = h.controller.getEntry(0);
            if (entry === null) { throw new Error('First row was not prepared'); }
            const changed = vi.spyOn(/** @type {any} */ (entry), '_setCharacterValue');
            const input = /** @type {HTMLInputElement} */ (window.document.querySelector('.sentence-termination-character-input1'));
            input.value = 'Q';
            input.dispatchEvent(new window.Event('change'));
            try {
                await entered.promise;
                input.value = 'R';
            } finally {
                release.resolve();
            }
            await Promise.allSettled(changed.mock.results.map((result) => result.value));
            expect(visibleCharacters(window)).toEqual(['R', 'B']);
            const saved = /** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options'));
            expect(saved.profiles[0].options.sentenceParsing.terminationCharacters[0].character1).toBe(persistFirst ? 'Q' : 'A');
        });
    }

    test('a skipped broken template does not shift the backend index of a healthy row', async ({window}) => {
        const h = await createHarness(window, false);
        vi.spyOn(log, 'error').mockImplementation(() => {});
        const instantiate = h.settings.instantiateTemplate.bind(h.settings);
        let count = 0;
        vi.spyOn(h.settings, 'instantiateTemplate').mockImplementation((name) => {
            const node = instantiate(name);
            if (++count === 1) { node.querySelector('.sentence-termination-character-input1')?.remove(); }
            return node;
        });
        await h.controller.prepare();
        expect(visibleCharacters(window)).toEqual(['B']);
        const entry = h.controller.getEntry(1);
        if (entry === null) { throw new Error('Second row was not prepared'); }
        const changed = vi.spyOn(/** @type {any} */ (entry), '_setCharacterValue');
        const input = /** @type {HTMLInputElement} */ (window.document.querySelector('.sentence-termination-character-input1'));
        input.value = 'R';
        input.dispatchEvent(new window.Event('change'));
        await Promise.allSettled(changed.mock.results.map((result) => result.value));
        const saved = /** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options'));
        expect(saved.profiles[0].options.sentenceParsing.terminationCharacters.map(({character1}) => character1)).toEqual(['A', 'R']);
    });

    test('an edit queued behind deletion follows the surviving row', async ({window}) => {
        const h = await createHarness(window);
        const entered = deferred();
        const release = deferred();
        const apply = h.settingsApi.modifySettings.getMockImplementation();
        if (typeof apply !== 'function') { throw new Error('Missing mutation transport'); }
        h.settingsApi.modifySettings.mockImplementationOnce(async (targets, source) => {
            entered.resolve();
            await release.promise;
            return await apply(targets, source);
        });
        const survivor = h.controller.getEntry(1);
        if (survivor === null) { throw new Error('Second row was not prepared'); }
        const changed = vi.spyOn(/** @type {any} */ (survivor), '_setCharacterValue');
        const input = /** @type {HTMLInputElement} */ (window.document.querySelectorAll('.sentence-termination-character-input1')[1]);
        const removing = h.controller.deleteEntry(0);
        try {
            await entered.promise;
            input.value = 'R';
            input.dispatchEvent(new window.Event('change'));
        } finally {
            release.resolve();
        }
        await removing;
        await Promise.allSettled(changed.mock.results.map((result) => result.value));
        const saved = /** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options'));
        expect(saved.profiles[0].options.sentenceParsing.terminationCharacters.map(({character1}) => character1)).toEqual(['R']);
        expect(visibleCharacters(window)).toEqual(['R']);
    });

    test('reset opened in A cannot target B after its defaults read is delayed', async ({window}) => {
        const h = await createHarness(window);
        const entered = deferred();
        const release = deferred();
        const defaults = await h.settings.getOptionsFull();
        defaults.profiles[0].options.sentenceParsing.terminationCharacters = [{enabled: true, character1: 'D', character2: null, includeCharacterAtStart: false, includeCharacterAtEnd: false}];
        vi.spyOn(h.settings, 'getDefaultOptions').mockImplementation(async () => {
            entered.resolve();
            await release.promise;
            return defaults;
        });
        const resetting = h.controller._reset();
        try {
            await entered.promise;
            const full = /** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options'));
            full.profiles.splice(0, 1);
            h.settings.setProfileSelection(0, 'profile-b');
            await vi.waitFor(() => expect(visibleCharacters(window)).toEqual(['X', 'Y']));
        } finally {
            release.resolve();
        }
        await resetting;
        expect(h.settingsApi.modifySettings).not.toHaveBeenCalled();
        const saved = /** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options'));
        expect(saved.profiles[0].options.sentenceParsing.terminationCharacters.map(({character1}) => character1)).toEqual(['X', 'Y']);
    });
});

test('a retired transport recovery cannot restore profile A draft inputs over profile B', async ({window}) => {
    const h = await createHarness(window);
    vi.spyOn(log, 'error').mockImplementation(() => {});
    const entered = deferred();
    const release = deferred();
    const read = h.settingsApi.optionsGet.getMockImplementation();
    if (typeof read !== 'function') { throw new Error('Missing options transport'); }
    h.settingsApi.optionsGet.mockImplementationOnce(async (context) => {
        const snapshot = await read(context);
        entered.resolve();
        await release.promise;
        return snapshot;
    });
    h.settingsApi.modifySettings.mockRejectedValueOnce(new Error('lost response'));
    const entry = h.controller.getEntry(0);
    const changed = vi.spyOn(/** @type {any} */ (entry), '_setCharacterValue');
    const input = /** @type {HTMLInputElement} */ (window.document.querySelector('.sentence-termination-character-input1'));
    input.value = 'Q';
    input.dispatchEvent(new window.Event('change'));
    input.value = 'R';
    try {
        await entered.promise;
        h.settings.setProfileSelection(1, 'profile-b');
        await vi.waitFor(() => expect(visibleCharacters(window)).toEqual(['X', 'Y']));
    } finally {
        release.resolve();
    }
    await Promise.allSettled(changed.mock.results.map((result) => result.value));
    expect(visibleCharacters(window)).toEqual(['X', 'Y']);
    const saved = /** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options'));
    expect(saved.profiles[1].options.sentenceParsing.terminationCharacters.map(({character1}) => character1)).toEqual(['X', 'Y']);
});

test('a valid edit after A to B to A waits for the earlier A save and remains saved', async ({window}) => {
    const h = await createHarness(window);
    vi.spyOn(log, 'error').mockImplementation(() => {});
    const entered = deferred();
    const release = deferred();
    const apply = h.settingsApi.modifySettings.getMockImplementation();
    if (typeof apply !== 'function') { throw new Error('Missing mutation transport'); }
    h.settingsApi.modifySettings.mockImplementationOnce(async (targets, source) => {
        entered.resolve();
        await release.promise;
        return await apply(targets, source);
    });
    const oldEntry = h.controller.getEntry(0);
    if (oldEntry === null) { throw new Error('First row was not prepared'); }
    const oldChanged = vi.spyOn(/** @type {any} */ (oldEntry), '_setCharacterValue');
    const oldInput = /** @type {HTMLInputElement} */ (window.document.querySelector('.sentence-termination-character-input1'));
    oldInput.value = 'Q';
    oldInput.dispatchEvent(new window.Event('change'));
    let changed;
    try {
        await entered.promise;
        h.settings.setProfileSelection(1, 'profile-b');
        await vi.waitFor(() => expect(visibleCharacters(window)).toEqual(['X', 'Y']));
        h.settings.setProfileSelection(0, 'profile-a');
        await vi.waitFor(() => expect(visibleCharacters(window)).toEqual(['A', 'B']));
        const entry = h.controller.getEntry(0);
        changed = vi.spyOn(/** @type {any} */ (entry), '_setCharacterValue');
        const input = /** @type {HTMLInputElement} */ (window.document.querySelector('.sentence-termination-character-input1'));
        input.value = 'R';
        input.dispatchEvent(new window.Event('change'));
    } finally {
        release.resolve();
    }
    await Promise.allSettled(oldChanged.mock.results.map((result) => result.value));
    await Promise.allSettled(changed?.mock.results.map((result) => result.value) ?? []);
    const saved = /** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options'));
    expect(saved.profiles[0].options.sentenceParsing.terminationCharacters.map(({character1}) => character1)).toEqual(['R', 'B']);
    expect(visibleCharacters(window)).toEqual(['R', 'B']);
});

test('a reset started before a later edit keeps that edit ordered after the reset', async ({window}) => {
    const h = await createHarness(window);
    const entered = deferred();
    const release = deferred();
    const defaults = await h.settings.getOptionsFull();
    defaults.profiles[0].options.sentenceParsing.terminationCharacters = [
        {enabled: true, character1: 'D', character2: null, includeCharacterAtStart: false, includeCharacterAtEnd: false},
    ];
    vi.spyOn(h.settings, 'getDefaultOptions').mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        return defaults;
    });
    const resetting = h.controller._reset();
    await entered.promise;
    const entry = h.controller.getEntry(0);
    if (entry === null) { throw new Error('First row missing'); }
    const editing = h.controller.setField(entry, 'character1', 'Q');
    await editing;
    release.resolve();
    await resetting;
    const saved = /** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options'));
    expect(saved.profiles[0].options.sentenceParsing.terminationCharacters[0].character1).toBe('Q');
});

describe('sentence editor ordered control edits', () => {
    test('a failed older checkbox edit cannot undo a newer edit with the same value', async ({window}) => {
        const h = await createHarness(window);
        const entered = deferred();
        const release = deferred();
        h.settingsApi.modifySettings.mockImplementationOnce(async () => {
            entered.resolve();
            await release.promise;
            return [{error: {name: 'Error', message: 'injected save rejection'}}];
        });
        const entry = h.controller.getEntry(0);
        if (entry === null) { throw new Error('First row missing'); }
        const changed = vi.spyOn(/** @type {any} */ (entry), '_setCheckboxValue');
        const checkbox = /** @type {HTMLInputElement} */ (window.document.querySelector('.sentence-termination-character-enabled'));
        checkbox.checked = false;
        checkbox.dispatchEvent(new window.Event('change'));
        try {
            await entered.promise;
            checkbox.checked = true;
            checkbox.dispatchEvent(new window.Event('change'));
            checkbox.checked = false;
            checkbox.dispatchEvent(new window.Event('change'));
        } finally {
            release.resolve();
        }
        await Promise.allSettled(changed.mock.results.map((result) => result.value));
        const saved = /** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options'));
        expect(saved.profiles[0].options.sentenceParsing.terminationCharacters[0].enabled).toBe(false);
        expect(checkbox.checked).toBe(false);
    });

    test('quote conversion uses the opening character acknowledged by an earlier queued edit', async ({window}) => {
        const h = await createHarness(window);
        const entered = deferred();
        const release = deferred();
        const apply = h.settingsApi.modifySettings.getMockImplementation();
        if (typeof apply !== 'function') { throw new Error('Missing mutation transport'); }
        h.settingsApi.modifySettings.mockImplementationOnce(async (targets, source) => {
            entered.resolve();
            await release.promise;
            return await apply(targets, source);
        });
        const entry = h.controller.getEntry(0);
        if (entry === null) { throw new Error('First row missing'); }
        const changed = vi.spyOn(/** @type {any} */ (entry), '_setCharacterValue');
        const toggled = vi.spyOn(/** @type {any} */ (entry), '_setHasCharacter2');
        const input = /** @type {HTMLInputElement} */ (window.document.querySelector('.sentence-termination-character-input1'));
        const type = /** @type {HTMLSelectElement} */ (window.document.querySelector('.sentence-termination-character-type'));
        input.value = 'Q';
        input.dispatchEvent(new window.Event('change'));
        try {
            await entered.promise;
            type.value = 'quote';
            type.dispatchEvent(new window.Event('change'));
        } finally {
            release.resolve();
        }
        await Promise.allSettled(changed.mock.results.map((result) => result.value));
        await Promise.allSettled(toggled.mock.results.map((result) => result.value));
        const saved = /** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options'));
        expect(saved.profiles[0].options.sentenceParsing.terminationCharacters[0]).toMatchObject({character1: 'Q', character2: 'Q'});
        expect(/** @type {HTMLInputElement} */ (window.document.querySelector('.sentence-termination-character-input2')).value).toBe('Q');
        expect(type.value).toBe('quote');
    });

    test('a malformed response is reconciled without acknowledging an unpersisted character', async ({window}) => {
        const h = await createHarness(window);
        h.settingsApi.modifySettings.mockResolvedValueOnce([{}]);
        const entry = h.controller.getEntry(0);
        if (entry === null) { throw new Error('First row missing'); }
        await expect(h.controller.setField(entry, 'character1', 'Q')).rejects.toThrow('Invalid sentence settings response');
        expect(entry.data.character1).toBe('A');
        await expect(h.controller.setField(entry, 'character1', 'R')).resolves.toBe(true);
        expect(/** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options')).profiles[0].options.sentenceParsing.terminationCharacters[0].character1).toBe('R');
    });

    test('a failed recovery preserves the save error and blocks writes until a verified refresh', async ({window}) => {
        const h = await createHarness(window);
        vi.spyOn(log, 'error').mockImplementation(() => {});
        h.settingsApi.modifySettings.mockRejectedValueOnce(new Error('primary save failure'));
        h.settingsApi.optionsGet.mockRejectedValueOnce(new Error('recovery read failure'));
        const entry = h.controller.getEntry(0);
        if (entry === null) { throw new Error('First row missing'); }
        await expect(h.controller.setField(entry, 'character1', 'Q')).rejects.toThrow('primary save failure');
        await expect(h.controller.setField(entry, 'character1', 'R')).resolves.toBe(false);
        expect(h.settingsApi.modifySettings).toHaveBeenCalledTimes(1);
        await h.controller._updateOptions();
        const refreshed = h.controller.getEntry(0);
        if (refreshed === null) { throw new Error('Refreshed row missing'); }
        await expect(h.controller.setField(refreshed, 'character1', 'R')).resolves.toBe(true);
        expect(/** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options')).profiles[0].options.sentenceParsing.terminationCharacters[0].character1).toBe('R');
    });
});

describe('sentence editor revisited view acknowledgement', () => {
    for (const draft of ['none', 'unsent', 'queued-original']) {
        test(`a revisited view adopts an old success while preserving ${draft} input`, async ({window}) => {
            const h = await createHarness(window);
            const entered = deferred();
            const release = deferred();
            const apply = h.settingsApi.modifySettings.getMockImplementation();
            if (typeof apply !== 'function') { throw new Error('Missing mutation transport'); }
            h.settingsApi.modifySettings.mockImplementationOnce(async (targets, source) => {
                entered.resolve();
                await release.promise;
                return await apply(targets, source);
            });
            const oldEntry = h.controller.getEntry(0);
            if (oldEntry === null) { throw new Error('Old row missing'); }
            const oldChanged = vi.spyOn(/** @type {any} */ (oldEntry), '_setCharacterValue');
            const oldInput = /** @type {HTMLInputElement} */ (window.document.querySelector('.sentence-termination-character-input1'));
            oldInput.value = 'Q';
            oldInput.dispatchEvent(new window.Event('change'));
            let input;
            try {
                await entered.promise;
                h.settings.setProfileSelection(1, 'profile-b');
                await vi.waitFor(() => expect(visibleCharacters(window)).toEqual(['X', 'Y']));
                h.settings.setProfileSelection(0, 'profile-a');
                await vi.waitFor(() => expect(visibleCharacters(window)).toEqual(['A', 'B']));
                input = /** @type {HTMLInputElement} */ (window.document.querySelector('.sentence-termination-character-input1'));
                if (draft === 'unsent') { input.value = 'R'; }
                if (draft === 'queued-original') { input.dispatchEvent(new window.Event('change')); }
            } finally {
                release.resolve();
            }
            await Promise.allSettled(oldChanged.mock.results.map((result) => result.value));
            await h.controller._mutationTail;
            await new Promise((resolve) => { setTimeout(resolve, 0); });
            const expectedSaved = draft === 'queued-original' ? 'A' : 'Q';
            const expectedInput = draft === 'none' ? 'Q' : (draft === 'unsent' ? 'R' : 'A');
            expect(/** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options')).profiles[0].options.sentenceParsing.terminationCharacters[0].character1).toBe(expectedSaved);
            expect(input?.value).toBe(expectedInput);
        });
    }
});

test('a successful old delete refreshes a revisited profile without reusing removed row controls', async ({window}) => {
    const h = await createHarness(window);
    const entered = deferred();
    const release = deferred();
    const apply = h.settingsApi.modifySettings.getMockImplementation();
    if (typeof apply !== 'function') { throw new Error('Missing mutation transport'); }
    h.settingsApi.modifySettings.mockImplementationOnce(async (targets, source) => {
        entered.resolve();
        await release.promise;
        return await apply(targets, source);
    });
    const removing = h.controller.deleteEntry(0);
    let staleInput;
    try {
        await entered.promise;
        h.settings.setProfileSelection(1, 'profile-b');
        await vi.waitFor(() => expect(visibleCharacters(window)).toEqual(['X', 'Y']));
        h.settings.setProfileSelection(0, 'profile-a');
        await vi.waitFor(() => expect(visibleCharacters(window)).toEqual(['A', 'B']));
        staleInput = /** @type {HTMLInputElement} */ (window.document.querySelector('.sentence-termination-character-input1'));
    } finally {
        release.resolve();
    }
    await removing;
    expect(visibleCharacters(window)).toEqual(['B']);
    if (typeof staleInput === 'undefined') { throw new Error('Missing retired control'); }
    staleInput.value = 'Q';
    staleInput.dispatchEvent(new window.Event('change'));
    await h.controller._mutationTail;
    expect(/** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options')).profiles[0].options.sentenceParsing.terminationCharacters.map(({character1}) => character1)).toEqual(['B']);
});

test('reset still follows an edit requested before the reset began', async ({window}) => {
    const h = await createHarness(window);
    const entered = deferred();
    const release = deferred();
    const apply = h.settingsApi.modifySettings.getMockImplementation();
    if (typeof apply !== 'function') { throw new Error('Missing mutation transport'); }
    h.settingsApi.modifySettings.mockImplementationOnce(async (targets, source) => {
        entered.resolve();
        await release.promise;
        return await apply(targets, source);
    });
    const defaults = await h.settings.getOptionsFull();
    defaults.profiles[0].options.sentenceParsing.terminationCharacters = [
        {enabled: true, character1: 'D', character2: null, includeCharacterAtStart: false, includeCharacterAtEnd: false},
    ];
    vi.spyOn(h.settings, 'getDefaultOptions').mockResolvedValue(defaults);
    const entry = h.controller.getEntry(0);
    if (entry === null) { throw new Error('First row missing'); }
    const editing = h.controller.setField(entry, 'character1', 'Q');
    await entered.promise;
    const resetting = h.controller._reset();
    release.resolve();
    await Promise.all([editing, resetting]);
    expect(/** @type {import('settings').Options} */ (Reflect.get(h.backend, '_options')).profiles[0].options.sentenceParsing.terminationCharacters.map(({character1}) => character1)).toEqual(['D']);
    expect(visibleCharacters(window)).toEqual(['D']);
});
