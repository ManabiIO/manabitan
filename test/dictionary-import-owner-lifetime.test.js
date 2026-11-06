/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, test, vi} from 'vitest';
import {API} from '../ext/js/comm/api.js';
import {Backend} from '../ext/js/background/backend.js';

/** @returns {{addListener: (callback: (...args: unknown[]) => void) => void, removeListener: (callback: (...args: unknown[]) => void) => void, emit: (...args: unknown[]) => void}} */
function browserEvent() {
    /** @type {Set<(...args: unknown[]) => void>} */
    const listeners = new Set();
    return {
        addListener(callback) { listeners.add(callback); },
        removeListener(callback) { listeners.delete(callback); },
        emit(...args) { for (const callback of listeners) { callback(...args); } },
    };
}

/** @type {API[]} */
const clients = [];
afterEach(() => {
    for (const client of clients.splice(0)) { client.shutdownRuntimeConnections(); }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

function fixture() {
    const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
    const cancel = vi.fn(async () => {});
    const refresh = vi.fn(async () => {});
    const notifications = vi.fn();
    Object.assign(backend, {
        _isPrepared: true,
        _prepareCompletePromise: Promise.resolve(),
        _setDictionaryImportModePromise: null,
        _dictionaryImportModeActive: false,
        _dictionaryImportOwners: new Set(),
        _ownedDictionaryImports: new Map(),
        _dictionaryImportOwnerConnections: new Map(),
        _orphanedDictionaryImportOwners: new Set(),
        _offscreen: {sendMessagePromise: cancel},
        _localDictionaryRuntime: null,
        _pendingDatabaseUpdatedNotifications: [],
        _deferredDictionaryRefreshDuringImport: false,
        _dictionaryDatabasePreparePromise: null,
        _translator: {clearDatabaseCaches: vi.fn()},
        _ensureDictionaryDatabaseReady: vi.fn(async () => {}),
        _refreshDictionaryDatabaseAfterUpdate: refresh,
        _clearDictionaryRefreshRetry: vi.fn(),
        _sendApplicationDatabaseUpdated: notifications,
    });
    const connect = vi.fn((/** @type {{name: string}} */ {name}) => {
        const onClientMessage = browserEvent();
        const onServerMessage = browserEvent();
        const onClientDisconnect = browserEvent();
        const onServerDisconnect = browserEvent();
        let disconnected = false;
        const disconnectClient = () => {
            if (disconnected) { return; }
            disconnected = true;
            onServerDisconnect.emit();
        };
        const disconnectServer = () => {
            if (disconnected) { return; }
            disconnected = true;
            onClientDisconnect.emit();
        };
        const client = {name, onMessage: onClientMessage, onDisconnect: onClientDisconnect, disconnect: disconnectClient, postMessage: onServerMessage.emit};
        const server = {name, onMessage: onServerMessage, onDisconnect: onServerDisconnect, disconnect: disconnectServer, postMessage: onClientMessage.emit};
        queueMicrotask(() => { backend._onDictionaryImportOwnerConnect(/** @type {chrome.runtime.Port} */ (/** @type {unknown} */ (server))); });
        return client;
    });
    vi.stubGlobal('chrome', {runtime: {connect}});
    const client = () => {
        const api = new API(/** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ ({}));
        vi.spyOn(api, '_invoke').mockImplementation(async (_action, params) => {
            const data = /** @type {{active: boolean, ownerId: string}} */ (/** @type {unknown} */ (params));
            await backend._setDictionaryImportMode(data.active, data.ownerId);
        });
        clients.push(api);
        return api;
    };
    return {backend, client, connect, cancel, refresh, notifications};
}

test('a browser connection acknowledges ownership and ordinary release closes it', async () => {
    const {backend, client, connect, cancel, refresh} = fixture();
    const api = client();
    await Promise.all([api.setDictionaryImportMode(true, 'page-A'), api.setDictionaryImportMode(true, 'page-A')]);
    expect(connect).toHaveBeenCalledOnce();
    expect(backend._dictionaryImportOwners.has('page-A')).toBe(true);
    await api.setDictionaryImportMode(false, 'page-A');
    expect(backend._dictionaryImportOwners.size).toBe(0);
    expect(Reflect.get(backend, '_dictionaryImportOwnerConnections').size).toBe(0);
    expect(cancel).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
});

test.each([false, true])('page loss preserves admitted work then releases only the orphaned owner (other page=%s)', async (anotherPage) => {
    const {backend, client, cancel, notifications} = fixture();
    const api = client();
    const other = client();
    await api.setDictionaryImportMode(true, 'departed-page');
    if (anotherPage) { await other.setDictionaryImportMode(true, 'live-page'); }
    backend._registerDictionaryImportOwner('operation-A', 'departed-page');
    const operation = backend._ownedDictionaryImports.get('operation-A');
    if (operation) { operation.runtimeAdmissionAttempted = true; }
    const observer = new MessageChannel();
    const relay = backend._superviseOwnedDictionaryImport('operation-A', observer.port2);
    try {
        backend._settleDictionaryImportOwnership('operation-A', 'departed-page');
        api.shutdownRuntimeConnections();
        expect(operation?.cancelled).toBe(false);
        expect(backend._dictionaryImportOwners.has('departed-page')).toBe(true);
        expect(cancel).not.toHaveBeenCalled();
        relay.port.postMessage({type: 'complete', result: {result: {title: 'Fixture'}, errors: []}});
        await expect.poll(() => backend._dictionaryImportOwners.has('departed-page')).toBe(false);
        expect(backend._ownedDictionaryImports.size).toBe(0);
        expect(cancel).not.toHaveBeenCalled();
        if (anotherPage) {
            expect(backend._dictionaryImportOwners.has('live-page')).toBe(true);
            expect(notifications).not.toHaveBeenCalled();
            await other.setDictionaryImportMode(false, 'live-page');
        }
        await expect.poll(() => notifications.mock.calls.length).toBe(1);
        expect(backend._dictionaryImportModeActive).toBe(false);
        expect(Reflect.get(backend, '_orphanedDictionaryImportOwners').size).toBe(0);
    } finally {
        relay.close();
        observer.port1.close();
        observer.port2.close();
    }
});

test('disconnect while activation is awaiting a cache clear cannot leave a late owner active', async () => {
    const {backend, client, cancel} = fixture();
    /** @type {PromiseWithResolvers<void>} */
    const entered = Promise.withResolvers();
    /** @type {PromiseWithResolvers<void>} */
    const release = Promise.withResolvers();
    Reflect.set(backend, '_translator', {clearDatabaseCaches: async () => {
        entered.resolve();
        await release.promise;
    }});
    const api = client();
    const open = api.setDictionaryImportMode(true, 'page-A');
    const rejected = expect(open).rejects.toThrow(/disconnected/iu);
    await entered.promise;
    api.shutdownRuntimeConnections();
    await rejected;
    release.resolve();
    await expect.poll(() => backend._dictionaryImportOwners.size).toBe(0);
    await expect.poll(() => backend._dictionaryImportModeActive).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
});


test('failed activation releases its browser connection and permits an independent session', async () => {
    const {backend, client} = fixture();
    const clear = vi.fn().mockRejectedValueOnce(new Error('injected cache-clear failure')).mockResolvedValue(void 0);
    Reflect.set(backend, '_translator', {clearDatabaseCaches: clear});
    const api = client();
    await expect(api.setDictionaryImportMode(true, 'failed-page')).rejects.toThrow('injected cache-clear failure');
    await expect.poll(() => backend._dictionaryImportOwners.size).toBe(0);
    expect(Reflect.get(backend, '_dictionaryImportOwnerConnections').size).toBe(0);
    await api.setDictionaryImportMode(true, 'healthy-page');
    expect(backend._dictionaryImportOwners.has('healthy-page')).toBe(true);
    await api.setDictionaryImportMode(false, 'healthy-page');
});

test('page loss aborts an unadmitted download without dispatching mutation cancellation', async () => {
    const {backend, client, cancel} = fixture();
    const api = client();
    await api.setDictionaryImportMode(true, 'page-A');
    backend._registerDictionaryImportOwner('download-A', 'page-A');
    const operation = backend._ownedDictionaryImports.get('download-A');
    const download = new AbortController();
    if (operation) { operation.downloadAbortController = download; }
    api.shutdownRuntimeConnections();
    expect(download.signal.aborted).toBe(true);
    expect(operation?.cancelled).toBe(true);
    backend._settleDictionaryImportOwnership('download-A', 'page-A', true);
    await expect.poll(() => backend._dictionaryImportOwners.size).toBe(0);
    expect(cancel).not.toHaveBeenCalled();
});

test('a duplicate owner connection cannot disconnect the original live session', async () => {
    const {backend, client} = fixture();
    const original = client();
    const duplicate = client();
    await original.setDictionaryImportMode(true, 'same-owner');
    await expect(duplicate.setDictionaryImportMode(true, 'same-owner')).rejects.toThrow(/disconnected/iu);
    expect(backend._dictionaryImportOwners.has('same-owner')).toBe(true);
    expect(Reflect.get(backend, '_dictionaryImportOwnerConnections').size).toBe(1);
    await original.setDictionaryImportMode(false, 'same-owner');
});


test('publication is still announced if the page dies after completion but before UI finalization', async () => {
    const {backend, client, notifications} = fixture();
    const api = client();
    await api.setDictionaryImportMode(true, 'page-A');
    backend._registerDictionaryImportOwner('operation-A', 'page-A');
    const operation = backend._ownedDictionaryImports.get('operation-A');
    if (operation) { operation.runtimeAdmissionAttempted = true; }
    backend._settleDictionaryImportOwnership('operation-A', 'page-A');
    const observer = new MessageChannel();
    const relay = backend._superviseOwnedDictionaryImport('operation-A', observer.port2);
    try {
        relay.port.postMessage({type: 'complete', result: {result: {title: 'Fixture'}, outcome: {status: 'published'}, errors: []}});
        await expect.poll(() => backend._ownedDictionaryImports.size).toBe(0);
        expect(notifications).not.toHaveBeenCalled();
        api.shutdownRuntimeConnections();
        await expect.poll(() => notifications.mock.calls.length).toBe(1);
        expect(notifications).toHaveBeenCalledExactlyOnceWith('dictionary', 'import');
    } finally {
        relay.close();
        observer.port1.close();
        observer.port2.close();
    }
});


test.each([false, true])('lost terminal delivery reconciles a published receipt without replay (page departed=%s)', async (departed) => {
    const {backend, client, cancel, notifications} = fixture();
    const api = client();
    await api.setDictionaryImportMode(true, 'page-A');
    backend._registerDictionaryImportOwner('operation-A', 'page-A');
    const operation = backend._ownedDictionaryImports.get('operation-A');
    if (operation) { operation.runtimeAdmissionAttempted = true; }
    backend._settleDictionaryImportOwnership('operation-A', 'page-A');
    cancel.mockResolvedValue(/** @type {never} */ ({
        operationId: 'operation-A',
        workerGeneration: 'worker-A',
        state: 'completed',
        published: true,
        result: {result: {title: 'Fixture'}, errors: [], outcome: {status: 'published'}},
    }));
    const observer = new MessageChannel();
    const relay = backend._superviseOwnedDictionaryImport('operation-A', observer.port2);
    try {
        if (departed) { api.shutdownRuntimeConnections(); }
        relay.port.postMessage({type: 'error', error: {name: 'DictionaryImportTransportError', message: 'lost completion'}});
        await expect.poll(() => backend._ownedDictionaryImports.size).toBe(0);
        expect(cancel).toHaveBeenCalledExactlyOnceWith({action: 'cancelDictionaryImportOffscreen', params: {operationId: 'operation-A', workerGeneration: void 0, lookupOnly: true}});
        if (!departed) {
            expect(backend._dictionaryImportOwners.has('page-A')).toBe(true);
            api.shutdownRuntimeConnections();
        }
        await expect.poll(() => notifications.mock.calls.length).toBe(1);
        expect(notifications).toHaveBeenCalledExactlyOnceWith('dictionary', 'import');
        expect(backend._dictionaryImportOwners.size).toBe(0);
    } finally {
        relay.close();
        observer.port1.close();
        observer.port2.close();
    }
});

test.each(['completed', 'failed', 'cancelled'])('authoritative status settles owned operation without a frontend terminal (%s)', async (state) => {
    const {backend, client, cancel, notifications} = fixture();
    const api = client();
    await api.setDictionaryImportMode(true, 'page-A');
    backend._registerDictionaryImportOwner('operation-A', 'page-A');
    const operation = backend._ownedDictionaryImports.get('operation-A');
    if (operation) { operation.runtimeAdmissionAttempted = true; }
    backend._settleDictionaryImportOwnership('operation-A', 'page-A');
    api.shutdownRuntimeConnections();
    cancel.mockResolvedValue(/** @type {never} */ ({operationId: 'operation-A', workerGeneration: 'worker-A', state, published: false}));
    await backend._onApiGetDictionaryImportOperationStatus({operationId: 'operation-A'}, {});
    await expect.poll(() => backend._dictionaryImportOwners.size).toBe(0);
    expect(backend._ownedDictionaryImports.size).toBe(0);
    expect(notifications).not.toHaveBeenCalled();
});

test.each(['unknown', 'queued', 'running', 'foreign-operation'])('nonterminal or mismatched receipt retains ownership (%s)', async (state) => {
    const {backend, client, cancel} = fixture();
    const api = client();
    await api.setDictionaryImportMode(true, 'page-A');
    backend._registerDictionaryImportOwner('operation-A', 'page-A');
    const operation = backend._ownedDictionaryImports.get('operation-A');
    if (operation) { operation.runtimeAdmissionAttempted = true; }
    backend._settleDictionaryImportOwnership('operation-A', 'page-A');
    api.shutdownRuntimeConnections();
    cancel.mockResolvedValue(/** @type {never} */ ({
        operationId: state === 'foreign-operation' ? state : 'operation-A',
        workerGeneration: 'worker-A',
        state: state === 'foreign-operation' ? 'completed' : state,
        published: true,
    }));
    await backend._onApiGetDictionaryImportOperationStatus({operationId: 'operation-A'}, {});
    expect(backend._ownedDictionaryImports.get('operation-A')).toBe(operation);
    expect(backend._dictionaryImportOwners.has('page-A')).toBe(true);
    cancel.mockResolvedValue(void 0);
    await backend._setDictionaryImportMode(false, 'page-A');
});


test('status reconciliation forwards terminal completion to a still-connected observer', async () => {
    const {backend, client, cancel} = fixture();
    const api = client();
    await api.setDictionaryImportMode(true, 'page-A');
    backend._registerDictionaryImportOwner('operation-A', 'page-A');
    backend._settleDictionaryImportOwnership('operation-A', 'page-A');
    const observer = new MessageChannel();
    const received = new Promise((resolve) => {
        observer.port1.onmessage = (event) => { resolve(event.data); };
    });
    const relay = backend._superviseOwnedDictionaryImport('operation-A', observer.port2);
    const result = {result: {title: 'Fixture'}, errors: [], outcome: {status: 'published'}};
    cancel.mockResolvedValue(/** @type {never} */ ({operationId: 'operation-A', state: 'completed', published: true, result}));
    try {
        await backend._onApiGetDictionaryImportOperationStatus({operationId: 'operation-A'}, {});
        expect(await received).toEqual({type: 'complete', result});
        expect(backend._ownedDictionaryImports.size).toBe(0);
        await api.setDictionaryImportMode(false, 'page-A');
    } finally {
        relay.close();
        observer.port1.close();
        observer.port2.close();
    }
});

test('a delayed receipt cannot settle a replacement operation with the same ID', async () => {
    const {backend, client, cancel} = fixture();
    const api = client();
    await api.setDictionaryImportMode(true, 'page-A');
    backend._registerDictionaryImportOwner('operation-A', 'page-A');
    /** @type {PromiseWithResolvers<unknown>} */
    const deferred = Promise.withResolvers();
    cancel.mockReturnValue(/** @type {Promise<void>} */ (deferred.promise));
    const lookup = backend._onApiGetDictionaryImportOperationStatus({operationId: 'operation-A'}, {});
    backend._ownedDictionaryImports.delete('operation-A');
    backend._registerDictionaryImportOwner('operation-A', 'page-A');
    const replacement = backend._ownedDictionaryImports.get('operation-A');
    deferred.resolve({operationId: 'operation-A', state: 'completed', published: true});
    await lookup;
    expect(backend._ownedDictionaryImports.get('operation-A')).toBe(replacement);
    expect(replacement?.completed).toBe(false);
    cancel.mockResolvedValue(void 0);
    await api.setDictionaryImportMode(false, 'page-A');
});

test.each(['cancellation', 'refresh'])('a publication receipt arriving during owner release retains its notification (%s)', async (phase) => {
    const {backend, client, cancel, refresh, notifications} = fixture();
    const api = client();
    await api.setDictionaryImportMode(true, 'page-A');
    backend._registerDictionaryImportOwner('operation-A', 'page-A');
    const operation = backend._ownedDictionaryImports.get('operation-A');
    if (operation) { operation.runtimeAdmissionAttempted = true; }
    // Retain the owned operation until after the delayed receipt, including
    // the case where explicit release has already reached its final refresh.
    /** @type {PromiseWithResolvers<unknown>} */
    const receipt = Promise.withResolvers();
    /** @type {PromiseWithResolvers<void>} */
    const entered = Promise.withResolvers();
    /** @type {PromiseWithResolvers<void>} */
    const resume = Promise.withResolvers();
    cancel.mockImplementation(async (/** @type {unknown[]} */ ...args) => {
        const message = /** @type {{params: {lookupOnly?: boolean}}} */ (args[0]);
        if (message.params.lookupOnly) { return /** @type {void} */ (await receipt.promise); }
        if (phase === 'cancellation') {
            entered.resolve();
            await resume.promise;
        }
    });
    if (phase === 'refresh') {
        refresh.mockImplementation(async () => {
            entered.resolve();
            await resume.promise;
        });
    }
    const lookup = backend._onApiGetDictionaryImportOperationStatus({operationId: 'operation-A'}, {});
    const release = api.setDictionaryImportMode(false, 'page-A');
    await entered.promise;
    receipt.resolve({operationId: 'operation-A', state: 'completed', published: true, outcome: {status: 'published'}});
    resume.resolve();
    await Promise.all([lookup, release]);
    backend._settleDictionaryImportOwnership('operation-A', 'page-A');
    await expect.poll(() => notifications.mock.calls.length).toBe(1);
    expect(notifications).toHaveBeenCalledExactlyOnceWith('dictionary', 'import');
    expect(Reflect.get(backend, '_dictionaryImportOwnerPublications')?.size ?? 0).toBe(0);
    expect(backend._ownedDictionaryImports.size).toBe(0);
    expect(backend._pendingDatabaseUpdatedNotifications).toHaveLength(0);
});


test('a publication receipt racing explicit release is still announced', async () => {
    const {backend, client, cancel, notifications} = fixture();
    const api = client();
    await api.setDictionaryImportMode(true, 'page-A');
    backend._registerDictionaryImportOwner('operation-A', 'page-A');
    backend._settleDictionaryImportOwnership('operation-A', 'page-A');
    /** @type {PromiseWithResolvers<void>} */
    const cancelled = Promise.withResolvers();
    cancel.mockReturnValueOnce(cancelled.promise).mockResolvedValue(/** @type {never} */ ({
        operationId: 'operation-A', state: 'completed', published: true,
    }));
    const release = api.setDictionaryImportMode(false, 'page-A');
    await expect.poll(() => cancel.mock.calls.length).toBe(1);
    try {
        await backend._onApiGetDictionaryImportOperationStatus({operationId: 'operation-A'}, {});
    } finally {
        cancelled.resolve();
        await release;
    }
    expect(notifications).toHaveBeenCalledExactlyOnceWith('dictionary', 'import');
    expect(Reflect.get(backend, '_dictionaryImportOwnerPublications')?.size ?? 0).toBe(0);
});


test.each(['offscreen', 'local'])('lost %s handoff acknowledgement reconciles after the page departed', async (runtime) => {
    const {backend, client, cancel, notifications} = fixture();
    const api = client();
    await api.setDictionaryImportMode(true, 'page-A');
    /** @type {PromiseWithResolvers<void>} */
    const sending = Promise.withResolvers();
    /** @type {PromiseWithResolvers<void>} */
    const handoff = Promise.withResolvers();
    const sendMessageViaPort = vi.fn(async () => {
        sending.resolve();
        await handoff.promise;
    });
    const messenger = {prepare: vi.fn(async () => {}), sendMessageViaPort, sendMessagePromise: cancel};
    if (runtime === 'offscreen') {
        Reflect.set(backend, '_offscreen', messenger);
    } else {
        Reflect.set(backend, '_offscreen', null);
        Reflect.set(backend, '_localDictionaryRuntime', messenger);
    }
    cancel.mockResolvedValue(/** @type {never} */ ({operationId: 'operation-A', state: 'completed', published: true}));
    const observer = new MessageChannel();
    try {
        const forwarded = backend._onPmImportDictionaryOffscreen({operationId: 'operation-A', ownerId: 'page-A', archiveContent: new Blob(['fixture']), details: {}}, [observer.port2]);
        await sending.promise;
        api.shutdownRuntimeConnections();
        const error = new Error('handoff acknowledgement lost');
        error.name = 'DictionaryImportTransportError';
        handoff.reject(error);
        await forwarded;
        await expect.poll(() => backend._dictionaryImportOwners.size).toBe(0);
        expect(backend._ownedDictionaryImports.size).toBe(0);
        expect(sendMessageViaPort).toHaveBeenCalledOnce();
        expect(cancel).toHaveBeenCalledExactlyOnceWith({action: 'cancelDictionaryImportOffscreen', params: {operationId: 'operation-A', workerGeneration: void 0, lookupOnly: true}});
        expect(notifications).toHaveBeenCalledExactlyOnceWith('dictionary', 'import');
    } finally {
        observer.port1.close();
        observer.port2.close();
    }
});


test('transient preparation failure on owner release retains and retries a publication notification', async () => {
    vi.useFakeTimers();
    const {backend, client, refresh, notifications} = fixture();
    Reflect.set(backend, '_dictionaryRefreshRetryTimer', null);
    Reflect.set(backend, '_dictionaryRefreshRetryAttempt', 0);
    Reflect.set(backend, '_clearDictionaryRefreshRetry', Backend.prototype._clearDictionaryRefreshRetry);
    const prepare = vi.fn().mockRejectedValueOnce(new Error('temporary database open failure')).mockResolvedValue(void 0);
    Reflect.set(backend, '_ensureDictionaryDatabaseReady', prepare);
    const api = client();
    try {
        await api.setDictionaryImportMode(true, 'page-A');
        Reflect.set(backend, '_dictionaryImportOwnerPublications', new Set(['page-A']));
        await expect(api.setDictionaryImportMode(false, 'page-A')).rejects.toThrow('temporary database open failure');
        expect(notifications).not.toHaveBeenCalled();
        expect(backend._pendingDatabaseUpdatedNotifications).toEqual([{type: 'dictionary', cause: 'import'}]);
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(250);
        expect(prepare).toHaveBeenCalledTimes(2);
        expect(refresh).toHaveBeenCalledOnce();
        expect(notifications).toHaveBeenCalledExactlyOnceWith('dictionary', 'import');
        expect(backend._pendingDatabaseUpdatedNotifications).toHaveLength(0);
        expect(Reflect.get(backend, '_dictionaryRefreshRetryTimer')).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
    } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
    }
});


