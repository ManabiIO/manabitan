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

describe('PopupWindowController', () => {
    test('popup test click logs popup-open failures instead of rejecting', async ({window}) => {
        vi.resetModules();
        vi.clearAllMocks();
        window.document.body.innerHTML = '<a id="test-window-open-link" href="#">Open</a>';

        const {PopupWindowController} = await import('../ext/js/pages/settings/popup-window-controller.js');
        const api = {
            getOrCreateSearchPopup: vi.fn().mockRejectedValue(new Error('popup failed')),
        };
        const controller = new PopupWindowController(/** @type {any} */ (api));
        controller.prepare();

        const link = /** @type {HTMLAnchorElement} */ (window.document.querySelector('#test-window-open-link'));
        link.dispatchEvent(new window.MouseEvent('click', {bubbles: true, cancelable: true}));
        await new Promise((resolve) => { window.setTimeout(resolve, 0); });

        expect(api.getOrCreateSearchPopup).toHaveBeenCalledWith({focus: true});
        expect(logError).toHaveBeenCalled();
    });
});
