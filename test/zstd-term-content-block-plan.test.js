/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {readFile} from 'node:fs/promises';
import {afterAll, beforeAll, describe, expect, test} from 'vitest';
import {
    beginCompressWrappedTermContentZstdSpansBatch,
    compressWrappedTermContentZstd,
    compressWrappedTermContentZstdSpans,
    compressWrappedTermContentZstdSpansBatch,
    initializeTermContentZstd,
    TermContentCompressionPool,
} from '../ext/js/dictionary/zstd-term-content.js';

const originalFetch = globalThis.fetch;

beforeAll(async () => {
    globalThis.fetch = async (input, init) => {
        const resource = new URL(String(input));
        if (resource.protocol !== 'file:') { return await originalFetch(input, init); }
        return new Response(await readFile(resource), {headers: {'Content-Type': 'application/wasm'}});
    };
    await initializeTermContentZstd();
});
afterAll(() => { globalThis.fetch = originalFetch; });

class CodecWorker {
    constructor() {
        /** @type {Array<(event: MessageEvent<unknown>) => void>} */
        this.listeners = [];
        this.callCount = 0;
    }

    /**
     * @param {string} type
     * @param {(event: MessageEvent<unknown>) => void} listener
     */
    addEventListener(type, listener) {
        if (type === 'message') { this.listeners.push(listener); }
    }

    /**
     * @param {Record<string, unknown>} message
     * @param {Transferable[]} transfer
     */
    postMessage(message, transfer) {
        ++this.callCount;
        const data = structuredClone(message, {transfer});
        const result = compressWrappedTermContentZstdSpans(
            /** @type {Uint8Array} */ (data.source),
            /** @type {Uint32Array} */ (data.sourceOffsets),
            /** @type {Uint32Array} */ (data.sourceLengths),
            /** @type {number} */ (data.contentBytes),
            /** @type {string|null} */ (data.dictName),
        );
        queueMicrotask(() => {
            for (const listener of this.listeners) {
                listener(/** @type {MessageEvent<unknown>} */ ({data: {type: 'source-consumed', id: data.id}}));
                listener(/** @type {MessageEvent<unknown>} */ ({data: {id: data.id, compressed: result.bytes.buffer}}));
            }
        });
    }

    terminate() {}
}

const malformedSinglePlans = [
    {name: 'missing start', offsets: [0], lengths: [4], starts: [1, 1]},
    {name: 'missing final span', offsets: [0], lengths: [4], starts: [0, 0]},
    {name: 'out-of-range final span', offsets: [0], lengths: [4], starts: [0, 2]},
    {name: 'missing boundary', offsets: [0], lengths: [4], starts: [0]},
    {name: 'extra boundary', offsets: [0], lengths: [4], starts: [0, 1, 1]},
    {name: 'mismatched source columns', offsets: [0, 4], lengths: [4], starts: [0, 2]},
];

describe('shared span block-plan validation', () => {
    test.each(malformedSinglePlans)('both single-block entrypoints reject $name through their completion promises', async ({offsets, lengths, starts}) => {
        const args = /** @type {const} */ ([
            new Uint8Array(new SharedArrayBuffer(8)),
            new Uint32Array(offsets),
            new Uint32Array(lengths),
            new Uint32Array(starts),
            Uint32Array.of(4),
            'jmdict',
        ]);
        // The begin API must still return both barriers rather than throwing.
        const operation = beginCompressWrappedTermContentZstdSpansBatch(...args);
        await expect(operation.completion).rejects.toThrow('block plan is invalid');
        await expect(operation.sourceConsumed).rejects.toThrow('block plan is invalid');
        await expect(compressWrappedTermContentZstdSpansBatch(...args)).rejects.toThrow('block plan is invalid');
    });

    test.each([
        ...malformedSinglePlans.map((plan) => ({...plan, blocks: [4], error: 'block plan is invalid'})),
        {name: 'zero blocks', offsets: [], lengths: [], starts: [0], blocks: [], error: 'block plan is invalid'},
        {name: 'incomplete partition', offsets: [0, 4], lengths: [4, 4], starts: [0, 1, 1], blocks: [4, 4], error: 'block plan is invalid'},
        {name: 'descending interior boundary', offsets: [0, 2], lengths: [2, 2], starts: [0, 1, 0, 2], blocks: [2, 0, 2], error: 'block span is invalid'},
        {name: 'out-of-range interior boundary', offsets: [0, 2], lengths: [2, 2], starts: [0, 3, 2], blocks: [2, 2], error: 'block span is invalid'},
    ])('pooled compression rejects $name before dispatch', ({offsets, lengths, starts, blocks, error}) => {
        const worker = new CodecWorker();
        const pool = new TermContentCompressionPool(/** @type {Worker[]} */ (/** @type {unknown} */ ([worker])));
        try {
            expect(() => pool.beginCompressWrappedSpans(
                new Uint8Array(new SharedArrayBuffer(8)),
                new Uint32Array(offsets),
                new Uint32Array(lengths),
                new Uint32Array(starts),
                new Uint32Array(blocks),
                'jmdict',
            )).toThrow(error);
            expect(worker.callCount).toBe(0);
        } finally { pool.close(); }
    });

    test.each([1, 2])('valid %i-block plans preserve packed frames and source acknowledgement', async (blockCount) => {
        const source = new Uint8Array(new SharedArrayBuffer(1024), 7, 512);
        for (let i = 0; i < source.length; ++i) { source[i] = (i % 79) + 32; }
        const offsets = Uint32Array.of(3, 23, 110, 219);
        const lengths = Uint32Array.of(13, 67, 101, 203);
        const starts = blockCount === 1 ? Uint32Array.of(0, 4) : Uint32Array.of(0, 2, 4);
        const blockLengths = blockCount === 1 ? Uint32Array.of(384) : Uint32Array.of(80, 304);
        const expected = Array.from(blockLengths, (size, block) => {
            const packed = new Uint8Array(size);
            let cursor = 0;
            for (let i = starts[block]; i < starts[block + 1]; ++i) {
                packed.set(source.subarray(offsets[i], offsets[i] + lengths[i]), cursor);
                cursor += lengths[i];
            }
            return compressWrappedTermContentZstd(packed, 'jmdict').bytes;
        });
        const workers = [new CodecWorker(), new CodecWorker()];
        const pool = new TermContentCompressionPool(/** @type {Worker[]} */ (/** @type {unknown} */ (workers)));
        try {
            const pooled = pool.beginCompressWrappedSpans(source, offsets, lengths, starts, blockLengths, 'jmdict');
            await expect(pooled.sourceConsumed).resolves.toBeUndefined();
            await expect(pooled.completion).resolves.toMatchObject({chunks: expected, wrapped: true});
            if (blockCount === 1) {
                const single = beginCompressWrappedTermContentZstdSpansBatch(source, offsets, lengths, starts, blockLengths, 'jmdict');
                await expect(single.sourceConsumed).resolves.toBeUndefined();
                await expect(single.completion).resolves.toMatchObject({chunks: expected, wrapped: true});
            }
            expect([...offsets]).toEqual([3, 23, 110, 219]);
            expect([...lengths]).toEqual([13, 67, 101, 203]);
        } finally { pool.close(); }
    });
});
