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

describe('PermissionsOriginController', () => {
    test('blank origin input is ignored instead of attempting a permission grant', async ({window}) => {
        vi.resetModules();
        vi.clearAllMocks();
        window.document.body.innerHTML = `
            <div id="permissions-origin-list"></div>
            <div id="permissions-origin-list-empty"></div>
            <input id="permissions-origin-new-input">
            <div id="permissions-origin-list-error" hidden></div>
            <button id="permissions-origin-add"></button>
            <template id="permissions-origin-template">
                <div class="permissions-origin-item">
                    <input class="permissions-origin-input">
                    <button class="permissions-origin-button"></button>
                </div>
            </template>
        `;
        getAllPermissions.mockResolvedValue({origins: [], permissions: []});

        const {PermissionsOriginController} = await import('../ext/js/pages/settings/permissions-origin-controller.js');
        const settingsController = {
            on: vi.fn(),
            instantiateTemplateFragment: vi.fn((name) => {
                if (name !== 'permissions-origin') { throw new Error(`Unexpected template: ${name}`); }
                const template = /** @type {HTMLTemplateElement} */ (window.document.querySelector('#permissions-origin-template'));
                return /** @type {DocumentFragment} */ (template.content.cloneNode(true));
            }),
        };
        const controller = new PermissionsOriginController(/** @type {any} */ (settingsController));
        await controller.prepare();

        /** @type {HTMLInputElement} */ (window.document.querySelector('#permissions-origin-new-input')).value = '   ';
        await controller._addOrigin();

        expect(setPermissionsGranted).not.toHaveBeenCalled();
    });

    test('permissions refresh clears stale origin permission errors', async ({window}) => {
        vi.resetModules();
        vi.clearAllMocks();
        window.document.body.innerHTML = `
            <div id="permissions-origin-list"></div>
            <div id="permissions-origin-list-empty"></div>
            <input id="permissions-origin-new-input">
            <div id="permissions-origin-list-error" hidden></div>
            <button id="permissions-origin-add"></button>
            <template id="permissions-origin-template">
                <div class="permissions-origin-item">
                    <input class="permissions-origin-input">
                    <button class="permissions-origin-button"></button>
                </div>
            </template>
        `;
        getAllPermissions.mockResolvedValue({origins: [], permissions: []});

        const {PermissionsOriginController} = await import('../ext/js/pages/settings/permissions-origin-controller.js');
        const settingsController = {
            on: vi.fn(),
            instantiateTemplateFragment: vi.fn((name) => {
                if (name !== 'permissions-origin') { throw new Error(`Unexpected template: ${name}`); }
                const template = /** @type {HTMLTemplateElement} */ (window.document.querySelector('#permissions-origin-template'));
                return /** @type {DocumentFragment} */ (template.content.cloneNode(true));
            }),
        };
        const controller = new PermissionsOriginController(/** @type {any} */ (settingsController));
        await controller.prepare();

        const errorNode = /** @type {HTMLElement} */ (window.document.querySelector('#permissions-origin-list-error'));
        errorNode.hidden = false;
        errorNode.textContent = 'stale';

        controller._onPermissionsChanged({permissions: {origins: [], permissions: []}});

        expect(errorNode.hidden).toBe(true);
        expect(errorNode.textContent).toBe('');
    });

    test('add-origin event wrapper logs refresh failures instead of rejecting', async ({window}) => {
        vi.resetModules();
        vi.clearAllMocks();
        window.document.body.innerHTML = `
            <div id="permissions-origin-list"></div>
            <div id="permissions-origin-list-empty"></div>
            <input id="permissions-origin-new-input">
            <div id="permissions-origin-list-error" hidden></div>
            <button id="permissions-origin-add"></button>
            <template id="permissions-origin-template">
                <div class="permissions-origin-item">
                    <input class="permissions-origin-input">
                    <button class="permissions-origin-button"></button>
                </div>
            </template>
        `;
        getAllPermissions
            .mockResolvedValueOnce({origins: [], permissions: []})
            .mockRejectedValueOnce(new Error('refresh failed'));
        setPermissionsGranted.mockResolvedValue(true);

        const {PermissionsOriginController} = await import('../ext/js/pages/settings/permissions-origin-controller.js');
        const settingsController = {
            on: vi.fn(),
            instantiateTemplateFragment: vi.fn((name) => {
                if (name !== 'permissions-origin') { throw new Error(`Unexpected template: ${name}`); }
                const template = /** @type {HTMLTemplateElement} */ (window.document.querySelector('#permissions-origin-template'));
                return /** @type {DocumentFragment} */ (template.content.cloneNode(true));
            }),
        };
        const controller = new PermissionsOriginController(/** @type {any} */ (settingsController));
        await controller.prepare();

        /** @type {HTMLInputElement} */ (window.document.querySelector('#permissions-origin-new-input')).value = 'https://example.com/*';
        controller._onAddButtonClickEvent(/** @type {Event} */ (/** @type {unknown} */ ({currentTarget: window.document.querySelector('#permissions-origin-add')})));
        await new Promise((resolve) => { window.setTimeout(resolve, 0); });

        expect(logError).toHaveBeenCalled();
    });
});
