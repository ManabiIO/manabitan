/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, test, vi} from 'vitest';
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js';

/** @typedef {Parameters<TermRecordOpfsStore['_encodeAndAppendArtifactChunkForState']>[1]} ArtifactChunk */
/** @typedef {NonNullable<ArtifactChunk['resolvedContentReferences']>} ContentReferences */

/**
 * @param {ContentReferences} references
 * @param {number} [rowCount]
 * @returns {ArtifactChunk}
 */
function createChunk(references, rowCount = references.uniqueIndexList.length) {
    const expressionBytes = new TextEncoder().encode('term');
    return {
        dictionary: 'Content reference validation',
        rowCount,
        expressionBytesList: new Array(rowCount).fill(expressionBytes),
        readingBytesList: new Array(rowCount).fill(expressionBytes),
        readingEqualsExpressionList: new Uint8Array(rowCount).fill(1),
        scoreList: new Int32Array(rowCount),
        sequenceList: new Int32Array(rowCount).fill(-1),
        resolvedContentReferences: references,
    };
}

/**
 * @param {TermRecordOpfsStore} store
 * @param {ArtifactChunk} chunk
 * @param {Float64Array} [offsets]
 * @param {Uint32Array} [lengths]
 * @param {Parameters<TermRecordOpfsStore['_encodeAndAppendArtifactChunkForState']>[7]} [prepared]
 * @returns {ReturnType<TermRecordOpfsStore['_encodeAndAppendArtifactChunkForState']>}
 */
function encode(store, chunk, offsets = new Float64Array(0), lengths = new Uint32Array(0), prepared = null) {
    return store._encodeAndAppendArtifactChunkForState(
        /** @type {Parameters<TermRecordOpfsStore['_encodeAndAppendArtifactChunkForState']>[0]} */ ({}),
        chunk,
        1,
        offsets,
        lengths,
        null,
        'raw',
        prepared,
    );
}

/** @returns {TermRecordOpfsStore} */
function createValidationStore() {
    const store = new TermRecordOpfsStore();
    vi.spyOn(store, '_encodeArtifactChunkRecords').mockImplementation(async (_chunk, _offsets, _lengths, _plan, _lookupBytes, base) => ({
        contentOffsetBase: base ?? 0,
        lookupIndexBytes: new Uint8Array(0),
        recordFields: new Uint8Array(0),
        recordFieldsFormat: 1,
        validationMs: 0,
        recordFieldEncodeMs: 0,
        lookupIndexEncodeMs: 0,
    }));
    vi.spyOn(store, '_appendEncodedChunk').mockResolvedValue();
    return store;
}

