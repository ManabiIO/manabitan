/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import {afterEach, expect, test, vi} from 'vitest';
import {API} from '../ext/js/comm/api.js';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

test('Firefox bridge channel construction failure releases the already-acquired shared-worker port', () => {
    const bridgePort = {postMessage: vi.fn(), close: vi.fn()};
    vi.stubGlobal('SharedWorker', class {
        constructor() { this.port = bridgePort; }
    });
    vi.stubGlobal('MessageChannel', class {
        constructor() { throw new Error('channel constructor failed'); }
    });
    const api = new API(/** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ (/** @type {unknown} */ ({})));
    expect(() => api._createFirefoxBackendPort()).toThrow('channel constructor failed');
    expect(bridgePort.close).toHaveBeenCalledTimes(1);
});

for (const closeThrows of [false, true]) {
    test(`failed Firefox handshake releases both channel ports even if bridge close throws=${closeThrows}`, () => {
        const bridgePort = {
            postMessage: vi.fn(() => { throw new Error('handshake failed'); }),
            close: vi.fn(() => { if (closeThrows) { throw new Error('close failed'); } }),
        };
        const port1 = {close: vi.fn()};
        const port2 = {close: vi.fn()};
        vi.stubGlobal('SharedWorker', class {
            constructor() { this.port = bridgePort; }
        });
        vi.stubGlobal('MessageChannel', class {
            constructor() {
                this.port1 = port1;
                this.port2 = port2;
            }
        });
        const api = new API(/** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ (/** @type {unknown} */ ({})));
        expect(() => api._createFirefoxBackendPort()).toThrow('handshake failed');
        expect(bridgePort.close).toHaveBeenCalledTimes(1);
        expect(port1.close).toHaveBeenCalledTimes(1);
        expect(port2.close).toHaveBeenCalledTimes(1);
    });

    test(`failed pre-transfer media connection releases both ports even if first close throws=${closeThrows}`, async () => {
        const port1 = {
            close: vi.fn(() => {
                if (closeThrows) { throw new Error('close failed'); }
            }),
        };
        const port2 = {close: vi.fn()};
        vi.stubGlobal('MessageChannel', class {
            constructor() {
                this.port1 = port1;
                this.port2 = port2;
            }
        });
        const worker = {addEventListener: vi.fn(), postMessage: vi.fn(() => { throw new Error('transfer failed'); })};
        const api = new API(
            /** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ (/** @type {unknown} */ ({})),
            /** @type {Worker} */ (/** @type {unknown} */ (worker)),
        );
        await expect(api.ensureMediaDrawingWorkerConnected()).rejects.toThrow('transfer failed');
        expect(port1.close).toHaveBeenCalledTimes(1);
        expect(port2.close).toHaveBeenCalledTimes(1);
        expect(api._mediaDrawingWorkerConnected).toBe(false);
        expect(api._mediaDrawingWorkerConnectPromise).toBeNull();
    });
}

test('successful Firefox bridge returns the live backend port without closing channel ownership', () => {
    const bridgePort = {postMessage: vi.fn(), close: vi.fn()};
    const port1 = {close: vi.fn()};
    const port2 = {close: vi.fn()};
    vi.stubGlobal('SharedWorker', class {
        constructor() { this.port = bridgePort; }
    });
    vi.stubGlobal('MessageChannel', class {
        constructor() {
            this.port1 = port1;
            this.port2 = port2;
        }
    });
    const api = new API(/** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ (/** @type {unknown} */ ({})));
    expect(api._createFirefoxBackendPort()).toBe(port2);
    expect(bridgePort.postMessage).toHaveBeenCalledWith({action: 'connectToBackend1'}, [port1]);
    expect(bridgePort.close).toHaveBeenCalledTimes(1);
    expect(port1.close).not.toHaveBeenCalled();
    expect(port2.close).not.toHaveBeenCalled();
});
