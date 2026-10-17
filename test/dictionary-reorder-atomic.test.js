/*
 * Copyright (C) 2026  Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, test, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';
import {DictionaryController} from '../ext/js/pages/settings/dictionary-controller.js';

function createDeferred() {
    /** @type {() => void} */
    let resolve = () => {};
    const promise = new Promise(/** @type {(resolve: (value: void) => void) => void} */ ((resolvePromise) => { resolve = () => resolvePromise(void 0); }));
    return {promise, resolve};
}

function createDeferredValue() {
    /** @type {(value: {title: string}[]) => void} */
    let resolve = () => {};
    const promise = new Promise(/** @type {(resolve: (value: {title: string}[]) => void) => void} */ ((resolvePromise) => { resolve = resolvePromise; }));
    return {promise, resolve};
}

function createHarness() {
    const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
    const options = {profiles: [
        {options: {dictionaries: [
            {name: 'A', alias: 'first', enabled: true},
            {name: 'B', alias: 'bee', enabled: true},
            {name: 'A', alias: 'second', enabled: false},
        ]}},
        {options: {dictionaries: [
            {name: 'X', alias: 'ex', enabled: true},
            {name: 'Y', alias: 'why', enabled: true},
        ]}},
    ]};
    Reflect.set(backend, '_options', options);
    Reflect.set(backend, '_optionsUtil', {save: vi.fn().mockResolvedValue(void 0)});
    Reflect.set(backend, '_applyOptions', vi.fn());
    Reflect.set(backend, '_clearProfileConditionsSchemaCache', vi.fn());
    /** @type {(target: import('settings-modifications').ScopedModification) => Promise<import('core').Response<import('settings-modifications').ModificationResult>[]>} */
    const modifyTarget = (target) => backend._modifySettings([target], 'settings');
    Reflect.set(backend, '_getModifySettingObject', (/** @type {import('settings-modifications').ScopedModification} */ target) => {
        const index = target.optionsContext?.index;
        if (typeof index !== 'number') { throw new Error('Missing profile index'); }
        return /** @type {{profiles: {options: import('settings').ProfileOptions}[]}} */ (Reflect.get(backend, '_options')).profiles[index].options;
    });
    Reflect.set(backend, '_saveOptions', async (source, stagedOptions) => {
        Reflect.set(backend, '_options', stagedOptions);
        return source;
    });
    const controller = /** @type {DictionaryController} */ (Object.create(DictionaryController.prototype));
    let profileIndex = 0;
    /** @type {ReturnType<typeof createDeferred>|null} */
    let nextReadGate = null;
    /** @type {ReturnType<typeof createDeferred>|null} */
    let modifyGate = null;
    const settingsController = {
        getOptionsContext: () => ({index: profileIndex}),
        async getOptions() {
            const optionsSnapshot = structuredClone(/** @type {{profiles: {options: import('settings').ProfileOptions}[]}} */ (Reflect.get(backend, '_options')).profiles[profileIndex].options);
            const gate = nextReadGate;
            nextReadGate = null;
            if (gate !== null) { await gate.promise; }
            return optionsSnapshot;
        },
        async modifyProfileSettings(/** @type {import('settings-modifications').Modification[]} */ targets) {
            const optionsContext = {index: profileIndex};
            const gate = modifyGate;
            modifyGate = null;
            if (gate !== null) { await gate.promise; }
            const results = await Promise.all(targets.map((target) => modifyTarget({
                ...target,
                scope: 'profile',
                optionsContext,
            })));
            return results.flat();
        },
        refresh: vi.fn().mockResolvedValue(void 0),
        trigger: vi.fn(),
    };
    Reflect.set(controller, '_settingsController', settingsController);
    Reflect.set(controller, '_updateCurrentEntries', vi.fn());
    return {
        backend,
        controller,
        settingsController,
        deferNextRead() {
            const gate = createDeferred();
            nextReadGate = gate;
            return gate;
        },
        deferModification() {
            const gate = createDeferred();
            modifyGate = gate;
            return gate;
        },
        setProfileIndex(/** @type {number} */ value) { profileIndex = value; },
    };
}

