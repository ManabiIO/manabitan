/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import {afterEach, beforeAll, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {encodeRawTermContentBinary, RAW_TERM_CONTENT_DICT_NAME} from '../ext/js/dictionary/raw-term-content.js';

vi.mock('../ext/js/dictionary/zstd-term-content.js', async (importOriginal) => ({
    .../** @type {typeof import('../ext/js/dictionary/zstd-term-content.js')} */(await importOriginal()),
    initializeTermContentZstd: vi.fn(async () => {}),
}));

/** @type {import('@sqlite.org/sqlite-wasm').Sqlite3Static} */
let sqlite3;
/** @type {import('@sqlite.org/sqlite-wasm').Database[]} */
const connections = [];
beforeAll(async () => { sqlite3 = await sqlite3InitModule(); });
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const connection of connections.splice(0)) { connection.close(); }
});

/**
 * Only the OPFS boundary is replaced. Files publish on close; checkpoints,
 * journal validation, record/content encoding, deletion and lookup stay real.
 * @returns {{root: FileSystemDirectoryHandle, files: Map<string, Uint8Array>, failures: {clearJournal: boolean}}}
 */
function createMemoryOpfs() {
    /** @type {Map<string, Uint8Array>} */
    const files = new Map();
    const directories = new Set(['']);
    const failures = {clearJournal: false};
    const missing = () => new DOMException('Missing checkpoint file', 'NotFoundError');
    /**
     * @param {string} prefix
     * @returns {FileSystemDirectoryHandle}
     */
    const directory = (prefix) => /** @type {FileSystemDirectoryHandle} */ (/** @type {unknown} */ ({
        kind: 'directory',
        async getDirectoryHandle(/** @type {string} */ name, {create = false} = {}) {
            const key = `${prefix}${name}/`;
            if (!directories.has(key)) {
                if (!create) { throw missing(); }
                directories.add(key);
            }
            return directory(key);
        },
        async getFileHandle(/** @type {string} */ name, {create = false} = {}) {
            const key = `${prefix}${name}`;
            if (!files.has(key)) {
                if (!create) { throw missing(); }
                files.set(key, new Uint8Array());
            }
            return {
                kind: 'file',
                name,
                async getFile() {
                    const bytes = files.get(key);
                    if (typeof bytes === 'undefined') { throw missing(); }
                    return new File([new Uint8Array(bytes)], name);
                },
                async createWritable({keepExistingData = false} = {}) {
                    let bytes = keepExistingData ? new Uint8Array(files.get(key) ?? []) : new Uint8Array();
                    let cursor = 0;
                    return {
                        async seek(/** @type {number} */ position) { cursor = position; },
                        async write(/** @type {FileSystemWriteChunkType} */ input) {
                            let value;
                            if (typeof input === 'string') {
                                value = new TextEncoder().encode(input);
                            } else if (input instanceof Blob) {
                                value = new Uint8Array(await input.arrayBuffer());
                            } else if (input instanceof ArrayBuffer) {
                                value = new Uint8Array(input);
                            } else if (ArrayBuffer.isView(input)) {
                                value = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
                            } else {
                                throw new TypeError('Unexpected test write input');
                            }
                            const next = new Uint8Array(Math.max(bytes.length, cursor + value.length));
                            next.set(bytes);
                            next.set(value, cursor);
                            bytes = next;
                            cursor += value.length;
                        },
                        async truncate(/** @type {number} */ size) {
                            const next = new Uint8Array(size);
                            next.set(bytes.subarray(0, size));
                            bytes = next;
                            cursor = Math.min(cursor, size);
                        },
                        async close() { files.set(key, bytes); },
                        async abort() {},
                    };
                },
            };
        },
        async removeEntry(/** @type {string} */ name) {
            if (name === 'manabitan-dictionary-import-journal.json' && failures.clearJournal) {
                throw new DOMException('Injected journal clear failure', 'UnknownError');
            }
            if (!files.delete(`${prefix}${name}`)) { throw missing(); }
        },
        async *entries() {
            for (const key of files.keys()) {
                if (key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) {
                    const name = key.slice(prefix.length);
                    yield [name, await directory(prefix).getFileHandle(name)];
                }
            }
        },
    }));
    return {root: directory(''), files, failures};
}

/**
 * @param {string[]} [titles]
 * @returns {Promise<{database: DictionaryDatabase, connection: import('@sqlite.org/sqlite-wasm').Database, opfs: ReturnType<typeof createMemoryOpfs>}>}
 */
