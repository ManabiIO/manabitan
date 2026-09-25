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

    test.each([512, 4096, 1024 * 1024])('reserves generic spans only after measured selection (%i)', async (blockTargetBytes) => {
        const {source, offsets, lengths, expected} = makeSource();
        const late = new TermContentBlockStore(new TermContentOpfsStore(), {blockTargetBytes, minInputBytes: 0});
        const early = new TermContentBlockStore(new TermContentOpfsStore(), {blockTargetBytes, minInputBytes: 0});
        late.setCompressionExperiments(options);
        early.setCompressionExperiments(options);
        const lateSession = late.beginImportSession();
        const earlySession = early.beginImportSession();
        expect(earlySession.tryBeginAppendSpans('generic', source, offsets, lengths, null)).toBeNull();
        const first = await earlySession.appendSpans('generic', source, offsets, lengths, null);
        const firstLate = await lateSession.appendSpans('generic', source, offsets, lengths, null);
        expect(first).not.toBeNull();
        expect(firstLate).not.toBeNull();
        expect(earlySession.tryBeginAppendSpans('other', source, offsets, lengths, null)).toBeNull();
        const operation = earlySession.tryBeginAppendSpans('generic', source, offsets, lengths, null);
        if (operation === null) { throw new Error('Expected prior measured selection to enable reservations'); }
        expect(operation.initialSelection).toBe(false);
        const a = await lateSession.appendSpans('generic', source, offsets, lengths, null);
        const b = await operation.completion;
        await operation.sourceConsumed;
        if (a === null) { throw new Error('Expected compressed late append'); }
        expect(b.initialSelectionSavingsMiss).toBe(false);
        expect(b.compressedBytes).toBe(a.compressedBytes);
        expect(b.uncompressedBytes).toBe(a.uncompressedBytes);
        expect(b.contentDictName).toBe(a.contentDictName);
        early.setCompressionExperiments({experimentalGenericSpanCompression: false});
        expect(earlySession.tryBeginAppendSpans('generic', source, offsets, lengths, null)).toBeNull();
        early.setCompressionExperiments(options);
        const next = early.beginImportSession();
        expect(next.tryBeginAppendSpans('generic', source, offsets, lengths, null)).toBeNull();
        source.fill(255);
        early.clearCache();
        late.clearCache();
        for (let i = 0; i < expected.length; ++i) {
            expect(await early.read(b.contentOffsets[i], b.contentLengths[i], b.contentDictName)).toEqual(expected[i]);
            expect(await late.read(a.contentOffsets[i], a.contentLengths[i], a.contentDictName)).toEqual(expected[i]);
        }
        earlySession.close();
        lateSession.close();
        next.close();
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
        store.setCompressionExperiments(options);
        store.setCompressionExperiments();
        expect(store.getDiagnostics().compressionExperiments).toMatchObject({experimentalGenericSpanCompression: false});
    });

    test('rejects out-of-range spans before producing a compressed frame', () => {
        const {source} = makeSource();
        expect(() => prepareWrappedTermContentZstdSpans(source, new Uint32Array([source.length - 1]), new Uint32Array([2]), 2, null, options)).toThrow();
    });
});
