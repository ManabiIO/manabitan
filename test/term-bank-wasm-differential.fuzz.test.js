/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {readFile} from 'node:fs/promises';
import fc from 'fast-check';
import {beforeAll, describe, expect, test} from 'vitest';
import {parseTermBankWithWasmChunks, setTermBankWasmModule} from '../ext/js/dictionary/term-bank-wasm-parser.js';

const encoder = new TextEncoder();
const fuzzSeedText = process.env.MANABITAN_FUZZ_SEED;
const fuzzSeed = typeof fuzzSeedText === 'string' && fuzzSeedText.length > 0 ? Number(fuzzSeedText) : 20261018;
const fuzzPath = process.env.MANABITAN_FUZZ_PATH || undefined;
const fuzzRuns = Number(process.env.MANABITAN_FUZZ_RUNS || 60);

if (!Number.isSafeInteger(fuzzSeed) || !Number.isInteger(fuzzRuns) || fuzzRuns < 1 || fuzzRuns > 500) {
    throw new Error('MANABITAN_FUZZ_SEED must be a safe integer and MANABITAN_FUZZ_RUNS must be between 1 and 500');
}

beforeAll(async () => {
    const wasmPath = new URL('../ext/lib/term-bank-parser.wasm', import.meta.url);
    const wasmBytes = await readFile(wasmPath);
    if (wasmBytes.length === 0) { throw new Error(`Generated term-bank WASM is empty: ${wasmPath.pathname}`); }
    setTermBankWasmModule(await WebAssembly.compile(wasmBytes));
});

/** @typedef {{expression: string, reading: string, definitionTags: string, rules: string, score: number, glossary: unknown[], sequence: number|null, termTags: string}} OracleRow */

const scalarStringArbitrary = fc.array(
    fc.oneof(
        fc.string({maxLength: 1}),
        fc.constantFrom('"', '\\', '\n', '\r', '\t', '\u0000', '日', '𠮷', '🙂', '\u2028', '\ufeff'),
    ),
    {maxLength: 18},
).map((parts) => parts.join(''));

const glossaryValueArbitrary = fc.jsonValue({maxDepth: 3});
const glossaryArbitrary = fc.array(glossaryValueArbitrary, {maxLength: 5});
const rowArbitrary = fc.record({
    expression: scalarStringArbitrary,
    reading: scalarStringArbitrary,
    definitionTags: scalarStringArbitrary,
    rules: scalarStringArbitrary,
    score: fc.oneof(fc.integer({min: -100000, max: 100000}), fc.double({min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true})),
    glossary: glossaryArbitrary,
    sequence: fc.integer({min: 0, max: 1000000}),
    termTags: scalarStringArbitrary,
});
const rowsArbitrary = /** @type {fc.Arbitrary<OracleRow[]>} */ (/** @type {unknown} */ (fc.array(rowArbitrary, {minLength: 1, maxLength: 8})));

/**
 * @param {OracleRow[]} rows
 * @param {number} chunkSize
 * @returns {Promise<OracleRow[]>}
 */
async function parseRows(rows, chunkSize) {
    const source = JSON.stringify(rows.map(({expression, reading, definitionTags, rules, score, glossary, sequence, termTags}) => [
        expression, reading, definitionTags, rules, score, glossary, sequence, termTags,
    ]));
    /** @type {OracleRow[]} */
    const chunks = [];
    await parseTermBankWithWasmChunks(encoder.encode(source), 3, (chunk) => {
        chunks.push(...chunk.map((row) => ({
            expression: row.expression,
            reading: row.reading,
            definitionTags: row.definitionTags,
            rules: row.rules,
            score: row.score,
            glossary: JSON.parse(row.glossaryJson),
            sequence: row.sequence,
            termTags: row.termTags,
        })));
    }, chunkSize);
    return chunks;
}

/**
 * @param {unknown} actual
 * @param {unknown} oracle
 */
function assertDifferential(actual, oracle) {
    expect(actual).toStrictEqual(oracle);
}

describe('format-3 term-bank WASM differential fuzzing', () => {
    test(`matches JSON source oracle across row chunk boundaries (seed ${fuzzSeed}, runs ${fuzzRuns})`, async () => {
        const typedRowsArbitrary = /** @type {fc.Arbitrary<unknown>} */ (/** @type {unknown} */ (rowsArbitrary));
        await fc.assert(fc.asyncProperty(typedRowsArbitrary, async (value) => {
            const rows = /** @type {OracleRow[]} */ (value);
            const source = JSON.stringify(rows.map(({expression, reading, definitionTags, rules, score, glossary, sequence, termTags}) => [
                expression, reading, definitionTags, rules, score, glossary, sequence, termTags,
            ]));
            const sourceRows = /** @type {Array<[string, string, string, string, number, unknown[], number, string]>} */ (JSON.parse(source));
            const oracle = sourceRows.map(([expression, reading, definitionTags, rules, score, glossary, sequence, termTags]) => ({
                expression,
                reading,
                definitionTags,
                rules,
                score,
                glossary,
                sequence,
                termTags,
            }));
            for (const chunkSize of [1, 3, 8]) {
                assertDifferential(await parseRows(oracle, chunkSize), oracle);
            }
        }), {
            numRuns: fuzzRuns,
            seed: fuzzSeed,
            ...(fuzzPath ? {path: fuzzPath} : {}),
        });
    });

    test.each([
        ['truncated JSON', '[['],
        ['wrong row shape', '[["expression"]]'],
        ['non-numeric score', '[["expression","reading","","","not-a-number",[],0,""]]'],
        ['fractional sequence', '[["expression","reading","","",0,[],1.5,""]]'],
    ])('requires rejection of %s input', async (_label, source) => {
        await expect(parseTermBankWithWasmChunks(encoder.encode(source), 3, () => {}, 1)).rejects.toThrow();
    });
});