async function fixture(titles = ['Existing', 'Survivor']) {
    const opfs = createMemoryOpfs();
    vi.stubGlobal('navigator', {storage: {getDirectory: async () => opfs.root}});
    const connection = new sqlite3.oo1.DB(':memory:');
    connections.push(connection);
    connection.exec(`
        CREATE TABLE dictionaries(id INTEGER PRIMARY KEY, title TEXT, version INTEGER, summaryJson TEXT);
        CREATE TABLE termEntryContent(id INTEGER PRIMARY KEY);
        CREATE TABLE dictionaryImportPublications(sessionId TEXT PRIMARY KEY, publishedAt INTEGER);
        CREATE TABLE dictionaryStorageHealth(title TEXT PRIMARY KEY, generationId TEXT, reason TEXT);
        CREATE TABLE terms(entryContentId INTEGER);
    `);
    for (const table of ['termMeta', 'kanji', 'kanjiMeta', 'tagMeta', 'media', 'sharedGlossaryArtifacts', 'termGlossaryTokens', 'termGlossarySearchTerms', 'dictionaryGlossarySearchIndex']) {
        connection.exec(`CREATE TABLE ${table}(dictionary TEXT)`);
    }
    const database = new DictionaryDatabase();
    Reflect.set(database, '_db', connection);
    const content = database._termContentStore;
    const records = database._termRecordStore;
    await content.prepare();
    await records.prepare();
    await records.beginImportSession();
    const encoder = new TextEncoder();
    for (const title of titles) {
        connection.exec({
            sql: 'INSERT INTO dictionaries(title, version, summaryJson) VALUES (?, 3, ?)',
            bind: [title, JSON.stringify({title, version: 3, importSuccess: true, counts: {terms: {total: 1}}})],
        });
        const bytes = encodeRawTermContentBinary('', '', '', encoder.encode(JSON.stringify([`${title} definition`])), encoder);
        const [span] = await content.appendBatch([bytes]);
        await records.appendBatch([{
            dictionary: title,
            expression: title,
            reading: title,
            expressionReverse: null,
            readingReverse: null,
            entryContentOffset: span.offset,
            entryContentLength: span.length,
            entryContentDictName: RAW_TERM_CONTENT_DICT_NAME,
            score: 0,
            sequence: 1,
        }]);
    }
    await records.endImportSession();
    database._refreshTermRecordStorageNameMappings();
    await database._importJournal.write({
        version: 1,
        sessionId: 'interrupted-import',
        createdAt: 1,
        contentCheckpoint: await content.createImportCheckpoint(),
        recordCheckpoint: await records.createImportCheckpoint(),
    });
    opfs.failures.clearJournal = true;
    await database._recoverInterruptedImportSession();
    expect(database._importJournalRecoveryPending).toBe(true);
    return {database, connection, opfs};
}

/**
 * @param {DictionaryDatabase} database
 * @param {string} title
 */
async function expectLookup(database, title) {
    await expect(database.findTermsBulk([title], new Set([title]), 'exact')).resolves.toMatchObject([
        {dictionary: title, term: title, definitions: [`${title} definition`]},
    ]);
}

test.each([{titles: ['Existing']}, {titles: ['Existing', 'Survivor']}])('retained rollback journal fences deletion with $titles installed', async ({titles}) => {
    const {database, connection, opfs} = await fixture(titles);
    const snapshot = structuredClone(opfs.files);
    await expectLookup(database, 'Existing');
    for (let attempt = 0; attempt < 2; ++attempt) {
        await expect(database.deleteDictionary('Existing', 1000, () => {})).rejects.toThrow('recovery metadata is cleared');
        await database._recoverInterruptedImportSession();
        expect(opfs.files).toEqual(snapshot);
        expect(connection.selectValue('SELECT COUNT(*) FROM dictionaries')).toBe(titles.length);
        await expectLookup(database, 'Existing');
    }
    opfs.failures.clearJournal = false;
    await database._recoverInterruptedImportSession();
    await database.deleteDictionary('Existing', 1000, () => {});
    expect(connection.selectValues('SELECT title FROM dictionaries')).toEqual(titles.slice(1));
    // New runtime owners read the same durable metadata and OPFS after restart.
    const restarted = new DictionaryDatabase();
    Reflect.set(restarted, '_db', connection);
    await restarted._termContentStore.prepare();
    await restarted._termRecordStore.prepare();
    await restarted._recoverInterruptedImportSession();
    restarted._refreshTermRecordStorageNameMappings();
    expect(restarted._importJournalRecoveryPending).toBe(false);
    await expect(restarted.findTermsBulk(['Existing'], new Set(['Existing']), 'exact')).resolves.toEqual([]);
    if (titles.includes('Survivor')) { await expectLookup(restarted, 'Survivor'); }
});

