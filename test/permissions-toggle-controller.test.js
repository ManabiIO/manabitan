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

import {describe, expect, vi} from 'vitest';
import {createDomTest} from './fixtures/dom-test.js';

const getAllPermissions = vi.fn();
const hasPermissions = vi.fn();
const setPermissionsGranted = vi.fn();

vi.mock('../ext/js/data/permissions-util.js', () => ({
    getAllPermissions,
    hasPermissions,
    setPermissionsGranted,
}));

const test = createDomTest();

describe('PermissionsToggleController', () => {
    test('reverts the toggle when saving the profile setting fails', async ({window}) => {
        vi.resetModules();
        vi.clearAllMocks();
        window.document.body.innerHTML = `
            <div class="settings-item">
                <input class="permissions-toggle" type="checkbox" data-permissions-setting="anki.enable" data-required-permissions="clipboardRead">
            </div>
        `;

        getAllPermissions.mockResolvedValue({permissions: []});
        hasPermissions.mockResolvedValue(true);

        const {PermissionsToggleController} = await import('../ext/js/pages/settings/permissions-toggle-controller.js');
        const settingsController = {
            getOptions: vi.fn().mockResolvedValue({anki: {enable: false}}),
            getOptionsContext: vi.fn(() => ({})),
            setProfileSetting: vi.fn().mockRejectedValue(new Error('save failed')),
            on: vi.fn(),
        };
        const controller = new PermissionsToggleController(/** @type {any} */ (settingsController));
        await controller.prepare();

        const toggle = /** @type {HTMLInputElement} */ (window.document.querySelector('.permissions-toggle'));
        toggle.checked = true;

        await expect(
            controller._onPermissionsToggleChange(/** @type {Event} */ (/** @type {unknown} */ ({currentTarget: toggle})))
        ).rejects.toThrow('save failed');

        expect(toggle.checked).toBe(false);
        expect((/** @type {HTMLElement} */ (toggle.closest('.settings-item'))).dataset.invalid).toBe('false');
    });
});
