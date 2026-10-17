/*
 * Copyright (C) 2026  Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {beforeEach, expect, test, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';
import {SettingsController} from '../ext/js/pages/settings/settings-controller.js';

beforeEach(() => {
    vi.stubGlobal('chrome', {permissions: {}});
});

function deferred() {
    /** @type {() => void} */
    let resolve = () => {};
    const promise = new Promise((resolvePromise) => { resolve = () => resolvePromise(void 0); });
    return {promise, resolve};
}

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

function createHarness() {
    const options = {
        profileCurrent: 0,
        profiles: [
            {id: 'a', name: 'A', options: {general: {enable: true}}, conditionGroups: []},
            {id: 'b', name: 'B', options: {general: {enable: true}}, conditionGroups: []},
        ],
    };
    const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
    Reflect.set(backend, '_options', options);
    Reflect.set(backend, '_optionsUtil', {createValidatingProxy: (/** @type {import('settings').Options} */ value) => value});
    Reflect.set(backend, '_profileConditionsSchemaCache', []);
    Reflect.set(backend, '_applyOptions', vi.fn());
    Reflect.set(backend, '_clearProfileConditionsSchemaCache', vi.fn());
    const firstSave = deferred();
    let saveCount = 0;
    /**
     * @param {string} _source
     * @param {import('settings').Options} value
     */
    const saveOptions = async (_source, value) => {
        if (++saveCount === 1) { await firstSave.promise; }
        Reflect.set(backend, '_options', value);
    };
    Reflect.set(backend, '_saveOptions', saveOptions);

    const application = {
        on: vi.fn(),
        api: {
            optionsGet: (/** @type {import('settings').OptionsContext} */ optionsContext) => backend._onApiOptionsGet({optionsContext}, /** @type {chrome.runtime.MessageSender} */ (/** @type {unknown} */ ({}))),
            optionsGetFull: () => backend._onApiOptionsGetFull(undefined, /** @type {chrome.runtime.MessageSender} */ (/** @type {unknown} */ ({}))),
            getSettings: (/** @type {import('settings-modifications').ScopedRead[]} */ targets) => backend._onApiGetSettings({targets}, /** @type {chrome.runtime.MessageSender} */ (/** @type {unknown} */ ({}))),
            modifySettings: (/** @type {import('settings-modifications').ScopedModification[]} */ targets, /** @type {string} */ source) => backend._onApiModifySettings({targets, source}, /** @type {chrome.runtime.MessageSender} */ (/** @type {unknown} */ ({}))),
            setAllSettings: async (/** @type {import('settings').Options} */ value) => { Reflect.set(backend, '_options', value); },
        },
    };
    const settingsController = new SettingsController(/** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ (application)));
    Reflect.set(settingsController, '_templates', {loadFromFiles: vi.fn()});
    Reflect.set(settingsController, '_source', 'settings-tab');
    return {backend, settingsController, firstSave, options};
}

test('profile-scoped settings writes stay with the selected Settings profile across a queued reorder', async () => {
    const {backend, settingsController, firstSave} = createHarness();
    await settingsController.prepare();
    const blockingWrite = backend._modifySettings([{
        action: 'set', scope: 'global', optionsContext: null, path: 'profileCurrent', value: 0,
    }], 'blocking-write');
    await Promise.resolve();

    const reorder = backend._modifySettings([{
        action: 'swapProfiles', profileId1: 'a', profileId2: 'b', scope: 'global', optionsContext: null,
    }], 'other-settings-tab');
    const profileWrite = settingsController.modifyProfileSettings([{
        action: 'set', path: 'general.enable', value: false,
    }]);
    firstSave.resolve();
    await Promise.all([blockingWrite, reorder, profileWrite]);

    const options = /** @type {import('settings').Options} */ (/** @type {unknown} */ (Reflect.get(backend, '_options')));
    expect(options.profiles.find(({id}) => id === 'a')?.options.general.enable).toBe(false);
    expect(options.profiles.find(({id}) => id === 'b')?.options.general.enable).toBe(true);
});

