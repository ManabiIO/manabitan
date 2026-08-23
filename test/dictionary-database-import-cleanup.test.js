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
    test('rolls back a preserved term-record rename when the SQLite title commit fails', async () => {
        const database = new DictionaryDatabase();
        let row = {
            id: 1,
            title: 'JMdict staging',
            version: 3,
            summaryJson: JSON.stringify({title: 'JMdict staging', version: 3, importSuccess: true}),
        };
        let transactionSnapshot = {...row};
        const exec = vi.fn((value) => {
            const sql = typeof value === 'string' ? value : value.sql;
            if (sql === 'BEGIN IMMEDIATE') {
                transactionSnapshot = {...row};
                return;
            }
            if (typeof value === 'object' && sql.startsWith('UPDATE dictionaries SET title')) {
                row = {
                    ...row,
                    title: value.bind.$toTitle,
                    version: value.bind.$version,
                    summaryJson: value.bind.$summaryJson,
                };
                return;
            }
            if (sql === 'COMMIT') {
                throw new Error('commit failed');
            }
            if (sql === 'ROLLBACK') {
                row = {...transactionSnapshot};
            }
        });
        const db = {
            exec,
            selectObject: vi.fn((_sql, bind) => {
                if (bind.$title !== row.title) { return null; }
                return {
                    id: row.id,
                    version: row.version,
                    summaryJson: row.summaryJson,
                };
            }),
            selectObjects: vi.fn(() => [{
                id: row.id,
                title: row.title,
                version: row.version,
                summaryJson: row.summaryJson,
            }]),
        };
        const replaceDictionaryName = vi.fn().mockResolvedValue(1);
        const rollbackPreservedDictionaryRename = vi.fn().mockResolvedValue();
        Reflect.set(database, '_db', db);
        Reflect.set(database, '_termRecordStore', {
            replaceDictionaryName,
            rollbackPreservedDictionaryRename,
        });

        await expect(database.replaceDictionaryTitle('JMdict staging', 'JMdict'))
            .rejects.toThrow('commit failed');

        expect(replaceDictionaryName).toHaveBeenCalledWith('JMdict staging', 'JMdict', true);
        expect(rollbackPreservedDictionaryRename).toHaveBeenCalledWith('JMdict staging', 'JMdict');
        expect(row.title).toBe('JMdict staging');
    });

    test('reports both SQLite and OPFS failures during title rollback', async () => {
        const database = new DictionaryDatabase();
        let row = {
            id: 1,
            title: 'JMdict staging',
            version: 3,
            summaryJson: JSON.stringify({title: 'JMdict staging', version: 3, importSuccess: true}),
        };
        const exec = vi.fn((value) => {
            const sql = typeof value === 'string' ? value : value.sql;
            if (typeof value === 'object' && sql.startsWith('UPDATE dictionaries SET title')) {
                row = {...row, title: value.bind.$toTitle, summaryJson: value.bind.$summaryJson};
            } else if (sql === 'COMMIT') {
                throw new Error('commit failed');
            } else if (sql === 'ROLLBACK') {
                throw new Error('rollback failed');
            }
        });
        Reflect.set(database, '_db', {
            exec,
            selectObject: vi.fn((_sql, bind) => {
                return bind.$title === row.title ? row : null;
            }),
            selectObjects: vi.fn(() => [row]),
        });
        Reflect.set(database, '_termRecordStore', {
            replaceDictionaryName: vi.fn().mockResolvedValue(1),
            rollbackPreservedDictionaryRename: vi.fn().mockRejectedValue(new Error('OPFS rollback failed')),
        });

        await expect(database.replaceDictionaryTitle('JMdict staging', 'JMdict'))
            .rejects.toMatchObject({
                name: 'AggregateError',
                message: 'Dictionary title replacement and rollback failed for JMdict staging to JMdict',
                errors: [
                    expect.objectContaining({message: 'commit failed'}),
                    expect.objectContaining({message: 'rollback failed'}),
                    expect.objectContaining({message: 'OPFS rollback failed'}),
                ],
            });
    });

    test('publishes an update without an intermediate cutover shard copy', async () => {
        const token = 'update-token';
        const stagingTitle = `JMdict [update-staging ${token}]`;
        const replacedTitle = `JMdict [replaced ${token}]`;
        let rows = [
            {id: 1, title: stagingTitle, version: 3, summaryJson: JSON.stringify({title: stagingTitle, version: 3, importSuccess: true})},
            {id: 2, title: 'JMdict', version: 3, summaryJson: JSON.stringify({title: 'JMdict', version: 3, importSuccess: true})},
        ];
        let transactionSnapshot = [];
        const exec = vi.fn((value) => {
            const sql = typeof value === 'string' ? value : value.sql;
            if (sql === 'BEGIN IMMEDIATE') {
                transactionSnapshot = rows.map((row) => ({...row}));
            } else if (typeof value === 'object' && sql.startsWith('UPDATE dictionaries SET title')) {
                const row = rows.find(({id}) => id === value.bind.$id);
                Object.assign(row, {
                    title: value.bind.$toTitle,
                    version: value.bind.$version,
                    summaryJson: value.bind.$summaryJson,
                });
            } else if (sql === 'ROLLBACK') {
                rows = transactionSnapshot.map((row) => ({...row}));
            }
        });
        const database = new DictionaryDatabase();
        const replaceDictionaryName = vi.fn().mockResolvedValue(1);
        Reflect.set(database, '_db', {
            exec,
            selectObject: vi.fn((_sql, bind) => rows.find(({title}) => title === bind.$title) ?? null),
            selectObjects: vi.fn(() => rows),
        });
        Reflect.set(database, '_termRecordStore', {
            replaceDictionaryName,
            rollbackPreservedDictionaryRename: vi.fn().mockResolvedValue(),
        });
        vi.spyOn(database, 'cleanupTransientTermRecordShards').mockResolvedValue([]);
        vi.spyOn(database, 'deleteDictionary').mockImplementation(async (title) => {
            rows = rows.filter((row) => row.title !== title);
        });

        await database.replaceDictionaryTitle(
            stagingTitle,
            'JMdict',
            {title: 'JMdict', version: 3, importSuccess: true, updateSessionToken: token},
            'JMdict',
        );

        expect(replaceDictionaryName.mock.calls).toStrictEqual([
            ['JMdict', replacedTitle, true],
            [stagingTitle, 'JMdict', true],
        ]);
        expect(replaceDictionaryName.mock.calls.flat().some((value) => `${value}`.includes('[cutover '))).toBe(false);
        expect(rows.map(({title}) => title)).toStrictEqual(['JMdict']);
    });

    test('restores the old generation when direct staged publication fails', async () => {
        const token = 'update-token';
        const stagingTitle = `JMdict [update-staging ${token}]`;
        const replacedTitle = `JMdict [replaced ${token}]`;
        let rows = [
            {id: 1, title: stagingTitle, version: 3, summaryJson: JSON.stringify({title: stagingTitle, version: 3, importSuccess: true})},
            {id: 2, title: 'JMdict', version: 3, summaryJson: JSON.stringify({title: 'JMdict', version: 3, importSuccess: true})},
        ];
        let transactionSnapshot = [];
        const exec = vi.fn((value) => {
            const sql = typeof value === 'string' ? value : value.sql;
            if (sql === 'BEGIN IMMEDIATE') {
                transactionSnapshot = rows.map((row) => ({...row}));
            } else if (typeof value === 'object' && sql.startsWith('UPDATE dictionaries SET title')) {
                const row = rows.find(({id}) => id === value.bind.$id);
                Object.assign(row, {
                    title: value.bind.$toTitle,
                    version: value.bind.$version,
                    summaryJson: value.bind.$summaryJson,
                });
            } else if (sql === 'ROLLBACK') {
                rows = transactionSnapshot.map((row) => ({...row}));
            }
        });
        const database = new DictionaryDatabase();
        const replaceDictionaryName = vi.fn(async (fromTitle, toTitle) => {
            if (fromTitle === stagingTitle && toTitle === 'JMdict') {
                throw new Error('injected staged publication failure');
            }
            return 1;
        });
        Reflect.set(database, '_db', {
            exec,
            selectObject: vi.fn((_sql, bind) => rows.find(({title}) => title === bind.$title) ?? null),
            selectObjects: vi.fn(() => rows),
        });
        Reflect.set(database, '_termRecordStore', {
            replaceDictionaryName,
            rollbackPreservedDictionaryRename: vi.fn().mockResolvedValue(),
        });
        vi.spyOn(database, 'cleanupTransientTermRecordShards').mockResolvedValue([]);

        await expect(database.replaceDictionaryTitle(
            stagingTitle,
            'JMdict',
            {title: 'JMdict', version: 3, importSuccess: true, updateSessionToken: token},
            'JMdict',
        )).rejects.toThrow('injected staged publication failure');

        expect(replaceDictionaryName.mock.calls).toStrictEqual([
            ['JMdict', replacedTitle, true],
            [stagingTitle, 'JMdict', true],
            [replacedTitle, 'JMdict', true],
        ]);
        expect(rows.map(({title}) => title).sort()).toStrictEqual(['JMdict', stagingTitle].sort());
    });

    test('removes a failed-import placeholder by primary key only', async () => {
        const database = new DictionaryDatabase();
        const exec = vi.fn();
        Reflect.set(database, '_db', {exec});

        await database.deleteDictionaryImportPlaceholder(42);

        expect(exec.mock.calls).toStrictEqual([
            ['BEGIN IMMEDIATE'],
            [{sql: 'DELETE FROM dictionaries WHERE id = $id', bind: {$id: 42}}],
            ['COMMIT'],
        ]);
    });

    test('does not remove term shards before dictionary metadata commits', async () => {
        const database = new DictionaryDatabase();
        const deleteByDictionary = vi.fn().mockResolvedValue(3);
        const exec = vi.fn((value) => {
            if (value === 'COMMIT') { throw new Error('commit failed'); }
        });
        Reflect.set(database, '_db', {
            exec,
            selectValue: vi.fn((sql) => sql.includes('COUNT(*) FROM dictionaries') ? 1 : 0),
        });
        Reflect.set(database, '_termRecordStore', {
            ensureDictionariesLoaded: vi.fn().mockResolvedValue(),
            getDictionaryRecordCount: vi.fn(() => 3),
            deleteByDictionary,
        });

        await expect(database.deleteDictionary('JMdict', 1000, () => {})).rejects.toThrow('commit failed');

        expect(deleteByDictionary).not.toHaveBeenCalled();
        expect(exec).toHaveBeenCalledWith('ROLLBACK');
    });

    test('resets the last dictionary content store only after metadata commits', async () => {
        const database = new DictionaryDatabase();
        const reset = vi.fn().mockResolvedValue();
        const events = [];
        Reflect.set(database, '_db', {
            exec: vi.fn((value) => events.push(value)),
            selectValue: vi.fn(() => 0),
        });
        Reflect.set(database, '_termContentStore', {reset: vi.fn(async () => {
            events.push('RESET');
            await reset();
        })});

        await Reflect.get(database, '_cleanupTermContentAfterDictionaryDelete').call(database);

        expect(events).toEqual([
            'BEGIN IMMEDIATE',
            'DELETE FROM termEntryContent',
            'DELETE FROM sharedGlossaryArtifacts',
            'COMMIT',
            'RESET',
        ]);
    });

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
        expect(Reflect.get(database, '_bulkImportState')).toBe('idle');
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
        expect(Reflect.get(database, '_bulkImportState')).toBe('active');
    });

    test('does not start an import through an opening, closing, or purging lifecycle', async () => {
        for (const [property, value] of [
            ['_isOpening', true],
            ['_closingPromise', Promise.resolve()],
            ['_purgingPromise', Promise.resolve(false)],
        ]) {
            const database = new DictionaryDatabase();
            Reflect.set(database, '_db', {exec: vi.fn()});
            Reflect.set(database, property, value);
            await expect(database.startBulkImport())
                .rejects.toThrow('Cannot start a dictionary bulk import while the database lifecycle is busy');
            expect(Reflect.get(database, '_bulkImportState')).toBe('idle');
        }
    });

    test('aborts failed imports without publishing SQLite and rolls back both OPFS stores', async () => {
        const database = new DictionaryDatabase();
        const exec = vi.fn();
        const contentRollback = vi.fn().mockResolvedValue();
        const recordRollback = vi.fn().mockResolvedValue();
        const clearJournal = vi.fn().mockResolvedValue();
        const closeContentBlocks = vi.fn();
        Reflect.set(database, '_db', {exec});
        Reflect.set(database, '_bulkImportState', 'active');
        Reflect.set(database, '_bulkImportTransactionOpen', true);
        Reflect.set(database, '_bulkImportJournalRecord', {
            version: 1,
            sessionId: 'abort-test',
            contentCheckpoint: {segments: []},
            recordCheckpoint: {shards: []},
            createdAt: 0,
        });
        Reflect.set(database, '_termContentStore', {rollbackImportSession: contentRollback});
        Reflect.set(database, '_termRecordStore', {rollbackImportSession: recordRollback});
        Reflect.set(database, '_importJournal', {clear: clearJournal});
        Reflect.set(database, '_termContentBlockImportSession', {close: closeContentBlocks});
        Reflect.set(database, '_applyRuntimePragmas', vi.fn());

        await database.abortBulkImport();
        await database.abortBulkImport();

        expect(exec).toHaveBeenCalledWith('ROLLBACK');
        expect(exec).not.toHaveBeenCalledWith('COMMIT');
        expect(contentRollback).toHaveBeenCalledOnce();
        expect(recordRollback).toHaveBeenCalledOnce();
        expect(clearJournal).toHaveBeenCalledOnce();
        expect(closeContentBlocks).toHaveBeenCalledOnce();
        expect(Reflect.get(database, '_bulkImportJournalRecord')).toBeNull();
        expect(Reflect.get(database, '_bulkImportState')).toBe('idle');
        expect(Reflect.get(database, '_bulkImportTransactionOpen')).toBe(false);
    });

    test('rejects start, finish, and abort while finalization is active', async () => {
        const database = new DictionaryDatabase();
        let releaseTermContent;
        const termContentEndGate = new Promise((resolve) => {
            releaseTermContent = resolve;
        });
        Reflect.set(database, '_db', {exec: vi.fn()});
        Reflect.set(database, '_bulkImportState', 'active');
        Reflect.set(database, '_termContentStore', {
            endImportSession: vi.fn(() => termContentEndGate),
            getLastEndImportSessionMetrics: vi.fn(() => null),
        });
        Reflect.set(database, '_termRecordStore', {
            endImportSession: vi.fn().mockResolvedValue(),
            getLastEndImportSessionMetrics: vi.fn(() => null),
        });
        Reflect.set(database, '_applyRuntimePragmas', vi.fn());

        const finalization = database.finishBulkImport();
        await vi.waitFor(() => {
            expect(Reflect.get(database, '_bulkImportState')).toBe('finalizing');
        });
        await expect(database.startBulkImport()).rejects.toThrow('A dictionary bulk import is already active');
        await expect(database.finishBulkImport()).rejects.toThrow('Dictionary bulk import finalization is already active');
        await expect(database.abortBulkImport()).rejects.toThrow('Dictionary bulk import finalization is already active');

        releaseTermContent();
        await expect(finalization).resolves.toBeDefined();
        expect(Reflect.get(database, '_bulkImportState')).toBe('idle');
        await expect(database.finishBulkImport()).resolves.toBeNull();
        await expect(database.abortBulkImport()).resolves.toBeUndefined();
    });

    test('waits for import setup before aborting its storage sessions', async () => {
        const database = new DictionaryDatabase();
        let releaseCheckpoint;
        const checkpointGate = new Promise((resolve) => {
            releaseCheckpoint = resolve;
        });
        const contentRollback = vi.fn().mockResolvedValue();
        const recordRollback = vi.fn().mockResolvedValue();
        Reflect.set(database, '_db', {exec: vi.fn(), selectValue: vi.fn(() => 0)});
        Reflect.set(database, '_termContentStore', {
            createImportCheckpoint: vi.fn(async () => {
                await checkpointGate;
                return {segments: []};
            }),
            beginImportSession: vi.fn().mockResolvedValue(),
            rollbackImportSession: contentRollback,
        });
        Reflect.set(database, '_termRecordStore', {
            createImportCheckpoint: vi.fn().mockResolvedValue({shards: []}),
            beginImportSession: vi.fn().mockResolvedValue(),
            rollbackImportSession: recordRollback,
        });
        Reflect.set(database, '_termContentBlockStore', {
            beginImportSession: vi.fn(() => ({close: vi.fn()})),
            clearCache: vi.fn(),
        });
        Reflect.set(database, '_importJournal', {
            write: vi.fn().mockResolvedValue(),
            clear: vi.fn().mockResolvedValue(),
        });
        Reflect.set(database, '_applyRuntimePragmas', vi.fn());

        const start = database.startBulkImport();
        const abort = database.abortBulkImport();
        await Promise.resolve();
        await Promise.resolve();
        expect(contentRollback).not.toHaveBeenCalled();
        expect(recordRollback).not.toHaveBeenCalled();

        releaseCheckpoint();
        await expect(start).resolves.toBeUndefined();
        await expect(abort).resolves.toBeUndefined();
        expect(contentRollback).toHaveBeenCalledOnce();
        expect(recordRollback).toHaveBeenCalledOnce();
        expect(Reflect.get(database, '_bulkImportState')).toBe('idle');
    });

    test('retains recovery ownership when an abort rollback fails', async () => {
        const database = new DictionaryDatabase();
        const clearJournal = vi.fn().mockResolvedValue();
        const close = vi.fn();
        Reflect.set(database, '_db', {exec: vi.fn(), close});
        Reflect.set(database, '_bulkImportState', 'active');
        Reflect.set(database, '_bulkImportTransactionOpen', true);
        Reflect.set(database, '_bulkImportJournalRecord', {
            version: 1,
            sessionId: 'abort-failure-test',
            contentCheckpoint: {segments: []},
            recordCheckpoint: {shards: []},
            createdAt: 0,
        });
        Reflect.set(database, '_termContentStore', {
            rollbackImportSession: vi.fn().mockRejectedValue(new Error('content rollback failed')),
        });
        Reflect.set(database, '_termRecordStore', {rollbackImportSession: vi.fn().mockResolvedValue()});
        Reflect.set(database, '_importJournal', {clear: clearJournal});
        Reflect.set(database, '_applyRuntimePragmas', vi.fn());

        await expect(database.abortBulkImport()).rejects.toThrow('Failed to roll back dictionary import storage');

        expect(clearJournal).not.toHaveBeenCalled();
        expect(Reflect.get(database, '_bulkImportJournalRecord')).not.toBeNull();
        expect(Reflect.get(database, '_importJournalRecoveryPending')).toBe(true);
        expect(Reflect.get(database, '_bulkImportState')).toBe('idle');
        expect(Reflect.get(database, '_db')).toBeNull();
        expect(close).toHaveBeenCalledOnce();
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
        expect(Reflect.get(database, '_bulkImportState')).toBe('idle');
        expect(Reflect.get(database, '_bulkImportJournalRecord')).not.toBeNull();
        expect(Reflect.get(database, '_importJournalRecoveryPending')).toBe(true);
    });

    test('quarantines the connection when failed import setup cannot roll back OPFS', async () => {
        const database = new DictionaryDatabase();
        const close = vi.fn();
        const clear = vi.fn().mockResolvedValue();
        Reflect.set(database, '_db', {exec: vi.fn(), close, selectValue: vi.fn(() => 0)});
        Reflect.set(database, '_termContentStore', {
            createImportCheckpoint: vi.fn().mockResolvedValue({segments: []}),
            beginImportSession: vi.fn().mockRejectedValue(new Error('content setup failed')),
            rollbackImportSession: vi.fn().mockRejectedValue(new Error('content rollback failed')),
        });
        Reflect.set(database, '_termRecordStore', {
            createImportCheckpoint: vi.fn().mockResolvedValue({shards: []}),
            beginImportSession: vi.fn().mockResolvedValue(),
            rollbackImportSession: vi.fn().mockResolvedValue(),
        });
        Reflect.set(database, '_importJournal', {write: vi.fn().mockResolvedValue(), clear});
        Reflect.set(database, '_applyRuntimePragmas', vi.fn());

        await expect(database.startBulkImport())
            .rejects.toThrow('Failed to start and clean up dictionary import storage');

        expect(clear).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledOnce();
        expect(Reflect.get(database, '_db')).toBeNull();
        expect(Reflect.get(database, '_bulkImportState')).toBe('idle');
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
        Reflect.set(database, '_bulkImportState', 'active');
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
        expect(Reflect.get(database, '_bulkImportState')).toBe('idle');
        expect(Reflect.get(database, '_db')).toBeNull();
    });

    test('restores runtime state then quarantines after finish checkpoint rollback fails', async () => {
        const database = new DictionaryDatabase();
        const close = vi.fn();
        const applyRuntimePragmas = vi.fn();
        const clear = vi.fn().mockResolvedValue();
        Reflect.set(database, '_db', {exec: vi.fn(), close});
        Reflect.set(database, '_bulkImportState', 'active');
        Reflect.set(database, '_bulkImportTransactionOpen', true);
        Reflect.set(database, '_deferTermsVirtualTableSync', true);
        Reflect.set(database, '_termsVirtualTableDirty', true);
        Reflect.set(database, '_bulkImportJournalRecord', {
            version: 1, sessionId: 'finish-rollback-failure', contentCheckpoint: {segments: []}, recordCheckpoint: {shards: []}, createdAt: 0,
        });
        Reflect.set(database, '_importJournal', {clear});
        Reflect.set(database, '_termContentStore', {
            endImportSession: vi.fn().mockRejectedValue(new Error('seal failed')),
            rollbackImportSession: vi.fn().mockRejectedValue(new Error('content rollback failed')),
        });
        Reflect.set(database, '_termRecordStore', {
            endImportSession: vi.fn().mockResolvedValue(),
            getLastEndImportSessionMetrics: vi.fn(() => null),
            rollbackImportSession: vi.fn().mockResolvedValue(),
        });
        Reflect.set(database, '_applyRuntimePragmas', applyRuntimePragmas);

        await expect(database.finishBulkImport())
            .rejects.toThrow('Dictionary import finalization and cleanup failed');

        expect(clear).not.toHaveBeenCalled();
        expect(applyRuntimePragmas).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
        expect(Reflect.get(database, '_deferTermsVirtualTableSync')).toBe(false);
        expect(Reflect.get(database, '_termsVirtualTableDirty')).toBe(false);
        expect(Reflect.get(database, '_bulkImportState')).toBe('idle');
        expect(Reflect.get(database, '_db')).toBeNull();
        expect(Reflect.get(database, '_bulkImportJournalRecord')).not.toBeNull();
        expect(Reflect.get(database, '_importJournalRecoveryPending')).toBe(true);
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
        Reflect.set(database, '_bulkImportState', 'active');
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
        Reflect.set(database, '_bulkImportState', 'active');
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
        const contentRollback = vi.fn()
            .mockRejectedValueOnce(new Error('content rollback failed'))
            .mockResolvedValueOnce(void 0);
        Reflect.set(database, '_db', {selectValue: vi.fn(() => 0), exec: vi.fn()});
        Reflect.set(database, '_importJournal', {read: vi.fn(async () => record), clear});
        Reflect.set(database, '_termContentStore', {rollbackImportSession: contentRollback});
        Reflect.set(database, '_termRecordStore', {rollbackImportSession: vi.fn(async () => {})});

        await expect(Reflect.get(database, '_recoverInterruptedImportSession').call(database))
            .rejects.toThrow('content rollback failed');
        expect(clear).not.toHaveBeenCalled();
        expect(Reflect.get(database, '_importJournalRecoveryPending')).toBe(true);

        await expect(Reflect.get(database, '_recoverInterruptedImportSession').call(database)).resolves.toBeUndefined();
        expect(contentRollback).toHaveBeenCalledTimes(2);
        expect(clear).toHaveBeenCalledOnce();
        expect(Reflect.get(database, '_importJournalRecoveryPending')).toBe(false);
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
        Reflect.set(database, '_bulkImportState', 'active');
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

    test('does not roll published storage back when post-commit runtime cleanup fails', async () => {
        const database = new DictionaryDatabase();
        const contentRollback = vi.fn().mockResolvedValue();
        const recordRollback = vi.fn().mockResolvedValue();
        const exec = vi.fn();
        const makeStore = (rollbackImportSession) => ({
            endImportSession: vi.fn().mockResolvedValue(),
            getLastEndImportSessionMetrics: vi.fn(() => null),
            rollbackImportSession,
        });
        Reflect.set(database, '_db', {exec});
        Reflect.set(database, '_bulkImportState', 'active');
        Reflect.set(database, '_bulkImportTransactionOpen', true);
        Reflect.set(database, '_bulkImportJournalRecord', {
            version: 1,
            sessionId: 'published-runtime-cleanup-failure',
            contentCheckpoint: {segments: []},
            recordCheckpoint: {shards: []},
            createdAt: 0,
        });
        Reflect.set(database, '_importJournal', {clear: vi.fn().mockResolvedValue()});
        Reflect.set(database, '_termContentStore', makeStore(contentRollback));
        Reflect.set(database, '_termRecordStore', makeStore(recordRollback));
        Reflect.set(database, '_applyRuntimePragmas', vi.fn(() => {
            throw new Error('runtime cleanup failed');
        }));

        await expect(database.finishBulkImport()).rejects.toThrow('Dictionary import finalization and cleanup failed');

        expect(exec).toHaveBeenCalledWith('COMMIT');
        expect(exec).not.toHaveBeenCalledWith('ROLLBACK');
        expect(contentRollback).not.toHaveBeenCalled();
        expect(recordRollback).not.toHaveBeenCalled();
        expect(Reflect.get(database, '_bulkImportJournalRecord')).toBeNull();
        expect(Reflect.get(database, '_bulkImportState')).toBe('idle');
        expect(Reflect.get(database, '_db')).not.toBeNull();
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

    test('does not clear the recovery journal when close cannot roll SQLite back', async () => {
        const database = new DictionaryDatabase();
        const clear = vi.fn().mockResolvedValue();
        const db = {
            exec: vi.fn((sql) => {
                if (sql === 'ROLLBACK') { throw new Error('SQLite rollback failed'); }
            }),
            close: vi.fn(),
        };
        Reflect.set(database, '_db', db);
        Reflect.set(database, '_bulkImportState', 'active');
        Reflect.set(database, '_bulkImportTransactionOpen', true);
        Reflect.set(database, '_bulkImportJournalRecord', {
            version: 1,
            sessionId: 'close-sqlite-rollback-failure',
            contentCheckpoint: {segments: []},
            recordCheckpoint: {shards: []},
            createdAt: 0,
        });
        Reflect.set(database, '_importJournal', {clear});
        Reflect.set(database, '_termContentStore', {rollbackImportSession: vi.fn().mockResolvedValue()});
        Reflect.set(database, '_termRecordStore', {rollbackImportSession: vi.fn().mockResolvedValue()});

        await expect(database.close()).rejects.toThrow('SQLite rollback failed');

        expect(clear).not.toHaveBeenCalled();
        expect(Reflect.get(database, '_bulkImportJournalRecord')).not.toBeNull();
        expect(Reflect.get(database, '_importJournalRecoveryPending')).toBe(true);
        expect(Reflect.get(database, '_bulkImportState')).toBe('idle');
        expect(db.close).toHaveBeenCalledOnce();
    });

    test('rejects close and purge while import finalization owns the lifecycle', async () => {
        const database = new DictionaryDatabase();
        Reflect.set(database, '_db', {exec: vi.fn(), close: vi.fn()});
        Reflect.set(database, '_bulkImportState', 'active');
        let releaseSeal;
        const sealGate = new Promise((resolve) => {
            releaseSeal = resolve;
        });
        Reflect.set(database, '_termContentStore', {
            endImportSession: vi.fn(async () => {
                await sealGate;
            }),
            getLastEndImportSessionMetrics: vi.fn(() => null),
        });
        Reflect.set(database, '_termRecordStore', {
            endImportSession: vi.fn().mockResolvedValue(),
            getLastEndImportSessionMetrics: vi.fn(() => null),
        });
        Reflect.set(database, '_applyRuntimePragmas', vi.fn());

        const finish = database.finishBulkImport();
        await Promise.resolve();
        expect(Reflect.get(database, '_bulkImportState')).toBe('finalizing');
        await expect(database.close()).rejects.toThrow('Dictionary bulk import finalization is already active');
        await expect(database.purge()).rejects.toThrow('Dictionary bulk import finalization is already active');

        releaseSeal();
        await expect(finish).resolves.toBeDefined();
        expect(Reflect.get(database, '_bulkImportState')).toBe('idle');
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
        Reflect.set(database, '_bulkImportState', 'active');
        Reflect.set(database, '_bulkImportTransactionOpen', true);

        const errors = await Reflect.get(database, '_cleanupAfterPrepareFailure').call(database);

        expect(errors.map((error) => error.message)).toContain('content block close failed');
        expect(db.close).toHaveBeenCalledOnce();
        expect(Reflect.get(database, '_db')).toBeNull();
        expect(Reflect.get(database, '_termContentBlockImportSession')).toBeNull();
        expect(Reflect.get(database, '_bulkImportState')).toBe('idle');
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
        const prepare = vi.spyOn(database, '_prepareOnce').mockResolvedValue();
        Reflect.set(database, '_db', db);
        Reflect.set(database, '_bulkImportState', 'active');
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
        expect(Reflect.get(database, '_bulkImportState')).toBe('idle');
        expect(Reflect.get(database, '_bulkImportTransactionOpen')).toBe(false);
        expect(Reflect.get(database, '_bulkImportJournalRecord')).toBeNull();
        expect(Reflect.get(database, '_importJournalRecoveryPending')).toBe(false);
    });

    test('coalesces purge and makes concurrent prepare wait for its result', async () => {
        const database = new DictionaryDatabase();
        let releasePurge;
        const purgeGate = new Promise((resolve) => {
            releasePurge = resolve;
        });
        const purgeOnce = vi.spyOn(database, '_purgeOnce').mockImplementation(async () => {
            await purgeGate;
            return true;
        });

        const firstPurge = database.purge();
        const secondPurge = database.purge();
        const prepare = database.prepare();
        let prepareSettled = false;
        void prepare.finally(() => { prepareSettled = true; });
        await Promise.resolve();
        expect(purgeOnce).toHaveBeenCalledOnce();
        expect(prepareSettled).toBe(false);

        releasePurge();
        await expect(Promise.all([firstPurge, secondPurge, prepare])).resolves.toStrictEqual([true, true, undefined]);
        expect(prepareSettled).toBe(true);
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

    test('keeps dictionary metadata and requests reimport when a cold record shard is missing', async () => {
        const database = new DictionaryDatabase();
        const markDictionaryReimportRequired = vi.fn();
        const deleteDictionary = vi.spyOn(database, 'deleteDictionary').mockResolvedValue();
        Reflect.set(database, '_db', {
            selectObjects: vi.fn(() => [{
                title: 'JMdict',
                summaryJson: JSON.stringify({title: 'JMdict', counts: {terms: {total: 100}}}),
            }]),
        });
        Reflect.set(database, '_termRecordStore', {
            verifyIntegrity: vi.fn(async () => ({
                expectedShardCount: 1,
                actualShardCount: 0,
                missingShardCount: 1,
                missingShardFileNames: ['dict-JMdict.mbtr'],
                missingDictionaryNames: ['JMdict'],
                orphanShardCount: 0,
                orphanShardFileNames: [],
                orphanDictionaryNames: [],
                removedOrphanShardCount: 0,
                invalidShardPayloadCount: 0,
                invalidShardFileNames: [],
                rewroteAllShardsFromMemory: false,
            })),
            markDictionaryReimportRequired,
        });

        const summary = await Reflect.get(database, '_cleanupMissingTermRecordShards').call(database);

        expect(deleteDictionary).not.toHaveBeenCalled();
        expect(markDictionaryReimportRequired).toHaveBeenCalledWith('JMdict', 'Dictionary record data is missing');
        expect(summary.markedReimportRequiredTitles).toEqual(['JMdict']);
        expect(summary.removedTitles).toEqual([]);
    });

    test('exposes dictionary storage health without rewriting imported summary metadata', async () => {
        const database = new DictionaryDatabase();
        const summaryJson = JSON.stringify({title: 'JMdict', revision: 'test'});
        Reflect.set(database, '_db', {selectObjects: vi.fn(() => [{summaryJson}])});
        Reflect.set(database, '_termRecordStore', {
            getDictionaryHealth: vi.fn(() => ({status: 'reimportRequired', reason: 'Dictionary record data is missing'})),
        });

        const result = await database.getDictionaryInfo();

        expect(result).toEqual([{
            title: 'JMdict',
            revision: 'test',
            storageHealth: 'reimportRequired',
            storageHealthReason: 'Dictionary record data is missing',
        }]);
        expect(summaryJson).not.toContain('storageHealth');
    });

    test('does not crash when valid JSON summary metadata has the wrong shape', async () => {
        const database = new DictionaryDatabase();
        Reflect.set(database, '_db', {
            selectObjects: vi.fn(() => [{summaryJson: 'null'}, {summaryJson: '[]'}, {summaryJson: '"invalid"'}]),
        });
        Reflect.set(database, '_termRecordStore', {
            getDictionaryHealth: vi.fn(() => ({status: 'available', reason: null})),
        });

        await expect(database.getDictionaryInfo()).resolves.toEqual([
            {storageHealth: 'available', storageHealthReason: null},
            {storageHealth: 'available', storageHealthReason: null},
            {storageHealth: 'available', storageHealthReason: null},
        ]);
    });

    test('restores durable reimport-required health across database restarts', () => {
        const database = new DictionaryDatabase();
        const exec = vi.fn();
        Reflect.set(database, '_db', {
            exec,
            selectObjects: vi.fn(() => [{title: 'JMdict', reason: 'Dictionary record data is damaged'}]),
        });

        Reflect.get(database, '_restoreTermRecordDictionaryHealth').call(database);

        expect(Reflect.get(database, '_termRecordStore').getDictionaryHealth('JMdict')).toEqual({
            status: 'reimportRequired',
            reason: 'Dictionary record data is damaged',
        });
        expect(exec).toHaveBeenCalledWith(expect.objectContaining({
            sql: expect.stringContaining('INSERT INTO dictionaryStorageHealth'),
        }));
    });

    test('clears durable dictionary health only after storage becomes available', () => {
        const database = new DictionaryDatabase();
        const exec = vi.fn();
        Reflect.set(database, '_db', {exec});
        const onHealthChanged = Reflect.get(database, '_onTermRecordDictionaryHealthChanged').bind(database);

        onHealthChanged('JMdict', 'repairing', null);
        onHealthChanged('JMdict', 'temporarilyUnavailable', 'temporary failure');
        expect(exec).not.toHaveBeenCalled();

        onHealthChanged('JMdict', 'available', null);
        expect(exec).toHaveBeenCalledWith({
            sql: 'DELETE FROM dictionaryStorageHealth WHERE title = ?',
            bind: ['JMdict'],
        });
    });
});
