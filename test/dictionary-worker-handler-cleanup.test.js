/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, test, vi} from 'vitest';
import {DictionaryWorkerHandler} from '../ext/js/dictionary/dictionary-worker-handler.js';

describe('DictionaryWorkerHandler transient update cleanup', () => {
    test('preserves record shards when deleting installed metadata fails', async () => {
        const handler = new DictionaryWorkerHandler();
        const title = 'JMdict [replaced update-token]';
        /** @type {((dictionaryName: string) => boolean)|undefined} */
        let shardPredicate;
        const database = {
            getDictionaryInfo: vi.fn(async () => [{title, updateSessionToken: 'update-token'}]),
            deleteDictionary: vi.fn().mockRejectedValue(new Error('database is busy')),
            cleanupTransientTermRecordShards: vi.fn(async (predicate) => {
                shardPredicate = predicate;
                return [];
            }),
        };

        await Reflect.get(handler, '_cleanupTransientReplacementTitles').call(
            handler,
            /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (database)),
            title,
        );

        expect(database.deleteDictionary).toHaveBeenCalledWith(title, 1000, expect.any(Function));
        expect(shardPredicate?.(title)).toBe(false);
    });

    test('cleans record shards after installed metadata is deleted', async () => {
        const handler = new DictionaryWorkerHandler();
        const title = 'JMdict [replaced update-token]';
        /** @type {((dictionaryName: string) => boolean)|undefined} */
        let shardPredicate;
        const database = {
            getDictionaryInfo: vi.fn(async () => [{title, updateSessionToken: 'update-token'}]),
            deleteDictionary: vi.fn().mockResolvedValue(undefined),
            cleanupTransientTermRecordShards: vi.fn(async (predicate) => {
                shardPredicate = predicate;
                return [];
            }),
        };

        await Reflect.get(handler, '_cleanupTransientReplacementTitles').call(
            handler,
            /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (database)),
            title,
        );

        expect(shardPredicate?.(title)).toBe(true);
    });
});

describe('DictionaryWorkerHandler import database cleanup', () => {
    test('preserves the import error when database close also fails', async () => {
        const handler = new DictionaryWorkerHandler();
        const importError = new Error('import failed');
        const database = {
            isPrepared: vi.fn(() => true),
            close: vi.fn().mockRejectedValue(new Error('close failed')),
        };

        await expect(Reflect.get(handler, '_closeDictionaryDatabaseAfterImport').call(
            handler,
            /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (database)),
            false,
            false,
            importError,
        )).resolves.toBeUndefined();
        expect(database.close).toHaveBeenCalledOnce();
    });

    test('reports database close failure after a successful import', async () => {
        const handler = new DictionaryWorkerHandler();
        const closeError = new Error('close failed');
        const database = {
            isPrepared: vi.fn(() => true),
            close: vi.fn().mockRejectedValue(closeError),
        };

        await expect(Reflect.get(handler, '_closeDictionaryDatabaseAfterImport').call(
            handler,
            /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (database)),
            false,
            false,
            null,
        )).rejects.toBe(closeError);
    });

    test('clears a finalized import session even when close fails', async () => {
        const handler = new DictionaryWorkerHandler();
        const closeError = new Error('close failed');
        const database = {
            isPrepared: vi.fn(() => true),
            close: vi.fn().mockRejectedValue(closeError),
        };
        Reflect.set(handler, '_importSessionDictionaryDatabase', database);

        await expect(Reflect.get(handler, '_closeDictionaryDatabaseAfterImport').call(
            handler,
            /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (database)),
            true,
            true,
            null,
        )).rejects.toBe(closeError);
        expect(Reflect.get(handler, '_importSessionDictionaryDatabase')).toBeNull();
    });

    test('closes and clears an import-session database when OPFS is unavailable', async () => {
        const handler = new DictionaryWorkerHandler();
        const database = {
            usesFallbackStorage: vi.fn(() => true),
            getOpenStorageDiagnostics: vi.fn(() => ({opfsVfsPtr: 0})),
            isPrepared: vi.fn(() => true),
            close: vi.fn().mockResolvedValue(undefined),
        };
        Reflect.set(handler, '_importSessionDictionaryDatabase', database);

        await expect(Reflect.get(handler, '_importDictionary').call(
            handler,
            {
                details: /** @type {import('dictionary-importer').ImportDetails} */ ({useImportSession: true}),
                archiveContent: new ArrayBuffer(0),
            },
            vi.fn(),
        )).rejects.toThrow(/OPFS is required/);

        expect(database.close).toHaveBeenCalledOnce();
        expect(Reflect.get(handler, '_importSessionDictionaryDatabase')).toBeNull();
    });
});