test('retained rollback journal fences replacement before metadata cutover or backup cleanup', async () => {
    const {database, connection, opfs} = await fixture();
    const rows = connection.selectObjects('SELECT * FROM dictionaries');
    const files = structuredClone(opfs.files);
    const deleteDictionary = vi.spyOn(database, 'deleteDictionary');
    await expect(database.replaceDictionaryTitle('Existing', 'Survivor', null, 'Survivor'))
        .rejects.toThrow('recovery metadata is cleared');
    expect(connection.selectObjects('SELECT * FROM dictionaries')).toEqual(rows);
    expect(opfs.files).toEqual(files);
    expect(deleteDictionary).not.toHaveBeenCalled();
    await expectLookup(database, 'Existing');
    opfs.failures.clearJournal = false;
    await database._recoverInterruptedImportSession();
    await database.replaceDictionaryTitle('Existing', 'Survivor', null, 'Survivor');
    expect(connection.selectValues('SELECT title FROM dictionaries')).toEqual(['Survivor']);
    expect(deleteDictionary).toHaveBeenCalledOnce();
    await expect(database.findTermsBulk(['Existing'], new Set(['Survivor']), 'exact')).resolves.toMatchObject([
        {dictionary: 'Survivor', term: 'Existing', definitions: ['Existing definition']},
    ]);
});

test('startup defers destructive cleanup while journal deletion fails and keeps healthy lookup available', async () => {
    const {database, connection, opfs} = await fixture(['Existing', 'Survivor', 'Incomplete', 'Orphan']);
    connection.exec({sql: 'UPDATE dictionaries SET summaryJson = ? WHERE title = ?', bind: [JSON.stringify({importSuccess: false}), 'Incomplete']});
    connection.exec("DELETE FROM dictionaries WHERE title = 'Orphan'");
    const files = structuredClone(opfs.files);
    const incomplete = vi.spyOn(database, '_cleanupIncompleteImports');
    const missingShards = vi.spyOn(database, '_cleanupMissingTermRecordShards');
    Reflect.set(database, '_db', null);
    vi.stubGlobal('self', {constructor: {name: 'DedicatedWorkerGlobalScope'}});
    vi.spyOn(database, '_deleteLegacyIndexedDb').mockResolvedValue();
    vi.spyOn(database, '_openConnection').mockImplementation(async () => {
        Reflect.set(database, '_db', connection);
        await database._termContentStore.prepare();
        await database._termRecordStore.prepare();
        await database._recoverInterruptedImportSession();
    });
    await database.prepare();
    expect(incomplete).not.toHaveBeenCalled();
    expect(missingShards).not.toHaveBeenCalled();
    expect(database.isPrepared()).toBe(true);
    expect(opfs.files).toEqual(files);
    expect(connection.selectValues('SELECT title FROM dictionaries')).toEqual(['Existing', 'Survivor', 'Incomplete']);
    await expectLookup(database, 'Existing');
    await expect(database._cleanupIncompleteImports()).rejects.toThrow('recovery metadata is cleared');
    await expect(database._cleanupMissingTermRecordShards()).rejects.toThrow('recovery metadata is cleared');
    opfs.failures.clearJournal = false;
    await database._recoverInterruptedImportSession();
    await database._cleanupIncompleteImports();
    await database._cleanupMissingTermRecordShards();
    expect(connection.selectValues('SELECT title FROM dictionaries')).toEqual(['Existing', 'Survivor']);
    expect([...opfs.files.keys()].some((name) => /(?:Incomplete|Orphan)/.test(name))).toBe(false);
    await expectLookup(database, 'Survivor');
});

test.each(['active', 'finalizing'])('mutation admission does not replay the %s import checkpoint', async (state) => {
    const {database, opfs} = await fixture();
    Reflect.set(database, '_bulkImportJournalRecord', await database._importJournal.read());
    Reflect.set(database, '_importJournalRecoveryPending', false);
    Reflect.set(database, '_bulkImportState', state);
    const read = vi.spyOn(database._importJournal, 'read');
    const files = structuredClone(opfs.files);
    await expect(database.deleteDictionary('Existing', 1000, () => {})).rejects.toThrow('recovery metadata is cleared');
    await expect(database.replaceDictionaryTitle('Existing', 'Renamed')).rejects.toThrow('recovery metadata is cleared');
    expect(read).not.toHaveBeenCalled();
    expect(opfs.files).toEqual(files);
});

test('startup cleanup remains allowed in the journal-free purge lifecycle', async () => {
    const {database, opfs} = await fixture();
    opfs.failures.clearJournal = false;
    await database._recoverInterruptedImportSession();
    Reflect.set(database, '_bulkImportState', 'finalizing');
    Reflect.set(database, '_purgingPromise', Promise.resolve(true));
    await expect(database._cleanupIncompleteImports()).resolves.toMatchObject({failedCount: 0});
    await expect(database._cleanupMissingTermRecordShards()).resolves.toMatchObject({failedCount: 0});
    expect(database._bulkImportState).toBe('finalizing');
});
