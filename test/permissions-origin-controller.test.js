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
    test('successfully removed origin permissions refresh and uncheck the UI', async ({window}) => {
        vi.resetModules();
        vi.clearAllMocks();
        window.document.body.innerHTML = `
            <div id="permissions-origin-list"></div>
            <div id="permissions-origin-list-empty"></div>
            <input id="permissions-origin-new-input">
            <div id="permissions-origin-list-error" hidden></div>
            <button id="permissions-origin-add"></button>
            <input class="permissions-origin-toggle" data-origin="<all_urls>" type="checkbox">
        `;
        getAllPermissions
            .mockResolvedValueOnce({origins: ['<all_urls>'], permissions: []})
            .mockResolvedValueOnce({origins: [], permissions: []});
        // The utility returns whether the permission remains granted;
        // successful removal is false, not a failed operation.
        setPermissionsGranted.mockResolvedValue(false);

        const {PermissionsOriginController} = await import('../ext/js/pages/settings/permissions-origin-controller.js');
        const settingsController = {on: vi.fn()};
        const controller = new PermissionsOriginController(/** @type {any} */ (settingsController));
        await controller.prepare();

        const toggle = /** @type {HTMLInputElement} */ (window.document.querySelector('.permissions-origin-toggle'));
        expect(toggle.checked).toBe(true);
        expect(await controller._setOriginPermissionEnabled('<all_urls>', false)).toBe(true);

        expect(setPermissionsGranted).toHaveBeenCalledWith({origins: ['<all_urls>']}, false);
        expect(getAllPermissions).toHaveBeenCalledTimes(2);
        expect(toggle.checked).toBe(false);
    });

    test('unsuccessful origin permission removal is not reported as success', async ({window}) => {
        vi.resetModules();
        vi.clearAllMocks();
        window.document.body.innerHTML = `
            <div id="permissions-origin-list"></div>
            <div id="permissions-origin-list-empty"></div>
            <input id="permissions-origin-new-input">
            <div id="permissions-origin-list-error" hidden></div>
            <button id="permissions-origin-add"></button>
        `;
        getAllPermissions.mockResolvedValue({origins: [], permissions: []});
        // A true returned state means permission still granted after removal.
        setPermissionsGranted.mockResolvedValue(true);
        const {PermissionsOriginController} = await import('../ext/js/pages/settings/permissions-origin-controller.js');
        const controller = new PermissionsOriginController(/** @type {any} */ ({on: vi.fn()}));
        await controller.prepare();

        expect(await controller._setOriginPermissionEnabled('https://example.com/*', false)).toBe(false);
        expect(getAllPermissions).toHaveBeenCalledOnce();
    });

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
    test('origin toggle logs asynchronous permission refresh failures', async ({window}) => {
        vi.resetModules();
        vi.clearAllMocks();
        window.document.body.innerHTML = `
            <div id="permissions-origin-list"></div>
            <div id="permissions-origin-list-empty"></div>
            <input id="permissions-origin-new-input">
            <div id="permissions-origin-list-error" hidden></div>
            <button id="permissions-origin-add"></button>
            <input class="permissions-origin-toggle" data-origin="https://example.com/*" type="checkbox">
        `;
        getAllPermissions
            .mockResolvedValueOnce({origins: [], permissions: []})
            .mockRejectedValueOnce(new Error('could not refresh permissions'));
        setPermissionsGranted.mockResolvedValue(true);

        const {PermissionsOriginController} = await import('../ext/js/pages/settings/permissions-origin-controller.js');
        const settingsController = {
            on: vi.fn(),
            instantiateTemplateFragment: vi.fn(),
        };
        const controller = new PermissionsOriginController(/** @type {any} */ (settingsController));
        await controller.prepare();

        const toggle = /** @type {HTMLInputElement} */ (window.document.querySelector('.permissions-origin-toggle'));
        toggle.checked = true;
        controller._onOriginToggleChangeEvent(/** @type {Event} */ (/** @type {unknown} */ ({currentTarget: toggle})));
        await new Promise((resolve) => { window.setTimeout(resolve, 0); });

        expect(setPermissionsGranted).toHaveBeenCalledWith({origins: ['https://example.com/*']}, true);
        expect(logError).toHaveBeenCalledOnce();
    });
});

/** @returns {{promise: Promise<any>, resolve: (value: any) => void, reject: (error: Error) => void}} */
function deferredOrigin() {
    /** @type {(value: any) => void} */
    let resolve = (_value) => {};
    /** @type {(error: Error) => void} */
    let reject = (_error) => {};
    const promise = new Promise((resolve2, reject2) => {
        resolve = resolve2;
        reject = reject2;
    });
    return {promise, resolve, reject};
}

/**
 * @param {import('jsdom').DOMWindow} window
 * @param {boolean} [prepare]
 * @returns {Promise<{controller: import('../ext/js/pages/settings/permissions-origin-controller.js').PermissionsOriginController, input: HTMLInputElement, toggle: HTMLInputElement, error: HTMLElement}>}
 */