function getDictionaries(/** @type {Backend} */ backend, /** @type {number} */ profileIndex = 0) {
    return /** @type {{name: string, alias: string, enabled: boolean}[]} */ (
        /** @type {{profiles: {options: import('settings').ProfileOptions}[]}} */ (Reflect.get(backend, '_options')).profiles[profileIndex].options.dictionaries
    );
}

function enableProductionRender(/** @type {ReturnType<typeof createHarness>} */ harness) {
    const {controller, settingsController} = harness;
    /** @type {string[]} */
    const renders = [];
    Reflect.set(controller, '_dictionaries', [
        {title: 'A'}, {title: 'B'}, {title: 'X'}, {title: 'Y'},
    ]);
    Reflect.set(controller, '_dictionaryModalBody', {scrollTop: 0, scroll: vi.fn()});
    Reflect.set(controller, '_dictionaryEntries', []);
    Reflect.set(controller, '_createDictionaryEntry', (index, info) => renders.push(`${index}:${info.title}`));
    Reflect.set(controller, '_updateDictionariesEnabledWarnings', vi.fn());
    Reflect.set(controller, '_updateCurrentEntries', DictionaryController.prototype._updateCurrentEntries.bind(controller));
    // Keep the real options refresh method and render method; stub only entry-list loading.
    /** @type {Promise<void>[]} */
    const updates = [];
    Reflect.set(controller, '_testEntryUpdatePromises', updates);
    Reflect.set(controller, '_updateEntries', (token) => {
        const update = (async () => {
            const options = await settingsController.getOptions();
            if (token !== null && typeof token !== 'undefined' && !controller._isEntriesUpdateCurrent(token)) { return; }
            controller._updateCurrentEntries(options);
        })();
        updates.push(update);
        return update;
    });
    return renders;
}

function setDictionaryOrder(/** @type {Backend} */ backend, /** @type {string[]} */ names) {
    const options = /** @type {{profiles: {options: import('settings').ProfileOptions}[]}} */ (Reflect.get(backend, '_options'));
    const dictionaries = options.profiles[0].options.dictionaries;
    const byName = new Map(dictionaries.map((dictionary) => [dictionary.name, dictionary]));
    options.profiles[0].options.dictionaries = /** @type {import('settings').DictionariesOptions} */ (names.map((name) => byName.get(name)));
}

test('reorder preserves concurrent dictionary field edits and duplicate aliases', async () => {
    const {backend, controller, deferNextRead} = createHarness();
    const readGate = deferNextRead();
    const operation = controller.moveDictionaryOptions(0, 1);
    await backend._modifySettings([{
        action: 'set',
        scope: 'profile',
        optionsContext: {index: 0},
        path: 'dictionaries[1].enabled',
        value: false,
    }], 'concurrent edit');
    readGate.resolve();
    await operation;
    expect(getDictionaries(backend)).toEqual([
        {name: 'B', alias: 'bee', enabled: false},
        {name: 'A', alias: 'first', enabled: true},
        {name: 'A', alias: 'second', enabled: false},
    ]);
});

test('reorder rejects a concurrent alias swap between duplicate dictionary names', async () => {
    const {backend, controller, deferNextRead, settingsController} = createHarness();
    const readGate = deferNextRead();
    const operation = controller.moveDictionaryOptions(0, 1);
    await backend._modifySettings([{
        action: 'swap',
        scope: 'profile',
        optionsContext: {index: 0},
        path1: 'dictionaries[0].alias',
        path2: 'dictionaries[2].alias',
    }], 'concurrent alias swap');
    readGate.resolve();
    await operation;
    expect(getDictionaries(backend).map(({name, alias}) => [name, alias])).toEqual([
        ['A', 'second'], ['B', 'bee'], ['A', 'first'],
    ]);
    expect(settingsController.refresh).toHaveBeenCalledOnce();
    expect(settingsController.trigger).not.toHaveBeenCalledWith('dictionarySettingsReordered', expect.anything());
});

test('reorder rejects stale indices after an import adds a settings entry', async () => {
    const {backend, controller, deferNextRead} = createHarness();
    const readGate = deferNextRead();
    const operation = controller.moveDictionaryOptions(0, 1);
    await backend._modifySettings([{
        action: 'push',
        scope: 'profile',
        optionsContext: {index: 0},
        path: 'dictionaries',
        items: [{name: 'C', alias: 'new', enabled: true}],
    }], 'import');
    readGate.resolve();
    await operation;
    expect(getDictionaries(backend).map(({name}) => name)).toEqual(['A', 'B', 'A', 'C']);
});

