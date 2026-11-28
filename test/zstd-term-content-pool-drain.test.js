/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test, vi} from 'vitest';
import {TermContentCompressionPool} from '../ext/js/dictionary/zstd-term-content.js';

class ControlledWorker {
    constructor() {
        /** @type {Map<string, Array<(event: MessageEvent<unknown>) => void>>} */
        this.listeners = new Map();
        /** @type {Record<string, unknown>[]} */
        this.calls = [];
        /** @type {Record<string, unknown>[]} */
        this.packets = [];
        this.throwOnDispatch = false;
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
    postMessage(message) {
        this.packets.push(message);
        this.calls.push(...(Array.isArray(message.messages) ? /** @type {Array<Record<string, unknown>>} */ (message.messages) : [message]));
        if (this.throwOnDispatch) { throw new Error('injected dispatch failure'); }
    }

    /**
     * @param {number} call
     * @param {Record<string, unknown>} response
     */
    reply(call, response) {
        for (const listener of this.listeners.get('message') ?? []) {
            listener(/** @type {MessageEvent<unknown>} */ ({data: {id: this.calls[call].id, ...response}}));
        }
    }

    /** @param {Array<{call: number, response: Record<string, unknown>}>} replies */
    replyBatch(replies) {
        const responses = replies.map(({call, response}) => ({id: this.calls[call].id, ...response}));
        for (const listener of this.listeners.get('message') ?? []) {
            listener(/** @type {MessageEvent<unknown>} */ ({data: {responses}}));
        }
    }

    terminate() { ++this.terminateCount; }
}

/**
 * @param {ControlledWorker[]} workers
 * @returns {{pool: TermContentCompressionPool, source: Uint8Array, operation: ReturnType<TermContentCompressionPool['beginCompressWrappedSpans']>}}
 */
function start(workers) {
    const pool = new TermContentCompressionPool(/** @type {Worker[]} */ (/** @type {unknown} */ (workers)));
    const source = new Uint8Array(new SharedArrayBuffer(8)).fill(7);
    const operation = pool.beginCompressWrappedSpans(
        source,
        Uint32Array.of(0, 4),
        Uint32Array.of(4, 4),
        Uint32Array.of(0, 1, 2),
        Uint32Array.of(4, 4),
        'jmdict',
    );
    return {pool, source, operation};
}

/** @returns {Promise<void>} */
async function flush() {
    await new Promise((resolve) => { setTimeout(resolve, 0); });
}

describe('shared compression job draining', () => {
    test.each(['error-reply', 'invalid-reply', 'dispatch-throw'])(
        '%s cannot settle a batch while another worker still reads its source',
        async (failure) => {
            const workers = [new ControlledWorker(), new ControlledWorker()];
            workers[0].throwOnDispatch = failure === 'dispatch-throw';
            const {pool, source, operation} = start(workers);
            let sourceSettled = false;
            let completionSettled = false;
            void operation.sourceConsumed.finally(() => { sourceSettled = true; }).catch(() => {});
            void operation.completion.finally(() => { completionSettled = true; }).catch(() => {});
            try {
                if (failure !== 'dispatch-throw') {
                    workers[0].reply(0, failure === 'error-reply' ? {error: 'injected worker failure'} : {compressed: []});
                }
                await flush();
                expect(workers[1].calls).toHaveLength(1);
                expect(sourceSettled).toBe(false);
                expect(completionSettled).toBe(false);
                expect([...source]).toEqual(new Array(8).fill(7));

                workers[1].reply(0, {type: 'source-consumed'});
                await expect(operation.sourceConsumed).rejects.toThrow();
                expect(completionSettled).toBe(false);
                source.fill(0); // A failed source lease is now fully drained.
                workers[1].reply(0, {compressed: Uint8Array.of(2).buffer});
                await expect(operation.completion).rejects.toThrow();
                expect(Reflect.get(pool, '_pending').size).toBe(0);
            } finally { pool.close(); }
        },
    );

    test('drains later jobs queued on the same worker', async () => {
        const worker = new ControlledWorker();
        const {pool, operation} = start([worker]);
        let completed = false;
        void operation.completion.finally(() => { completed = true; }).catch(() => {});
        try {
            worker.reply(0, {error: 'first job failed'});
            await flush();
            expect(completed).toBe(false);
            worker.reply(1, {compressed: Uint8Array.of(2).buffer});
            await expect(operation.sourceConsumed).rejects.toThrow('first job failed');
            await expect(operation.completion).rejects.toThrow('first job failed');
        } finally { pool.close(); }
    });

    test('preserves the first rejection observed while draining later failures', async () => {
        const workers = [new ControlledWorker(), new ControlledWorker()];
        const {pool, operation} = start(workers);
        let sourceSettled = false;
        let completionSettled = false;
        void operation.sourceConsumed.finally(() => { sourceSettled = true; }).catch(() => {});
        void operation.completion.finally(() => { completionSettled = true; }).catch(() => {});
        try {
            workers[1].reply(0, {error: 'second job failed first'});
            await flush();
            expect(sourceSettled).toBe(false);
            expect(completionSettled).toBe(false);

            workers[0].reply(0, {error: 'first job failed later'});
            await expect(operation.sourceConsumed).rejects.toThrow('second job failed first');
            await expect(operation.completion).rejects.toThrow('second job failed first');
        } finally { pool.close(); }
    });

    test('acknowledged sources remain reusable before a delayed compression result', async () => {
        const workers = [new ControlledWorker(), new ControlledWorker()];
        const {pool, source, operation} = start(workers);
        let completed = false;
        void operation.completion.finally(() => { completed = true; }).catch(() => {});
        try {
            workers[0].reply(0, {type: 'source-consumed'});
            workers[0].reply(0, {error: 'failure after source consumed'});
            await flush();
            expect(completed).toBe(false);
            workers[1].reply(0, {type: 'source-consumed'});
            await expect(operation.sourceConsumed).resolves.toBeUndefined();
            source.fill(0);
            expect(completed).toBe(false);
            workers[1].reply(0, {compressed: Uint8Array.of(2).buffer});
            await expect(operation.completion).rejects.toThrow('failure after source consumed');
        } finally { pool.close(); }
    });

    test('the existing job timeout terminates an unresponsive reader', async () => {
        vi.useFakeTimers();
        const workers = [new ControlledWorker(), new ControlledWorker()];
        const {pool, operation} = start(workers);
        try {
            workers[0].reply(0, {error: 'first job failed'});
            await vi.advanceTimersByTimeAsync(60_000);
            await expect(operation.sourceConsumed).rejects.toThrow('first job failed');
            await expect(operation.completion).rejects.toThrow('first job failed');
            expect(workers.map(({terminateCount}) => terminateCount)).toEqual([1, 1]);
            expect(Reflect.get(pool, '_pending').size).toBe(0);
        } finally {
            pool.close();
            vi.useRealTimers();
        }
    });

    test('closing the pool drains an outstanding reader instead of hanging', async () => {
        const workers = [new ControlledWorker(), new ControlledWorker()];
        const {pool, operation} = start(workers);
        workers[0].reply(0, {error: 'first job failed'});
        pool.close();
        await expect(operation.sourceConsumed).rejects.toThrow('first job failed');
        await expect(operation.completion).rejects.toThrow('first job failed');
        expect(workers.map(({terminateCount}) => terminateCount)).toEqual([1, 1]);
        expect(Reflect.get(pool, '_pending').size).toBe(0);
    });
    test('dispatch failure rejects every job in one packet and drains peer readers', async () => {
        const workers = [new ControlledWorker(), new ControlledWorker()];
        workers[0].throwOnDispatch = true;
        const pool = new TermContentCompressionPool(/** @type {Worker[]} */ (/** @type {unknown} */ (workers)));
        const operation = pool.beginCompressWrappedSpans(
            new Uint8Array(new SharedArrayBuffer(7)),
            Uint32Array.of(0, 1, 2, 3, 4, 5, 6),
            new Uint32Array(7).fill(1),
            Uint32Array.of(0, 1, 2, 3, 4, 5, 6, 7),
            new Uint32Array(7).fill(1),
            'jmdict',
        );
        let settled = false;
        void operation.completion.finally(() => { settled = true; }).catch(() => {});
        try {
            expect(workers.map(({packets}) => packets.length)).toEqual([1, 1]);
            expect(workers.map(({calls}) => calls.length)).toEqual([4, 3]);
            await flush();
            expect(settled).toBe(false);
            workers[1].replyBatch([2, 0, 1].map((call) => ({call, response: {type: 'source-consumed'}})));
            await expect(operation.sourceConsumed).rejects.toThrow('injected dispatch failure');
            expect(settled).toBe(false);
            workers[1].replyBatch([1, 2, 0].map((call) => ({call, response: {compressed: Uint8Array.of(call).buffer}})));
            await expect(operation.completion).rejects.toThrow('injected dispatch failure');
            expect(Reflect.get(pool, '_pending').size).toBe(0);
        } finally { pool.close(); }
    });

    test('isolates concurrent batches and restores uneven round-robin output order', async () => {
        const workers = Array.from({length: 3}, () => new ControlledWorker());
        const pool = new TermContentCompressionPool(/** @type {Worker[]} */ (/** @type {unknown} */ (workers)));
        const begin = () => pool.beginCompressWrappedSpans(
            new Uint8Array(new SharedArrayBuffer(7)),
            Uint32Array.of(0, 1, 2, 3, 4, 5, 6),
            new Uint32Array(7).fill(1),
            Uint32Array.of(0, 1, 2, 3, 4, 5, 6, 7),
            new Uint32Array(7).fill(1),
            'jmdict',
        );
        const first = begin();
        const second = begin();
        let firstSettled = false;
        void first.completion.then(() => { firstSettled = true; });
        try {
            expect(workers.map(({packets}) => packets.length)).toEqual([2, 2, 2]);
            for (let workerIndex = workers.length - 1; workerIndex >= 0; --workerIndex) {
                const worker = workers[workerIndex];
                const count = worker.calls.length / 2;
                worker.replyBatch(Array.from({length: count}, (_, index) => ({
                    call: count + index,
                    response: {compressed: Uint8Array.of(100 + index * 3 + workerIndex).buffer, envelopeMs: 2},
                })).reverse());
            }
            await expect(second.sourceConsumed).resolves.toBeUndefined();
            const result = await second.completion;
            expect(result.chunks.map((bytes) => bytes[0])).toEqual([100, 101, 102, 103, 104, 105, 106]);
            expect(result.envelopeMs).toBe(6);
            expect(firstSettled).toBe(false);
            for (let workerIndex = 0; workerIndex < workers.length; ++workerIndex) {
                const worker = workers[workerIndex];
                worker.replyBatch(Array.from({length: worker.calls.length / 2}, (_, call) => ({
                    call,
                    response: {compressed: Uint8Array.of(call * 3 + workerIndex).buffer, envelopeMs: 1},
                })));
            }
            await expect(first.sourceConsumed).resolves.toBeUndefined();
            const firstResult = await first.completion;
            expect(firstResult.chunks.map((bytes) => bytes[0])).toEqual([0, 1, 2, 3, 4, 5, 6]);
            expect(firstResult.envelopeMs).toBe(3);
            expect(Reflect.get(pool, '_pending').size).toBe(0);
        } finally { pool.close(); }
    });
});
