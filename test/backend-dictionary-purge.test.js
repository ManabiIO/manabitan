/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';
import {DictionaryDatabaseProxy} from '../ext/js/background/offscreen-proxy.js';
import {log} from '../ext/js/core/log.js';

/**
 * @param {{secondPurgeFails?: boolean, preparationFails?: boolean, stateFails?: boolean, purgeFails?: boolean, purgeResult?: boolean}} [options]
 * @returns {{backend: Backend, sendMessagePromise: ReturnType<typeof vi.fn>, prepare: ReturnType<typeof vi.fn>, updated: ReturnType<typeof vi.fn>}}
 */
function fixture({secondPurgeFails = false, preparationFails = false, stateFails = false, purgeFails = false, purgeResult = true} = {}) {
    let purges = 0;
    const sendMessagePromise = vi.fn(async (/** @type {{action: string}} */ {action}) => {
        if (action === 'databasePurgeOffscreen') {
            ++purges;
            if (purgeFails) { throw new Error('Purge storage failed'); }
            if (secondPurgeFails && purges > 1) { throw new Error('Dictionary import is active'); }
            return purgeResult;
        }
        if (stateFails) { throw new Error('Runtime state transport failed'); }
        return {isPrepared: true, usesFallbackStorage: false, openStorageDiagnostics: {mode: 'opfs-sahpool'}};
    });
    const runtime = {sendMessagePromise, sendMessageViaPort: vi.fn(async () => {})};
    const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
    const prepare = vi.fn(async () => {
        if (preparationFails) { throw new Error('Cannot safely recover invalid dictionary import journal'); }
    });
    const updated = vi.fn(async () => {});
    Reflect.set(backend, '_dictionaryMutationPromise', null);
    Reflect.set(backend, '_offscreen', runtime);
    Reflect.set(backend, '_dictionaryDatabase', new DictionaryDatabaseProxy(/** @type {import('../ext/js/background/offscreen-proxy.js').DictionaryRuntimeMessenger} */ (/** @type {unknown} */ (runtime))));
    Reflect.set(backend, '_ensureDictionaryDatabaseReady', prepare);
    Reflect.set(backend, '_triggerDatabaseUpdated', updated);
    return {backend, sendMessagePromise, prepare, updated};
}

describe('Backend explicit dictionary purge', () => {
    test.each([false, true])('issues one purge and one update when a later purge would fail: %s', async (secondPurgeFails) => {
        const {backend, sendMessagePromise, updated} = fixture({secondPurgeFails});
        await expect(backend._onApiPurgeDatabase(void 0, {})).resolves.toBeUndefined();
        expect(sendMessagePromise.mock.calls.filter(([message]) => message.action === 'databasePurgeOffscreen')).toHaveLength(1);
        expect(updated).toHaveBeenCalledExactlyOnceWith('dictionary', 'purge');
    });

    test('allows explicit reset when the runtime database cannot reopen', async () => {
        const {backend, sendMessagePromise, prepare, updated} = fixture({preparationFails: true});
        await expect(backend._onApiPurgeDatabase(void 0, {})).resolves.toBeUndefined();
        expect(prepare).not.toHaveBeenCalled();
        expect(sendMessagePromise.mock.calls.filter(([message]) => message.action === 'databasePurgeOffscreen')).toHaveLength(1);
        expect(updated).toHaveBeenCalledOnce();
    });
});

