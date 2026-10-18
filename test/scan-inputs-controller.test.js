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

import {readFileSync} from 'node:fs';
import {describe, expect, vi} from 'vitest';
import {ScanInputsController} from '../ext/js/pages/settings/scan-inputs-controller.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();

/**
 * @param {import('jsdom').DOMWindow} window
 * @param {import('settings').ScanningInput[]} inputs
 * @returns {Promise<{controller: ScanInputsController, modifySettings: ReturnType<typeof vi.fn>}>}
 */
async function createController(window, inputs) {
    window.document.body.innerHTML = '<div class="modal"><div class="modal-body"><div id="scan-input-list"></div><button id="scan-input-add"></button><span class="scanning-input-count"></span></div></div>';
    const templates = new window.DOMParser().parseFromString(readFileSync(new URL('../ext/templates-settings.html', import.meta.url), 'utf8'), 'text/html');
    const modifySettings = vi.fn().mockRejectedValue(new Error('injected save failure'));
    const settings = {
        application: {api: {getEnvironmentInfo: vi.fn().mockResolvedValue({platform: {os: 'linux'}})}},
        getOptions: vi.fn(async () => structuredClone({scanning: {inputs}})),
        getOptionsContext: vi.fn(() => ({index: 0, profileId: 'profile-a'})),
        instantiateTemplate: vi.fn((name) => {
            const template = /** @type {HTMLTemplateElement|null} */ (templates.getElementById(name + '-template'));
            const node = template?.content.firstElementChild;
            if (!node) { throw new Error('Missing shipped row template'); }
            return window.document.importNode(node, true);
        }),
        modifySettings,
        on: vi.fn(),
        trigger: vi.fn(),
    };
    const controller = new ScanInputsController(/** @type {any} */ (settings));
    await controller.prepare();
    return {controller, modifySettings};
}

describe('ScanInputsController failed writes', () => {
    test('a failed delete leaves the acknowledged row visible and usable', async ({window}) => {
        const {controller, modifySettings} = await createController(window, [ScanInputsController.createDefaultMouseInput('shift', 'mouse0')]);
        const row = window.document.querySelector('.scan-input');
        await controller.removeInput(0).catch(() => {});
        expect(modifySettings).toHaveBeenCalledTimes(1);
        expect(window.document.querySelector('.scan-input')).toBe(row);
        expect(controller._entries).toHaveLength(1);
        expect(window.document.querySelector('.scanning-input-count')?.textContent).toBe('1');
        expect(/** @type {HTMLInputElement} */ (row?.querySelector('.scan-input-field'))?.value).toBe('Shift');
    });

    test('a failed add click leaves no phantom row or count', async ({window}) => {
        const {controller, modifySettings} = await createController(window, []);
        const add = /** @type {HTMLButtonElement} */ (window.document.getElementById('scan-input-add'));
        add.dispatchEvent(new window.MouseEvent('click', {bubbles: true}));
        await Reflect.get(controller, '_mutationTail');
        await new Promise((resolve) => { setTimeout(resolve, 0); });
        expect(modifySettings).toHaveBeenCalledTimes(1);
        expect(window.document.querySelectorAll('.scan-input')).toHaveLength(0);
        expect(controller._entries).toHaveLength(0);
        expect(window.document.querySelector('.scanning-input-count')?.textContent).toBe('0');
    });
});
