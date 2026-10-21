/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {YomitanApi} from '../ext/js/comm/yomitan-api.js';
import {log} from '../ext/js/core/log.js';

/**
 * @template T
 * @returns {{promise: Promise<T>, resolve: (value: T) => void, reject: (error: unknown) => void}}
 */
function deferred() {
    /** @type {(value: T) => void} */
    let resolve = () => {};
    /** @type {(error: unknown) => void} */
    let reject = () => {};
    /** @type {Promise<T>} */
    const promise = new Promise((resolve2, reject2) => {
        resolve = resolve2;
        reject = reject2;
    });
    return {promise, resolve, reject};
}

class NativeEvent {
    constructor() {
        /** @type {Set<(value?: unknown) => unknown>} */
        this.listeners = new Set();
    }

    /** @param {(value?: unknown) => unknown} listener */
    addListener(listener) { this.listeners.add(listener); }

    /** @param {(value?: unknown) => unknown} listener */
    removeListener(listener) { this.listeners.delete(listener); }

    /** @param {unknown} [value] */
    emit(value) {
        for (const listener of this.listeners) { listener(value); }
    }
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

/** @type {YomitanApi[]} */
let clients = [];

beforeEach(() => {
    clients = [];
    vi.spyOn(log, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    for (const client of clients) { client.disconnect(); }
    vi.unstubAllGlobals();
});

/** @returns {Promise<void>} */
async function nextTask() {
    await new Promise((resolve) => { setTimeout(resolve, 0); });
}

function setup() {
    const first = new NativePort();
    const second = new NativePort();
    const connectNative = vi.fn().mockReturnValueOnce(first.asRuntimePort()).mockReturnValue(second.asRuntimePort());
    vi.stubGlobal('chrome', {runtime: {connectNative, getManifest: () => ({version: '1.2.3.4'})}});
    const options = /** @type {import('settings').Options} */ (/** @type {unknown} */ ({profileCurrent: 0, profiles: []}));
    const optionsGetFull = vi.fn(async () => options);
    /** @type {import('api').ApiMap} */
    const apiMap = new Map();
    apiMap.set('optionsGetFull', () => optionsGetFull());
    const api = new YomitanApi(apiMap, null);
    clients.push(api);
    return {api, apiMap, first, second, connectNative, options, optionsGetFull};
}

const request = {action: 'yomitanVersion', params: {id: 'request'}, body: ''};

test('a synchronous native connection failure can be retried and concurrent retries share setup', async () => {
    const {api, first, connectNative} = setup();
    connectNative.mockReset().mockImplementationOnce(() => { throw new Error('Native host temporarily unavailable'); }).mockReturnValue(first.asRuntimePort());
    await api.setEnabled(true);
    expect(api.isConnected()).toBe(false);
    await expect(Promise.all([api.startApiServer(), api.startApiServer()])).resolves.toEqual([true, true]);
    expect(connectNative).toHaveBeenCalledTimes(2);
    expect(api.isConnected()).toBe(true);
});

test('concurrent remote version checks return their own response versions', async () => {
    const {api} = setup();
    await api.setEnabled(true);
    const firstJson = deferred();
    const secondJson = deferred();
    vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce({json: () => firstJson.promise})
        .mockResolvedValueOnce({json: () => secondJson.promise}));

    const first = api.getRemoteVersion('http://first-host.test');
    const second = api.getRemoteVersion('http://second-host.test');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    secondJson.resolve({version: 2});
    firstJson.resolve({version: 1});

    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
});

test('temporary version check cannot retire a replacement started during native setup', async () => {
    const {api, first, second, connectNative} = setup();
    await api.setEnabled(true);
    api.disconnect();
    const third = new NativePort();
    connectNative.mockReset()
        .mockReturnValueOnce(second.asRuntimePort())
        .mockReturnValueOnce(third.asRuntimePort());
    const originalStart = api.startApiServer.bind(api);
    const startEntered = deferred();
    const finishStart = deferred();
    vi.spyOn(api, 'startApiServer').mockImplementation(async () => {
        const result = await originalStart();
        startEntered.resolve(void 0);
        await finishStart.promise;
        return result;
    });
    const response = deferred();
    vi.stubGlobal('fetch', vi.fn(() => response.promise));
    const check = api.getRemoteVersion('http://native-host.test', true);
    await startEntered.promise;
    expect(api.isConnected()).toBe(true);
    api.disconnect();
    await originalStart();
    finishStart.resolve(void 0);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    response.resolve(new Response('{"version":1}', {headers: {'Content-Type': 'application/json'}}));
    await expect(check).resolves.toBe(1);
    expect(connectNative).toHaveBeenCalledTimes(2);
    expect(api.isConnected()).toBe(true);
    expect(third.disconnect).not.toHaveBeenCalled();
    expect(first.disconnect).toHaveBeenCalledOnce();
});

test('an older failed setup cannot replace or clear a reentrant successful setup', async () => {
    const {api, first, connectNative} = setup();
    /** @type {ReturnType<typeof deferred<boolean>>} */
    const replacement = deferred();
    connectNative.mockReset().mockImplementationOnce(() => {
        api.disconnect();
        void api.startApiServer().then(replacement.resolve, replacement.reject);
        throw new Error('Older native setup failed');
    }).mockReturnValue(first.asRuntimePort());
    await api.setEnabled(true);
    await expect(replacement.promise).resolves.toBe(true);
    await expect(api.startApiServer()).resolves.toBe(true);
    expect(api.isConnected()).toBe(true);
    expect(connectNative).toHaveBeenCalledTimes(2);
    expect(first.disconnect).not.toHaveBeenCalled();
});

test('disabling after connection failure evicts failed setup before re-enabling', async () => {
    const {api, first, connectNative} = setup();
    connectNative.mockReset().mockImplementationOnce(() => { throw new Error('Native host temporarily unavailable'); }).mockReturnValue(first.asRuntimePort());
    await api.setEnabled(true);
    await api.setEnabled(false);
    await api.setEnabled(true);
    expect(connectNative).toHaveBeenCalledTimes(2);
    expect(api.isConnected()).toBe(true);
});

test('disabling during startup leaves no connection and can be re-enabled', async () => {
    const {api, connectNative} = setup();
    const enabling = api.setEnabled(true);
    await api.setEnabled(false);
    await enabling;
    expect(api.isEnabled()).toBe(false);
    expect(api.isConnected()).toBe(false);
    const attempts = connectNative.mock.calls.length;
    await api.setEnabled(true);
    expect(connectNative).toHaveBeenCalledTimes(attempts + 1);
    expect(api.isConnected()).toBe(true);
});

test('disconnect during startup leaves a later explicit start retryable', async () => {
    const {api, connectNative} = setup();
    const enabling = api.setEnabled(true);
    api.disconnect();
    await enabling;
    expect(api.isConnected()).toBe(false);
    const attempts = connectNative.mock.calls.length;
    await expect(api.startApiServer()).resolves.toBe(true);
    expect(connectNative).toHaveBeenCalledTimes(attempts + 1);
    expect(api.isConnected()).toBe(true);
});

test('settings-read failure returns an error response without an unhandled listener rejection', async () => {
    const {api, first, optionsGetFull} = setup();
    optionsGetFull.mockRejectedValueOnce(new Error('Settings unavailable'));
    await api.setEnabled(true);
    first.onMessage.emit(request);
    await nextTask();
    expect(first.postMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({action: request.action, params: request.params, responseStatusCode: 500}));
});

test.each(['resolve', 'reject'])('an old request cannot reply through a replacement connection after options %s', async (outcome) => {
    const {api, first, second, options, optionsGetFull} = setup();
    /** @type {ReturnType<typeof deferred<import('settings').Options>>} */
    const pending = deferred();
    /** @type {ReturnType<typeof deferred<void>>} */
    const entered = deferred();
    optionsGetFull.mockImplementationOnce(() => {
        entered.resolve();
        return pending.promise;
    });
    await api.setEnabled(true);
    first.onMessage.emit(request);
    await entered.promise;
    api.disconnect();
    await expect(api.startApiServer()).resolves.toBe(true);
    if (outcome === 'resolve') {
        pending.resolve(options);
    } else {
        pending.reject(new Error('Old request failed'));
    }
    await nextTask();
    expect(first.postMessage).not.toHaveBeenCalled();
    expect(second.postMessage).not.toHaveBeenCalled();
    second.onMessage.emit(request);
    await nextTask();
    expect(second.postMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({data: {version: '1.2.3.4'}, responseStatusCode: 200}));
});

test.each(['resolve', 'reject'])('a lookup finishing after reconnect cannot reply to the new host after %s', async (outcome) => {
    const {api, apiMap, first, second} = setup();
    /** @type {ReturnType<typeof deferred<import('api').ApiReturn<'termsFind'>>>} */
    const pending = deferred();
    /** @type {ReturnType<typeof deferred<void>>} */
    const entered = deferred();
    apiMap.set('termsFind', () => {
        entered.resolve();
        return pending.promise;
    });
    const lookupRequest = {action: 'termEntries', params: {id: 'old-lookup'}, body: JSON.stringify({term: '語'})};
    await api.setEnabled(true);
    first.onMessage.emit(lookupRequest);
    await entered.promise;
    api.disconnect();
    await expect(api.startApiServer()).resolves.toBe(true);
    if (outcome === 'resolve') {
        pending.resolve({dictionaryEntries: [], originalTextLength: 0});
    } else {
        pending.reject(new Error('Old lookup failed'));
    }
    await nextTask();
    expect(first.postMessage).not.toHaveBeenCalled();
    expect(second.postMessage).not.toHaveBeenCalled();
    expect(second.disconnect).not.toHaveBeenCalled();
    expect(api.isConnected()).toBe(true);
});

test('a queued disconnect callback from an old connection cannot close the replacement', async () => {
    const {api, first, second} = setup();
    await api.setEnabled(true);
    const staleDisconnect = [...first.onDisconnect.listeners][0];
    if (typeof staleDisconnect !== 'function') { throw new Error('Expected native disconnect listener'); }
    api.disconnect();
    await api.startApiServer();
    staleDisconnect();
    expect(api.isConnected()).toBe(true);
    expect(second.disconnect).not.toHaveBeenCalled();
    second.onMessage.emit(request);
    await nextTask();
    expect(second.postMessage).toHaveBeenCalledOnce();
});

test('a failed normal reply can return an error without closing a healthy connection', async () => {
    const {api, first, optionsGetFull} = setup();
    first.postMessage.mockImplementationOnce(() => { throw new TypeError('Cannot serialize response'); });
    await api.setEnabled(true);
    first.onMessage.emit(request);
    await nextTask();
    expect(first.postMessage).toHaveBeenCalledTimes(2);
    expect(first.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({action: request.action, params: request.params, responseStatusCode: 500}));
    expect(first.disconnect).not.toHaveBeenCalled();
    expect(optionsGetFull).toHaveBeenCalledOnce();
    expect(api.isConnected()).toBe(true);
    first.onMessage.emit(request);
    await nextTask();
    expect(first.postMessage).toHaveBeenCalledTimes(3);
    expect(optionsGetFull).toHaveBeenCalledTimes(2);
    expect(first.disconnect).not.toHaveBeenCalled();
});

test('response delivery failure closes only its owner and does not retry the action', async () => {
    const {api, first, second, optionsGetFull} = setup();
    first.postMessage.mockImplementation(() => { throw new Error('Native port closed'); });
    await api.setEnabled(true);
    first.onMessage.emit(request);
    await nextTask();
    expect(first.postMessage).toHaveBeenCalledTimes(2);
    expect(first.disconnect).toHaveBeenCalledOnce();
    expect(optionsGetFull).toHaveBeenCalledOnce();
    expect(api.isConnected()).toBe(false);
    await api.startApiServer();
    expect(second.postMessage).not.toHaveBeenCalled();
    second.onMessage.emit(request);
    await nextTask();
    expect(second.postMessage).toHaveBeenCalledOnce();
});

test('listener registration failure closes the incomplete connection and permits retry', async () => {
    const {api, first, second} = setup();
    vi.spyOn(first.onDisconnect, 'addListener').mockImplementation(() => { throw new Error('Registration unavailable'); });
    await api.setEnabled(true);
    expect(first.disconnect).toHaveBeenCalledOnce();
    expect(first.onMessage.listeners.size).toBe(0);
    expect(api.isConnected()).toBe(false);
    await expect(api.startApiServer()).resolves.toBe(true);
    expect(second.onMessage.listeners.size).toBe(1);
});

test('cleanup attempts all listener removals and disconnect even when one removal fails', async () => {
    const {api, first, second} = setup();
    await api.setEnabled(true);
    vi.spyOn(first.onMessage, 'removeListener').mockImplementation(() => { throw new Error('Listener removal failed'); });
    expect(() => api.disconnect()).not.toThrow();
    expect(first.onDisconnect.listeners.size).toBe(0);
    expect(first.disconnect).toHaveBeenCalledOnce();
    await expect(api.startApiServer()).resolves.toBe(true);
    expect(second.onMessage.listeners.size).toBe(1);
});
