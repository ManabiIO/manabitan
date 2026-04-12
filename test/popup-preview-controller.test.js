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

describe('PopupPreviewController', () => {
    test('invoke logs postMessage failures instead of throwing', async ({window}) => {
        vi.resetModules();
        vi.clearAllMocks();
        window.document.body.innerHTML = `
            <iframe id="popup-preview-frame"></iframe>
            <textarea id="custom-popup-css"></textarea>
            <textarea id="custom-popup-outer-css"></textarea>
            <div class="preview-frame-container"></div>
        `;
        globalThis.chrome = /** @type {any} */ ({
            runtime: {
                getURL: vi.fn((path) => `chrome-extension://test${path}`),
            },
        });

        const {PopupPreviewController} = await import('../ext/js/pages/settings/popup-preview-controller.js');
        const settingsController = {
            on: vi.fn(),
            application: {on: vi.fn()},
            getOptionsContext: vi.fn(() => ({})),
        };
        const controller = new PopupPreviewController(/** @type {any} */ (settingsController));
        controller._frame = /** @type {any} */ ({
            contentWindow: {
                postMessage: vi.fn(() => {
                    throw new Error('postMessage failed');
                }),
            },
        });

        expect(() => {
            controller._invoke('updateSearch', {});
        }).not.toThrow();
        expect(logError).toHaveBeenCalled();
    });
});