test.each([false, true])('an unknown durable outcome never retires its operation as completed (departed=%s)', async (departed) => {
    const {backend, client, cancel, notifications} = fixture();
    const api = client();
    await api.setDictionaryImportMode(true, 'page-A');
    backend._registerDictionaryImportOwner('operation-A', 'page-A');
    const operation = backend._ownedDictionaryImports.get('operation-A');
    if (operation) { operation.runtimeAdmissionAttempted = true; }
    backend._settleDictionaryImportOwnership('operation-A', 'page-A');
    const observer = new MessageChannel();
    const received = new Promise((resolve) => {
        observer.port1.onmessage = (event) => { resolve(event.data); };
    });
    const relay = backend._superviseOwnedDictionaryImport('operation-A', observer.port2);
    const completion = {result: null, errors: [], outcome: {status: 'unknown', warnings: ['Rollback could not be confirmed']}};
    cancel.mockResolvedValue(/** @type {never} */ ({operationId: 'operation-A', state: 'unknown', outcome: completion.outcome}));
    try {
        if (departed) { api.shutdownRuntimeConnections(); }
        relay.port.postMessage({type: 'complete', result: completion});
        expect(await received).toEqual({type: 'complete', result: completion});
        expect(operation?.completed).toBe(false);
        expect(backend._ownedDictionaryImports.get('operation-A')).toBe(operation);
        expect(backend._dictionaryImportOwners.has('page-A')).toBe(true);
        expect(notifications).not.toHaveBeenCalled();
    } finally {
        relay.close();
        observer.port1.close();
        observer.port2.close();
        await backend._setDictionaryImportMode(false, 'page-A');
    }
});


