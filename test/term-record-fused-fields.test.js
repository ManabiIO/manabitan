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

import {afterEach, describe, expect, test, vi} from 'vitest';
import {createArtifactTermRecordChunkWithResolvedContent, TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js';
import {createPreparedTermLookupIndexForRecordFields, getSynchronousWholePreparedTermLookupIndex} from '../ext/js/dictionary/term-record-field-preparation.js';

/** @typedef {Parameters<TermRecordOpfsStore['_encodeAndAppendArtifactChunkForState']>[1]} ArtifactChunk */
/** @typedef {NonNullable<ArtifactChunk['resolvedContentReferences']>} References */
/** @typedef {ReturnType<typeof fixture>} Fixture */

/**
 * @param {boolean} branded
 * @param {number} [count=128]
 */
function fixture(branded, count = 128) {
    const store = new TermRecordOpfsStore();
    const term = new TextEncoder().encode('term');
    const plan = {
        stringLengths: Uint16Array.of(term.byteLength),
        stringOffsets: Uint32Array.of(0),
        stringsBuffer: term,
        expressionIndexes: new Uint32Array(count),
        readingIndexes: new Uint32Array(count),
    };
    const rowData = {
        dictionary: 'Fused field oracle',
        rowCount: count,
        expressionBytesList: new Array(count).fill(term),
        readingBytesList: new Array(count).fill(term),
        readingEqualsExpressionList: new Uint8Array(count).fill(1),
        scoreList: Int32Array.from({length: count}, (_, i) => i % 7 - 3),
        sequenceList: new Int32Array(count).fill(-1),
    };
    const generated = store.prepareArtifactChunkLookupIndexes({...rowData, termRecordPreinternedPlan: plan});
    if (generated === null) { throw new Error('Missing prepared oracle index'); }
    /** @type {Map<string, import('../ext/js/dictionary/term-lookup-index-preparation.js').PreparedTermLookupIndex>} */
    const prepared = new Map();
    for (const [key, entry] of generated.indexes) {
        prepared.set(key, branded ?
            createPreparedTermLookupIndexForRecordFields(entry.bytes, entry.preinternedPlan, entry.routeFilter) :
            {...entry});
    }
    const uniqueCount = Math.ceil(count / 2);
    /** @type {ArtifactChunk & {resolvedContentReferences: References}} */
    const chunk = createArtifactTermRecordChunkWithResolvedContent(
        rowData,
        Uint32Array.from({length: count}, (_, i) => Math.floor(i / 2)),
        Float64Array.from({length: uniqueCount}, (_, i) => 2 ** 40 + i * 19),
        Uint32Array.from({length: uniqueCount}, (_, i) => i % 31),
        prepared,
    );
    return {store, chunk, prepared, references: chunk.resolvedContentReferences};
}

/**
 * The append hook retains the actual encoders. It validates and serializes
 * each complete sidecar envelope without creating OPFS files.
 * @param {Fixture} value
 */
async function capture(value) {
    const {store, chunk, prepared} = value;
    /** @type {Array<{firstId: number, count: number, base: number, fields: Uint8Array, payload: Uint8Array, envelope: Uint8Array}>} */
    const appends = [];
    vi.spyOn(store, '_appendEncodedChunk').mockImplementation(async (...args) => {
        const [, firstId, count, , base = 0, payload, fields, format = 1] = args;
        if (!(payload instanceof Uint8Array) || !(fields instanceof Uint8Array)) {
            throw new Error('Missing encoded oracle bytes');
        }
        appends.push({
            firstId, count, base,
            fields: new Uint8Array(fields),
            payload: new Uint8Array(payload),
            envelope: store._createLookupIndexChunk(firstId, count, base, payload, fields, format),
        });
    });
    /** @type {{name: string, message: string}|null} */
    let error = null;
    /** @type {Awaited<ReturnType<TermRecordOpfsStore['_encodeAndAppendArtifactChunkForState']>>|null} */
    let metrics = null;
    try {
        metrics = await store._encodeAndAppendArtifactChunkForState(
            /** @type {Parameters<TermRecordOpfsStore['_encodeAndAppendArtifactChunkForState']>[0]} */ ({}),
            chunk,
            1,
            [],
            [],
            null,
            'raw',
            prepared,
        );
    } catch (cause) {
        if (!(cause instanceof Error)) { throw cause; }
        error = {name: cause.name, message: cause.message};
    }
    return {appends, error, fusedRows: metrics?.fusedRecordFieldRows ?? 0};
}

/**
 * @param {Fixture} value
 * @param {string} kind
 */
function changeValues(value, kind) {
    const {chunk, references} = value;
    switch (kind) {
        case 'sentinel': references.offsets.fill(-1); break;
        case 'empty': references.lengths.fill(0); break;
        case 'max-delta': references.offsets.fill(0); references.offsets[1] = 0xfffffffe; break;
        case 'wide-delta': references.offsets[0] = 0; references.offsets[1] = 0xffffffff; break;
        case 'large-length': references.lengths[0] = 65535; break;
        case 'distinct-scores': chunk.scoreList = Int32Array.from({length: chunk.rowCount}, (_, i) => i); break;
        case 'fractional-score': chunk.scoreList = new Float64Array(chunk.rowCount).fill(0.25); break;
        case 'negative-zero-score': chunk.scoreList = new Float64Array(chunk.rowCount).fill(-0); break;
        case 'non-finite-score': chunk.scoreList = new Float64Array(chunk.rowCount).fill(Number.NaN); break;
        case 'bad-index': references.uniqueIndexList[chunk.rowCount - 1] = references.offsets.length; break;
        case 'bad-offset': references.offsets[references.offsets.length - 1] = Number.NaN; break;
        case 'fractional-offset': references.offsets[references.offsets.length - 1] = 0.5; break;
        case 'negative-offset': references.offsets[references.offsets.length - 1] = -2; break;
        case 'unsafe-offset': references.offsets[references.offsets.length - 1] = Number.MAX_SAFE_INTEGER + 1; break;
        case 'bad-length': references.lengths[references.lengths.length - 1] = 0xffffffff; break;
        case 'bad-after-wide': references.offsets[0] = 0; references.offsets[1] = 0xffffffff; references.offsets[2] = Number.NaN; break;
        case 'bad-after-legacy': references.lengths[0] = 65535; references.offsets[references.offsets.length - 1] = Number.NaN; break;
    }
}

afterEach(() => { vi.restoreAllMocks(); });

describe('fused whole-run content bounds and compact record fields', () => {
    test.each([128, 30001])('preserves complete envelope bytes and admits all %i rows', async (count) => {
        const baseline = await capture(fixture(false, count));
        const candidate = await capture(fixture(true, count));
        expect(candidate.error).toBeNull();
        expect(candidate.appends).toEqual(baseline.appends);
        expect(candidate.fusedRows).toBe(count);
        expect(candidate.appends).toHaveLength(1);
    });

    test.each(['sentinel', 'empty', 'max-delta'])('retains the compact result for %s spans', async (kind) => {
        const baseline = fixture(false);
        const candidate = fixture(true);
        changeValues(baseline, kind);
        changeValues(candidate, kind);
        const expected = await capture(baseline);
        const actual = await capture(candidate);
        expect(actual.error).toBeNull();
        expect(actual.appends).toEqual(expected.appends);
        expect(actual.fusedRows).toBe(128);
    });

    test.each(['wide-delta', 'large-length', 'distinct-scores', 'fractional-score', 'negative-zero-score', 'non-finite-score'])('preserves the complete fallback envelopes for %s', async (kind) => {
        const baseline = fixture(false);
        const candidate = fixture(true);
        changeValues(baseline, kind);
        changeValues(candidate, kind);
        const expected = await capture(baseline);
        const actual = await capture(candidate);
        expect(actual.error).toEqual(expected.error);
        expect(actual.appends).toEqual(expected.appends);
        expect(actual.fusedRows).toBe(0);
    });

    test.each(['bad-index', 'bad-offset', 'fractional-offset', 'negative-offset', 'unsafe-offset', 'bad-length', 'bad-after-wide', 'bad-after-legacy'])('preserves errors and any preceding split append for %s', async (kind) => {
        const baseline = fixture(false);
        const candidate = fixture(true);
        changeValues(baseline, kind);
        changeValues(candidate, kind);
        const expected = await capture(baseline);
        const actual = await capture(candidate);
        expect(expected.error).not.toBeNull();
        expect(actual.error).toEqual(expected.error);
        expect(actual.appends).toEqual(expected.appends);
        expect(actual.fusedRows).toBe(0);
    });

    test.each(['offsets', 'lengths', 'scores'])('retains the shared %s path', async (kind) => {
        const baseline = fixture(false);
        const candidate = fixture(true);
        for (const value of [baseline, candidate]) {
            if (kind === 'offsets') {
                const shared = new Float64Array(new SharedArrayBuffer(value.references.offsets.byteLength));
                shared.set(value.references.offsets);
                value.references.offsets = shared;
            } else if (kind === 'lengths') {
                const shared = new Uint32Array(new SharedArrayBuffer(value.references.lengths.byteLength));
                shared.set(value.references.lengths);
                value.references.lengths = shared;
            } else {
                const shared = new Int32Array(new SharedArrayBuffer(value.chunk.rowCount * Int32Array.BYTES_PER_ELEMENT));
                shared.set(value.chunk.scoreList);
                value.chunk.scoreList = shared;
            }
        }
        const expected = await capture(baseline);
        const actual = await capture(candidate);
        expect(actual.error).toEqual(expected.error);
        expect(actual.appends).toEqual(expected.appends);
        expect(actual.fusedRows).toBe(0);
    });

    test.each(['chunk-encoder', 'field-encoder'])('retains the %s override', async (kind) => {
        const baseline = fixture(false);
        const candidate = fixture(true);
        for (const value of [baseline, candidate]) {
            if (kind === 'chunk-encoder') {
                const original = value.store._encodeArtifactChunkRecords.bind(value.store);
                vi.spyOn(value.store, '_encodeArtifactChunkRecords').mockImplementation(async (...args) => {
                    value.references.offsets[0] = 27;
                    return await original(...args);
                });
            } else {
                const original = value.store._encodeArtifactRecordFields.bind(value.store);
                vi.spyOn(value.store, '_encodeArtifactRecordFields').mockImplementation((...args) => {
                    value.references.offsets[0] = 27;
                    return original(...args);
                });
            }
        }
        const expected = await capture(baseline);
        const actual = await capture(candidate);
        expect(actual.error).toEqual(expected.error);
        expect(actual.appends).toEqual(expected.appends);
        expect(actual.fusedRows).toBe(0);
    });

    test('keeps the encoded snapshot across the existing await boundary', async () => {
        const baseline = fixture(false);
        const candidate = fixture(true);
        const mutation = Promise.resolve().then(() => {
            baseline.references.offsets[0] = 27;
            candidate.references.offsets[0] = 27;
        });
        const expectedPromise = capture(baseline);
        const actualPromise = capture(candidate);
        await mutation;
        const [expected, actual] = await Promise.all([expectedPromise, actualPromise]);
        expect(actual.error).toBeNull();
        expect(actual.appends).toEqual(expected.appends);
        expect(actual.fusedRows).toBe(128);
    });

    test.each(['throwing-fixed-base', 'changing-fixed-base', 'map-get', 'entry-plan', 'offset-proxy', 'score-proxy', 'buffer-prototype'])('preserves reads and errors for the %s fallback', async (kind) => {
        const baseline = fixture(false);
        const candidate = fixture(true);
        const reads = [0, 0];
        for (const [position, value] of [baseline, candidate].entries()) {
            if (kind === 'throwing-fixed-base' || kind === 'changing-fixed-base') {
                Object.defineProperty(value.chunk, 'fixedContentOffsetBase', {get() {
                    ++reads[position];
                    if (kind === 'throwing-fixed-base') { throw new Error('Fixed base getter'); }
                    if (reads[position] === 2) { value.references.offsets[0] = Number.NaN; }
                    return void 0;
                }});
            } else if (kind === 'map-get') {
                const original = value.prepared.get.bind(value.prepared);
                value.prepared.get = (key) => {
                    ++reads[position];
                    if (reads[position] === 2) { value.references.offsets[0] = 27; }
                    return original(key);
                };
            } else if (kind === 'entry-plan') {
                const entry = value.prepared.get(`0:${value.chunk.rowCount}`);
                if (typeof entry === 'undefined') { throw new Error('Missing oracle entry'); }
                const plan = entry.preinternedPlan;
                Object.defineProperty(entry, 'preinternedPlan', {get() {
                    ++reads[position];
                    if (reads[position] === 3) { value.references.offsets[0] = 27; }
                    return plan;
                }});
            } else if (kind === 'offset-proxy') {
                value.references.offsets = new Proxy(value.references.offsets, {
                    get(target, key) { ++reads[position]; return Reflect.get(target, key, target); },
                    getPrototypeOf(target) { ++reads[position]; return Reflect.getPrototypeOf(target); },
                });
            } else if (kind === 'score-proxy') {
                value.chunk.scoreList = new Proxy(value.chunk.scoreList, {
                    get(target, key) { ++reads[position]; return Reflect.get(target, key, target); },
                    getPrototypeOf(target) { ++reads[position]; return Reflect.getPrototypeOf(target); },
                });
            } else {
                Object.setPrototypeOf(value.references.offsets.buffer, new Proxy(ArrayBuffer.prototype, {
                    getPrototypeOf(target) { ++reads[position]; return Reflect.getPrototypeOf(target); },
                }));
            }
        }
        const expected = await capture(baseline);
        const actual = await capture(candidate);
        expect(actual.error).toEqual(expected.error);
        expect(actual.appends).toEqual(expected.appends);
        expect(actual.fusedRows).toBe(0);
        expect(reads[1]).toBe(reads[0]);
    });

    test('requires original entry identity and data bindings without invoking proxy traps', () => {
        const value = fixture(true);
        const key = `0:${value.chunk.rowCount}`;
        const entry = value.prepared.get(key);
        if (typeof entry === 'undefined') { throw new Error('Missing oracle entry'); }
        expect(getSynchronousWholePreparedTermLookupIndex(value.prepared, 128)?.prepared).toBe(entry);
        let traps = 0;
        const wrapped = new Proxy(entry, {getOwnPropertyDescriptor() { ++traps; throw new Error('Unexpected descriptor trap'); }});
        expect(getSynchronousWholePreparedTermLookupIndex(new Map([[key, wrapped]]), 128)).toBeNull();
        const mapProxy = new Proxy(value.prepared, {getPrototypeOf() { ++traps; throw new Error('Unexpected prototype trap'); }});
        expect(getSynchronousWholePreparedTermLookupIndex(mapProxy, 128)).toBeNull();
        Object.defineProperty(entry, 'bytes', {get() { ++traps; throw new Error('Unexpected bytes getter'); }});
        expect(getSynchronousWholePreparedTermLookupIndex(value.prepared, 128)).toBeNull();
        expect(traps).toBe(0);
    });
});
