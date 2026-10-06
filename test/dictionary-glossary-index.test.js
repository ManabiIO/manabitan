/* Copyright (C) 2026 Manabitan authors; SPDX-License-Identifier: GPL-3.0-or-later */
import {describe, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {deferPromise} from '../ext/js/core/utilities.js';

function fixture() {
    const database = new DictionaryDatabase();
    const exec = vi.fn();
    Reflect.set(database, '_db', {exec, selectObjects: () => []});
    vi.spyOn(database, '_ensureDirectTermIndexesLoaded').mockResolvedValue();
    const store = Reflect.get(database, '_termRecordStore');
    vi.spyOn(store, 'getDictionaryRecordCount').mockReturnValue(1);
    vi.spyOn(store, 'getDictionaryIdBatch').mockReturnValue([1]);
    vi.spyOn(database, '_getCachedStatement').mockReturnValue(
        /** @type {import('core').SafeAny} */ ({reset() {}, bind() {}, step() {}}),
    );
    return {database, exec};
}

describe('glossary index publication', () => {
    test('missing authoritative row cannot publish a complete index', async () => {
        const {database, exec} = fixture();
        vi.spyOn(database, '_fetchTermRowsByIds').mockResolvedValue(new Map());
        await expect(database.ensureGlossarySearchIndex(new Set(['Test'])))
            .rejects.toThrow('missing authoritative term');
        expect(exec.mock.calls.some(([value]) => typeof value === 'object' && value.sql.includes('INSERT OR REPLACE INTO dictionaryGlossarySearchIndex'))).toBe(false);
    });

    test('a live waiter retries when the preceding search cancels its shared build', async () => {
        const {database} = fixture();
        /** @type {import('core').DeferredPromiseDetails<void>} */
        const entered = deferPromise();
        /** @type {import('core').DeferredPromiseDetails<void>} */
        const release = deferPromise();
        let cancelled = false;
        vi.spyOn(database, '_fetchTermRowsByIds').mockImplementation(async () => {
            entered.resolve();
            await release.promise;
            return new Map([[1, /** @type {import('core').SafeAny} */ ({dictionary: 'Test', score: 1, glossary: ['cat']})]]);
        });
        const first = database.ensureGlossarySearchIndex(new Set(['Test']), undefined, () => cancelled);
        const firstSettled = first.catch((error) => error);
        await entered.promise;
        const second = database.ensureGlossarySearchIndex(new Set(['Test']));
        const secondSettled = second.then(() => null, (error) => error);
        cancelled = true;
        release.resolve();
        expect((await firstSettled).name).toBe('AbortError');
        expect(await secondSettled).toBeNull();
    });
});
