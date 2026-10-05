/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, test, vi} from 'vitest';
import {AudioController} from '../ext/js/pages/settings/audio-controller.js';

afterEach(() => { vi.unstubAllGlobals(); });

/**
 * @template T
 * @returns {{promise: Promise<T>, resolve: (value: T) => void, reject: (error: unknown) => void}}
 */
function deferred() {
    let resolve = /** @type {(value: T) => void} */ (() => {});
    let reject = /** @type {(error: unknown) => void} */ (() => {});
    /** @type {Promise<T>} */
    const promise = new Promise((resolve2, reject2) => {
        resolve = resolve2;
        reject = reject2;
    });
    return {promise, resolve, reject};
}

/**
 * @typedef {EventTarget & {
 * value: string,
 * hidden: boolean,
 * dataset: Record<string, string>,
 * parentNode: TestElement|null,
 * children: TestElement[],
 * selectors: Map<string, TestElement>,
 * textContent: string,
 * appendChild: (child: TestElement) => void,
 * removeChild: (child: TestElement) => void,
 * querySelector: (selector: string) => TestElement,
 * querySelectorAll: () => TestElement[],
 * }} TestElement
 */

/** @returns {TestElement} */
function makeElement() {
    const element = Object.assign(new EventTarget(), {
        value: '',
        hidden: false,
        dataset: /** @type {Record<string, string>} */ ({}),
        parentNode: /** @type {TestElement|null} */ (null),
        children: /** @type {TestElement[]} */ ([]),
        selectors: new Map(),
        textContent: '',
        /** @param {TestElement} child */
        appendChild(child) {
            this.children.push(child);
            child.parentNode = this;
        },
        /** @param {TestElement} child */
        removeChild(child) {
            this.children.splice(this.children.indexOf(child), 1);
            child.parentNode = null;
        },
        /**
         * @param {string} selector
         * @returns {TestElement}
         */
        querySelector(selector) {
            let node = this.selectors.get(selector);
            if (!node) {
                node = makeElement();
                this.selectors.set(selector, node);
            }
            return node;
        },
        querySelectorAll: () => [],
    });
    return element;
}

/**
 * @param {string[]} [names]
 * @returns {import('settings').ProfileOptions}
 */
function options(names = ['A', 'B', 'C']) {
    return /** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({
        general: {language: 'ja'},
        audio: {sources: names.map((name) => ({type: 'custom', url: name, voice: `voice-${name}`}))},
    }));
}

async function setup() {
    const root = makeElement();
    vi.stubGlobal('document', {
        documentElement: {dataset: {browser: 'chrome'}},
        querySelector: root.querySelector.bind(root),
        createDocumentFragment: makeElement,
        createElement: makeElement,
    });
    const state = {
        profileIndex: 0,
        stored: options(),
        get: /** @type {() => Promise<import('settings').ProfileOptions>} */ (async () => structuredClone(state.stored)),
        save: /** @type {() => Promise<import('settings-controller').ModifyResult[]>} */ (async () => [{result: true}]),
        writes: /** @type {{profileIndex: number, targets: unknown}[]} */ ([]),
        reads: 0,
    };
    const events = new Map();
    const settings = {
        /**
         * @param {string} event
         * @param {(details: object) => void} listener
         */
        on(event, listener) { events.set(event, listener); },
        getOptionsContext: () => ({index: state.profileIndex}),
        getOptions: () => {
            ++state.reads;
            return state.get();
        },
        instantiateTemplate: makeElement,
        /**
         * @param {unknown} targets
         * @returns {Promise<import('settings-controller').ModifyResult[]>}
         */
        modifyProfileSettings(targets) {
            state.writes.push({profileIndex: state.profileIndex, targets});
            return state.save();
        },
        /**
         * @param {string} path
         * @param {unknown} value
         * @returns {Promise<import('settings-controller').ModifyResult[]>}
         */
        setProfileSetting(path, value) { return this.modifyProfileSettings([{action: 'set', path, value}]); },
    };
    const controller = new AudioController(
        /** @type {import('../ext/js/pages/settings/settings-controller.js').SettingsController} */ (/** @type {unknown} */ (settings)),
        /** @type {import('../ext/js/pages/settings/modal-controller.js').ModalController} */ (/** @type {unknown} */ ({getModal: () => null})),
    );
    await controller.prepare();
    const entries = () => Reflect.get(controller, '_audioSourceEntries');
    const urls = () => entries().map((/** @type {object} */ entry) => Reflect.get(entry, '_url'));
    /** @param {number} index */
    const switchProfile = (index) => {
        state.profileIndex = index;
        events.get('optionsContextChanged')?.({});
    };
    /** @param {string[]} names */
    const render = (names) => controller._onOptionsChanged({options: options(names), optionsContext: {index: state.profileIndex}});
    return {controller, state, entries, urls, switchProfile, render};
}

/** @returns {import('settings-controller').ModifyResult[]} */
function saveError() {
    return [{error: {name: 'Error', message: 'Audio setting was not saved', stack: ''}}];
}

