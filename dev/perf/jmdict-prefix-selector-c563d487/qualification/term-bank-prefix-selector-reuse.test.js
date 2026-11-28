/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {readFile} from 'node:fs/promises';
import {crc32, deflateRawSync} from 'node:zlib';
import {afterAll, beforeAll, describe, expect, test} from 'vitest';
import {decodeRawTermContentTokenBinary} from '../ext/js/dictionary/raw-term-content.js';
import {hashTermEntryContentBytesPair} from '../ext/js/dictionary/term-entry-content-hash.js';
import {
    consumeLastTermBankWasmParseProfile,
    copyWasmBackedColumnChunk,
    disposeParallelTermBankParser,
    inflateCompressedTermBankSourcesWasm,
    parseTermBankWithWasmColumnChunks,
    setTermBankWasmModule,
} from '../ext/js/dictionary/term-bank-wasm-parser.js';
import {bank, fallbackCases, malformedCases, rawRow, row, validCases} from './term-bank-prefix-selector-fixtures.js';

/** @typedef {Parameters<Parameters<typeof parseTermBankWithWasmColumnChunks>[2]>[0]} Chunk */
/** @typedef {import('dictionary-importer').ImportExperiments} Experiments */
/** @typedef {string|{type: 'text', text: string}|{type: 'image', path: string}} GlossaryValue */
/** @typedef {[string, string, string|null, string, number, GlossaryValue[], number|null, string]} SourceRow */

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {ignoreBOM: true});

/**
 * The fixtures use independent compressed/stored logical banks. Appending an
 * empty bank exercises ordinary multi-bank fusion, not the single-bank flag.
 * @param {string[]} banks
 * @param {Experiments} [experiments]
 * @param {Chunk[]} [chunks]
 * @param {boolean} [corruptLastSignature]
 * @param {boolean} [validateGlossaryTypes]
 * @returns {Promise<{chunks: Chunk[], memory: WebAssembly.Memory, profile: NonNullable<ReturnType<typeof consumeLastTermBankWasmParseProfile>>}>}
 */
async function parse(banks, experiments = {}, chunks = [], corruptLastSignature = false, validateGlossaryTypes = true) {
    const sourceBanks = banks.length === 1 ? [...banks, '[]'] : banks;
    const sources = sourceBanks.map((text, index) => {
        const decoded = encoder.encode(text);
        /** @type {0|8} */
        const compressionMethod = index % 2 === 0 ? 8 : 0;
        const bytes = compressionMethod === 8 ? Uint8Array.from(deflateRawSync(decoded)) : decoded;
        return {bytes, compressionMethod, compressedSize: bytes.length, uncompressedSize: decoded.length, signature: crc32(decoded)};
    });
    if (corruptLastSignature) { sources[sources.length - 1].signature = (sources[sources.length - 1].signature ^ 1) >>> 0; }
    const options = {
        experimentalNativeEscapedKeys: true,
        ...experiments,
        singleChunk: true,
        emitTermByteLists: true,
        computeContentHashes: true,
        emitContentSlab: true,
        emitTokenBinaryContent: true,
        mediaHintFastScan: true,
        validateGlossaryTypes,
        prepareLookupIndexes: true,
    };
    const preloadedSource = await inflateCompressedTermBankSourcesWasm(sources, options, true);
    await parseTermBankWithWasmColumnChunks(
        new Uint8Array(0),
        3,
        (chunk) => { chunks.push(copyWasmBackedColumnChunk(chunk)); },
        2048,
        {...options, preloadedSource},
    );
    const profile = consumeLastTermBankWasmParseProfile();
    if (profile === null) { throw new Error('Missing public parser profile'); }
    expect(profile.fusedParseAttempts).toBe(experiments.experimentalSkipFusedParse === true ? 0 : 1);
    expect(profile.fusedSingleBankGroups ?? 0).toBe(0);
    return {chunks, memory: preloadedSource.wasm.memory, profile};
}

/**
 * Independent expectations use JSON.parse and the public text-object
 * normalization rule. Explicit raw-reading cases supply their expected flags.
 * @param {string[]} banks
 * @param {number[]} [equals]
 * @returns {Array<{expression: string, reading: string, equal: number, score: number, negativeZero: boolean, sequence: number, content: {rules: string, definitionTags: string, termTags: string, glossary: Array<string|{type: 'image', path: string}>}}>}
 */
function expectedRows(banks, equals = []) {
    const rows = banks.flatMap((text) => /** @type {SourceRow[]} */ (JSON.parse(text)));
    return rows.map(([expression, reading, definitionTags, rules, score, values, sequence, termTags], index) => ({
        expression: decoder.decode(encoder.encode(expression)),
        reading: decoder.decode(encoder.encode(reading || expression)),
        equal: equals[index] ?? (reading === '' || reading === expression ? 1 : 0),
        score,
        negativeZero: Object.is(score, -0),
        sequence: sequence ?? -1,
        content: {rules,
            definitionTags: definitionTags ?? '',
            termTags,
            glossary: values.map((value) => (typeof value === 'object' && value.type === 'text' ? value.text : value))},
    }));
}

