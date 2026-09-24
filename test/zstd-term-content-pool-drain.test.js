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

    test.each([false, true])('preserves the first observed failure after draining, acknowledged=%s', async (acknowledged) => {
        const workers = [new ControlledWorker(), new ControlledWorker()];
        const {pool, operation} = start(workers);
        let sourceSettled = false;
        let completionSettled = false;
        void operation.sourceConsumed.finally(() => { sourceSettled = true; }).catch(() => {});
        void operation.completion.finally(() => { completionSettled = true; }).catch(() => {});
        try {
            if (acknowledged) {
                for (const worker of workers) { worker.reply(0, {type: 'source-consumed'}); }
                await expect(operation.sourceConsumed).resolves.toBeUndefined();
            }
            workers[1].reply(0, {error: 'higher-index job failed first'});
            await flush();
            expect(sourceSettled).toBe(acknowledged);
            expect(completionSettled).toBe(false);
            workers[0].reply(0, {error: 'lower-index job failed later'});
            if (!acknowledged) {
                await expect(operation.sourceConsumed).rejects.toThrow('higher-index job failed first');
            }
            await expect(operation.completion).rejects.toThrow('higher-index job failed first');
            expect(Reflect.get(pool, '_pending').size).toBe(0);
        } finally { pool.close(); }
    });

    test('preserves the first observed failure independently for each barrier', async () => {
        const workers = [new ControlledWorker(), new ControlledWorker()];
        const {pool, operation} = start(workers);
        let sourceSettled = false;
        let completionSettled = false;
        void operation.sourceConsumed.finally(() => { sourceSettled = true; }).catch(() => {});
        void operation.completion.finally(() => { completionSettled = true; }).catch(() => {});
        try {
            workers[1].reply(0, {type: 'source-consumed'});
            workers[1].reply(0, {error: 'first completion failure'});
            await flush();
            expect(sourceSettled).toBe(false);
            expect(completionSettled).toBe(false);
            workers[0].reply(0, {error: 'first source failure'});
            await expect(operation.sourceConsumed).rejects.toThrow('first source failure');
            await expect(operation.completion).rejects.toThrow('first completion failure');
            expect(Reflect.get(pool, '_pending').size).toBe(0);
        } finally { pool.close(); }
    });
});
