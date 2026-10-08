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
import {DisplayProfileSelection} from '../ext/js/display/display-profile-selection.js';

describe('DisplayProfileSelection options refresh handling', () => {
    test('options updates log refresh failures instead of escaping', async () => {
        const selection = /** @type {DisplayProfileSelection} */ (/** @type {unknown} */ (Object.create(DisplayProfileSelection.prototype)));
        Reflect.set(selection, '_source', 'local');
        Reflect.set(selection, '_profileListNeedsUpdate', false);
        Reflect.set(selection, '_profileNameRefreshGeneration', 0);
        Reflect.set(selection, '_profilePanel', {isVisible: vi.fn().mockReturnValue(true)});
        Reflect.set(selection, '_updateProfileList', vi.fn().mockRejectedValue(new Error('refresh failed')));
        Reflect.set(selection, '_updateCurrentProfileName', vi.fn());
        const logErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const onOptionsUpdatedEvent = /** @type {(details: {source: string}) => void} */ (Reflect.get(DisplayProfileSelection.prototype, '_onOptionsUpdatedEvent'));
        onOptionsUpdatedEvent.call(selection, {source: 'external'});
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(Reflect.get(selection, '_profileListNeedsUpdate')).toBe(true);
        expect(Reflect.get(selection, '_updateProfileList')).toHaveBeenCalledTimes(1);
        expect(Reflect.get(selection, '_updateCurrentProfileName')).not.toHaveBeenCalled();
        expect(logErrorSpy).toHaveBeenCalled();
    });

    test('stale profile-name refresh does not overwrite newer state', async () => {
        let resolveFirst;
        let resolveSecond;
        const selection = /** @type {DisplayProfileSelection} */ (/** @type {unknown} */ (Object.create(DisplayProfileSelection.prototype)));
        Reflect.set(selection, '_profileNameRefreshGeneration', 0);
        Reflect.set(selection, '_profileButton', {style: {}});
        Reflect.set(selection, '_profileName', {textContent: ''});
        Reflect.set(selection, '_display', {
            application: {
                api: {
                    optionsGetFull: vi
                        .fn()
                        .mockImplementationOnce(() => new Promise((resolve) => {
                            resolveFirst = resolve;
                        }))
                        .mockImplementationOnce(() => new Promise((resolve) => {
                            resolveSecond = resolve;
                        })),
                },
            },
        });

        const firstRefresh = DisplayProfileSelection.prototype._updateCurrentProfileName.call(selection);
        const secondRefresh = DisplayProfileSelection.prototype._updateCurrentProfileName.call(selection);
        resolveSecond({
            profileCurrent: 1,
            profiles: [{name: 'Default'}, {name: 'Mining'}],
        });
        await secondRefresh;
        resolveFirst({
            profileCurrent: 0,
            profiles: [{name: 'Default'}, {name: 'Mining'}],
        });
        await firstRefresh;

        expect(Reflect.get(selection, '_profileName').textContent).toBe('Mining');
    });

    test('profile name refresh is independent of an in-flight profile list request', async () => {
        let resolveList;
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
                        .mockImplementationOnce(() => new Promise((resolve) => { resolveList = resolve; }))
                        .mockResolvedValueOnce({profileCurrent: 0, profiles: [{name: 'One'}]}),
                },
            },
            displayGenerator: {createProfileListItem: vi.fn()},
        });

        const updateList = DisplayProfileSelection.prototype._updateProfileList.call(selection);
        await DisplayProfileSelection.prototype._updateCurrentProfileName.call(selection);
        expect(Reflect.get(selection, '_profileName').textContent).toBe('One');
        expect(Reflect.get(selection, '_profileButton').style.display).toBe('none');

        resolveList({profileCurrent: 0, profiles: []});
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
        await new Promise((resolve) => setTimeout(resolve, 0));

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
        await new Promise((resolve) => setTimeout(resolve, 0));

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
        /** @type {(value: [{error?: unknown}]) => void} */
        let completeFirst;
        /** @type {() => void} */
        let firstWriteStarted;
        const firstWriteStartedPromise = new Promise((resolve) => { firstWriteStarted = resolve; });
        const writes = [];
        const setProfileCurrent = vi.fn().mockImplementation((index) => {
            writes.push(index);
            if (index === 1) {
                firstWriteStarted();
                return new Promise((resolve) => { completeFirst = resolve; });
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
        const select = (index) => DisplayProfileSelection.prototype._onProfileRadioChange.call(selection, index,
            /** @type {Event} */ (/** @type {unknown} */ ({currentTarget: {checked: true}})));
        select(1);
        await firstWriteStartedPromise;
        select(2);
        expect(writes).toEqual([1]);
        completeFirst([{}]);
        await Reflect.get(selection, '_profileWriteTail');
        expect(writes).toEqual([1, 2]);
        expect(closePanel).toHaveBeenCalledOnce();
        expect(updateName).toHaveBeenCalledOnce();
    });

    test('superseded profile-save errors do not overwrite the latest selection', async () => {
        /** @type {(error: Error) => void} */
        let failFirst;
        /** @type {() => void} */
        let firstWriteStarted;
        const firstWriteStartedPromise = new Promise((resolve) => { firstWriteStarted = resolve; });
        const setProfileCurrent = vi.fn().mockImplementation((index) => {
            if (index === 1) {
                firstWriteStarted();
                return new Promise((_resolve, reject) => { failFirst = reject; });
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
        const select = (index) => DisplayProfileSelection.prototype._onProfileRadioChange.call(selection, index,
            /** @type {Event} */ (/** @type {unknown} */ ({currentTarget: {checked: true}})));
        select(1);
        await firstWriteStartedPromise;
        select(2);
        failFirst(new Error('earlier save failed'));
        await Reflect.get(selection, '_profileWriteTail');
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

        DisplayProfileSelection.prototype._onProfileRadioChange.call(selection, 1,
            /** @type {Event} */ (/** @type {unknown} */ ({currentTarget: {checked: true}})));
        await Reflect.get(selection, '_profileWriteTail');
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(setProfileCurrent).not.toHaveBeenCalled();
        expect(updateList).toHaveBeenCalledOnce();
    });

});
