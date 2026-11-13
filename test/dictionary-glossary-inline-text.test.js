/* Copyright (C) 2026 Manabitan authors; SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import {afterEach, beforeAll, expect, vi} from 'vitest'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'
import {createMdxImportData} from '../ext/js/dictionary/mdx/mdx-converter.js'
import {StructuredContentGenerator} from '../ext/js/display/structured-content-generator.js'
import {createDomTest} from './fixtures/dom-test.js'
import {makeMdictFixture} from './util/mdict-binary-fixture.js'

const test = createDomTest()
/** @type {import('@sqlite.org/sqlite-wasm').Sqlite3Static} */
let sqlite3
/** @type {import('@sqlite.org/sqlite-wasm').Database[]} */
const connections = []
let serial = 0
beforeAll(async () => { sqlite3 = await sqlite3InitModule() })
afterEach(() => {
    vi.restoreAllMocks()
    for (const connection of connections.splice(0)) { connection.close() }
})

/**
 * Keep the actual term records, hydration, SQL postings, and index versioning.
 * Only persistent OPFS discovery is omitted from this fixture.
 * @param {import('dictionary-data').TermGlossary[]} glossary
 * @param {boolean} staleIndex
 * @returns {Promise<{database: DictionaryDatabase, connection: import('@sqlite.org/sqlite-wasm').Database, contentSpan: {offset: number, length: number}}>}
 */
async function createDatabase(glossary, staleIndex) {
    const database = new DictionaryDatabase()
    const filename = staleIndex ? `/glossary-index-migration-${++serial}.sqlite3` : ':memory:'
    let connection = new sqlite3.oo1.DB(filename, 'c')
    connections.push(connection)
    connection.exec(`
        CREATE TABLE dictionaryStorageHealth(title TEXT PRIMARY KEY, generationId TEXT, reason TEXT);
        CREATE TABLE dictionaryGlossarySearchIndex(dictionary TEXT PRIMARY KEY, version INTEGER, termCount INTEGER, completedAt INTEGER);
        CREATE TABLE termGlossarySearchTerms(dictionary TEXT, termId INTEGER, score REAL, PRIMARY KEY(dictionary, termId));
        CREATE TABLE termGlossaryTokens(dictionary TEXT, token TEXT, termId INTEGER, PRIMARY KEY(dictionary, token, termId));
    `)
    database._db = connection
    database._registerTermRecordStorageName('Inline', 'physical-inline', 'generation-inline')
    const [span] = await database._termContentStore.appendBatch([
        new TextEncoder().encode(JSON.stringify({rules: '', definitionTags: '', termTags: '', glossary})),
    ])
    await database._termRecordStore.appendBatch([{
        dictionary: 'physical-inline',
        expression: '走る',
        reading: 'はしる',
        expressionReverse: 'る走',
        readingReverse: 'るしは',
        entryContentOffset: span.offset,
        entryContentLength: span.length,
        entryContentDictName: 'raw',
        score: 0,
        sequence: 1,
    }])
    database._termRecordStore.ensureDictionaryIndexes(['physical-inline'])
    vi.spyOn(database, '_ensureDirectTermIndexesLoaded').mockResolvedValue()
    if (staleIndex) {
        // Version 1 inserted separators at every inline text node boundary.
        const [id] = database._termRecordStore.getDictionaryIdBatch('physical-inline', 0, 1)
        connection.exec({sql: 'INSERT INTO termGlossarySearchTerms VALUES (?, ?, 0)', bind: ['Inline', id]})
        for (const token of ['run', 'ning', 'fast']) {
            connection.exec({sql: 'INSERT INTO termGlossaryTokens VALUES (?, ?, ?)', bind: ['Inline', token, id]})
        }
        connection.exec("INSERT INTO dictionaryGlossarySearchIndex VALUES ('Inline', 1, 1, 0)")
        // Reopen the populated SQLite file, as an existing installation does.
        connection.close()
        connection = new sqlite3.oo1.DB(filename, 'w')
        connections.push(connection)
        database._db = connection
        expect(connection.selectValue('SELECT version FROM dictionaryGlossarySearchIndex')).toBe(1)
    }
    return {database, connection, contentSpan: span}
}

for (const {name, html, tokens} of [
    {name: 'bold formatting', html: '<div>run<b>ning</b> fast</div>', tokens: ['fast', 'running']},
    {name: 'ruby annotation', html: '<div><ruby>run<rp>(</rp><rt>r<span>ʌn</span></rt><rp>)</rp></ruby>ning fast</div>', tokens: ['fast', 'running', 'rʌn']},
]) {
    for (const staleIndex of [false, true]) {
        test(`glossary lookup finds a rendered word split by ${name}; existing index=${staleIndex}`, async ({window}) => {
            const source = makeMdictFixture([{key: '走る', value: html}])
            const converted = await createMdxImportData('inline.mdx', {}, source.bytes, [])
            const bank = converted.files.get('term_bank_1.json')
            expect(bank).toBeInstanceOf(Uint8Array)
            const glossary = /** @type {import('dictionary-data').TermGlossary[]} */ (JSON.parse(new TextDecoder().decode(bank))[0][5])
            const structured = /** @type {import('dictionary-data').TermGlossaryStructuredContent} */ (glossary[0])
            const manager = {loadMediaUrl: () => {}, prepareLink: () => {}, openMediaInTab: async () => {}}
            const generator = new StructuredContentGenerator(manager, window.document, /** @type {Window} */ (/** @type {unknown} */ (window)))
            const node = generator.createStructuredContent(structured.content, 'Inline')
            // Ruby readings are annotations, separate from the visible base word.
            for (const annotation of node.querySelectorAll('rt, rp')) { annotation.remove() }
            expect(node.textContent).toBe('running fast')

            const {database, connection, contentSpan} = await createDatabase(glossary, staleIndex)
            const ids = database._termRecordStore.getDictionaryIdBatch('physical-inline', 0, 1)
            const before = await database._fetchTermRowsByIds(ids)
            const sourceBytes = await database._termContentStore.readSlice(contentSpan.offset, contentSpan.length)
            expect(sourceBytes).not.toBeNull()
            const beforeBytes = sourceBytes?.slice()
            const dictionaries = new Set(['Inline'])
            expect((await database.findTermsByGlossary('running', dictionaries)).map(({term}) => term)).toEqual(['走る'])
            expect((await database.findTermsByGlossary('runn', dictionaries)).map(({term}) => term)).toEqual(['走る'])
            expect((await database.findTermsByGlossary('running fast', dictionaries)).map(({term}) => term)).toEqual(['走る'])
            expect(connection.selectValues('SELECT token FROM termGlossaryTokens ORDER BY token')).toEqual(tokens)
            expect(connection.selectValue('SELECT version FROM dictionaryGlossarySearchIndex')).toBe(2)
            expect(await database._fetchTermRowsByIds(ids)).toEqual(before)
            expect(await database._termContentStore.readSlice(contentSpan.offset, contentSpan.length)).toEqual(beforeBytes)
            expect(database._termRecordStore.getDictionaryRecordCount('physical-inline')).toBe(1)
        })
    }
}
