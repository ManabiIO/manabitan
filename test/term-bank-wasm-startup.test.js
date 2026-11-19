/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {readFile} from 'node:fs/promises';
import {afterEach, expect, test, vi} from 'vitest';

const nativeCompile = WebAssembly.compile;

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

for (const outcome of ['resolve', 'reject']) {
    test(`cancels startup without abandoning shared module work that will ${outcome}`, async () => {
        vi.resetModules();
        const bytes = await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url));
        const module = await nativeCompile(bytes);
        /** @type {(value: Response) => void} */
        let resolveFetch = () => {};
        /** @type {(reason: unknown) => void} */
        let rejectFetch = () => {};
        const response = new Promise((resolve, reject) => {
            resolveFetch = resolve;
            rejectFetch = reject;
        });
        let fetchStarted = () => {};
        const started = new Promise((resolve) => { fetchStarted = () => resolve(void 0); });
        const fetchMock = vi.fn(async () => {
            fetchStarted();
            return await response;
        });
        vi.stubGlobal('fetch', fetchMock);
        /** @type {ReadyWorker[]} */
        const workers = [];
        class ReadyWorker {
            constructor() {
                /** @type {Map<string, Set<(event: MessageEvent<unknown>) => void>>} */
                this.listeners = new Map();
                this.terminated = false;
                this.initializeCount = 0;
                workers.push(this);
            }

            addEventListener(/** @type {string} */ type, /** @type {(event: MessageEvent<unknown>) => void} */ listener) {
                const listeners = this.listeners.get(type) ?? new Set();
                listeners.add(listener);
                this.listeners.set(type, listeners);
            }

            removeEventListener(/** @type {string} */ type, /** @type {(event: MessageEvent<unknown>) => void} */ listener) {
                this.listeners.get(type)?.delete(listener);
            }

            postMessage(/** @type {{type: string}} */ message) {
                expect(message.type).toBe('initialize');
                expect(this.terminated).toBe(false);
                ++this.initializeCount;
                queueMicrotask(() => {
                    for (const listener of this.listeners.get('message') ?? []) {
                        listener(new MessageEvent('message', {data: {type: 'ready'}}));
                    }
                });
            }

            terminate() { this.terminated = true; }
        }
        vi.stubGlobal('Worker', ReadyWorker);
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']});
        const parser = await import('../ext/js/dictionary/term-bank-wasm-parser.js');
        let cancelled = false;
        let settled = false;
        let sourceLoads = 0;
        /** @type {unknown} */
        let failure = null;
        const pending = parser.parseTermBankWithWasmColumnChunksParallelLazy(
            Array.from({length: 4}, () => async () => { ++sourceLoads; return new TextEncoder().encode('[]'); }),
            [2, 2, 2, 2],
            3,
            () => { throw new Error('Unexpected sink call'); },
            {emitContentSlab: true},
            () => cancelled,
        ).then(() => { settled = true; }, (error) => {
            settled = true;
            failure = error;
        });
        /** @type {Promise<boolean>|null} */
        let replacement = null;
        try {
            await started;
            cancelled = true;
            await vi.advanceTimersByTimeAsync(250);
            expect(settled).toBe(true);
            expect(failure).toMatchObject({name: 'AbortError'});
            const workerCount = parser.getParallelTermBankParserWorkerCount();
            expect(workers).toHaveLength(workerCount);
            expect(workers.every((worker) => worker.terminated && worker.initializeCount === 0)).toBe(true);
            expect(sourceLoads).toBe(0);
            expect(vi.getTimerCount()).toBe(0);
            await parser.disposeParallelTermBankParser();
            replacement = parser.prewarmParallelTermBankParser();
            expect(fetchMock).toHaveBeenCalledTimes(1);
            if (outcome === 'resolve') {
                resolveFetch(new Response(bytes));
                await expect(replacement).resolves.toBe(true);
                expect(workers).toHaveLength(workerCount * 2);
            } else {
                rejectFetch(new Error('Late module fetch failure'));
                await expect(replacement).resolves.toBe(false);
                expect(workers).toHaveLength(workerCount * 2);
                expect(workers.every((worker) => worker.terminated && worker.initializeCount === 0)).toBe(true);
                parser.setTermBankWasmModule(module);
                await expect(parser.prewarmParallelTermBankParser()).resolves.toBe(true);
            }
            await pending;
            await parser.disposeParallelTermBankParser();
            expect(workers.every((worker) => worker.terminated)).toBe(true);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            // Also settle the original implementation when this is run as a red test.
            rejectFetch(new Error('Test cleanup'));
            await pending;
            if (replacement !== null) { await replacement; }
            await parser.disposeParallelTermBankParser();
            vi.clearAllTimers();
        }
    });
}

