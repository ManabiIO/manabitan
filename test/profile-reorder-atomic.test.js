/*
 * Copyright (C) 2026  Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, test, vi} from 'vitest';
import {JSDOM} from 'jsdom';
import {Backend} from '../ext/js/background/backend.js';
import {ProfileConditionsUI} from '../ext/js/pages/settings/profile-conditions-ui.js';
import {ProfileController} from '../ext/js/pages/settings/profile-controller.js';

function deferred() {
    /** @type {() => void} */
    let resolve = () => {};
    const promise = new Promise((/** @type {(value: void) => void} */ resolvePromise) => { resolve = () => resolvePromise(void 0); });
    return {promise, resolve};
}

function deferredValue() {
    /** @type {(value: unknown) => void} */
    let resolve = () => {};
    const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
    return {promise, resolve};
}

/** @returns {Promise<void>} */
async function flush() {
    for (let i = 0; i < 20; ++i) { await Promise.resolve(); }
}

function createHarness() {
    const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
    const options = {
        profileCurrent: 0,
        profiles: [
            {id: 'a', name: 'A', options: {}, conditionGroups: []},
            {id: 'b', name: 'B', options: {}, conditionGroups: []},
            {id: 'c', name: 'C', options: {}, conditionGroups: []},
        ],
    };
    Reflect.set(backend, '_options', options);
    Reflect.set(backend, '_applyOptions', vi.fn());
    Reflect.set(backend, '_clearProfileConditionsSchemaCache', vi.fn());
    /** @type {ReturnType<typeof deferred>[]} */
    const saves = [];
    Reflect.set(backend, '_saveOptions', async (source, stagedOptions) => {
        const gate = saves.shift();
        if (gate !== void 0) { await gate.promise; }
        Reflect.set(backend, '_options', stagedOptions);
        return source;
    });
    Reflect.set(backend, '_getModifySettingObject', () => Reflect.get(backend, '_options'));

    const settingsController = {
        _profileIndex: 0,
        profileIndexChangeGeneration: 0,
        get profileIndex() { return this._profileIndex; },
        set profileIndex(value) {
            if (this._profileIndex !== value) {
                this._profileIndex = value;
                this.profileIndexChangeGeneration++;
            }
        },
        setGlobalSetting(/** @type {string} */ path, /** @type {unknown} */ value) {
            return backend._modifySettings([{action: 'set', path, value, scope: 'global', optionsContext: null}], 'settings');
        },
        modifyGlobalSettings(/** @type {import('settings-modifications').Modification[]} */ modifications) {
            return backend._modifySettings(modifications.map((modification) => ({...modification, scope: 'global', optionsContext: null})), 'settings');
        },
    };
    const controller = /** @type {ProfileController} */ (Object.create(ProfileController.prototype));
    Reflect.set(controller, '_settingsController', settingsController);
    Reflect.set(controller, '_profiles', structuredClone(options.profiles));
    Reflect.set(controller, '_profileCurrent', options.profileCurrent);
    Reflect.set(controller, '_defaultProfileWriteGeneration', 0);
    Reflect.set(controller, '_optionsUpdateToken', null);
    Reflect.set(controller, '_getProfileEntry', () => null);
    Reflect.set(controller, '_profileEntryList', []);
    Reflect.set(controller, '_updateSelectName', vi.fn());
    Reflect.set(controller, '_updateProfileSelectOptions', vi.fn());
    Reflect.set(controller, '_onOptionsChanged', vi.fn().mockResolvedValue(void 0));
    Reflect.set(settingsController, 'refresh', vi.fn().mockResolvedValue(void 0));
    Reflect.set(settingsController, 'refreshProfileIndex', vi.fn());
    return {backend, controller, saves, settingsController};
}

/**
 * @param {any} settingsController
 * @param {() => Promise<import('settings').Options>} getOptionsFull
 * @returns {{dom: JSDOM, ui: ProfileConditionsUI, restore: () => void}}
 */
