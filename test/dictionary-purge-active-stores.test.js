/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import {afterEach, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {deleteOpfsDatabaseFiles, openOpfsDatabase} from '../ext/js/dictionary/sqlite-wasm.js';

vi.mock('../ext/js/dictionary/sqlite-wasm.js', async (original) => ({
    ...await original(),
    deleteOpfsDatabaseFiles: vi.fn(async () => true),
    getSqlite3: vi.fn(async () => ({})),
    openOpfsDatabase: vi.fn(),
}));

afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(deleteOpfsDatabaseFiles).mockReset().mockResolvedValue(true);
    vi.mocked(openOpfsDatabase).mockReset();
});

function createPurgeRoot() {
    let marker = false;
    const root = {
        getFileHandle: vi.fn(async (/** @type {string} */ _name, /** @type {{create?: boolean}} */ options = {}) => {
            if (options.create) { marker = true; }
            if (!marker) { throw new DOMException('Missing marker', 'NotFoundError'); }
            return {};
        }),
        removeEntry: vi.fn(async () => { marker = false; }),
    };
    return {root, get hasMarker() { return marker; }};
}

/**
 * @param {DictionaryDatabase} database
 * @param {ReturnType<typeof createPurgeRoot>['root']} root
 */
function stubPurgeRoot(database, root) {
    vi.spyOn(database, '_getDictionaryPurgeRoot').mockResolvedValue(/** @type {FileSystemDirectoryHandle} */ (/** @type {unknown} */ (root)));
}

test('purge retires real active store sessions before preparing the replacement runtime', async () => {
    const database = new DictionaryDatabase();
    const marker = createPurgeRoot();
    stubPurgeRoot(database, marker.root);
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
        expect(marker.hasMarker).toBe(false);
        expect(recordStore.getDiagnostics().importSessionActive).toBe(false);
        expect(Reflect.get(database, '_bulkImportState')).toBe('idle');
        await recordStore.beginImportSession();
        await recordStore.endImportSession();
        await expect(recordStore.prepare()).resolves.toBeUndefined();
    } finally {
        vi.restoreAllMocks();
    }
});

test('a failed purge marker creation leaves the active import and payloads alone', async () => {
    const database = new DictionaryDatabase();
    const {root} = createPurgeRoot();
    stubPurgeRoot(database, root);
    root.getFileHandle.mockRejectedValueOnce(new Error('marker creation failed'));
    database._beginBulkImportLifecycle();
    const release = vi.spyOn(database, '_releaseRuntimeConnection');
    const reset = vi.spyOn(database, '_collectPersistentStoreResetErrors');

    await expect(database.purge()).rejects.toThrow('marker creation failed');
    expect(release).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    expect(deleteOpfsDatabaseFiles).not.toHaveBeenCalled();
    expect(Reflect.get(database, '_bulkImportState')).toBe('active');
});

test('a failed SQLite wipe leaves the payloads and import journal intact', async () => {
    const database = new DictionaryDatabase();
    const marker = createPurgeRoot();
    stubPurgeRoot(database, marker.root);
    vi.mocked(deleteOpfsDatabaseFiles).mockRejectedValueOnce(new Error('SQLite wipe failed'));
    const reset = vi.spyOn(database, '_collectPersistentStoreResetErrors');
    const reopen = vi.spyOn(database, '_prepareOnce');
    const clear = vi.fn(async () => {});
    Reflect.set(database, '_importJournal', {clear});

    await expect(database.purge()).rejects.toThrow('SQLite wipe failed');
    expect(marker.hasMarker).toBe(true);
    expect(reset).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(reopen).not.toHaveBeenCalled();
});

test('startup validates storage before finishing an interrupted purge, then stops replaying it', async () => {
    const interrupted = new DictionaryDatabase();
    const marker = createPurgeRoot();
    stubPurgeRoot(interrupted, marker.root);
    const interruptedClear = vi.fn(async () => {});
    Reflect.set(interrupted, '_importJournal', {clear: interruptedClear});
    vi.spyOn(interrupted, '_collectPersistentStoreResetErrors').mockResolvedValue([new Error('payload reset interrupted')]);
    await expect(interrupted.purge()).rejects.toThrow('payload reset interrupted');
    expect(deleteOpfsDatabaseFiles).toHaveBeenCalledOnce();
    expect(interruptedClear).not.toHaveBeenCalled();
    expect(marker.hasMarker).toBe(true);

    const restarted = new DictionaryDatabase();
    stubPurgeRoot(restarted, marker.root);
    /** @type {string[]} */
    const events = [];
    vi.mocked(deleteOpfsDatabaseFiles).mockImplementation(async () => {
        events.push('wipe SQLite');
        return true;
    });
    vi.spyOn(restarted, '_collectPersistentStoreResetErrors').mockImplementation(async () => {
        events.push('reset payloads');
        return [];
    });
    Reflect.set(restarted, '_importJournal', {clear: async () => { events.push('clear import journal'); }});
    // Stop just before SQLite opens, after the restart has run purge recovery.
    const stopBeforeOpen = new Error('stop before SQLite opens');
    vi.mocked(openOpfsDatabase).mockImplementation(async () => {
        events.push('open SQLite');
        throw stopBeforeOpen;
    });
    vi.mocked(openOpfsDatabase).mockImplementationOnce(async () => {
        events.push('open SQLite');
        return /** @type {import('@sqlite.org/sqlite-wasm').Database} */ (/** @type {unknown} */ ({
            selectValue(/** @type {string} */ sql) {
                if (sql === 'PRAGMA user_version') { return 10; }
                if (sql.includes('sqlite_master')) { return 0; }
                throw new Error('Unexpected startup query: ' + sql);
            },
            close() { events.push('close SQLite'); },
        }));
    });
    await expect(restarted._openConnection()).rejects.toThrow(stopBeforeOpen.message);
    expect(events).toEqual(['open SQLite', 'close SQLite', 'wipe SQLite', 'reset payloads', 'clear import journal', 'open SQLite']);
    expect(marker.hasMarker).toBe(false);

    events.length = 0;
    await expect(restarted._openConnection()).rejects.toThrow(stopBeforeOpen.message);
    expect(events).toEqual(['open SQLite']);
});
