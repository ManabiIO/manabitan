/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, describe, expect, test, vi} from 'vitest';

const mutationCases = [
    ['deleteDictionaryOffscreen', {dictionaryTitle: 'Old'}, 'deleteDictionary'],
    ['replaceDictionaryTitleOffscreen', {fromDictionaryTitle: 'Old', toDictionaryTitle: 'New'}, 'replaceDictionaryTitle'],
    ['databasePurgeOffscreen', {}, 'purge'],
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
    test.each(mutationCases)('%s invalidates translator caches after mutation succeeds', async (action, params, method) => {
        const {worker, database, translator} = await createHarness();
        await worker._invokeAction(action, params, []);
        expect(database[method]).toHaveBeenCalledOnce();
        expect(translator.clearDatabaseCaches).toHaveBeenCalledOnce();
    });

    test.each(mutationCases)('%s invalidates caches even when mutation fails after partial changes', async (action, params, method) => {
        const {worker, database, translator} = await createHarness();
        database[method].mockRejectedValueOnce(new Error('storage mutation failed'));
        await expect(worker._invokeAction(action, params, [])).rejects.toThrow('storage mutation failed');
        expect(translator.clearDatabaseCaches).toHaveBeenCalledOnce();
    });

    test.each(mutationCases)('%s does not clear caches before the mutation settles', async (action, params, method) => {
        const {worker, database, translator} = await createHarness();
        /** @type {(() => void)|null} */
        let release = null;
        database[method].mockImplementationOnce(() => new Promise((resolve) => {
            release = () => { resolve(method === 'purge'); };
        }));
        const pending = worker._invokeAction(action, params, []);
        await Promise.resolve();
        expect(database[method]).toHaveBeenCalledOnce();
        expect(translator.clearDatabaseCaches).not.toHaveBeenCalled();
        if (release === null) { throw new Error('Mutation did not start'); }
        release();
        await pending;
        expect(translator.clearDatabaseCaches).toHaveBeenCalledOnce();
    });
});
