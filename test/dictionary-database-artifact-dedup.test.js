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

describe('DictionaryDatabase artifact dedup path', () => {
    test('keeps packed raw-bytes artifact content packed through dedup append', async () => {
        const appendPackedBatchToArrays = vi.fn(async (bytesBuffer, byteOffsets, byteLengths, offsets, lengths) => {
            expect(bytesBuffer).toStrictEqual(new Uint8Array([10, 11, 30]));
            expect(byteOffsets).toStrictEqual(new Uint32Array([0, 2]));
            expect(byteLengths).toStrictEqual(new Uint32Array([2, 1]));
            offsets[0] = 100;
            offsets[1] = 102;
            lengths[0] = 2;
            lengths[1] = 1;
        });
        const appendBatchToArrays = vi.fn();
        const appendBatchFromArtifactChunkResolvedContent = vi.fn(async (_chunk, contentOffsets, contentLengths, contentDictNames) => {
            expect(contentOffsets).toStrictEqual(new Int32Array([100, 100, 102]));
            expect(contentLengths).toStrictEqual(new Int32Array([2, 2, 1]));
            expect(contentDictNames).toBe('raw');
            return {buildRecordsMs: 0, encodeMs: 0, appendWriteMs: 0};
        });
        const cacheTermEntryContentMeta = vi.fn();
        const createTermContentStorageChunks = vi.fn();

        const database = /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ ({
            _bulkImportTransactionOpen: true,
            _bulkImportDepth: 1,
            _deferTermsVirtualTableSync: true,
            _termContentStorageMode: 'raw-bytes',
            _importDebugLogging: false,
            _getTermEntryContentMetaByHashPair: vi.fn(() => undefined),
            _cacheTermEntryContentMeta: cacheTermEntryContentMeta,
            _createTermContentStorageChunks: createTermContentStorageChunks,
            _termContentStore: {
                appendPackedBatchToArrays,
                appendBatchToArrays,
            },
            _termRecordStore: {
                appendBatchFromArtifactChunkResolvedContent,
            },
            _insertTermRowsIntoVirtualTable: vi.fn(),
        }));

        const chunk = {
            dictionary: 'Test Dictionary',
            rowCount: 3,
            expressionBytesBuffer: new Uint8Array([1, 2, 3]),
            expressionOffsets: new Uint32Array([0, 1, 2]),
            expressionLengths: new Uint32Array([1, 1, 1]),
            readingBytesBuffer: new Uint8Array([4, 5, 6]),
            readingOffsets: new Uint32Array([0, 1, 2]),
            readingLengths: new Uint32Array([1, 1, 1]),
            readingEqualsExpressionList: [false, false, false],
            scoreList: [0, 0, 0],
            sequenceList: [1, 2, 3],
            contentBytesBuffer: new Uint8Array([10, 11, 20, 21, 30]),
            contentOffsets: new Uint32Array([0, 0, 4]),
            contentLengths: new Uint32Array([2, 2, 1]),
            contentHash1List: [7, 7, 8],
            contentHash2List: [9, 9, 10],
            contentDictNameList: null,
            uniformContentDictName: 'raw',
        };

        await DictionaryDatabase.prototype._bulkAddArtifactTermsChunkWithContentDedup.call(database, chunk);

        expect(appendPackedBatchToArrays).toHaveBeenCalledOnce();
        expect(appendBatchToArrays).not.toHaveBeenCalled();
        expect(createTermContentStorageChunks).not.toHaveBeenCalled();
        expect(appendBatchFromArtifactChunkResolvedContent).toHaveBeenCalledOnce();
        expect(cacheTermEntryContentMeta).toHaveBeenCalledTimes(2);
    });
});