function createConditionsUI(settingsController, getOptionsFull) {
    const previousDocument = globalThis.document;
    const dom = new JSDOM(`<div id="profile-condition-groups"></div>
        <button id="profile-add-condition-group"></button>
        <template id="profile-condition-group-template"><div class="profile-condition-group">
            <div class="profile-condition-list"></div>
            <button class="profile-condition-add-button"></button>
        </div></template>
        <template id="profile-condition-template"><div class="profile-condition">
            <div class="profile-condition-prefix"></div>
            <select class="profile-condition-type"><optgroup></optgroup></select>
            <select class="profile-condition-operator"><optgroup></optgroup></select>
            <input class="profile-condition-input">
            <button class="profile-condition-menu-button"></button>
            <div class="mouse-button-container"><button class="mouse-button"></button></div>
        </div></template>`);
    Reflect.set(globalThis, 'document', dom.window.document);
    Reflect.set(settingsController, 'getOptionsFull', getOptionsFull);
    Reflect.set(settingsController, 'instantiateTemplate', (/** @type {string} */ name) => {
        const template = /** @type {HTMLTemplateElement|null} */ (dom.window.document.querySelector(`#${name}-template`));
        if (template === null || template.content.firstElementChild === null) { throw new Error(`Missing template: ${name}`); }
        return template.content.firstElementChild.cloneNode(true);
    });
    const ui = new ProfileConditionsUI(/** @type {any} */ (settingsController));
    return {
        dom,
        ui,
        restore() {
            if (typeof previousDocument === 'undefined') {
                Reflect.deleteProperty(globalThis, 'document');
            } else {
                Reflect.set(globalThis, 'document', previousDocument);
            }
            dom.window.close();
        },
    };
}

/**
 * @param {JSDOM} dom
 * @param {string} selector
 * @returns {HTMLElement}
 */
function queryElement(dom, selector) {
    const element = dom.window.document.querySelector(selector);
    if (element === null) { throw new Error(`Missing element: ${selector}`); }
    return /** @type {HTMLElement} */ (element);
}

/**
 * @param {Backend} backend
 * @returns {import('settings').Options}
 */
function getBackendOptions(backend) {
    return /** @type {import('settings').Options} */ (Reflect.get(backend, '_options'));
}

test('default profile identity survives a queued reorder while its save is pending', async () => {
    const {backend, controller, saves} = createHarness();
    const firstSave = deferred();
    const reorderSave = deferred();
    saves.push(firstSave, reorderSave);

    const setDefault = controller.setDefaultProfile(1);
    await flush();
    const reorder = controller.swapProfiles(0, 1);
    await flush();

    firstSave.resolve();
    await flush();
    reorderSave.resolve();
    await Promise.all([setDefault, reorder]);

    const {profileCurrent, profiles} = /** @type {{profileCurrent: number, profiles: {id: string}[]}} */ (Reflect.get(backend, '_options'));
    expect(profiles[profileCurrent]?.id).toBe('b');
});

test('profile reorder preserves a newer explicit viewed profile choice', async () => {
    const {controller, saves, settingsController} = createHarness();
    settingsController.profileIndex = 1;
    const reorderSave = deferred();
    saves.push(reorderSave);

    const reorder = controller.swapProfiles(1, 2);
    await flush();
    settingsController.profileIndex = 0;
    reorderSave.resolve();
    await reorder;

    expect(settingsController.profileIndex).toBe(0);
});

test('profile deletion preserves a newer explicit viewed profile choice', async () => {
    const {controller, saves, settingsController} = createHarness();
    settingsController.profileIndex = 2;
    const deleteSave = deferred();
    saves.push(deleteSave);

    const deletion = controller.deleteProfile(0);
    await flush();
    settingsController.profileIndex = 0;
    deleteSave.resolve();
    await deletion;

    expect(settingsController.profileIndex).toBe(0);
});

