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
        const errorContainer = /** @type {HTMLElement} */ (window.document.querySelector('#recommended-permissions-error'));
        expect(errorContainer.hidden).toBe(false);
        expect(errorContainer.textContent).toContain('permission failed');
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
        await vi.waitFor(() => { expect(logError).toHaveBeenCalled(); });
        expect(toggle.checked).toBe(false);
    });
    test('origin permission failure remains visible after the request settles', async ({window}) => {
        vi.resetModules();
        vi.clearAllMocks();
        window.document.body.innerHTML = `
            <input id="recommended-permissions-toggle" data-origin="<all_urls>" type="checkbox">
            <input id="optional-permissions-toggle" type="checkbox">
            <div id="recommended-permissions-error" hidden></div>
        `;
        getAllPermissions.mockResolvedValue({origins: [], permissions: []});
        setPermissionsGranted.mockRejectedValue(new Error('origin request failed'));
        const {RecommendedPermissionsController} = await import('../ext/js/pages/settings/recommended-permissions-controller.js');
        const controller = new RecommendedPermissionsController(/** @type {any} */ ({on: vi.fn()}));
        await controller.prepare();
        await expect(controller._setOriginPermissionEnabled('<all_urls>', true)).resolves.toBe(false);
        const error = /** @type {HTMLElement} */ (window.document.querySelector('#recommended-permissions-error'));
        expect(error.hidden).toBe(false);
        expect(error.textContent).toContain('origin request failed');
    });

    test('a permission event owns checkboxes and welcome text over an older refresh', async ({window}) => {
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
        const controller = new RecommendedPermissionsController(/** @type {any} */ ({on: vi.fn()}));
        await controller.prepare();
        const pending = Promise.withResolvers();
        getAllPermissions.mockReturnValueOnce(pending.promise);
        const refresh = controller._updatePermissions();
        controller._onPermissionsChanged({permissions: {origins: ['<all_urls>'], permissions: ['clipboardRead', 'nativeMessaging']}});
        pending.resolve({origins: [], permissions: []});
        await refresh;
        expect(/** @type {HTMLInputElement} */ (window.document.querySelector('#recommended-permissions-toggle')).checked).toBe(true);
        expect(/** @type {HTMLInputElement} */ (window.document.querySelector('#optional-permissions-toggle')).checked).toBe(true);
        expect(/** @type {HTMLElement} */ (window.document.querySelector('#full-permissions-enabled')).hidden).toBe(false);
        expect(/** @type {HTMLElement} */ (window.document.querySelector('#permissions-disabled')).hidden).toBe(true);
    });

    test('a refresh started before an origin request cannot erase its failure', async ({window}) => {
        vi.resetModules();
        vi.clearAllMocks();
        window.document.body.innerHTML = `
            <input id="recommended-permissions-toggle" data-origin="<all_urls>" type="checkbox">
            <input id="optional-permissions-toggle" type="checkbox">
            <div id="recommended-permissions-error" hidden></div>
        `;
        getAllPermissions.mockResolvedValue({origins: [], permissions: []});
        setPermissionsGranted.mockRejectedValue(new Error('origin request failed'));
        const {RecommendedPermissionsController} = await import('../ext/js/pages/settings/recommended-permissions-controller.js');
        const controller = new RecommendedPermissionsController(/** @type {any} */ ({on: vi.fn()}));
        await controller.prepare();
        const pending = Promise.withResolvers();
        getAllPermissions.mockReturnValueOnce(pending.promise);
        const refresh = controller._updatePermissions();
        await controller._setOriginPermissionEnabled('<all_urls>', true);
        pending.resolve({origins: [], permissions: []});
        await refresh;
        const error = /** @type {HTMLElement} */ (window.document.querySelector('#recommended-permissions-error'));
        expect(error.hidden).toBe(false);
        expect(error.textContent).toContain('origin request failed');
    });

    test('origin toggle owns asynchronous refresh rejection', async ({window}) => {
        vi.resetModules();
        vi.clearAllMocks();
        window.document.body.innerHTML = `
            <input id="recommended-permissions-toggle" data-origin="<all_urls>" type="checkbox">
            <input id="optional-permissions-toggle" type="checkbox">
        `;
        const {RecommendedPermissionsController} = await import('../ext/js/pages/settings/recommended-permissions-controller.js');
        const controller = new RecommendedPermissionsController(/** @type {any} */ ({on: vi.fn()}));
        const catchSpy = vi.fn();
        controller._setOriginPermissionEnabled = vi.fn(() => /** @type {Promise<boolean>} */ (/** @type {unknown} */ ({catch: catchSpy})));
        const toggle = /** @type {HTMLInputElement} */ (window.document.querySelector('#recommended-permissions-toggle'));
        toggle.checked = true;
        controller._onOriginToggleChangeEvent(/** @type {Event} */ (/** @type {unknown} */ ({currentTarget: toggle})));
        expect(catchSpy).toHaveBeenCalledOnce();
        expect(toggle.checked).toBe(false);
    });
});
