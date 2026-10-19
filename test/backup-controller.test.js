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
import {BackupController} from '../ext/js/pages/settings/backup-controller.js';
import {DictionaryController} from '../ext/js/pages/settings/dictionary-controller.js';
import {SettingsController} from '../ext/js/pages/settings/settings-controller.js';

function createControllerForInternalTests() {
    return /** @type {BackupController} */ (Object.create(BackupController.prototype));
}

describe('BackupController settings export', () => {
    test('clears the export token when settings export data generation fails', async () => {
        const controller = createControllerForInternalTests();
        const getSettingsExportData = vi.fn().mockRejectedValue(new Error('export failed'));
        Reflect.set(controller, '_settingsExportRevoke', null);
        Reflect.set(controller, '_settingsExportToken', null);
        Reflect.set(controller, '_getSettingsExportData', getSettingsExportData);
        Reflect.set(controller, '_getSettingsExportDateString', vi.fn(() => '2026-04-10-010203'));
        Reflect.set(controller, '_saveBlob', vi.fn());

        await expect(controller._onSettingsExportClick()).rejects.toThrow('export failed');

        expect(getSettingsExportData).toHaveBeenCalledOnce();
        expect(Reflect.get(controller, '_settingsExportToken')).toBeNull();
        expect(Reflect.get(controller, '_saveBlob')).not.toHaveBeenCalled();
    });
});

