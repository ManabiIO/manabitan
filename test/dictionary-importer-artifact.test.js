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
import {RAW_TERM_CONTENT_COMPRESSED_SHARED_GLOSSARY_DICT_NAME} from '../ext/js/dictionary/raw-term-content.js';

/**
 * @param {Uint8Array} [content]
 * @returns {Uint8Array}
 */
function createArtifactWithEmptyReadingSentinel(content = new Uint8Array(0)) {
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
    view.setUint32(cursor, 0, true); cursor += 4;
    view.setUint32(cursor, 0, true); cursor += 4;
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

describe('DictionaryImporter packed artifact validation', () => {
    test('rejects term spans which would be silently clamped by Uint8Array.subarray', () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const validate = Reflect.get(importer, '_validatePackedTermArtifactManifest');
        /** @type {{termBanksByArtifact: Map<string, {packedOffset: number, packedLength: number, rows: number|null}>, sharedGlossaryPackedOffset: number|null, sharedGlossaryPackedLength: number|null}} */
        const manifest = {
            termBanksByArtifact: new Map([
                ['term_bank_1.mbtb', {packedOffset: 8, packedLength: 4, rows: null}],
            ]),
            sharedGlossaryPackedOffset: null,
            sharedGlossaryPackedLength: null,
        };

        expect(() => validate.call(importer, manifest, 10)).toThrow(/term_bank_1\.mbtb/u);
        manifest.termBanksByArtifact.set('term_bank_1.mbtb', {packedOffset: 6, packedLength: 4, rows: null});
        expect(() => validate.call(importer, manifest, 10)).not.toThrow();
    });

    test('rejects negative row hints and incomplete packed shared-glossary spans', () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const validate = Reflect.get(importer, '_validatePackedTermArtifactManifest');
        /** @type {{termBanksByArtifact: Map<string, {packedOffset: number, packedLength: number, rows: number|null}>, sharedGlossaryPackedOffset: number|null, sharedGlossaryPackedLength: number|null}} */
        const manifest = {
            termBanksByArtifact: new Map([
                ['term_bank_1.mbtb', {packedOffset: 0, packedLength: 10, rows: -1}],
            ]),
            sharedGlossaryPackedOffset: null,
            sharedGlossaryPackedLength: null,
        };

        expect(() => validate.call(importer, manifest, 10)).toThrow(/row count/u);
        manifest.termBanksByArtifact.set('term_bank_1.mbtb', {packedOffset: 0, packedLength: 10, rows: 0});
        expect(() => validate.call(importer, manifest, 10)).not.toThrow();

        manifest.sharedGlossaryPackedOffset = 0;
        expect(() => validate.call(importer, manifest, 10)).toThrow(/incomplete/u);
        manifest.sharedGlossaryPackedOffset = null;
        manifest.sharedGlossaryPackedLength = 10;
        expect(() => validate.call(importer, manifest, 10)).toThrow(/incomplete/u);
        manifest.sharedGlossaryPackedOffset = 0;
        expect(() => validate.call(importer, manifest, 10)).not.toThrow();
    });

    test('validates shared glossary compression descriptors without breaking legacy raw-v4', () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const validate = Reflect.get(importer, '_validateSharedGlossaryArtifactDescriptor');
        /** @type {{sharedGlossaryFileName: string|null, sharedGlossaryPackedOffset: number|null, sharedGlossaryPackedLength: number|null, sharedGlossaryCompression: string|null, sharedGlossaryUncompressedLength: number|null, termContentMode: string|null}} */
        const descriptor = {
            sharedGlossaryFileName: 'manabitan-term-glossary-shared.bin',
            sharedGlossaryPackedOffset: null,
            sharedGlossaryPackedLength: null,
            sharedGlossaryCompression: null,
            sharedGlossaryUncompressedLength: 100,
            termContentMode: 'raw-v4',
        };

        expect(() => validate.call(importer, descriptor)).not.toThrow();
        descriptor.sharedGlossaryCompression = 'zstd';
        expect(() => validate.call(importer, descriptor)).not.toThrow();
        descriptor.sharedGlossaryCompression = 'brotli';
        expect(() => validate.call(importer, descriptor)).toThrow(/compression/u);
        descriptor.sharedGlossaryCompression = null;
        descriptor.sharedGlossaryUncompressedLength = null;
        expect(() => validate.call(importer, descriptor)).toThrow(/uncompressed length/u);
        descriptor.termContentMode = 'raw-v3';
        expect(() => validate.call(importer, descriptor)).not.toThrow();
        descriptor.sharedGlossaryUncompressedLength = -1;
        expect(() => validate.call(importer, descriptor)).toThrow(/uncompressed length/u);
    });

    test('rejects packed media spans and invalid preserved compression descriptors', () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const validate = Reflect.get(importer, '_validatePackedMediaArtifactManifest');

        expect(() => validate.call(importer, [{
            path: 'image.webp', packedOffset: 9, packedLength: 2, compressionMethod: 0, uncompressedLength: 2,
        }], 10, false)).toThrow(/image\.webp/u);
        expect(() => validate.call(importer, [{
            path: 'image.webp', packedOffset: 0, packedLength: 10, compressionMethod: 99, uncompressedLength: 10,
        }], 10, true)).toThrow(/compression method 99/u);
        expect(() => validate.call(importer, [{
            path: 'image.webp', packedOffset: 0, packedLength: 10, compressionMethod: 8, uncompressedLength: 25,
        }], 10, true)).not.toThrow();
        expect(() => validate.call(importer, [{
            path: 'image.webp', packedOffset: 0, packedLength: 10, compressionMethod: 0, uncompressedLength: 11,
        }], 10, true)).toThrow(/length mismatch/u);
        expect(() => validate.call(importer, [{
            path: 'image.webp', packedOffset: 0, packedLength: 10, compressionMethod: 8, uncompressedLength: 0,
        }], 10, true)).toThrow(/uncompressed length/u);
    });

    test('ignores compression metadata when packed media is imported uncompressed', () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const validate = Reflect.get(importer, '_validatePackedMediaArtifactManifest');
        expect(() => validate.call(importer, [{
            path: 'image.webp', packedOffset: 0, packedLength: 10, compressionMethod: 99, uncompressedLength: 123,
        }], 10, false)).not.toThrow();
    });

    test('rejects duplicate packed media paths before creating ambiguous database rows', () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const validate = Reflect.get(importer, '_validatePackedMediaArtifactManifest');
        const entries = [
            {path: 'same.png', packedOffset: 0, packedLength: 4, compressionMethod: 0, uncompressedLength: 4},
            {path: 'same.png', packedOffset: 4, packedLength: 4, compressionMethod: 0, uncompressedLength: 4},
        ];
        expect(() => validate.call(importer, entries, 8, true)).toThrow(/Duplicate packed media artifact path/u);
    });

    test('span validation rejects unsafe integer arithmetic', () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const isValid = Reflect.get(importer, '_isValidPackedArtifactSpan');
        expect(isValid.call(importer, Number.MAX_SAFE_INTEGER, 2, Number.MAX_SAFE_INTEGER)).toBe(false);
        expect(isValid.call(importer, 4, 6, 10)).toBe(true);
    });

    test('rejects duplicate packed term artifact descriptors instead of silently taking the last one', async () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const read = Reflect.get(importer, '_readTermArtifactManifest');
        Reflect.set(importer, '_getData', async () => JSON.stringify({
            termBanks: [
                {artifact: 'term_bank_1.mbtb', packedOffset: 0, packedLength: 4, rows: 1},
                {artifact: 'term_bank_1.mbtb', packedOffset: 4, packedLength: 4, rows: 1},
            ],
        }));
        const fileMap = new Map([
            ['manabitan-import-artifact.json', /** @type {import('@zip.js/zip.js').Entry} */ ({})],
        ]);
        await expect(read.call(importer, fileMap)).rejects.toThrow(/Duplicate packed term artifact descriptor/u);
    });
});

