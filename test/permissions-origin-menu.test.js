/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, vi} from 'vitest';
import {HtmlTemplateCollection} from '../ext/js/dom/html-template-collection.js';
import {PopupMenu} from '../ext/js/dom/popup-menu.js';
import {PermissionsOriginController} from '../ext/js/pages/settings/permissions-origin-controller.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest('./ext/templates-settings.html');

test.for(['outside', 'resize', 'close', 'remove'])('origin menu %s only revokes access after choosing Remove', async (action, {window}) => {
    const {document} = window;
    const templates = new HtmlTemplateCollection();
    templates.load(document);
    document.body.insertAdjacentHTML('beforeend', `
        <div id="permissions-origin-list"></div>
        <div id="permissions-origin-list-empty"></div>
        <input id="permissions-origin-new-input">
        <div id="permissions-origin-list-error" hidden></div>
        <button id="permissions-origin-add"></button>
    `);
    const selectedOrigin = 'https://selected.example/*';
    const otherOrigin = 'https://other.example/*';
    const grantedOrigins = new Set([selectedOrigin, otherOrigin]);
    const permissions = {
        getAll: vi.fn((/** @type {(value: chrome.permissions.Permissions) => void} */ callback) => {
            callback({origins: [...grantedOrigins], permissions: []});
        }),
        remove: vi.fn((/** @type {chrome.permissions.Permissions} */ {origins}, /** @type {(removed: boolean) => void} */ callback) => {
            for (const origin of origins ?? []) { grantedOrigins.delete(origin); }
            callback(true);
        }),
    };
    vi.stubGlobal('chrome', {permissions, runtime: {}});
    const settingsController = {
        on: vi.fn(),
        instantiateTemplateFragment: (/** @type {string} */ name) => templates.instantiateFragment(name),
    };
    const controller = new PermissionsOriginController(/** @type {any} */ (settingsController));
    /** @type {PopupMenu|null} */
    let menu = null;
    try {
        await controller.prepare();
        const button = /** @type {HTMLElement} */ (document.querySelector('.permissions-origin-menu-button'));
        const container = /** @type {HTMLElement} */ (templates.instantiate('permissions-origin-menu'));
        document.body.appendChild(container);
        menu = new PopupMenu(button, container);
        menu.prepare();

        switch (action) {
            case 'outside':
                container.click();
                break;
            case 'resize':
                window.dispatchEvent(new window.Event('resize'));
                break;
            case 'close':
                menu.close();
                break;
            case 'remove':
                /** @type {HTMLButtonElement} */ (container.querySelector('[data-menu-action="remove"]')).click();
                break;
        }
        await new Promise((resolve) => { window.setTimeout(resolve, 0); });

        expect(menu.isClosed).toBe(true);
        expect(container.isConnected).toBe(false);
        if (action === 'remove') {
            expect(permissions.remove).toHaveBeenCalledExactlyOnceWith({origins: [selectedOrigin]}, expect.any(Function));
            expect([...grantedOrigins]).toEqual([otherOrigin]);
        } else {
            expect(permissions.remove).not.toHaveBeenCalled();
            expect([...grantedOrigins]).toEqual([selectedOrigin, otherOrigin]);
        }
        expect([...document.querySelectorAll('.permissions-origin-input')].map((node) => /** @type {HTMLInputElement} */ (node).value)).toEqual([...grantedOrigins]);
    } finally {
        controller._eventListeners.removeAllEventListeners();
        menu?.close(false);
        vi.unstubAllGlobals();
    }
});
