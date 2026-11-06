/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, test, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
});

function fixture() {
    vi.useFakeTimers();
    const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
    const clear = vi.fn(async () => {});
    const refresh = vi.fn(async () => {});
    const notify = vi.fn();
    const purge = vi.fn(async () => true);
    Object.assign(backend, {
        _translator: {clearDatabaseCaches: clear},
        _dictionaryDatabase: {purge},
        _dictionaryMutationPromise: null,
        _dictionaryImportModeActive: false,
        _dictionaryImportOwners: new Set(),
        _ownedDictionaryImports: new Map(),
        _pendingDatabaseUpdatedNotifications: [],
        _deferredDictionaryRefreshDuringImport: false,
        _dictionaryDatabasePreparePromise: null,
        _setDictionaryImportModePromise: null,
        _dictionaryRefreshRetryTimer: null,
        _dictionaryRefreshRetryAttempt: 0,
        _ensureDictionaryDatabaseReady: vi.fn(async () => {}),
        _refreshDictionaryDatabaseAfterUpdate: refresh,
        _sendApplicationDatabaseUpdated: notify,
    });
    return {backend, clear, refresh, notify, purge};
}

test.each(['delete', 'purge', 'edit'])('failed %s cache invalidation retains its update and retries invalidation before notification', async (cause) => {
    const {backend, clear, refresh, notify} = fixture();
    clear.mockRejectedValueOnce(new Error('Cache transport unavailable'));
    await expect(backend._triggerDatabaseUpdated('dictionary', /** @type {import('backend').DatabaseUpdateCause} */ (cause))).rejects.toThrow('Cache transport unavailable');
    expect(Reflect.get(backend, '_pendingDatabaseUpdatedNotifications')).toEqual([{type: 'dictionary', cause}]);
    expect(refresh).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(clear).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledOnce();
    expect(clear.mock.invocationCallOrder[1]).toBeLessThan(refresh.mock.invocationCallOrder[0]);
    expect(notify).toHaveBeenCalledExactlyOnceWith('dictionary', cause);
    expect(Reflect.get(backend, '_pendingDatabaseUpdatedNotifications')).toEqual([]);
    expect(Reflect.get(backend, '_dictionaryRefreshRetryTimer')).toBeNull();
});

test('a durable purge is not replayed after its cache invalidation fails', async () => {
    const {backend, clear, purge, notify} = fixture();
    clear.mockRejectedValueOnce(new Error('Cache transport unavailable'));
    await expect(backend._onApiPurgeDatabase(void 0, {})).rejects.toThrow('Cache transport unavailable');
    expect(purge).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(250);
    expect(clear).toHaveBeenCalledTimes(2);
    expect(purge).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledExactlyOnceWith('dictionary', 'purge');
});

test('repeated cache invalidation failure keeps retrying without prematurely refreshing or notifying', async () => {
    const {backend, clear, refresh, notify} = fixture();
    clear.mockRejectedValueOnce(new Error('first failure')).mockRejectedValueOnce(new Error('retry failure'));
    await expect(backend._triggerDatabaseUpdated('dictionary', 'delete')).rejects.toThrow('first failure');
    await vi.advanceTimersByTimeAsync(250);
    expect(clear).toHaveBeenCalledTimes(2);
    expect(refresh).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(clear).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledExactlyOnceWith('dictionary', 'delete');
});

test('coalescing an import notification cannot erase an earlier failed delete invalidation', async () => {
    const {backend, clear, refresh, notify} = fixture();
    Reflect.set(backend, '_dictionaryImportModeActive', true);
    clear.mockRejectedValueOnce(new Error('delete clear failed')).mockRejectedValueOnce(new Error('import clear failed'));
    await expect(backend._triggerDatabaseUpdated('dictionary', 'delete')).rejects.toThrow('delete clear failed');
    await expect(backend._triggerDatabaseUpdated('dictionary', 'import')).rejects.toThrow('import clear failed');
    expect(Reflect.get(backend, '_pendingDatabaseUpdatedNotifications')).toEqual([{type: 'dictionary', cause: 'import'}]);
    expect(notify).not.toHaveBeenCalled();
    await backend._setDictionaryImportMode(false);
    expect(clear).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenCalledExactlyOnceWith({reuseActiveImportConnection: true});
    expect(notify).toHaveBeenCalledExactlyOnceWith('dictionary', 'import');
});

test('an older successful cache invalidation cannot acknowledge a newer failed invalidation', async () => {
    const {backend, clear, notify} = fixture();
    /** @type {PromiseWithResolvers<void>} */
    const older = Promise.withResolvers();
    clear.mockImplementationOnce(() => older.promise).mockRejectedValueOnce(new Error('newer clear failed'));
    const deleting = backend._triggerDatabaseUpdated('dictionary', 'delete');
    await expect(backend._triggerDatabaseUpdated('dictionary', 'purge')).rejects.toThrow('newer clear failed');
    older.resolve();
    await deleting;
    expect(notify).not.toHaveBeenCalledWith('dictionary', 'purge');
    await vi.advanceTimersByTimeAsync(250);
    expect(clear).toHaveBeenCalledTimes(3);
    expect(notify).toHaveBeenCalledWith('dictionary', 'purge');
});


test('a synchronous cache invalidation failure keeps the same retry obligation', async () => {
    const {backend, clear, notify} = fixture();
    clear.mockImplementationOnce(() => { throw new Error('Synchronous cache failure'); });
    await expect(backend._triggerDatabaseUpdated('dictionary', 'delete')).rejects.toThrow('Synchronous cache failure');
    await vi.advanceTimersByTimeAsync(250);
    expect(clear).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledExactlyOnceWith('dictionary', 'delete');
});

test('a newer failed invalidation during retry cannot be drained by the older retry success', async () => {
    const {backend, clear, notify} = fixture();
    /** @type {PromiseWithResolvers<void>} */
    const retry = Promise.withResolvers();
    clear.mockRejectedValueOnce(new Error('initial clear failed'))
        .mockImplementationOnce(() => retry.promise)
        .mockRejectedValueOnce(new Error('newer clear failed'));
    await expect(backend._triggerDatabaseUpdated('dictionary', 'delete')).rejects.toThrow('initial clear failed');
    await vi.advanceTimersByTimeAsync(250);
    expect(clear).toHaveBeenCalledTimes(2);
    const olderRetry = Reflect.get(backend, '_setDictionaryImportModePromise');
    await expect(backend._triggerDatabaseUpdated('dictionary', 'purge')).rejects.toThrow('newer clear failed');
    retry.resolve();
    await olderRetry;
    expect(notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(clear).toHaveBeenCalledTimes(4);
    expect(notify).toHaveBeenCalledExactlyOnceWith('dictionary', 'purge');
});
