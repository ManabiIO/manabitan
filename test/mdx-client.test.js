/*
 * Copyright (C) 2026  Yomitan Authors
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

import {afterEach, describe, expect, test, vi} from 'vitest';
import {DictionaryWorker} from '../ext/js/dictionary/dictionary-worker.js';

/**
 * @param {number} length
 * @param {number} [seed]
 * @returns {Uint8Array}
 */
function createBytes(length, seed = 0) {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; ++i) {
        bytes[i] = (seed + i) % 251;
    }
    return bytes;
}

class FakeWorker {
    /**
     * @param {string} url
     * @param {WorkerOptions} options
     */
    constructor(url, options) {
        this.url = url;
        this.options = options;
        this.postMessage = vi.fn();
        this.terminate = vi.fn();
        /** @type {{message: Array<(event: MessageEvent) => void>, error: Array<(event: ErrorEvent) => void>, messageerror: Array<(event: MessageEvent) => void>}} */
        this._listeners = {
            message: [],
            error: [],
            messageerror: [],
        };
    }

    /**
     * @param {'message'|'error'|'messageerror'} type
     * @param {(event: MessageEvent|ErrorEvent) => void} listener
     */
    addEventListener(type, listener) {
        if (type === 'message') {
            this._listeners.message.push(/** @type {(event: MessageEvent) => void} */ (listener));
        } else if (type === 'error') {
            this._listeners.error.push(/** @type {(event: ErrorEvent) => void} */ (listener));
        } else {
            this._listeners.messageerror.push(/** @type {(event: MessageEvent) => void} */ (listener));
        }
    }

    /**
     * @param {'message'|'error'|'messageerror'} type
     * @param {(event: MessageEvent|ErrorEvent) => void} listener
     */
    removeEventListener(type, listener) {
        const listeners = this._listeners[type];
        const index = /** @type {unknown[]} */ (listeners).indexOf(listener);
        if (index >= 0) {
            listeners.splice(index, 1);
        }
    }

    /**
     * @param {unknown} data
     */
    emitMessage(data) {
        for (const listener of this._listeners.message) {
            listener(/** @type {MessageEvent} */ (/** @type {unknown} */ ({data})));
        }
    }

