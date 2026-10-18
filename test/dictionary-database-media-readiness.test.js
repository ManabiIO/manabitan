/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';

vi.mock('../ext/js/dictionary/zstd-term-content.js', async (importOriginal) => ({
    .../** @type {typeof import('../ext/js/dictionary/zstd-term-content.js')} */(await importOriginal()),
    initializeTermContentZstd: vi.fn(async () => {}),
}));

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

test('dictionary readiness never fetches SVG/font resources or depends on renderer readiness', async () => {
    const database = new DictionaryDatabase();
    const fetch = vi.fn().mockRejectedValue(new Error('media resources unavailable'));
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('self', {constructor: {name: 'DedicatedWorkerGlobalScope'}});
    vi.spyOn(database, '_openConnection').mockImplementation(async () => {
        Reflect.set(database, '_db', {});
    });
    vi.spyOn(database, '_deleteLegacyIndexedDb').mockResolvedValue();
    vi.spyOn(database, '_refreshTermRecordStorageNameMappings').mockImplementation(() => {});
    Reflect.set(database, '_cleanupIncompleteImports', vi.fn(async () => {}));
    Reflect.set(database, '_cleanupMissingTermRecordShards', vi.fn(async () => {}));
    const renderer = vi.spyOn(Reflect.get(database, '_mediaRenderer'), 'ensurePrepared').mockRejectedValue(new Error('renderer unavailable'));

    await database.prepare();
    expect(database.isPrepared()).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(renderer).not.toHaveBeenCalled();
});

test('concurrent prepare joins startup even after the connection exists', async () => {
    const database = new DictionaryDatabase();
    /** @type {PromiseWithResolvers<void>} */
    const gate = Promise.withResolvers();
    /** @type {PromiseWithResolvers<void>} */
    const entered = Promise.withResolvers();
    vi.stubGlobal('self', {constructor: {name: 'DedicatedWorkerGlobalScope'}});
    const open = vi.spyOn(database, '_openConnection').mockImplementation(async () => {
        Reflect.set(database, '_db', {});
    });
    vi.spyOn(database, '_deleteLegacyIndexedDb').mockImplementation(async () => {
        entered.resolve();
        await gate.promise;
    });
    vi.spyOn(database, '_refreshTermRecordStorageNameMappings').mockImplementation(() => {});
    Reflect.set(database, '_cleanupIncompleteImports', vi.fn(async () => {}));
    Reflect.set(database, '_cleanupMissingTermRecordShards', vi.fn(async () => {}));
    const first = database.prepare();
    await entered.promise;
    let joined = false;
    const second = database.prepare().then(() => { joined = true; });
    try {
        await Promise.resolve();
        expect(joined).toBe(false);
    } finally {
        gate.resolve();
        await Promise.all([first, second]);
    }
    expect(open).toHaveBeenCalledOnce();
    expect(joined).toBe(true);
});
