/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import {afterEach, beforeAll, describe, expect, test, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';

/** @type {import('@sqlite.org/sqlite-wasm').Sqlite3Static} */
let sqlite3;
/** @type {import('@sqlite.org/sqlite-wasm').Database[]} */
const connections = [];
const dataTables = ['termMeta', 'kanji', 'kanjiMeta', 'tagMeta', 'media', 'sharedGlossaryArtifacts', 'termGlossaryTokens', 'termGlossarySearchTerms', 'dictionaryGlossarySearchIndex'];
const upgradeReason = 'Dictionary storage was upgraded. Download or import this dictionary again.';

beforeAll(async () => { sqlite3 = await sqlite3InitModule(); });
afterEach(() => {
    vi.restoreAllMocks();
    for (const connection of connections.splice(0)) { connection.close(); }
});

/**
 * @param {import('@sqlite.org/sqlite-wasm').Database} connection
 * @returns {{database: DictionaryDatabase, records: import('../ext/js/dictionary/term-record-opfs-store.js').TermRecordOpfsStore, contentReset: import('vitest').MockInstance, recordReset: import('vitest').MockInstance}}
 */
function reopen(connection) {
    const database = new DictionaryDatabase();
    Reflect.set(database, '_db', connection);
    // Keep actual health ownership/callback behavior; only persistent reset I/O
    // is injected. Browser qualification covers real old/new OPFS packages.
    const contentReset = vi.spyOn(Reflect.get(database, '_termContentStore'), 'reset').mockResolvedValue();
    const records = Reflect.get(database, '_termRecordStore');
    const recordReset = vi.spyOn(records, 'reset').mockResolvedValue();
    return {database, records, contentReset, recordReset};
}

function createDatabase() {
    const connection = new sqlite3.oo1.DB(':memory:');
    connections.push(connection);
    connection.exec(`
        PRAGMA user_version = 5;
        CREATE TABLE dictionaries(id INTEGER PRIMARY KEY, title TEXT UNIQUE, version INTEGER, summaryJson TEXT);
        CREATE TABLE dictionaryStorageHealth(title TEXT PRIMARY KEY, generationId TEXT, reason TEXT);
        CREATE TABLE termEntryContent(id INTEGER PRIMARY KEY);
        CREATE TABLE terms(entryContentId INTEGER);
        CREATE TABLE dictionaryImportPublications(sessionId TEXT PRIMARY KEY, publishedAt INTEGER);
        INSERT INTO termEntryContent VALUES (1);
    `);
    for (const table of dataTables) {
        connection.exec(`CREATE TABLE ${table}(dictionary TEXT, value TEXT)`);
        connection.exec({sql: `INSERT INTO ${table} VALUES ('Main', 'old-data')`});
    }
    const summary = {
        title: 'Main',
        version: 3,
        revision: 'published',
        importSuccess: true,
        termRecordStorageName: 'old-physical-name',
        storageGenerationId: 'old-generation',
        storageImportOperationId: 'old-operation',
        downloadUrl: 'https://example.com/main.zip',
        sequenced: true,
        styles: '.definition {color: red}',
        importDate: 1,
        prefixWildcardsSupported: true,
        counts: {terms: {total: 3}, termMeta: {}, kanji: {total: 0}, kanjiMeta: {}, tagMeta: {total: 0}, media: {total: 0}},
    };
    connection.exec({sql: 'INSERT INTO dictionaries VALUES (1, ?, 3, ?)', bind: [summary.title, JSON.stringify(summary)]});
    return {connection, summary, ...reopen(connection)};
}

function assertMigrationHealth(/** @type {import('@sqlite.org/sqlite-wasm').Database} */ connection) {
    expect(connection.selectObjects('SELECT * FROM dictionaryStorageHealth')).toEqual([
        {title: 'Main', generationId: 'old-generation', reason: upgradeReason},
    ]);
}

describe('dictionary schema upgrade inventory recovery', () => {
    test('schema 5 to 10 retains metadata and source URL, quarantines old content, and removes its operation receipt', async () => {
        const {database, connection, summary, contentReset, recordReset} = createDatabase();
        await database._runSchemaMigrations();
        expect(connection.selectValue('PRAGMA user_version')).toBe(10);
        expect(contentReset).toHaveBeenCalledTimes(5);
        expect(recordReset).toHaveBeenCalledTimes(5);
        const {storageImportOperationId: _receipt, ...retainedSummary} = summary;
        expect(JSON.parse(String(connection.selectValue('SELECT summaryJson FROM dictionaries')))).toEqual(retainedSummary);
        expect(database.getPublishedDictionaryImport('old-operation')).toBeNull();
        assertMigrationHealth(connection);
        for (const table of [...dataTables, 'termEntryContent']) {
            expect(connection.selectValue(`SELECT COUNT(*) FROM ${table}`)).toBe(0);
        }
        // Real startup restores health before a second mapping refresh. A
        // physical name must not become a new logical-title health row.
        const restarted = reopen(connection);
        restarted.database._restoreTermRecordDictionaryHealth();
        expect(await restarted.database.getDictionaryInfo()).toMatchObject([
            {title: 'Main', downloadUrl: summary.downloadUrl, storageHealth: 'reimportRequired', storageHealthReason: upgradeReason},
        ]);
        expect(restarted.records.isDictionaryAvailable('old-physical-name')).toBe(false);
        assertMigrationHealth(connection);
        await restarted.database._cleanupIncompleteImports();
        await restarted.database._cleanupMissingTermRecordShards();
        assertMigrationHealth(connection);
        await restarted.database._runSchemaMigrations();
        expect(restarted.contentReset).not.toHaveBeenCalled();
        expect(restarted.recordReset).not.toHaveBeenCalled();
    });

    test('legacy implicit storage identity survives migration and restart', async () => {
        const {database, connection, summary} = createDatabase();
        const {termRecordStorageName: _physical, storageGenerationId: _generation, ...legacy} = summary;
        connection.exec({sql: 'UPDATE dictionaries SET summaryJson = ?', bind: [JSON.stringify(legacy)]});
        await database._runSchemaMigrations();
        const restarted = reopen(connection);
        restarted.database._restoreTermRecordDictionaryHealth();
        expect(restarted.records.getDictionaryHealth('Main')).toEqual({status: 'reimportRequired', reason: upgradeReason});
        expect(connection.selectObjects('SELECT title, generationId FROM dictionaryStorageHealth')).toEqual([{title: 'Main', generationId: 'Main'}]);
    });

    test.each([
        ['Malformed', '{', 3],
        ['Array', '[]', 3],
        ['Incomplete', JSON.stringify({title: 'Incomplete', version: 3, importSuccess: false}), 3],
        ['Missing success', JSON.stringify({title: 'Missing success', version: 3}), 3],
        ['Mismatched', JSON.stringify({title: 'Other', version: 3, importSuccess: true}), 3],
        ['Unsupported', JSON.stringify({title: 'Unsupported', version: 2, importSuccess: true}), 2],
        ['', JSON.stringify({title: '', version: 3, importSuccess: true}), 3],
        ['Main [update-staging token]', JSON.stringify({title: 'Main [update-staging token]', version: 3, importSuccess: true, transientUpdateStage: 'update-staging', updateSessionToken: 'token'}), 3],
    ])('does not retain malformed, incomplete, or transient summary %s', async (title, summaryJson, version) => {
        const {database, connection} = createDatabase();
        connection.exec({sql: 'INSERT INTO dictionaries VALUES (2, ?, ?, ?)', bind: [title, version, summaryJson]});
        await database._runSchemaMigrations();
        expect(connection.selectValues('SELECT title FROM dictionaries')).toEqual(['Main']);
        assertMigrationHealth(connection);
    });

    test('retains a valid format 1 dictionary and a legitimate title resembling update syntax', async () => {
        const {database, connection, summary} = createDatabase();
        const title = 'Personal [replaced example]';
        connection.exec({sql: 'INSERT INTO dictionaries VALUES (2, ?, 1, ?)', bind: [title, JSON.stringify({...summary, title, version: 1, termRecordStorageName: title, storageGenerationId: title})]});
        await database._runSchemaMigrations();
        expect(connection.selectValues('SELECT title FROM dictionaries ORDER BY id')).toEqual(['Main', title]);
    });

    test('metadata read failure stops migration before persistent files are reset', async () => {
        const {database, connection, contentReset, recordReset} = createDatabase();
        vi.spyOn(connection, 'selectObjects').mockImplementationOnce(() => { throw new Error('injected metadata read failure'); });
        await expect(database._runSchemaMigrations()).rejects.toThrow('injected metadata read failure');
        expect(contentReset).not.toHaveBeenCalled();
        expect(recordReset).not.toHaveBeenCalled();
        expect(connection.selectValue('PRAGMA user_version')).toBe(5);
        await database._runSchemaMigrations();
        assertMigrationHealth(connection);
    });

    test('failed persistent reset keeps summary metadata and schema version for safe retry', async () => {
        const {database, connection, summary, contentReset, recordReset} = createDatabase();
        contentReset.mockRejectedValueOnce(new Error('injected reset failure'));
        await expect(database._runSchemaMigrations()).rejects.toThrow('injected reset failure');
        expect(recordReset).toHaveBeenCalledOnce();
        expect(connection.selectValue('PRAGMA user_version')).toBe(5);
        expect(JSON.parse(String(connection.selectValue('SELECT summaryJson FROM dictionaries')))).toEqual(summary);
        await database._runSchemaMigrations();
        expect(connection.selectValue('PRAGMA user_version')).toBe(10);
        assertMigrationHealth(connection);
    });

    test('failed SQL commit rolls back retained inventory and permits retry after persistent reset', async () => {
        const {database, connection, summary} = createDatabase();
        const exec = connection.exec.bind(connection);
        let failCommit = true;
        vi.spyOn(connection, 'exec').mockImplementation((value, ...args) => {
            if (/** @type {unknown} */ (value) === 'COMMIT' && failCommit) {
                failCommit = false;
                throw new Error('injected migration commit failure');
            }
            return exec(value, ...args);
        });
        await expect(database._runSchemaMigrations()).rejects.toThrow('injected migration commit failure');
        expect(connection.selectValue('PRAGMA user_version')).toBe(5);
        expect(JSON.parse(String(connection.selectValue('SELECT summaryJson FROM dictionaries')))).toEqual(summary);
        expect(connection.selectObjects('SELECT * FROM dictionaryStorageHealth')).toEqual([]);
        await database._runSchemaMigrations();
        assertMigrationHealth(connection);
        expect(connection.selectValue('PRAGMA user_version')).toBe(10);
    });

    test('successful replacement clears upgrade quarantine without inheriting its old generation', async () => {
        const {database, connection, summary} = createDatabase();
        await database._runSchemaMigrations();
        database._restoreTermRecordDictionaryHealth();
        const stagedTitle = 'Main [update-staging new-operation]';
        const replacement = {...summary, title: stagedTitle, termRecordStorageName: 'new-physical', storageGenerationId: 'new-generation', storageImportOperationId: 'new-operation'};
        connection.exec({sql: 'INSERT INTO dictionaries VALUES (2, ?, 3, ?)', bind: [stagedTitle, JSON.stringify(replacement)]});
        database._refreshTermRecordStorageNameMappings();
        await database.replaceDictionaryTitle(stagedTitle, 'Main', {...replacement, title: 'Main'}, 'Main');
        const restarted = reopen(connection);
        restarted.database._restoreTermRecordDictionaryHealth();
        expect(await restarted.database.getDictionaryInfo()).toMatchObject([{title: 'Main', storageGenerationId: 'new-generation', storageHealth: 'available'}]);
        expect(connection.selectObjects('SELECT * FROM dictionaryStorageHealth')).toEqual([]);
        expect(restarted.database.getPublishedDictionaryImport('old-operation')).toBeNull();
        expect(restarted.database.getPublishedDictionaryImport('new-operation')).toMatchObject({outcome: {status: 'published', generationId: 'new-generation'}});
    });
});

test('startup pruning preserves migrated dictionary aliases, ordering, and profile selectors', async () => {
    const {database} = createDatabase();
    await database._runSchemaMigrations();
    database._restoreTermRecordDictionaryHealth();
    const options = {
        profiles: [
            {options: {
                dictionaries: [
                    {name: 'Main', alias: 'Primary', enabled: true, styles: '.custom {color: red}', allowSecondarySearches: true},
                    {name: 'Main', alias: 'Secondary', enabled: false, styles: '.custom {color: blue}'},
                ],
                general: {mainDictionary: 'Main', sortFrequencyDictionary: 'Main'},
                anki: {tags: ['preserved']},
            }},
            {options: {
                dictionaries: [{name: 'Main', alias: 'Other profile', enabled: false}],
                general: {mainDictionary: 'Main', sortFrequencyDictionary: null},
            }},
        ],
    };
    const before = structuredClone(options);
    const save = vi.fn();
    const context = {
        _options: options,
        _dictionaryDatabase: database,
        _ensureDictionaryDatabaseReady: vi.fn(async () => {}),
        _optionsUtil: {save},
        _clearProfileConditionsSchemaCache: vi.fn(),
    };
    const result = await Reflect.get(Backend.prototype, '_pruneStaleProfileDictionaryOptions').call(context);
    expect(result).toMatchObject({removedEntryCount: 0, affectedProfiles: 0, mainDictionaryResets: 0, sortFrequencyDictionaryResets: 0});
    expect(options).toStrictEqual(before);
    expect(save).not.toHaveBeenCalled();
});
