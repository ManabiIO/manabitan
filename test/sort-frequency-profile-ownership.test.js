/*
 * Copyright (C) 2026  Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';
import {SettingsController} from '../ext/js/pages/settings/settings-controller.js';
import {SortFrequencyDictionaryController} from '../ext/js/pages/settings/sort-frequency-dictionary-controller.js';
import {createDomTest} from './fixtures/dom-test.js';

const domTest = createDomTest();

function deferred() {
    /** @type {() => void} */
    let resolve = () => {};
    const promise = new Promise((resolvePromise) => { resolve = () => resolvePromise(void 0); });
    return {promise, resolve};
}

function createHarness() {
    const options = {
        profileCurrent: 0,
        profiles: [
            {id: 'a', name: 'A', options: {general: {sortFrequencyDictionary: 'Dict', sortFrequencyDictionaryOrder: 'ascending'}}, conditionGroups: []},
            {id: 'b', name: 'B', options: {general: {sortFrequencyDictionary: 'Dict', sortFrequencyDictionaryOrder: 'descending'}}, conditionGroups: []},
        ],
    };
    const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
    Reflect.set(backend, '_options', options);
    Reflect.set(backend, '_optionsUtil', {createValidatingProxy: (/** @type {import('settings').Options} */ value) => value});
    Reflect.set(backend, '_profileConditionsSchemaCache', []);
    Reflect.set(backend, '_applyOptions', vi.fn());
    Reflect.set(backend, '_clearProfileConditionsSchemaCache', vi.fn());
    Reflect.set(backend, '_saveOptions', async (_source, value) => {
        Reflect.set(backend, '_options', structuredClone(value));
    });
    const application = {
        on: vi.fn(),
        api: {
            optionsGet: async (/** @type {import('settings').OptionsContext} */ optionsContext) => structuredClone(await backend._onApiOptionsGet({optionsContext: structuredClone(optionsContext)}, /** @type {chrome.runtime.MessageSender} */ (/** @type {unknown} */ ({})))),
            getDictionaryInfo: async () => [],
            optionsGetFull: async () => structuredClone(await backend._onApiOptionsGetFull(undefined, /** @type {chrome.runtime.MessageSender} */ (/** @type {unknown} */ ({})))),
            getSettings: async (/** @type {import('settings-modifications').ScopedRead[]} */ targets) => structuredClone(await backend._onApiGetSettings({targets: structuredClone(targets)}, /** @type {chrome.runtime.MessageSender} */ (/** @type {unknown} */ ({})))),
            modifySettings: async (/** @type {import('settings-modifications').ScopedModification[]} */ targets, /** @type {string} */ source) => structuredClone(await backend._onApiModifySettings({targets: structuredClone(targets), source}, /** @type {chrome.runtime.MessageSender} */ (/** @type {unknown} */ ({})))),
            setAllSettings: async (/** @type {import('settings').Options} */ value) => { Reflect.set(backend, '_options', structuredClone(value)); },
        },
    };
    const settingsController = new SettingsController(/** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ (application)));
    Reflect.set(settingsController, '_templates', {loadFromFiles: vi.fn()});
    Reflect.set(settingsController, '_source', 'settings-tab');
    return {backend, settingsController};
}

domTest('queued sort-order write stays with its original profile when selection identity changes at the same index', async ({window}) => {
    vi.stubGlobal('chrome', {permissions: {}});
    window.document.body.innerHTML = `
        <select id="sort-frequency-dictionary"><option value="Dict" selected>Dict</option></select>
        <select id="sort-frequency-dictionary-order">
            <option value="ascending" selected>Ascending</option>
            <option value="descending">Descending</option>
        </select>
        <button id="sort-frequency-dictionary-order-auto"></button>
        <div id="sort-frequency-dictionary-order-container"></div>
    `;
    const {backend, settingsController} = createHarness();
    await settingsController.prepare();
    const sortController = new SortFrequencyDictionaryController(settingsController);
    settingsController.on('optionsChanged', sortController._onOptionsChanged.bind(sortController));
    sortController._onOptionsChanged({
        options: await settingsController.getOptions(),
        optionsContext: settingsController.getOptionsContext(),
    });

    const queueGate = deferred();
    Reflect.set(sortController, '_settingWriteTail', queueGate.promise);
    const staleWrite = sortController._setSortFrequencyDictionaryOrderValue('ascending');
    await Promise.resolve();

    Reflect.set(backend, '_options', {
        profileCurrent: 0,
        profiles: [{
            id: 'b',
            name: 'B',
            options: {general: {sortFrequencyDictionary: 'Dict', sortFrequencyDictionaryOrder: 'descending'}},
            conditionGroups: [],
        }],
    });
    const optionsReadStarted = deferred();
    const optionsResponse = deferredValue();
    Reflect.set(settingsController.application.api, 'optionsGet', () => {
        optionsReadStarted.resolve();
        return optionsResponse.promise;
    });
    const refresh = settingsController.refresh();
    await optionsReadStarted.promise;
    expect(settingsController.getOptionsContext()).toEqual({index: 0, profileId: 'b'});

    queueGate.resolve();
    await staleWrite;

    const savedOptions = /** @type {import('settings').Options} */ (/** @type {unknown} */ (Reflect.get(backend, '_options')));
    expect(savedOptions.profiles[0].options.general.sortFrequencyDictionaryOrder).toBe('descending');
    optionsResponse.resolve(/** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({general: {sortFrequencyDictionary: 'Dict', sortFrequencyDictionaryOrder: 'descending'}})));
    await refresh;
});


domTest('database refresh does not render a stale same-index profile response', async ({window}) => {
    vi.stubGlobal('chrome', {permissions: {}});
    window.document.body.innerHTML = `
        <select id="sort-frequency-dictionary"><option value="Dict" selected>Dict</option></select>
        <select id="sort-frequency-dictionary-order">
            <option value="ascending" selected>Ascending</option>
            <option value="descending">Descending</option>
        </select>
        <button id="sort-frequency-dictionary-order-auto"></button>
        <div id="sort-frequency-dictionary-order-container"></div>
    `;
    const {backend, settingsController} = createHarness();
    await settingsController.prepare();
    const sortController = new SortFrequencyDictionaryController(settingsController);
    const renderOptions = vi.spyOn(sortController, '_onOptionsChanged');
    settingsController.on('optionsChanged', sortController._onOptionsChanged.bind(sortController));

    const reads = /** @type {Array<ReturnType<typeof deferredValue<import('settings').ProfileOptions>>>} */ ([]);
    Reflect.set(settingsController.application.api, 'optionsGet', () => {
        const read = deferredValue();
        reads.push(read);
        return read.promise;
    });
    const databaseRefresh = sortController._onDatabaseUpdated();
    await vi.waitFor(() => expect(reads).toHaveLength(1), {timeout: 1000});

    Reflect.set(backend, '_options', {
        profileCurrent: 0,
        profiles: [{
            id: 'b',
            name: 'B',
            options: {general: {sortFrequencyDictionary: 'Dict', sortFrequencyDictionaryOrder: 'descending'}},
            conditionGroups: [],
        }],
    });
    settingsController.setProfileSelection(0, 'b');
    await vi.waitFor(() => expect(reads).toHaveLength(2), {timeout: 1000});

    reads[0].resolve(/** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({general: {sortFrequencyDictionary: 'Dict', sortFrequencyDictionaryOrder: 'ascending'}})));
    await databaseRefresh;
    expect(settingsController.getOptionsContext()).toEqual({index: 0, profileId: 'b'});
    expect(renderOptions).not.toHaveBeenCalled();

    reads[1].resolve(/** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({general: {sortFrequencyDictionary: 'Dict', sortFrequencyDictionaryOrder: 'descending'}})));
    await Promise.resolve();
    await Promise.resolve();
    expect(renderOptions).toHaveBeenCalledOnce();
    expect((/** @type {HTMLSelectElement} */ (window.document.querySelector('#sort-frequency-dictionary-order'))).value).toBe('descending');
});

