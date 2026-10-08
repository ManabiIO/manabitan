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
