/*
 * Copyright (C) 2026  Manabitan authors
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
import {Environment} from '../ext/js/extension/environment.js';

/**
 * @param {object} options
 * @param {string} options.userAgent
 * @param {string} [options.vendor]
 * @param {boolean} [options.exposeBrowser]
 * @param {boolean} [options.exposeFirefoxBrowserInfo]
 */
function configureEnvironment({userAgent, vendor = '', exposeBrowser = false, exposeFirefoxBrowserInfo = false}) {
    vi.stubGlobal('navigator', {userAgent, vendor});
    vi.stubGlobal('chrome', {runtime: {getURL: () => 'chrome-extension://test/'}});
    if (exposeBrowser) {
        vi.stubGlobal('browser', {
            runtime: exposeFirefoxBrowserInfo ? {getBrowserInfo: () => Promise.resolve({})} : {},
        });
    } else {
        vi.stubGlobal('browser', void 0);
    }
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('Environment browser detection', () => {
    test('treats the Chrome 148+ browser namespace as Chrome', async () => {
        configureEnvironment({
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36',
            exposeBrowser: true,
        });

        const environment = new Environment();
        expect(await environment._getBrowser('linux')).toBe('chrome');
    });

    test('uses runtime.getBrowserInfo to identify Firefox', async () => {
        configureEnvironment({
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:147.0) Gecko/20100101 Firefox/147.0',
            exposeBrowser: true,
            exposeFirefoxBrowserInfo: true,
        });

        const environment = new Environment();
        expect(await environment._getBrowser('linux')).toBe('firefox');
        expect(await environment._getBrowser('android')).toBe('firefox-mobile');
    });

    test('continues to identify Safari before the Firefox discriminator', async () => {
        configureEnvironment({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15',
            vendor: 'Apple Computer, Inc.',
            exposeBrowser: true,
        });

        const environment = new Environment();
        expect(await environment._getBrowser('mac')).toBe('safari');
    });
});
