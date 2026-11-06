/*
 * Copyright (C) 2026  Yomitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import {afterEach, beforeAll, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {log} from '../ext/js/core/log.js';

/** @type {import('@sqlite.org/sqlite-wasm').Sqlite3Static} */
let sqlite3;
/** @type {import('@sqlite.org/sqlite-wasm').Database[]} */
const connections = [];
beforeAll(async () => { sqlite3 = await sqlite3InitModule(); });
afterEach(() => {
    vi.restoreAllMocks();
    for (const connection of connections.splice(0)) { connection.close(); }
});

/**
 * @param {boolean} [malformed=false]
 * @returns {Promise<{database: DictionaryDatabase, recordStore: import('../ext/js/dictionary/term-record-opfs-store.js').TermRecordOpfsStore, connection: import('@sqlite.org/sqlite-wasm').Database}>}
 */
async function fixture(malformed = false) {
    const database = new DictionaryDatabase();
    const connection = new sqlite3.oo1.DB(':memory:');
    connections.push(connection);
    connection.exec(`
        CREATE TABLE dictionaryStorageHealth(title TEXT PRIMARY KEY, generationId TEXT, reason TEXT);
        CREATE TABLE dictionaryGlossarySearchIndex(dictionary TEXT PRIMARY KEY, version INTEGER, termCount INTEGER, completedAt INTEGER);
        CREATE TABLE termGlossarySearchTerms(dictionary TEXT, termId INTEGER, score REAL, PRIMARY KEY(dictionary, termId));
        CREATE TABLE termGlossaryTokens(dictionary TEXT, token TEXT, termId INTEGER, PRIMARY KEY(dictionary, token, termId));
    `);
    Reflect.set(database, '_db', connection);
    const recordStore = /** @type {import('../ext/js/dictionary/term-record-opfs-store.js').TermRecordOpfsStore} */ (Reflect.get(database, '_termRecordStore'));
    const contentStore = /** @type {import('../ext/js/dictionary/term-content-opfs-store.js').TermContentOpfsStore} */ (Reflect.get(database, '_termContentStore'));
    database._registerTermRecordStorageName('Broken', 'physical-broken', 'generation-broken');
    database._registerTermRecordStorageName('Healthy', 'physical-healthy', 'generation-healthy');
    const encoder = new TextEncoder();
    const bytes = [
        encoder.encode(JSON.stringify({rules: '', definitionTags: '', termTags: '', glossary: ['cat']})),
        encoder.encode(JSON.stringify({rules: '', definitionTags: '', termTags: '', glossary: 0})),
    ];
    const spans = await contentStore.appendBatch(bytes);
    // More high-ranking broken postings than the 400-candidate SQL limit.
    // Candidate filtering must happen before LIMIT, not after row hydration.
    const records = Array.from({length: 402}, (_, index) => {
        const broken = index !== 401;
        const term = `term-${index}`;
        const span = spans[malformed && broken ? 1 : 0];
        return {
            dictionary: broken ? 'physical-broken' : 'physical-healthy',
            expression: term,
            reading: term,
            expressionReverse: [...term].reverse().join(''),
            readingReverse: [...term].reverse().join(''),
            entryContentOffset: span.offset,
            entryContentLength: span.length,
            entryContentDictName: 'raw',
            score: broken ? 10 : 0,
            sequence: index + 1,
        };
    });
    await recordStore.appendBatch(records);
    recordStore.ensureDictionaryIndexes(['physical-broken', 'physical-healthy']);
    // Keep real records, hydration, health persistence and SQL index building.
    // OPFS discovery/setup is independent of the controlled health transition.
    vi.spyOn(database, '_ensureDirectTermIndexesLoaded').mockResolvedValue();
    vi.spyOn(log, 'error').mockImplementation(() => {});
    return {database, recordStore, connection};
}

