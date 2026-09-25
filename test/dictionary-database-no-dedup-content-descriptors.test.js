/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {
    encodeRawTermContentBinary,
    RAW_TERM_CONTENT_DICT_NAME,
} from '../ext/js/dictionary/raw-term-content.js';
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js';

/**
 * @param {string} expression
 * @param {Uint8Array} contentBytes
 * @param {string|null} [contentDictName=null]
 * @returns {import('dictionary-database').DatabaseTermEntry}
 */
function row(expression, contentBytes, contentDictName = null) {
    const result = /** @type {import('dictionary-database').DatabaseTermEntry} */ ({
        dictionary: 'Test',
        expression,
        reading: expression,
        rules: '',
        definitionTags: '',
        termTags: '',
        glossary: [],
        score: 0,
        sequence: null,
        termEntryContentBytes: contentBytes,
    });
    if (contentDictName !== null) {
        result.termEntryContentDictName = contentDictName;
    }
    return result;
}

describe('no-dedup term content descriptors', () => {
    test('preserves mixed descriptors through raw-byte slab packing', async () => {
        const database = new DictionaryDatabase();
        Reflect.set(database, '_enableTermEntryContentDedup', false);
        Reflect.set(database, '_termContentStorageMode', 'raw-bytes');
        Reflect.set(database, '_bulkImportTransactionOpen', true);
        Reflect.set(database, '_deferTermsVirtualTableSync', true);

        let nextOffset = 1000;
        Reflect.set(database, '_termContentStore', {
            appendBatchToArrays: vi.fn(async (
                /** @type {Uint8Array[]} */ chunks,
                /** @type {number[]} */ offsets,
                /** @type {number[]} */ lengths,
            ) => {
                for (let i = 0; i < chunks.length; ++i) {
                    offsets[i] = nextOffset;
                    lengths[i] = chunks[i].byteLength;
                    nextOffset += chunks[i].byteLength;
                }
            }),
        });

        const recordAppend = vi.fn(async (
            _rows,
            _start,
            _count,
            _offsets,
            _lengths,
            contentDictNames,
        ) => ({
            buildRecordsMs: 0,
            encodeMs: 0,
            appendWriteMs: 0,
            internMs: 0,
            packLengthsMs: 0,
            heapCopyMs: 0,
            recordFieldEncodeMs: 0,
            contentDictNames,
        }));
        Reflect.set(database, '_termRecordStore', {
            appendBatchFromImportTermEntriesResolvedContent: recordAppend,
        });

        const encoder = new TextEncoder();
        const rawContent = encodeRawTermContentBinary(
            '',
            '',
            '',
            encoder.encode('["raw definition"]'),
            encoder,
        );
        const rows = [
            row('json', encoder.encode('{"glossary":["json definition"]}')),
            row('raw', rawContent),
            row('custom', new Uint8Array([1, 2, 3, 4]), 'custom-content-dict'),
        ];

        await Reflect.get(database, '_bulkAddTerms').call(database, rows, 0, rows.length);

        expect(recordAppend).toHaveBeenCalledTimes(1);
        expect(recordAppend.mock.calls[0][5]).toEqual([
            'raw',
            RAW_TERM_CONTENT_DICT_NAME,
            'custom-content-dict',
        ]);
    });

    test('term-record persistence shards mixed descriptors without changing row order or offsets', async () => {
        const store = new TermRecordOpfsStore();
        Reflect.set(store, '_nextId', 1);
        Reflect.set(store, '_nextIdReady', true);
        const requestedShards = [];
        const appended = [];
        Reflect.set(store, '_getOrCreateShardState', vi.fn(async (
            /** @type {string} */ dictionary,
            /** @type {string} */ contentDictName,
        ) => {
            requestedShards.push([dictionary, contentDictName]);
            return /** @type {ReturnType<TermRecordOpfsStore['_createShardState']>} */ (/** @type {unknown} */ ({
                dictionary,
                contentDictName,
            }));
        }));
        Reflect.set(store, '_encodeAndAppendChunkRunsForState', vi.fn(async (
            state,
            records,
            preinternedPlan,
        ) => {
            appended.push({
                contentDictName: state.contentDictName,
                records: records.map(({expression, entryContentOffset, entryContentDictName}) => ({
                    expression,
                    entryContentOffset,
                    entryContentDictName,
                })),
                preinternedPlan,
            });
            return {encodeMs: 0, appendWriteMs: 0};
        }));

        const rows = [
            {dictionary: 'Test', expression: 'a', reading: 'a', score: 0, sequence: null},
            {dictionary: 'Test', expression: 'b', reading: 'b', score: 0, sequence: null},
            {dictionary: 'Test', expression: 'c', reading: 'c', score: 0, sequence: null},
        ];

        await store.appendBatchFromImportTermEntriesResolvedContent(
            rows,
            0,
            rows.length,
            [10, 20, 30],
            [1, 2, 3],
            ['raw', RAW_TERM_CONTENT_DICT_NAME, 'raw'],
        );

        expect(requestedShards).toEqual([
            ['Test', 'raw'],
            ['Test', RAW_TERM_CONTENT_DICT_NAME],
        ]);
        expect(appended).toEqual([
            {
                contentDictName: 'raw',
                records: [
                    {expression: 'a', entryContentOffset: 10, entryContentDictName: 'raw'},
                    {expression: 'c', entryContentOffset: 30, entryContentDictName: 'raw'},
                ],
                preinternedPlan: null,
            },
            {
                contentDictName: RAW_TERM_CONTENT_DICT_NAME,
                records: [
                    {expression: 'b', entryContentOffset: 20, entryContentDictName: RAW_TERM_CONTENT_DICT_NAME},
                ],
                preinternedPlan: null,
            },
        ]);
    });

    test('retains the uniform scalar fast path', async () => {
        const store = new TermRecordOpfsStore();
        Reflect.set(store, '_nextId', 1);
        Reflect.set(store, '_nextIdReady', true);
        const encode = vi.fn(async () => ({encodeMs: 0, appendWriteMs: 0}));
        Reflect.set(store, '_getOrCreateShardState', vi.fn(async () => /** @type {ReturnType<TermRecordOpfsStore['_createShardState']>} */ (/** @type {unknown} */ ({}))));
        Reflect.set(store, '_encodeAndAppendChunkRunsForState', encode);
        const rows = [
            {dictionary: 'Test', expression: 'a', reading: 'a', score: 0, sequence: null},
            {dictionary: 'Test', expression: 'b', reading: 'b', score: 0, sequence: null},
        ];

        await store.appendBatchFromImportTermEntriesResolvedContent(
            rows,
            0,
            2,
            [10, 20],
            [1, 2],
            RAW_TERM_CONTENT_DICT_NAME,
        );

        expect(encode).toHaveBeenCalledTimes(1);
        expect(encode.mock.calls[0][1].map(({entryContentDictName}) => entryContentDictName)).toEqual([
            RAW_TERM_CONTENT_DICT_NAME,
            RAW_TERM_CONTENT_DICT_NAME,
        ]);
    });
});
