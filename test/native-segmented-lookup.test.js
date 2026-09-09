/*
 * Copyright (C) 2026 Manabitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {beforeAll, describe, expect, test, vi} from 'vitest';
import {hashTermKeyBytes} from '../ext/js/dictionary/term-key-hash.js';
import {hasCompletePreparedTermLookupIndexes, prepareTermLookupIndexesFromPreinternedPlan} from '../ext/js/dictionary/term-lookup-index-preparation.js';
import {copyWasmBackedColumnChunk, parseTermBankWithWasmColumnChunks, setTermBankWasmModule} from '../ext/js/dictionary/term-bank-wasm-parser.js';

/** @typedef {Parameters<Parameters<typeof parseTermBankWithWasmColumnChunks>[2]>[0] & {preparedLookupIndexes?: Map<string, import('../ext/js/dictionary/term-lookup-index-preparation.js').PreparedTermLookupIndex>}} ColumnChunk */
/** @typedef {ReturnType<typeof copyWasmBackedColumnChunk>} StableChunk */
const encoder = new TextEncoder();

beforeAll(async () => {
    const bytes = await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url));
    setTermBankWasmModule(await WebAssembly.compile(bytes));
});

/**
 * Keep each input bank within the existing fused parser's capacity estimate.
 * @param {number} count
 * @param {number} unique
 * @param {boolean} [escaped]
 * @param {boolean} [boundaries]
 * @returns {Uint8Array[]}
 */
function makeSources(count, unique, escaped = false, boundaries = false) {
    const sources = [];
    for (let start = 0; start < count; start += 10000) {
        const rows = Array.from({length: Math.min(10000, count - start)}, (_, local) => {
            const row = start + local;
            const term = row % unique;
            let expression = `${escaped ? 'escaped\\' : '漢字😀/'}${term}`;
            if (boundaries) {
                if (row % 3 === 0) { expression = 'key-70e457ae-82f4bb35'; }
                if (row % 3 === 1) { expression = 'key-9893ec3a-fdbb0e51'; }
                if (row === count - 1) { expression = 'x'.repeat(65534); }
            }
            return [
                expression,
                row % 5 === 0 ? '' : `かな/${term}`,
                '',
                '',
                row % 85 - 42,
                [`definition-${row % 101}`],
                row % 7 === 0 ? -1 : row % 53,
                '',
            ];
        });
        sources.push(encoder.encode(JSON.stringify(rows)));
    }
    return sources;
}

/**
 * @param {Uint8Array[]} sources
 * @param {Parameters<typeof parseTermBankWithWasmColumnChunks>[4]} [options]
 * @param {number} [chunkSize]
 * @param {number} [version]
 * @returns {Promise<StableChunk[]>}
 */
async function parse(sources, options = {}, chunkSize = 262144, version = 3) {
    /** @type {StableChunk[]} */
    const chunks = [];
    await parseTermBankWithWasmColumnChunks(sources, version, (chunk) => {
        chunks.push(copyWasmBackedColumnChunk(chunk));
    }, chunkSize, {
        emitContentSlab: true,
        emitTokenBinaryContent: true,
        emitTermByteLists: false,
        prepareLookupIndexes: true,
        ...options,
    });
    return chunks;
}

/**
 * Compare all persisted bytes and row/key mappings, including re-hashing the
 * strings independently instead of trusting the candidate's cached hashes.
 * @param {StableChunk} chunk
 */