test('profile-scoped reads and writes retain selected identity after an authoritative reorder refresh', async () => {
    const {backend, settingsController, firstSave} = createHarness();
    await settingsController.prepare();
    firstSave.resolve();
    Reflect.set(backend, '_options', {
        profileCurrent: 0,
        profiles: [
            {id: 'b', name: 'B', options: {general: {enable: false}}, conditionGroups: []},
            {id: 'a', name: 'A', options: {general: {enable: true}}, conditionGroups: []},
        ],
    });

    await settingsController.refresh();
    expect(settingsController.profileIndex).toBe(1);
    await expect(settingsController.getProfileSettings([{path: 'general.enable'}])).resolves.toEqual([{result: true}]);
    const [writeResult] = await settingsController.setProfileSetting('general.enable', false);
    expect(writeResult).toEqual({result: false});
    const options = /** @type {import('settings').Options} */ (/** @type {unknown} */ (Reflect.get(backend, '_options')));
    expect(options.profiles.find(({id}) => id === 'a')?.options.general.enable).toBe(false);
    expect(options.profiles.find(({id}) => id === 'b')?.options.general.enable).toBe(false);
});

test('profile read callers with an explicit optionsContext keep that context', async () => {
    const {settingsController} = createHarness();
    await settingsController.prepare();

    await expect(settingsController.getSettings([{
        scope: 'profile', optionsContext: {index: 1}, path: 'general.enable',
    }])).resolves.toEqual([{result: true}]);
});

test('other-tab optionsUpdated refresh keeps Settings reads, UI snapshot, and writes on the selected profile ID', async () => {
    const {backend, settingsController, firstSave} = createHarness();
    await settingsController.prepare();
    firstSave.resolve();
    Reflect.set(backend, '_options', {
        profileCurrent: 0,
        profiles: [
            {id: 'b', name: 'B', options: {general: {enable: false}}, conditionGroups: []},
            {id: 'a', name: 'A', options: {general: {enable: true}}, conditionGroups: []},
        ],
    });

    const refreshed = new Promise((resolve) => {
        settingsController.on('optionsChanged', resolve);
    });
    const optionsUpdated = /** @type {(details: {source: string}) => void} */ (Reflect.get(settingsController, '_onOptionsUpdated').bind(settingsController));
    optionsUpdated({source: 'other-settings-tab'});
    const details = await refreshed;

    expect(settingsController.profileIndex).toBe(1);
    expect(details).toMatchObject({options: {general: {enable: true}}, optionsContext: {index: 1, profileId: 'a'}});
    const [writeResult] = await settingsController.setProfileSetting('general.enable', false);
    expect(writeResult).toEqual({result: false});
    const options = /** @type {import('settings').Options} */ (/** @type {unknown} */ (Reflect.get(backend, '_options')));
    expect(options.profiles.find(({id}) => id === 'a')?.options.general.enable).toBe(false);
    expect(options.profiles.find(({id}) => id === 'b')?.options.general.enable).toBe(false);
});

test('selecting a new numeric index after reorder captures the profile at that index', async () => {
    const {backend, settingsController, firstSave} = createHarness();
    await settingsController.prepare();
    firstSave.resolve();
    Reflect.set(backend, '_options', {
        profileCurrent: 0,
        profiles: [
            {id: 'b', name: 'B', options: {general: {enable: true}}, conditionGroups: []},
            {id: 'a', name: 'A', options: {general: {enable: true}}, conditionGroups: []},
        ],
    });
    await settingsController.refresh();
    settingsController.profileIndex = 0;
    await settingsController.refresh();

    await settingsController.setProfileSetting('general.enable', false);
    const options = /** @type {import('settings').Options} */ (/** @type {unknown} */ (Reflect.get(backend, '_options')));
    expect(options.profiles.find(({id}) => id === 'b')?.options.general.enable).toBe(false);
    expect(options.profiles.find(({id}) => id === 'a')?.options.general.enable).toBe(true);
});

test('profile reads with URL conditions still resolve the matching non-default profile', async () => {
    const {backend} = createHarness();
    Reflect.set(backend, '_options', {
        profileCurrent: 0,
        profiles: [
            {id: 'a', name: 'A', options: {general: {enable: false}}, conditionGroups: []},
            {
                id: 'b',
                name: 'B',
                options: {general: {enable: true}},
                conditionGroups: [{conditions: [{type: 'url', operator: 'matchDomain', value: 'example.com'}]}],
            },
        ],
    });

    const context = /** @type {import('settings').OptionsContext} */ (/** @type {unknown} */ ({depth: 0, url: 'https://example.com/'}));
    expect(backend._getProfileOptions(context, false).general.enable).toBe(true);

    const legacyNumericContext = /** @type {import('settings').OptionsContext} */ (/** @type {unknown} */ ({index: 0, depth: 0, url: 'https://example.com/'}));
    expect(backend._getProfileOptions(legacyNumericContext, false).general.enable).toBe(false);

    const stableIdentityContext = /** @type {import('settings').OptionsContext} */ (/** @type {unknown} */ ({index: 0, profileId: 'b', depth: 0, url: 'https://example.com/'}));
    expect(backend._getProfileOptions(stableIdentityContext, false).general.enable).toBe(true);
});

