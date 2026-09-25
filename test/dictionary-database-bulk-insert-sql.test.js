/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';

describe('DictionaryDatabase bulk insert SQL reuse', () => {
    test('preserves SQL shape, bindings and tail batches', async () => {
        const database = new DictionaryDatabase();
        /** @type {string[]} */
        const sqls = [];
        /** @type {unknown[][]} */
        const binds = [];
        const bindRow = vi.fn((/** @type {number} */ value) => [value, value * 10]);
        Reflect.set(database, '_getCachedStatement', (/** @type {string} */ sql) => {
            sqls.push(sql);
            return {
                reset() {},
                bind(/** @type {unknown[]} */ values) {
                    binds.push([...values]);
                },
                step() {},
            };
        });

        await Reflect.get(database, '_bulkInsertWithDescriptor').call(
            database,
            {
                table: 'sample',
                columnsSql: 'a, b',
                rowPlaceholderSql: '(?, ?)',
                batchSize: 2,
                bindRow,
            },
            [1, 2, 3, 4, 5],
            0,
            5,
        );

        expect(sqls).toEqual([
            'INSERT INTO sample(a, b) VALUES (?, ?),(?, ?)',
            'INSERT INTO sample(a, b) VALUES (?, ?),(?, ?)',
            'INSERT INTO sample(a, b) VALUES (?, ?)',
        ]);
        expect(binds).toEqual([
            [1, 10, 2, 20],
            [3, 30, 4, 40],
            [5, 50],
        ]);
        expect(bindRow).toHaveBeenCalledTimes(5);
    });

    test('keeps an empty insert as a no-op', async () => {
        const database = new DictionaryDatabase();
        const getCachedStatement = vi.fn();
        Reflect.set(database, '_getCachedStatement', getCachedStatement);

        await Reflect.get(database, '_bulkInsertWithDescriptor').call(
            database,
            {
                table: 'sample',
                columnsSql: 'value',
                rowPlaceholderSql: '(?)',
                batchSize: 4,
                bindRow: (value) => [value],
            },
            [],
            0,
            0,
        );

        expect(getCachedStatement).not.toHaveBeenCalled();
    });

    test('keeps a single partial batch on the ordinary construction path', async () => {
        const database = new DictionaryDatabase();
        /** @type {string[]} */
        const sqls = [];
        Reflect.set(database, '_getCachedStatement', (/** @type {string} */ sql) => {
            sqls.push(sql);
            return {reset() {}, bind() {}, step() {}};
        });

        await Reflect.get(database, '_bulkInsertWithDescriptor').call(
            database,
            {
                table: 'sample',
                columnsSql: 'value',
                rowPlaceholderSql: '(?)',
                batchSize: 4,
                bindRow: (value) => [value],
            },
            [1, 2],
            0,
            2,
        );

        expect(sqls).toEqual(['INSERT INTO sample(value) VALUES (?),(?)']);
    });
});
