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
        const termContentRollbackImportSession = vi.fn().mockResolvedValue();
        const termRecordRollbackImportSession = vi.fn().mockResolvedValue();
        Reflect.set(database, '_db', {exec});
        Reflect.set(database, '_termContentStore', {
            createImportCheckpoint: vi.fn().mockResolvedValue({segments: []}),
            beginImportSession: vi.fn().mockResolvedValue(),
            rollbackImportSession: termContentRollbackImportSession,
        });
        Reflect.set(database, '_termRecordStore', {
            createImportCheckpoint: vi.fn().mockResolvedValue({shards: []}),
            beginImportSession: vi.fn().mockRejectedValue(new Error('term record setup failed')),
            rollbackImportSession: termRecordRollbackImportSession,
        });
        Reflect.set(database, '_importJournal', {write: vi.fn().mockResolvedValue(), clear: vi.fn().mockResolvedValue()});
        Reflect.set(database, '_applyRuntimePragmas', vi.fn());

        await expect(database.startBulkImport()).rejects.toThrow('term record setup failed');

        expect(termContentRollbackImportSession).toHaveBeenCalledOnce();
        expect(termRecordRollbackImportSession).toHaveBeenCalledOnce();
        expect(Reflect.get(database, '_bulkImportDepth')).toBe(0);
        expect(Reflect.get(database, '_deferTermsVirtualTableSync')).toBe(false);
    });

    test('rolls back both OPFS stores when sealing fails before publication', async () => {
        const database = new DictionaryDatabase();
        const exec = vi.fn((sql) => {
            if (sql === 'COMMIT') { throw new Error('commit failed'); }
            if (sql === 'ROLLBACK') { throw new Error('rollback failed'); }
        });
        const termContentEndImportSession = vi.fn().mockRejectedValue(new Error('term content seal failed'));
        const termRecordEndImportSession = vi.fn().mockResolvedValue();
        const termContentRollbackImportSession = vi.fn().mockResolvedValue();
        const termRecordRollbackImportSession = vi.fn().mockResolvedValue();
        Reflect.set(database, '_db', {exec});
        Reflect.set(database, '_bulkImportDepth', 1);
        Reflect.set(database, '_bulkImportTransactionOpen', true);
        Reflect.set(database, '_bulkImportJournalRecord', {
            version: 1, sessionId: 'test', contentCheckpoint: {segments: []}, recordCheckpoint: {shards: []}, createdAt: 0,
        });
        Reflect.set(database, '_importJournal', {clear: vi.fn().mockResolvedValue()});
        Reflect.set(database, '_termContentStore', {endImportSession: termContentEndImportSession, rollbackImportSession: termContentRollbackImportSession});
        Reflect.set(database, '_termRecordStore', {endImportSession: termRecordEndImportSession, rollbackImportSession: termRecordRollbackImportSession});

        await expect(database.finishBulkImport()).rejects.toThrow('Dictionary import finalization and cleanup failed');

        expect(exec).not.toHaveBeenCalledWith('COMMIT');
        expect(exec).toHaveBeenCalledWith('ROLLBACK');
        expect(termContentEndImportSession).toHaveBeenCalledOnce();
        expect(termRecordEndImportSession).toHaveBeenCalledOnce();
        expect(termContentRollbackImportSession).toHaveBeenCalledOnce();
        expect(termRecordRollbackImportSession).toHaveBeenCalledOnce();
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

    test('seals OPFS and recreates indexes before publishing SQLite', async () => {
        const database = new DictionaryDatabase();
        const events = [];
        const exec = vi.fn((sql) => {
            if (sql === 'COMMIT') { events.push('commit'); }
            if (typeof sql === 'string' && sql.startsWith('CREATE INDEX')) { events.push('index'); }
        });
        const makeStore = (name) => ({
            endImportSession: vi.fn(async () => { events.push(`seal-${name}`); }),
            getLastEndImportSessionMetrics: vi.fn(() => null),
        });
        Reflect.set(database, '_db', {exec});
        Reflect.set(database, '_bulkImportDepth', 1);
        Reflect.set(database, '_bulkImportTransactionOpen', true);
        Reflect.set(database, '_enableSqliteSecondaryIndexes', true);
        Reflect.set(database, '_bulkImportJournalRecord', {
            version: 1, sessionId: 'publish-test', contentCheckpoint: {segments: []}, recordCheckpoint: {shards: []}, createdAt: 0,
        });
        Reflect.set(database, '_importJournal', {
            clear: vi.fn(async () => { events.push('clear-journal'); }),
        });
        Reflect.set(database, '_termContentStore', makeStore('content'));
        Reflect.set(database, '_termRecordStore', makeStore('record'));
        Reflect.set(database, '_applyRuntimePragmas', vi.fn());

        await database.finishBulkImport();

        expect(events.indexOf('seal-content')).toBeLessThan(events.indexOf('commit'));
        expect(events.indexOf('seal-record')).toBeLessThan(events.indexOf('commit'));
        expect(events.lastIndexOf('index')).toBeLessThan(events.indexOf('commit'));
        expect(events.indexOf('commit')).toBeLessThan(events.indexOf('clear-journal'));
    });

    test('rolls back an interrupted session that SQLite did not publish', async () => {
        const database = new DictionaryDatabase();
        const record = {
            version: 1, sessionId: 'interrupted', contentCheckpoint: {segments: []}, recordCheckpoint: {shards: []}, createdAt: 0,
        };
        const contentRollback = vi.fn().mockResolvedValue();
        const recordRollback = vi.fn().mockResolvedValue();
        const clear = vi.fn().mockResolvedValue();
        Reflect.set(database, '_db', {selectValue: vi.fn(() => 0), exec: vi.fn()});
        Reflect.set(database, '_importJournal', {read: vi.fn(async () => record), clear});
        Reflect.set(database, '_termContentStore', {rollbackImportSession: contentRollback});
        Reflect.set(database, '_termRecordStore', {rollbackImportSession: recordRollback});

        await Reflect.get(database, '_recoverInterruptedImportSession').call(database);

        expect(contentRollback).toHaveBeenCalledWith(record.contentCheckpoint);
        expect(recordRollback).toHaveBeenCalledWith(record.recordCheckpoint);
        expect(clear).toHaveBeenCalledOnce();
    });

    test('keeps OPFS for an interrupted session whose SQLite marker committed', async () => {
        const database = new DictionaryDatabase();
        const record = {
            version: 1, sessionId: 'published', contentCheckpoint: {segments: []}, recordCheckpoint: {shards: []}, createdAt: 0,
        };
        const contentRollback = vi.fn().mockResolvedValue();
        const recordRollback = vi.fn().mockResolvedValue();
        Reflect.set(database, '_db', {selectValue: vi.fn(() => 1), exec: vi.fn()});
        Reflect.set(database, '_importJournal', {read: vi.fn(async () => record), clear: vi.fn().mockResolvedValue()});
        Reflect.set(database, '_termContentStore', {rollbackImportSession: contentRollback});
        Reflect.set(database, '_termRecordStore', {rollbackImportSession: recordRollback});

        await Reflect.get(database, '_recoverInterruptedImportSession').call(database);

        expect(contentRollback).not.toHaveBeenCalled();
        expect(recordRollback).not.toHaveBeenCalled();
    });

    test('does not fail startup when a recovered publication marker cannot be deleted', async () => {
        const database = new DictionaryDatabase();
        const record = {
            version: 1, sessionId: 'published', contentCheckpoint: {segments: []}, recordCheckpoint: {shards: []}, createdAt: 0,
        };
        const exec = vi.fn(() => { throw new Error('database is busy'); });
        Reflect.set(database, '_db', {selectValue: vi.fn(() => 1), exec});
        Reflect.set(database, '_importJournal', {read: vi.fn(async () => record), clear: vi.fn().mockResolvedValue()});
        Reflect.set(database, '_termContentStore', {rollbackImportSession: vi.fn().mockResolvedValue()});
        Reflect.set(database, '_termRecordStore', {rollbackImportSession: vi.fn().mockResolvedValue()});

        await expect(Reflect.get(database, '_recoverInterruptedImportSession').call(database)).resolves.toBeUndefined();
        expect(exec).toHaveBeenCalledOnce();
    });

    test('does not write to SQLite during normal startup without an import journal', async () => {
        const database = new DictionaryDatabase();
        const exec = vi.fn();
        Reflect.set(database, '_db', {exec});
        Reflect.set(database, '_importJournal', {read: vi.fn(async () => null), clear: vi.fn().mockResolvedValue()});

        await Reflect.get(database, '_recoverInterruptedImportSession').call(database);

        expect(exec).not.toHaveBeenCalled();
    });
});
