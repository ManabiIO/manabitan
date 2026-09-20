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

import {expect, test} from './playwright-util.js';

test('dictionary refresh preserves a draft typed while options are pending', async ({page, extensionId}) => {
    await page.goto(`chrome-extension://${extensionId}/search.html?query=${encodeURIComponent('猫')}`);
    await expect(page.locator('html')).toHaveAttribute('data-loaded', 'true', {timeout: 30_000});
    await expect(page.locator('#search-textbox')).toHaveValue('猫');
    await page.evaluate(async () => {
        const moduleUrl = chrome.runtime.getURL('/js/display/display.js');
        const {Display} = /** @type {typeof import('../../ext/js/display/display.js')} */ (await import(moduleUrl));
        const originalUpdate = Display.prototype.updateOptions;
        const originalComplete = Display.prototype._triggerContentUpdateComplete;
        const state = {started: false, completions: 0, release: () => {}, restore: () => {}};
        /** @type {Promise<void>} */
        const gate = new Promise((resolve) => { state.release = resolve; });
        Display.prototype.updateOptions = async function () {
            if (Reflect.get(this, '_pageType') === 'search') {
                state.started = true;
                await gate;
            }
            await originalUpdate.call(this);
        };
        Display.prototype._triggerContentUpdateComplete = function () {
            ++state.completions;
            originalComplete.call(this);
        };
        state.restore = () => {
            Display.prototype.updateOptions = originalUpdate;
            Display.prototype._triggerContentUpdateComplete = originalComplete;
        };
        Reflect.set(globalThis, '__searchRefreshTest', state);
        await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({action: 'triggerDatabaseUpdated', params: {type: 'dictionary', cause: 'import'}}, (/** @type {unknown} */ value) => {
                const response = /** @type {{error?: {message?: string}}|undefined} */ (value);
                const error = chrome.runtime.lastError ?? response?.error;
                if (error) { reject(new Error(error.message)); } else { resolve(void 0); }
            });
        });
    });
    try {
        await page.waitForFunction(() => Reflect.get(globalThis, '__searchRefreshTest').started === true);
        const input = page.locator('#search-textbox');
        await input.fill('読め');
        await input.focus();
        await input.evaluate((node) => {
            const textarea = /** @type {HTMLTextAreaElement} */ (node);
            textarea.setSelectionRange(0, 2);
        });
        await page.evaluate(() => Reflect.get(globalThis, '__searchRefreshTest').release());
        await page.waitForFunction(() => Reflect.get(globalThis, '__searchRefreshTest').completions > 0);
        await expect(input).toHaveValue('読め');
        await expect(input).toBeFocused();
        expect(await input.evaluate((node) => {
            const textarea = /** @type {HTMLTextAreaElement} */ (node);
            return [textarea.selectionStart, textarea.selectionEnd];
        })).toEqual([0, 2]);
        await input.press('Enter');
        await expect(page).toHaveURL(/query=%E8%AA%AD%E3%82%81/u);
    } finally {
        await page.evaluate(() => {
            const state = Reflect.get(globalThis, '__searchRefreshTest');
            state.release();
            state.restore();
            Reflect.deleteProperty(globalThis, '__searchRefreshTest');
        });
    }
});
