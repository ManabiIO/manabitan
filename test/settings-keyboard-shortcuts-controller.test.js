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
import {KeyboardShortcutController} from '../ext/js/pages/settings/keyboard-shortcuts-controller.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();

function setupKeyboardShortcutDom(window) {
    window.document.body.innerHTML = `
        <button id="hotkey-list-add"></button>
        <button id="hotkey-list-reset"></button>
        <div id="hotkey-list"></div>
        <div id="hotkey-list-empty"></div>
        <div id="keyboard-shortcuts-modal"><div class="modal-body"></div></div>
        <template id="hotkey-list-item-template">
            <div class="hotkey-list-item">
                <button class="hotkey-list-item-button"></button>
                <input class="hotkey-list-item-input">
                <select class="hotkey-list-item-action"></select>
                <input class="hotkey-list-item-enabled" type="checkbox">
                <button class="hotkey-list-item-scopes-button"></button>
                <button class="hotkey-list-item-enabled-button"></button>
                <div class="hotkey-list-item-action-argument-container"></div>
            </div>
        </template>
    `;
}

function createController(settingsController) {
    return new KeyboardShortcutController(
        /** @type {import('../ext/js/pages/settings/settings-controller.js').SettingsController} */ (settingsController),
    );
}

describe('KeyboardShortcutController rebuild', () => {
    test('skips a broken hotkey row instead of rejecting the whole rebuild', async ({window}) => {
        setupKeyboardShortcutDom(window);

        const template = /** @type {HTMLTemplateElement} */ (window.document.querySelector('#hotkey-list-item-template'));
        const settingsController = {
            application: {
                api: {
                    getEnvironmentInfo: vi.fn().mockResolvedValue({platform: {os: 'mac'}}),
                },
            },
            getOptions: vi.fn().mockResolvedValue({
                inputs: {
                    hotkeys: [
                        {action: 'close', argument: '', key: 'a', modifiers: [], scopes: ['popup'], enabled: true},
                        {action: 'viewNotes', argument: '', key: 'b', modifiers: [], scopes: ['popup'], enabled: true},
                    ],
                },
            }),
            on: vi.fn(),
            instantiateTemplate: vi.fn((name) => {
                if (name !== 'hotkey-list-item') { throw new Error(`Unexpected template: ${name}`); }
                const callIndex = settingsController.instantiateTemplate.mock.calls.length;
                const node = /** @type {HTMLElement} */ (template.content.firstElementChild.cloneNode(true));
                if (callIndex === 2) {
                    node.querySelector('.hotkey-list-item-input')?.remove();
                }
                return node;
            }),
            modifyProfileSettings: vi.fn().mockResolvedValue([]),
            getOptionsContext: vi.fn(() => ({index: 0})),
            getDefaultOptions: vi.fn(),
            refresh: vi.fn(),
        };

        const controller = createController(settingsController);

        await expect(controller.prepare()).resolves.toBeUndefined();

        expect(settingsController.instantiateTemplate).toHaveBeenCalledTimes(2);
        expect(window.document.querySelectorAll('#hotkey-list .hotkey-list-item')).toHaveLength(1);
        expect(window.document.querySelector('#hotkey-list-empty')?.hidden).toBe(true);
    });
});
