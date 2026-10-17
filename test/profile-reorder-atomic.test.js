/*
 * Copyright (C) 2026  Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, test, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';
import {ProfileController} from '../ext/js/pages/settings/profile-controller.js';

function deferred() {
    /** @type {() => void} */
    let resolve = () => {};
    const promise = new Promise((/** @type {(value: void) => void} */ resolvePromise) => { resolve = () => resolvePromise(void 0); });
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
    Reflect.set(controller, '_updateProfileSelectOptions', vi.fn());
    Reflect.set(controller, '_onOptionsChanged', vi.fn().mockResolvedValue(void 0));
    return {backend, controller, saves, settingsController};
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