describe('BackupController settings reset', () => {
    function getDefaultOptions() {
        return {
            profileCurrent: 0,
            profiles: [{id: 'default-profile', name: 'Default', options: {general: {popupTheme: 'default', popupThemePreset: 'default'}}, conditionGroups: []}],
        };
    }

    /**
     * @param {BackupController} controller
     * @returns {{themeController: {theme: null, themePreset: null, siteOverride: boolean, prepare: import('vitest').Mock, updateTheme: import('vitest').Mock}, showError: import('vitest').Mock}}
     */
    function configureResetController(controller) {
        const themeController = {
            theme: null,
            themePreset: null,
            siteOverride: false,
            prepare: vi.fn(),
            updateTheme: vi.fn(),
        };
        const showError = vi.fn();
        Reflect.set(controller, '_optionsUtil', {getDefault: getDefaultOptions});
        Reflect.set(controller, '_settingsResetModal', {setVisible: vi.fn()});
        Reflect.set(controller, '_themeController', themeController);
        Reflect.set(controller, '_showSettingsImportError', showError);
        return {themeController, showError};
    }

    test('does not apply the reset theme or hide a persistence failure', async () => {
        const controller = createControllerForInternalTests();
        const {themeController, showError} = configureResetController(controller);
        const error = new Error('settings save failed');
        Reflect.set(controller, '_settingsImportSetOptionsFull', vi.fn().mockRejectedValue(error));
        const ensureSettings = vi.spyOn(DictionaryController, 'ensureDictionarySettings').mockResolvedValue();

        try {
            await controller._onSettingsResetConfirmClick();
        } finally {
            ensureSettings.mockRestore();
        }

        expect(themeController.prepare).not.toHaveBeenCalled();
        expect(themeController.updateTheme).not.toHaveBeenCalled();
        expect(showError).toHaveBeenCalledWith(error);
    });

    test('shows the existing error UI and leaves the theme unchanged when dictionary preparation fails', async () => {
        const controller = createControllerForInternalTests();
        const {themeController, showError} = configureResetController(controller);
        const error = new Error('dictionary information unavailable');
        const setOptions = vi.fn();
        Reflect.set(controller, '_settingsImportSetOptionsFull', setOptions);
        const ensureSettings = vi.spyOn(DictionaryController, 'ensureDictionarySettings').mockRejectedValue(error);

        try {
            await controller._onSettingsResetConfirmClick();
        } finally {
            ensureSettings.mockRestore();
        }

        expect(showError).toHaveBeenCalledWith(error);
        expect(setOptions).not.toHaveBeenCalled();
        expect(themeController.prepare).not.toHaveBeenCalled();
        expect(themeController.updateTheme).not.toHaveBeenCalled();
    });

    test('keeps the existing theme while settings persistence is pending', async () => {
        const controller = createControllerForInternalTests();
        const {themeController, showError} = configureResetController(controller);
        /** @type {() => void} */
        let resolvePersist = () => {};
        const persist = new Promise((resolve) => { resolvePersist = () => resolve(void 0); });
        Reflect.set(controller, '_settingsImportSetOptionsFull', vi.fn(() => persist));
        const ensureSettings = vi.spyOn(DictionaryController, 'ensureDictionarySettings').mockResolvedValue();

        try {
            const reset = controller._onSettingsResetConfirmClick();
            await Promise.resolve();
            await Promise.resolve();
            expect(themeController.theme).toBeNull();
            expect(themeController.themePreset).toBeNull();
            expect(themeController.prepare).not.toHaveBeenCalled();
            expect(themeController.updateTheme).not.toHaveBeenCalled();
            resolvePersist();
            await reset;
        } finally {
            ensureSettings.mockRestore();
        }

        expect(showError).not.toHaveBeenCalled();
        expect(themeController.theme).toBe('default');
        expect(themeController.themePreset).toBe('default');
    });

    test('applies the reset theme after settings replacement succeeds', async () => {
        const controller = createControllerForInternalTests();
        const {themeController, showError} = configureResetController(controller);
        /** @type {string[]} */
        const order = [];
        Reflect.set(controller, '_settingsImportSetOptionsFull', vi.fn(async () => { order.push('persist'); }));
        themeController.prepare.mockImplementation(() => order.push('prepare'));
        themeController.updateTheme.mockImplementation(() => order.push('update'));
        const ensureSettings = vi.spyOn(DictionaryController, 'ensureDictionarySettings').mockResolvedValue();

        try {
            await controller._onSettingsResetConfirmClick();
        } finally {
            ensureSettings.mockRestore();
        }

        expect(order).toEqual(['persist', 'prepare', 'update']);
        expect(themeController.siteOverride).toBe(true);
        expect(showError).not.toHaveBeenCalled();
    });

    test('real SettingsController swallows options refresh failure after API persistence for a valid default profile ID', async () => {
        vi.stubGlobal('chrome', {permissions: {}});
        const controller = createControllerForInternalTests();
        const {themeController, showError} = configureResetController(controller);
        const initialOptions = getDefaultOptions();
        /** @type {string[]} */
        const events = [];
        let failOptionsRefresh = false;
        const application = {
            on: vi.fn(),
            api: {
                optionsGetFull: vi.fn(async () => {
                    if (failOptionsRefresh) { throw new Error('options refresh failed'); }
                    return initialOptions;
                }),
                optionsGet: vi.fn(async () => initialOptions.profiles[0].options),
                setAllSettings: vi.fn(async () => { events.push('api-persisted'); }),
            },
        };
        const settingsController = new SettingsController(/** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ (application)));
        Reflect.set(settingsController, '_templates', {loadFromFiles: vi.fn()});
        await settingsController.prepare();
        expect(settingsController.getOptionsContext().profileId).toBe('default-profile');
        Reflect.set(controller, '_settingsController', settingsController);
        Reflect.set(controller, '_settingsImportSetOptionsFull', async (optionsFull) => await settingsController.setAllSettings(optionsFull));
        themeController.prepare.mockImplementation(() => events.push('theme-prepared'));
        themeController.updateTheme.mockImplementation(() => events.push('theme-updated'));
        failOptionsRefresh = true;
        const ensureSettings = vi.spyOn(DictionaryController, 'ensureDictionarySettings').mockResolvedValue();

        try {
            await controller._onSettingsResetConfirmClick();
        } finally {
            ensureSettings.mockRestore();
        }

        expect(application.api.setAllSettings).toHaveBeenCalledOnce();
        expect(events).toEqual(['api-persisted', 'theme-prepared', 'theme-updated']);
        expect(showError).not.toHaveBeenCalled();
        expect(themeController.theme).toBe('default');
        vi.unstubAllGlobals();
    });
});
