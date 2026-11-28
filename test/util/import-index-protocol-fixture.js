/* SPDX-License-Identifier: GPL-3.0-or-later */

import {encodePersistedTermLookupIndex, hashTermLookupKeyBytes, splitPersistedTermLookupIndex} from '../../ext/js/dictionary/term-lookup-index.js';

/**
 * A small valid envelope, independent of the parser's private ownership lane.
 * Its eager reference uses the existing persisted sections and hash function.
 * @param {number} [firstId=1]
 * @returns {{chunk: import('../../ext/js/dictionary/term-record-import-index-chunk.js').DeferredImportIndexChunk, expected: Uint8Array, expectedHeader: Uint8Array}}
 */
export function createDeferredIndexChunkFixture(firstId = 1) {
    const encoder = new TextEncoder();
    const payload = encodePersistedTermLookupIndex([{
        expressionBytes: encoder.encode(`語${firstId}`), readingBytes: encoder.encode(`ご${firstId}`), sequence: firstId,
    }]);
    const recordFields = new Uint8Array(12);
    const fields = new DataView(recordFields.buffer);
    fields.setUint32(4, 32, true);
    fields.setInt32(8, -firstId, true);
    const {base, derived} = splitPersistedTermLookupIndex(payload);
    const header = new Uint8Array(40);
    const view = new DataView(header.buffer);
    view.setUint32(0, firstId, true);
    view.setUint32(4, 1, true);
    view.setUint32(8, firstId * 1024, true);
    view.setUint32(16, payload.byteLength, true);
    view.setUint32(20, base.byteLength, true);
    view.setUint32(36, 1, true);
    const byteLength = header.byteLength + payload.byteLength + recordFields.byteLength;
    const expectedHeader = new Uint8Array(header);
    const completed = new DataView(expectedHeader.buffer);
    completed.setUint32(24, hashTermLookupKeyBytes(base), true);
    completed.setUint32(28, hashTermLookupKeyBytes(derived), true);
    completed.setUint32(32, hashTermLookupKeyBytes(recordFields), true);
    const expected = new Uint8Array(byteLength);
    expected.set(expectedHeader);
    expected.set(payload, header.byteLength);
    expected.set(recordFields, header.byteLength + payload.byteLength);
    return {chunk: {header, payload, recordFields, byteLength}, expected, expectedHeader};
}
