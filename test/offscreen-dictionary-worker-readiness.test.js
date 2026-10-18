/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {afterEach, expect, test, vi} from 'vitest';
import {deferPromise} from '../ext/js/core/utilities.js';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

test.each(['none', 'database', 'translator'])('concurrent cold requests await complete preparation; first failure=%s', async (failure) => {
    const postMessage = vi.fn();
    vi.stubGlobal('self', {addEventListener: vi.fn(), postMessage});
    const {OffscreenDictionaryWorkerHandler} = await import('../ext/js/background/offscreen-dictionary-worker.js');
    const worker = new OffscreenDictionaryWorkerHandler();
    const database = new DictionaryDatabase();
    const gate = deferPromise();
    const prepare = vi.spyOn(database, 'prepare').mockImplementationOnce(async () => {
        // Production _openConnection publishes _db before stores and recovery finish.
        Reflect.set(database, '_db', {});
        try {
            await gate.promise;
        } catch (error) {
            // Production preparation failure releases the connection before rejecting.
            Reflect.set(database, '_db', null);
            throw error;
        }
    }).mockImplementation(async () => { Reflect.set(database, '_db', {}); });
    const translator = {
        prepare: vi.fn(),
        findTerms: vi.fn().mockResolvedValue({dictionaryEntries: [], originalTextLength: 0}),
    };
    if (failure === 'translator') {
        translator.prepare.mockImplementationOnce(() => { throw new Error('translator preparation failed'); });
    }
    Reflect.set(worker, '_dictionaryDatabase', database);
    Reflect.set(worker, '_translator', translator);
    /**
     * @param {number} id
     * @returns {void}
     */
    const send = (id) => worker._onMessage(/** @type {MessageEvent} */ (/** @type {unknown} */ ({
        data: {id, action: 'findTermsStructuredOffscreen', params: {mode: 'simple', text: 'word', options: {}}},
        ports: [],
    })));
    send(1);
    expect(database.isPrepared()).toBe(true);
    send(2);
    try {
        await Promise.resolve();
        await Promise.resolve();
        expect(prepare).toHaveBeenCalledOnce();
        expect(translator.prepare).not.toHaveBeenCalled();
        expect(translator.findTerms).not.toHaveBeenCalled();
        expect(postMessage).not.toHaveBeenCalled();
    } finally {
        if (failure === 'database') {
            gate.reject(new Error('store preparation failed'));
        } else {
            gate.resolve(void 0);
        }
        await Promise.allSettled(Reflect.get(worker, '_activeConcurrentLookupPromises'));
    }
    expect(Reflect.get(worker, '_prepareDatabasePromise')).toBeNull();
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(Reflect.get(worker, '_databaseReady')).toBe(failure === 'none');
    if (failure !== 'none') {
        for (const id of [1, 2]) {
            expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
                id, error: expect.objectContaining({message: failure === 'database' ? 'store preparation failed' : 'translator preparation failed'}),
            }));
        }
        expect(translator.findTerms).not.toHaveBeenCalled();
        expect(translator.prepare).toHaveBeenCalledTimes(failure === 'translator' ? 1 : 0);
        send(3);
        await Promise.allSettled(Reflect.get(worker, '_activeConcurrentLookupPromises'));
        expect(prepare).toHaveBeenCalledTimes(failure === 'database' ? 2 : 1);
        expect(translator.findTerms).toHaveBeenCalledOnce();
    } else {
        expect(translator.findTerms).toHaveBeenCalledTimes(2);
    }
    expect(translator.prepare).toHaveBeenCalledTimes(failure === 'translator' ? 2 : 1);
    expect(Reflect.get(worker, '_databaseReady')).toBe(true);
    send(4);
    await Promise.allSettled(Reflect.get(worker, '_activeConcurrentLookupPromises'));
    expect(prepare).toHaveBeenCalledTimes(failure === 'database' ? 2 : 1);
    expect(translator.prepare).toHaveBeenCalledTimes(failure === 'translator' ? 2 : 1);
    expect(postMessage).toHaveBeenCalledWith({id: 4, result: {dictionaryEntries: [], originalTextLength: 0}});
});

test.each(['resume', 'databaseRefreshOffscreen', 'translatorPrepareOffscreen'])('translator preparation failure during %s remains retryable', async (action) => {
    vi.stubGlobal('self', {addEventListener: vi.fn(), postMessage: vi.fn()});
    const {OffscreenDictionaryWorkerHandler} = await import('../ext/js/background/offscreen-dictionary-worker.js');
    const worker = new OffscreenDictionaryWorkerHandler();
    const database = new DictionaryDatabase();
    const prepare = vi.spyOn(database, 'prepare').mockImplementation(async () => { Reflect.set(database, '_db', {}); });
    const close = vi.spyOn(database, 'close').mockImplementation(async () => { Reflect.set(database, '_db', null); });
    const translator = {prepare: vi.fn(), clearDatabaseCaches: vi.fn()};
    Reflect.set(worker, '_dictionaryDatabase', database);
    Reflect.set(worker, '_translator', translator);
    await worker._invokeAction('databasePrepareOffscreen', {}, []);
    if (action === 'resume') {
        await worker._invokeAction('databaseSetSuspendedOffscreen', {suspended: true}, []);
        expect(Reflect.get(worker, '_databaseReady')).toBe(false);
        await expect(worker._ensureDatabasePrepared()).rejects.toThrow('suspended');
    }
    translator.prepare.mockImplementationOnce(() => { throw new Error('translator preparation failed'); });
    await expect(worker._invokeAction(action === 'resume' ? 'databaseSetSuspendedOffscreen' : action, {}, [])).rejects.toThrow('translator preparation failed');
    expect(database.isPrepared()).toBe(true);
    expect(Reflect.get(worker, '_databaseReady')).toBe(false);
    const databasePrepareCount = prepare.mock.calls.length;
    await worker._ensureDatabasePrepared();
    expect(Reflect.get(worker, '_databaseReady')).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(databasePrepareCount);
    expect(translator.prepare).toHaveBeenCalledTimes(3);
    await worker._ensureDatabasePrepared();
    expect(translator.prepare).toHaveBeenCalledTimes(3);
    expect(close).toHaveBeenCalledTimes(action === 'translatorPrepareOffscreen' ? 0 : 1);
});