test('reset resolves the profile again by ID after options refresh replaces profile objects', async () => {
    const {backend, controller, settingsController} = createHarness();
    /** @type {(value: {profiles: {name: string, options: object, conditionGroups: unknown[]}[]}) => void} */
    let resolveDefaults = () => {};
    const defaults = new Promise((resolve) => { resolveDefaults = resolve; });
    Reflect.set(settingsController, 'getDefaultOptions', () => defaults);
    const reset = controller.resetProfile(0);
    const persistedOptions = /** @type {{profiles: {id: string, name: string}[]}} */ (Reflect.get(backend, '_options'));
    persistedOptions.profiles[0].name = 'Latest A';
    Reflect.set(controller, '_profiles', [
        {id: 'a', name: 'Latest A', options: {}, conditionGroups: []},
        {id: 'b', name: 'B', options: {}, conditionGroups: []},
        {id: 'c', name: 'C', options: {}, conditionGroups: []},
    ]);
    resolveDefaults({profiles: [{name: 'Default', options: {reset: true}, conditionGroups: []}]});
    await reset;

    const {profiles} = /** @type {{profiles: {id: string, name: string, options: object}[]}} */ (Reflect.get(backend, '_options'));
    expect(profiles.find(({id}) => id === 'a')).toMatchObject({options: {reset: true}});
});

test.each([{action: 'copy'}, {action: 'reset'}, {action: 'duplicate'}, {action: 'delete'}])('$action failure waits for authoritative reconciliation and preserves the write error', async ({action}) => {
    const {controller, settingsController} = createHarness();
    const reconciliation = deferred();
    const writeError = new Error('write failed');
    settingsController.modifyGlobalSettings = vi.fn().mockRejectedValue(writeError);
    Reflect.set(controller, '_onOptionsChanged', vi.fn(() => reconciliation.promise));
    Reflect.set(settingsController, 'getDefaultOptions', async () => ({profiles: [{options: {reset: true}, conditionGroups: []}]}));

    let settled = false;
    const operations = /** @type {Record<string, () => Promise<void>>} */ ({
        copy: () => controller.copyProfile(0, 1),
        reset: () => controller.resetProfile(0),
        duplicate: () => controller.duplicateProfile(0),
        delete: () => controller.deleteProfile(0),
    });
    const operation = operations[action]();
    const result = operation.then((value) => ({value}), (error) => {
        settled = true;
        return {error};
    });
    await flush();
    expect(settled).toBe(false);
    reconciliation.resolve();
    expect(await result).toStrictEqual({error: writeError});
    expect(Reflect.get(controller, '_onOptionsChanged')).toHaveBeenCalledOnce();
});

test('an unknown profile identity fails closed without changing settings', async () => {
    const {backend} = createHarness();
    const before = structuredClone(Reflect.get(backend, '_options'));

    const results = await backend._modifySettings([{
        action: 'setDefaultProfile',
        profileId: 'removed-profile',
        scope: 'global',
        optionsContext: null,
    }], 'settings');

    const error = results[0]?.error;
    expect(error !== void 0 && 'message' in error ? error.message : '').toContain('Profile identity changed');
    expect(Reflect.get(backend, '_options')).toStrictEqual(before);
});

test('a name edit queued behind a reorder follows the profile identity', async () => {
    const {backend, controller, saves} = createHarness();
    const reorderSave = deferred();
    saves.push(reorderSave);

    const reorder = backend._modifySettings([{
        action: 'swapProfiles', profileId1: 'a', profileId2: 'b', scope: 'global', optionsContext: null,
    }], 'other-tab');
    await flush();
    const rename = controller.setProfileName(0, 'Renamed A');
    await flush();
    reorderSave.resolve();
    await Promise.all([reorder, rename]);

    const {profiles} = /** @type {{profiles: {id: string, name: string}[]}} */ (Reflect.get(backend, '_options'));
    expect(profiles.find(({id}) => id === 'a')?.name).toBe('Renamed A');
    expect(profiles.find(({id}) => id === 'b')?.name).toBe('B');
});

