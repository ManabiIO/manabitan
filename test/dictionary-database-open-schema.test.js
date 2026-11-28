/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import {afterEach, beforeAll, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {getSqlite3, openOpfsDatabase} from '../ext/js/dictionary/sqlite-wasm.js';

vi.mock('../ext/js/dictionary/sqlite-wasm.js', async (importOriginal) => ({
    .../** @type {typeof import('../ext/js/dictionary/sqlite-wasm.js')} */(await importOriginal()),
    getSqlite3: vi.fn(),
    openOpfsDatabase: vi.fn(),
}));

/** @type {import('@sqlite.org/sqlite-wasm').Sqlite3Static} */
let sqlite3;
/** @type {import('@sqlite.org/sqlite-wasm').Database[]} */
const connections = [];
beforeAll(async () => { sqlite3 = await sqlite3InitModule(); });
afterEach(() => {
    vi.restoreAllMocks();
    for (const connection of connections.splice(0)) { connection.close(); }
});

test.each([13, -1])('startup refuses schema %s before old SQL or OPFS initialization', async (version) => {
    const connection = new sqlite3.oo1.DB(':memory:');
    connections.push(connection);
    connection.exec(`PRAGMA user_version = ${version}`);
    connection.exec('CREATE TABLE newer_storage(value TEXT)');
    connection.exec("INSERT INTO newer_storage VALUES ('preserved')");
    vi.mocked(getSqlite3).mockResolvedValue(sqlite3);
    vi.mocked(openOpfsDatabase).mockResolvedValue(connection);
    const database = new DictionaryDatabase();
    const contentPrepare = vi.spyOn(database._termContentStore, 'prepare').mockResolvedValue();
    const recordPrepare = vi.spyOn(database._termRecordStore, 'prepare').mockResolvedValue();
    const initialize = vi.spyOn(database, '_initializeSchema').mockImplementation(async () => {
        connection.exec('CREATE TABLE old_build_initialized(value TEXT)');
    });
    const pragmas = vi.spyOn(database, '_applyRuntimePragmas').mockImplementation(() => {});
    const recover = vi.spyOn(database, '_recoverInterruptedImportSession').mockResolvedValue();
    const resumePurge = vi.spyOn(database, '_resumePersistentDictionaryPurge').mockResolvedValue(false);
    vi.spyOn(database, '_restoreTermRecordDictionaryHealth').mockImplementation(() => {});
    await expect(database._openConnection()).rejects.toThrow(/schema.*(?:newer|invalid)/iu);
    expect(contentPrepare).not.toHaveBeenCalled();
    expect(recordPrepare).not.toHaveBeenCalled();
    expect(initialize).not.toHaveBeenCalled();
    expect(pragmas).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    expect(resumePurge).not.toHaveBeenCalled();
    expect(connection.selectValue('PRAGMA user_version')).toBe(version);
    expect(connection.selectValues('SELECT value FROM newer_storage')).toEqual(['preserved']);
    expect(connection.selectValues("SELECT name FROM sqlite_master WHERE type = 'table'")).toEqual(['newer_storage']);
});

test('keeps ordinary dictionaries at schema 10 and accepts a published packed-media schema', async () => {
    const connection = new sqlite3.oo1.DB(':memory:');
    connections.push(connection);
    connection.exec('PRAGMA user_version = 10');
    connection.exec('CREATE TABLE preserved(value TEXT)');
    connection.exec("INSERT INTO preserved VALUES ('text')");
    const database = new DictionaryDatabase();
    Reflect.set(database, '_db', connection);
    await database._runSchemaMigrations();
    expect(connection.selectValue('PRAGMA user_version')).toBe(10);

    connection.exec('BEGIN');
    connection.exec('PRAGMA user_version = 11');
    connection.exec('ROLLBACK');
    expect(connection.selectValue('PRAGMA user_version')).toBe(10);

    connection.exec('BEGIN');
    connection.exec('PRAGMA user_version = 11');
    connection.exec('COMMIT');
    expect(database._getSupportedInstalledSchemaVersion()).toBe(11);
    await database._runSchemaMigrations();
    expect(connection.selectValue('PRAGMA user_version')).toBe(11);
    expect(connection.selectValues('SELECT value FROM preserved')).toEqual(['text']);
});


test.each([[10, 1], [11, 1], [12, 0]])('rejects schema %s with incompatible root epoch %s before recovery', async (version, epoch) => {
    const connection = new sqlite3.oo1.DB(':memory:');
    connections.push(connection);
    connection.exec(`PRAGMA user_version = ${version}`);
    connection.exec('CREATE TABLE termContentStorageState(singleton INTEGER PRIMARY KEY, activeEpoch INTEGER, logicalHighWater INTEGER)');
    connection.exec({sql: 'INSERT INTO termContentStorageState VALUES (1, ?, 32)', bind: [epoch]});
    vi.mocked(getSqlite3).mockResolvedValue(sqlite3);
    vi.mocked(openOpfsDatabase).mockResolvedValue(connection);
    const database = new DictionaryDatabase();
    const recover = vi.spyOn(database, '_recoverInterruptedImportSession').mockResolvedValue();
    const resumePurge = vi.spyOn(database, '_resumePersistentDictionaryPurge').mockResolvedValue(false);
    await expect(database._openConnection()).rejects.toThrow(/schema version and immutable content root disagree/);
    expect(recover).not.toHaveBeenCalled();
    expect(resumePurge).not.toHaveBeenCalled();
});

test('packed-media publication cannot lower a committed online-content format gate', async () => {
    const connection = new sqlite3.oo1.DB(':memory:');
    connections.push(connection);
    connection.exec('PRAGMA user_version = 11');
    const database = new DictionaryDatabase();
    Reflect.set(database, '_db', connection);

    connection.exec('BEGIN');
    database._raiseDictionaryStorageVersion(12);
    expect(connection.selectValue('PRAGMA user_version')).toBe(12);
    connection.exec('ROLLBACK');
    expect(connection.selectValue('PRAGMA user_version')).toBe(11);

    connection.exec('BEGIN');
    database._raiseDictionaryStorageVersion(12);
    connection.exec('COMMIT');

    connection.exec('BEGIN');
    database._raiseDictionaryStorageVersion(11);
    connection.exec('COMMIT');
    await database._runSchemaMigrations();
    expect(connection.selectValue('PRAGMA user_version')).toBe(12);
});
