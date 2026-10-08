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

    test('failed profile change refreshes persisted state and logs the error', async () => {
        const selection = /** @type {DisplayProfileSelection} */ (/** @type {unknown} */ (Object.create(DisplayProfileSelection.prototype)));
        const updateProfileList = vi.fn().mockResolvedValue(void 0);
        const updateCurrentProfileName = vi.fn().mockResolvedValue(void 0);
        const setProfileCurrent = vi.fn().mockRejectedValue(new Error('profile save failed'));
        Reflect.set(selection, '_updateProfileList', updateProfileList);
        Reflect.set(selection, '_updateCurrentProfileName', updateCurrentProfileName);
        Reflect.set(selection, '_setProfileCurrent', setProfileCurrent);
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
});
