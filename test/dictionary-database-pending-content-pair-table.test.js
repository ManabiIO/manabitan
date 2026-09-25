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

import {expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';

/**
 * @param {number[]} values
 * @returns {import('dictionary-database').DatabaseTermEntry}
 */
function createRow(values) {
    return /** @type {import('dictionary-database').DatabaseTermEntry} */ ({
        dictionary: 'test',
        expression: 'x',
        reading: '',
        definitionTags: '',
        termTags: '',
        rules: '',
        glossary: [],
        score: 0,
        sequence: -1,
        termEntryContentBytes: Uint8Array.from(values),
        termEntryContentHash1: 0x12345678,
        termEntryContentHash2: 0x9abcdef0,
    });
}

test('generic term dedupe retains byte-distinct entries which share a hash pair', async () => {
    const database = new DictionaryDatabase();
    Reflect.set(database, '_termContentZstdInitialized', true);
    Reflect.set(database, '_bulkImportTransactionOpen', true);
    Reflect.set(database, '_db', {});

    /** @type {Uint8Array[][]} */
    const appendedBatches = [];
    Reflect.set(database, '_termContentStore', {
        appendBatch: vi.fn(async (/** @type {Uint8Array[]} */ chunks) => {
            appendedBatches.push(chunks.map((chunk) => Uint8Array.from(chunk)));
            return chunks.map((_chunk, index) => ({offset: 100 + index * 100, length: 1}));
        }),
    });
    Reflect.set(database, '_findMatchingTermEntryContentMeta', vi.fn(() => void 0));
    Reflect.set(database, '_ensureTermEntryContentMetaHashPairCapacity', vi.fn());
    Reflect.set(database, '_cacheTermEntryContentMeta', vi.fn());
    Reflect.set(database, '_createTermContentStorageChunks', vi.fn((/** @type {Uint8Array[]} */ pendingContentBytes) => ({
        storedChunks: pendingContentBytes,
        entryToStoredChunkIndexes: pendingContentBytes.map((_bytes, index) => index),
        entryToStoredChunkOffsets: pendingContentBytes.map(() => 0),
        contentDictNames: pendingContentBytes.map(() => 'raw'),
    })));

    /** @type {number[]} */
    const insertedOffsets = [];
    Reflect.set(database, '_insertResolvedImportTermEntries', vi.fn(async (
        /** @type {import('dictionary-database').DatabaseTermEntry[]} */ _rows,
        /** @type {number[]} */ contentOffsets,
        /** @type {number[]} */ _contentLengths,
        /** @type {(string|null)[]} */ _contentDictNames,
        /** @type {number} */ start,
        /** @type {number} */ count,
    ) => {
        insertedOffsets.push(...contentOffsets.slice(start, start + count));
        return {termRecordAppendMs: 0, termsVtabInsertMs: 0};
    }));

    const rows = [
        createRow([1]),
        createRow([2]),
        createRow([1]),
    ];
    const bulkAddTerms = Reflect.get(database, '_bulkAddTerms').bind(database);
    await bulkAddTerms(rows, 0, rows.length);

    expect(appendedBatches).toHaveLength(1);
    expect(appendedBatches[0]).toEqual([
        Uint8Array.from([1]),
        Uint8Array.from([2]),
    ]);
    expect(insertedOffsets).toEqual([100, 200, 100]);
});

test('generic term dedupe clears shared pair-table occupancy between staging batches', async () => {
    const database = new DictionaryDatabase();
    Reflect.set(database, '_termContentZstdInitialized', true);
    Reflect.set(database, '_bulkImportTransactionOpen', true);
    Reflect.set(database, '_db', {});
    Reflect.set(database, '_termBulkAddStagingMaxRows', 512);

    /** @type {number[]} */
    const batchSizes = [];
    Reflect.set(database, '_termContentStore', {
        appendBatch: vi.fn(async (/** @type {Uint8Array[]} */ chunks) => {
            batchSizes.push(chunks.length);
            return chunks.map((_chunk, index) => ({offset: 1000 + index, length: 1}));
        }),
    });
    Reflect.set(database, '_findMatchingTermEntryContentMeta', vi.fn(() => void 0));
    Reflect.set(database, '_ensureTermEntryContentMetaHashPairCapacity', vi.fn());
    Reflect.set(database, '_cacheTermEntryContentMeta', vi.fn());
    Reflect.set(database, '_createTermContentStorageChunks', vi.fn((/** @type {Uint8Array[]} */ pendingContentBytes) => ({
        storedChunks: pendingContentBytes,
        entryToStoredChunkIndexes: pendingContentBytes.map((_bytes, index) => index),
        entryToStoredChunkOffsets: pendingContentBytes.map(() => 0),
        contentDictNames: pendingContentBytes.map(() => 'raw'),
    })));
    Reflect.set(database, '_insertResolvedImportTermEntries', vi.fn(async () => ({
        termRecordAppendMs: 0,
        termsVtabInsertMs: 0,
    })));

    const rows = Array.from({length: 513}, (_value, index) => {
        const row = createRow([index & 0xff, (index >>> 8) & 0xff]);
        row.termEntryContentHash1 = index + 1;
        row.termEntryContentHash2 = (index + 17) * 31;
        return row;
    });
    const bulkAddTerms = Reflect.get(database, '_bulkAddTerms').bind(database);
    await bulkAddTerms(rows, 0, rows.length);

    expect(batchSizes).toEqual([512, 1]);
});
