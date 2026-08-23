/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, test} from 'vitest';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {DictionaryImporterMediaLoader} from '../ext/js/dictionary/dictionary-importer-media-loader.js';

/**
 * @returns {Uint8Array}
 */
function createArtifactWithEmptyReadingSentinel() {
    const expression = new TextEncoder().encode('term');
    const headerBytes = 8 + 4 + 8;
    const stringLengthsBytes = 4;
    const indexesStart = headerBytes + stringLengthsBytes + expression.byteLength;
    const indexPaddingBytes = (-indexesStart) & 3;
    const rowBytes = 20;
    const bytes = new Uint8Array(indexesStart + indexPaddingBytes + 8 + rowBytes);
    const view = new DataView(bytes.buffer);
    bytes.set(new TextEncoder().encode('MBTB0005'), 0);
    let cursor = 8;
    view.setUint32(cursor, 1, true); cursor += 4;
    view.setUint32(cursor, 2, true); cursor += 4;
    view.setUint32(cursor, expression.byteLength, true); cursor += 4;
    view.setUint16(cursor, expression.byteLength, true); cursor += 2;
    view.setUint16(cursor, 0, true); cursor += 2;
    bytes.set(expression, cursor); cursor += expression.byteLength;
    cursor += (-cursor) & 3;
    view.setUint32(cursor, 0, true); cursor += 4;
    view.setUint32(cursor, 1, true); cursor += 4;
    view.setInt32(cursor, 10, true); cursor += 4;
    view.setInt32(cursor, -1, true); cursor += 4;
    view.setUint32(cursor, 0, true); cursor += 4;
    view.setUint32(cursor, 0, true); cursor += 4;
    view.setUint32(cursor, 0, true);
    return bytes;
}

describe('DictionaryImporter term artifacts', () => {
    test('normalizes an empty reading sentinel to the expression key', async () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        /** @type {Record<string, import('core').SafeAny>|null} */
        let capturedChunk = null;

        await Reflect.get(importer, '_decodeTermBankArtifactBytes').call(
            importer,
            createArtifactWithEmptyReadingSentinel(),
            'term_bank_1.mbtb',
            'Test dictionary',
            false,
            'raw-bytes',
            /** @param {unknown} chunk */
            (chunk) => {
                capturedChunk = /** @type {Record<string, import('core').SafeAny>} */ (chunk);
            },
            0,
            0,
            true,
            1,
            'raw-v4',
        );

        expect(capturedChunk).not.toBeNull();
        const chunk = /** @type {Record<string, import('core').SafeAny>} */ (capturedChunk);
        expect(chunk.readingEqualsExpressionList).toStrictEqual(new Uint8Array([1]));
        expect(chunk.readingBytesList[0]).toBe(chunk.expressionBytesList[0]);
        expect(chunk.termRecordPreinternedPlan.readingIndexes[0])
            .toBe(chunk.termRecordPreinternedPlan.expressionIndexes[0]);
    });
});
