/*
 * Copyright (C) 2026  Yomitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {describe, expect, test, vi} from 'vitest';
import {ProfileConditionsUI} from '../ext/js/pages/settings/profile-conditions-ui.js';
import {ProfileController} from '../ext/js/pages/settings/profile-controller.js';

/**
 * @returns {ProfileController}
 */
function createControllerForInternalTests() {
    return /** @type {ProfileController} */ (Object.create(ProfileController.prototype));
}

/**
 * @template T
 * @returns {{promise: Promise<T>, resolve: (value: T) => void}}
 */
function deferred() {
    /** @type {(value: T) => void} */
    let resolve = () => {};
    /** @type {Promise<T>} */
    const promise = new Promise((resolve2) => { resolve = resolve2; });
    return {promise, resolve};
}

/** @returns {Promise<void>} */
async function flush() {
    for (let i = 0; i < 20; ++i) { await Promise.resolve(); }
}

describe('ProfileController profile conditions modal', () => {
    test('openProfileConditionsModal only shows the modal after prepare succeeds', async () => {
        const controller = createControllerForInternalTests();
        const setVisible = vi.fn();
        const cleanup = vi.fn();
        const prepare = vi.fn().mockResolvedValue(void 0);
        const profileConditionsProfileName = {textContent: ''};
        Reflect.set(controller, '_profiles', [{id: 'profile-0', name: 'Default profile'}]);
        Reflect.set(controller, '_profileConditionsModal', {setVisible});
        Reflect.set(controller, '_profileConditionsUI', {cleanup, prepare});
        Reflect.set(controller, '_profileConditionsProfileName', profileConditionsProfileName);
        Reflect.set(controller, '_profileConditionsIndex', null);

        await controller.openProfileConditionsModal(0);

        expect(cleanup).toHaveBeenCalledOnce();
        expect(prepare).toHaveBeenCalledWith(0);
        expect(profileConditionsProfileName.textContent).toBe('Default profile');
        expect(Reflect.get(controller, '_profileConditionsIndex')).toBe(0);
        expect(setVisible).toHaveBeenCalledWith(true);
    });

    test('openProfileConditionsModal does not show the modal when prepare fails', async () => {
        const controller = createControllerForInternalTests();
        const setVisible = vi.fn();
        const cleanup = vi.fn();
        const prepare = vi.fn().mockRejectedValue(new Error('prepare failed'));
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const profileConditionsProfileName = {textContent: 'Old profile'};
        Reflect.set(controller, '_profiles', [{name: 'Default profile'}]);
        Reflect.set(controller, '_profileConditionsModal', {setVisible});
        Reflect.set(controller, '_profileConditionsUI', {cleanup, prepare});
        Reflect.set(controller, '_profileConditionsProfileName', profileConditionsProfileName);
        Reflect.set(controller, '_profileConditionsIndex', 7);

        await expect(controller.openProfileConditionsModal(0)).resolves.toBeUndefined();

        expect(cleanup).toHaveBeenCalledOnce();
        expect(prepare).toHaveBeenCalledWith(0);
        expect(profileConditionsProfileName.textContent).toBe('Old profile');
        expect(Reflect.get(controller, '_profileConditionsIndex')).toBe(7);
        expect(setVisible).not.toHaveBeenCalled();
        expect(consoleError).toHaveBeenCalledOnce();
        consoleError.mockRestore();
    });

    test('onOptionsChanged prepares the currently tracked conditions profile', async () => {
        const controller = createControllerForInternalTests();
        const cleanup = vi.fn();
        const prepare = vi.fn().mockResolvedValue(void 0);
        Reflect.set(controller, '_settingsController', {
            getOptionsFull: vi.fn().mockResolvedValue({
                profiles: [
                    {id: 'profile-0', name: 'First'},
                    {id: 'profile-1', name: 'Second'},
                ],
                profileCurrent: 1,
            }),
            profileIndex: 1,
        });
        Reflect.set(controller, '_profileConditionsUI', {cleanup, prepare});
        Reflect.set(controller, '_profileConditionsIndex', 0);
        Reflect.set(controller, '_profileConditionsProfileId', 'profile-0');
        Reflect.set(controller, '_profileEntryList', []);
        Reflect.set(controller, '_profileEntriesSupported', false);
        Reflect.set(controller, '_profileActiveSelect', {value: ''});
        Reflect.set(controller, '_updateProfileSelectOptions', vi.fn());
        Reflect.set(controller, 'setDefaultProfile', vi.fn());
        Reflect.set(controller, '_getProfile', vi.fn((index) => ({name: index === 0 ? 'First' : 'Second'})));

        const onOptionsChanged = /** @type {(this: ProfileController) => Promise<void>} */ (
            Reflect.get(ProfileController.prototype, '_onOptionsChanged')
        );

        await onOptionsChanged.call(controller);

        expect(cleanup).toHaveBeenCalledOnce();
        expect(prepare).toHaveBeenCalledWith(0);
        expect(Reflect.get(controller, '_updateProfileSelectOptions')).toHaveBeenCalledOnce();
        expect(Reflect.get(controller, 'setDefaultProfile')).not.toHaveBeenCalled();
        expect(Reflect.get(controller, '_profileActiveSelect').value).toBe('1');
    });
});


