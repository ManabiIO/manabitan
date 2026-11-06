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

test.each([11, -1])('startup refuses schema %s before old SQL or OPFS initialization', async (version) => {
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
    vi.spyOn(database, '_recoverInterruptedImportSession').mockResolvedValue();
    vi.spyOn(database, '_restoreTermRecordDictionaryHealth').mockImplementation(() => {});
    await expect(database._openConnection()).rejects.toThrow(/schema.*(?:newer|invalid)/iu);
    expect(contentPrepare).not.toHaveBeenCalled();
    expect(recordPrepare).not.toHaveBeenCalled();
    expect(initialize).not.toHaveBeenCalled();
    expect(pragmas).not.toHaveBeenCalled();
    expect(connection.selectValue('PRAGMA user_version')).toBe(version);
    expect(connection.selectValues('SELECT value FROM newer_storage')).toEqual(['preserved']);
    expect(connection.selectValues("SELECT name FROM sqlite_master WHERE type = 'table'")).toEqual(['newer_storage']);
});
