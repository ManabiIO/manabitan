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
const setPermissionsGranted = vi.fn();
const logError = vi.fn();

vi.mock('../ext/js/data/permissions-util.js', () => ({
    getAllPermissions,
    setPermissionsGranted,
}));

vi.mock('../ext/js/core/log.js', () => ({
    log: {
        error: logError,
    },
}));

const test = createDomTest();

describe('RecommendedPermissionsController', () => {
    test('optional permission toggle failure shows an error and leaves the checkbox reverted', async ({window}) => {
        vi.resetModules();
        vi.clearAllMocks();
        window.document.body.innerHTML = `
            <input id="recommended-permissions-toggle" data-origin="<all_urls>" type="checkbox">
            <input id="optional-permissions-toggle" type="checkbox">
            <div id="recommended-permissions-error" hidden></div>
            <div id="full-permissions-enabled" hidden></div>
            <div id="recommended-permissions-enabled" hidden></div>
            <div id="permissions-disabled" hidden></div>
        `;
        getAllPermissions.mockResolvedValue({origins: [], permissions: []});
        setPermissionsGranted.mockRejectedValue(new Error('permission failed'));

        const {RecommendedPermissionsController} = await import('../ext/js/pages/settings/recommended-permissions-controller.js');
        const settingsController = {on: vi.fn()};
        const controller = new RecommendedPermissionsController(/** @type {any} */ (settingsController));
        await controller.prepare();

        const toggle = /** @type {HTMLInputElement} */ (window.document.querySelector('#optional-permissions-toggle'));
        toggle.checked = true;
        await controller._onOptionalPermissionsToggleChange(/** @type {Event} */ (/** @type {unknown} */ ({currentTarget: toggle})));

        expect(toggle.checked).toBe(false);
        expect(window.document.querySelector('#recommended-permissions-error')?.hidden).toBe(false);
        expect(window.document.querySelector('#recommended-permissions-error')?.textContent).toContain('permission failed');
    });

    test('permissions refresh clears stale recommended-permissions errors', async ({window}) => {
        vi.resetModules();
        vi.clearAllMocks();
        window.document.body.innerHTML = `
            <input id="recommended-permissions-toggle" data-origin="<all_urls>" type="checkbox">
            <input id="optional-permissions-toggle" type="checkbox">
            <div id="recommended-permissions-error" hidden></div>
            <div id="full-permissions-enabled" hidden></div>
            <div id="recommended-permissions-enabled" hidden></div>
            <div id="permissions-disabled" hidden></div>
        `;
        getAllPermissions.mockResolvedValue({origins: [], permissions: []});

        const {RecommendedPermissionsController} = await import('../ext/js/pages/settings/recommended-permissions-controller.js');
        const settingsController = {on: vi.fn()};
        const controller = new RecommendedPermissionsController(/** @type {any} */ (settingsController));
        await controller.prepare();

        const errorNode = /** @type {HTMLElement} */ (window.document.querySelector('#recommended-permissions-error'));
        errorNode.hidden = false;
        errorNode.textContent = 'stale';

        controller._onPermissionsChanged({permissions: {origins: [], permissions: []}});

        expect(errorNode.hidden).toBe(true);
        expect(errorNode.textContent).toBe('');
    });

    test('optional permissions event wrapper logs refresh failures instead of rejecting', async ({window}) => {
        vi.resetModules();
        vi.clearAllMocks();
        window.document.body.innerHTML = `
            <input id="recommended-permissions-toggle" data-origin="<all_urls>" type="checkbox">
            <input id="optional-permissions-toggle" type="checkbox">
            <div id="recommended-permissions-error" hidden></div>
            <div id="full-permissions-enabled" hidden></div>
            <div id="recommended-permissions-enabled" hidden></div>
            <div id="permissions-disabled" hidden></div>
        `;
        getAllPermissions
            .mockResolvedValueOnce({origins: [], permissions: []})
            .mockRejectedValueOnce(new Error('refresh failed'));
        setPermissionsGranted.mockResolvedValue(true);

        const {RecommendedPermissionsController} = await import('../ext/js/pages/settings/recommended-permissions-controller.js');
        const settingsController = {on: vi.fn()};
        const controller = new RecommendedPermissionsController(/** @type {any} */ (settingsController));
        await controller.prepare();

        const toggle = /** @type {HTMLInputElement} */ (window.document.querySelector('#optional-permissions-toggle'));
        toggle.checked = true;
        controller._onOptionalPermissionsToggleChangeEvent(/** @type {Event} */ (/** @type {unknown} */ ({currentTarget: toggle})));
        await Promise.resolve();
        await Promise.resolve();

        expect(logError).toHaveBeenCalled();
        expect(toggle.checked).toBe(false);
    });
});
