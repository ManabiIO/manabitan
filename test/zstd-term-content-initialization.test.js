/*
 * Copyright (C) 2026 Manabitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

const zstd = vi.hoisted(() => ({
    createCCtx: vi.fn(),
    createDCtx: vi.fn(),
    freeCCtx: vi.fn(),
    freeDCtx: vi.fn(),
    init: vi.fn(async () => {}),
    compressUsingDictWithPrefix: vi.fn(),
}));

vi.mock('../ext/lib/zstd-wasm.js', () => ({
    ...zstd,
    compress: vi.fn(),
    compressSpansUsingDictWithPrefix: vi.fn(),
    compressUsingDict: vi.fn(),
    compressUsingDictWithPrefix: zstd.compressUsingDictWithPrefix,
    decompress: vi.fn(),
    decompressUsingDict: vi.fn(),
}));

describe('term content zstd initialization', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    test('does not allocate native contexts before dictionary loading succeeds', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {status: 503})));
        const {initializeTermContentZstd} = await import('../ext/js/dictionary/zstd-term-content.js');

        await expect(initializeTermContentZstd()).rejects.toThrow('503');
        expect(zstd.createCCtx).not.toHaveBeenCalled();
        expect(zstd.createDCtx).not.toHaveBeenCalled();
    });

    test('rejects an empty dictionary before allocating native contexts', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array())));
        const {initializeTermContentZstd} = await import('../ext/js/dictionary/zstd-term-content.js');

        await expect(initializeTermContentZstd()).rejects.toThrow('dictionary is empty');
        expect(zstd.createCCtx).not.toHaveBeenCalled();
        expect(zstd.createDCtx).not.toHaveBeenCalled();
    });

    test('frees a partial allocation and permits a clean retry', async () => {
        zstd.createCCtx.mockReturnValueOnce(11).mockReturnValueOnce(12);
        zstd.createDCtx.mockReturnValueOnce(0).mockReturnValueOnce(22);
        const {initializeTermContentZstd} = await import('../ext/js/dictionary/zstd-term-content.js');

        await expect(initializeTermContentZstd()).rejects.toThrow('decompression context');
        expect(zstd.freeCCtx).toHaveBeenCalledOnce();
        expect(zstd.freeCCtx).toHaveBeenCalledWith(11);

        await expect(initializeTermContentZstd()).resolves.toBeUndefined();
        expect(zstd.createCCtx).toHaveBeenCalledTimes(2);
        expect(zstd.createDCtx).toHaveBeenCalledTimes(2);
        expect(zstd.freeCCtx).toHaveBeenCalledTimes(1);
    });

    test('falls back immediately when compression worker initialization messages cannot be decoded', async () => {
        class MessageErrorCompressionWorker {
            constructor() {
                /** @type {Map<string, Set<(event: unknown) => void>>} */
                this.listeners = new Map();
                queueMicrotask(() => { this._emit('messageerror', {}); });
            }

            /**
             * @param {string} type
             * @param {(event: unknown) => void} listener
             */
            addEventListener(type, listener) {
                this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener));
            }

            /**
             * @param {string} type
             * @param {(event: unknown) => void} listener
             */
            removeEventListener(type, listener) {
                this.listeners.get(type)?.delete(listener);
            }

            postMessage() {}

            terminate() {}

            /**
             * @param {string} type
             * @param {unknown} event
             */
            _emit(type, event) {
                for (const listener of this.listeners.get(type) ?? []) { listener(event); }
            }
        }

        zstd.createCCtx.mockReturnValue(11);
        zstd.createDCtx.mockReturnValue(22);
        zstd.compressUsingDictWithPrefix.mockReturnValue(Uint8Array.of(7, 8, 9));
        vi.stubGlobal('Worker', MessageErrorCompressionWorker);
        const {
            compressWrappedTermContentZstdBatch,
            initializeTermContentZstd,
        } = await import('../ext/js/dictionary/zstd-term-content.js');
        await initializeTermContentZstd();

        const completion = compressWrappedTermContentZstdBatch(
            [Uint8Array.of(1), Uint8Array.of(2)],
            'jmdict',
        );
        await expect(completion).resolves.toMatchObject({
            wrapped: true,
            chunks: [Uint8Array.of(7, 8, 9), Uint8Array.of(7, 8, 9)],
        });
        expect(zstd.compressUsingDictWithPrefix).toHaveBeenCalled();
    });

    test.each(['constructor', 'initialization-error', 'messageerror', 'error'])(
        'settles peer startup waits before compression fallback after %s',
        async (failure) => {
            /** @type {StartupWorker[]} */
            const instances = [];
            let failStartup = true;
            let constructionCount = 0;
            class StartupWorker {
                constructor() {
                    const index = constructionCount++;
                    if (failStartup && failure === 'constructor' && index % 2 === 1) {
                        throw new Error('Compression worker construction failed');
                    }
                    /** @type {Map<string, Set<(event: unknown) => void>>} */
                    this.listeners = new Map();
                    this.terminated = false;
                    instances.push(this);
                    queueMicrotask(() => {
                        if (!failStartup) {
                            this.emit('message', {data: {type: 'ready'}});
                        } else if (index % 4 === 0 && failure !== 'constructor') {
                            this.emit(failure === 'initialization-error' ? 'message' : failure, {
                                data: {type: failure, error: 'Compression startup failed'},
                                message: 'Compression startup failed',
                            });
                        }
                    });
                }

                /**
                 * @param {string} type
                 * @param {(event: unknown) => void} listener
                 */
                addEventListener(type, listener) {
                    this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener));
                }

                /**
                 * @param {string} type
                 * @param {(event: unknown) => void} listener
                 */
                removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }

                /**
                 * @param {string} type
                 * @param {unknown} event
                 */
                emit(type, event) {
                    for (const listener of this.listeners.get(type) ?? []) { listener(event); }
                }

                /** @param {{id: number}} message */
                postMessage(message) {
                    queueMicrotask(() => this.emit('message', {
                        data: {id: message.id, compressed: Uint8Array.of(9).buffer, envelopeMs: 0},
                    }));
                }

                terminate() { this.terminated = true; }
            }

            zstd.createCCtx.mockReturnValue(11);
            zstd.createDCtx.mockReturnValue(22);
            zstd.compressUsingDictWithPrefix.mockReturnValue(Uint8Array.of(7));
            vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
            vi.stubGlobal('Worker', StartupWorker);
            try {
                const {initializeTermContentZstd, compressWrappedTermContentZstdBatch} = await import('../ext/js/dictionary/zstd-term-content.js');
                await initializeTermContentZstd();
                const contents = [Uint8Array.of(1), Uint8Array.of(2)];
                await expect(compressWrappedTermContentZstdBatch(contents, 'jmdict')).resolves.toMatchObject({
                    chunks: [Uint8Array.of(7), Uint8Array.of(7)],
                });
                expect(instances.length).toBeGreaterThan(0);
                expect(instances.every((worker) => worker.terminated)).toBe(true);
                expect(vi.getTimerCount()).toBe(0);
                for (const worker of instances) {
                    expect([...worker.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
                }

                failStartup = false;
                zstd.compressUsingDictWithPrefix.mockClear();
                await expect(compressWrappedTermContentZstdBatch(contents, 'jmdict')).resolves.toMatchObject({
                    chunks: [Uint8Array.of(9), Uint8Array.of(9)],
                });
                expect(zstd.compressUsingDictWithPrefix).not.toHaveBeenCalled();
                expect(vi.getTimerCount()).toBe(0);
            } finally {
                vi.clearAllTimers();
                vi.useRealTimers();
            }
        },
    );

    test('does not synchronously recompress slabs detached by a failed worker dispatch', async () => {
        class DetachingCompressionWorker {
            constructor() {
                /** @type {Map<string, Set<(event: unknown) => void>>} */
                this.listeners = new Map();
                queueMicrotask(() => { this._emit('message', {data: {type: 'ready'}}); });
            }

            /**
             * @param {string} type
             * @param {(event: unknown) => void} listener
             */
            addEventListener(type, listener) {
                this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener));
            }

            /**
             * @param {string} type
             * @param {(event: unknown) => void} listener
             */
            removeEventListener(type, listener) {
                this.listeners.get(type)?.delete(listener);
            }

            /**
             * @param {unknown} message
             * @param {Transferable[]} [transfer]
             */
            postMessage(message, transfer = []) {
                structuredClone(message, {transfer});
                queueMicrotask(() => { this._emit('error', {message: 'injected worker failure'}); });
            }

            terminate() {}

            /**
             * @param {string} type
             * @param {unknown} event
             */
            _emit(type, event) {
                for (const listener of this.listeners.get(type) ?? []) { listener(event); }
            }
        }
        zstd.createCCtx.mockReturnValue(11);
        zstd.createDCtx.mockReturnValue(22);
        zstd.compressUsingDictWithPrefix.mockReturnValue(new Uint8Array([1]));
        vi.stubGlobal('Worker', DetachingCompressionWorker);
        const {
            compressWrappedTermContentZstdBatch,
            initializeTermContentZstd,
        } = await import('../ext/js/dictionary/zstd-term-content.js');
        await initializeTermContentZstd();
        const contents = [Uint8Array.of(1, 2), Uint8Array.of(3, 4)];

        await expect(compressWrappedTermContentZstdBatch(contents, 'jmdict'))
            .rejects.toThrow('injected worker failure');

        expect(contents.every(({byteLength}) => byteLength === 0)).toBe(true);
        expect(zstd.compressUsingDictWithPrefix).not.toHaveBeenCalled();
    });

    test.each(['unwrapped', 'wrapped', 'spans'])('a late failed %s batch cannot clear a replacement pool startup', async (mode) => {
        /** @type {RecoveryWorker[]} */
        const instances = [];
        class RecoveryWorker {
            constructor() {
                this.generation = Math.floor(instances.length / 4);
                /** @type {Map<string, Set<(event: unknown) => void>>} */
                this.listeners = new Map();
                /** @type {Array<{id: number}>} */
                this.calls = [];
                this.terminated = false;
                instances.push(this);
                if (this.generation === 0) {
                    queueMicrotask(() => this.emit('message', {data: {type: 'ready'}}));
                }
            }

            /**
             * @param {string} type
             * @param {(event: unknown) => void} listener
             */
            addEventListener(type, listener) {
                this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener));
            }

            /**
             * @param {string} type
             * @param {(event: unknown) => void} listener
             */
            removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }

            /**
             * @param {string} type
             * @param {unknown} event
             */
            emit(type, event) {
                for (const listener of this.listeners.get(type) ?? []) { listener(event); }
            }

            /**
             * @param {{id: number}} message
             * @param {Transferable[]} [transfer]
             */
            postMessage(message, transfer = []) {
                this.calls.push(structuredClone(message, {transfer}));
                if (this.generation > 0) {
                    queueMicrotask(() => this.emit('message', {
                        data: {id: message.id, compressed: Uint8Array.of(9).buffer},
                    }));
                }
            }

            terminate() { this.terminated = true; }
        }
        const flush = () => new Promise((resolve) => { setImmediate(resolve); });
        zstd.createCCtx.mockReturnValue(11);
        zstd.createDCtx.mockReturnValue(22);
        vi.stubGlobal('Worker', RecoveryWorker);
        const {
            initializeTermContentZstd,
            beginCompressWrappedTermContentZstdSpansBatch,
            compressTermContentZstdBatch,
            compressWrappedTermContentZstdBatch,
        } = await import('../ext/js/dictionary/zstd-term-content.js');
        const begin = () => {
            if (mode !== 'spans') {
                const contents = [Uint8Array.of(1), Uint8Array.of(2)];
                const completion = mode === 'unwrapped' ?
                    compressTermContentZstdBatch(contents, 'jmdict').then((chunks) => ({chunks})) :
                    compressWrappedTermContentZstdBatch(contents, 'jmdict');
                return {sourceConsumed: Promise.resolve(), completion};
            }
            return beginCompressWrappedTermContentZstdSpansBatch(
                new Uint8Array(new SharedArrayBuffer(8)),
                Uint32Array.of(0, 4),
                Uint32Array.of(4, 4),
                Uint32Array.of(0, 1, 2),
                Uint32Array.of(4, 4),
                'jmdict',
            );
        };
        /** @type {Promise<unknown>[]} */
        const pending = [];
        try {
            await initializeTermContentZstd();
            await flush();
            const first = begin();
            const peer = begin();
            const retry = first.completion.catch(() => begin().completion);
            pending.push(first.sourceConsumed, peer.sourceConsumed, peer.completion, retry);
            for (const promise of pending) { void promise.catch(() => {}); }
            await flush();
            expect(instances).toHaveLength(4);
            expect(instances[0].calls).toHaveLength(2);
            instances[0].emit('message', {data: {id: instances[0].calls[0].id, error: 'first batch failed'}});
            instances[1].emit('message', {data: {id: instances[1].calls[0].id, compressed: Uint8Array.of(8).buffer}});
            await expect(peer.completion).rejects.toThrow();
            await flush();
            expect(instances).toHaveLength(8);
            expect(instances.slice(0, 4).every((worker) => worker.terminated)).toBe(true);
            expect(instances.slice(4).every((worker) => !worker.terminated)).toBe(true);
            const other = begin();
            pending.push(other.sourceConsumed, other.completion);
            for (const promise of pending) { void promise.catch(() => {}); }
            await flush();
            // Both independent retries must share the one replacement startup.
            expect(instances).toHaveLength(8);
            for (const worker of instances.slice(4)) {
                worker.emit('message', {data: {type: 'ready'}});
            }
            await expect(retry).resolves.toMatchObject({chunks: [Uint8Array.of(9), Uint8Array.of(9)]});
            await expect(other.completion).resolves.toMatchObject({chunks: [Uint8Array.of(9), Uint8Array.of(9)]});
        } finally {
            for (const worker of instances) {
                worker.emit('error', {message: 'test cleanup'});
                worker.terminate();
            }
            await Promise.allSettled(pending);
        }
    });
});
