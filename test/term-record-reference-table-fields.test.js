/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, describe, expect, test, vi} from 'vitest';
import {snapshotTermBankExperiments} from '../ext/js/dictionary/term-bank-experiments.js';
import {createArtifactTermRecordChunkWithResolvedContent, TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js';

/** @typedef {Parameters<TermRecordOpfsStore['_encodeArtifactRecordFields']>[0]} FieldChunk */

/**
 * @param {number} [count=128]
 * @param {number} [uniqueCount=3]
 * @returns {{rowCount: number, scoreList: Int32Array, resolvedContentReferences: {uniqueIndexList: Uint32Array, offsets: Float64Array, lengths: Uint32Array}}}
 */
function fixture(count = 128, uniqueCount = 3) {
    return createArtifactTermRecordChunkWithResolvedContent(
        {rowCount: count, scoreList: Int32Array.from({length: count}, (_, i) => (i % 5) - 2)},
        Uint32Array.from({length: count}, (_, i) => (i * 7) % uniqueCount),
        Float64Array.from({length: uniqueCount}, (_, i) => 2 ** 40 + i * 23),
        Uint32Array.from({length: uniqueCount}, (_, i) => 10 + i),
    );
}

/**
 * @param {boolean} [enabled=true]
 * @returns {TermRecordOpfsStore}
 */
function encoder(enabled = true) {
    const store = new TermRecordOpfsStore();
    store.setImportExperiments({experimentalReferenceTableFields: enabled});
    Reflect.set(store, '_importSessionActive', true);
    return store;
}

/**
 * @param {FieldChunk} chunk
 * @param {boolean} [enabled=true]
 * @param {number} [base=2 ** 40]
 * @returns {Uint8Array}
 */
function encode(chunk, enabled = true, base = 2 ** 40) {
    return encoder(enabled)._encodeArtifactRecordFields(chunk, [], [], base);
}

/**
 * Independently read the proposed persisted layout, without product getters.
 * @param {Uint8Array} bytes
 * @param {ReturnType<typeof fixture>} chunk
 * @param {number} [base=2 ** 40]
 */
function expectReferences(bytes, chunk, base = 2 ** 40) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const scoreCount = view.getUint32(8, true);
    const uniqueCount = view.getUint32(16, true);
    expect(view.getUint32(0, true)).toBe(0x3446524d);
    expect(view.getUint32(4, true)).toBe(chunk.rowCount);
    expect(view.getUint32(12, true)).toBe(4);
    expect(uniqueCount).toBe(chunk.resolvedContentReferences.offsets.length);
    const tableOffsets = 20 + scoreCount * 4;
    const tableLengths = tableOffsets + uniqueCount * 4;
    const rowKeys = tableLengths + Math.ceil(uniqueCount / 2) * 4;
    const scoreKeys = rowKeys + chunk.rowCount * 2;
    expect(bytes.byteLength).toBe(scoreKeys + chunk.rowCount * 2);
    expect(bytes.byteLength % 4).toBe(0);
    for (let unique = 0; unique < uniqueCount; ++unique) {
        const offset = chunk.resolvedContentReferences.offsets[unique];
        expect(view.getUint32(tableOffsets + unique * 4, true)).toBe(offset === -1 ? 0xffffffff : offset - base);
        expect(view.getUint16(tableLengths + unique * 2, true)).toBe(chunk.resolvedContentReferences.lengths[unique]);
    }
    if (uniqueCount % 2) { expect(view.getUint16(tableLengths + uniqueCount * 2, true)).toBe(0); }
    for (let row = 0; row < chunk.rowCount; ++row) {
        expect(view.getUint16(rowKeys + row * 2, true)).toBe(chunk.resolvedContentReferences.uniqueIndexList[row]);
        const scoreKey = view.getUint16(scoreKeys + row * 2, true);
        expect(scoreKey).toBeLessThan(scoreCount);
        expect(view.getInt32(20 + scoreKey * 4, true)).toBe(chunk.scoreList[row]);
    }
}

afterEach(() => { vi.restoreAllMocks(); });