test('a frontend-produced condition edit queued behind a reorder follows profile identity', async () => {
    const {backend, saves, settingsController} = createHarness();
    const {ui, dom, restore} = createConditionsUI(settingsController, async () => getBackendOptions(backend));
    await ui.prepare(0, 'a');
    const reorderSave = deferred();
    saves.push(reorderSave);
    const reorder = backend._modifySettings([{
        action: 'swapProfiles', profileId1: 'a', profileId2: 'b', scope: 'global', optionsContext: null,
    }], 'other-tab');
    await flush();

    try {
        queryElement(dom, '#profile-add-condition-group').click();
        reorderSave.resolve();
        await reorder;
        await flush();

        const {profiles} = /** @type {{profiles: {id: string, conditionGroups: unknown[]}[]}} */ (Reflect.get(backend, '_options'));
        expect(profiles.find(({id}) => id === 'a')?.conditionGroups).toHaveLength(1);
        expect(profiles.find(({id}) => id === 'b')?.conditionGroups).toHaveLength(0);
    } finally {
        restore();
    }
});

test('rapid frontend condition edits serialize against each optimistic snapshot', async () => {
    const {backend, settingsController} = createHarness();
    const ui = /** @type {ProfileConditionsUI} */ (Object.create(ProfileConditionsUI.prototype));
    Reflect.set(ui, '_settingsController', settingsController);
    Reflect.set(ui, '_profileId', 'a');
    Reflect.set(ui, '_conditionGroups', []);
    Reflect.set(ui, '_conditionGroupsMutationGeneration', 0);
    Reflect.set(ui, '_prepareToken', {});
    Reflect.set(ui, '_children', []);
    Reflect.set(ui, '_addConditionGroup', () => { Reflect.get(ui, '_children').push(/** @type {any} */ ({})); });
    Reflect.set(ui, '_triggerConditionGroupCountChanged', vi.fn());
    Reflect.set(ui, 'getDefaultCondition', () => ({type: 'popupLevel', operator: 'equal', value: '0'}));

    ui._onAddConditionGroupButtonClick();
    ui._onAddConditionGroupButtonClick();
    await flush();

    const {profiles} = /** @type {{profiles: {id: string, conditionGroups: unknown[]}[]}} */ (Reflect.get(backend, '_options'));
    expect(profiles.find(({id}) => id === 'a')?.conditionGroups).toHaveLength(2);
    expect(profiles.find(({id}) => id === 'b')?.conditionGroups).toHaveLength(0);
});

test('rapid type, operator, and value changes are preserved in order', async () => {
    const {backend, settingsController} = createHarness();
    const options = /** @type {import('settings').Options} */ (Reflect.get(backend, '_options'));
    options.profiles[0].conditionGroups = [{conditions: [{type: 'popupLevel', operator: 'equal', value: '0'}]}];
    const {ui, dom, restore} = createConditionsUI(settingsController, async () => getBackendOptions(backend));
    try {
        await ui.prepare(0, 'a');
        const type = /** @type {HTMLSelectElement} */ (queryElement(dom, '.profile-condition-type'));
        type.value = 'url';
        type.dispatchEvent(new dom.window.Event('change', {bubbles: true}));
        const operator = /** @type {HTMLSelectElement} */ (queryElement(dom, '.profile-condition-operator'));
        operator.value = 'matchRegExp';
        operator.dispatchEvent(new dom.window.Event('change', {bubbles: true}));
        const input = /** @type {HTMLInputElement} */ (queryElement(dom, '.profile-condition-input'));
        input.value = 'example\\.org';
        input.dispatchEvent(new dom.window.Event('change', {bubbles: true}));
        await flush();

        const {profiles} = /** @type {import('settings').Options} */ (Reflect.get(backend, '_options'));
        expect(profiles[0].conditionGroups[0].conditions[0]).toStrictEqual({
            type: 'url', operator: 'matchRegExp', value: 'example\\.org',
        });
    } finally {
        ui.cleanup();
        restore();
    }
});

