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
import {
    decodeRawTermContentSharedGlossaryHeader,
    encodeRawTermContentSharedGlossaryBinary,
    RAW_TERM_CONTENT_COMPRESSED_SHARED_GLOSSARY_DICT_NAME,
} from '../ext/js/dictionary/raw-term-content.js';
import {hashTermEntryContentBytesPair} from '../ext/js/dictionary/term-entry-content-hash.js';

/**
 * @param {Uint8Array} [content]
 * @returns {Uint8Array}
 */
function createArtifactWithEmptyReadingSentinel(content = new Uint8Array(0), [hash1, hash2] = [0, 0]) {
    const expression = new TextEncoder().encode('term');
    const headerBytes = 8 + 4 + 8;
    const stringLengthsBytes = 4;
    const indexesStart = headerBytes + stringLengthsBytes + expression.byteLength;
    const indexPaddingBytes = (-indexesStart) & 3;
    const rowBytes = 20 + content.byteLength;
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
    view.setUint32(cursor, hash1, true); cursor += 4;
    view.setUint32(cursor, hash2, true); cursor += 4;
    view.setUint32(cursor, content.byteLength, true); cursor += 4;
    bytes.set(content, cursor);
    return bytes;
}

/**
 * Starts with the raw-v3/shared-glossary magic but declares one tag byte
 * without actually containing it.
 * @returns {Uint8Array}
 */
function createMalformedSharedGlossaryContent() {
    const bytes = new Uint8Array(28);
    bytes.set([0x4d, 0x42, 0x52, 0x32]);
    const view = new DataView(bytes.buffer);
    view.setUint32(4, 1, true);
    view.setBigUint64(16, 0n, true);
    view.setUint32(24, 2, true);
    return bytes;
}

