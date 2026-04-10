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
import {ScanInputsSimpleController} from '../ext/js/pages/settings/scan-inputs-simple-controller.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();

describe('ScanInputsSimpleController', () => {
    test('main scan modifier selection restores from options after a failed save', async ({window}) => {
        window.document.body.innerHTML = `
            <input id="middle-mouse-button-scan" type="checkbox">
            <select id="main-scan-modifier-key"></select>
        `;

        const options = {
            scanning: {
                inputs: [],
            },
        };
        const modifyProfileSettings = vi.fn().mockRejectedValue(new Error('save failed'));
        const settingsController = {
            application: {
                api: {
                    getEnvironmentInfo: vi.fn().mockResolvedValue({platform: {os: 'linux'}}),
                },
            },
            getOptions: vi.fn().mockResolvedValue(options),
            getOptionsContext: vi.fn(() => ({})),
            modifyProfileSettings,
            on: vi.fn(),
            trigger: vi.fn(),
        };
        const controller = new ScanInputsSimpleController(/** @type {any} */ (settingsController));

        await controller.prepare();
        const select = /** @type {HTMLSelectElement} */ (window.document.querySelector('#main-scan-modifier-key'));
        select.value = 'shift';
        await controller._handleMainScanModifierKeyInputChange(select, ['shift']);

        expect(select.value).toBe('other');
        expect([...select.options].map((option) => option.value)).toContain('other');
        expect(controller._mainScanModifierKeyInputHasOther).toBe(true);
    });

    test('middle mouse checkbox restores from options after a failed change refresh', async ({window}) => {
        window.document.body.innerHTML = `
            <input id="middle-mouse-button-scan" type="checkbox">
            <select id="main-scan-modifier-key"></select>
        `;

        const options = {
            scanning: {
                inputs: [],
            },
        };
        const settingsController = {
            application: {
                api: {
                    getEnvironmentInfo: vi.fn().mockResolvedValue({platform: {os: 'linux'}}),
                },
            },
            getOptions: vi.fn().mockResolvedValue(options),
            getOptionsContext: vi.fn(() => ({})),
            modifyProfileSettings: vi.fn().mockRejectedValue(new Error('save failed')),
            on: vi.fn(),
            trigger: vi.fn(),
        };
        const controller = new ScanInputsSimpleController(/** @type {any} */ (settingsController));

        await controller.prepare();
        const checkbox = /** @type {HTMLInputElement} */ (window.document.querySelector('#middle-mouse-button-scan'));
        checkbox.checked = true;
        await controller._handleMiddleMouseButtonScanChange(checkbox, true);

        expect(checkbox.checked).toBe(false);
    });
});
