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
import {ScanInputsController} from '../ext/js/pages/settings/scan-inputs-controller.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();

function createSettingsController(modifyProfileSettings, options) {
    return {
        application: {
            api: {
                getEnvironmentInfo: vi.fn().mockResolvedValue({platform: {os: 'linux'}}),
            },
        },
        getOptions: vi.fn().mockImplementation(async () => structuredClone(options)),
        getOptionsContext: vi.fn(() => ({})),
        instantiateTemplate: vi.fn(),
        modifyProfileSettings,
        setProfileSetting: vi.fn(),
        on: vi.fn(),
        trigger: vi.fn(),
    };
}

describe('ScanInputsController', () => {
    test('removeInput refreshes the list after a failed delete write', async ({window}) => {
        window.document.body.innerHTML = `
            <div id="scan-input-list"></div>
            <button id="scan-input-add"></button>
            <span class="scanning-input-count"></span>
        `;

        const input = ScanInputsController.createDefaultMouseInput('shift', 'mouse0');
        const options = {scanning: {inputs: [input]}};
        const modifyProfileSettings = vi.fn().mockRejectedValue(new Error('save failed'));
        const settingsController = createSettingsController(modifyProfileSettings, options);
        const controller = new ScanInputsController(/** @type {any} */ (settingsController));
        controller._scanningInputCountNodes = window.document.querySelectorAll('.scanning-input-count');
        vi.spyOn(controller, '_addOption').mockImplementation((index) => {
            controller._entries.push({cleanup: vi.fn(), index});
        });
        const cleanup = vi.fn();
        controller._entries = [{cleanup, index: 0}];
        controller._updateCounts();

        controller.removeInput(0);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(cleanup).toHaveBeenCalled();
        expect(controller._entries).toHaveLength(1);
        expect(window.document.querySelector('.scanning-input-count')?.textContent).toBe('1');
    });

    test('add click refreshes the list after a failed insert write', async ({window}) => {
        window.document.body.innerHTML = `
            <div class="modal">
                <div class="modal-body">
                    <div id="scan-input-list"></div>
                    <button id="scan-input-add"></button>
                    <span class="scanning-input-count"></span>
                </div>
            </div>
        `;

        const options = {scanning: {inputs: []}};
        const modifyProfileSettings = vi.fn().mockRejectedValue(new Error('save failed'));
        const settingsController = createSettingsController(modifyProfileSettings, options);
        const controller = new ScanInputsController(/** @type {any} */ (settingsController));
        controller._scanningInputCountNodes = window.document.querySelectorAll('.scanning-input-count');
        vi.spyOn(controller, '_addOption').mockImplementation((index) => {
            controller._entries.push({cleanup: vi.fn(), index});
        });
        controller._updateCounts();
        controller._onAddButtonClick(/** @type {MouseEvent} */ (/** @type {unknown} */ ({
            preventDefault() {},
            currentTarget: window.document.querySelector('#scan-input-add'),
        })));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(controller._entries).toHaveLength(0);
        expect(window.document.querySelector('.scanning-input-count')?.textContent).toBe('0');
    });
});
