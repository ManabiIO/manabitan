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
import {deferPromise} from '../ext/js/core/utilities.js';
import {DisplayProfileSelection} from '../ext/js/display/display-profile-selection.js';

/**
 * @param {DisplayProfileSelection} selection
 * @param {number} index
 */
function selectProfile(selection, index) {
    DisplayProfileSelection.prototype._onProfileRadioChange.call(selection, index, /** @type {Event} */ (/** @type {unknown} */ ({currentTarget: {checked: true}})));
}

describe('DisplayProfileSelection options refresh handling', () => {
    test('options updates log refresh failures instead of escaping', async () => {
        const selection = /** @type {DisplayProfileSelection} */ (/** @type {unknown} */ (Object.create(DisplayProfileSelection.prototype)));
        Reflect.set(selection, '_source', 'local');
        Reflect.set(selection, '_profileListNeedsUpdate', false);
        Reflect.set(selection, '_profileNameRefreshGeneration', 0);
        Reflect.set(selection, '_profilePanel', {isVisible: vi.fn().mockReturnValue(true)});
        Reflect.set(selection, '_updateProfileList', vi.fn().mockRejectedValue(new Error('refresh failed')));
        Reflect.set(selection, '_updateCurrentProfileName', vi.fn().mockResolvedValue(void 0));
        const logErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const onOptionsUpdatedEvent = /** @type {(details: {source: string}) => void} */ (Reflect.get(DisplayProfileSelection.prototype, '_onOptionsUpdatedEvent'));
        onOptionsUpdatedEvent.call(selection, {source: 'external'});
        await new Promise((resolve) => { setTimeout(resolve, 0); });

        expect(Reflect.get(selection, '_profileListNeedsUpdate')).toBe(true);
        expect(Reflect.get(selection, '_updateProfileList')).toHaveBeenCalledTimes(1);
        expect(Reflect.get(selection, '_updateCurrentProfileName')).toHaveBeenCalledOnce();
        expect(logErrorSpy).toHaveBeenCalled();
    });

    test('pending dropdown refresh does not delay the active profile name', async () => {
        const pendingList = /** @type {import('core').DeferredPromiseDetails<void>} */ (deferPromise());
        const selection = /** @type {DisplayProfileSelection} */ (/** @type {unknown} */ (Object.create(DisplayProfileSelection.prototype)));
        const updateProfileList = vi.fn(() => pendingList.promise);
        const updateCurrentProfileName = vi.fn().mockResolvedValue(void 0);
        Reflect.set(selection, '_source', 'local');
        Reflect.set(selection, '_profileListNeedsUpdate', false);
        Reflect.set(selection, '_profilePanel', {isVisible: () => true});
        Reflect.set(selection, '_updateProfileList', updateProfileList);
        Reflect.set(selection, '_updateCurrentProfileName', updateCurrentProfileName);

        const update = DisplayProfileSelection.prototype._onOptionsUpdated.call(selection, {source: 'external'});
        expect(updateProfileList).toHaveBeenCalledOnce();
        expect(updateCurrentProfileName).toHaveBeenCalledOnce();
        pendingList.resolve();
        await update;
    });

    test('stale profile-name refresh does not overwrite newer state', async () => {
        const firstRequest = /** @type {import('core').DeferredPromiseDetails<{profileCurrent: number, profiles: {name: string}[]}>} */ (deferPromise());
        const secondRequest = /** @type {import('core').DeferredPromiseDetails<{profileCurrent: number, profiles: {name: string}[]}>} */ (deferPromise());
        const selection = /** @type {DisplayProfileSelection} */ (/** @type {unknown} */ (Object.create(DisplayProfileSelection.prototype)));
        Reflect.set(selection, '_profileNameRefreshGeneration', 0);
        Reflect.set(selection, '_profileButton', {style: {}});
        Reflect.set(selection, '_profileName', {textContent: ''});
        Reflect.set(selection, '_display', {
            application: {
                api: {
                    optionsGetFull: vi
                        .fn()
                        .mockImplementationOnce(() => firstRequest.promise)
                        .mockImplementationOnce(() => secondRequest.promise),
                },
            },
        });

        const firstRefresh = DisplayProfileSelection.prototype._updateCurrentProfileName.call(selection);
        const secondRefresh = DisplayProfileSelection.prototype._updateCurrentProfileName.call(selection);
        secondRequest.resolve({
            profileCurrent: 1,
            profiles: [{name: 'Default'}, {name: 'Mining'}],
        });
        await secondRefresh;
        firstRequest.resolve({
            profileCurrent: 0,
            profiles: [{name: 'Default'}, {name: 'Mining'}],
        });
        await firstRefresh;

        expect(Reflect.get(selection, '_profileName').textContent).toBe('Mining');
    });

    test('an external change while a hidden list refresh is in flight keeps the list dirty', async () => {
        const oldRequest = /** @type {import('core').DeferredPromiseDetails<{profileCurrent: number, profiles: {name: string}[]}>} */ (deferPromise());
        const optionsGetFull = vi.fn()
            .mockImplementationOnce(() => oldRequest.promise)
            .mockResolvedValueOnce({profileCurrent: 0, profiles: []});
        const listeners = {removeAllEventListeners: vi.fn()};
        const profileList = {textContent: 'existing', appendChild: vi.fn()};
        const selection = /** @type {DisplayProfileSelection} */ (/** @type {unknown} */ (Object.create(DisplayProfileSelection.prototype)));
        Reflect.set(selection, '_profileListRefreshGeneration', 0);
        Reflect.set(selection, '_profileListNeedsUpdate', true);
        Reflect.set(selection, '_source', 'local');
        Reflect.set(selection, '_profilePanel', {isVisible: () => false});
        Reflect.set(selection, '_updateCurrentProfileName', vi.fn().mockResolvedValue(void 0));
        Reflect.set(selection, '_eventListeners', listeners);
        Reflect.set(selection, '_profileList', profileList);
        Reflect.set(selection, '_display', {application: {api: {optionsGetFull}}, displayGenerator: {}});
        vi.stubGlobal('document', {createDocumentFragment: () => ({})});
        try {
            const stale = DisplayProfileSelection.prototype._updateProfileList.call(selection);
            await DisplayProfileSelection.prototype._onOptionsUpdated.call(selection, {source: 'external'});
            oldRequest.resolve({profileCurrent: 0, profiles: []});
            await stale;
            expect(Reflect.get(selection, '_profileListNeedsUpdate')).toBe(true);
            expect(profileList.textContent).toBe('existing');
            expect(listeners.removeAllEventListeners).not.toHaveBeenCalled();

            await DisplayProfileSelection.prototype._updateProfileList.call(selection);
            expect(Reflect.get(selection, '_profileListNeedsUpdate')).toBe(false);
            expect(optionsGetFull).toHaveBeenCalledTimes(2);
            expect(listeners.removeAllEventListeners).toHaveBeenCalledOnce();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    test('failed list rendering preserves old listeners and stays retryable', async () => {
        const listeners = {removeAllEventListeners: vi.fn()};
        const profileList = {textContent: 'existing', appendChild: vi.fn()};
        const selection = /** @type {DisplayProfileSelection} */ (/** @type {unknown} */ (Object.create(DisplayProfileSelection.prototype)));
        Reflect.set(selection, '_profileListRefreshGeneration', 0);
        Reflect.set(selection, '_profileListNeedsUpdate', true);
        Reflect.set(selection, '_eventListeners', listeners);
        Reflect.set(selection, '_profileList', profileList);
        Reflect.set(selection, '_display', {
            application: {api: {optionsGetFull: vi.fn().mockResolvedValue({
                profileCurrent: 0, profiles: [{name: 'One'}],
            })}},
            displayGenerator: {createProfileListItem: () => { throw new Error('render failed'); }},
        });
        vi.stubGlobal('document', {createDocumentFragment: () => ({appendChild: vi.fn()})});
        try {
            await expect(DisplayProfileSelection.prototype._updateProfileList.call(selection)).rejects.toThrow('render failed');
            expect(Reflect.get(selection, '_profileListNeedsUpdate')).toBe(true);
            expect(profileList.textContent).toBe('existing');
            expect(listeners.removeAllEventListeners).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    test('profile name refresh is independent of an in-flight profile list request', async () => {
        const listRequest = /** @type {import('core').DeferredPromiseDetails<{profileCurrent: number, profiles: {name: string}[]}>} */ (deferPromise());
        const selection = /** @type {DisplayProfileSelection} */ (/** @type {unknown} */ (Object.create(DisplayProfileSelection.prototype)));
        Reflect.set(selection, '_profileNameRefreshGeneration', 0);
        Reflect.set(selection, '_profileListRefreshGeneration', 0);
        Reflect.set(selection, '_profileListNeedsUpdate', true);
        Reflect.set(selection, '_profileButton', {style: {}});
        Reflect.set(selection, '_profileName', {textContent: ''});
        Reflect.set(selection, '_eventListeners', {removeAllEventListeners: vi.fn()});
        Reflect.set(selection, '_profileList', {textContent: '', appendChild: vi.fn()});
        vi.stubGlobal('document', {createDocumentFragment: () => ({})});
        Reflect.set(selection, '_display', {
            application: {
                api: {
                    optionsGetFull: vi.fn()
                        .mockImplementationOnce(() => listRequest.promise)
                        .mockResolvedValueOnce({profileCurrent: 0, profiles: [{name: 'One'}]}),
                },
            },
            displayGenerator: {createProfileListItem: vi.fn()},
        });

        const updateList = DisplayProfileSelection.prototype._updateProfileList.call(selection);
        await DisplayProfileSelection.prototype._updateCurrentProfileName.call(selection);
        expect(Reflect.get(selection, '_profileName').textContent).toBe('One');
        expect(Reflect.get(selection, '_profileButton').style.display).toBe('none');

        listRequest.resolve({profileCurrent: 0, profiles: []});
        await updateList;
        expect(Reflect.get(selection, '_profileListNeedsUpdate')).toBe(false);
        vi.unstubAllGlobals();
    });

    test('profile selector becomes visible again after a second profile is added', async () => {
        const selection = /** @type {DisplayProfileSelection} */ (/** @type {unknown} */ (Object.create(DisplayProfileSelection.prototype)));
        Reflect.set(selection, '_profileNameRefreshGeneration', 0);
        Reflect.set(selection, '_profileButton', {style: {}});
        Reflect.set(selection, '_profileName', {textContent: ''});
        Reflect.set(selection, '_display', {
            application: {api: {optionsGetFull: vi.fn()
                .mockResolvedValueOnce({profileCurrent: 0, profiles: [{name: 'One'}]})
                .mockResolvedValueOnce({profileCurrent: 1, profiles: [{name: 'One'}, {name: 'Two'}]})}},
        });

        await DisplayProfileSelection.prototype._updateCurrentProfileName.call(selection);
        expect(Reflect.get(selection, '_profileButton').style.display).toBe('none');
        await DisplayProfileSelection.prototype._updateCurrentProfileName.call(selection);
        expect(Reflect.get(selection, '_profileButton').style.display).toBe('');
        expect(Reflect.get(selection, '_profileName').textContent).toBe('Two');
    });

    test('failed dropdown refresh stays retryable and is logged', async () => {
        const selection = /** @type {DisplayProfileSelection} */ (/** @type {unknown} */ (Object.create(DisplayProfileSelection.prototype)));
        const updateProfileList = vi.fn().mockRejectedValue(new Error('list fetch failed'));
        Reflect.set(selection, '_profilePanel', {setVisible: vi.fn()});
        Reflect.set(selection, '_profileButton', {classList: {toggle: vi.fn()}});
        Reflect.set(selection, '_profileListNeedsUpdate', true);
        Reflect.set(selection, '_updateProfileList', updateProfileList);
        const logErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.stubGlobal('document', {documentElement: {dataset: {}}});

        DisplayProfileSelection.prototype._setProfilePanelVisible.call(selection, true);
        await new Promise((resolve) => { setTimeout(resolve, 0); });

        expect(updateProfileList).toHaveBeenCalledOnce();
        expect(Reflect.get(selection, '_profileListNeedsUpdate')).toBe(true);
        expect(logErrorSpy).toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    test('failed profile change refreshes persisted state and logs the error', async () => {
        const selection = /** @type {DisplayProfileSelection} */ (/** @type {unknown} */ (Object.create(DisplayProfileSelection.prototype)));
        const updateProfileList = vi.fn().mockResolvedValue(void 0);
        const updateCurrentProfileName = vi.fn().mockResolvedValue(void 0);
        const setProfileCurrent = vi.fn().mockRejectedValue(new Error('profile save failed'));
        Reflect.set(selection, '_updateProfileList', updateProfileList);
        Reflect.set(selection, '_updateCurrentProfileName', updateCurrentProfileName);
        Reflect.set(selection, '_setProfileCurrent', setProfileCurrent);
        Reflect.set(selection, '_profileWriteGeneration', 0);
        Reflect.set(selection, '_profileWriteTail', Promise.resolve());
        Reflect.set(selection, '_display', {application: {api: {optionsGetFull: vi.fn().mockResolvedValue({
            profiles: [{name: 'One'}, {name: 'Two'}],
        })}}});
        const logErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        DisplayProfileSelection.prototype._onProfileRadioChange.call(selection, 1, /** @type {Event} */ (/** @type {unknown} */ ({
            currentTarget: {checked: true},
        })));
        await new Promise((resolve) => { setTimeout(resolve, 0); });

        expect(setProfileCurrent).toHaveBeenCalledWith(1);
        expect(updateProfileList).toHaveBeenCalledOnce();
        expect(updateCurrentProfileName).toHaveBeenCalledOnce();
        expect(logErrorSpy).toHaveBeenCalled();
    });

    test('profile selection rejects per-setting failures instead of closing the panel', async () => {
        const selection = /** @type {DisplayProfileSelection} */ (/** @type {unknown} */ (Object.create(DisplayProfileSelection.prototype)));
        const modifySettings = vi.fn().mockResolvedValue([{error: {name: 'Error', message: 'backend rejected', stack: ''}}]);
        Reflect.set(selection, '_source', 'source');
        Reflect.set(selection, '_display', {application: {api: {modifySettings}}});
        await expect(DisplayProfileSelection.prototype._setProfileCurrent.call(selection, 1)).rejects.toThrow('backend rejected');
        expect(modifySettings).toHaveBeenCalledOnce();
    });

    test('profile selection rejects malformed backend responses', async () => {
        const selection = /** @type {DisplayProfileSelection} */ (/** @type {unknown} */ (Object.create(DisplayProfileSelection.prototype)));
        const modifySettings = vi.fn().mockResolvedValue([]);
        Reflect.set(selection, '_source', 'source');
        Reflect.set(selection, '_display', {application: {api: {modifySettings}}});
        await expect(DisplayProfileSelection.prototype._setProfileCurrent.call(selection, 1)).rejects.toThrow('invalid result');
    });

    test('rapid selections serialize writes and only the newest selection refreshes UI', async () => {
        const firstWriteStarted = /** @type {import('core').DeferredPromiseDetails<void>} */ (deferPromise());
        const firstWriteCompletion = /** @type {import('core').DeferredPromiseDetails<void>} */ (deferPromise());
        /** @type {number[]} */
        const writes = [];
        const setProfileCurrent = vi.fn().mockImplementation((/** @type {number} */ index) => {
            writes.push(index);
            if (index === 1) {
                firstWriteStarted.resolve();
                return firstWriteCompletion.promise;
            }
            return Promise.resolve();
        });
        const closePanel = vi.fn();
        const updateName = vi.fn().mockResolvedValue(void 0);
        const selection = /** @type {DisplayProfileSelection} */ (/** @type {unknown} */ (Object.create(DisplayProfileSelection.prototype)));
        Reflect.set(selection, '_profileWriteGeneration', 0);
        Reflect.set(selection, '_profileWriteTail', Promise.resolve());
        Reflect.set(selection, '_display', {application: {api: {optionsGetFull: vi.fn().mockResolvedValue({
            profiles: [{name: 'Zero'}, {name: 'One'}, {name: 'Two'}],
        })}}});
        Reflect.set(selection, '_setProfileCurrent', setProfileCurrent);
        Reflect.set(selection, '_setProfilePanelVisible', closePanel);
        Reflect.set(selection, '_updateCurrentProfileName', updateName);
        const select = selectProfile.bind(null, selection);
        select(1);
        await firstWriteStarted.promise;
        select(2);
        expect(writes).toEqual([1]);
        firstWriteCompletion.resolve();
        await Reflect.get(selection, '_profileWriteTail');
        expect(writes).toEqual([1, 2]);
        expect(closePanel).toHaveBeenCalledOnce();
        expect(updateName).toHaveBeenCalledOnce();
    });

    test('superseded profile-save errors do not overwrite the latest selection', async () => {
        const firstWriteStarted = /** @type {import('core').DeferredPromiseDetails<void>} */ (deferPromise());
        const firstWriteCompletion = /** @type {import('core').DeferredPromiseDetails<void>} */ (deferPromise());
        const setProfileCurrent = vi.fn().mockImplementation((/** @type {number} */ index) => {
            if (index === 1) {
                firstWriteStarted.resolve();
                return firstWriteCompletion.promise;
            }
            return Promise.resolve();
        });
        const updateList = vi.fn().mockResolvedValue(void 0);
        const updateName = vi.fn().mockResolvedValue(void 0);
        const selection = /** @type {DisplayProfileSelection} */ (/** @type {unknown} */ (Object.create(DisplayProfileSelection.prototype)));
        Reflect.set(selection, '_profileWriteGeneration', 0);
        Reflect.set(selection, '_profileWriteTail', Promise.resolve());
        Reflect.set(selection, '_display', {application: {api: {optionsGetFull: vi.fn().mockResolvedValue({
            profiles: [{name: 'Zero'}, {name: 'One'}, {name: 'Two'}],
        })}}});
        Reflect.set(selection, '_setProfileCurrent', setProfileCurrent);
        Reflect.set(selection, '_setProfilePanelVisible', vi.fn());
        Reflect.set(selection, '_updateCurrentProfileName', updateName);
        Reflect.set(selection, '_updateProfileList', updateList);
        const logErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const select = selectProfile.bind(null, selection);
        select(1);
        await firstWriteStarted.promise;
        select(2);
        firstWriteCompletion.reject(new Error('earlier save failed'));
        await Reflect.get(selection, '_profileWriteTail');
        await new Promise((resolve) => { setTimeout(resolve, 0); });
        expect(setProfileCurrent).toHaveBeenCalledTimes(2);
        expect(updateList).not.toHaveBeenCalled();
        expect(updateName).toHaveBeenCalledOnce();
        expect(logErrorSpy).toHaveBeenCalled();
    });

    test('deleted profile indices are not persisted from a stale dropdown', async () => {
        const selection = /** @type {DisplayProfileSelection} */ (/** @type {unknown} */ (Object.create(DisplayProfileSelection.prototype)));
        const setProfileCurrent = vi.fn();
        const updateList = vi.fn().mockResolvedValue(void 0);
        Reflect.set(selection, '_profileWriteGeneration', 0);
        Reflect.set(selection, '_profileWriteTail', Promise.resolve());
        Reflect.set(selection, '_display', {application: {api: {optionsGetFull: vi.fn().mockResolvedValue({
            profiles: [{name: 'Default'}],
        })}}});
        Reflect.set(selection, '_setProfileCurrent', setProfileCurrent);
        Reflect.set(selection, '_updateProfileList', updateList);
        Reflect.set(selection, '_updateCurrentProfileName', vi.fn().mockResolvedValue(void 0));
        vi.spyOn(console, 'error').mockImplementation(() => {});

        DisplayProfileSelection.prototype._onProfileRadioChange.call(
            selection,
            1,
            /** @type {Event} */ (/** @type {unknown} */ ({currentTarget: {checked: true}})),
        );
        await Reflect.get(selection, '_profileWriteTail');
        await new Promise((resolve) => { setTimeout(resolve, 0); });
        expect(setProfileCurrent).not.toHaveBeenCalled();
        expect(updateList).toHaveBeenCalledOnce();
    });

    test('successful local profile changes invalidate cached radio selection', async () => {
        const selection = /** @type {DisplayProfileSelection} */ (/** @type {unknown} */ (Object.create(DisplayProfileSelection.prototype)));
        const save = vi.fn().mockResolvedValue(void 0);
        const hidePanel = vi.fn();
        Reflect.set(selection, '_profileWriteGeneration', 0);
        Reflect.set(selection, '_profileWriteTail', Promise.resolve());
        Reflect.set(selection, '_profileListNeedsUpdate', false);
        Reflect.set(selection, '_display', {application: {api: {optionsGetFull: vi.fn().mockResolvedValue({
            profiles: [{name: 'One'}, {name: 'Two'}],
        })}}});
        Reflect.set(selection, '_setProfileCurrent', save);
        Reflect.set(selection, '_setProfilePanelVisible', hidePanel);
        Reflect.set(selection, '_updateCurrentProfileName', vi.fn().mockResolvedValue(void 0));

        DisplayProfileSelection.prototype._onProfileRadioChange.call(
            selection,
            1,
            /** @type {Event} */ (/** @type {unknown} */ ({currentTarget: {checked: true}})),
        );
        await Reflect.get(selection, '_profileWriteTail');
        expect(save).toHaveBeenCalledWith(1);
        expect(hidePanel).toHaveBeenCalledWith(false);
        expect(Reflect.get(selection, '_profileListNeedsUpdate')).toBe(true);
    });
});


describe('DisplayProfileSelection row identity', () => {
    test.each([true, false])('selection follows a reordered row (stable ID=%s)', async (withId) => {
        const selected = {name: 'Selected', ...(withId ? {id: 'selected'} : {})};
        const other = {name: 'Other', ...(withId ? {id: 'other'} : {})};
        const selection = /** @type {DisplayProfileSelection} */ (/** @type {unknown} */ (Object.create(DisplayProfileSelection.prototype)));
        const save = vi.fn().mockResolvedValue(void 0);
        Reflect.set(selection, '_profileWriteGeneration', 0);
        Reflect.set(selection, '_profileWriteTail', Promise.resolve());
        Reflect.set(selection, '_profileListRefreshGeneration', 0);
        Reflect.set(selection, '_display', {application: {api: {optionsGetFull: vi.fn().mockResolvedValue({profiles: [other, selected]})}}});
        Reflect.set(selection, '_setProfileCurrent', save);
        Reflect.set(selection, '_setProfilePanelVisible', vi.fn());
        Reflect.set(selection, '_updateCurrentProfileName', vi.fn().mockResolvedValue(void 0));
        selection._onProfileRadioChange(
            0, /** @type {Event} */ (/** @type {unknown} */ (
                {currentTarget: {checked: true}})),
            /** @type {import('settings').Profile} */ (/** @type {unknown} */ (selected)),
        );
        await Reflect.get(selection, '_profileWriteTail');
        expect(save).toHaveBeenCalledExactlyOnceWith(1);
    });

    test('a replacement at the old index cannot receive a removed row selection', async () => {
        const selection = /** @type {DisplayProfileSelection} */ (/** @type {unknown} */ (Object.create(DisplayProfileSelection.prototype)));
        const save = vi.fn();
        const report = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            Reflect.set(selection, '_profileWriteGeneration', 0);
            Reflect.set(selection, '_profileWriteTail', Promise.resolve());
            Reflect.set(selection, '_profileListRefreshGeneration', 0);
            Reflect.set(selection, '_display', {application: {api: {optionsGetFull: vi.fn().mockResolvedValue({profiles: [{id: 'replacement', name: 'Other'}]})}}});
            Reflect.set(selection, '_setProfileCurrent', save);
            Reflect.set(selection, '_updateProfileList', vi.fn().mockResolvedValue(void 0));
            Reflect.set(selection, '_updateCurrentProfileName', vi.fn().mockResolvedValue(void 0));
            selection._onProfileRadioChange(
                0, /** @type {Event} */ (/** @type {unknown} */ (
                    {currentTarget: {checked: true}})),
                /** @type {import('settings').Profile} */ (/** @type {unknown} */ ({id: 'removed', name: 'Selected'})),
            );
            await Reflect.get(selection, '_profileWriteTail');
            expect(save).not.toHaveBeenCalled();
        } finally {
            report.mockRestore();
        }
    });
    test('ambiguous legacy snapshots cannot select the first matching row', async () => {
        const selection = /** @type {DisplayProfileSelection} */ (/** @type {unknown} */ (Object.create(DisplayProfileSelection.prototype)));
        const save = vi.fn();
        const report = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            Reflect.set(selection, '_profileWriteGeneration', 0);
            Reflect.set(selection, '_profileWriteTail', Promise.resolve());
            Reflect.set(selection, '_profileListRefreshGeneration', 0);
            Reflect.set(selection, '_display', {application: {api: {optionsGetFull: vi.fn().mockResolvedValue({profiles: [{name: 'Selected'}, {name: 'Selected'}]})}}});
            Reflect.set(selection, '_setProfileCurrent', save);
            Reflect.set(selection, '_updateProfileList', vi.fn().mockResolvedValue(void 0));
            Reflect.set(selection, '_updateCurrentProfileName', vi.fn().mockResolvedValue(void 0));
            selection._onProfileRadioChange(
                0, /** @type {Event} */ (/** @type {unknown} */ (
                    {currentTarget: {checked: true}})),
                /** @type {import('settings').Profile} */ (/** @type {unknown} */ ({name: 'Selected'})),
            );
            await Reflect.get(selection, '_profileWriteTail');
            expect(save).not.toHaveBeenCalled();
        } finally {
            report.mockRestore();
        }
    });
});
