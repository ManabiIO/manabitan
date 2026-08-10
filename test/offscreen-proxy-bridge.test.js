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

/**
 * @param {(message: Record<string, unknown>, transfers: Transferable[]) => void} [onPostMessage]
 * @returns {MessagePort & {close: ReturnType<typeof vi.fn>, postMessage: ReturnType<typeof vi.fn>}}
 */
function createPort(onPostMessage = () => {}) {
    return /** @type {MessagePort & {close: ReturnType<typeof vi.fn>, postMessage: ReturnType<typeof vi.fn>}} */ (/** @type {unknown} */ ({
        close: vi.fn(),
        onmessage: null,
        onmessageerror: null,
        postMessage: vi.fn((message, transfers = []) => {
            onPostMessage(/** @type {Record<string, unknown>} */ (message), transfers);
        }),
    }));
}

/**
 * @param {MessagePort} port
 * @param {Record<string, unknown>} response
 */
function respond(port, response) {
    port.onmessage?.(/** @type {MessageEvent} */ (/** @type {unknown} */ ({currentTarget: port, data: response})));
}

describe('OffscreenProxy bridge reliability', () => {
    /** @type {typeof globalThis.chrome|undefined} */
    let originalChrome;

    beforeEach(() => {
        originalChrome = globalThis.chrome;
        globalThis.chrome = /** @type {typeof globalThis.chrome} */ ({runtime: {lastError: undefined}});
    });

    afterEach(() => {
        vi.useRealTimers();
        if (typeof originalChrome === 'undefined') {
            // @ts-expect-error - test restores deleted global
            delete globalThis.chrome;
        } else {
            globalThis.chrome = originalChrome;
        }
        vi.restoreAllMocks();
    });

    test('waits for an acknowledged request on an asynchronously registered control port', async () => {
        /** @type {MessagePort|null} */
        let port = null;
        port = createPort((message) => {
            queueMicrotask(() => { respond(/** @type {MessagePort} */ (port), {id: message.id, result: undefined}); });
        });
        /** @type {InstanceType<typeof OffscreenProxy>|null} */
        let proxy = null;
        const webExtension = {
            sendMessagePromise: vi.fn(async (message) => {
                if (message?.action === 'createAndRegisterPortOffscreen' && proxy !== null) {
                    queueMicrotask(() => { void proxy?.registerOffscreenPort(/** @type {MessagePort} */ (port)); });
                }
                return {result: null};
            }),
        };
        proxy = new OffscreenProxy(/** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ (/** @type {unknown} */ (webExtension)));

        await proxy.sendMessageViaPort({action: 'connectToDatabaseWorker'}, []);

        expect(webExtension.sendMessagePromise).toHaveBeenCalledWith({action: 'createAndRegisterPortOffscreen'});
        expect(port.postMessage).toHaveBeenCalledWith({action: 'connectToDatabaseWorker', id: 1}, []);
    });

    test('returns request results from the acknowledged control port', async () => {
        /** @type {MessagePort|null} */
        let port = null;
        const result = {dictionaryEntries: [], originalTextLength: 2};
        port = createPort((message) => {
            queueMicrotask(() => { respond(/** @type {MessagePort} */ (port), {id: message.id, result}); });
        });
        const webExtension = {sendMessagePromise: vi.fn(async () => ({result: null}))};
        const proxy = new OffscreenProxy(/** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ (/** @type {unknown} */ (webExtension)));
        await proxy.registerOffscreenPort(port);

        await expect(proxy.sendMessageViaPort({
            action: 'findTermsStructuredOffscreen',
            params: {
                mode: 'group',
                text: '日本',
                options: /** @type {import('translation').FindTermsOptions} */ ({}),
            },
        }, [])).resolves.toBe(result);
    });

    test('rotates a stale control port and retries a request without transferables', async () => {
        const stalePort = createPort(() => { throw new Error('stale'); });
        /** @type {MessagePort|null} */
        let freshPort = null;
        freshPort = createPort((message) => {
            queueMicrotask(() => { respond(/** @type {MessagePort} */ (freshPort), {id: message.id, result: undefined}); });
        });
        /** @type {InstanceType<typeof OffscreenProxy>|null} */
        let proxy = null;
        const webExtension = {
            sendMessagePromise: vi.fn(async (message) => {
                if (message?.action === 'createAndRegisterPortOffscreen' && proxy !== null) {
                    queueMicrotask(() => { void proxy?.registerOffscreenPort(/** @type {MessagePort} */ (freshPort)); });
                }
                return {result: null};
            }),
        };
        proxy = new OffscreenProxy(/** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ (/** @type {unknown} */ (webExtension)));
        await proxy.registerOffscreenPort(stalePort);

        await proxy.sendMessageViaPort({action: 'connectToDatabaseWorker'}, []);

        expect(stalePort.postMessage).toHaveBeenCalledOnce();
        expect(stalePort.close).toHaveBeenCalledOnce();
        expect(freshPort.postMessage).toHaveBeenCalledWith({action: 'connectToDatabaseWorker', id: 2}, []);
    });

    test('does not retry after attempting to transfer ownership', async () => {
        const stalePort = createPort(() => { throw new Error('stale'); });
        const webExtension = {sendMessagePromise: vi.fn(async () => ({result: null}))};
        const proxy = new OffscreenProxy(/** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ (/** @type {unknown} */ (webExtension)));
        await proxy.registerOffscreenPort(stalePort);
        const transferredPort = /** @type {MessagePort} */ (/** @type {unknown} */ ({name: 'database-port'}));

        await expect(proxy.sendMessageViaPort({action: 'connectToDatabaseWorker'}, [transferredPort])).rejects.toThrow(
            'Failed to send offscreen control message',
        );
        expect(stalePort.postMessage).toHaveBeenCalledOnce();
        expect(webExtension.sendMessagePromise).not.toHaveBeenCalled();
    });

    test('propagates application errors without rotating a healthy control port', async () => {
        /** @type {MessagePort|null} */
        let port = null;
        port = createPort((message) => {
            queueMicrotask(() => {
                respond(/** @type {MessagePort} */ (port), {
                    id: message.id,
                    error: {name: 'Error', message: 'Database preparation failed', stack: ''},
                });
            });
        });
        const webExtension = {sendMessagePromise: vi.fn(async () => ({result: null}))};
        const proxy = new OffscreenProxy(/** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ (/** @type {unknown} */ (webExtension)));
        await proxy.registerOffscreenPort(port);

        await expect(proxy.sendMessageViaPort({action: 'connectToDatabaseWorker'}, [])).rejects.toThrow('Database preparation failed');
        expect(port.close).not.toHaveBeenCalled();
        expect(Reflect.get(proxy, '_currentOffscreenPort')).toBe(port);
    });

    test('rejects pending acknowledgements when the control port is replaced', async () => {
        const firstPort = createPort();
        const secondPort = createPort();
        const webExtension = {sendMessagePromise: vi.fn(async () => ({result: null}))};
        const proxy = new OffscreenProxy(/** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ (/** @type {unknown} */ (webExtension)));
        await proxy.registerOffscreenPort(firstPort);
        const transferredPort = /** @type {MessagePort} */ (/** @type {unknown} */ ({name: 'database-port'}));
        const pending = proxy.sendMessageViaPort({action: 'connectToDatabaseWorker'}, [transferredPort]);
        const expectation = expect(pending).rejects.toThrow('Offscreen control port disconnected');

        await vi.waitFor(() => expect(firstPort.postMessage).toHaveBeenCalledOnce());
        await proxy.registerOffscreenPort(secondPort);

        await expectation;
        expect(firstPort.close).toHaveBeenCalledOnce();
        expect(Reflect.get(proxy, '_offscreenControlResponseHandlers').size).toBe(0);
    });
});