test('deleting the selected profile refreshes controls and subsequent writes on the fallback profile', async () => {
    const {backend, settingsController, firstSave} = createHarness();
    await settingsController.prepare();
    firstSave.resolve();
    Reflect.set(backend, '_options', {
        profileCurrent: 0,
        profiles: [{id: 'b', name: 'B', options: {general: {enable: true}}, conditionGroups: []}],
    });
    const refreshed = new Promise((resolve) => {
        settingsController.on('optionsChanged', resolve);
    });

    await settingsController.refresh();
    const details = await refreshed;
    expect(details).toMatchObject({options: {general: {enable: true}}, optionsContext: {index: 0, profileId: 'b'}});
    await settingsController.setProfileSetting('general.enable', false);
    expect((/** @type {import('settings').Options} */ (/** @type {unknown} */ (backend._options))).profiles[0].options.general.enable).toBe(false);
});

test('setAllSettings uses the imported profile snapshot to capture the selected ID', async () => {
    const {backend, settingsController, firstSave} = createHarness();
    await settingsController.prepare();
    firstSave.resolve();
    const imported = {
        profileCurrent: 1,
        profiles: [
            {id: 'b', name: 'B', options: {general: {enable: true}}, conditionGroups: []},
            {id: 'a', name: 'A', options: {general: {enable: true}}, conditionGroups: []},
        ],
    };
    await settingsController.setAllSettings(/** @type {import('settings').Options} */ (/** @type {unknown} */ (imported)));
    await settingsController.setProfileSetting('general.enable', false);
    const options = /** @type {import('settings').Options} */ (/** @type {unknown} */ (Reflect.get(backend, '_options')));
    expect(options.profiles.find(({id}) => id === 'a')?.options.general.enable).toBe(false);
    expect(options.profiles.find(({id}) => id === 'b')?.options.general.enable).toBe(true);
});

test('setAllSettings refreshes settings controls after replacing a profile with the same ID and index', async () => {
    const {settingsController, firstSave} = createHarness();
    await settingsController.prepare();
    firstSave.resolve();
    const trigger = vi.spyOn(settingsController, 'trigger');
    const imported = {
        profileCurrent: 0,
        profiles: [
            {id: 'a', name: 'A', options: {general: {enable: false}}, conditionGroups: []},
            {id: 'b', name: 'B', options: {general: {enable: true}}, conditionGroups: []},
        ],
    };

    await settingsController.setAllSettings(/** @type {import('settings').Options} */ (/** @type {unknown} */ (imported)));

    expect(trigger).toHaveBeenCalledWith('optionsContextChanged', {});
    expect(trigger).toHaveBeenCalledWith('optionsChanged', {
        options: imported.profiles[0].options,
        optionsContext: {index: 0, profileId: 'a'},
    });
});

test('setAllSettings invalidates an in-flight options refresh even when the selected ID and index are unchanged', async () => {
    const {backend, settingsController, firstSave} = createHarness();
    await settingsController.prepare();
    firstSave.resolve();
    const staleOptions = deferredValue();
    const optionsStarted = deferredValue();
    Reflect.set(settingsController.application.api, 'optionsGet', vi.fn()
        .mockImplementationOnce(() => {
            optionsStarted.resolve(void 0);
            return staleOptions.promise;
        })
        .mockImplementation((optionsContext) => backend._getProfileOptions(optionsContext, false)));
    const trigger = vi.spyOn(settingsController, 'trigger');

    const staleRefresh = settingsController.refresh();
    await optionsStarted.promise;
    const imported = {
        profileCurrent: 0,
        profiles: [
            {id: 'a', name: 'A', options: {general: {enable: false}}, conditionGroups: []},
            {id: 'b', name: 'B', options: {general: {enable: true}}, conditionGroups: []},
        ],
    };
    await settingsController.setAllSettings(/** @type {import('settings').Options} */ (/** @type {unknown} */ (imported)));
    staleOptions.resolve({general: {enable: true}});
    await staleRefresh;

    expect(trigger).toHaveBeenCalledTimes(2);
    expect(trigger).toHaveBeenLastCalledWith('optionsChanged', {
        options: imported.profiles[0].options,
        optionsContext: {index: 0, profileId: 'a'},
    });
});

