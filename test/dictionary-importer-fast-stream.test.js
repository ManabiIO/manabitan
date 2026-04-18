/*
 * Copyright (C) 2026  Yomitan Authors
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

import {describe, expect, test} from 'vitest';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {decodeRawTermContentBinary} from '../ext/js/dictionary/raw-term-content.js';
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';

describe('DictionaryImporter fast streamed term-bank path', () => {
    test('streams no-media wasm rows as direct byte-backed chunks', async () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const textEncoder = new TextEncoder();
        const textDecoder = new TextDecoder();
        const termBankJson = JSON.stringify([
            ['食う', 'くう', 'vt', 'v5', 1, ['eat'], 1, 'P E1'],
        ]);
        const termBankBytes = textEncoder.encode(termBankJson);
        Reflect.set(importer, '_getData', async () => termBankBytes);
        Reflect.set(importer, '_wasmPassThroughTermContent', true);
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (input, init) => {
            if (typeof input === 'string' || input instanceof URL) {
                const url = input instanceof URL ? input : new URL(input);
                if (url.protocol === 'file:') {
                    const fileBytes = await readFile(fileURLToPath(url));
                    return {
                        ok: true,
                        status: 200,
                        arrayBuffer: async () => fileBytes.buffer.slice(fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength),
                    };
                }
            }
            return await /** @type {typeof fetch} */ (originalFetch)(input, init);
        };

        /** @type {unknown[]} */
        const chunks = [];
        const readTermBankFileFast = /** @type {(termFile: {filename: string}, version: number, dictionaryTitle: string, prefixWildcardsSupported: boolean, useMediaPipeline: boolean, enableTermEntryContentDedup: boolean, termContentStorageMode: 'baseline'|'raw-bytes', onChunk?: (payload: unknown, requirements: unknown, progress: unknown) => Promise<void>|void) => Promise<unknown>} */ (
            Reflect.get(importer, '_readTermBankFileFast')
        );

        try {
            await readTermBankFileFast.call(
                importer,
                {filename: 'term_bank_1.json'},
                3,
                'Test Dictionary',
                false,
                false,
                true,
                'raw-bytes',
                (payload) => {
                    chunks.push(payload);
                },
            );
        } finally {
            globalThis.fetch = originalFetch;
        }

        expect(chunks).toHaveLength(1);
        const chunk = /** @type {{dictionary: string, rowCount: number, expressionBytesBuffer: Uint8Array, expressionOffsets: Uint32Array, expressionLengths: Uint32Array, readingBytesBuffer: Uint8Array, readingOffsets: Uint32Array, readingLengths: Uint32Array, readingEqualsExpressionList: boolean[]|Uint8Array, scoreList: number[]|Int32Array, sequenceList: (number|undefined)[]|Int32Array, contentBytesBuffer: Uint8Array, contentOffsets: Uint32Array, contentLengths: Uint32Array, contentHash1List: number[]|Uint32Array, contentHash2List: number[]|Uint32Array, contentDictNameList: ((string|null)[]|null), termRecordPreinternedPlan?: {stringLengths: Uint16Array, stringsBuffer: Uint8Array, expressionIndexes: Uint32Array, readingIndexes: Uint32Array}} */ (chunks[0]);

        expect(Array.isArray(chunk)).toBe(false);
        expect(chunk.dictionary).toBe('Test Dictionary');
        expect(chunk.rowCount).toBe(1);
        const expressionBytes = chunk.expressionBytesBuffer.subarray(
            chunk.expressionOffsets[0],
            chunk.expressionOffsets[0] + chunk.expressionLengths[0],
        );
        const readingBytes = chunk.readingBytesBuffer.subarray(
            chunk.readingOffsets[0],
            chunk.readingOffsets[0] + chunk.readingLengths[0],
        );
        const contentBytes = chunk.contentBytesBuffer.subarray(
            chunk.contentOffsets[0],
            chunk.contentOffsets[0] + chunk.contentLengths[0],
        );
        expect(textDecoder.decode(expressionBytes)).toBe('食う');
        expect(textDecoder.decode(readingBytes)).toBe('くう');
        expect(Boolean(chunk.readingEqualsExpressionList[0])).toBe(false);
        expect(chunk.scoreList[0]).toBe(1);
        expect(chunk.sequenceList[0]).toBe(1);
        expect(chunk.contentDictNameList).toBeNull();
        expect(chunk.contentHash1List[0] || chunk.contentHash2List[0]).not.toBe(0);
        expect(chunk.termRecordPreinternedPlan?.expressionIndexes).toBeInstanceOf(Uint32Array);
        expect(chunk.termRecordPreinternedPlan?.readingIndexes).toBeInstanceOf(Uint32Array);

        const rawContent = decodeRawTermContentBinary(contentBytes, textDecoder);
        expect(rawContent).not.toBeNull();
        expect(rawContent).toMatchObject({
            rules: 'v5',
            definitionTags: 'vt',
            termTags: 'P E1',
            glossaryJson: '["eat"]',
        });
    });

    test('streams media-enabled chunks directly when glossary scan finds no media requirements', async () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const textEncoder = new TextEncoder();
        const textDecoder = new TextDecoder();
        const termBankJson = JSON.stringify([
            ['食う', 'くう', 'vt', 'v5', 1, ['eat'], 1, 'P E1'],
            ['読む', 'よむ', 'vt', 'v5', 2, ['read'], 2, 'P E1'],
        ]);
        const termBankBytes = textEncoder.encode(termBankJson);
        Reflect.set(importer, '_getData', async () => termBankBytes);
        Reflect.set(importer, '_wasmPassThroughTermContent', true);
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (input, init) => {
            if (typeof input === 'string' || input instanceof URL) {
                const url = input instanceof URL ? input : new URL(input);
                if (url.protocol === 'file:') {
                    const fileBytes = await readFile(fileURLToPath(url));
                    return {
                        ok: true,
                        status: 200,
                        arrayBuffer: async () => fileBytes.buffer.slice(fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength),
                    };
                }
            }
            return await /** @type {typeof fetch} */ (originalFetch)(input, init);
        };

        /** @type {Array<{payload: unknown, requirements: unknown}>} */
        const chunks = [];
        const readTermBankFileFast = /** @type {(termFile: {filename: string}, version: number, dictionaryTitle: string, prefixWildcardsSupported: boolean, useMediaPipeline: boolean, enableTermEntryContentDedup: boolean, termContentStorageMode: 'baseline'|'raw-bytes', onChunk?: (payload: unknown, requirements: unknown, progress: unknown) => Promise<void>|void) => Promise<unknown>} */ (
            Reflect.get(importer, '_readTermBankFileFast')
        );

        try {
            await readTermBankFileFast.call(
                importer,
                {filename: 'term_bank_1.json'},
                3,
                'Test Dictionary',
                false,
                true,
                true,
                'raw-bytes',
                (payload, requirements) => {
                    chunks.push({payload, requirements});
                },
            );
        } finally {
            globalThis.fetch = originalFetch;
        }

        expect(chunks).toHaveLength(1);
        expect(chunks[0].requirements).toBeNull();
        const chunk = /** @type {{dictionary: string, rowCount: number, expressionBytesBuffer: Uint8Array, expressionOffsets: Uint32Array, expressionLengths: Uint32Array, readingBytesBuffer: Uint8Array, readingOffsets: Uint32Array, readingLengths: Uint32Array, readingEqualsExpressionList: boolean[]|Uint8Array, scoreList: number[]|Int32Array, sequenceList: (number|undefined)[]|Int32Array, contentBytesBuffer: Uint8Array, contentOffsets: Uint32Array, contentLengths: Uint32Array, contentHash1List: number[]|Uint32Array, contentHash2List: number[]|Uint32Array, contentDictNameList: ((string|null)[]|null), termRecordPreinternedPlan?: {stringLengths: Uint16Array, stringsBuffer: Uint8Array, expressionIndexes: Uint32Array, readingIndexes: Uint32Array}} */ (chunks[0].payload);

        expect(Array.isArray(chunk)).toBe(false);
        expect(chunk.dictionary).toBe('Test Dictionary');
        expect(chunk.rowCount).toBe(2);
        expect(chunk.contentDictNameList).toBeNull();
        expect(chunk.termRecordPreinternedPlan?.expressionIndexes).toBeInstanceOf(Uint32Array);
        expect(chunk.termRecordPreinternedPlan?.readingIndexes).toBeInstanceOf(Uint32Array);

        const firstExpressionBytes = chunk.expressionBytesBuffer.subarray(
            chunk.expressionOffsets[0],
            chunk.expressionOffsets[0] + chunk.expressionLengths[0],
        );
        const secondContentBytes = chunk.contentBytesBuffer.subarray(
            chunk.contentOffsets[1],
            chunk.contentOffsets[1] + chunk.contentLengths[1],
        );
        expect(textDecoder.decode(firstExpressionBytes)).toBe('食う');
        expect(Boolean(chunk.readingEqualsExpressionList[1])).toBe(false);
        expect(chunk.scoreList[1]).toBe(2);
        expect(chunk.sequenceList[1]).toBe(2);

        const secondRawContent = decodeRawTermContentBinary(secondContentBytes, textDecoder);
        if (secondRawContent !== null) {
            expect(secondRawContent).toMatchObject({
                rules: 'v5',
                definitionTags: 'vt',
                termTags: 'P E1',
                glossaryJson: '["read"]',
            });
        } else {
            expect(textDecoder.decode(secondContentBytes)).toContain('read');
        }
    });

    test('splits media-enabled mixed chunks into direct safe runs and array fallback rows', async () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const textEncoder = new TextEncoder();
        const textDecoder = new TextDecoder();
        const termBankJson = JSON.stringify([
            ['食う', 'くう', 'vt', 'v5', 1, ['eat'], 1, 'P E1'],
            ['読む', 'よむ', 'vt', 'v5', 2, ['read'], 2, 'P E1'],
            ['見る', 'みる', 'vt', 'v1', 3, [{type: 'image', path: 'foo.png'}], 3, 'P E1'],
        ]);
        const termBankBytes = textEncoder.encode(termBankJson);
        Reflect.set(importer, '_getData', async () => termBankBytes);
        Reflect.set(importer, '_wasmPassThroughTermContent', true);
        Reflect.set(importer, '_mediaSafeDirectRunMinRows', 2);
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (input, init) => {
            if (typeof input === 'string' || input instanceof URL) {
                const url = input instanceof URL ? input : new URL(input);
                if (url.protocol === 'file:') {
                    const fileBytes = await readFile(fileURLToPath(url));
                    return {
                        ok: true,
                        status: 200,
                        arrayBuffer: async () => fileBytes.buffer.slice(fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength),
                    };
                }
            }
            return await /** @type {typeof fetch} */ (originalFetch)(input, init);
        };

        /** @type {Array<{payload: unknown, requirements: unknown}>} */
        const chunks = [];
        const readTermBankFileFast = /** @type {(termFile: {filename: string}, version: number, dictionaryTitle: string, prefixWildcardsSupported: boolean, useMediaPipeline: boolean, enableTermEntryContentDedup: boolean, termContentStorageMode: 'baseline'|'raw-bytes', onChunk?: (payload: unknown, requirements: unknown, progress: unknown) => Promise<void>|void) => Promise<unknown>} */ (
            Reflect.get(importer, '_readTermBankFileFast')
        );

        try {
            await readTermBankFileFast.call(
                importer,
                {filename: 'term_bank_1.json'},
                3,
                'Test Dictionary',
                false,
                true,
                true,
                'raw-bytes',
                (payload, requirements) => {
                    chunks.push({payload, requirements});
                },
            );
        } finally {
            globalThis.fetch = originalFetch;
        }

        expect(chunks).toHaveLength(2);
        expect(chunks[0].requirements).toBeNull();
        const directChunk = /** @type {{rowCount: number, expressionBytesBuffer: Uint8Array, expressionOffsets: Uint32Array, expressionLengths: Uint32Array}} */ (chunks[0].payload);
        expect(Array.isArray(directChunk)).toBe(false);
        expect(directChunk.rowCount).toBe(2);
        const firstExpressionBytes = directChunk.expressionBytesBuffer.subarray(
            directChunk.expressionOffsets[0],
            directChunk.expressionOffsets[0] + directChunk.expressionLengths[0],
        );
        expect(textDecoder.decode(firstExpressionBytes)).toBe('食う');

        expect(Array.isArray(chunks[1].payload)).toBe(true);
        const fallbackChunk = /** @type {import('../ext/js/dictionary/dictionary-database.js').DatabaseTermEntry[]} */ (chunks[1].payload);
        expect(fallbackChunk).toHaveLength(1);
        expect(fallbackChunk[0].expression).toBe('見る');
        expect(fallbackChunk[0].termEntryContentBytes).toBeUndefined();
        expect(fallbackChunk[0].termEntryContentRawGlossaryJsonBytes).toBeUndefined();
        expect(chunks[1].requirements).not.toBeNull();
        expect((/** @type {unknown[]} */ (chunks[1].requirements))).toHaveLength(1);
    });

    test('media fast scan can use glossary UTF-8 bytes without decoding to string first', () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        Reflect.set(importer, '_glossaryMediaFastScan', true);

        const hasMedia = /** @type {(row: {glossaryJsonBytes?: Uint8Array, glossaryJson?: string}) => boolean} */ (Reflect.get(importer, '_fastRowGlossaryLikelyContainsMedia'));
        const textEncoder = new TextEncoder();

        expect(hasMedia.call(importer, {glossaryJsonBytes: textEncoder.encode('[{\"type\":\"image\",\"path\":\"foo.png\"}]')})).toBe(true);
        expect(hasMedia.call(importer, {glossaryJsonBytes: textEncoder.encode('[{\"type\":\"text\",\"text\":\"eat\"}]')})).toBe(false);
    });

    test('resolved media rows can serialize as raw glossary bytes with precomputed hash pair', () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const prepareResolvedMediaTermEntrySerialization = /** @type {(entry: import('../ext/js/dictionary/dictionary-database.js').DatabaseTermEntry, enableTermEntryContentDedup: boolean, termContentStorageMode: 'baseline'|'raw-bytes') => void} */ (
            Reflect.get(importer, '_prepareResolvedMediaTermEntrySerialization')
        );
        /** @type {import('../ext/js/dictionary/dictionary-database.js').DatabaseTermEntry} */
        const entry = {
            expression: '見る',
            reading: 'みる',
            definitionTags: 'vt',
            rules: 'v1',
            score: 3,
            glossary: [{type: 'image', path: 'foo.png', width: 100, height: 50}],
            termTags: 'P E1',
            dictionary: 'Test Dictionary',
        };

        prepareResolvedMediaTermEntrySerialization.call(importer, entry, true, 'raw-bytes');

        expect(entry.termEntryContentBytes).toBeUndefined();
        expect(entry.termEntryContentRawGlossaryJsonBytes).toBeInstanceOf(Uint8Array);
        expect((entry.termEntryContentHash1 || 0) >>> 0).not.toBe(0);
        expect((entry.termEntryContentHash2 || 0) >>> 0).not.toBe(0);
        expect(entry.termEntryContentHash).toMatch(/^[0-9a-f]{16}$/);
        const glossaryJson = new TextDecoder().decode(/** @type {Uint8Array} */ (entry.termEntryContentRawGlossaryJsonBytes));
        expect(glossaryJson).toContain('"foo.png"');
        expect(glossaryJson).toContain('"width":100');
        expect(glossaryJson).toContain('"height":50');
    });
});