test('operator change does not persist an invalid flags input value', async () => {
    const {backend, settingsController} = createHarness();
    const options = /** @type {import('settings').Options} */ (Reflect.get(backend, '_options'));
    options.profiles[0].conditionGroups = [{conditions: [{type: 'flags', operator: 'are', value: 'clipboard'}]}];
    const {ui, dom, restore} = createConditionsUI(settingsController, async () => getBackendOptions(backend));
    try {
        await ui.prepare(0, 'a');
        const input = /** @type {HTMLInputElement} */ (queryElement(dom, '.profile-condition-input'));
        input.value = 'not-a-valid-flag';
        input.dispatchEvent(new dom.window.Event('change', {bubbles: true}));

        const operator = /** @type {HTMLSelectElement} */ (queryElement(dom, '.profile-condition-operator'));
        operator.value = 'areNot';
        operator.dispatchEvent(new dom.window.Event('change', {bubbles: true}));
        await flush();

        expect(getBackendOptions(backend).profiles[0].conditionGroups[0].conditions[0]).toStrictEqual({
            type: 'flags', operator: 'areNot', value: 'clipboard',
        });
        expect(input.value).toBe('not-a-valid-flag');
        expect(input.dataset.invalid).toBe('true');
    } finally {
        ui.cleanup();
        restore();
    }
});

test('deleting the last condition cascades its group removal in the same-tab queue', async () => {
    const {backend, settingsController} = createHarness();
    const options = /** @type {import('settings').Options} */ (Reflect.get(backend, '_options'));
    options.profiles[0].conditionGroups = [{conditions: [{type: 'popupLevel', operator: 'equal', value: '0'}]}];
    const {ui, dom, restore} = createConditionsUI(settingsController, async () => getBackendOptions(backend));
    try {
        await ui.prepare(0, 'a');
        const menuButton = queryElement(dom, '.profile-condition-menu-button');
        menuButton.dispatchEvent(new dom.window.CustomEvent('menuClose', {detail: {action: 'delete'}}));
        await flush();

        const {profiles} = getBackendOptions(backend);
        expect(profiles[0].conditionGroups).toStrictEqual([]);
    } finally {
        ui.cleanup();
        restore();
    }
});

test.each([
    {name: 'deleted', profiles: [{id: 'b', name: 'B', options: {}, conditionGroups: []}]},
    {
        name: 'duplicated',
        profiles: [
            {id: 'a', name: 'A', options: {}, conditionGroups: []},
            {id: 'a', name: 'duplicate', options: {}, conditionGroups: []},
        ],
    },
    {name: 'missing', profiles: [{name: 'legacy', options: {}, conditionGroups: []}]},
])('frontend-produced condition mutation fails closed when its profile identity is $name', async ({profiles}) => {
    const {backend, settingsController} = createHarness();
    const {ui, dom, restore} = createConditionsUI(settingsController, async () => getBackendOptions(backend));
    await ui.prepare(0, 'a');
    const options = /** @type {import('settings').Options} */ (Reflect.get(backend, '_options'));
    Reflect.set(options, 'profiles', profiles);
    const before = structuredClone(options);

    try {
        queryElement(dom, '#profile-add-condition-group').click();
        await flush();

        expect(Reflect.get(backend, '_options')).toStrictEqual(before);
        expect(Reflect.get(ui, '_conditionGroups')).toHaveLength(1);
    } finally {
        ui.cleanup();
        restore();
    }
});

test('condition compare-and-swap rejects stale nested structure without overwriting it', async () => {
    const {backend} = createHarness();
    const options = /** @type {import('settings').Options} */ (Reflect.get(backend, '_options'));
    options.profiles[0].conditionGroups = [{conditions: [{type: 'url', operator: 'matchDomain', value: 'changed.example'}]}];
    const before = structuredClone(options);

    const results = await backend._modifySettings([{
        action: 'setProfileConditionGroups',
        profileId: 'a',
        expectedConditionGroups: [],
        value: [{conditions: [{type: 'popupLevel', operator: 'equal', value: '0'}]}],
        scope: 'global',
        optionsContext: null,
    }], 'other-tab');

    expect(results[0]?.error).toBeDefined();
    expect(Reflect.get(backend, '_options')).toStrictEqual(before);
});

