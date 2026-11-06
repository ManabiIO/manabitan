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
            expect(workers).toHaveLength(0);
            expect(sourceLoads).toBe(0);
            expect(vi.getTimerCount()).toBe(0);
            await parser.disposeParallelTermBankParser();
            replacement = parser.prewarmParallelTermBankParser();
            expect(fetchMock).toHaveBeenCalledTimes(1);
            if (outcome === 'resolve') {
                resolveFetch(new Response(bytes));
                await expect(replacement).resolves.toBe(true);
                expect(workers).toHaveLength(parser.getParallelTermBankParserWorkerCount());
            } else {
                rejectFetch(new Error('Late module fetch failure'));
                await expect(replacement).resolves.toBe(false);
                expect(workers).toHaveLength(0);
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
