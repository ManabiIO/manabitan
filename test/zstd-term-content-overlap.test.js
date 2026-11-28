/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test} from 'vitest';
import {TermContentCompressionPool} from '../ext/js/dictionary/zstd-term-content.js';

class ControlledWorker {
    constructor() {
        /** @type {Map<string, Array<(event: MessageEvent<unknown>) => void>>} */
        this.listeners = new Map();
        /** @type {Record<string, unknown>[]} */
        this.calls = [];
        this.terminateCount = 0;
    }

    /**
     * @param {string} type
     * @param {(event: MessageEvent<unknown>) => void} listener
     */
    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    /** @param {Record<string, unknown>} message */
    postMessage(message) { this.calls.push(message); }

    /**
     * @param {number} call
     * @param {Record<string, unknown>} response
     */
    reply(call, response) {
        for (const listener of this.listeners.get('message') ?? []) {
            listener(/** @type {MessageEvent<unknown>} */ ({data: {id: this.calls[call].id, ...response}}));
        }
    }

    terminate() { ++this.terminateCount; }
}

/** @returns {{pool: TermContentCompressionPool, workers: ControlledWorker[]}} */
function createPool() {
    const workers = Array.from({length: 4}, () => new ControlledWorker());
    const pool = new TermContentCompressionPool(/** @type {Worker[]} */ (/** @type {unknown} */ (workers)));
    return {pool, workers};
}

/**
 * @param {TermContentCompressionPool} pool
 * @param {number[]} values
 * @returns {ReturnType<TermContentCompressionPool['beginCompressWrappedSpans']>}
 */
function begin(pool, values) {
    const source = new Uint8Array(new SharedArrayBuffer(values.length));
    source.set(values);
    return pool.beginCompressWrappedSpans(
        source,
        Uint32Array.from(values, (_, index) => index),
        new Uint32Array(values.length).fill(1),
        Uint32Array.from({length: values.length + 1}, (_, index) => index),
        new Uint32Array(values.length).fill(1),
        'jmdict',
    );
}

/**
 * @param {Record<string, unknown>} message
 * @returns {number}
 */
function inputByte(message) {
    const source = /** @type {Uint8Array} */ (message.source);
    const offsets = /** @type {Uint32Array} */ (message.sourceOffsets);
    return source[offsets[0]];
}

/**
 * @param {ControlledWorker} worker
 * @param {number} call
 * @param {number} [envelopeMs]
 */
function complete(worker, call, envelopeMs = 1) {
    worker.reply(call, {compressed: Uint8Array.of(inputByte(worker.calls[call])).buffer, envelopeMs});
}

describe('shared compression across adjacent groups', () => {
    test('uses the fourth worker while preserving each group output order', async () => {
        const {pool, workers} = createPool();
        const first = begin(pool, [11, 12, 13]);
        const second = begin(pool, [21, 22]);
        try {
            expect(workers.map(({calls}) => calls.map(inputByte))).toEqual([[11, 22], [12], [13], [21]]);
            complete(workers[0], 1);
            complete(workers[3], 0);
            const secondResult = await second.completion;
            expect(secondResult.chunks.map((bytes) => bytes[0])).toEqual([21, 22]);
            await second.sourceConsumed;
            complete(workers[2], 0);
            complete(workers[1], 0);
            complete(workers[0], 0);
            const firstResult = await first.completion;
            expect(firstResult.chunks.map((bytes) => bytes[0])).toEqual([11, 12, 13]);
            await first.sourceConsumed;
        } finally { pool.close(); }
    });

    test('accounts envelope work using the assigned workers across a wraparound', async () => {
        const {pool, workers} = createPool();
        try {
            const first = begin(pool, [11, 12, 13]);
            for (const worker of workers.slice(0, 3)) { complete(worker, 0); }
            await first.completion;
            const second = begin(pool, [1, 2, 3, 4, 5, 6]);
            expect(workers.map(({calls}) => calls.map(inputByte))).toEqual([[11, 2, 6], [12, 3], [13, 4], [1, 5]]);
            const costs = [10, 2, 3, 4, 20, 5];
            for (let workerIndex = workers.length - 1; workerIndex >= 0; --workerIndex) {
                const worker = workers[workerIndex];
                for (let call = worker.calls.length - 1; call >= (workerIndex === 3 ? 0 : 1); --call) {
                    complete(worker, call, costs[inputByte(worker.calls[call]) - 1]);
                }
            }
            const result = await second.completion;
            expect(result.chunks.map((bytes) => bytes[0])).toEqual([1, 2, 3, 4, 5, 6]);
            expect(result.envelopeMs).toBe(30);
        } finally { pool.close(); }
    });

    test('a rejected plan neither dispatches work nor consumes assignment positions', async () => {
        const {pool, workers} = createPool();
        try {
            const first = begin(pool, [11, 12, 13]);
            expect(() => pool.beginCompressWrappedSpans(
                new Uint8Array(new SharedArrayBuffer(1)),
                Uint32Array.of(0),
                Uint32Array.of(1),
                Uint32Array.of(1, 1),
                Uint32Array.of(1),
                'jmdict',
            )).toThrow('block plan is invalid');
            const second = begin(pool, [21, 22]);
            expect(workers.map(({calls}) => calls.map(inputByte))).toEqual([[11, 22], [12], [13], [21]]);
            for (const worker of workers) {
                for (let call = 0; call < worker.calls.length; ++call) { complete(worker, call); }
            }
            await Promise.all([first.completion, second.completion]);
        } finally { pool.close(); }
    });

    test('drains a failed group without mixing its leases or errors with its successor', async () => {
        const {pool, workers} = createPool();
        const first = begin(pool, [11, 12, 13]);
        const second = begin(pool, [21, 22]);
        let firstSettled = false;
        void first.completion.finally(() => { firstSettled = true; }).catch(() => {});
        try {
            workers[1].reply(0, {error: 'first group failed'});
            complete(workers[0], 1);
            complete(workers[3], 0);
            await second.sourceConsumed;
            expect((await second.completion).chunks.map((bytes) => bytes[0])).toEqual([21, 22]);
            expect(firstSettled).toBe(false);
            complete(workers[2], 0);
            complete(workers[0], 0);
            await expect(first.sourceConsumed).rejects.toThrow('first group failed');
            await expect(first.completion).rejects.toThrow('first group failed');
        } finally { pool.close(); }
    });

    test('closing the pool terminates every outstanding group and source lease', async () => {
        const {pool, workers} = createPool();
        const first = begin(pool, [11, 12, 13]);
        const second = begin(pool, [21, 22]);
        pool.close();
        for (const operation of [first, second]) {
            await expect(operation.sourceConsumed).rejects.toThrow('pool closed');
            await expect(operation.completion).rejects.toThrow('pool closed');
        }
        expect(workers.map(({terminateCount}) => terminateCount)).toEqual([1, 1, 1, 1]);
        expect(Reflect.get(pool, '_pending').size).toBe(0);
    });
});
