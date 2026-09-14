/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {afterEach, describe, expect, test, vi} from 'vitest';

vi.mock('../ext/js/core/diagnostics-reporter.js', () => ({
    isDevDiagnosticsBuild: false,
    reportDiagnostics: vi.fn(),
    reportDiagnosticsLazy: vi.fn(),
}));

const {Backend} = await import('../ext/js/background/backend.js');
const {OffscreenDictionaryWorkerHandler} = await import('../ext/js/background/offscreen-dictionary-worker.js');
const {OffscreenProxy} = await import('../ext/js/background/offscreen-proxy.js');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolve2, reject2) => {
        resolve = resolve2;
        reject = reject2;
    });
    return {promise, resolve, reject};
}

async function flushMicrotasks() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

describe('runtime reliability regressions', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    test('dictionary mutation admission is atomic and preserves serialization', async () => {
        const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
        Reflect.set(backend, '_dictionaryMutationPromise', null);
        const firstGate = deferred();
        const secondGate = deferred();
        const thirdGate = deferred();
        const starts = [];

        const first = Backend.prototype._runDictionaryMutation.call(backend, async () => {
            starts.push('first');
            await firstGate.promise;
        });
        await flushMicrotasks();

        const second = Backend.prototype._runDictionaryMutation.call(backend, async () => {
            starts.push('second');
            await secondGate.promise;
        });
        const third = Backend.prototype._runDictionaryMutation.call(backend, async () => {
            starts.push('third');
            await thirdGate.promise;
        });
        await flushMicrotasks();
        expect(starts).toEqual(['first']);

        firstGate.resolve();
        await flushMicrotasks();
        expect(starts).toEqual(['first', 'second']);

        secondGate.resolve();
        await flushMicrotasks();
        expect(starts).toEqual(['first', 'second', 'third']);

        thirdGate.resolve();
        await Promise.all([first, second, third]);
        expect(Reflect.get(backend, '_dictionaryMutationPromise')).toBe(null);
    });

    test('failed search-popup creation does not poison later attempts', async () => {
        const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
        Reflect.set(backend, '_searchPopupTabCreatePromise', null);
        const create = vi.fn()
            .mockRejectedValueOnce(new Error('transient window failure'))
            .mockResolvedValueOnce({tab: {id: 7}, created: true});
        Reflect.set(backend, '_getOrCreateSearchPopup', create);

        await expect(Backend.prototype._getOrCreateSearchPopupWrapper.call(backend)).rejects.toThrow('transient window failure');
        await expect(Backend.prototype._getOrCreateSearchPopupWrapper.call(backend)).resolves.toEqual({tab: {id: 7}, created: true});
        expect(create).toHaveBeenCalledTimes(2);
    });

    test('backend prepare can retry after a transient initialization failure', async () => {
        const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
        const initialReady = deferred();
        Reflect.set(backend, '_preparePromise', null);
        Reflect.set(backend, '_prepareError', false);
        Reflect.set(backend, '_isPrepared', false);
        Reflect.set(backend, '_prepareCompletePromise', initialReady.promise);
        Reflect.set(backend, '_prepareCompleteResolve', initialReady.resolve);
        Reflect.set(backend, '_prepareCompleteReject', initialReady.reject);
        Reflect.set(backend, '_updateBadge', vi.fn());
        const prepareInternal = vi.fn()
            .mockRejectedValueOnce(new Error('transient startup failure'))
            .mockResolvedValueOnce(void 0);
        Reflect.set(backend, '_prepareInternal', prepareInternal);

        await expect(Backend.prototype.prepare.call(backend)).rejects.toThrow('transient startup failure');
        await expect(Backend.prototype.prepare.call(backend)).resolves.toBeUndefined();
        expect(prepareInternal).toHaveBeenCalledTimes(2);
        expect(Reflect.get(backend, '_isPrepared')).toBe(true);
    });

    test('ordinary offscreen messages ensure the document exists before sending', async () => {
        const proxy = /** @type {OffscreenProxy} */ (Object.create(OffscreenProxy.prototype));
        const ensureOffscreenDocument = vi.fn().mockResolvedValue(void 0);
        const sendMessagePromise = vi.fn().mockResolvedValue({result: 'ok'});
        Reflect.set(proxy, '_ensureOffscreenDocument', ensureOffscreenDocument);
        Reflect.set(proxy, '_webExtension', {sendMessagePromise});

        await expect(OffscreenProxy.prototype.sendMessagePromise.call(proxy, {action: 'getDictionaryInfoOffscreen'})).resolves.toBe('ok');
        expect(ensureOffscreenDocument).toHaveBeenCalledOnce();
        expect(sendMessagePromise).toHaveBeenCalledOnce();
    });

    test('lookup queued behind an import is rejected promptly instead of waiting for the worker timeout', async () => {
        const postMessage = vi.fn();
        vi.stubGlobal('self', {postMessage});
        const handler = new OffscreenDictionaryWorkerHandler();
        const importGate = deferred();
        Reflect.set(handler, '_requestQueue', importGate.promise);
        Reflect.set(handler, '_queuedExclusiveRequestCount', 1);
        Reflect.set(handler, '_queuedImportRequestCount', 1);

        Reflect.get(handler, '_onMessage').call(handler, {
            data: {id: 99, action: 'findTermsStructuredOffscreen', params: {}},
            ports: [],
        });
        await flushMicrotasks();

        expect(postMessage).toHaveBeenCalledOnce();
        expect(postMessage.mock.calls[0][0]).toMatchObject({id: 99, error: expect.any(Object)});
        importGate.resolve();
    });
});
