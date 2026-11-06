/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, test, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';

/** @typedef {NonNullable<ReturnType<Backend['_ownedDictionaryImports']['get']>>} ImportOperation */

/** @type {MessagePort[]} */
const ports = [];
afterEach(() => {
    for (const port of ports.splice(0)) { port.close(); }
    vi.restoreAllMocks();
});

async function fixture() {
    const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
    const purge = vi.fn(async () => true);
    const notifications = vi.fn();
    const refresh = vi.fn(async () => {});
    Object.assign(backend, {
        _isPrepared: true,
        _setDictionaryImportModePromise: null,
        _dictionaryImportModeActive: false,
        _dictionaryImportOwners: new Set(),
        _ownedDictionaryImports: new Map(),
        _dictionaryImportOwnerConnections: new Map(),
        _orphanedDictionaryImportOwners: new Set(),
        _offscreen: {sendMessagePromise: async () => ({operationId: 'operation-A', state: 'unknown', outcome: {status: 'unknown'}})},
        _localDictionaryRuntime: null,
        _pendingDatabaseUpdatedNotifications: [],
        _deferredDictionaryRefreshDuringImport: false,
        _dictionaryDatabasePreparePromise: null,
        _dictionaryMutationPromise: null,
        _dictionaryDatabase: {purge},
        _translator: {clearDatabaseCaches: vi.fn(async () => {})},
        _ensureDictionaryDatabaseReady: vi.fn(async () => {}),
        _refreshDictionaryDatabaseAfterUpdate: refresh,
        _clearDictionaryRefreshRetry: vi.fn(),
        _sendApplicationDatabaseUpdated: notifications,
    });
    /** @type {Set<() => void>} */
    const disconnectListeners = new Set();
    /** @type {PromiseWithResolvers<void>} */
    const ready = Promise.withResolvers();
    const ownerPort = {
        name: JSON.stringify({name: 'dictionary-import-owner', ownerId: 'page-A'}),
        onDisconnect: {
            addListener: (/** @type {() => void} */ listener) => { disconnectListeners.add(listener); },
            removeListener: (/** @type {() => void} */ listener) => { disconnectListeners.delete(listener); },
        },
        postMessage: () => { ready.resolve(); },
        disconnect: () => {},
    };
    backend._onDictionaryImportOwnerConnect(/** @type {chrome.runtime.Port} */ (/** @type {unknown} */ (ownerPort)));
    await ready.promise;
    const depart = () => {
        for (const listener of disconnectListeners) { listener(); }
    };
    /**
     * @param {string} [operationId]
     * @returns {ImportOperation}
     */
    const register = (operationId = 'operation-A') => {
        backend._registerDictionaryImportOwner(operationId, 'page-A');
        const operation = backend._ownedDictionaryImports.get(operationId);
        if (!operation) { throw new Error('Fixture operation was not registered'); }
        operation.runtimeAdmissionAttempted = true;
        backend._settleDictionaryImportOwnership(operationId, 'page-A');
        return operation;
    };
    /**
     * @param {unknown} [message]
     * @returns {Promise<ImportOperation>}
     */
    const terminal = async (message) => {
        const operation = register();
        const channel = new MessageChannel();
        const relay = backend._superviseOwnedDictionaryImport('operation-A', channel.port2);
        ports.push(channel.port1, channel.port2, relay.port);
        const received = new Promise((resolve) => { channel.port1.onmessage = resolve; });
        relay.port.postMessage(typeof message === 'undefined' ? {type: 'complete', result: {result: null, errors: [], outcome: {status: 'unknown'}}} : message);
        await received;
        await expect.poll(() => operation.reconciliationPending).toBe(false);
        return operation;
    };
    return {backend, purge, refresh, notifications, depart, register, terminal};
}

test('successful explicit purge releases a departed owner after a terminal unknown outcome', async () => {
    const {backend, purge, refresh, notifications, depart, terminal} = await fixture();
    const operation = await terminal();
    depart();
    expect(backend._dictionaryImportModeActive).toBe(true);
    await backend._onApiPurgeDatabase(void 0, {});
    expect(purge).toHaveBeenCalledOnce();
    expect(operation.completed).toBe(false);
    expect(backend._ownedDictionaryImports.size).toBe(0);
    expect(backend._dictionaryImportOwners.size).toBe(0);
    expect(Reflect.get(backend, '_orphanedDictionaryImportOwners').size).toBe(0);
    expect(backend._dictionaryImportModeActive).toBe(false);
    expect(refresh).toHaveBeenCalled();
    expect(notifications).toHaveBeenCalledExactlyOnceWith('dictionary', 'purge');
});

test('failed purge preserves the unresolved storage owner and notification fence', async () => {
    const {backend, purge, notifications, depart, terminal} = await fixture();
    const operation = await terminal();
    depart();
    purge.mockRejectedValueOnce(new Error('OPFS reset failed'));
    await expect(backend._onApiPurgeDatabase(void 0, {})).rejects.toThrow('OPFS reset failed');
    expect(backend._ownedDictionaryImports.get('operation-A')).toBe(operation);
    expect(backend._dictionaryImportOwners.has('page-A')).toBe(true);
    expect(backend._dictionaryImportModeActive).toBe(true);
    expect(notifications).not.toHaveBeenCalled();
});

