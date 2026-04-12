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
import {ExtensionKeyboardShortcutController} from '../ext/js/pages/settings/extension-keyboard-shortcuts-controller.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();

describe('ExtensionKeyboardShortcutController', () => {
    test('reset click swallows rejected reset-all command updates', async ({window}) => {
        window.document.body.innerHTML = `
            <button id="extension-hotkey-list-reset-all"></button>
            <button id="extension-hotkey-list-clear-all"></button>
            <div id="extension-hotkey-list"></div>
        `;

        vi.stubGlobal('browser', {
            commands: {
                reset: vi.fn().mockRejectedValue(new Error('reset failed')),
                update: vi.fn(),
            },
        });
        vi.stubGlobal('chrome', {
            commands: {
                getAll: (callback) => callback([{name: 'openSearchPage', shortcut: 'Ctrl+Shift+F'}]),
            },
            runtime: {
                lastError: null,
            },
        });

        const controller = new ExtensionKeyboardShortcutController(/** @type {any} */ ({
            application: {api: {getEnvironmentInfo: vi.fn().mockResolvedValue({platform: {os: 'linux'}})}},
            instantiateTemplate: vi.fn(() => {
                const node = window.document.createElement('div');
                node.innerHTML = `
                    <div class="extension-hotkey-list-item">
                        <div class="settings-item-label"></div>
                        <button class="extension-hotkey-list-item-button"></button>
                        <input>
                    </div>
                `;
                return /** @type {Element} */ (node.firstElementChild);
            }),
        }));

        await controller.prepare();

        await expect(controller._onResetClick(new window.MouseEvent('click'))).toBeUndefined();
        await Promise.resolve();

        vi.unstubAllGlobals();
    });
});
