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

vi.mock('../ext/js/pages/settings/dictionary-controller.js', () => ({
    DictionaryController: {ensureDictionarySettings: vi.fn()},
}));

/** @returns {BackupController} */
function createController() {
    return /** @type {BackupController} */ (Object.create(BackupController.prototype));
}

/**
 * @template T
 * @returns {{promise: Promise<T>, resolve: (value: T) => void, reject: (reason: Error) => void}}
 */
function deferred() {
    /** @type {(value: T) => void} */
    let resolve = () => {};
    /** @type {(reason: Error) => void} */
    let reject = () => {};
    const promise = new Promise((resolve2, reject2) => {
        resolve = resolve2;
        reject = reject2;
    });
    return {promise, resolve, reject};
}

/** @returns {Promise<void>} */
async function flush() {
    for (let i = 0; i < 20; ++i) { await Promise.resolve(); }
}

describe('BackupController replacement ownership', () => {
    test('serializes overlapping imports and admits a retry after the first fails', async () => {
        const controller = createController();
        const first = deferred();
        const second = deferred();
        let active = 0;
        let maxActive = 0;
        /** @type {string[]} */
        const started = [];
        const importSettingsFile = vi.fn(async (/** @type {File} */ file) => {
            started.push(file.name);
            active++;
            maxActive = Math.max(maxActive, active);
            try {
                await (file.name === 'first.json' ? first.promise : second.promise);
            } finally {
                active--;
            }
        });
        const showError = vi.fn();
        Reflect.set(controller, '_importSettingsFile', importSettingsFile);
        Reflect.set(controller, '_showSettingsImportError', showError);

        const change = (/** @type {string} */ name) => ({currentTarget: {files: [{name}], value: name}});
        const firstImport = controller._onSettingsImportFileChange(/** @type {Event} */ (/** @type {unknown} */ (change('first.json'))));
        await flush();
        const secondImport = controller._onSettingsImportFileChange(/** @type {Event} */ (/** @type {unknown} */ (change('second.json'))));
        await flush();

        expect(started).toEqual(['first.json']);
        expect(maxActive).toBe(1);

        first.reject(new Error('first import failed'));
        await firstImport;
        await flush();
        expect(started).toEqual(['first.json', 'second.json']);

        second.resolve(void 0);
        await secondImport;
        expect(active).toBe(0);
        expect(maxActive).toBe(1);
        expect(showError).toHaveBeenCalledOnce();
    });

    test('queues reset behind a pending import so the final persisted settings follow user action order', async () => {
        const controller = createController();
        const importGate = deferred();
        /** @type {string[]} */
        const order = [];
        Reflect.set(controller, '_importSettingsFile', vi.fn(async () => {
            order.push('import-start');
            await importGate.promise;
            order.push('import-end');
        }));
        Reflect.set(controller, '_optionsUtil', {getDefault: () => ({
            profileCurrent: 0,
            profiles: [{id: 'default-profile', name: 'Default', options: {general: {popupTheme: 'default', popupThemePreset: 'default'}}, conditionGroups: []}],
        })});
        Reflect.set(controller, '_settingsResetModal', null);
        Reflect.set(controller, '_themeController', {theme: null, themePreset: null, siteOverride: false, prepare: vi.fn(), updateTheme: vi.fn()});
        Reflect.set(controller, '_settingsImportSetOptionsFull', vi.fn(async () => { order.push('reset-persist'); }));
        const ensureSettings = vi.mocked(DictionaryController.ensureDictionarySettings);
        ensureSettings.mockImplementation(async () => { order.push('reset-dictionaries'); });

        try {
            const importTask = controller._onSettingsImportFileChange(/** @type {Event} */ (/** @type {unknown} */ ({currentTarget: {files: [{name: 'backup.json'}], value: ''}})));
            await flush();
            const resetTask = controller._onSettingsResetConfirmClick();
            await flush();

            expect(order).toEqual(['import-start']);

            importGate.resolve(void 0);
            await Promise.all([importTask, resetTask]);
        } finally {
            ensureSettings.mockRestore();
        }

        expect(order).toEqual(['import-start', 'import-end', 'reset-dictionaries', 'reset-persist']);
    });
});