test('frontend edit fails closed after another tab removes the edited condition group', async () => {
    const {backend, saves, settingsController} = createHarness();
    const options = getBackendOptions(backend);
    options.profiles[0].conditionGroups = [
        {conditions: [{type: 'url', operator: 'matchDomain', value: 'first.example'}]},
        {conditions: [{type: 'url', operator: 'matchDomain', value: 'second.example'}]},
    ];
    const {ui, dom, restore} = createConditionsUI(settingsController, async () => getBackendOptions(backend));
    try {
        await ui.prepare(0, 'a');
        const externalSave = deferred();
        saves.push(externalSave);
        const removeGroup = backend._modifySettings([{
            action: 'splice',
            path: 'profiles[0].conditionGroups',
            start: 0,
            deleteCount: 1,
            items: [],
            scope: 'global',
            optionsContext: null,
        }], 'other-tab');
        await flush();

        const input = /** @type {HTMLInputElement} */ (queryElement(dom, '.profile-condition-input'));
        input.value = 'would-be-wrong-row.example';
        input.dispatchEvent(new dom.window.Event('change', {bubbles: true}));

        externalSave.resolve();
        await removeGroup;
        await flush();

        expect(getBackendOptions(backend).profiles[0].conditionGroups).toStrictEqual([
            {conditions: [{type: 'url', operator: 'matchDomain', value: 'second.example'}]},
        ]);
        expect(Reflect.get(ui, '_conditionGroups')).toStrictEqual(getBackendOptions(backend).profiles[0].conditionGroups);
        expect(dom.window.document.querySelectorAll('.profile-condition-group')).toHaveLength(1);
    } finally {
        ui.cleanup();
        restore();
    }
});

test('late condition failure from a closed dialog cannot reconcile a reopened dialog for the same profile', async () => {
    const {backend, settingsController} = createHarness();
    const oldWrite = deferredValue();
    const newWrite = deferredValue();
    const modifyGlobalSettings = vi.fn()
        .mockReturnValueOnce(oldWrite.promise)
        .mockReturnValueOnce(newWrite.promise);
    const getOptionsFull = vi.fn().mockResolvedValue({profiles: [
        {id: 'a', name: 'A', options: {}, conditionGroups: []},
    ]});
    Reflect.set(settingsController, 'modifyGlobalSettings', modifyGlobalSettings);
    Reflect.set(settingsController, 'getOptionsFull', getOptionsFull);

    const ui = /** @type {ProfileConditionsUI} */ (Object.create(ProfileConditionsUI.prototype));
    Reflect.set(ui, '_settingsController', settingsController);
    Reflect.set(ui, '_profileId', 'a');
    Reflect.set(ui, '_conditionGroups', []);
    Reflect.set(ui, '_conditionGroupsMutationGeneration', 0);
    Reflect.set(ui, '_prepareToken', {});
    Reflect.set(ui, '_children', []);
    Reflect.set(ui, '_addConditionGroup', () => { Reflect.get(ui, '_children').push(/** @type {any} */ ({cleanup: vi.fn()})); });
    Reflect.set(ui, '_addConditionGroupButton', {});
    Reflect.set(ui, '_eventListeners', {addEventListener: vi.fn(), removeAllEventListeners: vi.fn()});
    const countChanged = vi.fn();
    Reflect.set(ui, '_triggerConditionGroupCountChanged', countChanged);

    ui.updateConditionGroups((conditionGroups) => { conditionGroups.push({conditions: []}); });
    ui.cleanup();
    await ui.prepare(0, 'a');
    ui.updateConditionGroups((conditionGroups) => { conditionGroups.push({conditions: [{type: 'url', operator: 'matchDomain', value: 'new.example'}]}); });

    oldWrite.resolve([{error: {message: 'stale write rejected'}}]);
    await flush();

    expect(getOptionsFull).toHaveBeenCalledOnce();
    expect(Reflect.get(ui, '_conditionGroups')).toHaveLength(1);
    expect(Reflect.get(ui, '_conditionGroupsMutationGeneration')).toBeGreaterThan(1);
    expect(countChanged).not.toHaveBeenCalled();

    newWrite.resolve([{}]);
    await flush();
    expect(getBackendOptions(backend).profiles[0].conditionGroups).toStrictEqual([]);
});

