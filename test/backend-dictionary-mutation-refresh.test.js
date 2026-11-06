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
    const deletion = vi.fn(async () => {});
    const replacement = vi.fn(async () => {});
    const refresh = vi.fn(async () => {});
    const clear = vi.fn(async () => {});
    const notify = vi.fn();
    Object.assign(backend, {
        _dictionaryMutationPromise: null,
        _dictionaryDatabase: {deleteDictionary: deletion, replaceDictionaryTitle: replacement},
        _ensureDictionaryDatabaseReady: vi.fn(async () => {}),
        _refreshDictionaryDatabaseAfterUpdate: refresh,
        _translator: {clearDatabaseCaches: clear},
        _dictionaryImportModeActive: false,
        _dictionaryImportOwners: new Set(),
        _ownedDictionaryImports: new Map(),
        _pendingDatabaseUpdatedNotifications: [],
        _deferredDictionaryRefreshDuringImport: false,
        _dictionaryRefreshRetryTimer: null,
        _dictionaryRefreshRetryAttempt: 0,
        _dictionaryDatabasePreparePromise: null,
        _setDictionaryImportModePromise: null,
        _sendApplicationDatabaseUpdated: notify,
    });
    /**
     * @param {'delete'|'replace'} action
     * @returns {Promise<void>}
     */
    const invoke = async (action) => (
        action === 'delete' ?
            backend._onApiDeleteDictionaryByTitle({dictionaryTitle: 'Fixture'}, {}) :
            backend._onApiReplaceDictionaryTitle({fromDictionaryTitle: 'Old', toDictionaryTitle: 'New', summary: null, replacedDictionaryTitle: null})
    );
    return {backend, deletion, replacement, refresh, clear, notify, invoke};
}

test.each(['delete', 'replace'])('committed %s keeps a failed refresh notification and retries without replay', async (value) => {
    const action = /** @type {'delete'|'replace'} */ (value);
    const cause = action === 'delete' ? 'delete' : 'edit';
    const {backend, deletion, replacement, refresh, clear, notify, invoke} = fixture();
    const mutation = action === 'delete' ? deletion : replacement;
    refresh.mockRejectedValueOnce(new Error('Connection refresh unavailable'));
    await expect(invoke(action)).resolves.toBeUndefined();
    expect(mutation).toHaveBeenCalledOnce();
    expect(Reflect.get(backend, '_pendingDatabaseUpdatedNotifications')).toEqual([{type: 'dictionary', cause}]);
    expect(Reflect.get(backend, '_dictionaryRefreshRetryTimer')).not.toBeNull();
    expect(notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(mutation).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(clear.mock.invocationCallOrder[0]).toBeLessThan(refresh.mock.invocationCallOrder[1]);
    expect(notify).toHaveBeenCalledExactlyOnceWith('dictionary', cause);
    expect(Reflect.get(backend, '_pendingDatabaseUpdatedNotifications')).toEqual([]);
    expect(Reflect.get(backend, '_dictionaryRefreshRetryTimer')).toBeNull();
});

test.each(['delete', 'replace'])('a failed %s mutation does not fabricate a committed update or refresh retry', async (value) => {
    const action = /** @type {'delete'|'replace'} */ (value);
    const {backend, deletion, replacement, refresh, clear, notify, invoke} = fixture();
    const mutation = action === 'delete' ? deletion : replacement;
    mutation.mockRejectedValueOnce(new Error('Mutation failed'));
    await expect(invoke(action)).rejects.toThrow('Mutation failed');
    expect(refresh).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(Reflect.get(backend, '_pendingDatabaseUpdatedNotifications')).toEqual([]);
    expect(Reflect.get(backend, '_dictionaryRefreshRetryTimer')).toBeNull();
});

test('repeated refresh recovery failure retains a committed delete until later success', async () => {
    const {backend, deletion, refresh, notify, invoke} = fixture();
    refresh.mockRejectedValueOnce(new Error('Initial refresh failed')).mockRejectedValueOnce(new Error('Retry failed'));
    await expect(invoke('delete')).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(250);
    expect(deletion).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled();
    expect(Reflect.get(backend, '_pendingDatabaseUpdatedNotifications')).toEqual([{type: 'dictionary', cause: 'delete'}]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(deletion).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(notify).toHaveBeenCalledExactlyOnceWith('dictionary', 'delete');
});
