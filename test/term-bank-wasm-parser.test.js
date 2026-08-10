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

import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterAll, beforeAll, describe, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {hashTermEntryContentBytesPair} from '../ext/js/dictionary/term-entry-content-hash.js';
import {decodeRawTermContentTokenBinary} from '../ext/js/dictionary/raw-term-content.js';
import {consumeLastTermBankWasmParseProfile, parseTermBankWithWasmChunks, parseTermBankWithWasmColumnChunks} from '../ext/js/dictionary/term-bank-wasm-parser.js';
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const termBankParserWasmPath = path.resolve(__dirname, '../ext/lib/term-bank-parser.wasm');
const maybeTest = existsSync(termBankParserWasmPath) ? test : test.skip;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const nativeFetch = globalThis.fetch;
/** @typedef {{expression: string, reading: string, glossaryMayContainMedia?: boolean, termEntryContentHash1?: number, termEntryContentHash2?: number, termEntryContentBytes: Uint8Array, readingEqualsExpression?: boolean, readingBytes?: Uint8Array}} ParsedRow */
/** @typedef {{strings: string[], stringLengths: number[], stringHashes: number[], stringOffsets: number[], expressionIndexes: number[], readingIndexes: number[], readingEqualsExpressionList: number[]}} TermStringPlanSnapshot */

/**
 * @param {Array<unknown>} rows
 * @param {Parameters<typeof parseTermBankWithWasmChunks>[4]} [options]
 * @returns {Promise<ParsedRow[]>}
 */
async function parseRows(rows, options = {}) {
    /** @type {ParsedRow[]} */
    const parsedRows = [];
    await parseTermBankWithWasmChunks(
        textEncoder.encode(JSON.stringify(rows)),
        3,
        (chunk) => { parsedRows.push(...chunk); },
        2,
        {copyContentBytes: true, mediaHintFastScan: true, ...options},
    );
    return parsedRows;
}

/**
 * @param {string} json
 * @returns {Promise<ParsedRow[]>}
 */
async function parseRowsJson(json) {
    /** @type {ParsedRow[]} */
    const parsedRows = [];
    await parseTermBankWithWasmChunks(
        textEncoder.encode(json),
        3,
        (chunk) => { parsedRows.push(...chunk); },
        2,
        {copyContentBytes: true, mediaHintFastScan: true},
    );
    return parsedRows;
}

/**
 * @param {{termEntryContentBytes: Uint8Array}} row
 * @returns {string}
 */
function getContentString(row) {
    return textDecoder.decode(row.termEntryContentBytes);
}

/**
 * @param {Uint8Array} bytes
 * @returns {number}
 */
function hashBytes(bytes) {
    let hash = 0x811c9dc5;
    for (const value of bytes) {
        hash = Math.imul(hash ^ value, 0x01000193);
    }
    return hash >>> 0;
}