/**
 * @param {Chunk[]} chunks
 * @returns {{rows: ReturnType<typeof expectedRows>, bytes: number[][], uniqueIndexes: number[], uniqueRows: number[][], uniqueSignatures: number[][], uniqueCounts: number[], indexes: Array<[string, number[]]>, media: Chunk['mediaRows']}}
 */
function snapshot(chunks) {
    /** @type {ReturnType<typeof expectedRows>} */
    const rows = [];
    /** @type {number[][]} */
    const bytes = [];
    /** @type {number[]} */
    const uniqueIndexes = [];
    /** @type {number[][]} */
    const uniqueRows = [];
    /** @type {number[][]} */
    const uniqueSignatures = [];
    /** @type {number[]} */
    const uniqueCounts = [];
    /** @type {Array<[string, number[]]>} */
    const indexes = [];
    /** @type {Chunk['mediaRows']} */
    const media = [];
    for (const chunk of chunks) {
        const meta = chunk.contentMetaList;
        const source = chunk.contentBytesBuffer;
        const ids = chunk.contentUniqueIndexList;
        if (!(meta instanceof Uint32Array) || !(source instanceof Uint8Array) || ids === null || chunk.contentDedupPlan === null) {
            throw new Error('Missing production content metadata');
        }
        for (let i = 0; i < chunk.rowCount; ++i) {
            const m = (chunk.contentMetaByUniqueIndex ? ids[i] : i) * 4;
            const start = (chunk.contentBytesBaseOffset ?? 0) + meta[m];
            expect(start).toBeGreaterThanOrEqual(0);
            expect(start + meta[m + 1]).toBeLessThanOrEqual(source.length);
            const content = source.subarray(start, start + meta[m + 1]);
            expect(content.length).toBe(meta[m + 1]);
            expect(hashTermEntryContentBytesPair(content)).toEqual([meta[m + 2], meta[m + 3]]);
            const decoded = decodeRawTermContentTokenBinary(content, decoder);
            if (decoded === null) { throw new Error('Invalid token-binary term content'); }
            const expression = decoder.decode(chunk.expressionBytesList[i]);
            rows.push({expression,
                reading: chunk.readingEqualsExpressionList[i] === 1 ? expression : decoder.decode(chunk.readingBytesList[i]),
                equal: chunk.readingEqualsExpressionList[i],
                score: chunk.scoreList[i],
                negativeZero: Object.is(chunk.scoreList[i], -0),
                sequence: chunk.sequenceList[i],
                content: {rules: decoded.rules,
                    definitionTags: decoded.definitionTags,
                    termTags: decoded.termTags,
                    glossary: /** @type {ReturnType<typeof expectedRows>[number]['content']['glossary']} */ (JSON.parse(decoded.glossaryJson))}});
            bytes.push([...content]);
        }
        uniqueIndexes.push(...ids);
        uniqueRows.push([...chunk.contentDedupPlan.uniqueRowIndexes]);
        uniqueSignatures.push([...chunk.contentDedupPlan.uniqueSignatures ?? []]);
        uniqueCounts.push(chunk.contentDedupPlan.uniqueCount);
        for (const [key, value] of chunk.preparedLookupIndexes ?? []) { indexes.push([key, [...value.bytes]]); }
        media.push(...chunk.mediaRows);
    }
    return {rows, bytes, uniqueIndexes, uniqueRows, uniqueSignatures, uniqueCounts, indexes, media};
}

beforeAll(async () => {
    // The source checkout must first rebuild its own uninstrumented WASM.
    setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))));
});
afterAll(async () => { await disposeParallelTermBankParser(); });