describe('resolved content reference validation runs', () => {
    test.each(['ordinary', 'aliased', 'shared'])('matches exact record and lookup bytes with %s columns', async (kind) => {
        const buffer = kind === 'shared' ? new SharedArrayBuffer(16) : new ArrayBuffer(16);
        const offsets = new Float64Array(buffer);
        offsets.set([16, 32]);
        const lengths = kind === 'aliased' ? new Uint32Array(buffer, 0, 2) : Uint32Array.of(7, 9);
        const references = {
            uniqueIndexList: Uint32Array.from({length: 120}, (_, index) => Math.floor(index / 2) % 2),
            offsets,
            lengths,
        };
        const chunk = createChunk(references);
        const resolvedStore = new TermRecordOpfsStore();
        const resolvedAppend = vi.spyOn(resolvedStore, '_appendEncodedChunk').mockResolvedValue();
        await encode(resolvedStore, chunk);
        const plainStore = new TermRecordOpfsStore();
        const plainAppend = vi.spyOn(plainStore, '_appendEncodedChunk').mockResolvedValue();
        await encode(
            plainStore,
            {...chunk, resolvedContentReferences: void 0},
            Float64Array.from(references.uniqueIndexList, (index) => offsets[index]),
            Uint32Array.from(references.uniqueIndexList, (index) => lengths[index]),
        );
        expect(resolvedAppend.mock.calls).toStrictEqual(plainAppend.mock.calls);
    });

    test('keeps the exact uint32 offset boundary and sentinel spans when aliases cross a split', async () => {
        const references = {
            uniqueIndexList: Uint32Array.of(0, 0, 1, 1, 2, 2, 3, 3),
            offsets: Float64Array.of(16, 16 + 0xfffffffe, 16 + 0xffffffff, -1),
            lengths: Uint32Array.of(7, 9, 11, 0),
        };
        const chunk = createChunk(references);
        const resolvedStore = new TermRecordOpfsStore();
        const resolvedAppend = vi.spyOn(resolvedStore, '_appendEncodedChunk').mockResolvedValue();
        await encode(resolvedStore, chunk);
        const plainStore = new TermRecordOpfsStore();
        const plainAppend = vi.spyOn(plainStore, '_appendEncodedChunk').mockResolvedValue();
        await encode(
            plainStore,
            {...chunk, resolvedContentReferences: void 0},
            Float64Array.from(references.uniqueIndexList, (index) => references.offsets[index]),
            Uint32Array.from(references.uniqueIndexList, (index) => references.lengths[index]),
        );
        expect(resolvedAppend.mock.calls).toStrictEqual(plainAppend.mock.calls);
        expect(resolvedAppend.mock.calls.map((args) => [args[2], args[4]])).toStrictEqual([[4, 16], [4, 16 + 0xffffffff]]);
    });

    test.each([
        [Uint32Array.of(0, 0, 2, 2), Float64Array.of(16, 32), Uint32Array.of(7, 9), 'Invalid resolved term content reference index: 2'],
        [Uint32Array.of(0, 0, 1, 1), Float64Array.of(16, Number.NaN), Uint32Array.of(7, 9), 'Invalid term content offset: NaN'],
        [Uint32Array.of(0, 0, 1, 1), Float64Array.of(16, 32), Uint32Array.of(7, 0xffffffff), 'Invalid term content length: 4294967295'],
        [Uint32Array.of(0, 0, 1, 1), Float64Array.of(16, 32), Uint32Array.of(7), 'Invalid resolved term content reference index: 1'],
        [Uint32Array.of(0, 0, 1), Float64Array.of(16, 32), Uint32Array.of(7, 9), 'Invalid term content offset: undefined'],
    ])('rejects malformed columns after valid aliases (%#)', async (uniqueIndexList, offsets, lengths, message) => {
        const store = createValidationStore();
        await expect(encode(store, createChunk({uniqueIndexList, offsets, lengths}, 4))).rejects.toThrow(message);
        expect(store._appendEncodedChunk).not.toHaveBeenCalled();
    });

    test.each(['offset', 'length', 'index', 'replace'])('revalidates %s changes after an awaited append at the row limit', async (change) => {
        const references = {
            uniqueIndexList: new Uint32Array(30_001),
            offsets: Float64Array.of(16),
            lengths: Uint32Array.of(7),
        };
        const chunk = createChunk(references);
        const store = createValidationStore();
        vi.mocked(store._appendEncodedChunk).mockImplementationOnce(async () => {
            switch (change) {
                case 'offset': references.offsets[0] = Number.NaN; break;
                case 'length': references.lengths[0] = 0xffffffff; break;
                case 'index': references.uniqueIndexList[30_000] = 1; break;
                case 'replace': chunk.resolvedContentReferences = {...references, offsets: Float64Array.of(Number.NaN)}; break;
            }
        });
        await expect(encode(store, chunk)).rejects.toThrow(/Invalid (term content|resolved term content reference)/);
        expect(store._encodeArtifactChunkRecords).toHaveBeenCalledTimes(1);
        expect(vi.mocked(store._encodeArtifactChunkRecords).mock.calls[0][0].rowCount).toBe(30_000);
    });

    test('keeps consecutive aliases in a complete prepared whole-chunk index beyond the row limit', async () => {
        const chunk = createChunk({uniqueIndexList: new Uint32Array(30_001), offsets: Float64Array.of(16), lengths: Uint32Array.of(7)});
        const store = createValidationStore();
        const expressionBytes = chunk.expressionBytesList[0];
        const prepared = store.prepareArtifactChunkLookupIndexes({
            ...chunk,
            termRecordPreinternedPlan: {
                stringLengths: Uint16Array.of(expressionBytes.byteLength),
                stringOffsets: Uint32Array.of(0),
                stringsBuffer: expressionBytes,
                expressionIndexes: new Uint32Array(chunk.rowCount),
                readingIndexes: new Uint32Array(chunk.rowCount),
            },
        });
        expect(prepared?.indexes.size).toBe(1);
        await encode(store, chunk, void 0, void 0, prepared?.indexes);
        expect(store._encodeArtifactChunkRecords).toHaveBeenCalledTimes(1);
        expect(vi.mocked(store._encodeArtifactChunkRecords).mock.calls[0][0].rowCount).toBe(30_001);
    });

    test.each(['fixed', 'fixed-length', 'invalid-fixed-base'])('preserves %s overrides over invalid referenced lengths', async (mode) => {
        const chunk = createChunk({uniqueIndexList: Uint32Array.of(0, 0), offsets: Float64Array.of(16), lengths: Uint32Array.of(0xffffffff)});
        chunk.fixedContentLength = 7;
        if (mode !== 'fixed-length') { chunk.fixedContentOffsetBase = mode === 'fixed' ? 32 : -1; }
        const store = createValidationStore();
        await encode(store, chunk);
        expect(vi.mocked(store._encodeArtifactChunkRecords).mock.calls[0][5]).toBe(mode === 'fixed' ? 32 : 16);
    });

    test('retains per-row reads for accessor-backed references', async () => {
        const offsets = Float64Array.of(16);
        const references = {uniqueIndexList: Uint32Array.of(0, 0), offsets, lengths: Uint32Array.of(7)};
        let reads = 0;
        Object.defineProperty(references, 'offsets', {
            get() {
                if (++reads > 2) { offsets[0] = Number.NaN; }
                return offsets;
            },
        });
        const store = createValidationStore();
        await expect(encode(store, createChunk(references))).rejects.toThrow('Invalid term content offset: NaN');
        expect(store._appendEncodedChunk).not.toHaveBeenCalled();
    });

    test.each(['own', 'inherited'])('retains per-row reads for an %s fixed-length accessor', async (kind) => {
        const chunk = createChunk({uniqueIndexList: Uint32Array.of(0, 0), offsets: Float64Array.of(16), lengths: Uint32Array.of(7)});
        let reads = 0;
        const target = kind === 'own' ? chunk : {};
        Object.defineProperty(target, 'fixedContentLength', {
            get() { return ++reads > 2 ? 0xffffffff : 7; },
        });
        if (kind === 'inherited') { Object.setPrototypeOf(chunk, target); }
        await expect(encode(createValidationStore(), chunk)).rejects.toThrow('Invalid term content length: 4294967295');
    });

    test('retains per-row bounds checks for a typed column with an own length accessor', async () => {
        const offsets = Float64Array.of(16);
        let reads = 0;
        Object.defineProperty(offsets, 'length', {get() { return ++reads > 1 ? 0 : 1; }});
        const references = {uniqueIndexList: Uint32Array.of(0, 0), offsets, lengths: Uint32Array.of(7)};
        await expect(encode(createValidationStore(), createChunk(references))).rejects.toThrow('Invalid resolved term content reference index: 0');
    });

    test('does not invoke a typed column buffer accessor when selecting the fallback', async () => {
        const offsets = Float64Array.of(16);
        Object.defineProperty(offsets, 'buffer', {get() { throw new Error('Unexpected buffer getter'); }});
        const references = {uniqueIndexList: Uint32Array.of(0, 0), offsets, lengths: Uint32Array.of(7)};
        const store = createValidationStore();
        await encode(store, createChunk(references));
        expect(store._appendEncodedChunk).toHaveBeenCalledTimes(1);
    });

    test('retains per-row validation for untyped external reference columns', async () => {
        const offsets = [16];
        const indexes = [0, 0];
        Object.defineProperty(indexes, 1, {
            get() { offsets[0] = Number.NaN; return 0; },
        });
        const references = /** @type {ContentReferences} */ (/** @type {unknown} */ ({uniqueIndexList: indexes, offsets, lengths: [7]}));
        await expect(encode(createValidationStore(), createChunk(references))).rejects.toThrow('Invalid term content offset: NaN');
    });
});
