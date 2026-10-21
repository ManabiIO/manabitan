/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, test, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';
import {YomitanApi} from '../ext/js/comm/yomitan-api.js';

class NativeEvent {
    constructor() {
        /** @type {Set<(value?: unknown) => unknown>} */
        this.listeners = new Set();
    }

    /** @param {(value?: unknown) => unknown} listener */
    addListener(listener) { this.listeners.add(listener); }

    /** @param {(value?: unknown) => unknown} listener */
    removeListener(listener) { this.listeners.delete(listener); }
}

class NativePort {
    constructor() {
        this.onMessage = new NativeEvent();
        this.onDisconnect = new NativeEvent();
        this.disconnect = vi.fn();
        this.postMessage = vi.fn();
    }

    /** @returns {chrome.runtime.Port} */
    asRuntimePort() { return /** @type {chrome.runtime.Port} */ (/** @type {unknown} */ (this)); }
}

/**
 * @template T
 * @returns {{promise: Promise<T>, resolve: (value: T) => void}}
 */
function deferred() {
    /** @type {(value: T) => void} */
    let resolve = () => {};
    const promise = new Promise((resolve2) => { resolve = resolve2; });
    return {promise, resolve};
}

afterEach(() => {
    vi.unstubAllGlobals();
});

test('API version check only retires the temporary connection it started with', async () => {
    const ports = [new NativePort(), new NativePort(), new NativePort()];
    const connectNative = vi.fn()
        .mockReturnValueOnce(ports[0].asRuntimePort())
        .mockReturnValueOnce(ports[1].asRuntimePort())
        .mockReturnValueOnce(ports[2].asRuntimePort());
    vi.stubGlobal('chrome', {
        permissions: {contains: (/** @type {chrome.permissions.Permissions} */ _permissions, /** @type {(result: boolean) => void} */ callback) => callback(true)},
        runtime: {connectNative},
    });
    const api = new YomitanApi(new Map(), null);
    await api.setEnabled(true);
    api.disconnect();

    const response = deferred();
    vi.stubGlobal('fetch', vi.fn(() => response.promise));
    const backend = /** @type {Backend} */ (Object.assign(Object.create(Backend.prototype), {_yomitanApi: api}));
    const check = backend._onApiTestYomitanApi({url: 'http://native-host.test'}, {});
    await vi.waitFor(() => expect(connectNative).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    api.disconnect();
    await expect(api.startApiServer()).resolves.toBe(true);
    expect(api.isConnected()).toBe(true);
    response.resolve(new Response('{"version":1}', {headers: {'Content-Type': 'application/json'}}));
    await expect(check).resolves.toBe(true);

    expect(api.isConnected()).toBe(true);
    expect(ports[2].disconnect).not.toHaveBeenCalled();
});
