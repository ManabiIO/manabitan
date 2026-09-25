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
    encodeRawTermContentBinary,
    RAW_TERM_CONTENT_DICT_NAME,
} from '../ext/js/dictionary/raw-term-content.js';

const encoder = new TextEncoder();

/** @returns {Uint8Array} */
function createMalformedRawContent() {
    const bytes = encodeRawTermContentBinary('', '', '', encoder.encode('["x"]'), encoder);
    const malformed = Uint8Array.from(bytes);
    const view = new DataView(malformed.buffer, malformed.byteOffset, malformed.byteLength);
    view.setUint32(16, view.getUint32(16, true) + 1, true);
    return malformed;
}

/**
 * @param {Uint8Array} content
 * @returns {import('dictionary-database').DatabaseTermEntry}
 */
function createRow(content) {
    return /** @type {import('dictionary-database').DatabaseTermEntry} */ ({
        dictionary: 'Test',
        expression: 'term',
        reading: 'term',
        definitionTags: '',
        termTags: '',
        rules: '',
        glossary: [],
        score: 0,
        sequence: -1,
        termEntryContentBytes: content,
    });
}

describe('DictionaryDatabase raw-content descriptor inference', () => {
    test('storage planning does not label malformed raw magic as raw-term content', () => {
        const database = new DictionaryDatabase();
        Reflect.set(database, '_termContentStorageMode', 'raw-bytes');

        const valid = encodeRawTermContentBinary('', '', '', encoder.encode('["x"]'), encoder);
        const malformed = createMalformedRawContent();
        const createStorage = Reflect.get(database, '_createTermContentStorageChunks').bind(database);

        const validStorage = createStorage([valid], null);
        const malformedStorage = createStorage([malformed], null);

        expect(validStorage.contentDictNames).toEqual([RAW_TERM_CONTENT_DICT_NAME]);
        expect(malformedStorage.contentDictNames).toEqual(['raw']);
    });

    test('no-dedup import keeps malformed raw-magic bytes on the generic raw decoder path', async () => {
        const database = new DictionaryDatabase();
        Reflect.set(database, '_termContentStorageMode', 'raw-bytes');
        Reflect.set(database, '_bulkImportTransactionOpen', true);
        Reflect.set(database, '_deferTermsVirtualTableSync', true);
        Reflect.set(database, '_rawTermContentPackTargetBytes', 1024 * 1024);
        Reflect.set(database, '_termContentStore', {
            appendBatchToArrays: vi.fn(async (
                /** @type {Uint8Array[]} */ chunks,
                /** @type {number[]} */ offsets,
                /** @type {number[]} */ lengths,
            ) => {
                let offset = 100;
                for (let i = 0; i < chunks.length; ++i) {
                    offsets[i] = offset;
                    lengths[i] = chunks[i].byteLength;
                    offset += chunks[i].byteLength;
                }
            }),
            getDebugState: () => null,
        });

        const descriptors = [];
        Reflect.set(database, '_termRecordStore', {
            appendBatchFromImportTermEntriesResolvedContent: vi.fn(async (
                _rows,
                _start,
                _count,
                _offsets,
                _lengths,
                contentDictNames,
            ) => {
                descriptors.push(contentDictNames);
                return {buildRecordsMs: 0, encodeMs: 0, appendWriteMs: 0};
            }),
        });

        await Reflect.get(database, '_bulkAddTermsWithoutContentDedup').call(
            database,
            [createRow(createMalformedRawContent())],
            0,
            1,
        );

        expect(descriptors).toEqual(['raw']);
    });
});