describe('strict prefix-selected glossary reuse preserves production semantics and policy', () => {
    test.each(validCases)('$name', async ({banks, equals, baselineReuses, selectorReuses}) => {
        const enabledResult = await parse(banks);
        expect(enabledResult.profile.fusedParseFallbacks ?? 0).toBe(0);
        expect(enabledResult.profile.validatedGlossaryReuseCount).toBe(baselineReuses + selectorReuses);
        const enabled = snapshot(enabledResult.chunks);
        const expected = expectedRows(banks, equals);
        expect(enabled.rows).toEqual(expected);
        if (expected.length > 0) { expect(enabled.indexes.length).toBeGreaterThan(0); }
        const mediaContents = new Set(expected.filter(({content}) => content.glossary.some((value) => typeof value === 'object' && value.type === 'image'))
            .map(({content}) => JSON.stringify(content)));
        expect(enabled.media.length).toBe(mediaContents.size);
        const disabledResult = await parse(banks, {experimentalValidatedGlossaryReuse: false});
        expect(disabledResult.profile.validatedGlossaryReuseCount).toBe(0);
        expect(snapshot(disabledResult.chunks)).toEqual(enabled);
        const generic = snapshot((await parse(banks, {experimentalSkipFusedParse: true})).chunks);
        expect(generic.rows).toEqual(expected);
        expect(generic.bytes).toEqual(enabled.bytes);
        expect(generic.indexes).toEqual(enabled.indexes);
    });

    test.each(malformedCases)('rejects $name without publishing a valid prefix', async ({banks}) => {
        for (const experimentalValidatedGlossaryReuse of [true, false]) {
            /** @type {Chunk[]} */
            const published = [];
            await expect(parse(banks, {experimentalValidatedGlossaryReuse}, published)).rejects.toThrow();
            expect(published).toHaveLength(0);
            const fresh = [bank(row('fresh', {score: '3', sequence: '9', gloss: '["new"]'})), '[]'];
            const result = await parse(fresh);
            expect(result.profile.validatedGlossaryReuseCount).toBe(0);
            expect(snapshot(result.chunks).rows).toEqual(expectedRows(fresh));
        }
    });

    test.each(fallbackCases)('$name', async ({banks, equals}) => {
        const enabled = await parse(banks);
        expect(enabled.profile.fusedParseFallbacks).toBe(1);
        expect(snapshot(enabled.chunks).rows).toEqual(expectedRows(banks, equals));
        expect(snapshot((await parse(banks, {experimentalValidatedGlossaryReuse: false})).chunks)).toEqual(snapshot(enabled.chunks));
    });

    test('escaped keys still use the existing disabled-native-key fallback', async () => {
        const banks = [bank(rawRow('"\\u0061"'), rawRow('"\\u0061"')), '[]'];
        const result = await parse(banks, {experimentalNativeEscapedKeys: false});
        expect(result.profile.fusedParseFallbacks).toBe(1);
        expect(snapshot(result.chunks).rows).toEqual(expectedRows(banks));
        expect(snapshot((await parse(banks, {experimentalNativeEscapedKeys: false, experimentalValidatedGlossaryReuse: false})).chunks)).toEqual(snapshot(result.chunks));
    });

    test('permissive parsing does not enable the strict prefix selector', async () => {
        const banks = [bank(row('same'), row('same')), '[]'];
        const result = await parse(banks, {}, [], false, false);
        expect(result.profile.fusedParseFallbacks ?? 0).toBe(0);
        expect(result.profile.validatedGlossaryReuseCount).toBe(0);
        expect(snapshot(result.chunks).rows).toEqual(expectedRows(banks));
    });

    test('a wrong bank CRC is rejected after an older long glossary proof', async () => {
        const fixture = validCases.find(({name}) => name === 'older selected glossary can exceed the immediate 511-byte bound');
        if (typeof fixture === 'undefined') { throw new Error('Missing long-range fixture'); }
        /** @type {Chunk[]} */
        const published = [];
        await expect(parse(fixture.banks, {}, published, true)).rejects.toThrow();
        expect(published).toHaveLength(0);
        const again = await parse(fixture.banks);
        expect(again.profile.validatedGlossaryReuseCount).toBe(1);
        expect(snapshot(again.chunks).rows).toEqual(expectedRows(fixture.banks));
    });

    test('key state, probe state and owned outputs do not leak across requests or heap growth', async () => {
        const banks = [bank(row('same')), '[]', bank(row('same'))];
        const held = await parse(banks);
        expect(held.profile.validatedGlossaryReuseCount).toBe(1);
        const saved = structuredClone(held.chunks);
        held.memory.grow(1);
        await expect(parse([bank(row('same')), `[${row('same')} null]`])).rejects.toThrow();
        const fresh = [bank(row('fresh', {score: '7', sequence: '29', gloss: '["replacement"]'})), '[]'];
        const next = await parse(fresh);
        expect(next.profile.validatedGlossaryReuseCount).toBe(0);
        expect(snapshot(next.chunks).rows).toEqual(expectedRows(fresh));
        const disabled = await parse(banks, {experimentalValidatedGlossaryReuse: false});
        expect(disabled.profile.validatedGlossaryReuseCount).toBe(0);
        expect(snapshot(disabled.chunks)).toEqual(snapshot(held.chunks));
        expect((await parse(banks)).profile.validatedGlossaryReuseCount).toBe(1);
        expect(held.chunks).toEqual(saved);
        expect(snapshot(held.chunks).rows).toEqual(expectedRows(banks));
    });
});
