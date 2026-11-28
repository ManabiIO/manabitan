/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {readFile} from 'node:fs/promises';
import {crc32, deflateRawSync} from 'node:zlib';
import {afterAll, beforeAll, describe, expect, test} from 'vitest';
import {decodeRawTermContentTokenBinary} from '../ext/js/dictionary/raw-term-content.js';
import {
    consumeLastTermBankWasmParseProfile,
    copyWasmBackedColumnChunk,
    disposeParallelTermBankParser,
    inflateCompressedTermBankSourcesWasm,
    parseTermBankWithWasmColumnChunks,
    setTermBankWasmModule,
} from '../ext/js/dictionary/term-bank-wasm-parser.js';
import {acceptedNegativeZeroSequenceFixture, invalidNullScoreAfterProof, proofConsumerFixtures} from './term-bank-row-suffix-proof-fixtures.js';

/** @typedef {Parameters<Parameters<typeof parseTermBankWithWasmColumnChunks>[2]>[0]} Chunk */
/** @typedef {import('dictionary-importer').ImportExperiments} Experiments */
/** @typedef {[string, string, string|null, string, number, unknown[], number|null, string]} SourceRow */
/** @typedef {{expression: string, reading: string, score: number, sequence: number, definitionTags: string, rules: string, termTags: string, glossary: unknown[]}} SemanticRow */

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {ignoreBOM: true});

/**
 * @param {string[]} banks
 * @param {Experiments} [experiments]
 * @param {Chunk[]} [published]
 * @returns {Promise<{chunks: Chunk[], attempts: number, fallbacks: number, glossaryReuses: number, globalHits: number}>}
 */
async function parse(banks, experiments = {}, published = []) {
    expect(banks.length).toBeGreaterThanOrEqual(2);
    const sources = banks.map((text) => {
        const raw = encoder.encode(text);
        const bytes = Uint8Array.from(deflateRawSync(raw));
        return {bytes, compressionMethod: /** @type {const} */ (8), compressedSize: bytes.length, uncompressedSize: raw.length, signature: crc32(raw)};
    });
    const options = {
        experimentalNativeEscapedKeys: true,
        experimentalValidatedGlossaryReuse: true,
        ...experiments,
        singleChunk: true,
        emitTermByteLists: true,
        computeContentHashes: true,
        emitContentSlab: true,
        emitTokenBinaryContent: true,
        mediaHintFastScan: true,
        validateGlossaryTypes: true,
        prepareLookupIndexes: true,
    };
    const preloadedSource = await inflateCompressedTermBankSourcesWasm(sources, options, true);
    await parseTermBankWithWasmColumnChunks(
        new Uint8Array(0),
        3,
        (chunk) => { published.push(copyWasmBackedColumnChunk(chunk)); },
        2048,
        {...options, preloadedSource},
    );
    const profile = consumeLastTermBankWasmParseProfile();
    expect(profile).not.toBeNull();
    return {chunks: published,
        attempts: profile?.fusedParseAttempts ?? 0,
        fallbacks: profile?.fusedParseFallbacks ?? 0,
        glossaryReuses: profile?.validatedGlossaryReuseCount ?? 0,
        globalHits: profile?.globalExactContentReuseCount ?? 0};
}

/**
 * @param {string[]} banks
 * @returns {SemanticRow[]}
 */
function expectedRows(banks) {
    const rows = banks.flatMap((text) => /** @type {SourceRow[]} */ (JSON.parse(text)));
    return rows.map(([expression, reading, definitionTags, rules, score, glossary, sequence, termTags]) => ({
        expression,
        reading: reading || expression,
        score,
        sequence: sequence ?? -1,
        definitionTags: definitionTags ?? '',
        rules,
        termTags,
        glossary,
    }));
}

/**
 * @param {Chunk[]} chunks
 * @returns {{rows: SemanticRow[], bytes: number[][], uniqueIndexes: number[], indexes: Array<[string, number[]]>}}
 */
