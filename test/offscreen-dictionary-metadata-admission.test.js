/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, test, vi} from 'vitest';
import {deferPromise} from '../ext/js/core/utilities.js';

/**
 * @returns {Promise<{worker: import('../ext/js/background/offscreen-dictionary-worker.js').OffscreenDictionaryWorkerHandler, postMessage: ReturnType<typeof vi.fn>}>}
 */
async function createWorker() {
    const postMessage = vi.fn();
    vi.stubGlobal('self', {addEventListener: vi.fn(), postMessage});
    const {OffscreenDictionaryWorkerHandler} = await import('../ext/js/background/offscreen-dictionary-worker.js');
    return {worker: new OffscreenDictionaryWorkerHandler(), postMessage};
}

/**
 * @param {import('../ext/js/background/offscreen-dictionary-worker.js').OffscreenDictionaryWorkerHandler} worker
 * @param {number} id
 * @param {string} action
 */
function send(worker, id, action) {
    worker._onMessage(/** @type {MessageEvent} */ (/** @type {unknown} */ ({data: {id, action, params: {}}, ports: []})));
}

/**
 * @param {import('../ext/js/background/offscreen-dictionary-worker.js').OffscreenDictionaryWorkerHandler} worker
 */
async function drain(worker) {
    await Reflect.get(worker, '_requestQueue');
    await Promise.allSettled(Reflect.get(worker, '_activeConcurrentLookupPromises'));
    await Reflect.get(worker, '_requestQueue');
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

const cooperativeReadActions = ['getDictionaryInfoOffscreen', 'databaseGetMediaOffscreen'];

test.each(cooperativeReadActions)('%s during warmup does not make foreground lookups wait', async (action) => {
    const {worker, postMessage} = await createWorker();
    const warm = deferPromise();
    const invoke = vi.spyOn(worker, '_invokeAction').mockImplementation(async (action) => {
        if (action === 'warmTermLookupCachesOffscreen') { await warm.promise; }
        return action;
    });
    send(worker, 1, 'warmTermLookupCachesOffscreen');
    send(worker, 2, action);
    send(worker, 3, 'findTermsStructuredOffscreen');
    try {
        await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({id: 3, result: 'findTermsStructuredOffscreen'}));
        expect(postMessage).toHaveBeenCalledWith({id: 2, result: action});
        expect(invoke.mock.calls.map(([name]) => name)).toEqual([
            'warmTermLookupCachesOffscreen', action, 'findTermsStructuredOffscreen',
        ]);
        expect(postMessage).not.toHaveBeenCalledWith({id: 1, result: expect.anything()});
    } finally {
        warm.resolve(void 0);
        await drain(worker);
    }
});

test.each(cooperativeReadActions)('mutation waits for active %s and warmup; later reads preserve ordering', async (readAction) => {
    const {worker, postMessage} = await createWorker();
    const warm = deferPromise();
    const reader = deferPromise();
    const mutation = deferPromise();
    const invoke = vi.spyOn(worker, '_invokeAction').mockImplementation(async (action) => {
        if (action === 'warmTermLookupCachesOffscreen') { await warm.promise; }
        if (action === readAction) { await reader.promise; }
        if (action === 'databaseRefreshOffscreen') { await mutation.promise; }
        return action;
    });
    send(worker, 1, 'warmTermLookupCachesOffscreen');
    send(worker, 2, readAction);
    send(worker, 3, 'databaseRefreshOffscreen');
    send(worker, 4, readAction);
    send(worker, 5, 'findTermsStructuredOffscreen');
    try {
        expect(invoke.mock.calls.map(([action]) => action)).toEqual(['warmTermLookupCachesOffscreen', readAction]);
        warm.resolve(void 0);
        await Promise.resolve();
        expect(invoke).not.toHaveBeenCalledWith('databaseRefreshOffscreen', expect.anything(), expect.anything());
        reader.resolve(void 0);
        await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('databaseRefreshOffscreen', {}, []));
        expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({id: 4}));
        expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({id: 5}));
        mutation.resolve(void 0);
        await drain(worker);
        expect(postMessage).toHaveBeenCalledWith({id: 4, result: readAction});
        expect(postMessage).toHaveBeenCalledWith({id: 5, result: 'findTermsStructuredOffscreen'});
    } finally {
        warm.resolve(void 0);
        reader.resolve(void 0);
        mutation.resolve(void 0);
        await drain(worker);
    }
});

test('metadata failure releases the read before the next mutation', async () => {
    const {worker, postMessage} = await createWorker();
    vi.spyOn(worker, '_invokeAction').mockImplementation(async (action) => {
        if (action === 'getDictionaryInfoOffscreen') { throw new Error('metadata unavailable'); }
        return action;
    });
    send(worker, 1, 'getDictionaryInfoOffscreen');
    send(worker, 2, 'databaseRefreshOffscreen');
    await drain(worker);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({id: 1, error: expect.objectContaining({message: 'metadata unavailable'})}));
    expect(postMessage).toHaveBeenCalledWith({id: 2, result: 'databaseRefreshOffscreen'});
    expect(Reflect.get(worker, '_activeConcurrentLookupPromises').size).toBe(0);
});

test.each(cooperativeReadActions)('%s is rejected during queued and active import ownership', async (action) => {
    const {worker, postMessage} = await createWorker();
    const invoke = vi.spyOn(worker, '_invokeAction');
    Reflect.set(worker, '_queuedImportRequestCount', 1);
    send(worker, 1, action);
    Reflect.set(worker, '_queuedImportRequestCount', 0);
    Reflect.set(worker, '_activeImportAbortController', new AbortController());
    send(worker, 2, action);
    await drain(worker);
    expect(invoke).not.toHaveBeenCalled();
    for (const id of [1, 2]) {
        expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({id, error: expect.objectContaining({data: {action, code: 'DICTIONARY_IMPORT_IN_PROGRESS'}})}));
    }
});