test('controller renders the committed order after reordering', async () => {
    const {backend, controller} = createHarness();
    await controller.moveDictionaryOptions(0, 1);
    expect(getDictionaries(backend).map(({name}) => name)).toEqual(['B', 'A', 'A']);
    expect(Reflect.get(controller, '_updateCurrentEntries')).toHaveBeenCalledWith({dictionaries: getDictionaries(backend)});
});

test('profile switch during a pending reorder write does not render the old profile', async () => {
    const {backend, controller, deferModification, setProfileIndex, settingsController} = createHarness();
    const writeGate = deferModification();
    const operation = controller.moveDictionaryOptions(0, 1);
    await Promise.resolve();
    await Promise.resolve();
    setProfileIndex(1);
    writeGate.resolve();
    await operation;
    expect(getDictionaries(backend, 0).map(({name}) => name)).toEqual(['B', 'A', 'A']);
    expect(getDictionaries(backend, 1).map(({name}) => name)).toEqual(['X', 'Y']);
    expect(Reflect.get(controller, '_updateCurrentEntries')).not.toHaveBeenCalled();
    expect(settingsController.trigger).not.toHaveBeenCalledWith('dictionarySettingsReordered', expect.anything());
});

test('malformed moveDictionary action returns an error without persisting', async () => {
    const {backend} = createHarness();
    const saveOptions = /** @type {{save: ReturnType<typeof vi.fn>}} */ (/** @type {unknown} */ (Reflect.get(backend, '_optionsUtil')));
    const results = await backend._modifySettings([{
        action: 'moveDictionary',
        path: 'dictionaries',
        currentIndex: 0,
        targetIndex: 1,
        expectedNames: ['A', 'B', 'A'],
        expectedEntries: [],
        scope: 'profile',
        optionsContext: {index: 0},
    }], 'malformed move');
    expect(results[0]?.error).toBeDefined();
    expect(saveOptions.save).not.toHaveBeenCalled();
    expect(getDictionaries(backend).map(({name}) => name)).toEqual(['A', 'B', 'A']);
});

