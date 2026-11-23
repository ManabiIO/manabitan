/*
 * Copyright (C) 2026 Manabitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {readFile} from 'node:fs/promises';
import {afterAll, beforeAll, describe, expect, test} from 'vitest';
import {TermContentBlockStore} from '../ext/js/dictionary/term-content-block-store.js';
import {TermContentOpfsStore} from '../ext/js/dictionary/term-content-opfs-store.js';
import {compressWrappedTermContentZstd, finishWrappedTermContentZstdSpans, initializeTermContentZstd, prepareWrappedTermContentZstdSpans} from '../ext/js/dictionary/zstd-term-content.js';

const originalFetch = globalThis.fetch;
const options = {experimentalGenericSpanCompression: true};

beforeAll(async () => {
    // Resolve packaged extension resources in Node. The real compiled Zstd,
    // checksum implementation, block codec and memory-backed store all run.
    globalThis.fetch = async (input, init) => {
        const value = String(input);
        const resource = value.startsWith('/lib/') ?
            new URL(`../ext${value}`, import.meta.url) :
            new URL(value);
        if (resource.protocol !== 'file:') { return await originalFetch(input, init); }
        const bytes = await readFile(resource);
        return new Response(bytes, {headers: {'Content-Type': 'application/wasm'}});
    };
    await initializeTermContentZstd();
});
afterAll(() => { globalThis.fetch = originalFetch; });

/** @returns {{source: Uint8Array, offsets: Uint32Array, lengths: Uint32Array, expected: Uint8Array[], packed: Uint8Array}} */
function makeSource() {
    // Non-zero view offset, odd span boundaries, unused capacity and a gap.
    const source = new Uint8Array(new SharedArrayBuffer(262161), 17, 262144);
    for (let i = 0; i < source.length; ++i) { source[i] = (i % 29) + 40; }
    const offsets = new Uint32Array([3, 12289, 196609, 200001]);
    const lengths = new Uint32Array([8001, 16385, 1233, 32000]);
    const expected = Array.from(offsets, (offset, i) => source.slice(offset, offset + lengths[i]));
    const packed = new Uint8Array(lengths.reduce((sum, length) => sum + length, 0));
    let offset = 0;
    for (const bytes of expected) {
        packed.set(bytes, offset);
        offset += bytes.length;
    }
    return {source, offsets, lengths, expected, packed};
}

