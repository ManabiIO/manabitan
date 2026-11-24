/*
 * Copyright (C) 2026 Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {readFile} from 'node:fs/promises';
import {afterAll, beforeAll, describe, expect, test, vi} from 'vitest';
import {decodeRawTermContentCompactBlockReference} from '../ext/js/dictionary/raw-term-content.js';
import {TermContentBlockStore} from '../ext/js/dictionary/term-content-block-store.js';
import {TermContentOpfsStore} from '../ext/js/dictionary/term-content-opfs-store.js';
import {registerOwnedTermContent} from '../ext/js/dictionary/term-content-ownership.js';
import {initializeTermContentZstd} from '../ext/js/dictionary/zstd-term-content.js';

beforeAll(async () => {
    vi.stubGlobal('fetch', async (/** @type {RequestInfo|URL} */ input) => {
        const resource = new URL(String(input));
        if (resource.protocol !== 'file:') { throw new Error('Unexpected codec resource'); }
        return new Response(await readFile(resource), {headers: {'Content-Type': 'application/wasm'}});
    });
    await initializeTermContentZstd();
});

afterAll(() => { vi.unstubAllGlobals(); });

describe('private reservation codec equivalence', () => {
    test.each([0, 2 ** 32 + 11])('preserves native compressed frames, canonical reads and total storage at %s', async (start) => {
        const source = new TextEncoder().encode('日本語の同じ説明を繰り返す。'.repeat(1024));
        registerOwnedTermContent(source);
        const offsets = Uint32Array.of(2, 2500, 8200, 1000);
        const lengths = Uint32Array.of(1800, 3000, 4101, 2731);
        const oldContent = new TermContentOpfsStore();
        const newContent = new TermContentOpfsStore();
        Reflect.set(oldContent, '_length', start);
        Reflect.set(newContent, '_length', start);
        const oldStore = new TermContentBlockStore(oldContent, {blockTargetBytes: 4096});
        const newStore = new TermContentBlockStore(newContent, {blockTargetBytes: 4096});
        const oldResult = await oldStore.tryAppendSpans(source, offsets, lengths, 'jmdict', true);
        const operation = newStore.tryBeginAppendSpans(source, offsets, lengths, 'jmdict', true);
        if (oldResult === null || operation === null) { throw new Error('Expected compressed storage'); }
        const newResult = await operation.completion;
        const oldEnd = /** @type {number} */ (Reflect.get(oldContent, '_length'));
        const newEnd = /** @type {number} */ (Reflect.get(newContent, '_length'));
        expect(newEnd).toBe(oldEnd);
        expect(newResult.compressedBytes).toBe(oldResult.compressedBytes);
        expect(newResult.uncompressedBytes).toBe(oldResult.uncompressedBytes);
        const referenceBytes = lengths.length * 20;
        for (let index = 0; index < lengths.length; ++index) {
            const oldReferenceBytes = await oldContent.readSlice(oldResult.contentOffsets[index], 20);
            const newReferenceBytes = await newContent.readSlice(newResult.contentOffsets[index], 20);
            if (oldReferenceBytes === null || newReferenceBytes === null) { throw new Error('Missing reference'); }
            const oldReference = decodeRawTermContentCompactBlockReference(oldReferenceBytes, lengths[index]);
            const newReference = decodeRawTermContentCompactBlockReference(newReferenceBytes, lengths[index]);
            if (oldReference === null || newReference === null) { throw new Error('Invalid reference'); }
            const prefix = start === 0;
            expect(newReference).toEqual({...oldReference, blockOffset: oldReference.blockOffset + (prefix ? referenceBytes : 0)});
            expect(newResult.contentOffsets[index]).toBe(prefix ? start + index * 20 : oldResult.contentOffsets[index]);
            expect(await newContent.readSlice(newReference.blockOffset, newReference.blockCompressedLength)).toEqual(
                await oldContent.readSlice(oldReference.blockOffset, oldReference.blockCompressedLength),
            );
            const expected = source.slice(offsets[index], offsets[index] + lengths[index]);
            expect(await oldStore.read(oldResult.contentOffsets[index], lengths[index], oldResult.contentDictName)).toEqual(expected);
            expect(await newStore.read(newResult.contentOffsets[index], lengths[index], newResult.contentDictName)).toEqual(expected);
        }
        if (start !== 0) {
            expect(await newContent.readSlice(start, newEnd - start)).toEqual(await oldContent.readSlice(start, oldEnd - start));
        }
    });
});