/**
 * Models independently loaded worker scripts and a shared deferred WASM fetch.
 * @param {{autoReady?: boolean, constructorFailureIndex?: number, postFailure?: boolean}} [options]
 * @returns {Promise<{
 *   bytes: import('node:buffer').Buffer,
 *   parser: typeof import('../ext/js/dictionary/term-bank-wasm-parser.js'),
 *   workers: Array<{scriptLoaded: boolean, terminated: boolean, initializeCount: number, emit: (type: string, event: unknown) => void}>,
 *   started: Promise<unknown>,
 *   resolveFetch: (value: Response) => void,
 *   rejectFetch: (reason: unknown) => void,
 *   expectRetired: () => void,
 *   cleanup: () => Promise<void>,
 * }>}
 */
async function createStartupFixture({autoReady = true, constructorFailureIndex = -1, postFailure = false} = {}) {
    vi.resetModules();
    const bytes = await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url));
    /** @type {(value: Response) => void} */
    let resolveFetch = () => {};
    /** @type {(reason: unknown) => void} */
    let rejectFetch = () => {};
    const response = new Promise((resolve, reject) => {
        resolveFetch = resolve;
        rejectFetch = reject;
    });
    let fetchStarted = () => {};
    const started = new Promise((resolve) => { fetchStarted = () => resolve(void 0); });
    vi.stubGlobal('fetch', async () => {
        fetchStarted();
        return await response;
    });
    /** @type {LoadingWorker[]} */
    const workers = [];
    class LoadingWorker {
        constructor() {
            if (workers.length === constructorFailureIndex) { throw new Error('Worker constructor failure'); }
            /** @type {Map<string, Set<(event: MessageEvent<unknown>) => void>>} */
            this.listeners = new Map();
            this.scriptLoaded = false;
            this.terminated = false;
            this.initializeCount = 0;
            workers.push(this);
            queueMicrotask(() => { this.scriptLoaded = true; });
        }

        addEventListener(/** @type {string} */ type, /** @type {(event: MessageEvent<unknown>) => void} */ listener) {
            this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener));
        }

        removeEventListener(/** @type {string} */ type, /** @type {(event: MessageEvent<unknown>) => void} */ listener) {
            this.listeners.get(type)?.delete(listener);
        }

        postMessage(/** @type {{type: string, module: WebAssembly.Module}} */ message) {
            expect(this.terminated).toBe(false);
            expect(message.type).toBe('initialize');
            expect(message.module).toBeInstanceOf(WebAssembly.Module);
            expect(this.scriptLoaded).toBe(true);
            if (postFailure) { throw new Error('Worker message failure'); }
            ++this.initializeCount;
            if (autoReady) {
                queueMicrotask(() => { this.emit('message', new MessageEvent('message', {data: {type: 'ready'}})); });
            }
        }

        terminate() { this.terminated = true; }

        emit(/** @type {string} */ type, /** @type {unknown} */ event) {
            for (const listener of this.listeners.get(type) ?? []) {
                listener(/** @type {MessageEvent<unknown>} */ (event));
            }
        }
    }
    vi.stubGlobal('Worker', LoadingWorker);
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']});
    const parser = await import('../ext/js/dictionary/term-bank-wasm-parser.js');
    const expectRetired = () => {
        expect(workers.every((worker) => worker.terminated)).toBe(true);
        expect(workers.every((worker) => [...worker.listeners.values()].every((listeners) => listeners.size === 0))).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    };
    const cleanup = async () => {
        rejectFetch(new Error('Test cleanup'));
        await parser.disposeParallelTermBankParser();
        vi.clearAllTimers();
    };
    return {bytes, parser, workers, started, resolveFetch, rejectFetch, expectRetired, cleanup};
}