test('purge does not end a connected owner session with a terminal unknown outcome', async () => {
    const {backend, notifications, terminal} = await fixture();
    const operation = await terminal();
    await backend._onApiPurgeDatabase(void 0, {});
    expect(backend._ownedDictionaryImports.get('operation-A')).toBe(operation);
    expect(backend._dictionaryImportOwners.has('page-A')).toBe(true);
    expect(backend._dictionaryImportModeActive).toBe(true);
    expect(notifications).not.toHaveBeenCalled();
    await backend._setDictionaryImportMode(false, 'page-A');
    expect(notifications).toHaveBeenCalledExactlyOnceWith('dictionary', 'purge');
});

test('purge releases only the obsolete orphan while another page owns an import session', async () => {
    const {backend, notifications, depart, terminal} = await fixture();
    await terminal();
    await backend._setDictionaryImportMode(true, 'page-B');
    depart();
    await backend._onApiPurgeDatabase(void 0, {});
    expect(backend._ownedDictionaryImports.size).toBe(0);
    expect([...backend._dictionaryImportOwners]).toEqual(['page-B']);
    expect(backend._dictionaryImportModeActive).toBe(true);
    expect(notifications).not.toHaveBeenCalled();
    await backend._setDictionaryImportMode(false, 'page-B');
    expect(notifications).toHaveBeenCalledExactlyOnceWith('dictionary', 'purge');
});

test('a successful purge does not retire another operation whose mutation may still be live', async () => {
    const {backend, notifications, depart, register, terminal} = await fixture();
    await terminal();
    const otherOperation = register('operation-B');
    const observer = new MessageChannel();
    const relay = backend._superviseOwnedDictionaryImport('operation-B', observer.port2);
    ports.push(observer.port1, observer.port2, relay.port);
    depart();
    await backend._onApiPurgeDatabase(void 0, {});
    expect([...backend._ownedDictionaryImports.keys()]).toEqual(['operation-B']);
    expect(backend._ownedDictionaryImports.get('operation-B')).toBe(otherOperation);
    expect(otherOperation.cancelled).toBe(false);
    expect(backend._dictionaryImportOwners.has('page-A')).toBe(true);
    expect(backend._dictionaryImportModeActive).toBe(true);
    expect(notifications).not.toHaveBeenCalled();
    relay.close();
});

test('transport failure without a terminal durable outcome remains fenced after purge', async () => {
    const {backend, notifications, depart, terminal} = await fixture();
    const operation = await terminal({type: 'error', error: {name: 'DictionaryImportTransportError', message: 'Delivery failed'}});
    depart();
    await backend._onApiPurgeDatabase(void 0, {});
    expect(backend._ownedDictionaryImports.get('operation-A')).toBe(operation);
    expect(backend._dictionaryImportOwners.has('page-A')).toBe(true);
    expect(backend._dictionaryImportModeActive).toBe(true);
    expect(notifications).not.toHaveBeenCalled();
});

test('a terminal unknown outcome arriving after purge starts is not superseded by that purge', async () => {
    const {backend, purge, notifications, depart, terminal} = await fixture();
    /** @type {PromiseWithResolvers<void>} */
    const entered = Promise.withResolvers();
    /** @type {PromiseWithResolvers<void>} */
    const finish = Promise.withResolvers();
    purge.mockImplementationOnce(async () => {
        entered.resolve();
        await finish.promise;
        return true;
    });
    const purging = backend._onApiPurgeDatabase(void 0, {});
    await entered.promise;
    const operation = await terminal();
    depart();
    finish.resolve();
    await purging;
    expect(backend._ownedDictionaryImports.get('operation-A')).toBe(operation);
    expect(backend._dictionaryImportOwners.has('page-A')).toBe(true);
    expect(notifications).not.toHaveBeenCalled();
});


test('purge preserves a departed page download until its cancellation actually settles', async () => {
    const {backend, notifications, depart, terminal} = await fixture();
    await terminal();
    backend._registerDictionaryImportOwner('download-B', 'page-A');
    const download = backend._ownedDictionaryImports.get('download-B');
    if (!download) { throw new Error('Download ownership missing'); }
    download.downloadAbortController = new AbortController();
    depart();
    expect(download.downloadAbortController.signal.aborted).toBe(true);
    await backend._onApiPurgeDatabase(void 0, {});
    expect([...backend._ownedDictionaryImports.keys()]).toEqual(['download-B']);
    expect(download.settled).toBe(false);
    expect(backend._dictionaryImportOwners.has('page-A')).toBe(true);
    expect(notifications).not.toHaveBeenCalled();
    backend._settleDictionaryImportOwnership('download-B', 'page-A', true);
    await expect.poll(() => backend._dictionaryImportOwners.size).toBe(0);
    await expect.poll(() => notifications.mock.calls.length).toBe(1);
    expect(notifications).toHaveBeenCalledExactlyOnceWith('dictionary', 'purge');
});
