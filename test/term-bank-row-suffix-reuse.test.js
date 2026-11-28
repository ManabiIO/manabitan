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

/** @typedef {Parameters<Parameters<typeof parseTermBankWithWasmColumnChunks>[2]>[0]} Chunk */
/** @typedef {import('dictionary-importer').ImportExperiments} Experiments */
/** @typedef {string|{type: 'text', text: string}|{type: 'image', path: string}} GlossaryValue */
/** @typedef {[string, string, string|null, string, number, GlossaryValue[], number|null, string]} SourceRow */
/** @typedef {{score?: string, sequence?: string, definitionTags?: string, rules?: string, termTags?: string, gloss?: string}} Fields */
/** @typedef {{name: string, banks: string[], equals?: number[]}} ValidCase */

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {ignoreBOM: true});
const glossary = '[{"type":"text","text":"  shared text  "},{"type":"image","path":"image.png"}]';

/**
 * @param {Fields} [fields]
 * @returns {string}
 */
function body({score = '-5', sequence = '17', definitionTags = '"noun"', rules = '""', termTags = '"common"', gloss = glossary} = {}) {
    return `${definitionTags},${rules},${score},${gloss},${sequence},${termTags}`;
}

/**
 * @param {string} expression
 * @param {Fields} [fields]
 * @param {string} [reading]
 * @returns {string}
 */
function row(expression, fields = {}, reading = '""') {
    return `[${JSON.stringify(expression)},${reading},${body(fields)}]`;
}

/**
 * @param {...string} rows
 * @returns {string}
 */
function bank(...rows) { return `[${rows.join(',')}]`; }

/**
 * @param {Fields} [first]
 * @param {Fields} [second]
 * @param {Fields} [last]
 * @returns {string}
 */
function three(first = {}, second = first, last = second) {
    return bank(row('first', first), row('second', second), row('last', last));
}

const prefix = bank(row('first'), row('second'));
/** @type {ValidCase[]} */
const validCases = [
    {name: 'cross-bank escaped keys retain raw reading identity', banks: [prefix, `[["\\u0061","a",${body()}],["a","a",${body()}]]`], equals: [1, 1, 0, 1]},
    {name: 'same-length unequal glossary', banks: [three({}, {}, {gloss: glossary.replace('shared', 'differ')})]},
    {name: 'unequal definition tags', banks: [three({}, {}, {definitionTags: '"verb"'})]},
    {name: 'unequal term tags', banks: [three({}, {}, {termTags: '"public"'})]},
    {name: 'unequal current score', banks: [three({}, {}, {score: '-4'})]},
    {name: 'unequal current sequence', banks: [three({}, {}, {sequence: '18'})]},
    {name: 'differing prior scores', banks: [three({}, {score: '-4'}, {score: '-4'})]},
    {name: 'differing prior sequences', banks: [three({}, {sequence: '18'}, {sequence: '18'})]},
    {name: 'differing prior numerics across banks', banks: [bank(row('first')), bank(row('second', {score: '-4', sequence: '18'})), bank(row('third', {score: '-4', sequence: '18'}))]},
    {name: 'nullable tags and sequence', banks: [three({score: '0', sequence: 'null', definitionTags: 'null'})]},
    {name: 'empty bank between equal pairs', banks: [prefix, '[]', bank(row('last'))]},
    {name: 'fractional score fallback', banks: [three({score: '0.5'})]},
    {name: 'exponent score fallback', banks: [three({score: '1e1'})]},
    {name: 'exponent sequence fallback', banks: [three({sequence: '1e1'})]},
    {name: 'negative zero fallback', banks: [three({score: '-0'})]},
    {name: 'fraction after equal prior pair', banks: [three({}, {}, {score: '0.5'})]},
    {name: 'negative zero after equal prior pair', banks: [three({score: '0'}, {score: '0'}, {score: '-0'})]},
    {name: 'valid numeric prefix extension', banks: [three({score: '1'}, {score: '1'}, {score: '10'})]},
];
const malformedCases = [
    {name: 'fractional sequence after fallback', banks: [three({sequence: '0.5'})]},
    {name: 'extra field after equal pair', banks: [prefix, `[["last","",${body()},true]]`]},
    {name: 'suffix token extension', banks: [prefix, `[["last","",${body()} null]]`]},
    {name: 'post-row token after a proven suffix', banks: [prefix, `[${row('last')} null]`]},
    {name: 'truncated bank', banks: [prefix, `[["last","",${body().slice(0, -1)}`]},
    {name: 'next bank cannot complete a truncated token', banks: [prefix, `[["last","",${body().slice(0, -1)}`, '"]]]']},
    {name: 'boolean score after equal pair', banks: [prefix, bank(row('last', {score: 'false'}))]},
    {name: 'invalid tags after a successful equal suffix', banks: [prefix, bank(row('last'), row('broken', {definitionTags: '{}'}))]},
    {name: 'invalid numeric prefix extension', banks: [bank(row('first', {score: '0'}), row('second', {score: '0'})), bank(row('last', {score: '00'}))]},
    {name: 'malformed current expression', banks: [prefix, `[["bad\\x","",${body()}]]`]},
    {name: 'malformed current reading', banks: [prefix, `[["last","bad\\x",${body()}]]`]},
    {name: 'malformed current sequence', banks: [prefix, bank(row('last', {sequence: '17e'}))]},
];

