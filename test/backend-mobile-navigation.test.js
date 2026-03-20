/*
 * Copyright (C) 2023-2026  Yomitan Authors
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

import {afterEach, describe, expect, test, vi} from 'vitest';
import {openSettingsPage} from '../ext/js/background/extension-page-navigation.js';

/** @type {typeof chrome|undefined} */
const originalChrome = global.chrome;

afterEach(() => {
    global.chrome = originalChrome;
    vi.restoreAllMocks();
});

describe('Backend mobile navigation fallbacks', () => {
    test('falls back to opening a settings tab when openOptionsPage fails', async () => {
        global.chrome = /** @type {typeof chrome} */ (/** @type {unknown} */ ({
            runtime: {
                getManifest: () => ({options_ui: {page: 'settings.html'}}),
                getURL: (path) => `chrome-extension://test/${path}`,
                openOptionsPage: (callback) => {
                    global.chrome.runtime.lastError = {message: 'openOptionsPage unsupported'};
                    callback();
                    global.chrome.runtime.lastError = null;
                },
                lastError: null,
            },
        }));

        const createTab = vi.fn(async () => ({id: 1}));
        await openSettingsPage('existingOrNewTab', createTab);

        expect(createTab).toHaveBeenCalledTimes(1);
        expect(createTab).toHaveBeenCalledWith('chrome-extension://test/settings.html');
    });
});