function compareWithJavascript(chunk) {
    const native = chunk.preparedLookupIndexes;
    if (!(native instanceof Map)) { throw new Error('Expected native segmented sidecars'); }
    expect(hasCompletePreparedTermLookupIndexes(native, chunk.rowCount)).toBe(true);
    const reference = prepareTermLookupIndexesFromPreinternedPlan(chunk);
    if (reference === null) { throw new Error('Expected JavaScript reference sidecars'); }
    expect([...native.keys()]).toEqual([...reference.indexes.keys()]);
    for (const [key, actual] of native) {
        const expected = reference.indexes.get(key);
        if (expected === void 0) { throw new Error(`Missing reference segment ${key}`); }
        assert.deepEqual(actual.bytes, expected.bytes);
        const plan = actual.preinternedPlan;
        for (const field of ['stringLengths', 'stringOffsets', 'stringsBuffer', 'expressionIndexes', 'readingIndexes']) {
            assert.deepEqual(Reflect.get(plan, field), Reflect.get(expected.preinternedPlan, field));
        }
        if (plan.stringHashes === void 0 || plan.stringOffsets === void 0) { throw new Error('Expected native string metadata'); }
        for (let i = 0; i < plan.stringLengths.length; ++i) {
            /** @type {number} */
            const offset = plan.stringOffsets[i];
            assert.equal(plan.stringHashes[i], hashTermKeyBytes(plan.stringsBuffer.subarray(offset, offset + plan.stringLengths[i])));
        }
        expect(plan.stringsBuffer.buffer).not.toBe(chunk.termRecordPreinternedPlan.stringsBuffer.buffer);
    }
}

