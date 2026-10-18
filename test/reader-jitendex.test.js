/*
 * Copyright (C) 2026 Manabitan authors
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

import {afterAll, describe, expect, test, vi} from 'vitest';
import {DictionaryImportController} from '../ext/js/pages/settings/dictionary-import-controller.js';
import {setupDomTest} from './fixtures/dom-test.js';

const testEnv = await setupDomTest();
afterAll(async () => {
    await testEnv.teardown(global);
});

describe('Reader Jitendex handoff', () => {
    test('uses the existing recommendation button once and skips an installed dictionary', () => {
        document.body.innerHTML = `<div id="recommended-term-dictionaries">
            <div class="settings-item"><span class="settings-item-label">JMnedict</span>
                <button class="action-button" data-action="import-recommended-dictionary"></button></div>
            <div class="settings-item"><span class="settings-item-label">Jitendex</span>
                <button class="action-button" data-action="import-recommended-dictionary"></button></div>
        </div>`;
        const controller = /** @type {DictionaryImportController} */ (Object.create(DictionaryImportController.prototype));
        Reflect.set(controller, '_readerInstallJitendex', true);
        const [otherButton, jitendexButton] = document.querySelectorAll('button');
        const otherClick = vi.fn();
        const jitendexClick = vi.fn();
        otherButton.addEventListener('click', otherClick);
        jitendexButton.addEventListener('click', jitendexClick);
        const install = /** @type {() => void} */ (Reflect.get(controller, '_installReaderJitendexIfRequested'));

        install.call(controller);
        install.call(controller);
        expect(otherClick).not.toHaveBeenCalled();
        expect(jitendexClick).toHaveBeenCalledTimes(1);

        jitendexButton.disabled = true;
        Reflect.set(controller, '_readerInstallJitendex', true);
        install.call(controller);
        expect(jitendexClick).toHaveBeenCalledTimes(1);
    });
});
