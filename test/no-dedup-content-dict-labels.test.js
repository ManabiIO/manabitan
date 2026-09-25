/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {
    RAW_TERM_CONTENT_DICT_NAME,
    RAW_TERM_CONTENT_TOKEN_DICT_NAME,
} from '../ext/js/dictionary/raw-term-content.js';
import {createTermRecordPreinternedPlanBuilder} from '../ext/js/dictionary/term-record-preinterned-plan.js';
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js';

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

/**
 * @param {unknown[]} rows
 * @param {string[]} expressions
 */
function attachPreinternedPlan(rows, expressions) {
    const encoder = new TextEncoder();
    const builder = createTermRecordPreinternedPlanBuilder(expressions.length);
    const indexes = expressions.map((value) => builder.internStringBytes(encoder.encode(value)));
    Reflect.set(rows, 'termRecordPreinternedPlan', builder.buildPlan(indexes, indexes));
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

    test('shards one dictionary by per-row resolved content label without losing preinterned row alignment', async () => {
        const store = new TermRecordOpfsStore();
        const getOrCreateShardState = vi.spyOn(store, '_getOrCreateShardState')
            .mockResolvedValue(/** @type {import('core').SafeAny} */ ({}));
        const encodeAndAppend = vi.spyOn(store, '_encodeAndAppendChunkRunsForState')
            .mockResolvedValue({encodeMs: 0, appendWriteMs: 0});
        const rows = [
            {
                dictionary: 'Mixed content',
                expression: 'a',
                reading: 'a',
                score: 0,
                sequence: -1,
            },
            {
                dictionary: 'Mixed content',
                expression: 'b',
                reading: 'b',
                score: 0,
                sequence: -1,
            },
            {
                dictionary: 'Mixed content',
                expression: 'c',
                reading: 'c',
                score: 0,
                sequence: -1,
            },
        ];
        attachPreinternedPlan(rows, ['a', 'b', 'c']);

        await store.appendBatchFromImportTermEntriesResolvedContent(
            rows,
            0,
            rows.length,
            [10, 20, 30],
            [1, 1, 1],
            [RAW_TERM_CONTENT_DICT_NAME, RAW_TERM_CONTENT_TOKEN_DICT_NAME, RAW_TERM_CONTENT_DICT_NAME],
        );

        expect(getOrCreateShardState.mock.calls).toEqual([
            ['Mixed content', RAW_TERM_CONTENT_DICT_NAME],
            ['Mixed content', RAW_TERM_CONTENT_TOKEN_DICT_NAME],
        ]);
        expect(encodeAndAppend).toHaveBeenCalledTimes(2);
        expect(encodeAndAppend.mock.calls[0][3]).toEqual([0, 2]);
        expect(encodeAndAppend.mock.calls[1][3]).toEqual([1]);
    });

});
