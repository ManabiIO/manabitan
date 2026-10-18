/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import {afterEach, beforeAll, describe, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';

/** @type {import('@sqlite.org/sqlite-wasm').Sqlite3Static} */
let sqlite3;
/** @type {import('@sqlite.org/sqlite-wasm').Database[]} */
const connections = [];
const originalTitle = 'JMdict';
const backupTitle = `${originalTitle} [replaced recovery-token]`;
const metadataTables = ['termMeta', 'kanji', 'kanjiMeta', 'tagMeta', 'media', 'sharedGlossaryArtifacts'];

beforeAll(async () => { sqlite3 = await sqlite3InitModule(); });
afterEach(() => {
    vi.restoreAllMocks();
    for (const connection of connections.splice(0)) { connection.close(); }
});

/**
 * @param {string} invalidSummary
 * @returns {{database: DictionaryDatabase, connection: import('@sqlite.org/sqlite-wasm').Database, deleteRecords: import('vitest').MockInstance}}
 */
function createRecoveryDatabase(invalidSummary) {
    const connection = new sqlite3.oo1.DB(':memory:');
    connections.push(connection);
    connection.exec('CREATE TABLE dictionaries(id INTEGER PRIMARY KEY, title TEXT UNIQUE, version INTEGER, summaryJson TEXT)');
    connection.exec('CREATE TABLE dictionaryStorageHealth(title TEXT PRIMARY KEY, generationId TEXT, reason TEXT)');
    for (const table of ['termGlossaryTokens', 'termGlossarySearchTerms', 'dictionaryGlossarySearchIndex']) {
        connection.exec(`CREATE TABLE ${table}(dictionary TEXT)`);
    }
    for (const table of metadataTables) {
        connection.exec(`CREATE TABLE ${table}(dictionary TEXT, value TEXT)`);
        connection.exec({sql: `INSERT INTO ${table} VALUES (?, ?), (?, ?), (?, ?)`,
            bind: [
                originalTitle, 'invalid-new', backupTitle, 'valid-old', 'Other', 'other',
            ]});
    }
    connection.exec({sql: 'INSERT INTO dictionaries VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)',
        bind: [
            1,
            originalTitle,
            3,
            invalidSummary,
            2,
            backupTitle,
            3,
            JSON.stringify({
                title: backupTitle,
                version: 3,
                importSuccess: true,
                termRecordStorageName: 'immutable-old',
                transientUpdateStage: 'replaced',
                updateSessionToken: 'recovery-token',
            }),
            3,
            'Other',
            3,
            JSON.stringify({title: 'Other', importSuccess: true}),
        ]});
    const database = new DictionaryDatabase();
    Reflect.set(database, '_db', connection);
    const deleteRecords = vi.spyOn(Reflect.get(database, '_termRecordStore'), 'deleteByDictionary');
    return {database, connection, deleteRecords};
}

/** @param {import('@sqlite.org/sqlite-wasm').Database} connection */
function expectRestored(connection) {
    expect(connection.selectValues('SELECT title FROM dictionaries ORDER BY id')).toEqual([originalTitle, 'Other']);
    const summary = JSON.parse(String(connection.selectValue('SELECT summaryJson FROM dictionaries WHERE id = 2')));
    expect(summary).toMatchObject({title: originalTitle, importSuccess: true, termRecordStorageName: 'immutable-old'});
    expect(summary).not.toHaveProperty('transientUpdateStage');
    expect(summary).not.toHaveProperty('updateSessionToken');
    for (const table of metadataTables) {
        expect(connection.selectObjects(`SELECT * FROM ${table} ORDER BY dictionary`)).toEqual([
            {dictionary: originalTitle, value: 'valid-old'}, {dictionary: 'Other', value: 'other'},
        ]);
    }
}

describe('startup recovery preserves authoritative backup storage', () => {
    test.each(['{invalid', JSON.stringify({importSuccess: false, termRecordStorageName: 'immutable-old'})])('restores over invalid replacement metadata with real SQLite: %s', async (invalidSummary) => {
        const {database, connection, deleteRecords} = createRecoveryDatabase(invalidSummary);
        database._refreshTermRecordStorageNameMappings();
        const report = await database._cleanupIncompleteImports();
        expect(report.restoredTitles).toEqual([originalTitle]);
        expect(report.failedTitles).toEqual([]);
        expect(deleteRecords).not.toHaveBeenCalled();
        expectRestored(connection);
        const secondReport = await database._cleanupIncompleteImports();
        expect(secondReport.restoredTitles).toEqual([]);
        expect(deleteRecords).not.toHaveBeenCalled();
    });

    test('rolls back metadata discard on COMMIT failure and retries without deleting records', async () => {
        const {database, connection, deleteRecords} = createRecoveryDatabase('{invalid');
        const exec = connection.exec.bind(connection);
        const injected = vi.spyOn(connection, 'exec').mockImplementation((value, ...args) => {
            if (/** @type {unknown} */ (value) === 'COMMIT') { throw new Error('injected commit failure'); }
            return exec(value, ...args);
        });
        const report = await database._cleanupIncompleteImports();
        expect(report.failedTitles).toEqual([backupTitle]);
        expect(connection.selectValues('SELECT title FROM dictionaries ORDER BY id')).toEqual([originalTitle, backupTitle, 'Other']);
        for (const table of metadataTables) {
            expect(connection.selectValue(`SELECT COUNT(*) FROM ${table}`)).toBe(3);
        }
        expect(deleteRecords).not.toHaveBeenCalled();
        injected.mockRestore();
        await database._cleanupIncompleteImports();
        expectRestored(connection);
        expect(deleteRecords).not.toHaveBeenCalled();
    });

    test('retains the backup after failed rename and restores it on the next startup', async () => {
        const {database, connection, deleteRecords} = createRecoveryDatabase('{invalid');
        const rename = vi.spyOn(database, 'replaceDictionaryTitle').mockRejectedValue(new Error('rename unavailable'));
        const report = await database._cleanupIncompleteImports();
        expect(report.failedTitles).toEqual([backupTitle]);
        expect(connection.selectValues('SELECT title FROM dictionaries ORDER BY id')).toEqual([backupTitle, 'Other']);
        expect(deleteRecords).not.toHaveBeenCalled();
        rename.mockRestore();
        await database._cleanupIncompleteImports();
        expectRestored(connection);
        expect(deleteRecords).not.toHaveBeenCalled();
    });
});
