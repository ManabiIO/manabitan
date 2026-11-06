/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';
import {DictionaryDatabaseProxy} from '../ext/js/background/offscreen-proxy.js';

/**
 * @param {{secondPurgeFails?: boolean, preparationFails?: boolean}} [options]
 * @returns {{backend: Backend, sendMessagePromise: ReturnType<typeof vi.fn>, prepare: ReturnType<typeof vi.fn>, updated: ReturnType<typeof vi.fn>}}
 */
function fixture({secondPurgeFails = false, preparationFails = false} = {}) {
    let purges = 0;
    const sendMessagePromise = vi.fn(async (/** @type {{action: string}} */ {action}) => {
        if (action === 'databasePurgeOffscreen') {
            ++purges;
            if (secondPurgeFails && purges > 1) { throw new Error('Dictionary import is active'); }
            return true;
        }
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
