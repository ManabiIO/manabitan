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
        if (!value.startsWith('/lib/')) { return await originalFetch(input, init); }
        const bytes = await readFile(new URL(`../ext${value}`, import.meta.url));
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