test('rapid profile selection ignores stale full-options completions', async () => {
    const {settingsController} = createHarness();
    await settingsController.prepare();
    /** @type {Array<ReturnType<typeof deferredValue<import('settings').Options>>>} */
    const pending = [];
    Reflect.set(settingsController.application.api, 'optionsGetFull', () => {
        const request = deferredValue();
        pending.push(request);
        return request.promise;
    });
    /** @type {Promise<void>[]} */
    const refreshes = [];
    const originalRefresh = settingsController._onOptionsUpdatedInternal.bind(settingsController);
    Reflect.set(settingsController, '_onOptionsUpdatedInternal', (canUpdateProfileIndex) => {
        const refresh = originalRefresh(canUpdateProfileIndex);
        refreshes.push(refresh);
        return refresh;
    });
    settingsController.profileIndex = 1;
    settingsController.profileIndex = 0;
    expect(pending).toHaveLength(2);
    expect(refreshes).toHaveLength(2);
    pending[1].resolve(/** @type {import('settings').Options} */ (/** @type {unknown} */ ({
        profileCurrent: 0,
        profiles: [
            {id: 'b', name: 'B', options: {general: {enable: true}}, conditionGroups: []},
            {id: 'a', name: 'A', options: {general: {enable: true}}, conditionGroups: []},
        ],
    })));
    await refreshes[1];
    pending[0].resolve(/** @type {import('settings').Options} */ (/** @type {unknown} */ ({
        profileCurrent: 0,
        profiles: [
            {id: 'b', name: 'B', options: {general: {enable: true}}, conditionGroups: []},
            {id: 'a', name: 'A', options: {general: {enable: true}}, conditionGroups: []},
        ],
    })));
    await refreshes[0];
    expect(settingsController.getOptionsContext()).toEqual({index: 1, profileId: 'a'});
});

test('a queued write fails closed if its selected profile is deleted before dispatch', async () => {
    const {backend, settingsController, firstSave} = createHarness();
    await settingsController.prepare();
    const blockingWrite = backend._modifySettings([{
        action: 'set', scope: 'global', optionsContext: null, path: 'profileCurrent', value: 0,
    }], 'blocking-write');
    await Promise.resolve();
    const deletion = backend._modifySettings([{
        action: 'deleteProfile', profileId: 'a', scope: 'global', optionsContext: null,
    }], 'other-settings-tab');
    const profileWrite = settingsController.setProfileSetting('general.enable', false);
    firstSave.resolve();
    await Promise.all([blockingWrite, deletion]);
    const [result] = await profileWrite;
    expect(result).toHaveProperty('error.message', 'Profile identity changed; reload settings and try again');
});

test.each([
    ['missing', [
        {name: 'A', options: {general: {enable: true}}, conditionGroups: []},
        {id: 'b', name: 'B', options: {general: {enable: false}}, conditionGroups: []},
    ]],
    ['ambiguous', [
        {id: 'a', name: 'A1', options: {general: {enable: true}}, conditionGroups: []},
        {id: 'a', name: 'A2', options: {general: {enable: false}}, conditionGroups: []},
    ]],
])('profile-scoped setting reads fail closed when the selected profile ID is %s', async (_state, profiles) => {
    const {backend, settingsController} = createHarness();
    await settingsController.prepare();
    Reflect.set(backend, '_options', {profileCurrent: 0, profiles});

    await settingsController.refresh();
    const [result] = await settingsController.getProfileSettings([{path: 'general.enable'}]);
    expect(result).toHaveProperty('error.message');
});

test('URL and current-profile contexts keep their ordinary resolution rules', async () => {
    const {backend, settingsController} = createHarness();
    await settingsController.prepare();
    Reflect.set(backend, '_profileConditionsSchemaCache', []);
    const options = /** @type {import('settings').Options} */ (/** @type {unknown} */ (Reflect.get(backend, '_options')));
    options.profiles[1].conditionGroups = [{conditions: [{type: 'popupLevel', operator: 'greaterThan', value: '0'}]}];
    const urlProfile = backend._getProfile({url: 'https://example.com/', depth: 1}, false);
    const unmatchedProfile = backend._getProfile({url: 'https://example.com/', depth: 0}, false);
    const currentProfile = backend._getProfile({current: true}, false);
    expect(urlProfile.id).toBe('b');
    expect(unmatchedProfile.id).toBe('a');
    expect(currentProfile.id).toBe('a');
});
