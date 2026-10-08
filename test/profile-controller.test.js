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
    const controller = /** @type {ProfileController} */ (Object.create(ProfileController.prototype));
    Reflect.set(controller, '_profileConditionsProfileName', null);
    return controller;
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


describe('ProfileController name save ownership', () => {
    /**
     * @returns {{controller: ProfileController, profiles: Array<{id: string, name: string}>, setGlobalSetting: ReturnType<typeof vi.fn>, refresh: ReturnType<typeof vi.fn>}}
     */
    function makeController() {
        const controller = createControllerForInternalTests();
        const profiles = [{id: 'first', name: 'Original'}, {id: 'second', name: 'Other'}];
        const setGlobalSetting = vi.fn().mockResolvedValue([{result: null}]);
        const refresh = vi.fn().mockResolvedValue(void 0);
        Reflect.set(controller, '_profiles', profiles);
        Reflect.set(controller, '_profileEntryList', []);
        Reflect.set(controller, '_updateSelectName', vi.fn());
        Reflect.set(controller, '_settingsController', {setGlobalSetting, refresh});
        return {controller, profiles, setGlobalSetting, refresh};
    }

    test('coalesces rapid typing into the latest not-yet-started save', async () => {
        const {controller, profiles, setGlobalSetting} = makeController();
        const first = controller.setProfileName(0, 'Read');
        const second = controller.setProfileName(0, 'Reading');

        await Promise.all([first, second]);

        expect(setGlobalSetting).toHaveBeenCalledOnce();
        expect(setGlobalSetting).toHaveBeenCalledWith('profiles[0].name', 'Reading');
        expect(profiles[0].name).toBe('Reading');
    });

    test('serializes in-flight saves and follows the profile after reordering', async () => {
        const {controller, profiles, setGlobalSetting} = makeController();
        /** @type {ReturnType<typeof deferred<import('settings-controller').ModifyResult[]>>} */
        const firstSave = deferred();
        const firstStarted = deferred();
        setGlobalSetting
            .mockImplementationOnce(() => {
                firstStarted.resolve(void 0);
                return firstSave.promise;
            })
            .mockResolvedValueOnce([{result: null}]);

        const first = controller.setProfileName(0, 'Read');
        await firstStarted.promise;
        const second = controller.setProfileName(0, 'Reading');
        Reflect.set(controller, '_profiles', [profiles[1], profiles[0]]);
        expect(setGlobalSetting).toHaveBeenCalledOnce();
        firstSave.resolve([{result: null}]);
        await Promise.all([first, second]);

        expect(setGlobalSetting.mock.calls).toStrictEqual([
            ['profiles[0].name', 'Read'],
            ['profiles[1].name', 'Reading'],
        ]);
        expect(profiles[0].name).toBe('Reading');
    });

    test('reconciles latest rejected saves from persisted settings', async () => {
        const {controller, setGlobalSetting, refresh} = makeController();
        setGlobalSetting.mockResolvedValue([{error: {
            name: 'Error', message: 'name was rejected', stack: '',
        }}]);
        refresh.mockImplementation(async () => {
            Reflect.set(controller, '_profiles', [{id: 'first', name: 'Original'}, {id: 'second', name: 'Other'}]);
        });

        await expect(controller.setProfileName(0, 'Unpersisted')).rejects.toThrow('name was rejected');

        expect(refresh).toHaveBeenCalledOnce();
        expect(Reflect.get(controller, '_profiles')[0].name).toBe('Original');
    });

    test('typing during failed-save recovery survives refreshed profile objects', async () => {
        const {controller, setGlobalSetting, refresh} = makeController();
        const refreshStarted = deferred();
        const finishRefresh = deferred();
        setGlobalSetting
            .mockResolvedValueOnce([{error: {name: 'Error', message: 'rejected', stack: ''}}])
            .mockResolvedValueOnce([{result: null}]);
        refresh.mockImplementation(async () => {
            refreshStarted.resolve(void 0);
            await finishRefresh.promise;
            Reflect.set(controller, '_profiles', [{id: 'second', name: 'Other'}, {id: 'first', name: 'Original'}]);
        });
        const first = controller.setProfileName(0, 'Failed');
        const rejected = expect(first).rejects.toThrow('rejected');
        await refreshStarted.promise;
        const latest = controller.setProfileName(0, 'Latest');
        await flush();
        expect(setGlobalSetting).toHaveBeenCalledTimes(1);
        finishRefresh.resolve(void 0);
        await rejected;
        await latest;
        expect(setGlobalSetting.mock.calls[1]).toStrictEqual(['profiles[1].name', 'Latest']);
        expect(Reflect.get(controller, '_profiles')[1].name).toBe('Latest');
        expect(Reflect.get(controller, '_updateSelectName')).toHaveBeenLastCalledWith(1, 'Latest');
    });

    test('another profile edit waits for full-settings recovery', async () => {
        const {controller, setGlobalSetting, refresh} = makeController();
        const refreshStarted = deferred();
        const finishRefresh = deferred();
        setGlobalSetting
            .mockResolvedValueOnce([{error: {name: 'Error', message: 'rejected', stack: ''}}])
            .mockResolvedValueOnce([{result: null}]);
        refresh.mockImplementation(async () => {
            refreshStarted.resolve(void 0);
            await finishRefresh.promise;
            Reflect.set(controller, '_profiles', [{id: 'second', name: 'Other'}, {id: 'first', name: 'Original'}]);
        });
        const first = controller.setProfileName(0, 'Failed');
        const rejected = expect(first).rejects.toThrow('rejected');
        await refreshStarted.promise;
        const latest = controller.setProfileName(1, 'Latest');
        await flush();
        expect(setGlobalSetting).toHaveBeenCalledTimes(1);
        finishRefresh.resolve(void 0);
        await rejected;
        await latest;
        expect(setGlobalSetting.mock.calls[1]).toStrictEqual(['profiles[0].name', 'Latest']);
        expect(Reflect.get(controller, '_profiles')[0].name).toBe('Latest');
        expect(Reflect.get(controller, '_updateSelectName')).toHaveBeenLastCalledWith(0, 'Latest');
    });

    test('an older failed save does not restore the UI over a newer edit', async () => {
        const {controller, profiles, setGlobalSetting, refresh} = makeController();
        /** @type {ReturnType<typeof deferred<import('settings-controller').ModifyResult[]>>} */
        const firstSave = deferred();
        const started = deferred();
        setGlobalSetting
            .mockImplementationOnce(() => {
                started.resolve(void 0);
                return firstSave.promise;
            })
            .mockResolvedValueOnce([{result: null}]);
        const first = controller.setProfileName(0, 'First attempt');
        await started.promise;
        const second = controller.setProfileName(0, 'Latest');
        firstSave.resolve([{error: {
            name: 'Error', message: 'earlier attempt failed', stack: '',
        }}]);

        await expect(first).rejects.toThrow('earlier attempt failed');
        await second;

        expect(refresh).not.toHaveBeenCalled();
        expect(profiles[0].name).toBe('Latest');
        expect(setGlobalSetting.mock.calls[1]).toStrictEqual(['profiles[0].name', 'Latest']);
    });
});