function snapshot(chunks) {
    /** @type {SemanticRow[]} */
    const rows = [];
    /** @type {number[][]} */
    const bytes = [];
    /** @type {number[]} */
    const uniqueIndexes = [];
    /** @type {Array<[string, number[]]>} */
    const indexes = [];
    for (const chunk of chunks) {
        const meta = chunk.contentMetaList;
        const source = chunk.contentBytesBuffer;
        const ids = chunk.contentUniqueIndexList;
        if (!(meta instanceof Uint32Array) || !(source instanceof Uint8Array) || ids === null) {
            throw new Error('Missing native content metadata');
        }
        for (let i = 0; i < chunk.rowCount; ++i) {
            const m = (chunk.contentMetaByUniqueIndex ? ids[i] : i) * 4;
            const start = (chunk.contentBytesBaseOffset ?? 0) + meta[m];
            const content = source.subarray(start, start + meta[m + 1]);
            expect(content.length).toBe(meta[m + 1]);
            const decoded = decodeRawTermContentTokenBinary(content, decoder);
            if (decoded === null) { throw new Error('Invalid token-binary content'); }
            const expression = decoder.decode(chunk.expressionBytesList[i]);
            rows.push({expression,
                reading: chunk.readingEqualsExpressionList[i] === 1 ? expression : decoder.decode(chunk.readingBytesList[i]),
                score: chunk.scoreList[i],
                sequence: chunk.sequenceList[i],
                definitionTags: decoded.definitionTags,
                rules: decoded.rules,
                termTags: decoded.termTags,
                glossary: /** @type {unknown[]} */ (JSON.parse(decoded.glossaryJson))});
            bytes.push([...content]);
        }
        uniqueIndexes.push(...ids);
        for (const [key, index] of chunk.preparedLookupIndexes ?? []) { indexes.push([key, [...index.bytes]]); }
    }
    return {rows, bytes, uniqueIndexes, indexes};
}

beforeAll(async () => {
    setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))));
});
afterAll(async () => { await disposeParallelTermBankParser(); });

describe('full row-suffix proof is consumed only by its valid fused row', () => {
    test.each(proofConsumerFixtures)('$name', async ({banks, experiments, expectedFallbacks, expectedGlossaryReuses, expectedGlobalHits}) => {
        const expected = expectedRows(banks);
        const actual = await parse(banks, experiments);
        expect(actual.attempts).toBe(1);
        expect(actual.fallbacks).toBe(expectedFallbacks);
        expect(actual.glossaryReuses).toBe(expectedGlossaryReuses);
        expect(actual.globalHits).toBe(expectedGlobalHits);
        const value = snapshot(actual.chunks);
        expect(value.rows).toStrictEqual(expected);
        expect(value.indexes.length).toBeGreaterThan(0);
        // Ordinary conversion remains an independent comparison route for
        // numeric columns, complete content bytes and prepared lookup indexes.
        const disabled = await parse(banks, {...experiments, experimentalValidatedGlossaryReuse: false});
        expect(disabled.attempts).toBe(1);
        expect(disabled.fallbacks).toBe(expectedFallbacks);
        expect(disabled.glossaryReuses).toBe(0);
        expect(disabled.globalHits).toBe(expectedGlobalHits);
        expect(snapshot(disabled.chunks)).toStrictEqual(value);
    });

    test(acceptedNegativeZeroSequenceFixture.name, async () => {
        const {banks, expectedFallbacks, expectedGlossaryReuses, expectedGlobalHits} = acceptedNegativeZeroSequenceFixture;
        const sourceRows = expectedRows(banks);
        expect(sourceRows.every(({sequence}) => Object.is(sequence, -0))).toBe(true);
        // The ordinary accepted int32 sequence path already normalizes -0 to 0.
        // Keep the source oracle unchanged for fallback score/sequence cases.
        const expected = sourceRows.map((value) => ({...value, sequence: 0}));
        const actual = await parse(banks);
        expect(actual.attempts).toBe(1);
        expect(actual.fallbacks).toBe(expectedFallbacks);
        expect(actual.glossaryReuses).toBe(expectedGlossaryReuses);
        expect(actual.globalHits).toBe(expectedGlobalHits);
        const value = snapshot(actual.chunks);
        expect(value.rows).toStrictEqual(expected);
        expect(value.indexes.length).toBeGreaterThan(0);
        const disabled = await parse(banks, {experimentalValidatedGlossaryReuse: false});
        expect(disabled.attempts).toBe(1);
        expect(disabled.fallbacks).toBe(0);
        expect(disabled.glossaryReuses).toBe(0);
        expect(snapshot(disabled.chunks)).toStrictEqual(value);
    });

    test('a null score after a successful suffix rejects without publishing the prefix', async () => {
        for (const experimentalValidatedGlossaryReuse of [true, false]) {
            /** @type {Chunk[]} */
            const published = [];
            await expect(parse(invalidNullScoreAfterProof, {experimentalValidatedGlossaryReuse}, published)).rejects.toThrow();
            expect(published).toHaveLength(0);
            const {banks, expectedGlossaryReuses} = proofConsumerFixtures[4];
            const fresh = await parse(banks);
            expect(fresh.attempts).toBe(1);
            expect(fresh.fallbacks).toBe(0);
            expect(fresh.glossaryReuses).toBe(expectedGlossaryReuses);
            expect(snapshot(fresh.chunks).rows).toStrictEqual(expectedRows(banks));
        }
    });
});