describe('ProfileController async ownership', () => {
    test('reset follows the same profile object if profiles are reordered while defaults load', async () => {
        const controller = createControllerForInternalTests();
        const first = {name: 'First'};
        const second = {name: 'Second'};
        Reflect.set(controller, '_profiles', [first, second]);
        /** @type {ReturnType<typeof deferred<import('settings').Options>>} */
        const defaults = deferred();
        const modifyGlobalSettings = vi.fn().mockResolvedValue([]);
        const refresh = vi.fn().mockResolvedValue();
        Reflect.set(controller, '_settingsController', {
            getDefaultOptions: () => defaults.promise,
            modifyGlobalSettings,
            refresh,
        });

        const operation = controller.resetProfile(0);
        await flush();
        Reflect.set(controller, '_profiles', [second, first]);
        defaults.resolve(/** @type {import('settings').Options} */ (/** @type {unknown} */ ({
            profiles: [{name: 'Default', options: {}}],
        })));
        await operation;

        expect(modifyGlobalSettings).toHaveBeenCalledOnce();
        expect(modifyGlobalSettings.mock.calls[0][0][0].path).toBe('profiles[1]');
        expect(modifyGlobalSettings.mock.calls[0][0][0].value.name).toBe('First');
        expect(refresh).toHaveBeenCalledOnce();
    });

    test('reset does not overwrite a replacement profile if the original profile was removed', async () => {
        const controller = createControllerForInternalTests();
        const first = {name: 'First'};
        const second = {name: 'Second'};
        Reflect.set(controller, '_profiles', [first, second]);
        /** @type {ReturnType<typeof deferred<import('settings').Options>>} */
        const defaults = deferred();
        const modifyGlobalSettings = vi.fn().mockResolvedValue([]);
        const refresh = vi.fn().mockResolvedValue();
        Reflect.set(controller, '_settingsController', {
            getDefaultOptions: () => defaults.promise,
            modifyGlobalSettings,
            refresh,
        });

        const operation = controller.resetProfile(0);
        await flush();
        Reflect.set(controller, '_profiles', [second]);
        defaults.resolve(/** @type {import('settings').Options} */ (/** @type {unknown} */ ({
            profiles: [{name: 'Default', options: {}}],
        })));
        await operation;

        expect(modifyGlobalSettings).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
    });

    test('a slower full-options refresh cannot overwrite a newer profile snapshot', async () => {
        const controller = createControllerForInternalTests();
        /** @type {ReturnType<typeof deferred<import('settings').Options>>} */
        const older = deferred();
        /** @type {ReturnType<typeof deferred<import('settings').Options>>} */
        const newer = deferred();
        const getOptionsFull = vi.fn()
            .mockImplementationOnce(() => older.promise)
            .mockImplementationOnce(() => newer.promise);
        Reflect.set(controller, '_settingsController', {
            getOptionsFull,
            profileIndex: 1,
        });
        const cleanup = vi.fn();
        const prepare = vi.fn().mockResolvedValue();
        Reflect.set(controller, '_profileConditionsUI', {cleanup, prepare});
        Reflect.set(controller, '_profileConditionsIndex', null);
        Reflect.set(controller, '_profileEntryList', []);
        Reflect.set(controller, '_profileEntriesSupported', false);
        Reflect.set(controller, '_profileActiveSelect', {value: ''});
        Reflect.set(controller, '_updateProfileSelectOptions', vi.fn());
        Reflect.set(controller, 'setDefaultProfile', vi.fn());

        const onOptionsChanged = /** @type {(this: ProfileController) => Promise<void>} */ (
            Reflect.get(ProfileController.prototype, '_onOptionsChanged')
        );
        const first = onOptionsChanged.call(controller);
        const second = onOptionsChanged.call(controller);
        await flush();

        newer.resolve(/** @type {import('settings').Options} */ (/** @type {unknown} */ ({
            profiles: [{name: 'New A'}, {name: 'New B'}],
            profileCurrent: 1,
        })));
        await second;
        older.resolve(/** @type {import('settings').Options} */ (/** @type {unknown} */ ({
            profiles: [{name: 'Old A'}, {name: 'Old B'}],
            profileCurrent: 0,
        })));
        await first;

        expect(Reflect.get(controller, '_profiles').map((profile) => profile.name)).toEqual(['New A', 'New B']);
        expect(Reflect.get(controller, '_profileCurrent')).toBe(1);
        expect(Reflect.get(controller, '_profileActiveSelect').value).toBe('1');
        expect(cleanup).toHaveBeenCalledOnce();
        expect(prepare).toHaveBeenCalledOnce();
    });
});


