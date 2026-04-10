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

import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

const {WebExtension} = await import('../ext/js/extension/web-extension.js');

describe('WebExtension', () => {
    /** @type {typeof globalThis.chrome|undefined} */
    let originalChrome;

    beforeEach(() => {
        originalChrome = globalThis.chrome;
        globalThis.chrome = /** @type {typeof globalThis.chrome} */ ({
            runtime: {
                getURL: vi.fn((path) => `chrome-extension://test${path}`),
                getManifest: vi.fn(() => ({name: 'Manabitan', version: '0.0.0.0'})),
                sendMessage: vi.fn(),
                lastError: undefined,
            },
        });
    });

    afterEach(() => {
        if (typeof originalChrome === 'undefined') {
            // @ts-expect-error - restoring deleted global
            delete globalThis.chrome;
        } else {
            globalThis.chrome = originalChrome;
        }
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    test('sendMessagePromise times out when runtime never answers', async () => {
        vi.useFakeTimers();
        const webExtension = new WebExtension();

        const expectation = expect(
            webExtension.sendMessagePromise({action: 'noop'}),
        ).rejects.toThrow(/Timed out waiting for extension response after 30000ms/);
        await vi.advanceTimersByTimeAsync(30_000);

        await expectation;
    });

    test('sendMessagePromise marks extension unloaded on retryable runtime disconnect', async () => {
        const webExtension = new WebExtension();
        globalThis.chrome.runtime.sendMessage = vi.fn((_message, callback) => {
            globalThis.chrome.runtime.lastError = {message: 'Could not establish connection. Receiving end does not exist.'};
            callback(undefined);
        });

        await expect(webExtension.sendMessagePromise({action: 'noop'})).rejects.toThrow(/Could not establish connection/);
        expect(webExtension.unloaded).toBe(true);
    });
});