    /**
     * @param {string} message
     */
    emitError(message) {
        for (const listener of this._listeners.error) {
            listener(/** @type {ErrorEvent} */ (/** @type {unknown} */ ({message})));
        }
    }
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('DictionaryWorker MDX import integration', () => {
    test('imports MDX bytes through the dictionary worker and forwards parser progress', async () => {
        /** @type {FakeWorker[]} */
        const workerInstances = [];
        vi.stubGlobal('Worker', vi.fn((url, options) => {
            const worker = new FakeWorker(url, options);
            workerInstances.push(worker);
            return worker;
        }));

        const dictionaryWorker = new DictionaryWorker();
        /** @type {import('dictionary-importer').ProgressData[]} */
        const progressEvents = [];
        const mdxBytes = createBytes(12, 11).buffer;
        const mddBytes = createBytes(8, 47).buffer;

        const invocationPromise = dictionaryWorker.importMdxDictionary(
            'fixture.mdx',
            mdxBytes,
            [{name: 'fixture.mdd', bytes: mddBytes}],
            {prefixWildcardsSupported: true, yomitanVersion: '1.2.3.4'},
            (details) => {
                progressEvents.push(details);
            },
            {
                titleOverride: 'Fixture',
                descriptionOverride: 'Fixture description',
                revision: '2026.03.18',
                enableAudio: true,
            },
        );

        await vi.waitFor(() => {
            expect(workerInstances).toHaveLength(1);
        });

        const [worker] = workerInstances;
        expect(worker?.url).toBe('/js/dictionary/dictionary-worker-main.js');
        expect(worker?.options).toStrictEqual({type: 'module'});

        const postMessageCalls = worker?.postMessage.mock.calls ?? [];
        expect(postMessageCalls).toHaveLength(1);
        const [message, transferables] = /** @type {[{action: string, params: {details: Record<string, unknown>, mdxFileName: string, mdxBytes: ArrayBuffer, mddFiles: Array<{name: string, bytes: ArrayBuffer}>, options: Record<string, unknown>}}, Transferable[]]} */ (/** @type {unknown} */ (postMessageCalls[0]));
        expect(message.action).toBe('importMdxDictionary');
        expect(message.params.mdxFileName).toBe('fixture.mdx');
        expect(message.params.details).toMatchObject({
            prefixWildcardsSupported: true,
            yomitanVersion: '1.2.3.4',
        });
        expect(message.params.options).toMatchObject({
            titleOverride: 'Fixture',
            descriptionOverride: 'Fixture description',
            revision: '2026.03.18',
            enableAudio: true,
        });
        expect(new Uint8Array(message.params.mdxBytes)).toStrictEqual(createBytes(12, 11));
        expect(new Uint8Array(message.params.mddFiles[0].bytes)).toStrictEqual(createBytes(8, 47));
        expect(transferables).toHaveLength(2);

        worker?.emitMessage({
            action: 'progress',
            params: {
                args: [{nextStep: false, index: 725, count: 1000}],
            },
        });
        worker?.emitMessage({
            action: 'complete',
            params: {
                result: {
                    result: null,
                    errors: [],
                    debug: null,
                },
            },
        });

        await expect(invocationPromise).resolves.toStrictEqual({
            result: null,
            errors: [],
            debug: null,
        });
        expect(progressEvents).toStrictEqual([{nextStep: false, index: 725, count: 1000}]);
        expect(worker?.terminate).toHaveBeenCalledTimes(1);
    });

    test('queries the direct MDX import version through the dictionary worker', async () => {
        /** @type {FakeWorker[]} */
        const workerInstances = [];
        vi.stubGlobal('Worker', vi.fn((url, options) => {
            const worker = new FakeWorker(url, options);
            workerInstances.push(worker);
            return worker;
        }));

        const dictionaryWorker = new DictionaryWorker();
        const invocationPromise = dictionaryWorker.getMdxVersion();

        await vi.waitFor(() => {
            expect(workerInstances).toHaveLength(1);
        });

        const [worker] = workerInstances;
        const postMessageCalls = worker?.postMessage.mock.calls ?? [];
        expect(postMessageCalls).toHaveLength(1);
        const [message, transferables] = /** @type {[{action: string, params: Record<string, never>}, Transferable[]]} */ (/** @type {unknown} */ (postMessageCalls[0]));
        expect(message.action).toBe('getMdxVersion');
        expect(transferables).toHaveLength(0);

        worker?.emitMessage({
            action: 'complete',
            params: {
                result: 1,
            },
        });

        await expect(invocationPromise).resolves.toBe(1);
    });

    test('surfaces worker failures and disconnects cleanly during direct MDX import', async () => {
        /** @type {FakeWorker[]} */
        const workerInstances = [];
        vi.stubGlobal('Worker', vi.fn((url, options) => {
            const worker = new FakeWorker(url, options);
            workerInstances.push(worker);
            return worker;
        }));

        const dictionaryWorker = new DictionaryWorker();
        const invocationPromise = dictionaryWorker.importMdxDictionary(
            'fixture.mdx',
            createBytes(4, 7).buffer,
            [],
            {prefixWildcardsSupported: true, yomitanVersion: '1.2.3.4'},
            null,
        );

        await vi.waitFor(() => {
            expect(workerInstances).toHaveLength(1);
        });

        workerInstances[0]?.emitError('Dictionary worker exploded');

        await expect(invocationPromise).rejects.toThrow('Dictionary worker failed: Dictionary worker exploded');
        expect(workerInstances[0]?.terminate).toHaveBeenCalledTimes(1);
    });
});
