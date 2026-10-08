/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, test, vi} from 'vitest';
import {Offscreen} from '../ext/js/background/offscreen.js';
import {API} from '../ext/js/comm/api.js';

describe('Offscreen dictionary cache warming', () => {
    test('forwards enabled dictionary names to the dictionary worker', async () => {
        const offscreen = /** @type {Offscreen} */ (Object.create(Offscreen.prototype));
        const invokeDictionaryWorker = vi.fn().mockResolvedValue(undefined);
        Reflect.set(offscreen, '_invokeDictionaryWorker', invokeDictionaryWorker);

        await offscreen._warmTermLookupCachesHandler({dictionaryNames: ['JMdict', 'Names']});

        expect(invokeDictionaryWorker).toHaveBeenCalledOnce();
        expect(invokeDictionaryWorker).toHaveBeenCalledWith('warmTermLookupCachesOffscreen', {dictionaryNames: ['JMdict', 'Names']});
    });

    test('propagates worker failures to the caller', async () => {
        const offscreen = /** @type {Offscreen} */ (Object.create(Offscreen.prototype));
        const workerError = new Error('Cache warm failed');
        Reflect.set(offscreen, '_invokeDictionaryWorker', vi.fn().mockRejectedValue(workerError));

        await expect(offscreen._warmTermLookupCachesHandler({dictionaryNames: ['JMdict']})).rejects.toBe(workerError);
    });
});

describe('Offscreen dictionary worker invocation isolation', () => {
    test('DataCloneError rejects only the offending call, leaving the worker and other requests alive', async () => {
        const offscreen = /** @type {Offscreen} */ (Object.create(Offscreen.prototype));
        const worker = {
            postMessage: vi.fn()
                .mockImplementationOnce(() => {})
                .mockImplementationOnce(() => {
                    throw new DOMException('Function cannot be cloned', 'DataCloneError');
                }),
            terminate: vi.fn(),
        };
        Reflect.set(offscreen, '_dictionaryWorker', worker);
        Reflect.set(offscreen, '_dictionaryWorkerFatalError', null);
        Reflect.set(offscreen, '_dictionaryWorkerRequestId', 0);
        Reflect.set(offscreen, '_dictionaryWorkerResponseHandlers', new Map());

        const pending = offscreen._invokeDictionaryWorker('getDictionaryInfoOffscreen', {});
        const rejected = offscreen._invokeDictionaryWorker('getDictionaryCountsOffscreen', {callback: () => {}});

        await expect(rejected).rejects.toThrow('Function cannot be cloned');
        expect(worker.terminate).not.toHaveBeenCalled();
        expect(Reflect.get(offscreen, '_dictionaryWorkerFatalError')).toBeNull();
        expect(Reflect.get(offscreen, '_dictionaryWorkerResponseHandlers').size).toBe(1);

        offscreen._onDictionaryWorkerMessage(/** @type {any} */ ({data: {id: 1, result: ['JMdict']}}));
        await expect(pending).resolves.toStrictEqual(['JMdict']);
        expect(Reflect.get(offscreen, '_dictionaryWorkerResponseHandlers').size).toBe(0);
    });
});

describe('Dictionary archive API contract', () => {
    test('passes the archive URL to the backend command', async () => {
        const api = /** @type {API} */ (Object.create(API.prototype));
        const result = {contentBase64: 'Zm9v', fileName: 'dictionary.zip', contentType: 'application/zip'};
        const invoke = vi.fn().mockResolvedValue(result);
        Reflect.set(api, '_invoke', invoke);

        await expect(api.downloadDictionaryArchive('https://example.test/dictionary.zip')).resolves.toBe(result);
        expect(invoke).toHaveBeenCalledOnce();
        expect(invoke).toHaveBeenCalledWith('downloadDictionaryArchive', {url: 'https://example.test/dictionary.zip'});
    });
});