async function originHarness(window, prepare = true) {
    vi.resetModules();
    vi.resetAllMocks();
    window.document.body.innerHTML = `
        <div id="permissions-origin-list"></div><div id="permissions-origin-list-empty"></div>
        <input id="permissions-origin-new-input"><div id="permissions-origin-list-error" hidden></div>
        <button id="permissions-origin-add"></button>
        <input class="permissions-origin-toggle" data-origin="<all_urls>" type="checkbox">
    `;
    getAllPermissions.mockResolvedValue({origins: [], permissions: []});
    const {PermissionsOriginController} = await import('../ext/js/pages/settings/permissions-origin-controller.js');
    const controller = new PermissionsOriginController(/** @type {any} */ ({on: vi.fn()}));
    if (prepare) { await controller.prepare(); }
    return {controller, input: /** @type {HTMLInputElement} */ (window.document.querySelector('#permissions-origin-new-input')), toggle: /** @type {HTMLInputElement} */ (window.document.querySelector('.permissions-origin-toggle')), error: /** @type {HTMLElement} */ (window.document.querySelector('#permissions-origin-list-error'))};
}

test('a permission event supersedes a pending origin snapshot', async ({window}) => {
    const h = await originHarness(window);
    const pending = deferredOrigin();
    getAllPermissions.mockReturnValueOnce(pending.promise);
    const refresh = h.controller._updatePermissions();
    h.controller._onPermissionsChanged({permissions: {origins: ['<all_urls>'], permissions: []}});
    pending.resolve({origins: [], permissions: []});
    await refresh;
    expect(h.toggle.checked).toBe(true);
});

test('a newer origin refresh wins out of order responses', async ({window}) => {
    const h = await originHarness(window);
    const pending = deferredOrigin();
    getAllPermissions.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({origins: ['<all_urls>'], permissions: []});
    const oldRefresh = h.controller._updatePermissions();
    await h.controller._updatePermissions();
    pending.resolve({origins: [], permissions: []});
    await oldRefresh;
    expect(h.toggle.checked).toBe(true);
});

test('an origin draft edited during approval survives successful approval', async ({window}) => {
    const h = await originHarness(window);
    const pending = deferredOrigin();
    setPermissionsGranted.mockReturnValueOnce(pending.promise);
    h.input.value = 'https://first.example/*';
    const adding = h.controller._addOrigin();
    expect(setPermissionsGranted).toHaveBeenCalledWith({origins: ['https://first.example/*']}, true);
    h.input.value = 'https://next.example/*';
    h.input.dispatchEvent(new window.Event('input'));
    pending.resolve(true);
    await adding;
    expect(h.input.value).toBe('https://next.example/*');
});

test('an old origin failure cannot replace a newer successful permission result', async ({window}) => {
    const h = await originHarness(window);
    const pending = deferredOrigin();
    setPermissionsGranted.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(true);
    const first = h.controller._setOriginPermissionEnabled('https://first.example/*', true);
    await h.controller._setOriginPermissionEnabled('<all_urls>', true);
    pending.reject(new Error('old request failed'));
    await first;
    expect(h.error.hidden).toBe(true);
});

test('current permission snapshot failures are visible and stale failures are discarded', async ({window}) => {
    const h = await originHarness(window);
    getAllPermissions.mockRejectedValueOnce(new Error('current read failed'));
    await expect(h.controller._updatePermissions()).rejects.toThrow('current read failed');
    expect(h.error.textContent).toBe('current read failed');
    expect(h.error.hidden).toBe(false);
    const pending = deferredOrigin();
    getAllPermissions.mockReturnValueOnce(pending.promise);
    const oldRefresh = h.controller._updatePermissions();
    h.controller._onPermissionsChanged({permissions: {origins: [], permissions: []}});
    pending.reject(new Error('old read failed'));
    await oldRefresh;
    expect(h.error.hidden).toBe(true);
});

test('a permission event also supersedes the initial origin read', async ({window}) => {
    const h = await originHarness(window, false);
    const pending = deferredOrigin();
    getAllPermissions.mockReturnValueOnce(pending.promise);
    const preparing = h.controller.prepare();
    h.controller._onPermissionsChanged({permissions: {origins: ['<all_urls>'], permissions: []}});
    pending.resolve({origins: [], permissions: []});
    await preparing;
    expect(h.toggle.checked).toBe(true);
});

test('initial origin read failures show their error', async ({window}) => {
    const h = await originHarness(window, false);
    getAllPermissions.mockRejectedValueOnce(new Error('initial read failed'));
    await expect(h.controller.prepare()).rejects.toThrow('initial read failed');
    expect(h.error.hidden).toBe(false);
    expect(h.error.textContent).toBe('initial read failed');
});

test('editing a pending origin draft away and back preserves the draft', async ({window}) => {
    const h = await originHarness(window);
    const pending = deferredOrigin();
    setPermissionsGranted.mockReturnValueOnce(pending.promise);
    h.input.value = 'https://first.example/*';
    const adding = h.controller._addOrigin();
    h.input.value = 'https://next.example/*';
    h.input.dispatchEvent(new window.Event('input'));
    h.input.value = 'https://first.example/*';
    h.input.dispatchEvent(new window.Event('input'));
    pending.resolve(true);
    await adding;
    expect(h.input.value).toBe('https://first.example/*');
});