describe('DictionaryImporter term artifacts', () => {
    test('normalizes an empty reading sentinel without mutating the source artifact', async () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        /** @type {Record<string, import('core').SafeAny>|null} */
        let capturedChunk = null;
        const bytes = createArtifactWithEmptyReadingSentinel();
        const originalBytes = Uint8Array.from(bytes);

        await Reflect.get(importer, '_decodeTermBankArtifactBytes').call(
            importer,
            bytes,
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
        const chunk = /** @type {Record<string, import('core').SafeAny>} */ (/** @type {unknown} */ (capturedChunk));
        expect(chunk.readingEqualsExpressionList).toStrictEqual(new Uint8Array([1]));
        expect(chunk.readingBytesList[0]).toBe(chunk.expressionBytesList[0]);
        expect(chunk.termRecordPreinternedPlan.readingIndexes[0])
            .toBe(chunk.termRecordPreinternedPlan.expressionIndexes[0]);
        expect(bytes).toStrictEqual(originalBytes);
        expect(chunk.termRecordPreinternedPlan.readingIndexes.buffer).not.toBe(bytes.buffer);
    });


    test('recomputes direct-chunk content hashes after shared-glossary rebasing', async () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const sourceContent = encodeRawTermContentSharedGlossaryBinary(
            '',
            '',
            '',
            7,
            11,
            new TextEncoder(),
        );
        const sourceHash = hashTermEntryContentBytesPair(sourceContent);
        const artifact = createArtifactWithEmptyReadingSentinel(sourceContent, sourceHash);
        /** @type {Record<string, import('core').SafeAny>|null} */
        let capturedChunk = null;

        await Reflect.get(importer, '_decodeTermBankArtifactBytes').call(
            importer,
            artifact,
            'term_bank_1.mbtb',
            'Test dictionary',
            false,
            'raw-bytes',
            /** @param {unknown} chunk */
            (chunk) => {
                capturedChunk = /** @type {Record<string, import('core').SafeAny>} */ (chunk);
            },
            0,
            4096,
            true,
            1,
            RAW_TERM_CONTENT_COMPRESSED_SHARED_GLOSSARY_DICT_NAME,
        );

        expect(capturedChunk).not.toBeNull();
        const chunk = /** @type {Record<string, import('core').SafeAny>} */ (/** @type {unknown} */ (capturedChunk));
        const rebasedContent = /** @type {Uint8Array} */ (chunk.contentBytesList[0]);
        const rebasedHeader = decodeRawTermContentSharedGlossaryHeader(rebasedContent, new TextDecoder());
        expect(rebasedHeader?.glossaryOffset).toBe(4103);
        const rebasedHash = hashTermEntryContentBytesPair(rebasedContent);
        expect([chunk.contentHash1List[0], chunk.contentHash2List[0]]).toStrictEqual(rebasedHash);
        expect(rebasedHash).not.toStrictEqual(sourceHash);
    });

    test('recomputes direct-chunk hashes when legacy JSON is converted to raw binary', async () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const sourceContent = new TextEncoder().encode(JSON.stringify({
            rules: 'rule',
            definitionTags: 'tag',
            termTags: '',
            glossary: ['definition'],
        }));
        const sourceHash = hashTermEntryContentBytesPair(sourceContent);
        const artifact = createArtifactWithEmptyReadingSentinel(sourceContent, sourceHash);
        /** @type {Record<string, import('core').SafeAny>|null} */
        let capturedChunk = null;

        await Reflect.get(importer, '_decodeTermBankArtifactBytes').call(
            importer,
            artifact,
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
            null,
        );

        const chunk = /** @type {Record<string, import('core').SafeAny>} */ (/** @type {unknown} */ (capturedChunk));
        const normalizedBytes = /** @type {Uint8Array} */ (chunk.contentBytesList[0]);
        const normalizedHash = hashTermEntryContentBytesPair(normalizedBytes);
        expect(normalizedBytes).not.toStrictEqual(sourceContent);
        expect([chunk.contentHash1List[0], chunk.contentHash2List[0]]).toStrictEqual(normalizedHash);
        expect(normalizedHash).not.toStrictEqual(sourceHash);
    });

    test('recomputes materialized-row hashes after shared-glossary rebasing', async () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const sourceContent = encodeRawTermContentSharedGlossaryBinary(
            '',
            '',
            '',
            13,
            5,
            new TextEncoder(),
        );
        const sourceHash = hashTermEntryContentBytesPair(sourceContent);
        const artifact = createArtifactWithEmptyReadingSentinel(sourceContent, sourceHash);

        const result = await Reflect.get(importer, '_decodeTermBankArtifactBytes').call(
            importer,
            artifact,
            'term_bank_1.mbtb',
            'Test dictionary',
            false,
            'raw-bytes',
            void 0,
            0,
            512,
            false,
            1,
            RAW_TERM_CONTENT_COMPRESSED_SHARED_GLOSSARY_DICT_NAME,
        );

        expect(result.termList).toHaveLength(1);
        const entry = result.termList[0];
        const rebasedBytes = /** @type {Uint8Array} */ (entry.termEntryContentBytes);
        const rebasedHash = hashTermEntryContentBytesPair(rebasedBytes);
        expect([entry.termEntryContentHash1, entry.termEntryContentHash2]).toStrictEqual(rebasedHash);
        expect(rebasedHash).not.toStrictEqual(sourceHash);
        expect(decodeRawTermContentSharedGlossaryHeader(rebasedBytes, new TextDecoder())?.glossaryOffset).toBe(525);
    });

    test('preserves artifact content hashes when normalization does not change bytes', async () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const contentBytes = encodeRawTermContentSharedGlossaryBinary(
            '',
            '',
            '',
            7,
            11,
            new TextEncoder(),
        );
        const sourceHash = hashTermEntryContentBytesPair(contentBytes);
        const artifact = createArtifactWithEmptyReadingSentinel(contentBytes, sourceHash);
        /** @type {Record<string, import('core').SafeAny>|null} */
        let capturedChunk = null;

        await Reflect.get(importer, '_decodeTermBankArtifactBytes').call(
            importer,
            artifact,
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
            RAW_TERM_CONTENT_COMPRESSED_SHARED_GLOSSARY_DICT_NAME,
        );

        const chunk = /** @type {Record<string, import('core').SafeAny>} */ (/** @type {unknown} */ (capturedChunk));
        expect(chunk.contentBytesList[0]).toStrictEqual(contentBytes);
        expect([chunk.contentHash1List[0], chunk.contentHash2List[0]]).toStrictEqual(sourceHash);
    });

    test('rejects malformed zero-base shared-glossary artifact rows before chunk delivery', async () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        let chunkDelivered = false;

        await expect(Reflect.get(importer, '_decodeTermBankArtifactBytes').call(
            importer,
            createArtifactWithEmptyReadingSentinel(createMalformedSharedGlossaryContent()),
            'term_bank_1.mbtb',
            'Test dictionary',
            false,
            'raw-bytes',
            () => { chunkDelivered = true; },
            0,
            0,
            true,
            1,
            RAW_TERM_CONTENT_COMPRESSED_SHARED_GLOSSARY_DICT_NAME,
        )).rejects.toThrow(/shared glossary/i);

        expect(chunkDelivered).toBe(false);
    });

    test('rejects malformed shared-glossary artifact rows before rebasing', async () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        let chunkDelivered = false;

        await expect(Reflect.get(importer, '_decodeTermBankArtifactBytes').call(
            importer,
            createArtifactWithEmptyReadingSentinel(createMalformedSharedGlossaryContent()),
            'term_bank_1.mbtb',
            'Test dictionary',
            false,
            'raw-bytes',
            () => { chunkDelivered = true; },
            0,
            4096,
            true,
            1,
            null,
        )).rejects.toThrow(/shared glossary/i);

        expect(chunkDelivered).toBe(false);
    });
});
