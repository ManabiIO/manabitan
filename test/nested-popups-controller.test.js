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
import {NestedPopupsController} from '../ext/js/pages/settings/nested-popups-controller.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();

describe('NestedPopupsController', () => {
    test('restores the previous nesting UI when saving fails', async ({window}) => {
        window.document.body.innerHTML = `
            <input id="nested-popups-enabled" type="checkbox">
            <input id="nested-popups-count" type="number">
            <div id="nested-popups-enabled-more-options" hidden></div>
        `;

        const setProfileSetting = vi.fn().mockRejectedValue(new Error('save failed'));
        const settingsController = {
            getOptions: vi.fn().mockResolvedValue({scanning: {popupNestingMaxDepth: 2}}),
            getOptionsContext: vi.fn(() => ({index: 0})),
            setProfileSetting,
            on: vi.fn(),
        };
        const controller = new NestedPopupsController(/** @type {any} */ (settingsController));

        await controller.prepare();
        await expect(controller._setPopupNestingMaxDepth(1)).rejects.toThrow('save failed');

        expect((/** @type {HTMLInputElement} */ (window.document.querySelector('#nested-popups-enabled'))).checked).toBe(true);
        expect((/** @type {HTMLInputElement} */ (window.document.querySelector('#nested-popups-count'))).value).toBe('2');
        expect((/** @type {HTMLElement} */ (window.document.querySelector('#nested-popups-enabled-more-options'))).hidden).toBe(false);
    });
});
