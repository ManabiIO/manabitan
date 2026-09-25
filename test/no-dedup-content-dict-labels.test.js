/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {createTermRecordPreinternedPlanBuilder} from '../ext/js/dictionary/term-record-preinterned-plan.js';
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js';
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
        expect(Reflect.get(appendRecords.mock.calls[0], 5)).toEqual([
            RAW_TERM_CONTENT_DICT_NAME,
            RAW_TERM_CONTENT_TOKEN_DICT_NAME,
        ]);
    });

    test('slices a preinterned plan for partial resolved-content batches', async () => {
        const store = new TermRecordOpfsStore();
        const getOrCreateShardState = vi.spyOn(store, '_getOrCreateShardState')
            .mockResolvedValue(/** @type {import('core').SafeAny} */ ({}));
        const encodeAndAppend = vi.spyOn(store, '_encodeAndAppendChunkRunsForState')
            .mockResolvedValue({encodeMs: 0, appendWriteMs: 0});

        const rows = ['a', 'b', 'c', 'd'].map((expression) => ({
            dictionary: 'Partial plan',
            expression,
            reading: expression,
            score: 0,
            sequence: -1,
        }));
        const encoder = new TextEncoder();
        const builder = createTermRecordPreinternedPlanBuilder(rows.length);
        const indexes = rows.map(({expression}) => builder.internStringBytes(encoder.encode(expression)));
        Reflect.set(rows, 'termRecordPreinternedPlan', builder.buildPlan(indexes, indexes));

        await store.appendBatchFromImportTermEntriesResolvedContent(
            rows,
            1,
            2,
            [10, 20],
            [1, 1],
            RAW_TERM_CONTENT_DICT_NAME,
        );

        expect(getOrCreateShardState).toHaveBeenCalledWith('Partial plan', RAW_TERM_CONTENT_DICT_NAME);
        expect(encodeAndAppend).toHaveBeenCalledOnce();
        const slicedPlan = Reflect.get(encodeAndAppend.mock.calls[0], 2);
        expect([...slicedPlan.expressionIndexes]).toEqual([1, 2]);
        expect([...slicedPlan.readingIndexes]).toEqual([1, 2]);
    });
});