test('condition CAS reconciliation refreshes the profile entry group count', async () => {
    const {settingsController} = createHarness();
    Reflect.set(settingsController, 'modifyGlobalSettings', vi.fn().mockResolvedValue([{error: {message: 'stale write rejected'}}]));
    Reflect.set(settingsController, 'getOptionsFull', vi.fn().mockResolvedValue({profiles: [
        {id: 'a', name: 'A', options: {}, conditionGroups: [{conditions: []}, {conditions: []}]},
    ]}));
    const ui = /** @type {ProfileConditionsUI} */ (Object.create(ProfileConditionsUI.prototype));
    Reflect.set(ui, '_settingsController', settingsController);
    Reflect.set(ui, '_profileId', 'a');
    Reflect.set(ui, '_profileIndex', 0);
    Reflect.set(ui, '_conditionGroups', []);
    Reflect.set(ui, '_conditionGroupsMutationGeneration', 0);
    Reflect.set(ui, '_prepareToken', {});
    Reflect.set(ui, '_children', []);
    Reflect.set(ui, '_addConditionGroup', () => { Reflect.get(ui, '_children').push(/** @type {any} */ ({cleanup: vi.fn()})); });
    const countChanged = vi.fn();
    Reflect.set(ui, '_triggerConditionGroupCountChanged', countChanged);

    ui.updateConditionGroups((conditionGroups) => { conditionGroups.push({conditions: []}); });
    await flush();

    expect(countChanged).toHaveBeenLastCalledWith(2);
    expect(Reflect.get(ui, '_children')).toHaveLength(2);
    expect(Reflect.get(ui, '_conditionGroups')).toHaveLength(2);
});

test('copy queued behind a reorder resolves source and destination by identity', async () => {
    const {backend, controller, saves} = createHarness();
    const profiles = Reflect.get(controller, '_profiles');
    Reflect.set(profiles[0], 'options', {marker: 'A snapshot'});
    Reflect.set(profiles[1], 'options', {marker: 'B'});
    Reflect.set(profiles[2], 'options', {marker: 'C snapshot'});
    const reorderSave = deferred();
    saves.push(reorderSave);

    const reorder = backend._modifySettings([{
        action: 'swapProfiles', profileId1: 'a', profileId2: 'b', scope: 'global', optionsContext: null,
    }], 'other-tab');
    await flush();
    const copy = controller.copyProfile(2, 0);
    await flush();
    reorderSave.resolve();
    await Promise.all([reorder, copy]);

    const {profiles: persisted} = /** @type {{profiles: {id: string, options: object}[]}} */ (Reflect.get(backend, '_options'));
    expect(persisted.find(({id}) => id === 'a')?.options).toStrictEqual({marker: 'C snapshot'});
    expect(persisted.find(({id}) => id === 'b')?.options).toStrictEqual({});
});

test('duplication queued behind a reorder appends a snapshot of the selected profile', async () => {
    const {backend, controller, saves} = createHarness();
    Reflect.set(Reflect.get(controller, '_profiles')[0], 'options', {marker: 'A snapshot'});
    const reorderSave = deferred();
    saves.push(reorderSave);

    const reorder = backend._modifySettings([{
        action: 'swapProfiles', profileId1: 'a', profileId2: 'b', scope: 'global', optionsContext: null,
    }], 'other-tab');
    await flush();
    const duplicate = controller.duplicateProfile(0);
    await flush();
    reorderSave.resolve();
    await Promise.all([reorder, duplicate]);

    const {profiles} = /** @type {{profiles: {id: string, name: string, options: object}[]}} */ (Reflect.get(backend, '_options'));
    expect(profiles.slice(0, 3).map(({id}) => id)).toEqual(['b', 'a', 'c']);
    expect(profiles).toHaveLength(4);
    expect(profiles[3]?.id).toEqual(expect.any(String));
    expect(profiles[3]?.name).toBe('A (Copy)');
    expect(profiles[3]?.options).toStrictEqual({marker: 'A snapshot'});
});

