/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';

/**
 * @returns {{database: DictionaryDatabase, sqls: string[], binds: unknown[][]}}
 */
function createHarness() {
    const database = new DictionaryDatabase();
    /** @type {string[]} */
    const sqls = [];
    /** @type {unknown[][]} */
    const binds = [];
    Reflect.set(database, '_bulkImportTransactionOpen', true);
    Reflect.set(database, '_requireDb', () => ({exec() {}}));
    Reflect.set(database, '_getCachedStatement', (/** @type {string} */ sql) => {
        sqls.push(sql);
        return {
            reset() {},
            bind(/** @type {unknown[]} */ values) { binds.push([...values]); },
            step() {},
        };
    });
    return {database, sqls, binds};
}

/**
 * @param {string} sql
 * @returns {number}
 */
function countRows(sql) {
    return sql.split("x''").length - 1;
}

describe('DictionaryDatabase external media bulk insert SQL reuse', () => {
    test('reuses the full-batch SQL while preserving external media row bindings', async () => {
        const {database, sqls, binds} = createHarness();
        const items = Array.from({length: 513}, (_, index) => ({
            dictionary: 'Test',
            path: `media/${index}.webp`,
            mediaType: 'image/webp',
            width: index,
            height: index + 1,
            content: new ArrayBuffer(0),
            contentOffset: index * 10,
            contentLength: 10,
            contentCompressionMethod: 0,
            contentUncompressedLength: 10,
        }));

        await database.bulkAddExternalMediaRows(items);

        expect(sqls).toHaveLength(2);
        expect(countRows(sqls[0])).toBe(512);
        expect(countRows(sqls[1])).toBe(1);
        expect(binds[0]).toHaveLength(512 * 9);
        expect(binds[0].slice(0, 9)).toEqual([
            'Test', 'media/0.webp', 'image/webp', 0, 1, 0, 10, 0, 10,
        ]);
        expect(binds[1]).toEqual([
            'Test', 'media/512.webp', 'image/webp', 512, 513, 5120, 10, 0, 10,
        ]);
    });

    test('reuses the full-batch SQL while preserving manifest offsets and compression metadata', async () => {
        const {database, sqls, binds} = createHarness();
        const items = Array.from({length: 513}, (_, index) => ({
            path: `media/${index}.webp`,
            mediaType: 'image/webp',
            packedOffset: index * 10,
            packedLength: 10,
            compressionMethod: 8,
            uncompressedLength: 20,
        }));

        await database.bulkAddExternalMediaManifestRows('Test', items, 1000, true);

        expect(sqls).toHaveLength(2);
        expect(countRows(sqls[0])).toBe(512);
        expect(countRows(sqls[1])).toBe(1);
        expect(binds[0]).toHaveLength(512 * 9);
        expect(binds[0].slice(0, 9)).toEqual([
            'Test', 'media/0.webp', 'image/webp', 0, 0, 1000, 10, 8, 20,
        ]);
        expect(binds[1]).toEqual([
            'Test', 'media/512.webp', 'image/webp', 0, 0, 6120, 10, 8, 20,
        ]);
    });

    test('keeps a single partial external-media batch exact', async () => {
        const {database, sqls} = createHarness();
        const items = Array.from({length: 3}, (_, index) => ({
            dictionary: 'Test',
            path: `media/${index}.png`,
            mediaType: 'image/png',
            width: 0,
            height: 0,
            content: new ArrayBuffer(0),
        }));

        await database.bulkAddExternalMediaRows(items);

        expect(sqls).toHaveLength(1);
        expect(countRows(sqls[0])).toBe(3);
    });
});