test.each(['offscreen', 'local'])('lost %s handoff acknowledgement cannot discard a later publication after page loss', async (runtime) => {
    const {backend, client, cancel, notifications} = fixture();
    const api = client();
    await api.setDictionaryImportMode(true, 'page-A');
    /** @type {PromiseWithResolvers<void>} */
    const entered = Promise.withResolvers();
    /** @type {PromiseWithResolvers<void>} */
    const acknowledge = Promise.withResolvers();
    /** @type {MessagePort|null} */
    let workerPort = null;
    const sendMessageViaPort = vi.fn(async (/** @type {unknown} */ _message, /** @type {MessagePort[]} */ ports) => {
        workerPort = structuredClone(ports[0], {transfer: [ports[0]]});
        entered.resolve();
        await acknowledge.promise;
    });
    const messenger = {prepare: vi.fn(async () => {}), sendMessageViaPort, sendMessagePromise: cancel};
    Reflect.set(backend, runtime === 'offscreen' ? '_offscreen' : '_localDictionaryRuntime', messenger);
    if (runtime === 'local') { Reflect.set(backend, '_offscreen', null); }
    cancel.mockResolvedValue(/** @type {never} */ ({operationId: 'operation-A', workerGeneration: 'worker-A', state: 'running'}));
    const observer = new MessageChannel();
    try {
        const forwarded = backend._onPmImportDictionaryOffscreen({operationId: 'operation-A', ownerId: 'page-A', archiveContent: new Blob(['fixture']), details: {}}, [observer.port2]);
        await entered.promise;
        api.shutdownRuntimeConnections();
        const error = new Error('lost handoff acknowledgement');
        error.name = 'OffscreenControlTransportError';
        acknowledge.reject(error);
        await forwarded;
        expect(backend._ownedDictionaryImports.size).toBe(1);
        expect(backend._dictionaryImportOwners.has('page-A')).toBe(true);
        /** @type {MessagePort|null} */ (workerPort)?.postMessage({type: 'complete', result: {result: {title: 'Fixture'}, errors: [], outcome: {status: 'published'}}});
        await expect.poll(() => backend._dictionaryImportOwners.size).toBe(0);
        expect(backend._ownedDictionaryImports.size).toBe(0);
        expect(notifications).toHaveBeenCalledExactlyOnceWith('dictionary', 'import');
        expect(sendMessageViaPort).toHaveBeenCalledOnce();
        expect(cancel).toHaveBeenCalledExactlyOnceWith({action: 'cancelDictionaryImportOffscreen', params: {operationId: 'operation-A', workerGeneration: void 0, lookupOnly: true}});
    } finally {
        /** @type {MessagePort|null} */ (workerPort)?.close();
        observer.port1.close();
        observer.port2.close();
        await backend._setDictionaryImportMode(false, 'page-A');
    }
});