for (const operation of ['add', 'remove', 'move']) {
    test(`${operation} surfaces an embedded settings error and restores the authoritative source list`, async () => {
        const {controller, state, entries, urls} = await setup();
        state.save = async () => saveError();
        const request = operation === 'add' ? controller._addAudioSource() :
            (operation === 'remove' ? controller.removeSource(entries()[0]) : controller.moveAudioSourceOptions(0, 1));
        let failure = null;
        try { await request; } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
        expect(failure instanceof Error).toBe(true);
        expect(failure?.message).toBe('Audio setting was not saved');
        expect(urls()).toEqual(['A', 'B', 'C']);
        expect(state.writes.length).toBe(1);
    });
}

for (const [method, property, input, value, previous] of [
    ['_setType', '_type', '_typeSelect', 'text-to-speech', 'custom'],
    ['_setUrl', '_url', '_urlInput', 'updated', 'A'],
    ['_setVoice', '_voice', '_voiceSelect', 'voice-new', 'voice-A'],
]) {
    test(`${method} rolls back an embedded settings error rather than displaying a successful edit`, async () => {
        const {state, entries} = await setup();
        state.save = async () => saveError();
        const entry = entries()[0];
        Reflect.get(entry, input).value = value;
        let failure = null;
        try { await Reflect.get(entry, method).call(entry, value); } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
        expect(failure instanceof Error).toBe(true);
        expect(Reflect.get(entry, property)).toBe(previous);
        expect(Reflect.get(entry, input).value).toBe(previous);
    });
}

test('a removed source cannot delete the next source through its obsolete numeric index', async () => {
    const {controller, state, entries, urls} = await setup();
    const removed = entries()[0];
    await controller.removeSource(removed);
    await controller.removeSource(removed);
    expect(urls()).toEqual(['B', 'C']);
    expect(state.writes.length).toBe(1);
});

test('an entry from a replaced source list cannot remove a new source at the same index', async () => {
    const {controller, state, entries, render, urls} = await setup();
    const oldEntry = entries()[0];
    render(['replacement']);
    await controller.removeSource(oldEntry);
    expect(urls()).toEqual(['replacement']);
    expect(state.writes.length).toBe(0);
});

test('switching profiles while a reorder reads options never copies the old sources into the new profile', async () => {
    const {controller, state, switchProfile, render, urls} = await setup();
    const pending = deferred();
    state.get = () => /** @type {Promise<import('settings').ProfileOptions>} */ (pending.promise);
    const request = controller.moveAudioSourceOptions(0, 1);
    switchProfile(1);
    render(['other-profile']);
    pending.resolve(options());
    await request;
    expect(state.writes.length).toBe(0);
    expect(urls()).toEqual(['other-profile']);
});

test('switching away and back retires a pending reorder even when the profile index is equal again', async () => {
    const {controller, state, switchProfile} = await setup();
    const pending = deferred();
    state.get = () => /** @type {Promise<import('settings').ProfileOptions>} */ (pending.promise);
    const request = controller.moveAudioSourceOptions(0, 1);
    switchProfile(1);
    switchProfile(0);
    pending.resolve(options());
    await request;
    expect(state.writes.length).toBe(0);
});

test('a delayed refresh does not restore sources superseded by a settings notification', async () => {
    const {controller, state, render, urls} = await setup();
    const pending = deferred();
    state.get = () => /** @type {Promise<import('settings').ProfileOptions>} */ (pending.promise);
    const request = controller._refreshAudioSources();
    render(['fresh']);
    pending.resolve(options());
    await request;
    expect(urls()).toEqual(['fresh']);
});

test('a reorder already sent to the old profile does not replace the new profile UI on completion', async () => {
    const {controller, state, switchProfile, render, urls} = await setup();
    const pending = deferred();
    state.save = () => /** @type {Promise<import('settings-controller').ModifyResult[]>} */ (pending.promise);
    const request = controller.moveAudioSourceOptions(0, 1);
    for (let i = 0; i < 12; ++i) { await Promise.resolve(); }
    expect(state.writes.length).toBe(1);
    switchProfile(1);
    render(['other-profile']);
    pending.resolve([{result: true}]);
    await request;
    expect(state.writes[0].profileIndex).toBe(0);
    expect(urls()).toEqual(['other-profile']);
});

test('a source removal invalidates an older reorder snapshot before it can undo the removal', async () => {
    const {controller, state, entries, urls} = await setup();
    const pending = deferred();
    state.get = () => /** @type {Promise<import('settings').ProfileOptions>} */ (pending.promise);
    const request = controller.moveAudioSourceOptions(0, 1);
    await controller.removeSource(entries()[0]);
    pending.resolve(options());
    await request;
    expect(state.writes.length).toBe(1);
    expect(urls()).toEqual(['B', 'C']);
});