describe('DictionaryDatabaseProxy purge acknowledgement', () => {
    test.each([false, true])('adopts the prepared database without another control request when deleted files: %s', async (purgeResult) => {
        const {backend, sendMessagePromise, updated} = fixture({stateFails: true, purgeResult});
        const database = Reflect.get(backend, '_dictionaryDatabase');
        expect(database.isPrepared()).toBe(false);
        await expect(backend._onApiPurgeDatabase(void 0, {})).resolves.toBeUndefined();
        expect(database.isPrepared()).toBe(true);
        expect(sendMessagePromise).toHaveBeenCalledExactlyOnceWith({action: 'databasePurgeOffscreen'});
        expect(updated).toHaveBeenCalledExactlyOnceWith('dictionary', 'purge');
    });

    test.each([false, true])('preserves the deleted-files result: %s', async (purgeResult) => {
        const {backend} = fixture({purgeResult});
        await expect(Reflect.get(backend, '_dictionaryDatabase').purge()).resolves.toBe(purgeResult);
    });

    test.each([false, true])('invalidates readiness after a purge fails (prepared: %s)', async (prepared) => {
        const {backend, sendMessagePromise, updated} = fixture({purgeFails: true});
        const database = Reflect.get(backend, '_dictionaryDatabase');
        if (prepared) {
            await database.prepare();
            expect(database.isPrepared()).toBe(true);
            sendMessagePromise.mockClear();
        }
        await expect(backend._onApiPurgeDatabase(void 0, {})).rejects.toThrow('Purge storage failed');
        expect(database.isPrepared()).toBe(false);
        expect(sendMessagePromise).toHaveBeenCalledExactlyOnceWith({action: 'databasePurgeOffscreen'});
        expect(updated).not.toHaveBeenCalled();
    });
});

test('a dictionary storage failure leaves backend startup and explicit reset available', async () => {
    const {backend, prepare, sendMessagePromise, updated} = fixture({preparationFails: true});
    const signalReady = vi.fn();
    const saveOptions = vi.fn();
    const options = {profiles: [{options: {
        dictionaries: [{name: 'Installed dictionary', enabled: true}],
        general: {mainDictionary: 'Installed dictionary', sortFrequencyDictionary: 'Installed dictionary'},
    }}]};
    const savedOptions = structuredClone(options);
    Object.assign(backend, {
        _prepareInternalSyncComplete: true,
        _offscreen: null,
        _requestBuilder: {prepare: vi.fn(async () => {})},
        _environment: {prepare: vi.fn(async () => {}), getInfo: () => ({browser: 'chrome'})},
        _clipboardReader: {},
        _clipboardMonitor: {on: vi.fn()},
        _optionsUtil: {prepare: vi.fn(async () => {}), load: vi.fn(async () => options), save: saveOptions},
        _getBrowserIconTitle: () => 'Manabitan',
        _updateBadge: vi.fn(),
        _isWindowBackgroundRuntime: () => false,
        _applyOptions: vi.fn(),
        _attachOmniboxListener: vi.fn(),
        _getProfileOptions: () => ({general: {showGuide: false}}),
        _sendMessageAllTabsIgnoreResponse: signalReady,
        _sendMessageIgnoreResponse: vi.fn(),
    });
    vi.stubGlobal('self', {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    vi.stubGlobal('chrome', {runtime: {}, permissions: {getAll: (/** @type {(value: object) => void} */ callback) => callback({})}});
    vi.spyOn(log, 'on').mockImplementation(() => {});
    const errorLog = vi.spyOn(log, 'error').mockImplementation(() => {});
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
        await expect(backend._prepareInternal()).resolves.toBeUndefined();
        expect(prepare).toHaveBeenCalledOnce();
        expect(signalReady).toHaveBeenCalledExactlyOnceWith({action: 'applicationBackendReady'});
        expect(errorLog).toHaveBeenCalledWith(expect.objectContaining({message: 'Cannot safely recover invalid dictionary import journal'}));
        expect(options).toEqual(savedOptions);
        expect(saveOptions).not.toHaveBeenCalled();
        expect(sendMessagePromise).not.toHaveBeenCalled();
        await expect(backend._onApiPurgeDatabase(void 0, {})).resolves.toBeUndefined();
        expect(sendMessagePromise).toHaveBeenCalledExactlyOnceWith({action: 'databasePurgeOffscreen'});
        expect(updated).toHaveBeenCalledExactlyOnceWith('dictionary', 'purge');
    } finally {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    }
});
