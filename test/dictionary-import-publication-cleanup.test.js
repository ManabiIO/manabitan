/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import {afterEach, beforeAll, describe, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {DictionaryImportSession} from '../ext/js/dictionary/dictionary-import-session.js';

/** @type {import('@sqlite.org/sqlite-wasm').Sqlite3Static} */
let sqlite3;
/** @type {import('@sqlite.org/sqlite-wasm').Database[]} */
const connections = [];

beforeAll(async () => {
    sqlite3 = await sqlite3InitModule();
});

afterEach(() => {
    for (const connection of connections.splice(0)) { connection.close(); }
});

/** @returns {Promise<void>} */
async function resolveVoid() {}

/** @returns {{database: DictionaryDatabase, connection: import('@sqlite.org/sqlite-wasm').Database}} */
function createDatabase() {
    const connection = new sqlite3.oo1.DB(':memory:');
    connections.push(connection);
    connection.exec(`
        CREATE TABLE dictionaries(id INTEGER PRIMARY KEY, title TEXT, version INTEGER, summaryJson TEXT);
        CREATE TABLE termEntryContent(id INTEGER PRIMARY KEY);
        CREATE TABLE dictionaryImportPublications(sessionId TEXT PRIMARY KEY, publishedAt INTEGER);
    `);
    const database = new DictionaryDatabase();
    Reflect.set(database, '_db', connection);
    Reflect.set(database, '_createIndexesSql', () => []);
    Reflect.set(database, '_applyRuntimePragmas', () => {});
    Reflect.set(database, '_applyImportPragmas', () => {});
    Reflect.set(database, '_createDropIndexesSql', () => []);
    Reflect.set(database, '_importJournal', {clear: vi.fn(resolveVoid), write: vi.fn(resolveVoid)});
    for (const key of ['_termContentStore', '_termRecordStore']) {
        Reflect.set(database, key, {
            createImportCheckpoint: vi.fn(async () => (key === '_termContentStore' ? {segments: []} : {shards: []})),
            beginImportSession: vi.fn(resolveVoid),
            endImportSession: vi.fn(resolveVoid),
            getLastEndImportSessionMetrics: () => null,
            rollbackImportSession: vi.fn(resolveVoid),
        });
    }
    return {database, connection};
}

/**
 * @param {import('@sqlite.org/sqlite-wasm').Database} connection
 * @param {number} id
 * @param {unknown} value
 */
function insertSummary(connection, id, value) {
    connection.exec({
        sql: 'INSERT INTO dictionaries VALUES (?, ?, 3, ?)',
        bind: [id, `Dictionary ${id}`, JSON.stringify(value)],
    });
}

/**
 * @param {DictionaryDatabase} database
 * @param {Error[]} errors
 * @returns {DictionaryImportSession}
 */
function createSession(database, errors) {
    return new DictionaryImportSession({
        dictionaryDatabase: database,
        dictionaryTitle: 'Dictionary 42',
        dictionarySummaryPrimaryKey: 42,
        errors,
        archiveReader: {close: resolveVoid},
        disposeParser: resolveVoid,
    });
}

/**
 * @param {DictionaryDatabase} database
 * @param {import('@sqlite.org/sqlite-wasm').Database} connection
 */
function activateImport(database, connection) {
    connection.exec('BEGIN IMMEDIATE');
    Reflect.set(database, '_bulkImportState', 'active');
    Reflect.set(database, '_bulkImportTransactionOpen', true);
    Reflect.set(database, '_bulkImportJournalRecord', {
        version: 1,
        sessionId: 'publication-cleanup-test',
        createdAt: 0,
        contentCheckpoint: {segments: []},
        recordCheckpoint: {shards: []},
    });
}

const summary = /** @type {import('dictionary-importer').Summary} */ ({
    title: 'Dictionary 42', version: 3, importSuccess: true,
});

describe('committed dictionary cleanup uses real SQLite metadata', () => {
    test.each([
        {importSuccess: true},
        {},
        {importSuccess: null},
        {importSuccess: 'false'},
        {importSuccess: 0},
        {nested: {importSuccess: false}},
    ])('does not delete a summary that is not an explicit placeholder: %j', async (value) => {
        const {database, connection} = createDatabase();
        insertSummary(connection, 42, value);
        await database.deleteDictionaryImportPlaceholder(42);
        expect(connection.selectValue('SELECT COUNT(*) FROM dictionaries WHERE id = 42')).toBe(1);
    });

    test('removes only the requested explicit false placeholder', async () => {
        const {database, connection} = createDatabase();
        insertSummary(connection, 42, {importSuccess: false});
        insertSummary(connection, 43, {importSuccess: false});
        insertSummary(connection, 44, {importSuccess: true});
        await database.deleteDictionaryImportPlaceholder(42);
        await database.deleteDictionaryImportPlaceholder(42);
        expect(connection.selectValues('SELECT id FROM dictionaries ORDER BY id')).toEqual([43, 44]);
    });

    test('fails closed for unreadable summary JSON', async () => {
        const {database, connection} = createDatabase();
        connection.exec("INSERT INTO dictionaries VALUES (42, 'Dictionary 42', 3, '{invalid')");
        await expect(database.deleteDictionaryImportPlaceholder(42)).rejects.toThrow();
        expect(connection.selectValue('SELECT COUNT(*) FROM dictionaries')).toBe(1);
        connection.exec('BEGIN IMMEDIATE');
        connection.exec('ROLLBACK');
    });

    test('does not join or commit a transaction owned by another operation', async () => {
        const {database, connection} = createDatabase();
        insertSummary(connection, 42, {importSuccess: false});
        connection.exec('BEGIN IMMEDIATE');
        insertSummary(connection, 43, {importSuccess: true});
        await expect(database.deleteDictionaryImportPlaceholder(42)).rejects.toThrow();
        connection.exec('ROLLBACK');
        expect(connection.selectValues('SELECT id FROM dictionaries ORDER BY id')).toEqual([42]);
    });

    test.each([
        ['_bulkImportState', 'active'],
        ['_bulkImportState', 'finalizing'],
        ['_isOpening', true],
        ['_closingPromise', Promise.resolve()],
        ['_purgingPromise', Promise.resolve()],
        ['_importJournalRecoveryPending', true],
    ])('does not clean up while lifecycle ownership is held: %s=%s', async (key, value) => {
        const {database, connection} = createDatabase();
        insertSummary(connection, 42, {importSuccess: false});
        Reflect.set(database, /** @type {string} */ (key), value);
        await expect(database.deleteDictionaryImportPlaceholder(42)).rejects.toThrow();
        expect(connection.selectValue('SELECT COUNT(*) FROM dictionaries')).toBe(1);
    });

    test.each(['runtime', 'block-close'])('preserves a real COMMIT after %s housekeeping fails', async (failurePoint) => {
        const {database, connection} = createDatabase();
        insertSummary(connection, 42, {importSuccess: false});

        const deletion = vi.spyOn(database, 'deleteDictionary').mockImplementation(async () => {
            connection.exec('DELETE FROM dictionaries WHERE id = 42');
        });
        const housekeepingError = new Error(`injected ${failurePoint} failure`);
        if (failurePoint === 'runtime') {
            Reflect.set(database, '_applyRuntimePragmas', () => { throw housekeepingError; });
        }
        const errors = /** @type {Error[]} */ ([]);
        const session = createSession(database, errors);
        await session.startBulkImport();
        if (failurePoint === 'block-close') {
            Reflect.set(database, '_termContentBlockImportSession', {close() { throw housekeepingError; }});
        }
        expect(await session.finalizeBulkImport(() => {}, summary)).toBeNull();
        // Publication really committed before the late error was returned.
        expect(connection.selectValue("SELECT json_extract(summaryJson, '$.importSuccess') FROM dictionaries WHERE id = 42")).toBe(1);
        await session.cleanupIncompleteSummary();
        expect(deletion).not.toHaveBeenCalled();
        expect(connection.selectValue('SELECT COUNT(*) FROM dictionaries WHERE id = 42')).toBe(1);
        expect(session.failed).toBe(true);
        expect(errors.length).toBeGreaterThan(0);
    });
});

describe('session finalization cannot steal another import', () => {
    test('a rejected start does not abort the active owner', async () => {
        const {database, connection} = createDatabase();
        insertSummary(connection, 42, {importSuccess: false});
        activateImport(database, connection);
        insertSummary(connection, 43, {importSuccess: true});
        const abort = vi.spyOn(database, 'abortBulkImport');
        const session = createSession(database, []);
        await expect(session.startBulkImport()).rejects.toThrow('already active');
        await session.finalizeBulkImport(() => {}, summary);
        await session.cleanupIncompleteSummary();
        expect(abort).not.toHaveBeenCalled();
        expect(Reflect.get(database, '_bulkImportState')).toBe('active');
        connection.exec('ROLLBACK');
        expect(connection.selectValues('SELECT id FROM dictionaries')).toEqual([42]);
    });

    test('a never-started finalizer does not publish the active owner', async () => {
        const {database, connection} = createDatabase();
        activateImport(database, connection);
        const finish = vi.spyOn(database, 'finishBulkImport');
        const session = createSession(database, []);
        await session.finalizeBulkImport(() => {}, summary);
        expect(finish).not.toHaveBeenCalled();
        expect(session.failed).toBe(true);
        expect(Reflect.get(database, '_bulkImportState')).toBe('active');
    });

    test('does not acquire storage ownership after finalization already ran', async () => {
        const {database} = createDatabase();
        const start = vi.spyOn(database, 'startBulkImport');
        const session = createSession(database, []);
        await session.finalizeBulkImport(() => {}, summary);
        await expect(session.startBulkImport()).rejects.toThrow();
        expect(start).not.toHaveBeenCalled();
    });

    test.each(['commit', 'abort'])('rejects a former owner trying to %s its replacement', async (operation) => {
        const {database, connection} = createDatabase();
        insertSummary(connection, 42, {importSuccess: false});
        const errors = /** @type {Error[]} */ ([]);
        const session = createSession(database, errors);
        await session.startBulkImport();
        const firstId = Reflect.get(database, '_bulkImportJournalRecord')?.sessionId;
        await database.abortBulkImport();
        const replacementId = await database.startBulkImport();
        expect(replacementId).not.toBe(firstId);
        insertSummary(connection, 43, {importSuccess: false});
        if (operation === 'abort') { session.recordFailure(new Error('obsolete parse failure')); }

        expect(await session.finalizeBulkImport(() => {}, summary)).toBeNull();
        await session.cleanupIncompleteSummary();
        expect(errors.some(({message}) => message.includes('ownership changed'))).toBe(true);
        expect(Reflect.get(database, '_bulkImportState')).toBe('active');
        expect(Reflect.get(database, '_bulkImportJournalRecord')?.sessionId).toBe(replacementId);
        expect(connection.selectValue('SELECT COUNT(*) FROM dictionaryImportPublications')).toBe(0);
        expect(connection.selectValue("SELECT json_type(summaryJson, '$.importSuccess') FROM dictionaries WHERE id = 42")).toBe('false');
        await database.abortBulkImport(replacementId);
        expect(connection.selectValues('SELECT id FROM dictionaries')).toEqual([42]);
    });

    test.each(['', 'different-session'])('rejects invalid owner %j without changing the live transaction', async (invalidId) => {
        const {database, connection} = createDatabase();
        const ownerId = await database.startBulkImport();
        insertSummary(connection, 43, {importSuccess: false});
        await expect(database.finishBulkImport(null, null, invalidId)).rejects.toThrow('ownership changed');
        await expect(database.abortBulkImport(invalidId)).rejects.toThrow('ownership changed');
        expect(Reflect.get(database, '_bulkImportState')).toBe('active');
        expect(Reflect.get(database, '_bulkImportJournalRecord')?.sessionId).toBe(ownerId);
        await database.abortBulkImport(ownerId);
        expect(connection.selectValue('SELECT COUNT(*) FROM dictionaries')).toBe(0);
    });

    test('the acquired owner publishes once with its matching identity', async () => {
        const {database, connection} = createDatabase();
        insertSummary(connection, 42, {importSuccess: false});
        const session = createSession(database, []);
        await session.startBulkImport();
        const ownerId = Reflect.get(database, '_bulkImportJournalRecord')?.sessionId;
        expect(ownerId).toEqual(expect.any(String));
        const result = await session.finalizeBulkImport(() => {}, summary);
        expect(result).not.toBeNull();
        expect(session.state).toBe('published');
        expect(session.failed).toBe(false);
        expect(await session.finalizeBulkImport(() => {}, summary)).toBe(result);
        await session.cleanupIncompleteSummary();
        expect(connection.selectValue("SELECT json_type(summaryJson, '$.importSuccess') FROM dictionaries WHERE id = 42")).toBe('true');
    });

    test('the acquired owner rolls back failed parsing and cleans only its placeholder', async () => {
        const {database, connection} = createDatabase();
        insertSummary(connection, 42, {importSuccess: false});
        insertSummary(connection, 44, {importSuccess: true});
        const errors = /** @type {Error[]} */ ([]);
        const session = createSession(database, errors);
        await session.startBulkImport();
        insertSummary(connection, 43, {importSuccess: false});
        const parseError = new Error('parse failed');
        session.recordFailure(parseError);
        expect(await session.finalizeBulkImport(() => {}, summary)).toEqual({aborted: true});
        await session.cleanupIncompleteSummary();
        expect(errors).toEqual([parseError]);
        expect(connection.selectValues('SELECT id FROM dictionaries')).toEqual([44]);
    });

    test('pre-commit sealing failure still rolls back tentative rows and removes its placeholder', async () => {
        const {database, connection} = createDatabase();
        insertSummary(connection, 42, {importSuccess: false});
        insertSummary(connection, 44, {importSuccess: true});
        const session = createSession(database, []);
        await session.startBulkImport();
        insertSummary(connection, 43, {importSuccess: false});
        vi.spyOn(Reflect.get(database, '_termContentStore'), 'endImportSession').mockRejectedValue(new Error('content sealing failed'));
        expect(await session.finalizeBulkImport(() => {}, summary)).toBeNull();
        await session.cleanupIncompleteSummary();
        expect(session.failed).toBe(true);
        expect(connection.selectValues('SELECT id FROM dictionaries')).toEqual([44]);
    });

    test('cleanup is blocked while a recovery journal still owns storage', async () => {
        const {database, connection} = createDatabase();
        insertSummary(connection, 42, {importSuccess: false});
        Reflect.set(database, '_bulkImportJournalRecord', {sessionId: 'unrecovered-session'});
        await expect(database.deleteDictionaryImportPlaceholder(42)).rejects.toThrow();
        expect(connection.selectValue('SELECT COUNT(*) FROM dictionaries')).toBe(1);
    });

    test('does not start an import after resources were disposed independently', async () => {
        const {database} = createDatabase();
        const start = vi.spyOn(database, 'startBulkImport');
        const session = createSession(database, []);
        await session.disposeImportResources();
        await expect(session.startBulkImport()).rejects.toThrow();
        expect(start).not.toHaveBeenCalled();
    });
});
