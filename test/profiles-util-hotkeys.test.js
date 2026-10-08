/*
 * Copyright (C) 2026  Manabitan Authors
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
import {setProfile} from '../ext/js/data/profiles-util.js';

/**
 * @param {ReturnType<typeof vi.fn>} getOptions
 * @param {ReturnType<typeof vi.fn>} modifySettings
 */
function createApplication(getOptions, modifySettings) {
    return /** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({
        api: {optionsGetFull: getOptions, modifySettings},
    }));
}

describe('Profile hotkey writes', () => {
    test('two fast Next actions persist successive profiles rather than losing a press', async () => {
        const started = /** @type {import('core').DeferredPromiseDetails<void>} */ (deferPromise());
        const allowFirstWrite = /** @type {import('core').DeferredPromiseDetails<void>} */ (deferPromise());
        let current = 0;
        /** @type {number[]} */
        const writes = [];
        const optionsGetFull = vi.fn(async () => ({
            profileCurrent: current,
            profiles: [{}, {}, {}],
        }));
        const modifySettings = vi.fn(async (/** @type {import('settings-modifications').ScopedModificationSet[]} */ modifications) => {
            const index = /** @type {number} */ (Reflect.get(modifications[0], 'value'));
            writes.push(index);
            if (writes.length === 1) {
                started.resolve();
                await allowFirstWrite.promise;
            }
            current = index;
            return [{}];
        });
        const app = createApplication(optionsGetFull, modifySettings);

        const first = setProfile(1, app);
        await started.promise;
        const second = setProfile(1, app);
        expect(writes).toEqual([1]);
        expect(optionsGetFull).toHaveBeenCalledOnce();

        allowFirstWrite.resolve();
        await Promise.all([first, second]);
        expect(writes).toEqual([1, 2]);
        expect(current).toBe(2);
        expect(optionsGetFull).toHaveBeenCalledTimes(2);
    });

    test('negative directions wrap without producing negative profile indices', async () => {
        /** @type {number[]} */
        const writes = [];
        const app = createApplication(
            vi.fn().mockResolvedValue({profileCurrent: 0, profiles: [{}, {}, {}]}),
            vi.fn().mockImplementation((/** @type {import('settings-modifications').ScopedModificationSet[]} */ modifications) => {
                writes.push(/** @type {number} */ (Reflect.get(modifications[0], 'value')));
                return Promise.resolve([{}]);
            }),
        );
        await setProfile(-1, app);
        await setProfile(-5, app);
        expect(writes).toEqual([2, 1]);
    });

    test('empty or single-profile configurations are not modified', async () => {
        const modifySettings = vi.fn();
        const appEmpty = createApplication(
            vi.fn().mockResolvedValue({profileCurrent: 0, profiles: []}),
            modifySettings,
        );
        const appSingle = createApplication(
            vi.fn().mockResolvedValue({profileCurrent: 0, profiles: [{}]}),
            modifySettings,
        );
        await setProfile(1, appEmpty);
        await setProfile(-1, appSingle);
        expect(modifySettings).not.toHaveBeenCalled();
    });

    test('invalid direction and invalid stored index do not persist malformed values', async () => {
        const modifySettings = vi.fn();
        const app = createApplication(
            vi.fn().mockResolvedValue({profileCurrent: -1, profiles: [{}, {}]}),
            modifySettings,
        );
        await expect(setProfile(0.5, app)).rejects.toThrow('integer');
        await expect(setProfile(1, app)).rejects.toThrow('invalid');
        expect(modifySettings).not.toHaveBeenCalled();
    });

    test('per-setting error rejects and does not prevent a later hotkey press', async () => {
        const modifySettings = vi.fn()
            .mockResolvedValueOnce([{error: {name: 'Error', message: 'save denied', stack: ''}}])
            .mockResolvedValueOnce([{}]);
        const app = createApplication(
            vi.fn().mockResolvedValue({profileCurrent: 0, profiles: [{}, {}]}),
            modifySettings,
        );
        const first = setProfile(1, app);
        const second = setProfile(1, app);
        await expect(first).rejects.toThrow('save denied');
        await expect(second).resolves.toBeUndefined();
        expect(modifySettings).toHaveBeenCalledTimes(2);
    });

    test('malformed backend save responses reject instead of reporting success', async () => {
        const app = createApplication(
            vi.fn().mockResolvedValue({profileCurrent: 0, profiles: [{}, {}]}),
            vi.fn().mockResolvedValue([]),
        );
        await expect(setProfile(1, app)).rejects.toThrow('invalid result');
    });
});
