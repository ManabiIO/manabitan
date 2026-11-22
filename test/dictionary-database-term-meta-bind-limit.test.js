/*
 * Copyright (C) 2026 Manabitan authors
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

import {readFile} from 'node:fs/promises';
import {afterEach, beforeAll, describe, expect, test, vi} from 'vitest';
import sqlite3InitModule from '../ext/lib/sqlite/index.mjs';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';

/** @type {import('@sqlite.org/sqlite-wasm').Sqlite3Static} */
let sqlite3;
/** @type {import('@sqlite.org/sqlite-wasm').Database[]} */
const handles = [];

beforeAll(async () => {
    const initialize = /** @type {(options: {wasmBinary: Uint8Array}) => Promise<import('@sqlite.org/sqlite-wasm').Sqlite3Static>} */ (sqlite3InitModule);
    sqlite3 = await initialize({wasmBinary: await readFile(new URL('../ext/lib/sqlite/sqlite3.wasm', import.meta.url))});
});

afterEach(() => {
    for (const handle of handles.splice(0)) { handle.close(); }
});

/** @returns {{database: DictionaryDatabase, sql: import('@sqlite.org/sqlite-wasm').Database}} */
function createFixture() {
    const sql = new sqlite3.oo1.DB(':memory:', 'c');
    handles.push(sql);
    sql.exec(`
        CREATE TABLE termMeta (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            dictionary TEXT NOT NULL,
            expression TEXT NOT NULL,
            mode TEXT NOT NULL,
            dataJson TEXT NOT NULL
        );
        CREATE INDEX idx_term_meta_expression_dictionary ON termMeta(expression, dictionary);
    `);
    const database = new DictionaryDatabase();
    Reflect.set(database, '_db', sql);
    return {database, sql};
}

/** @param {import('@sqlite.org/sqlite-wasm').Database} sql */
function insertFixtureRows(sql) {
    for (const [dictionary, expression, data] of /** @type {[string, string, string][]} */ ([
        ['VNDB Characters by Bee', 'zeta', '{"rank":1}'],
        ['VNDB Characters by Bee', 'alpha', '{"rank":2}'],
        ['VNDB Characters by Bee', 'middle', '{"rank":3}'],
        ['Other Dictionary', 'alpha', '{"rank":99}'],
    ])) {
        sql.exec({
            sql: 'INSERT INTO termMeta (dictionary, expression, mode, dataJson) VALUES ($dictionary, $expression, $mode, $dataJson)',
            bind: {$dictionary: dictionary, $expression: expression, $mode: 'freq', $dataJson: data},
        });
    }
}

describe('DictionaryDatabase.findTermMetaBulk SQLite binding limit', () => {
    test('large lookups avoid the SQLite variable ceiling and keep complete ordered rows and item indexes', async () => {
        const {database, sql} = createFixture();
        insertFixtureRows(sql);
        const terms = Array.from({length: 32769}, (_, index) => `term-${index}`);
        terms[3] = 'zeta';
        terms[20] = 'alpha';
        terms[32765] = 'middle';
        terms[32768] = 'alpha';
        const dictionaries = new Map([['VNDB Characters by Bee', {}]]);

        const statement = vi.spyOn(database, '_getCachedStatement');
        const results = await database.findTermMetaBulk(terms, dictionaries);
        const smallQueryResults = await database.findTermMetaBulk(['zeta', 'alpha', 'middle'], dictionaries);

        expect(results.map(({term, mode, data, dictionary}) => ({term, mode, data, dictionary}))).toEqual(
            smallQueryResults.map(({term, mode, data, dictionary}) => ({term, mode, data, dictionary})).flatMap((item) => (
                item.term === 'alpha' ? [item, item] : [item]
            )),
        );
        expect(results.map(({term, index}) => ({term, index}))).toContainEqual({term: 'alpha', index: 20});
        expect(results.map(({term, index}) => ({term, index}))).toContainEqual({term: 'alpha', index: 32768});
        expect(results.some(({dictionary}) => dictionary === 'Other Dictionary')).toBe(false);
        expect(sql.selectValue("SELECT compile_options FROM pragma_compile_options WHERE compile_options = 'MAX_VARIABLE_NUMBER=32766'")).toBe('MAX_VARIABLE_NUMBER=32766');
        expect(statement).toHaveBeenCalledTimes(2);
        expect(statement.mock.calls[0][0]).toContain('json_each($termsJson)');
        expect(statement.mock.calls[0][0]).toContain('json_each($dictionariesJson)');
        expect(statement.mock.calls[1][0]).toContain('expression IN ($term0, $term1, $term2)');
    });

    test('small lookups retain the placeholder query path', async () => {
        const {database, sql} = createFixture();
        insertFixtureRows(sql);
        const statement = vi.spyOn(database, '_getCachedStatement');

        await database.findTermMetaBulk(['alpha'], new Map([['VNDB Characters by Bee', {}]]));

        expect(statement).toHaveBeenCalledOnce();
        expect(statement.mock.calls[0][0]).toContain('expression IN ($term0)');
        expect(statement.mock.calls[0][0]).toContain('dictionary IN ($dict0)');
        expect(statement.mock.calls[0][0]).not.toContain('json_each');
    });
});