describe('experimental complete reference-table fields', () => {
    test.each([undefined, false, 0, 1, 'true', {}])('only literal true enables the ephemeral option: %s', (value) => {
        const options = {};
        Reflect.set(options, 'experimentalReferenceTableFields', value);
        expect(snapshotTermBankExperiments(options).experimentalReferenceTableFields).toBe(false);
        const store = encoder();
        store.setImportExperiments(options);
        const chunk = fixture();
        expect(store._encodeArtifactRecordFields(chunk, [], [], 2 ** 40)).toEqual(encode(chunk, false));
    });

    test.each([2, 3])('preserves all %i table entries, row IDs, alias scores and alignment', (uniqueCount) => {
        const chunk = fixture(128, uniqueCount);
        chunk.resolvedContentReferences.offsets[0] = -1;
        chunk.resolvedContentReferences.lengths[1] = 65534;
        const bytes = encode(chunk);
        expect(bytes.byteLength).toBeLessThan(encode(chunk, false).byteLength);
        expectReferences(bytes, chunk);
    });

    test('retains representable unused entries without a row remap or source callback', () => {
        const chunk = fixture();
        chunk.resolvedContentReferences.uniqueIndexList.fill(1);
        const subarray = vi.fn(() => { throw new Error('Caller subarray must not run'); });
        chunk.resolvedContentReferences.uniqueIndexList.subarray = subarray;
        const constructor = vi.fn(() => { throw new Error('Caller species must not run'); });
        const byteOffset = vi.fn(() => { throw new Error('Caller offset getter must not run'); });
        Object.defineProperty(chunk.resolvedContentReferences.uniqueIndexList, 'constructor', {get: constructor});
        Object.defineProperty(chunk.resolvedContentReferences.uniqueIndexList, 'byteOffset', {get: byteOffset});
        expectReferences(encode(chunk), chunk);
        expect(subarray).not.toHaveBeenCalled();
        expect(constructor).not.toHaveBeenCalled();
        expect(byteOffset).not.toHaveBeenCalled();
    });

    test.each([
        ['before base', -2],
        ['negative', -2 - 2 ** 40],
        ['unsafe delta', 0xffffffff],
        ['unsafe integer', Number.MAX_SAFE_INTEGER],
        ['NaN', Number.NaN],
        ['infinite', Number.POSITIVE_INFINITY],
    ])('declines an unused table offset that is %s', (_name, delta) => {
        const chunk = fixture();
        chunk.resolvedContentReferences.uniqueIndexList.fill(0);
        chunk.resolvedContentReferences.offsets[2] = 2 ** 40 + /** @type {number} */ (delta);
        expect(encode(chunk)).toEqual(encode(chunk, false));
    });

    test.each([65535, 65536, 0xffffffff])('declines unused u16 length overflow %i without changing existing fields', (length) => {
        const chunk = fixture();
        chunk.resolvedContentReferences.uniqueIndexList.fill(0);
        chunk.resolvedContentReferences.lengths[2] = length;
        expect(encode(chunk)).toEqual(encode(chunk, false));
    });

    test.each([65535, 65536])('declines reserved or wide reference count %i', (count) => {
        const chunk = fixture(128, count);
        chunk.resolvedContentReferences.uniqueIndexList.fill(0);
        expect(encode(chunk)).toEqual(encode(chunk, false));
    });

    test('requires a strict byte saving and preserves legacy score fallback', () => {
        const dense = fixture(128, 128);
        expect(encode(dense)).toEqual(encode(dense, false));
        const small = fixture(2, 2);
        expect(encode(small)).toEqual(encode(small, false));
        const uniqueScores = fixture();
        uniqueScores.scoreList = Int32Array.from({length: uniqueScores.rowCount}, (_, i) => i);
        expect(encode(uniqueScores)).toEqual(encode(uniqueScores, false));
        expect(encode(uniqueScores).byteLength).toBe(uniqueScores.rowCount * 12);
    });

    test('preserves float64, negative-zero and non-finite score representation', () => {
        const values = [0.5, -0, Number.POSITIVE_INFINITY, Number.NaN];
        const chunk = {...fixture(), scoreList: Float64Array.from({length: 128}, (_, i) => values[i % values.length])};
        expect(encode(chunk)).toEqual(encode(chunk, false));
        expect(encode(chunk).byteLength).toBe(128 * 16);
    });

    test.each(['external', 'proxy', 'references', 'shared', 'score-accessor'])('keeps %s inputs on the existing path', (kind) => {
        let chunk = fixture();
        if (kind === 'external') { chunk = {...chunk}; }
        if (kind === 'proxy') { chunk = new Proxy(chunk, {}); }
        if (kind === 'references') { chunk.resolvedContentReferences = {...chunk.resolvedContentReferences}; }
        if (kind === 'shared') {
            const offsets = new Float64Array(new SharedArrayBuffer(chunk.resolvedContentReferences.offsets.byteLength));
            offsets.set(chunk.resolvedContentReferences.offsets);
            chunk.resolvedContentReferences.offsets = offsets;
        }
        if (kind === 'score-accessor') {
            const scores = chunk.scoreList;
            Object.defineProperty(chunk, 'scoreList', {get: () => scores});
        }
        expect(encode(chunk)).toEqual(encode(chunk, false));
    });

    test('does not persist a successful value witness between calls', () => {
        const chunk = fixture();
        const bytes = encode(chunk);
        const snapshot = Uint8Array.from(bytes);
        chunk.resolvedContentReferences.offsets[1] += 100;
        chunk.resolvedContentReferences.lengths[1] += 7;
        chunk.scoreList.fill(-700);
        expectReferences(encode(chunk), chunk);
        expect(bytes).toEqual(snapshot);
    });

    test('validates a late row key before builtin u16 conversion', () => {
        const chunk = fixture();
        chunk.resolvedContentReferences.uniqueIndexList[127] = 65536;
        expect(() => encode(chunk)).toThrow('Invalid resolved term content reference index');
        expect(() => encode(chunk, false)).toThrow('Invalid resolved term content reference index');
    });

    test('is inactive outside an import and is reset after a session ends', async () => {
        const chunk = fixture();
        const store = new TermRecordOpfsStore();
        store.setImportExperiments({experimentalReferenceTableFields: true});
        expect(store._encodeArtifactRecordFields(chunk, [], [], 2 ** 40)).toEqual(encode(chunk, false));
        await store.beginImportSession();
        expectReferences(store._encodeArtifactRecordFields(chunk, [], [], 2 ** 40), chunk);
        await store.endImportSession();
        await store.beginImportSession();
        expect(store._encodeArtifactRecordFields(chunk, [], [], 2 ** 40)).toEqual(encode(chunk, false));
        await store.endImportSession();
    });
});
