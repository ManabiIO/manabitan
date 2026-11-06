/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import {afterEach, beforeAll, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {deferPromise} from '../ext/js/core/utilities.js';
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

async function fixture() {
    const database = new DictionaryDatabase();
    const connection = new sqlite3.oo1.DB(':memory:');
    connections.push(connection);
    connection.exec(`
        CREATE TABLE dictionaryStorageHealth(title TEXT PRIMARY KEY, generationId TEXT, reason TEXT);
        CREATE TABLE termGlossarySearchTerms(dictionary TEXT, termId INTEGER, score REAL);
        CREATE TABLE termGlossaryTokens(dictionary TEXT, token TEXT, termId INTEGER);
        INSERT INTO termGlossarySearchTerms VALUES ('Broken', 1, 0), ('Healthy', 3, 0);
        INSERT INTO termGlossaryTokens VALUES ('Broken', 'first', 1), ('Healthy', 'sibling', 3);
    `);
    Reflect.set(database, '_db', connection);
    const recordStore = /** @type {import('../ext/js/dictionary/term-record-opfs-store.js').TermRecordOpfsStore} */ (Reflect.get(database, '_termRecordStore'));
    const contentStore = /** @type {import('../ext/js/dictionary/term-content-opfs-store.js').TermContentOpfsStore} */ (Reflect.get(database, '_termContentStore'));
    database._registerTermRecordStorageName('Broken', 'physical-broken', 'generation-broken');
    database._registerTermRecordStorageName('Healthy', 'physical-healthy', 'generation-healthy');
    const encoder = new TextEncoder();
    const entries = [
        {dictionary: 'Broken', expression: 'first', glossary: ['first definition']},
        {dictionary: 'Broken', expression: 'second', glossary: 0},
        {dictionary: 'Healthy', expression: 'sibling', glossary: ['sibling definition']},
    ];
    const bytes = entries.map(({glossary}) => encoder.encode(JSON.stringify({rules: '', definitionTags: '', termTags: '', glossary})));
    const spans = await contentStore.appendBatch(bytes);
    await recordStore.appendBatch(entries.map((entry, i) => ({
        dictionary: entry.dictionary === 'Broken' ? 'physical-broken' : 'physical-healthy',
        expression: entry.expression,
        reading: entry.expression,
        expressionReverse: [...entry.expression].reverse().join(''),
        readingReverse: [...entry.expression].reverse().join(''),
        entryContentOffset: spans[i].offset,
        entryContentLength: spans[i].length,
        entryContentDictName: 'raw',
        score: 0,
        sequence: i + 1,
    })));
    recordStore.ensureDictionaryIndexes(['physical-broken', 'physical-healthy']);
    // OPFS capability/setup is independent of this race; keep real record
    // indexes, content parsing, health callbacks, SQLite persistence and caches.
    vi.spyOn(database, '_ensureDirectTermIndexesLoaded').mockResolvedValue();
    // The real SQL postings above are already built, keeping discovery of the
    // malformed sibling inside the controlled race rather than index setup.
    vi.spyOn(database, 'ensureGlossarySearchIndex').mockResolvedValue();
    vi.spyOn(log, 'error').mockImplementation(() => {});
    return {database, recordStore, contentStore, connection, spans};
}

/**
 * @param {DictionaryDatabase} database
 * @param {string} kind
 * @param {string} term
 * @param {Set<string>} names
 * @param {import('dictionary-database').DictionaryAvailability[]} [availability=[]]
 * @returns {Promise<import('dictionary-database').TermEntry[]>}
 */
function lookup(database, kind, term, names, availability = []) {
    switch (kind) {
        case 'glossary': return database.findTermsByGlossary(term, names);
        case 'pair': return database.findTermsExactBulk([{term, reading: term}], names, availability);
        case 'sequence':
            return database.findTermsBySequenceBulk([...names].map((dictionary) => ({
                dictionary, query: term === 'first' ? 1 : 3,
            })), availability);
        default: return database.findTermsBulk([term], names, /** @type {'exact'|'prefix'|'suffix'} */ (kind), availability);
    }
}

const phases = ['record read', 'content read', 'hydration', 'publication'];
const kinds = ['exact', 'prefix', 'suffix', 'pair', 'sequence', 'glossary'];

test.each(phases.flatMap((phase) => kinds.map((kind) => ({phase, kind}))))(
    'quarantine fences $kind lookup during $phase without blocking healthy siblings',
    async ({phase, kind}) => {
        const {database, recordStore, contentStore, connection, spans} = await fixture();
        const entered = deferPromise();
        const release = deferPromise();
        const healthyEntered = deferPromise();
        const healthyRelease = deferPromise();
        const pause = async (/** @type {number} */ id) => {
            if (id === 1) {
                entered.resolve(void 0);
                await release.promise;
            }
            if (id === 3) {
                healthyEntered.resolve(void 0);
                await healthyRelease.promise;
            }
        };
        switch (phase) {
            case 'record read': {
                const fetch = recordStore.getByIdsAsync.bind(recordStore);
                vi.spyOn(recordStore, 'getByIdsAsync').mockImplementation(async (ids) => {
                    const selectedIds = [...ids];
                    if (selectedIds.includes(1)) { await pause(1); }
                    if (selectedIds.includes(3)) { await pause(3); }
                    return await fetch(selectedIds);
                });
                break;
            }
            case 'content read': {
                const read = contentStore.readSlice.bind(contentStore);
                vi.spyOn(contentStore, 'readSlice').mockImplementation(async (offset, length) => {
                    if (offset === spans[0].offset) { await pause(1); }
                    if (offset === spans[2].offset) { await pause(3); }
                    return await read(offset, length);
                });
                break;
            }
            case 'hydration': {
                const deserialize = database._deserializeTermRow.bind(database);
                vi.spyOn(database, '_deserializeTermRow').mockImplementation(async (value) => {
                    const result = await deserialize(value);
                    await pause(value.id);
                    return result;
                });
                break;
            }
            default: {
                const fetch = database._fetchTermRowsByIds.bind(database);
                vi.spyOn(database, '_fetchTermRowsByIds').mockImplementation(async (ids) => {
                    const result = await fetch(ids);
                    if (result.has(1)) { await pause(1); }
                    if (result.has(3)) { await pause(3); }
                    return result;
                });
                break;
            }
        }
        const names = new Set(['Broken']);
        const pending = lookup(database, kind, 'first', names);
        const settled = pending.then((value) => ({value, error: null}), (error) => ({value: null, error}));
        await entered.promise;
        const healthy = database.findTermsBulk(['sibling'], new Set(['Healthy']), 'exact').then((value) => ({value, error: null}), (error) => ({value: null, error}));
        await healthyEntered.promise;
        try {
            await expect(database.findTermsBulk(['second'], names, 'exact')).rejects.toThrow();
            expect(recordStore.getDictionaryHealth('physical-broken').status).toBe('reimportRequired');
            expect(connection.selectObjects('SELECT title FROM dictionaryStorageHealth')).toEqual([{title: 'Broken'}]);
            healthyRelease.resolve(void 0);
            const sibling = await healthy;
            expect(sibling.error).toBeNull();
            expect(sibling.value?.[0]?.definitions).toEqual(['sibling definition']);
        } finally {
            healthyRelease.resolve(void 0);
            release.resolve(void 0);
            await healthy;
        }
        const result = await settled;
        expect(result.error).toMatchObject({status: 'corrupt'});
        expect(result.value).toBeNull();
        expect(Reflect.get(database, '_termRowCache').has(1)).toBe(false);
        if (phase === 'content read' || phase === 'record read') {
            expect(Reflect.get(database, '_termEntryContentCache').has(`span:${spans[0].offset}:${spans[0].length}:raw`)).toBe(false);
        }
    },
);

test.each(kinds)('existing quarantine preserves healthy results and availability for %s', async (kind) => {
    const {database, recordStore} = await fixture();
    recordStore.markDictionaryReimportRequired('physical-broken', 'Confirmed prior corruption');
    /** @type {import('dictionary-database').DictionaryAvailability[]} */
    const availability = [];
    const names = new Set(['Broken', 'Healthy']);
    const result = await lookup(database, kind, 'sibling', names, availability);
    if (kind === 'glossary') { availability.push(...database.getDictionaryAvailability(names)); }
    expect(result).toHaveLength(1);
    expect(result[0].definitions).toEqual(['sibling definition']);
    expect(availability).toMatchObject([{dictionary: 'Broken', generationId: 'generation-broken', status: 'reimportRequired'}]);
});