/**
 * Parse real independently compressed/stored banks through the committed
 * production WASM. Copy callback data at its documented ownership boundary.
 * @param {string[]} banks
 * @param {Experiments} [experiments]
 * @param {Chunk[]} [chunks]
 * @param {boolean} [corruptLastSignature]
 * @returns {Promise<{chunks: Chunk[], memory: WebAssembly.Memory}>}
 */
async function parse(banks, experiments = {}, chunks = [], corruptLastSignature = false) {
    // Exercise the ordinary multi-bank fused admission for short one-bank
    // fixtures as well; no single-bank experiment or production default changes.
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
        validateGlossaryTypes: true,
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
    expect(profile?.fusedParseAttempts ?? 0).toBe(experiments.experimentalSkipFusedParse === true ? 0 : 1);
    return {chunks, memory: preloadedSource.wasm.memory};
}

/**
 * Independent expected values use JavaScript's JSON parser and the fixture's
 * public text-object normalization rule, not a second native parser run.
 * @param {string[]} banks
 * @param {number[]} [equals]
 * @returns {Array<{expression: string, reading: string, equal: number, score: number, negativeZero: boolean, sequence: number, content: {rules: string, definitionTags: string, termTags: string, glossary: Array<string|{type: 'image', path: string}>}}>}
 */
function expectedRows(banks, equals = []) {
    const rows = banks.flatMap((text) => /** @type {SourceRow[]} */ (JSON.parse(text)));
    return rows.map(([expression, reading, definitionTags, rules, score, values, sequence, termTags], index) => ({
        expression,
        reading: reading || expression,
        equal: equals[index] ?? 1,
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
 * @throws {Error} If a required production output is missing or malformed.
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
            throw new Error('Missing native content metadata');
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
    // Load the committed production module; no diagnostic rebuild or skip.
    setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))));
});
afterAll(async () => { await disposeParallelTermBankParser(); });

describe('strict row-suffix reuse preserves production semantics', () => {
    test.each(validCases)('$name', async ({banks, equals}) => {
        const enabled = snapshot((await parse(banks)).chunks);
        expect(enabled.rows).toEqual(expectedRows(banks, equals));
        expect(enabled.indexes.length).toBeGreaterThan(0);
        expect(enabled.media.length).toBeGreaterThan(0);
        const disabled = snapshot((await parse(banks, {experimentalValidatedGlossaryReuse: false})).chunks);
        expect(disabled).toEqual(enabled);
        const generic = snapshot((await parse(banks, {experimentalSkipFusedParse: true})).chunks);
        expect(generic.rows).toEqual(enabled.rows);
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
            expect(snapshot((await parse(fresh)).chunks).rows).toEqual(expectedRows(fresh));
        }
    });

    test('rejects a wrong bank CRC despite equal suffixes', async () => {
        const repeated = {gloss: JSON.stringify(['x'.repeat(4096)])};
        const banks = [bank(row('first', repeated), row('second', repeated)), '[]', bank(row('last', repeated))];
        /** @type {Chunk[]} */
        const published = [];
        await expect(parse(banks, {}, published, true)).rejects.toThrow();
        expect(published).toHaveLength(0);
        expect(snapshot((await parse(banks)).chunks).rows).toEqual(expectedRows(banks));
    });

    test('keeps copied content, keys, media and lookup bytes owned across growth and failed requests', async () => {
        const banks = [prefix, '[]', bank(row('last'))];
        const held = await parse(banks);
        const saved = structuredClone(held.chunks);
        held.memory.grow(1);
        await expect(parse([prefix, `[${row('broken')} null]`])).rejects.toThrow();
        const fresh = [three({score: '7', sequence: '29', gloss: '["replacement"]'})];
        expect(snapshot((await parse(fresh, {experimentalValidatedGlossaryReuse: false})).chunks).rows).toEqual(expectedRows(fresh));
        expect(held.chunks).toEqual(saved);
        expect(snapshot(held.chunks).rows).toEqual(expectedRows(banks));
    });
});