describe('native sidecars for format-limited fused plans', () => {
    test.each([
        {rows: 65535, unique: 65535},
        {rows: 70001, unique: 70001},
        {rows: 40001, unique: 40001},
        {rows: 70001, unique: 29},
    ])('matches every JavaScript sidecar byte for $rows rows / $unique terms', async ({rows, unique}) => {
        const [chunk] = await parse(makeSources(rows, unique));
        expect(chunk.rowCount).toBe(rows);
        compareWithJavascript(chunk);
    });

    test('preserves version-one sequence normalization in each segment', async () => {
        const [chunk] = await parse(makeSources(65535, 29), {}, 262144, 1);
        expect(chunk.sequenceList.every((value) => value === -1)).toBe(true);
        compareWithJavascript(chunk);
    });

    test('keeps independently copied segment plans alive across the next parser operation', async () => {
        const [chunk] = await parse(makeSources(70001, 70001));
        const saved = structuredClone(chunk.preparedLookupIndexes);
        await parse(makeSources(80000, 40000));
        assert.deepEqual(chunk.preparedLookupIndexes, saved);
        compareWithJavascript(chunk);
    });

    test('copies each segment plan, not the whole chunk plan, at the worker ownership boundary', async () => {
        /** @type {ColumnChunk|null} */
        let borrowed = null;
        /** @type {StableChunk|null} */
        let owned = null;
        await parseTermBankWithWasmColumnChunks(makeSources(65535, 65535), 3, (chunk) => {
            borrowed = chunk;
            owned = copyWasmBackedColumnChunk(chunk);
        }, 262144, {emitContentSlab: true, emitTokenBinaryContent: true, emitTermByteLists: false, prepareLookupIndexes: true});
        const original = /** @type {ColumnChunk} */ (/** @type {unknown} */ (borrowed));
        const stable = /** @type {StableChunk} */ (/** @type {unknown} */ (owned));
        const plans = original.preparedLookupIndexes;
        if (!(plans instanceof Map)) { throw new Error('Expected prepared plans'); }
        for (const [key, prepared] of plans) {
            const copied = stable.preparedLookupIndexes?.get(key)?.preinternedPlan;
            if (copied === void 0) { throw new Error('Missing copied segment'); }
            expect(copied).not.toBe(stable.termRecordPreinternedPlan);
            expect(copied.expressionIndexes.length).toBe(Number(key.split(':')[1]));
            expect(copied.stringsBuffer.buffer).not.toBe(prepared.preinternedPlan.stringsBuffer.buffer);
            prepared.preinternedPlan.stringsBuffer.fill(0);
            prepared.preinternedPlan.expressionIndexes.fill(0);
        }
        compareWithJavascript(stable);
    });

    test.each([
        {name: 'disabled preparation', options: {prepareLookupIndexes: false}, escaped: false, chunkSize: 262144},
        {name: 'disabled native string plans', options: {useNativeStringPlan: false}, escaped: false, chunkSize: 262144},
        {name: 'escaped string fallback', options: {}, escaped: true, chunkSize: 262144},
        {name: 'multi-chunk fallback', options: {}, escaped: false, chunkSize: 31000},
    ])('retains the existing $name route', async ({options, escaped, chunkSize}) => {
        const chunks = await parse(makeSources(70001, 310, escaped), options, chunkSize);
        expect(chunks.reduce((sum, chunk) => sum + chunk.rowCount, 0)).toBe(70001);
        for (const chunk of chunks) { expect(chunk.preparedLookupIndexes).toBeUndefined(); }
    });

    test('preserves real same-length key-hash collisions, maximum native keys and signed sequences', async () => {
        expect(hashTermKeyBytes(encoder.encode('key-70e457ae-82f4bb35'))).toBe(3528436524);
        expect(hashTermKeyBytes(encoder.encode('key-9893ec3a-fdbb0e51'))).toBe(3528436524);
        const [chunk] = await parse(makeSources(70001, 29, false, true));
        compareWithJavascript(chunk);
        expect([...chunk.preparedLookupIndexes?.values() ?? []].some(
            ({preinternedPlan}) => preinternedPlan.stringLengths.includes(65534),
        )).toBe(true);
    });

    test.each(['allocation', 'encoding'])('retains complete JavaScript fallback after optional native %s failure', async (mode) => {
        const sources = makeSources(65535, 101);
        const [reference] = await parse(sources, {prepareLookupIndexes: false});
        let forcedFailures = 0;
        vi.resetModules();
        const isolated = await import('../ext/js/dictionary/term-bank-wasm-parser.js');
        isolated.setTermBankWasmModule(await WebAssembly.compile(
            await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url)),
        ));
        const instantiate = vi.spyOn(WebAssembly, 'instantiate').mockImplementation(async (module, imports) => {
            if (!(module instanceof WebAssembly.Module)) { throw new TypeError('Expected compiled module'); }
            const instance = new WebAssembly.Instance(module, imports);
            const exports = instance.exports;
            const fused = /** @type {(...args: number[]) => number} */ (exports.parse_and_encode_term_bank_token_binary_dedup);
            const alloc = /** @type {(size: number) => number} */ (exports.wasm_alloc);
            const encode = /** @type {(...args: number[]) => number} */ (exports.encode_term_lookup_index);
            const memory = /** @type {WebAssembly.Memory} */ (exports.memory);
            let parsed = false;
            let allocations = 0;
            let encodings = 0;
            return {exports: {
                ...exports,
                /**
                 * @param {...number} args
                 * @returns {number}
                 */
                parse_and_encode_term_bank_token_binary_dedup(...args) {
                    const result = fused(...args);
                    parsed = true;
                    return result;
                },
                /**
                 * @param {number} size
                 * @returns {number}
                 */
                wasm_alloc(size) {
                    if (parsed && mode === 'allocation' && ++allocations === 2) {
                        // Change memory.buffer after parsing to exercise the
                        // view refresh even when optional preparation fails.
                        memory.grow(1);
                        ++forcedFailures;
                        return 0;
                    }
                    return alloc(size);
                },
                /**
                 * @param {...number} args
                 * @returns {number}
                 */
                encode_term_lookup_index(...args) {
                    if (mode === 'encoding' && ++encodings === 2) {
                        ++forcedFailures;
                        return -1;
                    }
                    return encode(...args);
                },
            }};
        });
        try {
            /** @type {StableChunk[]} */
            const chunks = [];
            await isolated.parseTermBankWithWasmColumnChunks(sources, 3, (chunk) => {
                chunks.push(isolated.copyWasmBackedColumnChunk(chunk));
            }, 262144, {emitContentSlab: true, emitTokenBinaryContent: true, emitTermByteLists: false, prepareLookupIndexes: true});
            expect(forcedFailures).toBe(1);
            expect(chunks).toHaveLength(1);
            const [chunk] = chunks;
            expect(chunk.preparedLookupIndexes).toBeUndefined();
            assert.deepEqual(chunk.termRecordPreinternedPlan, reference.termRecordPreinternedPlan);
            assert.deepEqual(chunk.contentBytesBuffer, reference.contentBytesBuffer);
            assert.deepEqual(chunk.contentMetaList, reference.contentMetaList);
            assert.deepEqual(
                prepareTermLookupIndexesFromPreinternedPlan(chunk)?.indexes,
                prepareTermLookupIndexesFromPreinternedPlan(reference)?.indexes,
            );
        } finally {
            instantiate.mockRestore();
            vi.resetModules();
        }
    });
});