test('newer options render owns publication when an older committed reorder read completes', async () => {
    const harness = createHarness();
    const {backend, controller, settingsController} = harness;
    const renders = enableProductionRender(harness);
    const originalGetOptions = settingsController.getOptions.bind(settingsController);
    const oldRead = createDeferred();
    let readCount = 0;
    settingsController.getOptions = async () => {
        const snapshot = await originalGetOptions();
        ++readCount;
        if (readCount === 2) { await oldRead.promise; }
        return snapshot;
    };
    const reorder = controller.moveDictionaryOptions(0, 1);
    await vi.waitFor(() => { expect(readCount).toBe(2); });

    setDictionaryOrder(backend, ['A', 'A', 'B']);
    controller._onOptionsChanged({options: /** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({dictionaries: []})), optionsContext: {index: 0}});
    await vi.waitFor(() => { expect(renders).toEqual(['0:A', '1:A', '2:B']); });
    renders.length = 0;
    oldRead.resolve();
    await reorder;

    expect(renders).toEqual([]);
    expect(settingsController.trigger).not.toHaveBeenCalledWith('dictionarySettingsReordered', expect.anything());
});

test('newer reorder prevents an older committed read from rendering or announcing', async () => {
    const harness = createHarness();
    const {controller, settingsController} = harness;
    const renders = enableProductionRender(harness);
    const originalGetOptions = settingsController.getOptions.bind(settingsController);
    const oldRead = createDeferred();
    let readCount = 0;
    settingsController.getOptions = async () => {
        const snapshot = await originalGetOptions();
        ++readCount;
        if (readCount === 2) { await oldRead.promise; }
        return snapshot;
    };
    const first = controller.moveDictionaryOptions(0, 1);
    await vi.waitFor(() => { expect(readCount).toBe(2); });
    await controller.moveDictionaryOptions(1, 0);
    expect(renders).toEqual(['0:A', '1:B', '2:A']);
    expect(settingsController.trigger).toHaveBeenCalledTimes(1);

    renders.length = 0;
    oldRead.resolve();
    await first;
    expect(renders).toEqual([]);
    expect(settingsController.trigger).toHaveBeenCalledTimes(1);
});

test('an options refresh pending during a write cannot replace the committed reorder render', async () => {
    const harness = createHarness();
    const {backend, controller, settingsController} = harness;
    const renders = enableProductionRender(harness);
    const oldRefreshRead = createDeferred();
    const originalGetOptions = settingsController.getOptions.bind(settingsController);
    let holdNextRead = false;
    settingsController.getOptions = async () => {
        const snapshot = await originalGetOptions();
        if (holdNextRead) {
            holdNextRead = false;
            await oldRefreshRead.promise;
        }
        return snapshot;
    };

    holdNextRead = true;
    controller._onOptionsChanged({options: /** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({dictionaries: []})), optionsContext: {index: 0}});
    await Promise.resolve();
    const writeGate = harness.deferModification();
    const reorder = controller.moveDictionaryOptions(0, 1);
    await Promise.resolve();
    await Promise.resolve();
    writeGate.resolve();
    await reorder;
    expect(renders).toEqual(['0:B', '1:A', '2:A']);

    renders.length = 0;
    oldRefreshRead.resolve();
    await Promise.all(/** @type {Promise<void>[]} */ (Reflect.get(controller, '_testEntryUpdatePromises')));
    expect(renders).toEqual([]);
});

test('reorder during a pending database refresh renders the committed order', async () => {
    const {backend, controller, settingsController} = createHarness();
    const dictionaryInfoGate = createDeferredValue();
    Reflect.set(settingsController, 'getDictionaryInfo', vi.fn(() => dictionaryInfoGate.promise));
    Reflect.set(controller, '_dictionaries', null);
    Reflect.set(controller, '_dictionaryModalBody', {scrollTop: 0, scroll: vi.fn()});
    Reflect.set(controller, '_dictionaryEntries', []);
    Reflect.set(controller, '_dictionaryInstallCountNode', null);
    Reflect.set(controller, '_noDictionariesInstalledWarnings', []);
    Reflect.set(controller, '_updateDictionaryEntryCount', vi.fn());
    Reflect.set(controller, '_updateMainDictionarySelectOptions', vi.fn());
    Reflect.set(controller, '_updateDictionariesEnabledWarnings', vi.fn());
    /** @type {string[]} */
    const renders = [];
    Reflect.set(controller, '_createDictionaryEntry', (index, info) => renders.push(`${index}:${info.title}`));
    Reflect.set(controller, '_updateCurrentEntries', DictionaryController.prototype._updateCurrentEntries.bind(controller));
    Reflect.set(controller, '_updateEntries', DictionaryController.prototype._updateEntries.bind(controller));
    vi.spyOn(DictionaryController, 'ensureDictionarySettings').mockResolvedValue(void 0);

    const refresh = controller._onDatabaseUpdated();
    await vi.waitFor(() => { expect(Reflect.get(settingsController, 'getDictionaryInfo')).toHaveBeenCalledOnce(); });
    await controller.moveDictionaryOptions(0, 1);
    expect(getDictionaries(backend).map(({name}) => name)).toEqual(['B', 'A', 'A']);

    dictionaryInfoGate.resolve(/** @type {import('dictionary-importer').Summary[]} */ (/** @type {unknown} */ ([{title: 'A'}, {title: 'B'}])));
    await refresh;

    expect(renders).toEqual(['0:B', '1:A', '2:A']);
    expect(Reflect.get(controller, '_dictionaries')).not.toBeNull();
});

test('a reorder render with a null dictionary cache does not invalidate the pending database refresh', () => {
    const {controller} = createHarness();
    const pendingDatabaseRefresh = {};
    Reflect.set(controller, '_dictionaries', null);
    Reflect.set(controller, '_dictionaryModalBody', {scrollTop: 0, scroll: vi.fn()});
    Reflect.set(controller, '_entriesUpdateToken', pendingDatabaseRefresh);
    Reflect.set(controller, '_updateCurrentEntries', DictionaryController.prototype._updateCurrentEntries.bind(controller));

    controller._updateCurrentEntries(/** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({dictionaries: []})));

    expect(Reflect.get(controller, '_entriesUpdateToken')).toBe(pendingDatabaseRefresh);
});