test('loads worker scripts before the shared parser module is available', async () => {
    const fixture = await createStartupFixture();
    const {parser, workers} = fixture;
    try {
        const pending = parser.prewarmParallelTermBankParser();
        await fixture.started;
        await Promise.resolve();
        expect(workers).toHaveLength(parser.getParallelTermBankParserWorkerCount());
        expect(workers.every((worker) => worker.scriptLoaded && worker.initializeCount === 0)).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
        fixture.resolveFetch(new Response(fixture.bytes));
        await expect(pending).resolves.toBe(true);
        expect(workers.every((worker) => worker.initializeCount === 1 && !worker.terminated)).toBe(true);
        await parser.disposeParallelTermBankParser();
        fixture.expectRetired();
    } finally {
        await fixture.cleanup();
    }
});

for (const outcome of ['resolve', 'reject']) {
    test(`retires script-loading failures before shared compilation will ${outcome}`, async () => {
        const fixture = await createStartupFixture();
        const {parser, workers} = fixture;
        try {
            const pending = parser.prewarmParallelTermBankParser();
            await fixture.started;
            expect(workers).toHaveLength(parser.getParallelTermBankParserWorkerCount());
            workers[0].emit('error', {message: 'Worker module graph failed to load'});
            await expect(pending).resolves.toBe(false);
            fixture.expectRetired();
            const moduleSettled = parser.compileTermBankWasmModule().then(() => true, () => false);
            if (outcome === 'resolve') {
                fixture.resolveFetch(new Response(fixture.bytes));
            } else {
                fixture.rejectFetch(new Error('Late module fetch failure'));
            }
            await expect(moduleSettled).resolves.toBe(outcome === 'resolve');
            expect(workers.every((worker) => worker.initializeCount === 0)).toBe(true);
            fixture.expectRetired();
        } finally {
            await fixture.cleanup();
        }
    });
}

for (const constructorFailureIndex of [0, 1]) {
    test(`joins failed worker construction at index ${constructorFailureIndex} while compilation is pending`, async () => {
        const fixture = await createStartupFixture({constructorFailureIndex});
        const {parser, workers} = fixture;
        try {
            const pending = parser.prewarmParallelTermBankParser();
            await fixture.started;
            await expect(pending).resolves.toBe(false);
            expect(workers).toHaveLength(constructorFailureIndex);
            fixture.expectRetired();
            const moduleSettled = parser.compileTermBankWasmModule().then(() => true, () => false);
            fixture.rejectFetch(new Error('Late failed-constructor module fetch'));
            await expect(moduleSettled).resolves.toBe(false);
            expect(workers.every((worker) => worker.initializeCount === 0)).toBe(true);
            fixture.expectRetired();
        } finally {
            await fixture.cleanup();
        }
    });
}

test('retires every worker when shared module compilation fails', async () => {
    const fixture = await createStartupFixture();
    try {
        const pending = fixture.parser.prewarmParallelTermBankParser();
        await fixture.started;
        fixture.rejectFetch(new Error('Parser module fetch failure'));
        await expect(pending).resolves.toBe(false);
        expect(fixture.workers).toHaveLength(fixture.parser.getParallelTermBankParserWorkerCount());
        expect(fixture.workers.every((worker) => worker.initializeCount === 0)).toBe(true);
        fixture.expectRetired();
    } finally {
        await fixture.cleanup();
    }
});

test('starts initialization timeout when compilation finishes and clears peers on timeout', async () => {
    const fixture = await createStartupFixture({autoReady: false});
    const {parser, workers} = fixture;
    try {
        let settled = false;
        const pending = parser.prewarmParallelTermBankParser().then((value) => {
            settled = true;
            return value;
        });
        await fixture.started;
        await vi.advanceTimersByTimeAsync(60_001);
        expect(settled).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        const moduleReady = parser.compileTermBankWasmModule();
        fixture.resolveFetch(new Response(fixture.bytes));
        await moduleReady;
        await vi.advanceTimersByTimeAsync(0);
        expect(workers.every((worker) => worker.initializeCount === 1)).toBe(true);
        expect(vi.getTimerCount()).toBe(workers.length);
        await vi.advanceTimersByTimeAsync(59_999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await expect(pending).resolves.toBe(false);
        fixture.expectRetired();
    } finally {
        await fixture.cleanup();
    }
});

test('cleans up worker message failures after overlapped startup', async () => {
    const fixture = await createStartupFixture({postFailure: true});
    try {
        const pending = fixture.parser.prewarmParallelTermBankParser();
        await fixture.started;
        fixture.resolveFetch(new Response(fixture.bytes));
        await expect(pending).resolves.toBe(false);
        fixture.expectRetired();
    } finally {
        await fixture.cleanup();
    }
});
