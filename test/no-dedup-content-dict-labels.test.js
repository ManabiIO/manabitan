/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {
    RAW_TERM_CONTENT_DICT_NAME,
    RAW_TERM_CONTENT_TOKEN_DICT_NAME,
} from '../ext/js/dictionary/raw-term-content.js';

/**
 * @param {string} expression
 * @param {string} contentDictName
 * @returns {import('dictionary-database').DatabaseTermEntry}
 */
function createDatabaseRow(expression, contentDictName) {
    return /** @type {import('dictionary-database').DatabaseTermEntry} */ ({
        dictionary: 'Mixed content',
        expression,
        reading: expression,
        definitionTags: '',
        termTags: '',
        rules: '',
        glossary: [],
        score: 0,
        sequence: -1,
        termEntryContentBytes: Uint8Array.of(expression.charCodeAt(0)),
        termEntryContentDictName: contentDictName,
    });
}

describe('no-dedup content dictionary labels', () => {
    test('preserves mixed explicit labels through generic no-dedup import', async () => {
        const database = new DictionaryDatabase();
        Reflect.set(database, '_bulkImportTransactionOpen', true);
        Reflect.set(database, '_termContentStorageMode', 'raw-bytes');

        Reflect.set(database, '_termContentStore', {
            appendBatchToArrays: vi.fn(async (chunks, offsets, lengths) => {
                let offset = 100;
                for (let i = 0; i < chunks.length; ++i) {
                    offsets[i] = offset;
                    lengths[i] = chunks[i].byteLength;
                    offset += chunks[i].byteLength;
                }
            }),
        });
        const appendRecords = vi.fn(async () => ({
            buildRecordsMs: 0,
            encodeMs: 0,
            appendWriteMs: 0,
        }));
        Reflect.set(database, '_termRecordStore', {
            appendBatchFromImportTermEntriesResolvedContent: appendRecords,
        });

        const rows = [
            createDatabaseRow('a', RAW_TERM_CONTENT_DICT_NAME),
            createDatabaseRow('b', RAW_TERM_CONTENT_TOKEN_DICT_NAME),
        ];
        const bulkAdd = Reflect.get(database, '_bulkAddTermsWithoutContentDedup').bind(database);
        await bulkAdd(rows, 0, rows.length);

        expect(appendRecords).toHaveBeenCalledOnce();
        expect(appendRecords.mock.calls[0][5]).toEqual([
            RAW_TERM_CONTENT_DICT_NAME,
            RAW_TERM_CONTENT_TOKEN_DICT_NAME,
        ]);
    });
});
