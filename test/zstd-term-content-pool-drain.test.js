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
        this.calls.push(message);
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
});

/* eslint-disable @stylistic/semi */
/**
 * @param {TermContentCompressionPool} pool
 * @param {number} count
 * @returns {{source: Uint8Array, operation: ReturnType<TermContentCompressionPool['beginCompressWrappedSpans']>}}
 */
function startBlocks(pool, count) {
    const source = new Uint8Array(new SharedArrayBuffer(Math.max(1, count)))
    source.set(Array.from({length: count}, (_, i) => i + 1))
    const operation = pool.beginCompressWrappedSpans(
        source,
        Uint32Array.from({length: count}, (_, i) => i),
        new Uint32Array(count).fill(1),
        Uint32Array.from({length: count + 1}, (_, i) => i),
        new Uint32Array(count).fill(1),
        'jmdict',
    )
    return {source, operation}
}

describe('per-worker final source acknowledgments', () => {
    test.each([1, 2, 3])('marks each batch independently with %i workers and accepts legacy acknowledgments', async (workerCount) => {
        const workers = Array.from({length: workerCount}, () => new ControlledWorker())
        const pool = new TermContentCompressionPool(/** @type {Worker[]} */ (/** @type {unknown} */ (workers)))
        try {
            for (const count of [1, 2, 8, 3]) {
                const starts = workers.map(({calls}) => calls.length)
                const {operation} = startBlocks(pool, count)
                for (let workerIndex = 0; workerIndex < workers.length; ++workerIndex) {
                    const worker = workers[workerIndex]
                    const calls = worker.calls.slice(starts[workerIndex])
                    expect(calls.map(({acknowledgeSourceConsumed}) => acknowledgeSourceConsumed))
                        .toEqual(calls.map((_, index) => index === calls.length - 1))
                    for (let i = 0; i < calls.length; ++i) {
                        // Existing/custom workers may ignore the new request field.
                        worker.reply(starts[workerIndex] + i, {type: 'source-consumed'})
                        worker.reply(starts[workerIndex] + i, {compressed: Uint8Array.of(1).buffer})
                    }
                }
                await expect(operation.sourceConsumed).resolves.toBeUndefined()
                await expect(operation.completion).resolves.toMatchObject({chunks: Array.from({length: count}, () => Uint8Array.of(1))})
            }
        } finally { pool.close() }
    })

    test('keeps the aggregate source barrier early after intermediate completions', async () => {
        const workers = [new ControlledWorker(), new ControlledWorker()]
        const pool = new TermContentCompressionPool(/** @type {Worker[]} */ (/** @type {unknown} */ (workers)))
        const {source, operation} = startBlocks(pool, 5)
        let sourceSettled = false
        let completed = false
        void operation.sourceConsumed.then(() => { sourceSettled = true }).catch(() => {})
        void operation.completion.then(() => { completed = true }).catch(() => {})
        try {
            workers[0].reply(0, {compressed: Uint8Array.of(1).buffer})
            workers[1].reply(0, {compressed: Uint8Array.of(2).buffer})
            workers[0].reply(1, {compressed: Uint8Array.of(3).buffer})
            workers[0].reply(2, {type: 'source-consumed'})
            await flush()
            expect(sourceSettled).toBe(false)
            expect(completed).toBe(false)
            workers[1].reply(1, {type: 'source-consumed'})
            await expect(operation.sourceConsumed).resolves.toBeUndefined()
            source.fill(0)
            expect(completed).toBe(false)
            workers[0].reply(2, {compressed: Uint8Array.of(5).buffer})
            workers[1].reply(1, {compressed: Uint8Array.of(4).buffer})
            expect((await operation.completion).chunks.map((bytes) => bytes[0])).toEqual([1, 2, 3, 4, 5])
        } finally { pool.close() }
    })

    test('preserves a consumed source on an intermediate terminal error and drains the final job', async () => {
        const worker = new ControlledWorker()
        const {pool, operation} = start([worker])
        let completed = false
        void operation.completion.finally(() => { completed = true }).catch(() => {})
        try {
            worker.reply(0, {error: 'failure after suppressed acknowledgment', sourceConsumed: true})
            await flush()
            expect(completed).toBe(false)
            worker.reply(1, {type: 'source-consumed'})
            await expect(operation.sourceConsumed).resolves.toBeUndefined()
            expect(completed).toBe(false)
            worker.reply(1, {compressed: Uint8Array.of(2).buffer})
            await expect(operation.completion).rejects.toThrow('failure after suppressed acknowledgment')
        } finally { pool.close() }
    })

    test('keeps overlapping batches separate while their final results are delayed', async () => {
        const workers = [new ControlledWorker(), new ControlledWorker()]
        const pool = new TermContentCompressionPool(/** @type {Worker[]} */ (/** @type {unknown} */ (workers)))
        const first = startBlocks(pool, 5)
        const second = startBlocks(pool, 3)
        let secondSourceSettled = false
        void second.operation.sourceConsumed.then(() => { secondSourceSettled = true }).catch(() => {})
        try {
            workers[0].reply(0, {compressed: Uint8Array.of(1).buffer})
            workers[0].reply(1, {compressed: Uint8Array.of(1).buffer})
            workers[1].reply(0, {compressed: Uint8Array.of(1).buffer})
            workers[0].reply(2, {type: 'source-consumed'})
            workers[1].reply(1, {type: 'source-consumed'})
            await first.operation.sourceConsumed
            expect(secondSourceSettled).toBe(false)
            workers[0].reply(2, {compressed: Uint8Array.of(1).buffer})
            workers[1].reply(1, {compressed: Uint8Array.of(1).buffer})
            await first.operation.completion
            workers[0].reply(3, {compressed: Uint8Array.of(1).buffer})
            workers[0].reply(4, {type: 'source-consumed'})
            await flush()
            expect(secondSourceSettled).toBe(false)
            workers[1].reply(2, {type: 'source-consumed'})
            await second.operation.sourceConsumed
            workers[0].reply(4, {compressed: Uint8Array.of(1).buffer})
            workers[1].reply(2, {compressed: Uint8Array.of(1).buffer})
            await second.operation.completion
            expect(Reflect.get(pool, '_pending').size).toBe(0)
        } finally { pool.close() }
    })

    test('uses no batch-global acknowledgment state during reentrant custom dispatch', async () => {
        const worker = new ControlledWorker()
        const pool = new TermContentCompressionPool(/** @type {Worker[]} */ (/** @type {unknown} */ ([worker])))
        const nested = /** @type {{value: ReturnType<typeof startBlocks>|null}} */ ({value: null})
        const postMessage = worker.postMessage.bind(worker)
        vi.spyOn(worker, 'postMessage').mockImplementation((message) => {
            postMessage(message)
            if (worker.calls.length === 1) { nested.value = startBlocks(pool, 2) }
        })
        try {
            const first = startBlocks(pool, 3)
            expect(worker.calls.map(({acknowledgeSourceConsumed}) => acknowledgeSourceConsumed)).toEqual([false, false, true, false, true])
            for (let i = 0; i < worker.calls.length; ++i) {
                if (worker.calls[i].acknowledgeSourceConsumed === true) { worker.reply(i, {type: 'source-consumed'}) }
                worker.reply(i, {compressed: Uint8Array.of(1).buffer})
            }
            if (nested.value === null) { throw new Error('Nested batch was not dispatched') }
            await Promise.all([first.operation.sourceConsumed, first.operation.completion, nested.value.operation.sourceConsumed, nested.value.operation.completion])
            expect(Reflect.get(pool, '_pending').size).toBe(0)
        } finally { pool.close() }
    })

    test('rejects both barriers when a worker stops during a suppressed-ack job', async () => {
        const worker = new ControlledWorker()
        const {pool, operation} = start([worker])
        expect(worker.calls[0].acknowledgeSourceConsumed).toBe(false)
        pool.close()
        await expect(operation.sourceConsumed).rejects.toThrow('pool closed')
        await expect(operation.completion).rejects.toThrow('pool closed')
        expect(worker.terminateCount).toBe(1)
    })
})
/* eslint-enable @stylistic/semi */
