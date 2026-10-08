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

import {afterEach, describe, expect, test, vi} from 'vitest';
import {setPermissionsGranted} from '../ext/js/data/permissions-util.js';

afterEach(() => { vi.unstubAllGlobals(); });

/**
 * @param {boolean} removed
 * @param {boolean} granted
 * @returns {{remove: ReturnType<typeof vi.fn>, contains: ReturnType<typeof vi.fn>}}
 */
function mockPermissionState(removed, granted) {
    const remove = vi.fn((/** @type {unknown} */ _options, /** @type {(value: boolean) => void} */ callback) => { callback(removed); });
    const contains = vi.fn((/** @type {unknown} */ _options, /** @type {(value: boolean) => void} */ callback) => { callback(granted); });
    vi.stubGlobal('chrome', {
        runtime: {lastError: null},
        permissions: {remove, contains},
    });
    return {remove, contains};
}

describe('Permission removal state', () => {
    test('successful removal reports the now-revoked state', async () => {
        const {remove, contains} = mockPermissionState(true, false);
        const granted = await setPermissionsGranted({permissions: ['clipboardRead']}, false);
        expect(granted).toBe(false);
        expect(remove).toHaveBeenCalledOnce();
        expect(contains).not.toHaveBeenCalled();
    });

    test('already-revoked permission remains revoked if remove reports nothing changed', async () => {
        const {contains} = mockPermissionState(false, false);
        expect(await setPermissionsGranted({permissions: ['clipboardRead']}, false)).toBe(false);
        expect(contains).toHaveBeenCalledOnce();
    });

    test('permission that remains granted after unsuccessful removal is reported as granted', async () => {
        const {contains} = mockPermissionState(false, true);
        expect(await setPermissionsGranted({permissions: ['clipboardRead']}, false)).toBe(true);
        expect(contains).toHaveBeenCalledOnce();
    });
});