test.each(['publication', 'explicit-release'])('a failed relay message preserves worker observation until %s', async (ending) => {
    const {backend, client, cancel, notifications} = fixture();
    const api = client();
    await api.setDictionaryImportMode(true, 'page-A');
    backend._registerDictionaryImportOwner('operation-A', 'page-A');
    const operation = backend._ownedDictionaryImports.get('operation-A');
    if (operation) { operation.runtimeAdmissionAttempted = true; }
    backend._settleDictionaryImportOwnership('operation-A', 'page-A');
    /** @type {MessagePort[]} */
    const receivers = [];
    const NativeMessageChannel = MessageChannel;
    vi.stubGlobal('MessageChannel', class extends NativeMessageChannel {
        constructor() {
            super();
            receivers.push(this.port1);
        }
    });
    const observer = new MessageChannel();
    const received = new Promise((resolve) => {
        observer.port1.onmessage = (event) => { resolve(event.data); };
    });
    const relay = backend._superviseOwnedDictionaryImport('operation-A', observer.port2);
    cancel.mockResolvedValue(/** @type {never} */ ({operationId: 'operation-A', state: 'running'}));
    try {
        api.shutdownRuntimeConnections();
        receivers[1].onmessageerror?.(new MessageEvent('messageerror'));
        expect(await received).toMatchObject({type: 'error', error: {name: 'DictionaryImportTransportError'}});
        expect(backend._dictionaryImportOwners.has('page-A')).toBe(true);
        if (ending === 'publication') {
            relay.port.postMessage({type: 'complete', result: {result: {title: 'Fixture'}, errors: [], outcome: {status: 'published'}}});
            await expect.poll(() => backend._dictionaryImportOwners.size).toBe(0);
            expect(notifications).toHaveBeenCalledExactlyOnceWith('dictionary', 'import');
        } else {
            await backend._setDictionaryImportMode(false, 'page-A');
            expect(notifications).not.toHaveBeenCalled();
        }
        expect(backend._ownedDictionaryImports.size).toBe(0);
        expect(receivers[1].onmessage).toBeNull();
        expect(receivers[1].onmessageerror).toBeNull();
    } finally {
        relay.close();
        observer.port1.close();
        observer.port2.close();
        await backend._setDictionaryImportMode(false, 'page-A');
    }
});