describe('term-bank WASM parser', () => {
    beforeAll(() => {
        vi.stubGlobal('fetch', async (resource) => {
            const url = resource instanceof URL ? resource : new URL(String(resource));
            if (url.protocol === 'file:') {
                return new Response(await readFile(fileURLToPath(url)));
            }
            return await nativeFetch(resource);
        });
    });

    afterAll(() => {
        vi.unstubAllGlobals();
    });

    maybeTest('keeps text-object glossary dedup equivalent to plain text glossary', async () => {
        const textFirstObject = {text: 'shared text', type: 'text'};
        const rows = await parseRows([
            ['plain', 'plain', '', '', 0, ['shared text'], 1, ''],
            ['object', 'object', '', '', 0, [{type: 'text', text: 'shared text'}], 2, ''],
            ['text-first-object', 'text-first-object', '', '', 0, [textFirstObject], 3, ''],
        ]);

        expect(rows).toHaveLength(3);
        expect(getContentString(rows[0])).toBe('{"rules":"","definitionTags":"","termTags":"","glossary":["shared text"]}');
        expect(getContentString(rows[1])).toBe(getContentString(rows[0]));
        expect(getContentString(rows[2])).toBe(getContentString(rows[0]));
        expect(rows[1].termEntryContentHash1).toBe(rows[0].termEntryContentHash1);
        expect(rows[1].termEntryContentHash2).toBe(rows[0].termEntryContentHash2);
        expect(rows[2].termEntryContentHash1).toBe(rows[0].termEntryContentHash1);
        expect(rows[2].termEntryContentHash2).toBe(rows[0].termEntryContentHash2);
    });

    maybeTest('preserves compact plain glossaries while normalizing equivalent object and spaced forms', async () => {
        const rows = await parseRows([
            ['compact', 'compact', '', '', 0, ['brace { and spaces', 'escaped "quote"'], 1, ''],
            ['object', 'object', '', '', 0, [{type: 'text', text: 'same'}], 2, ''],
            ['plain', 'plain', '', '', 0, ['same'], 3, ''],
        ]);

        expect(getContentString(rows[0])).toBe(
            '{"rules":"","definitionTags":"","termTags":"","glossary":["brace { and spaces","escaped \\"quote\\""]}',
        );
        expect(getContentString(rows[1])).toBe(getContentString(rows[2]));
    });

    maybeTest('scans escaped strings correctly at every word alignment', async () => {
        const glossary = [
            '"',
            'a"b',
            'ab"c',
            'abc"d',
            '\\',
            'a\\b',
            'ab\\c',
            'abc\\d',
            `long-${'x'.repeat(257)}-"quoted"-\\-終`,
        ];
        const [row] = await parseRows([
            ['alignment', 'alignment', '', '', 0, glossary, 1, ''],
        ]);

        const content = JSON.parse(getContentString(row));
        expect(content.glossary).toStrictEqual(glossary);
    });

    maybeTest('rejects an unterminated string ending at a word boundary', async () => {
        const malformed = `[["entry","entry","","",0,["${'x'.repeat(64)}]`;
        await expect(parseRowsJson(malformed)).rejects.toThrow(/term-bank parser failed/);
    });

    maybeTest('rejects mismatched nested glossary containers before dispatch', async () => {
        let chunkCount = 0;
        await expect(parseTermBankWithWasmChunks(
            textEncoder.encode('[["entry","","","",0,[{"value":[1,2}}],1,""]]'),
            3,
            () => { ++chunkCount; },
            1,
        )).rejects.toThrow(/term-bank parser failed/);
        expect(chunkCount).toBe(0);
    });

    maybeTest.each([
        ['missing field comma', '[["entry" "", "", "", 0, ["definition"], 1, ""]]'],
        ['trailing field comma', '[["entry", "", "", "", 0, ["definition"], 1, "",]]'],
        ['missing row comma', '[["first", "", "", "", 0, ["definition"], 1, ""] ["second", "", "", "", 0, ["definition"], 2, ""]]'],
        ['trailing row comma', '[["entry", "", "", "", 0, ["definition"], 1, ""],]'],
        ['trailing content', '[["entry", "", "", "", 0, ["definition"], 1, ""]] false'],
        ['invalid escape', '[["entry\\x", "", "", "", 0, ["definition"], 1, ""]]'],
        ['invalid unicode escape', '[["entry\\u12xz", "", "", "", 0, ["definition"], 1, ""]]'],
        ['leading-zero score', '[["entry", "", "", "", 01, ["definition"], 1, ""]]'],
    ])('rejects malformed JSON syntax: %s', async (_name, malformed) => {
        await expect(parseRowsJson(malformed)).rejects.toThrow(/term-bank parser failed/);
    });

    maybeTest('preserves valid deeply mixed glossary containers', async () => {
        /** @type {unknown} */
        let nested = 'leaf';
        for (let i = 0; i < 32; ++i) {
            nested = {content: [nested], tag: 'span'};
        }
        const [row] = await parseRows([
            ['nested', '', '', '', 0, [nested], 1, ''],
        ]);
        expect(JSON.parse(getContentString(row)).glossary[0]).toStrictEqual(nested);
    });

    maybeTest('grows the metadata buffer in place without dropping rows', async () => {
        const rowCount = 9000;
        const source = textEncoder.encode(JSON.stringify(
            Array.from({length: rowCount}, (_, index) => [
                `entry-${index}`,
                '',
                '',
                '',
                index,
                ['definition'],
                index,
                '',
            ]),
        ));
        let processedRows = 0;
        await parseTermBankWithWasmChunks(
            source,
            3,
            (chunk) => { processedRows += chunk.length; },
            4096,
            {includeContentMetadata: false, minimalDecode: true},
        );
        const profile = consumeLastTermBankWasmParseProfile();

        expect(processedRows).toBe(rowCount);
        expect(profile?.rowCount).toBe(rowCount);
        expect(profile?.metaCapacity).toBeGreaterThanOrEqual(rowCount);
        expect(profile?.metaCapacity).toBeLessThan(20000);
        expect(profile?.metaAllocatedBytes).toBe((profile?.metaCapacity ?? 0) * 17 * 4);
    });

    maybeTest('grows the content buffer while preserving a large row', async () => {
        const definition = 'x'.repeat(2 * 1024 * 1024);
        const [row] = await parseRows([
            ['large-content', '', '', '', 0, [definition], 1, ''],
        ]);
        const profile = consumeLastTermBankWasmParseProfile();

        expect(JSON.parse(getContentString(row)).glossary).toStrictEqual([definition]);
        expect(profile?.encodedContentBytes).toBe(row.termEntryContentBytes.byteLength);
        expect(profile?.initialContentBytesPerRow).toBe(48);
        expect(profile?.contentCapacity).toBeGreaterThanOrEqual(row.termEntryContentBytes.byteLength);
        expect(profile?.contentCapacity).toBeLessThan(4 * 1024 * 1024);
    });

    maybeTest('reports the normalized initial content capacity hint', async () => {
        await parseRows(
            [['capacity-hint', '', '', '', 0, ['definition'], 1, '']],
            {initialContentBytesPerRow: 768},
        );
        const profile = consumeLastTermBankWasmParseProfile();

        expect(profile?.initialContentBytesPerRow).toBe(512);
        expect(profile?.encodedContentBytes).toBeGreaterThan(0);
        expect(profile?.contentCapacity).toBeGreaterThanOrEqual(profile?.encodedContentBytes ?? Infinity);
    });

    maybeTest('falls back to normalization for formatted glossary JSON', async () => {
        const rows = await parseRowsJson(`[
            ["formatted", "formatted", "", "", 0, [ "same", { "type" : "text", "text" : "wrapped" } ], 1, ""],
            ["canonical", "canonical", "", "", 0, ["same", "wrapped"], 2, ""]
        ]`);

        expect(rows).toHaveLength(2);
        expect(getContentString(rows[0])).toBe(getContentString(rows[1]));
        expect(rows[0].termEntryContentHash1).toBe(rows[1].termEntryContentHash1);
        expect(rows[0].termEntryContentHash2).toBe(rows[1].termEntryContentHash2);
    });

    maybeTest('uses the same dedup hash pair as every JavaScript fallback path', async () => {
        const [row] = await parseRows([
            ['hash', 'hash', 'tag', 'rule', 7, ['hash definition'], 1, 'term-tag'],
        ]);
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const database = new DictionaryDatabase();
        const hashEntryContentBytesPair = /** @type {(this: DictionaryImporter, bytes: Uint8Array) => [number, number]} */ (
            Reflect.get(importer, '_hashEntryContentBytesPair')
        );
        const hashEntryContent = /** @type {(this: DictionaryDatabase, contentJson: string) => string} */ (
            Reflect.get(database, '_hashEntryContent')
        );
        const contentString = getContentString(row);
        const expectedHashPair = [
            row.termEntryContentHash1,
            row.termEntryContentHash2,
        ];

        expect(hashTermEntryContentBytesPair(row.termEntryContentBytes)).toEqual(expectedHashPair);
        expect(hashEntryContentBytesPair.call(importer, row.termEntryContentBytes)).toEqual(expectedHashPair);
        expect(hashEntryContent.call(database, contentString)).toBe(
            `${(row.termEntryContentHash1 ?? 0).toString(16).padStart(8, '0')}` +
            `${(row.termEntryContentHash2 ?? 0).toString(16).padStart(8, '0')}`,
        );
    });

    maybeTest('does not collapse structured-content objects into text glossary content', async () => {
        const structuredGlossary = {
            content: [{tag: 'span', content: 'structured definition'}],
            type: 'structured-content',
        };
        const [row] = await parseRows([
            ['structured', 'structured', '', '', 0, [structuredGlossary], 1, ''],
        ]);

        const content = getContentString(row);
        expect(content).toContain('"type":"structured-content"');
        expect(content).toContain('"structured definition"');
        expect(content).not.toBe('{"rules":"","definitionTags":"","termTags":"","glossary":["structured definition"]}');
    });

    maybeTest('reports exact image media markers without matching ordinary words', async () => {
        const rows = await parseRows([
            ['image-row', 'image-row', '', '', 0, [{type: 'image', path: 'image-row.png'}], 1, ''],
            ['img-row', 'img-row', '', '', 0, [{tag: 'div', content: [{tag: 'img', path: 'nested.png'}]}], 2, ''],
            ['word-row', 'word-row', '', '', 0, ['imagination and imagery'], 2, ''],
            ['quoted-row', 'quoted-row', '', '', 0, ['The literal token "image" is not media'], 3, ''],
        ]);

        expect(rows[0].glossaryMayContainMedia).toBe(true);
        expect(rows[1].glossaryMayContainMedia).toBe(true);
        expect(rows[2].glossaryMayContainMedia).toBe(false);
        expect(rows[3].glossaryMayContainMedia).toBe(false);
    });

    maybeTest('does not dispatch partial chunks when parsing malformed term-bank JSON', async () => {
        let chunkCount = 0;
        await expect(parseTermBankWithWasmChunks(
            textEncoder.encode('[["ok","ok","","",0,["ok"],1,""],not-json]'),
            3,
            () => { ++chunkCount; },
            1,
            {copyContentBytes: true},
        )).rejects.toThrow(/term-bank parser failed/);
        expect(chunkCount).toBe(0);
    });

    maybeTest('rejects out-of-range integer metadata before dispatch', async () => {
        let chunkCount = 0;
        await expect(parseTermBankWithWasmColumnChunks(
            textEncoder.encode('[["overflow","overflow","","",2147483648,["definition"],1,""]]'),
            3,
            () => { ++chunkCount; },
        )).rejects.toThrow(/term-bank parser failed/);
        expect(chunkCount).toBe(0);
    });

    maybeTest('bounds and serializes pipelined chunk dispatch', async () => {
        const calls = [];
        let releaseFirst = () => {};
        const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
        let active = 0;
        let maxActive = 0;
        const parsePromise = parseTermBankWithWasmChunks(
            textEncoder.encode(JSON.stringify([
                ['a', 'a', '', '', 0, ['a'], 1, ''],
                ['b', 'b', '', '', 0, ['b'], 2, ''],
                ['c', 'c', '', '', 0, ['c'], 3, ''],
            ])),
            3,
            async (_chunk, progress) => {
                ++active;
                maxActive = Math.max(maxActive, active);
                calls.push(progress.chunkIndex);
                if (progress.chunkIndex === 1) { await firstGate; }
                --active;
            },
            1,
            {copyContentBytes: true, maxPendingChunks: 2},
        );
        await vi.waitFor(() => { expect(calls).toStrictEqual([1]); });
        releaseFirst();
        await parsePromise;

        expect(calls).toStrictEqual([1, 2, 3]);
        expect(maxActive).toBe(1);
        expect(consumeLastTermBankWasmParseProfile()?.maxPendingChunks).toBe(2);
    });

    maybeTest.each([
        ['row', parseTermBankWithWasmChunks],
        ['column', parseTermBankWithWasmColumnChunks],
    ])('observes queued %s dispatch rejections after an earlier chunk fails', async (_kind, parseChunks) => {
        const source = textEncoder.encode(JSON.stringify([
            ['a', 'a', '', '', 0, ['a'], 1, ''],
            ['b', 'b', '', '', 0, ['b'], 2, ''],
            ['c', 'c', '', '', 0, ['c'], 3, ''],
        ]));
        const failure = new Error('chunk write failed');
        const calls = [];
        const unhandledRejections = [];
        const onUnhandledRejection = (reason) => { unhandledRejections.push(reason); };
        process.on('unhandledRejection', onUnhandledRejection);
        try {
            await expect(parseChunks(
                source,
                3,
                async (_chunk, progress) => {
                    calls.push(progress.chunkIndex);
                    if (progress.chunkIndex === 1) { throw failure; }
                },
                1,
                {copyContentBytes: true, maxPendingChunks: 2},
            )).rejects.toBe(failure);
            await new Promise((resolve) => { setTimeout(resolve, 0); });
            expect(calls).toStrictEqual([1]);
            expect(unhandledRejections).toStrictEqual([]);
        } finally {
            process.off('unhandledRejection', onUnhandledRejection);
        }
    });

    maybeTest('combines source arrays directly in WASM input memory', async () => {
        const chunks = [];
        await parseTermBankWithWasmChunks(
            [
                textEncoder.encode(JSON.stringify([['a', 'a', '', '', 0, ['first'], 1, '']])),
                textEncoder.encode(JSON.stringify([['b', 'b', '', '', 0, ['second'], 2, '']])),
            ],
            3,
            (rows) => { chunks.push(...rows); },
            1,
            {copyContentBytes: true},
        );

        expect(chunks.map((row) => row.expression)).toStrictEqual(['a', 'b']);
        expect(chunks.map(getContentString)).toStrictEqual([
            '{"rules":"","definitionTags":"","termTags":"","glossary":["first"]}',
            '{"rules":"","definitionTags":"","termTags":"","glossary":["second"]}',
        ]);
    });

    maybeTest('treats an empty reading as the expression in minimal and columnar paths', async () => {
        const source = textEncoder.encode(JSON.stringify([
            ['expression', '', '', '', 4, ['definition'], 12, ''],
        ]));
        /** @type {ParsedRow[]} */
        const rows = [];
        await parseTermBankWithWasmChunks(
            source,
            3,
            (chunk) => { rows.push(...chunk); },
            1,
            {minimalDecode: true, reuseExpressionForReadingDecode: true},
        );
        /** @type {Array<Parameters<Parameters<typeof parseTermBankWithWasmColumnChunks>[2]>[0]>} */
        const columns = [];
        await parseTermBankWithWasmColumnChunks(source, 3, (chunk) => { columns.push(chunk); }, 1);

        expect(rows[0].readingEqualsExpression).toBe(true);
        expect(textDecoder.decode(rows[0].readingBytes)).toBe('expression');
        expect(columns[0].readingEqualsExpressionList[0]).toBe(1);
        expect(columns[0].readingBytesList[0]).toHaveLength(0);
        expect(columns[0].termRecordPreinternedPlan.readingIndexes[0]).toBe(
            columns[0].termRecordPreinternedPlan.expressionIndexes[0],
        );
    });

    maybeTest('builds native string plans equivalent to the JavaScript fallback across duplicates and hash collisions', async () => {
        const source = textEncoder.encode(JSON.stringify([
            ['003pwu', '00a5fa', '', '', 1, ['first collision'], 1, ''],
            ['00a5fa', '003pwu', '', '', 2, ['second collision'], 2, ''],
            ['same', 'same', '', '', 3, ['same token'], 3, ''],
            ['same', '', '', '', 4, ['empty reading'], 4, ''],
            ['other', 'same', '', '', 5, ['shared reading'], 5, ''],
        ]));
        expect(hashBytes(textEncoder.encode('003pwu'))).toBe(hashBytes(textEncoder.encode('00a5fa')));

        /**
         * @param {boolean} useNativeStringPlan
         * @returns {Promise<TermStringPlanSnapshot>}
         */
        const parsePlan = async (useNativeStringPlan) => {
            /** @type {TermStringPlanSnapshot|null} */
            let snapshot = null;
            await parseTermBankWithWasmColumnChunks(
                source,
                3,
                (chunk) => {
                    const plan = chunk.termRecordPreinternedPlan;
                    if (plan.stringOffsets === undefined || plan.stringHashes === undefined) {
                        throw new Error('Expected complete preinterned string metadata');
                    }
                    snapshot = {
                        strings: Array.from(plan.stringLengths, (length, index) => {
                            const offset = plan.stringOffsets[index];
                            return textDecoder.decode(plan.stringsBuffer.subarray(offset, offset + length));
                        }),
                        stringLengths: [...plan.stringLengths],
                        stringHashes: [...plan.stringHashes],
                        stringOffsets: [...plan.stringOffsets],
                        expressionIndexes: [...plan.expressionIndexes],
                        readingIndexes: [...plan.readingIndexes],
                        readingEqualsExpressionList: [...chunk.readingEqualsExpressionList],
                    };
                },
                8,
                {emitTermByteLists: false, useNativeStringPlan},
            );
            return /** @type {TermStringPlanSnapshot} */ (snapshot);
        };

        const nativePlan = await parsePlan(true);
        const nativeProfile = consumeLastTermBankWasmParseProfile();
        const fallbackPlan = await parsePlan(false);
        const fallbackProfile = consumeLastTermBankWasmParseProfile();

        expect(nativePlan).toStrictEqual(fallbackPlan);
        expect(nativeProfile?.nativeStringPlanChunkCount).toBe(1);
        expect(nativeProfile?.nativeStringPlanFallbackChunkCount).toBe(0);
        expect(fallbackProfile?.nativeStringPlanChunkCount).toBe(0);
        expect(nativePlan?.strings).toContain('003pwu');
        expect(nativePlan?.strings).toContain('00a5fa');
        for (const value of ['003pwu', '00a5fa', 'same', 'other']) {
            const index = nativePlan.strings.indexOf(value);
            expect(index).toBeGreaterThanOrEqual(0);
            expect(nativePlan.stringHashes[index]).toBe(hashBytes(textEncoder.encode(value)));
        }
    });

    maybeTest('emits equivalent import columns and decodes only media compatibility rows', async () => {
        const source = textEncoder.encode(JSON.stringify([
            ['escaped\\value', 'reading', '', '', -2, ['plain'], null, ''],
            ['image', '', '', '', 7, [{type: 'image', path: 'test.png'}], 8, ''],
            ['minimum-score', '', '', '', -2147483648, ['minimum'], 9, ''],
            ['maximum-values', '', '', '', 2147483647, ['maximum'], 2147483647, ''],
        ]));
        /** @type {Array<Parameters<Parameters<typeof parseTermBankWithWasmColumnChunks>[2]>[0]>} */
        const chunks = [];
        await parseTermBankWithWasmColumnChunks(
            source,
            3,
            (chunk) => { chunks.push(chunk); },
            8,
            {mediaHintFastScan: true},
        );
        const [chunk] = chunks;
        const plan = chunk.termRecordPreinternedPlan;
        const stringOffsets = [];
        let offset = 0;
        for (const length of plan.stringLengths) {
            stringOffsets.push(offset);
            offset += length;
        }
        const getPlanString = (index) => textDecoder.decode(
            plan.stringsBuffer.subarray(stringOffsets[index], stringOffsets[index] + plan.stringLengths[index]),
        );

        expect(chunk.rowCount).toBe(4);
        expect(chunk.scoreList).toStrictEqual(new Int32Array([-2, 7, -2147483648, 2147483647]));
        expect(chunk.sequenceList).toStrictEqual(new Int32Array([-1, 8, 9, 2147483647]));
        expect(getPlanString(plan.expressionIndexes[0])).toBe('escaped\\value');
        expect(getPlanString(plan.readingIndexes[0])).toBe('reading');
        expect(getPlanString(plan.expressionIndexes[1])).toBe('image');
        expect(plan.readingIndexes[1]).toBe(plan.expressionIndexes[1]);
        expect(chunk.mediaRows).toHaveLength(1);
        expect(chunk.mediaRows[0].index).toBe(1);
        expect(chunk.mediaRows[0].row.glossaryMayContainMedia).toBe(true);
        expect(getContentString({termEntryContentBytes: chunk.contentBytesList[0]})).toContain('"plain"');
        expect(plan.stringHashes[plan.expressionIndexes[0]]).toBe(hashBytes(textEncoder.encode('escaped\\value')));
        expect(plan.stringHashes[plan.expressionIndexes[1]]).toBe(hashBytes(textEncoder.encode('image')));
        expect(consumeLastTermBankWasmParseProfile()?.nativeStringPlanFallbackChunkCount).toBe(1);
    });

    maybeTest('emits shared content slabs without allocating per-row content views', async () => {
        const source = textEncoder.encode(JSON.stringify([
            ['first', '', '', '', 1, ['same'], 1, ''],
            ['second', '', '', '', 2, ['same'], 2, ''],
            ['third', '', '', '', 3, ['different'], 3, ''],
            ['fourth', '', '', '', 4, ['different'], 4, ''],
        ]));
        /** @type {Array<Parameters<Parameters<typeof parseTermBankWithWasmColumnChunks>[2]>[0]>} */
        const chunks = [];
        await parseTermBankWithWasmColumnChunks(
            source,
            3,
            (chunk) => { chunks.push(chunk); },
            8,
            {emitContentSlab: true, emitTermByteLists: false},
        );

        const [chunk] = chunks;
        expect(chunk.contentBytesList).toHaveLength(0);
        expect(chunk.expressionBytesList).toHaveLength(0);
        expect(chunk.readingBytesList).toHaveLength(0);
        expect(chunk.contentHash1List).toHaveLength(0);
        expect(chunk.contentHash2List).toHaveLength(0);
        expect(chunk.contentMetaList).toBeInstanceOf(Uint32Array);
        expect(chunk.contentMetaList).toHaveLength(16);
        expect(chunk.contentBytesBuffer).toBeInstanceOf(Uint8Array);
        const contentStrings = [0, 1, 2, 3].map((index) => {
            const metaOffset = index * 4;
            const offset = chunk.contentBytesBaseOffset + chunk.contentMetaList[metaOffset];
            const length = chunk.contentMetaList[metaOffset + 1];
            return textDecoder.decode(chunk.contentBytesBuffer.subarray(offset, offset + length));
        });
        expect(contentStrings[0]).toBe(contentStrings[1]);
        expect(contentStrings[0]).toContain('"same"');
        expect(contentStrings[2]).toBe(contentStrings[3]);
        expect(contentStrings[2]).toContain('"different"');
        expect(contentStrings[2]).not.toBe(contentStrings[0]);
        expect(chunk.contentMetaList[2]).toBe(chunk.contentMetaList[6]);
        expect(chunk.contentMetaList[3]).toBe(chunk.contentMetaList[7]);
        expect(chunk.contentMetaList[10]).toBe(chunk.contentMetaList[14]);
        expect(chunk.contentMetaList[11]).toBe(chunk.contentMetaList[15]);
        expect(chunk.contentMetaList[0]).not.toBe(chunk.contentMetaList[4]);
        expect(chunk.contentMetaList[8]).not.toBe(chunk.contentMetaList[12]);
        expect(chunk.contentMetaList[8]).toBeGreaterThan(chunk.contentMetaList[0]);
        expect(chunk.contentUniqueIndexList).toBeNull();
        expect(chunk.contentDedupPlan).toBeNull();
    });

    maybeTest('emits compact token-binary content with strict round-trip decoding', async () => {
        const source = textEncoder.encode(JSON.stringify([
            ['first', '', 'tag\\value', 'rule\\value', 1, ['same', {type: 'text', text: 'wrapped'}], 1, 'term-tag'],
            ['second', '', 'tag\\value', 'rule\\value', 2, ['same', 'wrapped'], 2, 'term-tag'],
            ['third', '', 'tag\\value', 'rule\\value', 3, ['different'], 3, 'term-tag'],
            ['fourth', '', 'tag\\value', 'rule\\value', 4, [{type: 'text', text: 'different'}], 4, 'term-tag'],
        ]));
        const chunks = [];
        await parseTermBankWithWasmColumnChunks(
            source,
            3,
            (chunk) => { chunks.push(chunk); },
            8,
            {emitContentSlab: true, emitTokenBinaryContent: true},
        );

        const [chunk] = chunks;
        const contents = [0, 1].map((index) => {
            const metaOffset = index * 4;
            const offset = chunk.contentBytesBaseOffset + chunk.contentMetaList[metaOffset];
            const length = chunk.contentMetaList[metaOffset + 1];
            const bytes = chunk.contentBytesBuffer.subarray(offset, offset + length);
            return {bytes, decoded: decodeRawTermContentTokenBinary(bytes, textDecoder)};
        });
        expect(contents[0].decoded).toStrictEqual({
            rules: 'rule\\value',
            definitionTags: 'tag\\value',
            termTags: 'term-tag',
            glossaryJson: '["same","wrapped"]',
        });
        expect(contents[1].decoded).toStrictEqual(contents[0].decoded);
        expect(chunk.contentMetaList[2]).toBe(chunk.contentMetaList[6]);
        expect(chunk.contentMetaList[3]).toBe(chunk.contentMetaList[7]);
        expect(chunk.contentMetaList[0]).toBe(chunk.contentMetaList[4]);
        expect(chunk.contentMetaList[8]).toBe(chunk.contentMetaList[12]);
        expect(chunk.contentMetaList[8]).toBeGreaterThan(chunk.contentMetaList[0]);
        expect(chunk.contentUniqueIndexList).toStrictEqual(new Uint32Array([0, 0, 1, 1]));
        expect(chunk.contentDedupPlan?.uniqueCount).toBe(2);
        expect(hashTermEntryContentBytesPair(contents[0].bytes)).toEqual([
            chunk.contentMetaList[2],
            chunk.contentMetaList[3],
        ]);

        const malformed = Uint8Array.from(contents[0].bytes.filter((value) => value !== 0));
        expect(decodeRawTermContentTokenBinary(malformed, textDecoder)).toBeNull();

        const formattedChunks = [];
        await parseTermBankWithWasmColumnChunks(
            textEncoder.encode(`[
                ["formatted", "", "", "", 0, [ "same", { "type" : "text", "text" : "wrapped" } ], 1, ""],
                ["canonical", "", "", "", 0, ["same","wrapped"], 2, ""]
            ]`),
            3,
            (chunk2) => { formattedChunks.push(chunk2); },
            8,
            {emitContentSlab: true, emitTokenBinaryContent: true},
        );
        const [formattedChunk] = formattedChunks;
        expect(formattedChunk.contentMetaList[2]).toBe(formattedChunk.contentMetaList[6]);
        expect(formattedChunk.contentMetaList[3]).toBe(formattedChunk.contentMetaList[7]);
        expect(formattedChunk.contentMetaList[1]).toBe(formattedChunk.contentMetaList[5]);
    });

});
