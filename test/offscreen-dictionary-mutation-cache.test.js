/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, describe, expect, test, vi} from 'vitest';

/** @type {Array<{
 *   action: string,
 *   params: import('core').SerializableObject,
 *   method: 'deleteDictionary'|'replaceDictionaryTitle'|'purge',
 * }>} */
const mutationCases = [
    {action: 'deleteDictionaryOffscreen', params: {dictionaryTitle: 'Old'}, method: 'deleteDictionary'},
    {action: 'replaceDictionaryTitleOffscreen', params: {fromDictionaryTitle: 'Old', toDictionaryTitle: 'New'}, method: 'replaceDictionaryTitle'},
    {action: 'databasePurgeOffscreen', params: {}, method: 'purge'},
];

/**
 * @returns {Promise<{
 *   worker: import('../ext/js/background/offscreen-dictionary-worker.js').OffscreenDictionaryWorkerHandler,
 *   database: {
 *     isPrepared: ReturnType<typeof vi.fn>, prepare: ReturnType<typeof vi.fn>,
 *     deleteDictionary: ReturnType<typeof vi.fn>, replaceDictionaryTitle: ReturnType<typeof vi.fn>,
 *     purge: ReturnType<typeof vi.fn>
 *   },
 *   translator: {prepare: ReturnType<typeof vi.fn>, clearDatabaseCaches: ReturnType<typeof vi.fn>}
 * }>}
 */
async function createHarness() {
    // This module also registers its worker entry point at import time.
    vi.stubGlobal('self', {addEventListener: vi.fn(), postMessage: vi.fn()});
    const {OffscreenDictionaryWorkerHandler} = await import('../ext/js/background/offscreen-dictionary-worker.js');
    const worker = new OffscreenDictionaryWorkerHandler();
    const database = {
        isPrepared: vi.fn(() => true),
        prepare: vi.fn(async () => {}),
        deleteDictionary: vi.fn(async () => {}),
        replaceDictionaryTitle: vi.fn(async () => {}),
        purge: vi.fn(async () => true),
    };
    const translator = {
        prepare: vi.fn(),
        clearDatabaseCaches: vi.fn(),
    };
    Reflect.set(worker, '_dictionaryDatabase', database);
    Reflect.set(worker, '_translator', translator);
    await worker._invokeAction('databasePrepareOffscreen', {}, []);
    return {worker, database, translator};
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('offscreen dictionary mutation cache coherence', () => {
    test.each(mutationCases)('$action invalidates translator caches after mutation succeeds', async ({action, params, method}) => {
        const {worker, database, translator} = await createHarness();
        await worker._invokeAction(action, params, []);
        expect(database[method]).toHaveBeenCalledOnce();
        expect(translator.clearDatabaseCaches).toHaveBeenCalledOnce();
    });

    test.each(mutationCases)('$action invalidates caches even when mutation fails after partial changes', async ({action, params, method}) => {
        const {worker, database, translator} = await createHarness();
        const mutation = /** @type {ReturnType<typeof vi.fn>} */ (/** @type {unknown} */ (database[method]));
        mutation.mockRejectedValueOnce(new Error('storage mutation failed'));
        await expect(worker._invokeAction(action, params, [])).rejects.toThrow('storage mutation failed');
        expect(translator.clearDatabaseCaches).toHaveBeenCalledOnce();
    });

    test.each(mutationCases)('$action does not clear caches before the mutation settles', async ({action, params, method}) => {
        const {worker, database, translator} = await createHarness();
        /** @type {() => void} */
        let release = () => { throw new Error('Mutation did not start'); };
        const mutation = /** @type {ReturnType<typeof vi.fn>} */ (/** @type {unknown} */ (database[method]));
        mutation.mockImplementationOnce(() => new Promise((resolve) => {
            release = () => { resolve(method === 'purge'); };
        }));
        const pending = worker._invokeAction(action, params, []);
        await Promise.resolve();
        expect(mutation).toHaveBeenCalledOnce();
        expect(translator.clearDatabaseCaches).not.toHaveBeenCalled();
        release();
        await pending;
        expect(translator.clearDatabaseCaches).toHaveBeenCalledOnce();
    });
});