test('deletion queued behind a reorder removes the selected identity and preserves the default identity', async () => {
    const {backend, controller, saves, settingsController} = createHarness();
    const reorderSave = deferred();
    saves.push(reorderSave);

    const reorder = backend._modifySettings([{
        action: 'swapProfiles', profileId1: 'a', profileId2: 'b', scope: 'global', optionsContext: null,
    }], 'other-tab');
    await flush();
    const deletion = controller.deleteProfile(0);
    await flush();
    reorderSave.resolve();
    await Promise.all([reorder, deletion]);

    const {profileCurrent, profiles} = /** @type {{profileCurrent: number, profiles: {id: string}[]}} */ (Reflect.get(backend, '_options'));
    expect(profiles.map(({id}) => id)).toEqual(['b', 'c']);
    expect(profiles[profileCurrent]?.id).toBe('b');
    expect(settingsController.profileIndex).toBe(0);
});

test('reset queued behind a name change preserves the latest profile name', async () => {
    const {backend, controller, saves} = createHarness();
    const localProfiles = Reflect.get(controller, '_profiles');
    localProfiles[0].name = 'Stale name';
    const defaults = {profiles: [{name: 'Default', options: {reset: true}, conditionGroups: []}]};
    const renameSave = deferred();
    const resetSave = deferred();
    saves.push(renameSave, resetSave);
    Reflect.set(Reflect.get(controller, '_settingsController'), 'getDefaultOptions', vi.fn().mockResolvedValue(defaults));

    const rename = backend._modifySettings([{
        action: 'set', path: 'profiles[0].name', value: 'Latest name', scope: 'global', optionsContext: null,
    }], 'other-tab');
    await flush();
    const reset = controller.resetProfile(0);
    await flush();
    renameSave.resolve();
    await flush();
    resetSave.resolve();
    await Promise.all([rename, reset]);

    const {profiles: persisted} = /** @type {{profiles: {id: string, name: string, options: object}[]}} */ (Reflect.get(backend, '_options'));
    expect(persisted[0]).toStrictEqual({id: 'a', name: 'Latest name', options: {reset: true}, conditionGroups: []});
});

test('profile identity actions reject ambiguous IDs and protect the last profile', async () => {
    const {backend} = createHarness();
    const options = /** @type {{profileCurrent: number, profiles: {id: string, name: string, options: object, conditionGroups: unknown[]}[]}} */ (Reflect.get(backend, '_options'));
    options.profiles.push({...options.profiles[0]});
    const before = structuredClone(options);

    const ambiguous = await backend._modifySettings([{
        action: 'setProfileName', profileId: 'a', value: 'Wrong', scope: 'global', optionsContext: null,
    }], 'settings');
    expect(JSON.stringify(ambiguous[0]?.error)).toContain('Profile identity changed');
    expect(Reflect.get(backend, '_options')).toStrictEqual(before);

    Reflect.set(backend, '_options', {profileCurrent: 0, profiles: [options.profiles[0]]});
    const lastProfile = await backend._modifySettings([{
        action: 'deleteProfile', profileId: 'a', scope: 'global', optionsContext: null,
    }], 'settings');
    expect(JSON.stringify(lastProfile[0]?.error)).toContain('Cannot delete the last profile');
    const remainingOptions = /** @type {{profiles: object[]}} */ (Reflect.get(backend, '_options'));
    expect(remainingOptions.profiles).toHaveLength(1);
});
