/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import {afterEach, beforeAll, describe, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {log} from '../ext/js/core/log.js';

/** @type {import('@sqlite.org/sqlite-wasm').Sqlite3Static} */
let sqlite3;
/** @type {import('@sqlite.org/sqlite-wasm').Database[]} */
const connections = [];
const metadataTables = ['termMeta', 'kanji', 'kanjiMeta', 'tagMeta', 'media', 'sharedGlossaryArtifacts'];
const glossaryTables = ['termGlossaryTokens', 'termGlossarySearchTerms', 'dictionaryGlossarySearchIndex'];
const stagingTitle = 'JMdict [update-staging health-test]';

beforeAll(async () => { sqlite3 = await sqlite3InitModule(); });
afterEach(() => {
    vi.restoreAllMocks();
    for (const connection of connections.splice(0)) { connection.close(); }
});

/** @returns {{database: DictionaryDatabase, connection: import('@sqlite.org/sqlite-wasm').Database, newSummary: import('dictionary-importer').Summary}} */
function createDatabase() {
    const connection = new sqlite3.oo1.DB(':memory:');
    connections.push(connection);
    connection.exec(`
        CREATE TABLE dictionaries(id INTEGER PRIMARY KEY, title TEXT UNIQUE, version INTEGER, summaryJson TEXT);
        CREATE TABLE dictionaryStorageHealth(title TEXT PRIMARY KEY, generationId TEXT, reason TEXT);
        CREATE TABLE termEntryContent(id INTEGER PRIMARY KEY);
        CREATE TABLE terms(entryContentId INTEGER);
    `);
    for (const table of glossaryTables) {
        connection.exec(`CREATE TABLE ${table}(dictionary TEXT)`);
        connection.exec({sql: `INSERT INTO ${table} VALUES (?), (?)`, bind: ['JMdict', stagingTitle]});
    }
    const oldSummary = {title: 'JMdict', revision: 'test', version: 3, sequenced: false, styles: '', importDate: 0, prefixWildcardsSupported: true, importSuccess: true, termRecordStorageName: 'old-storage', storageGenerationId: 'old-generation'};
    const newSummary = {...oldSummary, title: stagingTitle, termRecordStorageName: 'new-storage', storageGenerationId: 'new-generation'};
    connection.exec({sql: 'INSERT INTO dictionaries VALUES (1, ?, 3, ?), (2, ?, 3, ?)', bind: [oldSummary.title, JSON.stringify(oldSummary), stagingTitle, JSON.stringify(newSummary)]});
    for (const table of metadataTables) {
        connection.exec(`CREATE TABLE ${table}(dictionary TEXT, value TEXT)`);
        connection.exec({sql: `INSERT INTO ${table} VALUES (?, ?), (?, ?)`, bind: ['JMdict', 'old', stagingTitle, 'new']});
    }
    const database = reopen(connection);
    return {database, connection, newSummary};
}

/**
 * @param {import('@sqlite.org/sqlite-wasm').Database} connection
 * @returns {DictionaryDatabase}
 */
function reopen(connection) {
    const database = new DictionaryDatabase();
    Reflect.set(database, '_db', connection);
    database._refreshTermRecordStorageNameMappings();
    database._restoreTermRecordDictionaryHealth();
    return database;
}

describe('generation-owned durable dictionary health', () => {
    test.each([null, 'JMdict'])('explicit publication retains its update receipt after reopen (replaced=%s)', async (replacedTitle) => {
        const {database, connection, newSummary} = createDatabase();
        const title = replacedTitle ?? 'Renamed';
        const stagedSummary = {...newSummary, transientUpdateStage: 'update-staging', updateSessionToken: 'stale-token'};
        connection.exec({sql: 'UPDATE dictionaries SET summaryJson = ? WHERE title = ?', bind: [JSON.stringify(stagedSummary), stagingTitle]});
        await database.replaceDictionaryTitle(stagingTitle, title, {...newSummary, title, updateSessionToken: ' current-operation '}, replacedTitle);
        const summary = (await reopen(connection).getDictionaryInfo()).find((entry) => entry.title === title);
        expect(summary).toMatchObject({title, updateSessionToken: 'current-operation', storageGenerationId: 'new-generation'});
        expect(summary).not.toHaveProperty('transientUpdateStage');
    });

    test('a healthy replacement does not inherit old quarantine on reopen', async () => {
        const {database, connection, newSummary} = createDatabase();
        Reflect.get(database, '_termRecordStore').markDictionaryReimportRequired('old-storage', 'old checksum failure');
        await database.replaceDictionaryTitle(stagingTitle, 'JMdict', {...newSummary, title: 'JMdict'}, 'JMdict');
        expect(Reflect.get(reopen(connection), '_termRecordStore').getDictionaryHealth('new-storage').status).toBe('available');
        expect(connection.selectObjects('SELECT * FROM dictionaryStorageHealth')).toEqual([]);
        for (const table of metadataTables) {
            expect(connection.selectObjects(`SELECT * FROM ${table}`)).toEqual([{dictionary: 'JMdict', value: 'new'}]);
        }
    });

    test('quarantine follows the same generation through an ordinary rename', async () => {
        const {database, connection} = createDatabase();
        Reflect.get(database, '_termRecordStore').markDictionaryReimportRequired('new-storage', 'new checksum failure');
        await database.replaceDictionaryTitle(stagingTitle, 'Renamed');
        const restarted = reopen(connection);
        expect(Reflect.get(restarted, '_termRecordStore').getDictionaryHealth('new-storage')).toEqual({status: 'reimportRequired', reason: 'new checksum failure'});
        expect(connection.selectObjects('SELECT title, generationId FROM dictionaryStorageHealth')).toEqual([{title: 'Renamed', generationId: 'new-generation'}]);
    });

    test('stale persisted health cannot quarantine a different generation with the same storage name', () => {
        const {connection} = createDatabase();
        connection.exec({sql: 'INSERT INTO dictionaryStorageHealth VALUES (?, ?, ?)', bind: ['JMdict', 'superseded-generation', 'stale failure']});
        expect(Reflect.get(reopen(connection), '_termRecordStore').getDictionaryHealth('old-storage').status).toBe('available');
    });

    test('legacy unbound health cannot quarantine a newly published generation', () => {
        const {connection} = createDatabase();
        connection.exec({sql: 'INSERT INTO dictionaryStorageHealth VALUES (?, NULL, ?)', bind: ['JMdict', 'legacy failure']});
        expect(Reflect.get(reopen(connection), '_termRecordStore').getDictionaryHealth('old-storage').status).toBe('available');
    });

    test('additive health migration preserves legacy health and is idempotent', () => {
        const connection = new sqlite3.oo1.DB(':memory:');
        connections.push(connection);
        connection.exec(`CREATE TABLE dictionaryStorageHealth(title TEXT PRIMARY KEY, reason TEXT);
            INSERT INTO dictionaryStorageHealth VALUES ('Legacy', 'checksum failure');`);
        const database = new DictionaryDatabase();
        Reflect.set(database, '_db', connection);
        database._migrateDictionaryStorageHealthSchema();
        database._migrateDictionaryStorageHealthSchema();
        expect(connection.selectObjects('SELECT * FROM dictionaryStorageHealth')).toEqual([{title: 'Legacy', reason: 'checksum failure', generationId: null}]);
    });

    test('summary overrides cannot change source physical storage or generation identity', async () => {
        const {database, connection, newSummary} = createDatabase();
        await database.replaceDictionaryTitle(stagingTitle, 'Renamed', {...newSummary, termRecordStorageName: 'wrong-storage', storageGenerationId: 'wrong-generation'});
        const row = connection.selectObject("SELECT summaryJson FROM dictionaries WHERE title = 'Renamed'");
        expect(JSON.parse(String(row?.summaryJson))).toMatchObject({termRecordStorageName: 'new-storage', storageGenerationId: 'new-generation'});
    });

    test('availability identifies the logical dictionary and generation without discarding healthy siblings', () => {
        const {database} = createDatabase();
        Reflect.get(database, '_termRecordStore').markDictionaryReimportRequired('old-storage', 'checksum failure');
        expect(database.getDictionaryAvailability(['JMdict', stagingTitle])).toEqual([{
            dictionary: 'JMdict', generationId: 'old-generation', status: 'reimportRequired', reason: 'checksum failure',
        }]);
    });

    test('a durable publication receipt survives reopen and rename but never matches by title alone', async () => {
        const {database, connection, newSummary} = createDatabase();
        const summary = {...newSummary, storageImportOperationId: 'exact-operation'};
        connection.exec({sql: 'UPDATE dictionaries SET summaryJson = ? WHERE title = ?', bind: [JSON.stringify(summary), stagingTitle]});
        expect(reopen(connection).getPublishedDictionaryImport('exact-operation')).toMatchObject({
            result: {title: stagingTitle}, outcome: {status: 'published', generationId: 'new-generation'},
        });
        expect(database.getPublishedDictionaryImport(stagingTitle)).toBeNull();
        expect(database.getPublishedDictionaryImport('other-operation')).toBeNull();
        await database.replaceDictionaryTitle(stagingTitle, 'Renamed');
        expect(reopen(connection).getPublishedDictionaryImport('exact-operation')).toMatchObject({result: {title: 'Renamed'}});
        connection.exec("UPDATE dictionaries SET summaryJson = json_set(summaryJson, '$.importSuccess', json('false')) WHERE title = 'Renamed'");
        expect(database.getPublishedDictionaryImport('exact-operation')).toBeNull();
    });

    test.each(['COMMIT', 'ROLLBACK'])('uncommitted import metadata is not a durable receipt (%s)', (terminalStatement) => {
        const {database, connection, newSummary} = createDatabase();
        connection.exec('BEGIN IMMEDIATE');
        Reflect.set(database, '_bulkImportTransactionOpen', true);
        connection.exec({sql: 'UPDATE dictionaries SET summaryJson = ? WHERE title = ?', bind: [JSON.stringify({...newSummary, storageImportOperationId: 'pending-operation'}), stagingTitle]});
        expect(database.getPublishedDictionaryImport('pending-operation')).toBeNull();
        connection.exec(terminalStatement);
        Reflect.set(database, '_bulkImportTransactionOpen', false);
        const receipt = database.getPublishedDictionaryImport('pending-operation');
        if (terminalStatement === 'COMMIT') {
            expect(receipt).toMatchObject({outcome: {status: 'published', generationId: 'new-generation'}});
        } else {
            expect(receipt).toBeNull();
        }
    });

    test('legacy implicit physical identity survives rename', async () => {
        const {database, connection} = createDatabase();
        connection.exec({sql: 'UPDATE dictionaries SET summaryJson = ? WHERE title = ?', bind: [JSON.stringify({title: stagingTitle, version: 3, importSuccess: true}), stagingTitle]});
        database._refreshTermRecordStorageNameMappings();
        await database.replaceDictionaryTitle(stagingTitle, 'Renamed');
        const restarted = reopen(connection);
        expect(restarted._getTermRecordStorageName('Renamed')).toBe(stagingTitle);
    });

    test('physical mapping collisions reject before committing any rename', async () => {
        const {database, connection, newSummary} = createDatabase();
        connection.exec({sql: 'UPDATE dictionaries SET summaryJson = ? WHERE title = ?', bind: [JSON.stringify({...newSummary, termRecordStorageName: 'old-storage'}), stagingTitle]});
        await expect(database.replaceDictionaryTitle(stagingTitle, 'Renamed')).rejects.toThrow('Term-record storage name collision');
        expect(connection.selectValue("SELECT COUNT(*) FROM dictionaries WHERE title = 'Renamed'")).toBe(0);
        expect(connection.selectValue('SELECT COUNT(*) FROM dictionaries WHERE title = ?', [stagingTitle])).toBe(1);
        for (const table of metadataTables) {
            expect(connection.selectValue(`SELECT COUNT(*) FROM ${table} WHERE dictionary = ?`, [stagingTitle])).toBe(1);
        }
    });

    test('both metadata renames and health changes roll back together', async () => {
        const {database, connection, newSummary} = createDatabase();
        Reflect.get(database, '_termRecordStore').markDictionaryReimportRequired('old-storage', 'old checksum failure');
        const beforeRows = connection.selectObjects('SELECT * FROM dictionaries ORDER BY id');
        const beforeHealth = connection.selectObjects('SELECT * FROM dictionaryStorageHealth');
        const exec = connection.exec.bind(connection);
        vi.spyOn(connection, 'exec').mockImplementation((value, ...args) => {
            if (/** @type {unknown} */ (value) === 'COMMIT') { throw new Error('injected cutover failure'); }
            return exec(value, ...args);
        });
        await expect(database.replaceDictionaryTitle(stagingTitle, 'JMdict', {...newSummary, title: 'JMdict'}, 'JMdict')).rejects.toThrow('injected cutover failure');
        expect(connection.selectObjects('SELECT * FROM dictionaries ORDER BY id')).toEqual(beforeRows);
        expect(connection.selectObjects('SELECT * FROM dictionaryStorageHealth')).toEqual(beforeHealth);
        for (const table of metadataTables) {
            expect(connection.selectObjects(`SELECT * FROM ${table}`)).toEqual([{dictionary: 'JMdict', value: 'old'}, {dictionary: stagingTitle, value: 'new'}]);
        }
        for (const table of glossaryTables) {
            expect(connection.selectValues(`SELECT dictionary FROM ${table}`)).toEqual(['JMdict', stagingTitle]);
        }
        expect(database._getTermRecordStorageName('JMdict')).toBe('old-storage');
    });

    test('failed physical cleanup retains the old generation health without affecting the replacement', async () => {
        const {database, connection, newSummary} = createDatabase();
        Reflect.get(database, '_termRecordStore').markDictionaryReimportRequired('old-storage', 'old checksum failure');
        vi.spyOn(database, 'deleteDictionary').mockRejectedValue(new Error('storage busy'));
        vi.spyOn(log, 'warn').mockImplementation(() => { throw new Error('logger failed'); });
        await database.replaceDictionaryTitle(stagingTitle, 'JMdict', {...newSummary, title: 'JMdict'}, 'JMdict');
        const restarted = reopen(connection);
        expect(Reflect.get(restarted, '_termRecordStore').getDictionaryHealth('new-storage').status).toBe('available');
        expect(Reflect.get(restarted, '_termRecordStore').getDictionaryHealth('old-storage').status).toBe('reimportRequired');
    });
});
