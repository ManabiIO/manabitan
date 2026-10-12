/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {DictionaryDatabaseProxy} from '../ext/js/background/offscreen-proxy.js';

describe('Backend lookup diagnostics ownership', () => {
    test.each(['_offscreen', '_localDictionaryRuntime'])('%s inspects only its owning runtime', async (property) => {
        const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
        const state = {ok: true, directHits: [{dictionary: 'Test Dictionary', expressionHitCount: 1}]};
        const sendMessagePromise = vi.fn().mockResolvedValue(state);
        const inspectLocal = vi.fn().mockRejectedValue(new Error('The proxy has no local database'));
        Reflect.set(backend, '_offscreen', null);
        Reflect.set(backend, '_localDictionaryRuntime', null);
        Reflect.set(backend, property, {sendMessagePromise});
        Reflect.set(backend, '_dictionaryDatabase', Object.create(DictionaryDatabaseProxy.prototype));
        Reflect.set(backend, '_debugDictionaryLookupStateLocal', inspectLocal);

        const result = await backend._debugDictionaryLookupState('暗記', ['Test Dictionary']);

        expect(result).toBe(state);
        expect(inspectLocal).not.toHaveBeenCalled();
        expect(sendMessagePromise).toHaveBeenCalledOnce();
        expect(sendMessagePromise).toHaveBeenCalledWith({
            action: 'debugDictionaryLookupStateOffscreen',
            params: {text: '暗記', dictionaryNames: ['Test Dictionary']},
        });
    });

    test('direct database inspection remains available without a runtime', async () => {
        const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
        const database = /** @type {DictionaryDatabase} */ (Object.create(DictionaryDatabase.prototype));
        const state = {ok: true, rowSample: []};
        const inspect = vi.fn().mockResolvedValue(state);
        Reflect.set(database, 'debugDictionaryLookupState', inspect);
        Reflect.set(backend, '_offscreen', null);
        Reflect.set(backend, '_localDictionaryRuntime', null);
        Reflect.set(backend, '_dictionaryDatabase', database);

        expect(await backend._debugDictionaryLookupState('暗記', ['Test Dictionary'])).toBe(state);
        expect(inspect).toHaveBeenCalledOnce();
        expect(inspect).toHaveBeenCalledWith('暗記', ['Test Dictionary']);
    });
});
