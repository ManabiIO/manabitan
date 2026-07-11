/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';

describe('DictionaryDatabase import cleanup', () => {
    test('does not claim ownership of an existing transaction for bulk import', async () => {
        const database = new DictionaryDatabase();
        const db = {
            exec: vi.fn(() => {
                throw new Error('cannot start a transaction within a transaction');
            }),
        };

        await expect(Reflect.get(database, '_beginImmediateTransaction').call(database, db, false))
            .rejects.toThrow('cannot start a transaction within a transaction');
        await expect(Reflect.get(database, '_beginImmediateTransaction').call(database, db, true))
            .resolves.toBeUndefined();
    });

    test('unwinds the first OPFS store when the second store fails to start', async () => {
        const database = new DictionaryDatabase();
        const exec = vi.fn();
        const termContentEndImportSession = vi.fn().mockResolvedValue();
        const termRecordEndImportSession = vi.fn().mockResolvedValue();
        Reflect.set(database, '_db', {exec});
        Reflect.set(database, '_termContentStore', {
            beginImportSession: vi.fn().mockResolvedValue(),
            endImportSession: termContentEndImportSession,
        });
        Reflect.set(database, '_termRecordStore', {
            beginImportSession: vi.fn().mockRejectedValue(new Error('term record setup failed')),
            endImportSession: termRecordEndImportSession,
        });
        Reflect.set(database, '_applyRuntimePragmas', vi.fn());

        await expect(database.startBulkImport()).rejects.toThrow('term record setup failed');

        expect(termContentEndImportSession).toHaveBeenCalledOnce();
        expect(termRecordEndImportSession).toHaveBeenCalledOnce();
        expect(Reflect.get(database, '_bulkImportDepth')).toBe(0);
        expect(Reflect.get(database, '_deferTermsVirtualTableSync')).toBe(false);
    });

    test('finalizes both OPFS stores after commit and rollback failures', async () => {
        const database = new DictionaryDatabase();
        const exec = vi.fn((sql) => {
            if (sql === 'COMMIT') { throw new Error('commit failed'); }
            if (sql === 'ROLLBACK') { throw new Error('rollback failed'); }
        });
        const termContentEndImportSession = vi.fn().mockRejectedValue(new Error('term content cleanup failed'));
        const termRecordEndImportSession = vi.fn().mockResolvedValue();
        Reflect.set(database, '_db', {exec});
        Reflect.set(database, '_bulkImportDepth', 1);
        Reflect.set(database, '_bulkImportTransactionOpen', true);
        Reflect.set(database, '_termContentStore', {endImportSession: termContentEndImportSession});
        Reflect.set(database, '_termRecordStore', {endImportSession: termRecordEndImportSession});

        await expect(database.finishBulkImport()).rejects.toThrow('Dictionary import finalization and cleanup failed');

        expect(exec).toHaveBeenCalledWith('COMMIT');
        expect(exec).toHaveBeenCalledWith('ROLLBACK');
        expect(termContentEndImportSession).toHaveBeenCalledOnce();
        expect(termRecordEndImportSession).toHaveBeenCalledOnce();
        expect(Reflect.get(database, '_bulkImportTransactionOpen')).toBe(false);
    });

    test('restores lookup state and runtime pragmas after finalization failure', async () => {
        const database = new DictionaryDatabase();
        const exec = vi.fn((sql) => {
            if (sql === 'COMMIT') { throw new Error('commit failed'); }
            if (sql === 'ROLLBACK') { throw new Error('rollback failed'); }
            if (sql.includes('idx_dictionaries_title')) { throw new Error('one index failed'); }
        });
        const applyRuntimePragmas = vi.fn();
        Reflect.set(database, '_db', {exec});
        Reflect.set(database, '_bulkImportDepth', 1);
        Reflect.set(database, '_bulkImportTransactionOpen', true);
        Reflect.set(database, '_deferTermsVirtualTableSync', true);
        Reflect.set(database, '_enableSqliteSecondaryIndexes', true);
        Reflect.set(database, '_termContentStore', {endImportSession: vi.fn().mockResolvedValue()});
        Reflect.set(database, '_termRecordStore', {endImportSession: vi.fn().mockResolvedValue()});
        Reflect.set(database, '_applyRuntimePragmas', applyRuntimePragmas);

        await expect(database.finishBulkImport()).rejects.toThrow('Dictionary import finalization and cleanup failed');

        expect(exec.mock.calls.filter(([sql]) => String(sql).startsWith('CREATE INDEX'))).toHaveLength(8);
        expect(applyRuntimePragmas).toHaveBeenCalledOnce();
        expect(Reflect.get(database, '_deferTermsVirtualTableSync')).toBe(false);
    });
});
