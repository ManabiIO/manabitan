/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import {afterEach, beforeAll, describe, expect, test, vi} from 'vitest'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'

/** @type {Awaited<ReturnType<typeof sqlite3InitModule>>} */
let sqlite3
/** @type {Array<() => void>} */
const cleanups = []
beforeAll(async () => { sqlite3 = await sqlite3InitModule() })
afterEach(() => {
    for (const cleanup of cleanups.splice(0)) { cleanup() }
    vi.restoreAllMocks()
})

function fixture() {
    const connection = new sqlite3.oo1.DB(':memory:')
    const database = new DictionaryDatabase()
    Reflect.set(database, '_db', connection)
    Reflect.set(database, '_sqlite3', sqlite3)
    /** @type {import('../ext/js/dictionary/term-record-opfs-store.js').TermRecordOpfsStore} */
    const store = Reflect.get(database, '_termRecordStore')
    const data = /** @type {Array<[string, string, string, number|null]>} */ ([
        ['Dict', 'entry', 'reading', 42],
        ['Dict', 'other', 'reading', 42],
        ['Other', 'entry', 'reading', 42],
        ['Dict', 'entry', 'different', 7],
        ['Dict', '', '', -1],
        ['Dict', '123', '4.0', null],
        ['dict', 'ENTRY', 'reading ', 42],
        ['Dict ', 'entry ', '?', 0],
        ['Dict', 'entry', 'reading', 43],
        ['Dict', 'a\u0000b', '日本語', 0],
        ['Dict', 'unread', '', 9],
        ['Dict', 'alias', 'alias', 7],
    ])
    database._registerTermRecordStorageName('Dict', 'physical-A')
    database._registerTermRecordStorageName('Other', 'physical-B')
    connection.exec('CREATE TABLE reference(dictionary TEXT, expression TEXT, reading TEXT, sequence INTEGER)')
    const insert = connection.prepare('INSERT INTO reference(rowid, dictionary, expression, reading, sequence) VALUES(?, ?, ?, ?, ?)')
    try {
        for (const [i, [dictionary, expression, reading, sequence]] of data.entries()) {
            store._storeRecord({
                id: i + 1,
                dictionary: database._getTermRecordStorageName(dictionary),
                expression,
                reading,
                sequence,
                expressionReverse: null,
                readingReverse: null,
                entryContentOffset: -1,
                entryContentLength: -1,
                entryContentDictName: 'raw',
                score: 0,
            })
            insert.bind([i + 1, dictionary, expression, reading, sequence]).stepReset()
        }
    } finally { insert.finalize() }
    database._registerTermsVirtualTableModule()
    connection.exec('CREATE VIRTUAL TABLE terms USING manabitan_terms')
    cleanups.push(() => {
        connection.close()
        const module = Reflect.get(database, '_termsVtabModule')
        module?.dispose()
    })
    /**
     * Compare real SQLite execution over the virtual table with an ordinary
     * table. SQLite, not a mock evaluator or JS coercion, is the semantics oracle.
     * @param {string} condition
     * @param {import('@sqlite.org/sqlite-wasm').BindingSpec} [bindings]
     * @returns {unknown[]}
     */
    const check = (condition, bindings = []) => {
        const sql = `SELECT rowid, dictionary, expression, reading, sequence FROM TABLE WHERE ${condition} ORDER BY rowid`
        const expected = connection.selectObjects(sql.replace('TABLE', 'reference'), bindings)
        const actual = connection.selectObjects(sql.replace('TABLE', 'terms'), bindings)
        expect(actual, condition).toEqual(expected)
        return actual
    }
    return {connection, database, store, check}
}

/**
 * @param {string[]} values
 * @returns {string[][]}
 */
function permutations(values) {
    if (values.length === 0) { return [[]] }
    return values.flatMap((value, i) => permutations(values.filter((_, j) => j !== i)).map((rest) => [value, ...rest]))
}

