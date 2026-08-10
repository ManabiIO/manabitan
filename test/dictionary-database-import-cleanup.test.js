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

    test('reserves bulk-import ownership before awaiting storage checkpoints', async () => {
        const database = new DictionaryDatabase();
        let releaseCheckpoint;
        const checkpointGate = new Promise((resolve) => {
            releaseCheckpoint = resolve;
        });
        const db = {exec: vi.fn(), selectValue: vi.fn(() => 0)};
        Reflect.set(database, '_db', db);
        Reflect.set(database, '_termContentStore', {
            createImportCheckpoint: vi.fn(async () => {
                await checkpointGate;
                return {segments: []};
            }),
            beginImportSession: vi.fn().mockResolvedValue(),
            rollbackImportSession: vi.fn().mockResolvedValue(),
        });
        Reflect.set(database, '_termRecordStore', {
            createImportCheckpoint: vi.fn().mockResolvedValue({shards: []}),
            beginImportSession: vi.fn().mockResolvedValue(),
            rollbackImportSession: vi.fn().mockResolvedValue(),
        });
        Reflect.set(database, '_termContentBlockStore', {
            beginImportSession: vi.fn(() => ({close: vi.fn()})),
            clearCache: vi.fn(),
        });
        Reflect.set(database, '_importJournal', {
            write: vi.fn().mockResolvedValue(),
            clear: vi.fn().mockResolvedValue(),
        });

        const firstStart = database.startBulkImport();
        await expect(database.startBulkImport()).rejects.toThrow('A dictionary bulk import is already active');
        releaseCheckpoint();
        await expect(firstStart).resolves.toBeUndefined();
        expect(Reflect.get(database, '_bulkImportDepth')).toBe(1);
    });

    test('preserves recovery ownership when failed import setup cannot clear its journal', async () => {
        const database = new DictionaryDatabase();
        Reflect.set(database, '_db', {exec: vi.fn(), selectValue: vi.fn(() => 0)});
        Reflect.set(database, '_termContentStore', {
            createImportCheckpoint: vi.fn().mockResolvedValue({segments: []}),
            beginImportSession: vi.fn().mockRejectedValue(new Error('content setup failed')),
            rollbackImportSession: vi.fn().mockResolvedValue(),
        });
        Reflect.set(database, '_termRecordStore', {
            createImportCheckpoint: vi.fn().mockResolvedValue({shards: []}),
            beginImportSession: vi.fn().mockResolvedValue(),
            rollbackImportSession: vi.fn().mockResolvedValue(),
        });
        Reflect.set(database, '_importJournal', {
            write: vi.fn().mockResolvedValue(),
            clear: vi.fn().mockRejectedValue(new Error('journal clear failed')),
        });
        Reflect.set(database, '_applyRuntimePragmas', vi.fn());

        await expect(database.startBulkImport())
            .rejects.toThrow('Failed to start and clean up dictionary import storage');
        expect(Reflect.get(database, '_bulkImportDepth')).toBe(0);
        expect(Reflect.get(database, '_bulkImportJournalRecord')).not.toBeNull();
        expect(Reflect.get(database, '_importJournalRecoveryPending')).toBe(true);
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
        const clear = vi.fn(async () => {});
        Reflect.set(database, '_db', {selectValue: vi.fn(() => 0), exec: vi.fn()});
        Reflect.set(database, '_importJournal', {read: vi.fn(async () => record), clear});
        Reflect.set(database, '_termContentStore', {rollbackImportSession: contentRollback});
        Reflect.set(database, '_termRecordStore', {rollbackImportSession: recordRollback});

        await Reflect.get(database, '_recoverInterruptedImportSession').call(database);

        expect(contentRollback).toHaveBeenCalledWith(record.contentCheckpoint);
        expect(recordRollback).toHaveBeenCalledWith(record.recordCheckpoint);
        expect(clear).toHaveBeenCalledOnce();
    });

    test('keeps the recovery journal when an interrupted-session rollback fails', async () => {
        const database = new DictionaryDatabase();
        const record = {
            version: 1, sessionId: 'interrupted', contentCheckpoint: {segments: []}, recordCheckpoint: {shards: []}, createdAt: 0,
        };
        const clear = vi.fn(async () => {});
        Reflect.set(database, '_db', {selectValue: vi.fn(() => 0), exec: vi.fn()});
        Reflect.set(database, '_importJournal', {read: vi.fn(async () => record), clear});
        Reflect.set(database, '_termContentStore', {rollbackImportSession: vi.fn(async () => { throw new Error('content rollback failed'); })});
        Reflect.set(database, '_termRecordStore', {rollbackImportSession: vi.fn(async () => {})});

        await expect(Reflect.get(database, '_recoverInterruptedImportSession').call(database))
            .rejects.toThrow('content rollback failed');
        expect(clear).not.toHaveBeenCalled();
    });

    test('waits for both interrupted-session rollbacks before reporting failure', async () => {
        const database = new DictionaryDatabase();
        const record = {
            version: 1, sessionId: 'interrupted', contentCheckpoint: {segments: []}, recordCheckpoint: {shards: []}, createdAt: 0,
        };
        let finishRecordRollback;
        const recordRollback = vi.fn(() => new Promise((resolve) => {
            finishRecordRollback = resolve;
        }));
        Reflect.set(database, '_db', {selectValue: vi.fn(() => 0), exec: vi.fn()});
        Reflect.set(database, '_importJournal', {read: vi.fn(async () => record), clear: vi.fn()});
        Reflect.set(database, '_termContentStore', {
            rollbackImportSession: vi.fn().mockRejectedValue(new Error('content rollback failed')),
        });
        Reflect.set(database, '_termRecordStore', {rollbackImportSession: recordRollback});

        let settled = false;
        const recovery = Reflect.get(database, '_recoverInterruptedImportSession').call(database)
            .finally(() => { settled = true; });
        await Promise.resolve();
        await Promise.resolve();
        expect(settled).toBe(false);
        finishRecordRollback();
        await expect(recovery).rejects.toThrow('content rollback failed');
        expect(recordRollback).toHaveBeenCalledOnce();
    });

    test('rejects shared glossary spans outside the inflated artifact', async () => {
        const database = new DictionaryDatabase();
        Reflect.set(database, '_sharedGlossaryArtifactInflatedByDictionary', new Map([
            ['JMdict', new Uint8Array([1, 2, 3])],
        ]));

        await expect(Reflect.get(database, '_readCompressedSharedGlossarySlice').call(
            database,
            'JMdict',
            2,
            2,
        )).rejects.toThrow('out of bounds');
    });

    test('does not resurrect shared glossary cache entries after invalidation', async () => {
        const database = new DictionaryDatabase();
        let finishInflation;
        Reflect.set(database, '_inflateSharedGlossaryArtifact', vi.fn(() => new Promise((resolve) => {
            finishInflation = resolve;
        })));

        const read = Reflect.get(database, '_readCompressedSharedGlossarySlice').call(
            database,
            'JMdict',
            0,
            3,
        );
        Reflect.get(database, '_clearSharedGlossaryArtifactCaches').call(database);
        finishInflation(new Uint8Array([1, 2, 3]));

        await expect(read).resolves.toStrictEqual(new Uint8Array([1, 2, 3]));
        expect(Reflect.get(database, '_sharedGlossaryArtifactInflatedByDictionary').has('JMdict')).toBe(false);
    });

    test('does not clear an invalid recovery journal', async () => {
        const database = new DictionaryDatabase();
        const clear = vi.fn(async () => {});
        Reflect.set(database, '_db', {selectValue: vi.fn(), exec: vi.fn()});
        Reflect.set(database, '_importJournal', {
            read: vi.fn().mockRejectedValue(new Error('Invalid dictionary import journal')),
            clear,
        });

        await expect(Reflect.get(database, '_recoverInterruptedImportSession').call(database))
            .rejects.toThrow(/Cannot safely recover invalid dictionary import journal/);
        expect(clear).not.toHaveBeenCalled();
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

    test('does not retain rollback ownership after SQLite commits when journal cleanup fails', async () => {
        const database = new DictionaryDatabase();
        const rollbackContent = vi.fn().mockResolvedValue();
        const rollbackRecord = vi.fn().mockResolvedValue();
        const db = {
            exec: vi.fn(),
            close: vi.fn(),
        };
        const makeStore = (rollbackImportSession) => ({
            endImportSession: vi.fn().mockResolvedValue(),
            getLastEndImportSessionMetrics: vi.fn(() => null),
            rollbackImportSession,
        });
        Reflect.set(database, '_db', db);
        Reflect.set(database, '_bulkImportDepth', 1);
        Reflect.set(database, '_bulkImportTransactionOpen', true);
        Reflect.set(database, '_bulkImportJournalRecord', {
            version: 1,
            sessionId: 'published-clear-failure',
            contentCheckpoint: {segments: []},
            recordCheckpoint: {shards: []},
            createdAt: 0,
        });
        Reflect.set(database, '_importJournal', {
            clear: vi.fn().mockRejectedValue(new Error('OPFS temporarily unavailable')),
        });
        Reflect.set(database, '_termContentStore', makeStore(rollbackContent));
        Reflect.set(database, '_termRecordStore', makeStore(rollbackRecord));
        Reflect.set(database, '_applyRuntimePragmas', vi.fn());

        await expect(database.finishBulkImport()).resolves.toBeDefined();
        expect(Reflect.get(database, '_bulkImportJournalRecord')).toBeNull();
        expect(Reflect.get(database, '_importJournalRecoveryPending')).toBe(true);

        await expect(database.close()).resolves.toBeUndefined();
        expect(rollbackContent).not.toHaveBeenCalled();
        expect(rollbackRecord).not.toHaveBeenCalled();
        expect(db.close).toHaveBeenCalledOnce();
    });

    test('closes SQLite and preserves the journal after a partial close rollback failure', async () => {
        const database = new DictionaryDatabase();
        const db = {exec: vi.fn(), close: vi.fn()};
        const clear = vi.fn().mockResolvedValue();
        const contentRollback = vi.fn().mockRejectedValue(new Error('content rollback failed'));
        const recordRollback = vi.fn().mockResolvedValue();
        Reflect.set(database, '_db', db);
        Reflect.set(database, '_bulkImportJournalRecord', {
            version: 1,
            sessionId: 'close-rollback-failure',
            contentCheckpoint: {segments: []},
            recordCheckpoint: {shards: []},
            createdAt: 0,
        });
        Reflect.set(database, '_importJournal', {clear});
        Reflect.set(database, '_termContentStore', {rollbackImportSession: contentRollback});
        Reflect.set(database, '_termRecordStore', {rollbackImportSession: recordRollback});

        await expect(database.close()).rejects.toThrow('content rollback failed');

        expect(contentRollback).toHaveBeenCalledOnce();
        expect(recordRollback).toHaveBeenCalledOnce();
        expect(clear).not.toHaveBeenCalled();
        expect(db.close).toHaveBeenCalledOnce();
        expect(Reflect.get(database, '_db')).toBeNull();
        expect(Reflect.get(database, '_bulkImportJournalRecord')).not.toBeNull();
        expect(Reflect.get(database, '_importJournalRecoveryPending')).toBe(true);
    });

    test('coalesces concurrent close calls into one cleanup operation', async () => {
        const database = new DictionaryDatabase();
        let finishEndSession;
        const endImportSession = vi.fn(() => new Promise((resolve) => {
            finishEndSession = resolve;
        }));
        const db = {close: vi.fn()};
        Reflect.set(database, '_db', db);
        Reflect.set(database, '_termContentStore', {endImportSession});
        Reflect.set(database, '_termRecordStore', {endImportSession: vi.fn().mockResolvedValue()});

        const first = database.close();
        const second = database.close();
        await Promise.resolve();
        expect(endImportSession).toHaveBeenCalledOnce();
        finishEndSession();
        await expect(Promise.all([first, second])).resolves.toStrictEqual([undefined, undefined]);
        expect(db.close).toHaveBeenCalledOnce();
        expect(Reflect.get(database, '_db')).toBeNull();
    });

    test('allows repeated close after resources are already released', async () => {
        const database = new DictionaryDatabase();
        const db = {close: vi.fn()};
        Reflect.set(database, '_db', db);
        Reflect.set(database, '_termContentStore', {endImportSession: vi.fn().mockResolvedValue()});
        Reflect.set(database, '_termRecordStore', {endImportSession: vi.fn().mockResolvedValue()});

        await database.close();
        await expect(database.close()).resolves.toBeUndefined();
        expect(db.close).toHaveBeenCalledOnce();
    });

    test('continues failed-prepare cleanup after content block close throws', async () => {
        const database = new DictionaryDatabase();
        const db = {close: vi.fn()};
        Reflect.set(database, '_db', db);
        Reflect.set(database, '_termContentStore', {
            endImportSession: vi.fn().mockResolvedValue(undefined),
        });
        Reflect.set(database, '_termRecordStore', {
            endImportSession: vi.fn().mockResolvedValue(undefined),
        });
        Reflect.set(database, '_termContentBlockImportSession', {
            close: vi.fn(() => {
                throw new Error('content block close failed');
            }),
        });
        Reflect.set(database, '_bulkImportDepth', 1);
        Reflect.set(database, '_bulkImportTransactionOpen', true);

        const errors = await Reflect.get(database, '_cleanupAfterPrepareFailure').call(database);

        expect(errors.map((error) => error.message)).toContain('content block close failed');
        expect(db.close).toHaveBeenCalledOnce();
        expect(Reflect.get(database, '_db')).toBeNull();
        expect(Reflect.get(database, '_termContentBlockImportSession')).toBeNull();
        expect(Reflect.get(database, '_bulkImportDepth')).toBe(0);
        expect(Reflect.get(database, '_bulkImportTransactionOpen')).toBe(false);
    });

    test('purge attempts every cleanup step and reopens after independent failures', async () => {
        const database = new DictionaryDatabase();
        const db = {
            close: vi.fn(() => {
                throw new Error('database close failed');
            }),
            exec: vi.fn((sql) => {
                if (sql === 'ROLLBACK') {
                    throw new Error('rollback failed');
                }
            }),
        };
        const termContentReset = vi.fn().mockRejectedValue(new Error('term content reset failed'));
        const termRecordReset = vi.fn().mockResolvedValue(undefined);
        const journalClear = vi.fn().mockRejectedValue(new Error('journal clear failed'));
        const terminate = vi.fn();
        const prepare = vi.spyOn(database, 'prepare').mockResolvedValue();
        Reflect.set(database, '_db', db);
        Reflect.set(database, '_bulkImportDepth', 1);
        Reflect.set(database, '_bulkImportTransactionOpen', true);
        Reflect.set(database, '_bulkImportJournalRecord', {sessionId: 'purge-test'});
        Reflect.set(database, '_importJournalRecoveryPending', true);
        Reflect.set(database, '_termContentStore', {reset: termContentReset});
        Reflect.set(database, '_termRecordStore', {reset: termRecordReset});
        Reflect.set(database, '_importJournal', {clear: journalClear});
        Reflect.set(database, '_worker', {terminate});
        Reflect.set(database, '_applyRuntimePragmas', vi.fn());

        await expect(database.purge()).rejects.toThrow('Dictionary database purge encountered cleanup failures');

        expect(termContentReset).toHaveBeenCalledOnce();
        expect(termRecordReset).toHaveBeenCalledOnce();
        expect(journalClear).toHaveBeenCalledOnce();
        expect(db.close).toHaveBeenCalledOnce();
        expect(terminate).toHaveBeenCalledOnce();
        expect(prepare).toHaveBeenCalledOnce();
        expect(Reflect.get(database, '_db')).toBeNull();
        expect(Reflect.get(database, '_bulkImportDepth')).toBe(0);
        expect(Reflect.get(database, '_bulkImportTransactionOpen')).toBe(false);
        expect(Reflect.get(database, '_bulkImportJournalRecord')).toBeNull();
        expect(Reflect.get(database, '_importJournalRecoveryPending')).toBe(false);
    });

    test('schema wipe attempts both persistent store resets before failing', async () => {
        const database = new DictionaryDatabase();
        const termContentReset = vi.fn().mockRejectedValue(new Error('term content reset failed'));
        const termRecordReset = vi.fn().mockResolvedValue(undefined);
        const beginImmediateTransaction = vi.spyOn(database, '_beginImmediateTransaction').mockResolvedValue();
        Reflect.set(database, '_db', {
            selectValue: vi.fn(() => 0),
            exec: vi.fn(),
        });
        Reflect.set(database, '_termContentStore', {reset: termContentReset});
        Reflect.set(database, '_termRecordStore', {reset: termRecordReset, size: 0});

        await expect(Reflect.get(database, '_wipeDictionaryDataForSchemaMigration').call(database, 'test-wipe'))
            .rejects.toThrow('term content reset failed');

        expect(termContentReset).toHaveBeenCalledOnce();
        expect(termRecordReset).toHaveBeenCalledOnce();
        expect(beginImmediateTransaction).not.toHaveBeenCalled();
    });

    test('waits for close to finish before resuming a suspended database', async () => {
        const database = new DictionaryDatabase();
        let finishEndSession;
        const endImportSession = vi.fn(() => new Promise((resolve) => {
            finishEndSession = resolve;
        }));
        Reflect.set(database, '_db', {close: vi.fn()});
        Reflect.set(database, '_termContentStore', {endImportSession});
        Reflect.set(database, '_termRecordStore', {endImportSession: vi.fn().mockResolvedValue()});
        const prepare = vi.spyOn(database, 'prepare').mockResolvedValue();

        const close = database.close();
        const resume = database.setSuspended(false);
        await Promise.resolve();
        expect(prepare).not.toHaveBeenCalled();
        finishEndSession();

        await Promise.all([close, resume]);
        expect(prepare).toHaveBeenCalledOnce();
    });

    test('allows lookups after recovered journal cleanup fails but blocks a new import', async () => {
        const database = new DictionaryDatabase();
        const record = {
            version: 1,
            sessionId: 'recovered-clear-failure',
            contentCheckpoint: {segments: []},
            recordCheckpoint: {shards: []},
            createdAt: 0,
        };
        Reflect.set(database, '_db', {selectValue: vi.fn(() => 0), exec: vi.fn()});
        Reflect.set(database, '_importJournal', {
            read: vi.fn(async () => record),
            clear: vi.fn().mockRejectedValue(new Error('clear failed')),
        });
        Reflect.set(database, '_termContentStore', {rollbackImportSession: vi.fn().mockResolvedValue()});
        Reflect.set(database, '_termRecordStore', {rollbackImportSession: vi.fn().mockResolvedValue()});

        await expect(Reflect.get(database, '_recoverInterruptedImportSession').call(database))
            .resolves.toBeUndefined();
        expect(Reflect.get(database, '_importJournalRecoveryPending')).toBe(true);
        await expect(database.startBulkImport())
            .rejects.toThrow('Cannot import dictionaries until interrupted-import recovery metadata is cleared');
    });

    test('does not write to SQLite during normal startup without an import journal', async () => {
        const database = new DictionaryDatabase();
        const exec = vi.fn();
        Reflect.set(database, '_db', {exec});
        Reflect.set(database, '_importJournal', {read: vi.fn(async () => null), clear: vi.fn().mockResolvedValue()});

        await Reflect.get(database, '_recoverInterruptedImportSession').call(database);

        expect(exec).not.toHaveBeenCalled();
    });

    test('preserves a replaced recovery copy when startup restoration fails', async () => {
        const database = new DictionaryDatabase();
        const replacedTitle = 'JMdict [2026-02-26] [replaced update-token]';
        const deleteDictionary = vi.spyOn(database, 'deleteDictionary').mockResolvedValue();
        vi.spyOn(database, 'cleanupTransientTermRecordShards').mockResolvedValue([]);
        vi.spyOn(database, 'replaceDictionaryTitle').mockRejectedValue(new Error('transient OPFS failure'));
        Reflect.set(database, '_db', {
            selectObjects: vi.fn(() => [{
                id: 1,
                title: replacedTitle,
                summaryJson: JSON.stringify({
                    title: replacedTitle,
                    importSuccess: true,
                    transientUpdateStage: 'replaced',
                    updateSessionToken: 'update-token',
                }),
            }]),
            exec: vi.fn(),
        });

        const summary = await Reflect.get(database, '_cleanupIncompleteImports').call(database);

        expect(deleteDictionary).not.toHaveBeenCalled();
        expect(summary.removedTitles).toStrictEqual([]);
        expect(summary.failedTitles).toStrictEqual([replacedTitle]);
    });
});