domTest('an auto-order response is discarded after the profile identity changes', async ({window}) => {
    vi.stubGlobal('chrome', {permissions: {}});
    window.document.body.innerHTML = `
        <select id="sort-frequency-dictionary"><option value="Dict" selected>Dict</option></select>
        <select id="sort-frequency-dictionary-order"><option value="ascending" selected>Ascending</option></select>
        <button id="sort-frequency-dictionary-order-auto"></button>
        <div id="sort-frequency-dictionary-order-container"></div>
    `;
    const {backend, settingsController} = createHarness();
    await settingsController.prepare();
    const sortController = new SortFrequencyDictionaryController(settingsController);
    const orderResponse = deferredValue();
    Reflect.set(sortController, '_getFrequencyOrder', () => orderResponse.promise);
    const saveOrder = vi.spyOn(sortController, '_setSortFrequencyDictionaryOrderValue');
    const update = sortController._autoUpdateOrder('Dict');

    settingsController.setProfileSelection(0, 'b');
    orderResponse.resolve('descending');
    await update;

    const savedOptions = /** @type {import('settings').Options} */ (/** @type {unknown} */ (Reflect.get(backend, '_options')));
    expect(savedOptions.profiles[0].options.general.sortFrequencyDictionaryOrder).toBe('ascending');
    expect(saveOrder).not.toHaveBeenCalled();
});

domTest('a queued dictionary selection remains scoped to its original profile', async ({window}) => {
    vi.stubGlobal('chrome', {permissions: {}});
    window.document.body.innerHTML = `
        <select id="sort-frequency-dictionary"><option value="Dict" selected>Dict</option><option value="Other">Other</option></select>
        <select id="sort-frequency-dictionary-order"><option value="ascending" selected>Ascending</option></select>
        <button id="sort-frequency-dictionary-order-auto"></button>
        <div id="sort-frequency-dictionary-order-container"></div>
    `;
    const {backend, settingsController} = createHarness();
    await settingsController.prepare();
    const sortController = new SortFrequencyDictionaryController(settingsController);
    const queueGate = deferred();
    Reflect.set(sortController, '_settingWriteTail', queueGate.promise);
    const staleWrite = sortController._setSortFrequencyDictionaryValue('Other');
    await Promise.resolve();

    settingsController.setProfileSelection(0, 'b');
    queueGate.resolve();
    await staleWrite;

    const savedOptions = /** @type {import('settings').Options} */ (/** @type {unknown} */ (Reflect.get(backend, '_options')));
    expect(savedOptions.profiles[1].options.general.sortFrequencyDictionary).toBe('Dict');
});

/**
 * @template T
 * @returns {{promise: Promise<T>, resolve: (value: T) => void}}
 */
function deferredValue() {
    /** @type {(value: T) => void} */
    let resolve = () => {};
    const promise = new Promise((resolvePromise) => { resolve = (value) => resolvePromise(value); });
    return {promise, resolve};
}
