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

import {describe, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';

/**
 * @param {number} byte
 * @param {number} hash1
 * @param {number} hash2
 * @param {string|null} dictName
 * @returns {import('dictionary-database').DatabaseTermEntry}
 */
function createRow(byte, hash1, hash2, dictName) {
    return /** @type {import('dictionary-database').DatabaseTermEntry} */ (/** @type {unknown} */ ({
        dictionary: 'Test',
        expression: `term-${byte}`,
        reading: `term-${byte}`,
        rules: '',
        definitionTags: '',
        termTags: '',
        glossary: [],
        score: 0,
        sequence: null,
        termEntryContentHash: hash1.toString(16).padStart(8, '0') + hash2.toString(16).padStart(8, '0'),
        termEntryContentHash1: hash1,
        termEntryContentHash2: hash2,
        termEntryContentBytes: new Uint8Array([byte, byte + 1]),
        termEntryContentDictName: dictName,
    }));
}

describe('DictionaryDatabase generic term dedup content descriptors', () => {
    test('keeps content dict names aligned with compacted pending-content indexes after cache hits', async () => {
        const database = new DictionaryDatabase();
        Reflect.set(database, '_enableTermEntryContentDedup', true);
        Reflect.set(database, '_termContentZstdInitialized', true);
        Reflect.set(database, '_termContentStorageMode', 'raw-bytes');
        Reflect.set(database, '_bulkImportTransactionOpen', true);
        Reflect.set(database, '_db', {});

        const cachedRow = createRow(1, 1, 11, null);
        const newRow = createRow(3, 2, 22, 'custom-content-dict');

        Reflect.set(database, '_findMatchingTermEntryContentMeta', vi.fn(
            (_hash1, _hash2, contentBytes) => (contentBytes[0] === 1 ?
                {id: 0, offset: 100, length: contentBytes.byteLength, dictName: 'cached-content-dict'} :
                void 0),
        ));
        Reflect.set(database, '_ensureTermEntryContentMetaHashPairCapacity', vi.fn());
        Reflect.set(database, '_cacheTermEntryContentMeta', vi.fn());
        Reflect.set(database, '_termContentStore', {
            appendBatch: vi.fn(async (/** @type {Uint8Array[]} */ chunks) => chunks.map((chunk, index) => ({
                offset: 200 + index * 100,
                length: chunk.byteLength,
            }))),
        });

        const inserted = vi.fn(async (
            _rows,
            _offsets,
            _lengths,
            contentDictNames,
        ) => {
            expect(contentDictNames).toEqual([
                'cached-content-dict',
                'custom-content-dict',
            ]);
            return {termRecordAppendMs: 0, termsVtabInsertMs: 0};
        });
        Reflect.set(database, '_insertResolvedImportTermEntries', inserted);

        await Reflect.get(database, '_bulkAddTerms').call(database, [cachedRow, newRow], 0, 2);

        expect(inserted).toHaveBeenCalledTimes(1);
    });

    test('keeps later unique descriptors aligned after an intra-batch duplicate', async () => {
        const database = new DictionaryDatabase();
        Reflect.set(database, '_enableTermEntryContentDedup', true);
        Reflect.set(database, '_termContentZstdInitialized', true);
        Reflect.set(database, '_termContentStorageMode', 'raw-bytes');
        Reflect.set(database, '_bulkImportTransactionOpen', true);
        Reflect.set(database, '_db', {});
        Reflect.set(database, '_findMatchingTermEntryContentMeta', vi.fn(() => void 0));
        Reflect.set(database, '_ensureTermEntryContentMetaHashPairCapacity', vi.fn());
        Reflect.set(database, '_cacheTermEntryContentMeta', vi.fn());
        Reflect.set(database, '_termContentStore', {
            appendBatch: vi.fn(async (/** @type {Uint8Array[]} */ chunks) => chunks.map((chunk, index) => ({
                offset: 300 + index * 100,
                length: chunk.byteLength,
            }))),
        });

        const first = createRow(5, 5, 55, 'first-dict');
        const duplicate = createRow(5, 5, 55, 'first-dict');
        const laterUnique = createRow(7, 7, 77, 'later-dict');
        const inserted = vi.fn(async (
            _rows,
            _offsets,
            _lengths,
            contentDictNames,
        ) => {
            expect(contentDictNames).toEqual([
                'first-dict',
                'first-dict',
                'later-dict',
            ]);
            return {termRecordAppendMs: 0, termsVtabInsertMs: 0};
        });
        Reflect.set(database, '_insertResolvedImportTermEntries', inserted);

        await Reflect.get(database, '_bulkAddTerms').call(
            database,
            [first, duplicate, laterUnique],
            0,
            3,
        );

        expect(inserted).toHaveBeenCalledTimes(1);
    });
});