describe('ProfileController condition modal ownership', () => {
    test('a slower first modal open cannot overwrite a newer profile open', async () => {
        const controller = createControllerForInternalTests();
        const profiles = [{name: 'First'}, {name: 'Second'}];
        Reflect.set(controller, '_profiles', profiles);
        const first = deferred();
        const second = deferred();
        const prepare = vi.fn()
            .mockImplementationOnce(() => first.promise)
            .mockImplementationOnce(() => second.promise);
        const cleanup = vi.fn();
        const setVisible = vi.fn();
        const profileConditionsProfileName = {textContent: ''};
        Reflect.set(controller, '_profileConditionsUI', {cleanup, prepare});
        Reflect.set(controller, '_profileConditionsModal', {setVisible});
        Reflect.set(controller, '_profileConditionsProfileName', profileConditionsProfileName);
        Reflect.set(controller, '_profileConditionsIndex', null);

        const older = controller.openProfileConditionsModal(0);
        await flush();
        const newer = controller.openProfileConditionsModal(1);
        await flush();

        second.resolve();
        await newer;
        expect(profileConditionsProfileName.textContent).toBe('Second');
        expect(Reflect.get(controller, '_profileConditionsIndex')).toBe(1);
        expect(setVisible).toHaveBeenCalledTimes(1);

        first.resolve();
        await older;
        expect(profileConditionsProfileName.textContent).toBe('Second');
        expect(Reflect.get(controller, '_profileConditionsIndex')).toBe(1);
        expect(setVisible).toHaveBeenCalledTimes(1);
    });

    test('a modal open is dropped if its target profile moves while conditions load', async () => {
        const controller = createControllerForInternalTests();
        const firstProfile = {name: 'First'};
        const secondProfile = {name: 'Second'};
        Reflect.set(controller, '_profiles', [firstProfile, secondProfile]);
        const pending = deferred();
        const prepare = vi.fn(() => pending.promise);
        const setVisible = vi.fn();
        Reflect.set(controller, '_profileConditionsUI', {cleanup: vi.fn(), prepare});
        Reflect.set(controller, '_profileConditionsModal', {setVisible});
        Reflect.set(controller, '_profileConditionsProfileName', {textContent: ''});
        Reflect.set(controller, '_profileConditionsIndex', null);

        const operation = controller.openProfileConditionsModal(0);
        await flush();
        Reflect.set(controller, '_profiles', [secondProfile, firstProfile]);
        pending.resolve();
        await operation;

        expect(setVisible).not.toHaveBeenCalled();
        expect(Reflect.get(controller, '_profileConditionsIndex')).toBe(null);
    });
});

describe('ProfileConditionsUI prepare ownership', () => {
    test('only the latest overlapping profile preparation can populate the shared UI', async () => {
        const ui = /** @type {ProfileConditionsUI} */ (Object.create(ProfileConditionsUI.prototype));
        /** @type {ReturnType<typeof deferred<import('settings').Options>>} */
        const first = deferred();
        /** @type {ReturnType<typeof deferred<import('settings').Options>>} */
        const second = deferred();
        const getOptionsFull = vi.fn()
            .mockImplementationOnce(() => first.promise)
            .mockImplementationOnce(() => second.promise);
        const addConditionGroup = vi.fn();
        const addEventListener = vi.fn();
        Reflect.set(ui, '_settingsController', {getOptionsFull});
        Reflect.set(ui, '_prepareToken', null);
        Reflect.set(ui, '_profileIndex', 0);
        Reflect.set(ui, '_addConditionGroup', addConditionGroup);
        Reflect.set(ui, '_eventListeners', {addEventListener});
        Reflect.set(ui, '_addConditionGroupButton', {});

        const older = ui.prepare(0);
        const newer = ui.prepare(1);
        await flush();

        second.resolve(/** @type {import('settings').Options} */ (/** @type {unknown} */ ({
            profiles: [
                {conditionGroups: [{name: 'old'}]},
                {conditionGroups: [{name: 'new'}]},
            ],
        })));
        await newer;
        first.resolve(/** @type {import('settings').Options} */ (/** @type {unknown} */ ({
            profiles: [
                {conditionGroups: [{name: 'stale'}]},
                {conditionGroups: []},
            ],
        })));
        await older;

        expect(addConditionGroup).toHaveBeenCalledTimes(1);
        expect(addConditionGroup.mock.calls[0][0]).toEqual({name: 'new'});
        expect(addConditionGroup.mock.calls[0][1]).toBe(0);
        expect(Reflect.get(ui, '_profileIndex')).toBe(1);
        expect(addEventListener).toHaveBeenCalledTimes(1);
    });
});


