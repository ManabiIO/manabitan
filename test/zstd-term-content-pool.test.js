/*
 * Copyright (C) 2026 Manabitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, test} from 'vitest';

import {TermContentCompressionPool} from '../ext/js/dictionary/zstd-term-content.js';

class MockCompressionWorker {
    /** @param {(message: Record<string, unknown>, transfer: Transferable[]) => Record<string, unknown>} respond */
    constructor(respond) {
        this.respond = respond;
        /** @type {Map<string, Set<(event: MessageEvent<unknown>) => void>>} */
        this.listeners = new Map();
        /** @type {Array<{message: Record<string, unknown>, transfer: Transferable[]}>} */
        this.calls = [];
        this.terminateCount = 0;
    }

    /**
     * @param {string} type
     * @param {(event: MessageEvent<unknown>) => void} listener
     */
    addEventListener(type, listener) {
        this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener));
    }

    /**
     * @param {Record<string, unknown>} message
     * @param {Transferable[]} transfer
     */
    postMessage(message, transfer = []) {
        this.calls.push({message, transfer});
        const response = this.respond(message, transfer);
        queueMicrotask(() => {
            for (const listener of this.listeners.get('message') ?? []) {
                listener(/** @type {MessageEvent<unknown>} */ ({data: {id: message.id, ...response}}));
            }
        });
    }

    terminate() { ++this.terminateCount; }
}

describe('TermContentCompressionPool', () => {
    test('dispatches packed blocks across workers and restores source order', async () => {
        const workers = Array.from({length: 3}, () => new MockCompressionWorker((message) => {
            const content = /** @type {Uint8Array} */ (message.content);
            return {
                compressed: Uint8Array.of(content[0] + 100).buffer,
                envelopeMs: 1,
            };
        }));
        const pool = new TermContentCompressionPool(/** @type {Worker[]} */ (/** @type {unknown} */ (workers)));
        const contents = Array.from({length: 8}, (_, index) => Uint8Array.of(index));

        const result = await pool.compressWrapped(contents, 'jmdict');

        expect(result.chunks.map((bytes) => bytes[0])).toStrictEqual([100, 101, 102, 103, 104, 105, 106, 107]);
        expect(result.envelopeMs).toBe(3);
        expect(workers.map(({calls}) => calls.length)).toStrictEqual([3, 3, 2]);
        expect(workers.reduce((sum, {calls}) => sum + calls.reduce((subtotal, {transfer}) => subtotal + transfer.length, 0), 0)).toBe(8);

        pool.close();
        expect(workers.map(({terminateCount}) => terminateCount)).toStrictEqual([1, 1, 1]);
    });

    test('dispatches shared-source spans without changing block order', async () => {
        const workers = Array.from({length: 2}, () => new MockCompressionWorker((message) => {
            return {
                compressed: Array.from(
                    /** @type {Uint32Array} */ (message.blockLengths),
                    (length) => Uint8Array.of(length).buffer,
                ),
            };
        }));
        const pool = new TermContentCompressionPool(/** @type {Worker[]} */ (/** @type {unknown} */ (workers)));
        const source = new Uint8Array(new SharedArrayBuffer(64));
        const sourceOffsets = Uint32Array.of(0, 2, 5, 9, 14, 20, 27, 35);
        const sourceLengths = Uint32Array.of(2, 3, 4, 5, 6, 7, 8, 9);
        const blockStarts = Uint32Array.of(0, 2, 3, 5, 6, 8);
        const blockLengths = Uint32Array.of(5, 4, 11, 7, 17);

        const result = await pool.compressWrappedSpans(
            source,
            sourceOffsets,
            sourceLengths,
            blockStarts,
            blockLengths,
            'jmdict',
        );

        expect(result.chunks.map((bytes) => bytes[0])).toStrictEqual([...blockLengths]);
        expect(workers.map(({calls}) => calls.length)).toStrictEqual([1, 1]);
        for (const worker of workers) {
            for (const {message, transfer} of worker.calls) {
                expect(message.source).toBe(source);
                expect(transfer).toHaveLength(4);
                expect(/** @type {Uint32Array} */ (message.sourceOffsets).length).toBe(
                    /** @type {Uint32Array} */ (message.sourceLengths).length,
                );
                const starts = /** @type {Uint32Array} */ (message.blockStartIndexes);
                const lengths = /** @type {Uint32Array} */ (message.blockLengths);
                expect(starts).toHaveLength(lengths.length + 1);
                expect(starts[0]).toBe(0);
                expect(starts.at(-1)).toBe(/** @type {Uint32Array} */ (message.sourceOffsets).length);
            }
        }

        pool.close();
    });

    test('does not transfer a backing buffer shared by multiple inputs', async () => {
        const worker = new MockCompressionWorker((message) => ({
            compressed: Uint8Array.from(/** @type {Uint8Array} */ (message.content)).buffer,
        }));
        const pool = new TermContentCompressionPool(/** @type {Worker[]} */ (/** @type {unknown} */ ([worker])));
        const buffer = Uint8Array.of(1, 2, 3, 4).buffer;

        const result = await pool.compress([new Uint8Array(buffer, 0, 2), new Uint8Array(buffer, 2, 2)], null);

        expect(result.map((bytes) => [...bytes])).toStrictEqual([[1, 2], [3, 4]]);
        expect(worker.calls.map(({transfer}) => transfer.length)).toStrictEqual([0, 0]);

        pool.close();
    });

    test('rejects an invalid worker response', async () => {
        const worker = new MockCompressionWorker(() => ({compressed: []}));
        const pool = new TermContentCompressionPool(/** @type {Worker[]} */ (/** @type {unknown} */ ([worker])));

        await expect(pool.compress([Uint8Array.of(1), Uint8Array.of(2)], null)).rejects.toThrow(
            'returned invalid bytes',
        );

        pool.close();
    });

    test('rejects an invalid batched span response', async () => {
        const worker = new MockCompressionWorker(() => ({compressed: [new ArrayBuffer(1), []]}));
        const pool = new TermContentCompressionPool(/** @type {Worker[]} */ (/** @type {unknown} */ ([worker])));

        await expect(pool.compressWrappedSpans(
            new Uint8Array(new SharedArrayBuffer(4)),
            Uint32Array.of(0, 1),
            Uint32Array.of(1, 1),
            Uint32Array.of(0, 1, 2),
            Uint32Array.of(1, 1),
            'jmdict',
        )).rejects.toThrow('returned invalid batch bytes');

        pool.close();
    });

    test('rejects invalid span partitions before dispatch', async () => {
        const worker = new MockCompressionWorker(() => ({compressed: new ArrayBuffer(0)}));
        const pool = new TermContentCompressionPool(/** @type {Worker[]} */ (/** @type {unknown} */ ([worker])));

        await expect(pool.compressWrappedSpans(
            new Uint8Array(new SharedArrayBuffer(4)),
            Uint32Array.of(0),
            Uint32Array.of(1),
            Uint32Array.of(1, 1),
            Uint32Array.of(1),
            'jmdict',
        )).rejects.toThrow('block plan is invalid');
        expect(worker.calls).toHaveLength(0);

        await expect(pool.compressWrappedSpans(
            new Uint8Array(new SharedArrayBuffer(4)),
            Uint32Array.of(0, 1),
            Uint32Array.of(1, 1),
            Uint32Array.of(0, 1, 0, 2),
            Uint32Array.of(1, 1, 2),
            'jmdict',
        )).rejects.toThrow('block span is invalid');
        expect(worker.calls).toHaveLength(0);

        pool.close();
    });
});
