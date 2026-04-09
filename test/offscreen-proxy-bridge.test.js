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

const {OffscreenProxy} = await import('../ext/js/background/offscreen-proxy.js');

describe('OffscreenProxy bridge reliability', () => {
    /** @type {typeof globalThis.chrome|undefined} */
    let originalChrome;

    beforeEach(() => {
        originalChrome = globalThis.chrome;
        globalThis.chrome = /** @type {typeof globalThis.chrome} */ ({
            runtime: {
                lastError: undefined,
            },
        });
    });

    afterEach(() => {
        if (typeof originalChrome === 'undefined') {
            // @ts-expect-error - test restores deleted global
            delete globalThis.chrome;
        } else {
            globalThis.chrome = originalChrome;
        }
        vi.restoreAllMocks();
    });

    test('sendMessageViaPort waits for asynchronously registered control port', async () => {
        const port = {
            postMessage: vi.fn(),
            close: vi.fn(),
            onmessageerror: null,
        };
        /** @type {InstanceType<typeof OffscreenProxy>|null} */
        let proxy = null;
        const webExtension = {
            sendMessagePromise: vi.fn(async (message) => {
                if (message?.action === 'createAndRegisterPortOffscreen' && proxy !== null) {
                    queueMicrotask(() => {
                        void proxy?.registerOffscreenPort(/** @type {MessagePort} */ (/** @type {unknown} */ (port)));
                    });
                }
                return {result: null};
            }),
        };
        proxy = new OffscreenProxy(/** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ (/** @type {unknown} */ (webExtension)));

        await proxy.sendMessageViaPort({action: 'connectToDatabaseWorker'}, []);

        expect(webExtension.sendMessagePromise).toHaveBeenCalledWith({action: 'createAndRegisterPortOffscreen'});
        expect(port.postMessage).toHaveBeenCalledTimes(1);
    });

    test('sendMessageViaPort clears stale control port and retries once', async () => {
        const stalePort = {
            postMessage: vi.fn(() => {
                throw new Error('stale');
            }),
            close: vi.fn(),
            onmessageerror: null,
        };
        const freshPort = {
            postMessage: vi.fn(),
            close: vi.fn(),
            onmessageerror: null,
        };
        /** @type {InstanceType<typeof OffscreenProxy>|null} */
        let proxy = null;
        const webExtension = {
            sendMessagePromise: vi.fn(async (message) => {
                if (message?.action === 'createAndRegisterPortOffscreen' && proxy !== null) {
                    queueMicrotask(() => {
                        void proxy?.registerOffscreenPort(/** @type {MessagePort} */ (/** @type {unknown} */ (freshPort)));
                    });
                }
                return {result: null};
            }),
        };
        proxy = new OffscreenProxy(/** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ (/** @type {unknown} */ (webExtension)));
        await proxy.registerOffscreenPort(/** @type {MessagePort} */ (/** @type {unknown} */ (stalePort)));

        await proxy.sendMessageViaPort({action: 'connectToDatabaseWorker'}, []);

        expect(stalePort.postMessage).toHaveBeenCalledTimes(1);
        expect(stalePort.close).toHaveBeenCalledTimes(1);
        expect(freshPort.postMessage).toHaveBeenCalledTimes(1);
    });
});