describe('generic span compression with the real codec', () => {
    test.each([512, 4096, 1024 * 1024])('matches packed frames and persisted content with a %i-byte block target', async (blockTargetBytes) => {
        const {source, offsets, lengths, expected} = makeSource();
        const baseline = new TermContentBlockStore(new TermContentOpfsStore(), {blockTargetBytes});
        baseline.setCompressionExperiments({experimentalGenericSpanCompression: false});
        const candidate = new TermContentBlockStore(new TermContentOpfsStore(), {blockTargetBytes});
        candidate.setCompressionExperiments(options);
        const a = await baseline.tryAppendSpans(source, offsets, lengths, null, true);
        const b = await candidate.tryAppendSpans(source, offsets, lengths, null, true);
        expect(a).not.toBeNull();
        expect(b).not.toBeNull();
        if (a === null || b === null) { throw new Error('Expected compressed storage'); }
        expect(b.compressedBytes).toBe(a.compressedBytes);
        expect(b.uncompressedBytes).toBe(a.uncompressedBytes);
        expect(b.contentDictName).toBe(a.contentDictName);
        expect(b.contentOffsets).toEqual(a.contentOffsets);
        expect(b.contentLengths).toEqual(a.contentLengths);
        source.fill(0);
        candidate.clearCache();
        const results = await candidate.readDetailedBatch(Array.from(b.contentOffsets, (contentOffset, i) => ({
            contentOffset,
            contentLength: b.contentLengths[i],
            contentDictName: b.contentDictName,
        })));
        for (let i = 0; i < expected.length; ++i) {
            expect(results[i]).toEqual({status: 'ok', bytes: expected[i]});
        }
    });

    test('consumes the shared source before finishing, without changing the frame or checksum', () => {
        const {source, offsets, lengths, packed} = makeSource();
        const baseline = compressWrappedTermContentZstd(packed, null).bytes;
        const prepared = prepareWrappedTermContentZstdSpans(source, offsets, lengths, packed.length, null, options);
        source.fill(255);
        const result = finishWrappedTermContentZstdSpans(prepared);
        expect(result.bytes).toEqual(baseline);
        expect(() => finishWrappedTermContentZstdSpans(prepared)).toThrow();
    });

    test('does not leak generic admission into the next import', () => {
        const {source, offsets, lengths, packed} = makeSource();
        const prepared = prepareWrappedTermContentZstdSpans(source, offsets, lengths, packed.length, null, options);
        finishWrappedTermContentZstdSpans(prepared);
        expect(() => prepareWrappedTermContentZstdSpans(source, offsets, lengths, packed.length, null)).toThrow('unavailable');
        const store = new TermContentBlockStore(new TermContentOpfsStore());
        store.setCompressionExperiments({experimentalGenericSpanCompression: false});
        expect(store.getDiagnostics().compressionExperiments).toMatchObject({experimentalGenericSpanCompression: false});
        store.setCompressionExperiments();
        expect(store.getDiagnostics().compressionExperiments).toMatchObject({experimentalGenericSpanCompression: true});
    });

    test('rejects out-of-range spans before producing a compressed frame', () => {
        const {source} = makeSource();
        expect(() => prepareWrappedTermContentZstdSpans(source, new Uint32Array([source.length - 1]), new Uint32Array([2]), 2, null, options)).toThrow();
    });

    test('reserves generic content only after measured block savings in the same import', async () => {
        const {source, offsets, lengths} = makeSource();
        const store = new TermContentBlockStore(new TermContentOpfsStore(), {minInputBytes: 0});
        const session = store.beginImportSession();

        expect(session.tryBeginAppendSpans('Jitendex', source, offsets, lengths, null)).toBeNull();
        const first = await session.appendSpans('Jitendex', source, offsets, lengths, null);
        expect(first).not.toBeNull();
        expect(session.tryBeginAppendSpans('VNDB', source, offsets, lengths, null)).toBeNull();
        const operation = session.tryBeginAppendSpans('Jitendex', source, offsets, lengths, null);
        if (operation === null) { throw new Error('Expected an established generic block reservation'); }
        expect(operation.initialSelection).toBe(false);
        await expect(operation.completion).resolves.toMatchObject({initialSelectionSavingsMiss: false});

        store.setCompressionExperiments({experimentalGenericSpanCompression: false});
        expect(session.tryBeginAppendSpans('Jitendex', source, offsets, lengths, null)).toBeNull();
        store.setCompressionExperiments(options);
        const ownedOperation = session.tryBeginAppendSpans('Jitendex', Uint8Array.from(source), offsets, lengths, null);
        if (ownedOperation === null) { throw new Error('Expected an owned generic block reservation'); }
        await ownedOperation.completion;
        expect(session.tryBeginAppendSpans('Jitendex', source, Uint32Array.of(0), Uint32Array.of(0), null)).toBeNull();
        expect(() => session.tryBeginAppendSpans('Jitendex', source, Uint32Array.of(source.length - 1), Uint32Array.of(2), null)).toThrow(RangeError);
        session.close();
        expect(() => session.tryBeginAppendSpans('Jitendex', source, offsets, lengths, null)).toThrow('closed');
        expect(store.beginImportSession().tryBeginAppendSpans('Jitendex', source, offsets, lengths, null)).toBeNull();
    });

    test.each([512, 4096, 1024 * 1024].flatMap((blockTargetBytes) => [
        {blockTargetBytes, shared: true, compressionDictName: null},
        {blockTargetBytes, shared: false, compressionDictName: null},
        {blockTargetBytes, shared: false, compressionDictName: 'jmdict'},
    ]))('preserves frames, total storage and content with early references ($blockTargetBytes-byte blocks, shared: $shared, codec: $compressionDictName)', async ({blockTargetBytes, shared, compressionDictName}) => {
        const fixture = makeSource();
        const {offsets, lengths, expected} = fixture;
        const source = shared ? fixture.source : Uint8Array.from(fixture.source);
        const baselineContent = new TermContentOpfsStore();
        const candidateContent = new TermContentOpfsStore();
        const baseline = new TermContentBlockStore(baselineContent, {blockTargetBytes});
        const candidate = new TermContentBlockStore(candidateContent, {blockTargetBytes});
        const a = await baseline.tryAppendSpans(source, offsets, lengths, compressionDictName, true);
        expect(candidate.tryBeginAppendSpans(source, offsets, lengths, compressionDictName)).toBeNull();
        const operation = candidate.tryBeginAppendSpans(source, offsets, lengths, compressionDictName, true);
        if (a === null || operation === null) { throw new Error('Expected generic compressed storage'); }
        const reserved = await operation.storage;
        await operation.sourceConsumed;
        source.fill(0);
        const b = await operation.completion;
        expect(b.compressedBytes).toBe(a.compressedBytes);
        expect(b.uncompressedBytes).toBe(a.uncompressedBytes);
        expect(b.contentDictName).toBe(a.contentDictName);
        expect(b.contentLengths).toEqual(a.contentLengths);
        expect(b.contentOffsets).toEqual(reserved.contentOffsets);
        expect(b.initialSelectionSavingsMiss).toBe(false);
        expect(Reflect.get(candidateContent, '_length')).toBe(Reflect.get(baselineContent, '_length'));

        // Prefix references move physical offsets; every logical definition and
        // the complete compressed frame payload must remain unchanged.
        const payloadBytes = a.compressedBytes;
        const referenceBytes = offsets.length * 20;
        expect(await candidateContent.readSlice(referenceBytes, payloadBytes)).toEqual(await baselineContent.readSlice(0, payloadBytes));
        candidate.clearCache();
        for (let i = 0; i < expected.length; ++i) {
            expect(await candidate.read(b.contentOffsets[i], b.contentLengths[i], b.contentDictName)).toEqual(expected[i]);
        }
    });
});
