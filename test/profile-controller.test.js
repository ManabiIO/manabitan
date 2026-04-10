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
import {ProfileController} from '../ext/js/pages/settings/profile-controller.js';

/**
 * @returns {ProfileController}
 */
function createControllerForInternalTests() {
    return /** @type {ProfileController} */ (Object.create(ProfileController.prototype));
}

describe('ProfileController profile conditions modal', () => {
    test('openProfileConditionsModal only shows the modal after prepare succeeds', async () => {
        const controller = createControllerForInternalTests();
        const setVisible = vi.fn();
        const cleanup = vi.fn();
        const prepare = vi.fn().mockResolvedValue(void 0);
        const profileConditionsProfileName = {textContent: ''};
        Reflect.set(controller, '_profiles', [{name: 'Default profile'}]);
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
                    {name: 'First'},
                    {name: 'Second'},
                ],
                profileCurrent: 1,
            }),
            profileIndex: 1,
        });
        Reflect.set(controller, '_profileConditionsUI', {cleanup, prepare});
        Reflect.set(controller, '_profileConditionsIndex', 0);
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
        expect(Reflect.get(controller, 'setDefaultProfile')).toHaveBeenCalledWith(1);
    });
});
