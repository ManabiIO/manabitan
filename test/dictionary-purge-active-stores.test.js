/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import {expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {deleteOpfsDatabaseFiles} from '../ext/js/dictionary/sqlite-wasm.js';

vi.mock('../ext/js/dictionary/sqlite-wasm.js', async (original) => ({
    ...await original(),
    deleteOpfsDatabaseFiles: vi.fn(async () => true),
}));

test('purge retires real active store sessions before preparing the replacement runtime', async () => {
    const database = new DictionaryDatabase();
    const recordStore = /** @type {import('../ext/js/dictionary/term-record-opfs-store.js').TermRecordOpfsStore} */ (Reflect.get(database, '_termRecordStore'));
    const contentStore = /** @type {import('../ext/js/dictionary/term-content-opfs-store.js').TermContentOpfsStore} */ (Reflect.get(database, '_termContentStore'));
    const clearJournal = vi.fn(async () => {});
    Reflect.set(database, '_importJournal', {clear: clearJournal});
    await contentStore.beginImportSession();
    await recordStore.beginImportSession();
    database._beginBulkImportLifecycle();
    // Only browser persistence and SQLite reopening are substituted. The
    // coordinator, both store resets, and their preparation admission are real.
    const prepare = vi.spyOn(database, '_prepareOnce').mockImplementation(async () => {
        await contentStore.prepare();
        await recordStore.prepare();
    });
    try {
        await expect(database.purge()).resolves.toBe(true);
        expect(prepare).toHaveBeenCalledExactlyOnceWith(true);
        expect(deleteOpfsDatabaseFiles).toHaveBeenCalledOnce();
        expect(clearJournal).toHaveBeenCalledOnce();
        expect(recordStore.getDiagnostics().importSessionActive).toBe(false);
        expect(Reflect.get(database, '_bulkImportState')).toBe('idle');
        await recordStore.beginImportSession();
        await recordStore.endImportSession();
        await expect(recordStore.prepare()).resolves.toBeUndefined();
    } finally {
        vi.restoreAllMocks();
    }
});