describe('ProfileController reset preserves identity', () => {
    test('reset keeps the original ID and name while restoring default settings', async () => {
        const controller = createControllerForInternalTests();
        const original = {
            id: 'my-stable-profile',
            name: 'Reading',
            options: {general: {enable: false}},
            conditionGroups: [{conditions: []}],
        };
        Reflect.set(controller, '_profiles', [
            {id: 'another-profile', name: 'Other'},
            original,
        ]);
        const defaults = /** @type {import('settings').Options} */ (/** @type {unknown} */ ({
            profiles: [{
                name: 'Default',
                options: {general: {enable: true}},
                conditionGroups: [],
            }],
        }));
        const modifyGlobalSettings = vi.fn().mockResolvedValue([{result: true}]);
        const refresh = vi.fn().mockResolvedValue(void 0);
        Reflect.set(controller, '_settingsController', {
            getDefaultOptions: vi.fn().mockResolvedValue(defaults),
            modifyGlobalSettings,
            refresh,
        });

        await controller.resetProfile(1);

        expect(modifyGlobalSettings).toHaveBeenCalledOnce();
        expect(modifyGlobalSettings.mock.calls[0][0][0]).toStrictEqual({
            action: 'set',
            path: 'profiles[1]',
            value: {
                id: 'my-stable-profile',
                name: 'Reading',
                options: {general: {enable: true}},
                conditionGroups: [],
            },
        });
        expect(refresh).toHaveBeenCalledOnce();
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
        const refresh = vi.fn(async () => {});
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
        const refresh = vi.fn(async () => {});
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
        const prepare = vi.fn(async () => {});
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

        second.resolve(void 0);
        await newer;
        expect(profileConditionsProfileName.textContent).toBe('Second');
        expect(Reflect.get(controller, '_profileConditionsIndex')).toBe(1);
        expect(setVisible).toHaveBeenCalledTimes(1);

        first.resolve(void 0);
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
        pending.resolve(void 0);
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
        const prepare = vi.fn(async () => {});
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
        const prepare = vi.fn(async () => {});
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

describe('ProfileController displayed profile ownership', () => {
    test.each([
        {name: 'preserves a valid non-default settings selection', viewed: 1, expected: 1},
        {name: 'repairs an invalid viewed index after profile deletion', viewed: 7, expected: 0},
    ])('$name', async ({viewed, expected}) => {
        const controller = createControllerForInternalTests();
        const settingsController = {
            profileIndex: viewed,
            getOptionsFull: vi.fn().mockResolvedValue({
                profiles: [
                    {id: 'profile-a', name: 'Default'},
                    {id: 'profile-b', name: 'Editing'},
                ],
                profileCurrent: 0,
            }),
        };
        const cleanup = vi.fn();
        const prepare = vi.fn().mockResolvedValue(void 0);
        const select = {value: ''};
        const setDefaultProfile = vi.fn();
        Reflect.set(controller, '_settingsController', settingsController);
        Reflect.set(controller, '_profileConditionsUI', {cleanup, prepare});
        Reflect.set(controller, '_profileConditionsIndex', null);
        Reflect.set(controller, '_profileConditionsProfileId', null);
        Reflect.set(controller, '_profileEntryList', []);
        Reflect.set(controller, '_profileEntriesSupported', false);
        Reflect.set(controller, '_profileActiveSelect', select);
        Reflect.set(controller, '_updateProfileSelectOptions', vi.fn());
        Reflect.set(controller, 'setDefaultProfile', setDefaultProfile);

        await controller._onOptionsChanged();

        expect(settingsController.profileIndex).toBe(expected);
        expect(Reflect.get(controller, '_profileCurrent')).toBe(0);
        expect(select.value).toBe('0');
        expect(setDefaultProfile).not.toHaveBeenCalled();
        expect(cleanup).toHaveBeenCalledOnce();
        expect(prepare).toHaveBeenCalledOnce();
        expect(prepare).toHaveBeenCalledWith(expected);
    });
});

describe('ProfileController profile deletion indices', () => {
    test.each([
        {name: 'removing the active first profile with one survivor', count: 2, active: 0, viewed: 0, deleted: 0, nextActive: 0, nextViewed: 0},
        {name: 'removing the first profile while a later one is active', count: 3, active: 1, viewed: 2, deleted: 0, nextActive: 0, nextViewed: 1},
        {name: 'removing the active last profile', count: 3, active: 2, viewed: 2, deleted: 2, nextActive: 1, nextViewed: 1},
        {name: 'removing an unrelated later profile', count: 3, active: 0, viewed: 0, deleted: 2, nextActive: 0, nextViewed: 0},
        {name: 'removing a profile before the one selected in settings', count: 3, active: 0, viewed: 2, deleted: 1, nextActive: 0, nextViewed: 1},
    ])('$name', async ({count, active, viewed, deleted, nextActive, nextViewed}) => {
        const controller = createControllerForInternalTests();
        const profiles = Array.from({length: count}, (_, i) => ({id: `p${i}`, name: `Profile ${i}`}));
        /** @type {string[]} */
        const calls = [];
        const refreshProfileIndex = vi.fn(() => { calls.push('refresh'); });
        const modifyGlobalSettings = vi.fn(async (/** @type {import('settings-modifications').Modification[]} */ targets) => {
            calls.push('persist');
            return targets.map(() => ({result: true}));
        });
        const settingsController = {profileIndex: viewed, refreshProfileIndex, modifyGlobalSettings};
        Reflect.set(controller, '_profiles', profiles);
        Reflect.set(controller, '_profileCurrent', active);
        Reflect.set(controller, '_profileEntryList', []);
        Reflect.set(controller, '_settingsController', settingsController);
        Reflect.set(controller, '_updateProfileSelectOptions', vi.fn());

        await controller.deleteProfile(deleted);

        expect(Reflect.get(controller, '_profileCurrent')).toBe(nextActive);
        expect(settingsController.profileIndex).toBe(nextViewed);
        expect(settingsController.profileIndex).toBeGreaterThanOrEqual(0);
        expect(Reflect.get(controller, '_profiles')).toHaveLength(count - 1);
        expect(modifyGlobalSettings).toHaveBeenCalledOnce();
        expect(calls[0]).toBe('persist');
        expect(refreshProfileIndex).toHaveBeenCalledTimes(nextViewed === viewed ? 1 : 0);
        if (active >= deleted) {
            expect(modifyGlobalSettings.mock.calls[0][0]).toContainEqual({
                action: 'set', path: 'profileCurrent', value: nextActive,
            });
        }
    });
});


describe('ProfileController deletion write failures', () => {
    test('a per-target rejection refreshes persisted state without advancing the settings index', async () => {
        const controller = createControllerForInternalTests();
        const refresh = vi.fn().mockResolvedValue(void 0);
        const refreshProfileIndex = vi.fn();
        const settingsController = {
            profileIndex: 1,
            refresh,
            refreshProfileIndex,
            modifyGlobalSettings: vi.fn().mockResolvedValue([{result: null}, {error: {name: 'Error', message: 'delete rejected', stack: ''}}]),
        };
        Reflect.set(controller, '_profiles', [{id: 'a', name: 'First'}, {id: 'b', name: 'Second'}]);
        Reflect.set(controller, '_profileCurrent', 1);
        Reflect.set(controller, '_profileEntryList', []);
        Reflect.set(controller, '_settingsController', settingsController);
        Reflect.set(controller, '_updateProfileSelectOptions', vi.fn());

        await expect(controller.deleteProfile(0)).rejects.toThrow('delete rejected');

        expect(refresh).toHaveBeenCalledOnce();
        expect(refreshProfileIndex).not.toHaveBeenCalled();
        expect(settingsController.profileIndex).toBe(1);
    });
});
