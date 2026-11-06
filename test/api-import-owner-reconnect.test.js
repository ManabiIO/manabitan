/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, test, vi} from 'vitest';
import {API} from '../ext/js/comm/api.js';

/** @type {API[]} */
const clients = [];
afterEach(() => {
    for (const api of clients.splice(0)) { api.shutdownRuntimeConnections(); }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

function fixture() {
    let active = false;
    let holdReadiness = false;
    /** @type {Array<{ready: () => void, disconnect: () => void}>} */
    const connections = [];
    const connect = vi.fn(() => {
        /** @type {Set<(message: unknown) => void>} */
        const messages = new Set();
        /** @type {Set<() => void>} */
        const disconnects = new Set();
        const connection = {
            ready() {
                active = true;
                for (const listener of messages) { listener({type: 'ready', ownerId: 'page-A'}); }
            },
            disconnect() {
                active = false;
                for (const listener of disconnects) { listener(); }
            },
        };
        connections.push(connection);
        if (!holdReadiness) { queueMicrotask(connection.ready); }
        return {
            onMessage: {addListener: (/** @type {(message: unknown) => void} */ listener) => messages.add(listener), removeListener: (/** @type {(message: unknown) => void} */ listener) => messages.delete(listener)},
            onDisconnect: {addListener: (/** @type {() => void} */ listener) => disconnects.add(listener), removeListener: (/** @type {() => void} */ listener) => disconnects.delete(listener)},
            disconnect() { active = false; },
        };
    });
    const dispatch = vi.fn((/** @type {{action: string}} */ _message, /** @type {MessagePort[]} */ ports) => {
        ports[0].postMessage(active ? {type: 'complete', result: {title: 'Fixture'}} : {type: 'error', error: {name: 'Error', message: 'Dictionary import session owner is not active'}});
        ports[0].close();
    });
    const serviceWorker = {ready: Promise.resolve({active: {postMessage: dispatch}})};
    vi.stubGlobal('navigator', {serviceWorker});
    vi.stubGlobal('chrome', {runtime: {connect}});
    const api = new API(/** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ ({}));
    const invoke = vi.spyOn(api, '_invoke').mockResolvedValue(void 0);
    clients.push(api);
    return {api, connect, dispatch, serviceWorker, connections, invoke, holdReadiness() { holdReadiness = true; }};
}

/**
 * @param {API} api
 * @param {string} mode
 * @returns {Promise<unknown>}
 */
function importNext(api, mode) {
    return mode === 'url' ?
        api.importDictionaryUrlOffscreen('https://example.test/dictionary.zip', {}, null, 'operation-A', 'page-A') :
        api.importDictionaryOffscreen(new Blob(['archive']), {}, null, 'operation-A', 'page-A');
}

test.each(['url', 'blob'])('new %s import reestablishes its owner after backend loss without replay', async (mode) => {
    const {api, connect, dispatch, connections} = fixture();
    await api.setDictionaryImportMode(true, 'page-A');
    connections[0].disconnect();
    await expect(importNext(api, mode)).resolves.toStrictEqual({title: 'Fixture'});
    expect(connect).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledOnce();
});

test.each(['url', 'blob'])('retiring a session prevents %s dispatch while owner reconnect is awaiting readiness', async (mode) => {
    const {api, connect, dispatch, connections, holdReadiness} = fixture();
    await api.setDictionaryImportMode(true, 'page-A');
    connections[0].disconnect();
    holdReadiness();
    const result = importNext(api, mode);
    const rejected = expect(result).rejects.toThrow(/session.*(inactive|retired)|disconnected/iu);
    await api.setDictionaryImportMode(false, 'page-A');
    await rejected;
    expect(connect).toHaveBeenCalledTimes(2);
    expect(dispatch).not.toHaveBeenCalled();
});

test.each(['url', 'blob'])('retiring a session prevents %s dispatch while the message transport is awaiting readiness', async (mode) => {
    const {api, dispatch, serviceWorker, invoke: apiInvoke} = fixture();
    await api.setDictionaryImportMode(true, 'page-A');
    /** @type {PromiseWithResolvers<{active: {postMessage: typeof dispatch}}>} */
    const transport = Promise.withResolvers();
    const invoke = vi.spyOn(api, '_pmInvoke');
    serviceWorker.ready = transport.promise;
    const result = importNext(api, mode);
    const rejected = expect(result).rejects.toThrow(/session.*(inactive|retired)/iu);
    await expect.poll(() => invoke.mock.calls.length).toBe(1);
    await api.setDictionaryImportMode(false, 'page-A');
    transport.resolve({active: {postMessage: dispatch}});
    await rejected;
    expect(dispatch).not.toHaveBeenCalled();
    expect(apiInvoke).toHaveBeenCalledExactlyOnceWith('setDictionaryImportMode', {active: false, ownerId: 'page-A'});
});