test.each(['first page', 'final page'])('quarantine after the %s never publishes a complete glossary index or starves healthy siblings', async (phase) => {
    const {database, recordStore, connection} = await fixture();
    let quarantined = false;
    const result = await database.findTermsByGlossary('cat', new Set(['Broken', 'Healthy']), 100, (progress) => {
        if (!quarantined && progress.dictionary === 'Broken' && (phase === 'first page' || progress.processed === progress.total)) {
            quarantined = true;
            recordStore.markDictionaryReimportRequired('physical-broken', 'Concurrent confirmed corruption');
        }
    });
    expect(quarantined).toBe(true);
    expect(result.map(({dictionary}) => dictionary)).toEqual(['Healthy']);
    expect(connection.selectObjects("SELECT dictionary FROM dictionaryGlossarySearchIndex WHERE dictionary = 'Broken'")).toEqual([]);
    expect(connection.selectObjects("SELECT dictionary, termCount FROM dictionaryGlossarySearchIndex WHERE dictionary = 'Healthy'")).toEqual([{dictionary: 'Healthy', termCount: 1}]);
    expect((await database.findTermsByGlossary('cat', new Set(['Broken', 'Healthy']))).map(({dictionary}) => dictionary)).toEqual(['Healthy']);
    expect(database.getDictionaryAvailability(['Broken', 'Healthy'])).toMatchObject([{dictionary: 'Broken', status: 'reimportRequired'}]);
});

test('a previously quarantined index cannot consume the healthy glossary candidate budget', async () => {
    const {database, recordStore, connection} = await fixture();
    await database.ensureGlossarySearchIndex(new Set(['Broken', 'Healthy']));
    recordStore.markDictionaryReimportRequired('physical-broken', 'Confirmed prior corruption');
    const build = vi.spyOn(database, '_ensureGlossarySearchIndexForDictionary');
    expect((await database.findTermsByGlossary('cat', new Set(['Broken', 'Healthy']))).map(({dictionary}) => dictionary)).toEqual(['Healthy']);
    expect(build.mock.calls.map(([dictionary]) => dictionary)).toEqual(['Healthy']);
    // Retained derived postings remain harmless because SQL excludes their owner.
    expect(connection.selectObjects("SELECT COUNT(*) AS count FROM termGlossarySearchTerms WHERE dictionary = 'Broken'")).toEqual([{count: 401}]);
    expect(await database.findTermsByGlossary('cat', new Set(['Broken']))).toEqual([]);
});

test('authoritative corruption discovered by glossary index construction preserves healthy siblings', async () => {
    const {database, recordStore, connection} = await fixture(true);
    const result = await database.findTermsByGlossary('cat', new Set(['Broken', 'Healthy']));
    expect(recordStore.getDictionaryHealth('physical-broken').status).toBe('reimportRequired');
    expect(result.map(({dictionary}) => dictionary)).toEqual(['Healthy']);
    expect(connection.selectObjects("SELECT dictionary FROM dictionaryGlossarySearchIndex WHERE dictionary = 'Broken'")).toEqual([]);
});

test.each(['failure', 'cancellation', 'mutation'])('glossary discovery preserves unrelated %s instead of skipping the dictionary', async (mode) => {
    const {database} = await fixture();
    let cancelled = false;
    const failure = new Error('Read temporarily unavailable');
    if (mode === 'failure') {
        vi.spyOn(database, '_fetchTermRowsByIds').mockRejectedValue(failure);
    }
    const pending = database.findTermsByGlossary('cat', new Set(['Broken', 'Healthy']), 100, () => {
        if (mode === 'cancellation') { cancelled = true; }
        if (mode === 'mutation') { database._clearBulkImportRuntimeCaches(); }
    }, () => cancelled);
    if (mode === 'failure') {
        await expect(pending).rejects.toBe(failure);
    } else if (mode === 'cancellation') {
        await expect(pending).rejects.toMatchObject({name: 'AbortError'});
    } else {
        await expect(pending).rejects.toMatchObject({status: 'temporarilyUnavailable'});
    }
});