describe('ProfileController condition profile identity', () => {
    test('a tracked conditions profile follows its stable ID after profile reordering', async () => {
        const controller = createControllerForInternalTests();
        const prepare = vi.fn().mockResolvedValue();
        const cleanup = vi.fn();
        const setVisible = vi.fn();
        const profileName = {textContent: 'First'};
        Reflect.set(controller, '_settingsController', {
            getOptionsFull: vi.fn().mockResolvedValue({
                profiles: [
                    {id: 'profile-b', name: 'Second'},
                    {id: 'profile-a', name: 'First'},
                ],
                profileCurrent: 0,
            }),
            profileIndex: 0,
        });
        Reflect.set(controller, '_profileConditionsUI', {cleanup, prepare});
        Reflect.set(controller, '_profileConditionsIndex', 0);
        Reflect.set(controller, '_profileConditionsProfileId', 'profile-a');
        Reflect.set(controller, '_profileConditionsOpenToken', null);
        Reflect.set(controller, '_profileConditionsModal', {setVisible});
        Reflect.set(controller, '_profileConditionsProfileName', profileName);
        Reflect.set(controller, '_profileEntryList', []);
        Reflect.set(controller, '_profileEntriesSupported', false);
        Reflect.set(controller, '_profileActiveSelect', {value: ''});
        Reflect.set(controller, '_updateProfileSelectOptions', vi.fn());
        Reflect.set(controller, 'setDefaultProfile', vi.fn());

        await controller._onOptionsChanged();

        expect(Reflect.get(controller, '_profileConditionsIndex')).toBe(1);
        expect(Reflect.get(controller, '_profileConditionsProfileId')).toBe('profile-a');
        expect(profileName.textContent).toBe('First');
        expect(prepare).toHaveBeenCalledWith(1);
        expect(setVisible).not.toHaveBeenCalled();
    });

    test('deleting the tracked conditions profile closes rather than retargeting the modal', async () => {
        const controller = createControllerForInternalTests();
        const prepare = vi.fn().mockResolvedValue();
        const cleanup = vi.fn();
        const setVisible = vi.fn();
        Reflect.set(controller, '_settingsController', {
            getOptionsFull: vi.fn().mockResolvedValue({
                profiles: [
                    {id: 'profile-b', name: 'Second'},
                ],
                profileCurrent: 0,
            }),
            profileIndex: 0,
        });
        Reflect.set(controller, '_profileConditionsUI', {cleanup, prepare});
        Reflect.set(controller, '_profileConditionsIndex', 0);
        Reflect.set(controller, '_profileConditionsProfileId', 'profile-a');
        Reflect.set(controller, '_profileConditionsOpenToken', null);
        Reflect.set(controller, '_profileConditionsModal', {setVisible});
        Reflect.set(controller, '_profileConditionsProfileName', {textContent: 'First'});
        Reflect.set(controller, '_profileEntryList', []);
        Reflect.set(controller, '_profileEntriesSupported', false);
        Reflect.set(controller, '_profileActiveSelect', {value: ''});
        Reflect.set(controller, '_updateProfileSelectOptions', vi.fn());
        Reflect.set(controller, 'setDefaultProfile', vi.fn());

        await controller._onOptionsChanged();

        expect(Reflect.get(controller, '_profileConditionsIndex')).toBe(null);
        expect(Reflect.get(controller, '_profileConditionsProfileId')).toBe(null);
        expect(setVisible).toHaveBeenCalledWith(false);
        expect(prepare).not.toHaveBeenCalled();
    });
});