describe('real SQLite terms virtual-table planning', () => {
    test('all 120 condition orders bind to the same columns', () => {
        const {check} = fixture()
        for (const conditions of permutations(["dictionary = 'Dict'", "expression = 'entry'", "reading = 'reading'", 'sequence = 42', 'rowid = 1'])) {
            expect(check(conditions.join(' AND '))).toHaveLength(1)
        }
    })

    test('every reordered subset works with separately named bindings', () => {
        const {check} = fixture()
        const conditions = ['dictionary = $d', 'expression = $e', 'reading = $r', 'sequence = $s']
        for (let mask = 1; mask < 16; ++mask) {
            for (const chosen of permutations(conditions.filter((_, i) => mask & (1 << i)))) {
                const values = {$d: 'Dict', $e: 'entry', $r: 'reading', $s: 42}
                const bindings = Object.fromEntries(Object.entries(values).filter(([name]) => chosen.some((term) => term.includes(name))))
                check(chosen.join(' AND '), bindings)
            }
        }
    })

    test.each(['rowid', 'dictionary', 'expression', 'reading', 'sequence'])('leaves duplicate %s equalities for SQLite to recheck', (column) => {
        const {check} = fixture()
        for (const values of [['Dict', 'Other'], ['entry', 'other'], ['reading', 'different'], [42, 7], [1, 2], [null, ''], ['', '']]) {
            check(`${column} = ?1 AND ${column} = ?2 AND dictionary = 'Dict'`, values)
            check(`dictionary = 'Dict' AND ${column} = ?2 AND ${column} = ?1`, values)
        }
    })

    test.each(['rowid', 'dictionary', 'expression', 'reading', 'sequence'])('preserves NULL, storage classes and affinity for %s', (column) => {
        const {check} = fixture()
        for (const value of [null, '', -1, 0, 1, 1.5, '1', '1.0', '001', '42', '42.0', '4.2e1', '123', ' 42 ', '0x2a', 'invalid', 1e30, new Uint8Array([49])]) {
            check(`${column} = ?`, [value])
            check(`${column} = ? AND dictionary = 'Dict'`, [value])
        }
        check(`${column} IS NULL`)
        check(`${column} IS NOT NULL`)
    })

    test('never interprets a NULL filter as an empty-string or missing-sequence sentinel', () => {
        const {check} = fixture()
        for (const column of ['dictionary', 'expression', 'reading', 'sequence']) {
            expect(check(`${column} = NULL`)).toHaveLength(0)
            expect(check(`${column} = ? AND rowid = ?`, [null, 5])).toHaveLength(0)
        }
        for (const id of [0, -1, 1.5, 999]) { expect(check('rowid = ?', [id])).toHaveLength(0) }
    })

    test.each(['BINARY', 'NOCASE', 'RTRIM'])('preserves %s collations and mixed-collation duplicates', (collation) => {
        const {check} = fixture()
        for (const column of ['dictionary', 'expression', 'reading']) {
            for (const value of ['dict', 'ENTRY', 'reading ', 'entry']) {
                check(`${column} COLLATE ${collation} = ?`, [value])
                check(`? = ${column} COLLATE ${collation} AND dictionary = 'Dict'`, [value])
            }
        }
        check(`expression COLLATE ${collation} = 'ENTRY' AND expression = 'entry'`)
        check(`expression = 'entry' AND expression COLLATE ${collation} = 'ENTRY'`)
    })

    test('supports repeated IN filters, OR alternatives, ranges and parameter reuse', () => {
        const {check} = fixture()
        for (const condition of [
            "expression IN ('entry', 'other', NULL) AND dictionary IN ('Dict', 'Other')",
            "dictionary IN ('Other', 'Dict') AND sequence IN (7, 42, NULL)",
            "dictionary = 'Dict' AND expression IN ('entry', 'other') AND expression IN ('other', '123')",
            "(expression = 'entry' AND dictionary = 'Dict') OR (sequence = 42 AND dictionary = 'Other')",
            "reading = 'reading' AND rowid >= 1 AND rowid <= 9",
            "dictionary = 'Dict' AND sequence BETWEEN 1 AND 43",
            'rowid IN (0, 1, 3, NULL)',
        ]) { check(condition) }
        for (const value of ['entry', 'other', '', 'entry']) { check('expression = ? AND dictionary = ?', [value, 'Dict']) }
    })

    test('preserves join-dependent usable constraints and multiple active cursors', () => {
        const {connection} = fixture()
        connection.exec("CREATE TABLE queries(d TEXT, e TEXT); INSERT INTO queries VALUES ('Dict', 'entry'), ('Other', 'entry'), ('Dict', 'missing')")
        for (const join of ['JOIN', 'LEFT JOIN']) {
            const sql = `SELECT q.rowid AS queryId, t.rowid AS termId FROM queries q ${join} TABLE t ON t.expression=q.e AND t.dictionary=q.d ORDER BY q.rowid, t.rowid`
            expect(connection.selectObjects(sql.replace('TABLE', 'terms'))).toEqual(connection.selectObjects(sql.replace('TABLE', 'reference')))
        }
        const one = connection.prepare("SELECT rowid FROM terms WHERE dictionary='Dict' AND expression='entry' ORDER BY rowid")
        const two = connection.prepare("SELECT rowid FROM terms WHERE sequence=42 AND dictionary='Other'")
        try {
            expect(one.step()).toBe(true)
            expect(one.get(0)).toBe(1)
            expect(two.step()).toBe(true)
            expect(two.get(0)).toBe(3)
            expect(one.step()).toBe(true)
            expect(one.get(0)).toBe(4)
        } finally { one.finalize(); two.finalize() }
    })

    test('keeps scoped results live and owned across deletion, moves and missing membership metadata', () => {
        const {check, store, connection, database} = fixture()
        const saved = store.getResidentIdsForDictionary('physical-A')
        const savedCopy = [...saved]
        store._deleteRecord(1)
        connection.exec('DELETE FROM reference WHERE rowid=1')
        const record = store.getById(2)
        if (!record) { throw new Error('Missing fixture record') }
        for (const title of ['Other', '', 'Dict', '', 'Other', 'Dict']) {
            store._storeRecord({...record, dictionary: database._getTermRecordStorageName(title)})
            connection.exec({sql: 'UPDATE reference SET dictionary=? WHERE rowid=2', bind: [title]})
            for (const name of ['Dict', 'Other', '']) { check('dictionary = ?', [name]) }
        }
        expect(saved).toEqual(savedCopy)
        saved.fill(-1)
        check("dictionary='Dict'")
        /** @type {Map<string, number[]>} */
        const memberships = Reflect.get(store, '_recordIdsByDictionary')
        memberships.delete('physical-A')
        check("dictionary='Dict'")
        check("dictionary='missing'")
    })

    test('scopes resident IDs without global sorting, index building or record mutation', () => {
        const {check, store} = fixture()
        const scan = vi.spyOn(store, 'getAllIds')
        const scoped = vi.spyOn(store, 'getResidentIdsForDictionary')
        const index = vi.spyOn(store, 'getDictionaryIndex')
        check("dictionary = 'Dict' AND expression = 'entry'")
        check("reading = 'reading' AND dictionary = 'Dict' AND sequence = 42")
        check("sequence = 7 AND dictionary = 'Dict'")
        check('rowid = 0')
        check('rowid = 1')
        expect(scan).not.toHaveBeenCalled()
        check("expression='unread' AND dictionary='Dict'")
        check("reading='' AND dictionary='Dict'")
        check("reading='alias' AND dictionary='Dict'")
        expect(scoped).toHaveBeenCalledWith('physical-A')
        expect(index).not.toHaveBeenCalled()
    })
})
