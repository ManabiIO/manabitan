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

import {afterEach, describe, expect, test, vi} from 'vitest';

const {API} = await import('../ext/js/comm/api.js');

describe('API PM transport reliability', () => {
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

    afterEach(() => {
        if (typeof navigatorDescriptor === 'undefined') {
            // @ts-expect-error - test restores deleted global
            delete globalThis.navigator;
        } else {
            Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
        }
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    test('registerOffscreenPort rejects when Firefox backend port is unavailable', async () => {
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: {},
        });
        const api = new API(/** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ (/** @type {unknown} */ ({})));

        await expect(api.registerOffscreenPort([])).rejects.toThrow(/Backend message port is not available/);
    });

    test('registerOffscreenPort clears stale Firefox backend port when postMessage throws', async () => {
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: {},
        });
        vi.stubGlobal('window', {location: {protocol: 'file:'}});
        vi.stubGlobal('SharedWorker', class {
            constructor() {
                this.port = {
                    postMessage: vi.fn(),
                    close: vi.fn(),
                };
            }
        });
        vi.stubGlobal('MessageChannel', class {
            constructor() {
                this.port1 = {close: vi.fn()};
                this.port2 = {postMessage: vi.fn(), close: vi.fn(), onmessageerror: null};
            }
        });
        const backendPort = {
            postMessage: vi.fn(() => {
                throw new Error('port closed');
            }),
            close: vi.fn(),
            onmessageerror: null,
        };
        const api = new API(
            /** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ (/** @type {unknown} */ ({})),
            null,
            /** @type {MessagePort} */ (/** @type {unknown} */ (backendPort)),
        );

        await expect(api.registerOffscreenPort([])).resolves.toBeUndefined();
        expect(backendPort.close).toHaveBeenCalledTimes(1);
    });

    test('registerOffscreenPort shares one Firefox backend-port reconnect across concurrent calls', async () => {
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: {},
        });
        vi.stubGlobal('window', {location: {protocol: 'file:'}});
        const staleBackendPort = {
            postMessage: vi.fn(() => {
                throw new Error('port closed');
            }),
            close: vi.fn(),
            onmessageerror: null,
        };
        const freshBackendPort = {
            postMessage: vi.fn(),
            close: vi.fn(),
            onmessageerror: null,
        };
        const api = new API(
            /** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ (/** @type {unknown} */ ({})),
            null,
            /** @type {MessagePort} */ (/** @type {unknown} */ (staleBackendPort)),
        );
        const reconnectSpy = vi.spyOn(api, '_createFirefoxBackendPort').mockImplementation(() => /** @type {MessagePort} */ (/** @type {unknown} */ (freshBackendPort)));

        await Promise.all([
            api.registerOffscreenPort([]),
            api.registerOffscreenPort([]),
        ]);

        expect(reconnectSpy).toHaveBeenCalledTimes(1);
        expect(freshBackendPort.postMessage).toHaveBeenCalledTimes(2);
    });

    test('registerOffscreenPort discards a late Firefox backend reconnect after shutdown', async () => {
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: {},
        });
        vi.stubGlobal('window', {location: {protocol: 'file:'}});
        const staleBackendPort = {
            postMessage: vi.fn(() => {
                throw new Error('port closed');
            }),
            close: vi.fn(),
            onmessageerror: null,
        };
        const freshBackendPort = {
            postMessage: vi.fn(),
            close: vi.fn(),
            onmessageerror: null,
        };
        const api = new API(
            /** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ (/** @type {unknown} */ ({})),
            null,
            /** @type {MessagePort} */ (/** @type {unknown} */ (staleBackendPort)),
        );
        vi.spyOn(api, '_createFirefoxBackendPort').mockImplementation(() => {
            api.shutdownRuntimeConnections();
            return /** @type {MessagePort} */ (/** @type {unknown} */ (freshBackendPort));
        });

        await expect(api.registerOffscreenPort([])).rejects.toThrow(/Runtime connections have been shut down/);
        expect(api._backendPort).toBeNull();
        expect(freshBackendPort.close).toHaveBeenCalledTimes(1);
    });

    test('connectToDatabaseWorker times out when service worker never becomes ready', async () => {
        vi.useFakeTimers();
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: {
                serviceWorker: {
                    ready: new Promise(() => {}),
                },
            },
        });
        const api = new API(/** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ (/** @type {unknown} */ ({})));

        const expectation = expect(
            api.connectToDatabaseWorker(/** @type {MessagePort} */ (/** @type {unknown} */ ({}))),
        ).rejects.toThrow(/Timed out waiting for active service worker/);
        await vi.advanceTimersByTimeAsync(10_000);

        await expectation;
    });

    test('connectToDatabaseWorker retries once when service worker postMessage initially fails', async () => {
        vi.useFakeTimers();
        const active = {
            postMessage: vi.fn(() => {
                if (active.postMessage.mock.calls.length === 1) {
                    throw new Error('worker restarting');
                }
            }),
        };
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: {
                serviceWorker: {
                    ready: Promise.resolve({active}),
                },
            },
        });
        const api = new API(/** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ (/** @type {unknown} */ ({})));

        const promise = api.connectToDatabaseWorker(/** @type {MessagePort} */ (/** @type {unknown} */ ({})));
        await vi.advanceTimersByTimeAsync(100);

        await expect(promise).resolves.toBeUndefined();
        expect(active.postMessage).toHaveBeenCalledTimes(2);
    });

    test('connectToDatabaseWorker does not retry service-worker PM after runtime shutdown', async () => {
        vi.useFakeTimers();
        const active = {
            postMessage: vi.fn(() => {
                throw new Error('worker restarting');
            }),
        };
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: {
                serviceWorker: {
                    ready: Promise.resolve({active}),
                },
            },
        });
        const api = new API(/** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ (/** @type {unknown} */ ({})));

        const promise = api.connectToDatabaseWorker(/** @type {MessagePort} */ (/** @type {unknown} */ ({close: vi.fn()})));
        const expectation = expect(promise).rejects.toThrow(/Runtime connections have been shut down/);
        api.shutdownRuntimeConnections();
        await vi.advanceTimersByTimeAsync(100);

        await expectation;
        expect(active.postMessage).toHaveBeenCalledTimes(1);
    });

    test('_invoke times out when backend never answers', async () => {
        vi.useFakeTimers();
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: {
                serviceWorker: {},
            },
        });
        const webExtension = {
            sendMessage: vi.fn((_message, _callback) => {}),
        };
        const api = new API(/** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ (/** @type {unknown} */ (webExtension)));

        const expectation = expect(
            api.getDictionaryInfo(),
        ).rejects.toThrow(/Timed out waiting for backend response to getDictionaryInfo after 30000ms/);
        await vi.advanceTimersByTimeAsync(30_000);

        await expectation;
    });

    test('_invoke retries once for retryable transient runtime disconnects', async () => {
        vi.useFakeTimers();
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: {
                serviceWorker: {},
            },
        });
        let callbackCount = 0;
        vi.stubGlobal('chrome', {
            runtime: {
                lastError: undefined,
            },
        });
        const webExtension = {
            sendMessage: vi.fn((_message, callback) => {
                callbackCount += 1;
                if (callbackCount === 1) {
                    globalThis.chrome.runtime.lastError = {message: 'Could not establish connection. Receiving end does not exist.'};
                    callback(undefined);
                    return;
                }
                globalThis.chrome.runtime.lastError = undefined;
                callback({result: []});
            }),
            getLastError: vi.fn(() => {
                const lastError = globalThis.chrome.runtime.lastError;
                if (!lastError) { return null; }
                return new Error(lastError.message);
            }),
        };
        const api = new API(/** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ (/** @type {unknown} */ (webExtension)));

        const promise = api.getDictionaryInfo();
        await vi.advanceTimersByTimeAsync(100);

        await expect(promise).resolves.toStrictEqual([]);
        expect(webExtension.sendMessage).toHaveBeenCalledTimes(2);
    });

    test('_invoke does not perform delayed retry after runtime shutdown', async () => {
        vi.useFakeTimers();
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: {
                serviceWorker: {},
            },
        });
        vi.stubGlobal('chrome', {
            runtime: {
                lastError: undefined,
            },
        });
        const webExtension = {
            sendMessage: vi.fn((_message, callback) => {
                globalThis.chrome.runtime.lastError = {message: 'Could not establish connection. Receiving end does not exist.'};
                callback(undefined);
            }),
            getLastError: vi.fn(() => {
                const lastError = globalThis.chrome.runtime.lastError;
                if (!lastError) { return null; }
                return new Error(lastError.message);
            }),
        };
        const api = new API(/** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ (/** @type {unknown} */ (webExtension)));

        const promise = api.getDictionaryInfo();
        const expectation = expect(promise).rejects.toThrow(/Runtime connections have been shut down/);
        api.shutdownRuntimeConnections();
        await vi.advanceTimersByTimeAsync(100);

        await expectation;
        expect(webExtension.sendMessage).toHaveBeenCalledTimes(1);
    });

    test('_invoke does not retry mutation actions on transient runtime disconnects', async () => {
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: {
                serviceWorker: {},
            },
        });
        vi.stubGlobal('chrome', {
            runtime: {
                lastError: {message: 'Could not establish connection. Receiving end does not exist.'},
            },
        });
        const webExtension = {
            sendMessage: vi.fn((_message, callback) => {
                callback(undefined);
            }),
            getLastError: vi.fn(() => new Error('Could not establish connection. Receiving end does not exist.')),
        };
        const api = new API(/** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ (/** @type {unknown} */ (webExtension)));

        await expect(api.modifySettings([], 'test')).rejects.toThrow(/Could not establish connection/);
        expect(webExtension.sendMessage).toHaveBeenCalledTimes(1);
    });

    test('drawMedia reconnects the media worker database port before drawing when needed', async () => {
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: {},
        });
        /** @type {(event: MessageEvent) => void} */
        let onMessage = () => {};
        const mediaDrawingWorker = {
            addEventListener: vi.fn((type, listener) => {
                if (type === 'message') {
                    onMessage = /** @type {(event: MessageEvent) => void} */ (listener);
                }
            }),
            postMessage: vi.fn(),
        };
        const backendPort = {
            postMessage: vi.fn(),
            close: vi.fn(),
            onmessageerror: null,
        };
        const api = new API(
            /** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ (/** @type {unknown} */ ({})),
            /** @type {Worker} */ (/** @type {unknown} */ (mediaDrawingWorker)),
            /** @type {MessagePort} */ (/** @type {unknown} */ (backendPort)),
        );
        api._mediaDrawingWorkerConnected = false;

        api.drawMedia([{canvas: null}], []);
        await vi.waitFor(() => {
            expect(mediaDrawingWorker.postMessage).toHaveBeenCalledTimes(2);
        });

        expect(mediaDrawingWorker.postMessage).toHaveBeenNthCalledWith(
            1,
            {action: 'connectToDatabaseWorker'},
            expect.any(Array),
        );
        expect(backendPort.postMessage).toHaveBeenCalledWith({action: 'connectToDatabaseWorker', params: undefined}, expect.any(Array));
        expect(mediaDrawingWorker.postMessage).toHaveBeenNthCalledWith(
            2,
            {action: 'drawMedia', params: {requests: [{canvas: null}]}},
            [],
        );

        onMessage(/** @type {MessageEvent} */ (/** @type {unknown} */ ({
            data: {action: 'mediaDrawingWorkerDatabasePortClosed'},
        })));

        expect(api._mediaDrawingWorkerConnected).toBe(false);
    });

    test('stale media worker notifications do not disconnect the current worker state', () => {
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: {},
        });
        /** @type {(event: MessageEvent) => void} */
        let staleWorkerOnMessage = () => {};
        /** @type {(event: MessageEvent) => void} */
        let currentWorkerOnMessage = () => {};
        const staleWorker = {
            addEventListener: vi.fn((type, listener) => {
                if (type === 'message') {
                    staleWorkerOnMessage = /** @type {(event: MessageEvent) => void} */ (listener);
                }
            }),
        };
        const currentWorker = {
            addEventListener: vi.fn((type, listener) => {
                if (type === 'message') {
                    currentWorkerOnMessage = /** @type {(event: MessageEvent) => void} */ (listener);
                }
            }),
        };
        const api = new API(
            /** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ (/** @type {unknown} */ ({})),
            /** @type {Worker} */ (/** @type {unknown} */ (staleWorker)),
        );

        api._mediaDrawingWorkerConnected = true;
        api.setMediaDrawingWorker(/** @type {Worker} */ (/** @type {unknown} */ (currentWorker)));
        api._mediaDrawingWorkerConnected = true;

        staleWorkerOnMessage(/** @type {MessageEvent} */ (/** @type {unknown} */ ({
            data: {action: 'mediaDrawingWorkerDatabasePortClosed'},
        })));
        expect(api._mediaDrawingWorkerConnected).toBe(true);

        currentWorkerOnMessage(/** @type {MessageEvent} */ (/** @type {unknown} */ ({
            data: {action: 'mediaDrawingWorkerDatabasePortClosed'},
        })));
        expect(api._mediaDrawingWorkerConnected).toBe(false);
    });

    test('stale media worker connect success does not mark current worker connected', async () => {
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: {
                serviceWorker: {},
            },
        });
        let resolvePmInvoke;
        const staleWorker = {
            addEventListener: vi.fn(),
            postMessage: vi.fn(),
        };
        const currentWorker = {
            addEventListener: vi.fn(),
            postMessage: vi.fn(),
        };
        const webExtension = {
            sendMessage: vi.fn(),
            getLastError: vi.fn(() => null),
        };
        const api = new API(
            /** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ (/** @type {unknown} */ (webExtension)),
            /** @type {Worker} */ (/** @type {unknown} */ (staleWorker)),
        );
        vi.spyOn(api, '_pmInvoke').mockImplementation(() => new Promise((resolve) => {
            resolvePmInvoke = resolve;
        }));

        const pending = api.ensureMediaDrawingWorkerConnected();
        api.setMediaDrawingWorker(/** @type {Worker} */ (/** @type {unknown} */ (currentWorker)));
        resolvePmInvoke();

        await expect(pending).rejects.toThrow(/Media drawing worker changed while connecting/);
        expect(api._mediaDrawingWorkerConnected).toBe(false);
    });

    test('shutdownRuntimeConnections clears stale backend and media worker state', () => {
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: {},
        });
        const mediaDrawingWorker = {
            addEventListener: vi.fn(),
        };
        const backendPort = {
            postMessage: vi.fn(),
            close: vi.fn(),
            onmessageerror: null,
        };
        const api = new API(
            /** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ (/** @type {unknown} */ ({})),
            /** @type {Worker} */ (/** @type {unknown} */ (mediaDrawingWorker)),
            /** @type {MessagePort} */ (/** @type {unknown} */ (backendPort)),
        );
        api._backendReconnectPromise = Promise.resolve();
        api._mediaDrawingWorkerConnected = true;

        api.shutdownRuntimeConnections();

        expect(api._mediaDrawingWorker).toBeNull();
        expect(api._mediaDrawingWorkerConnected).toBe(false);
        expect(api._backendPort).toBeNull();
        expect(api._backendReconnectPromise).toBeNull();
        expect(backendPort.close).toHaveBeenCalledTimes(1);
    });

    test('registerOffscreenPort fails explicitly after runtime shutdown instead of reconnecting', async () => {
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: {},
        });
        vi.stubGlobal('window', {location: {protocol: 'file:'}});
        const reconnectSpy = vi.spyOn(API.prototype, '_createFirefoxBackendPort');
        const api = new API(/** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ (/** @type {unknown} */ ({})));

        api.shutdownRuntimeConnections();

        await expect(api.registerOffscreenPort([])).rejects.toThrow(/Runtime connections have been shut down/);
        expect(reconnectSpy).not.toHaveBeenCalled();
    });

    test('_invoke fails explicitly after runtime shutdown', async () => {
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: {
                serviceWorker: {},
            },
        });
        const webExtension = {
            sendMessage: vi.fn(),
            getLastError: vi.fn(() => null),
        };
        const api = new API(/** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ (/** @type {unknown} */ (webExtension)));

        api.shutdownRuntimeConnections();

        await expect(api.getDictionaryInfo()).rejects.toThrow(/Runtime connections have been shut down/);
        expect(webExtension.sendMessage).not.toHaveBeenCalled();
    });

    test('connectToDatabaseWorker does not restore connected state after shutdown races with success', async () => {
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: {
                serviceWorker: {
                    ready: Promise.resolve({
                        active: {
                            postMessage: vi.fn(),
                        },
                    }),
                },
            },
        });
        const port = {close: vi.fn()};
        const api = new API(/** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ (/** @type {unknown} */ ({})));
        const pending = api.connectToDatabaseWorker(/** @type {MessagePort} */ (/** @type {unknown} */ (port)));

        api.shutdownRuntimeConnections();

        await expect(pending).rejects.toThrow(/Runtime connections have been shut down/);
        expect(api._mediaDrawingWorkerConnected).toBe(false);
        expect(port.close).toHaveBeenCalledTimes(1);
    });
});
