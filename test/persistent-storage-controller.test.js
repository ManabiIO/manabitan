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

const logError = vi.fn();

vi.mock('../ext/js/core/log.js', () => ({
    log: {
        error: logError,
    },
}));

const test = createDomTest();

describe('PersistentStorageController', () => {
    test('change event logs triggerStorageChanged failures instead of rejecting', async ({window}) => {
        vi.resetModules();
        vi.clearAllMocks();
        window.document.body.innerHTML = `
            <input id="storage-persistent-checkbox" type="checkbox">
            <div id="storage-persistent-info" hidden></div>
            <div id="storage-persistent-fail-warning" hidden></div>
        `;

        const persisted = vi.fn().mockResolvedValue(false);
        const persist = vi.fn().mockResolvedValue(true);
        Object.defineProperty(window.navigator, 'storage', {
            value: {persisted, persist},
            configurable: true,
        });

        const {PersistentStorageController} = await import('../ext/js/pages/settings/persistent-storage-controller.js');
        const application = {
            triggerStorageChanged: vi.fn(() => {
                throw new Error('notify failed');
            }),
        };
        const controller = new PersistentStorageController(/** @type {any} */ (application));
        await controller.prepare();

        const checkbox = /** @type {HTMLInputElement} */ (window.document.querySelector('#storage-persistent-checkbox'));
        checkbox.checked = true;
        checkbox.dispatchEvent(new window.Event('change', {bubbles: true}));
        await new Promise((resolve) => { window.setTimeout(resolve, 0); });

        expect(persist).toHaveBeenCalledOnce();
        expect(logError).toHaveBeenCalled();
    });
});