test('a healthy reorder retains source data and writes to the original profile', async () => {
    const {controller, state, urls} = await setup();
    await controller.moveAudioSourceOptions(0, 2);
    expect(urls()).toEqual(['B', 'C', 'A']);
    expect(state.writes[0].profileIndex).toBe(0);
});

test('transport rejection still restores a failed removal', async () => {
    const {controller, state, entries, urls} = await setup();
    state.save = async () => { throw new Error('transport closed'); };
    let failure = null;
    try { await controller.removeSource(entries()[0]); } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
    expect(failure?.message).toBe('transport closed');
    expect(urls()).toEqual(['A', 'B', 'C']);
});

for (const [method, property, first, latest, original] of [
    ['_setType', '_type', 'text-to-speech', 'custom-json', 'custom'],
    ['_setUrl', '_url', 'first-url', 'last-url', 'A'],
    ['_setVoice', '_voice', 'first-voice', 'last-voice', 'voice-A'],
]) {
    for (const firstSucceeds of [false, true]) {
        test(`${method} serializes edits and restores the last acknowledged value when the latest fails (first success: ${firstSucceeds})`, async () => {
            const {state, entries} = await setup();
            const pending = deferred();
            let calls = 0;
            state.save = () => {
                ++calls;
                return calls === 1 ? /** @type {Promise<import('settings-controller').ModifyResult[]>} */ (pending.promise) : Promise.resolve(saveError());
            };
            const entry = entries()[0];
            const old = Reflect.get(entry, method).call(entry, first).catch(() => {});
            for (let i = 0; i < 12; ++i) { await Promise.resolve(); }
            const next = Reflect.get(entry, method).call(entry, latest).catch(() => {});
            for (let i = 0; i < 12; ++i) { await Promise.resolve(); }
            expect(calls).toBe(1);
            expect(Reflect.get(entry, property)).toBe(latest);
            pending.resolve(firstSucceeds ? [{result: true}] : saveError());
            await Promise.all([old, next]);
            expect(calls).toBe(2);
            expect(Reflect.get(entry, property)).toBe(firstSucceeds ? first : original);
        });
    }
}

test('a source-field edit retires a reorder snapshot containing the previous field value', async () => {
    const {controller, state, entries} = await setup();
    const pending = deferred();
    state.get = () => /** @type {Promise<import('settings').ProfileOptions>} */ (pending.promise);
    const move = controller.moveAudioSourceOptions(0, 1);
    await entries()[0]._setUrl('new-url');
    pending.resolve(options());
    await move;
    expect(state.writes.length).toBe(1);
});

for (const operation of ['add', 'remove', 'type', 'url', 'voice']) {
    test(`${operation} cannot mutate stale rows while replacement profile options are loading`, async () => {
        const {controller, state, switchProfile, entries} = await setup();
        const entry = entries()[0];
        switchProfile(1);
        switch (operation) {
            case 'add': await controller._addAudioSource(); break;
            case 'remove': await controller.removeSource(entry); break;
            case 'type': await entry._setType('custom-json'); break;
            case 'url': await entry._setUrl('changed'); break;
            case 'voice': await entry._setVoice('changed'); break;
        }
        expect(state.writes.length).toBe(0);
    });
}

test('queued field edits are dropped when their source row is replaced', async () => {
    const {state, entries, render} = await setup();
    const pending = deferred();
    state.save = () => /** @type {Promise<import('settings-controller').ModifyResult[]>} */ (pending.promise);
    const entry = entries()[0];
    const first = entry._setUrl('first');
    for (let i = 0; i < 12; ++i) { await Promise.resolve(); }
    const second = entry._setUrl('second');
    render(['replacement']);
    pending.resolve([{result: true}]);
    await Promise.all([first, second]);
    expect(state.writes.length).toBe(1);
});

test('healthy rapid field edits persist in order and retain the latest visible value', async () => {
    const {state, entries} = await setup();
    const entry = entries()[0];
    await Promise.all([entry._setUrl('first'), entry._setUrl('second'), entry._setUrl('third')]);
    expect(state.writes.map(({targets}) => /** @type {{value: string}[]} */ (targets)[0].value)).toEqual(['first', 'second', 'third']);
    expect(Reflect.get(entry, '_urlInput').value).toBe('third');
});

test('a reorder waits for earlier field saves before reading the array it will persist', async () => {
    const {controller, state, entries, urls} = await setup();
    const pending = deferred();
    let calls = 0;
    state.save = async () => {
        if (++calls === 1) {
            await pending.promise;
            state.stored.audio.sources[0].url = 'saved-new-url';
        }
        return [{result: true}];
    };
    const readsBefore = state.reads;
    const edit = entries()[0]._setUrl('saved-new-url');
    const move = controller.moveAudioSourceOptions(0, 2);
    for (let i = 0; i < 12; ++i) { await Promise.resolve(); }
    const earlyReads = state.reads;
    pending.resolve(null);
    await Promise.all([edit, move]);
    expect(earlyReads).toBe(readsBefore);
    expect(urls()).toEqual(['B', 'C', 'saved-new-url']);
});
