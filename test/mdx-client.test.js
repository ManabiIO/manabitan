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

import {File as NodeFile} from 'node:buffer';
import {afterEach, describe, expect, test, vi} from 'vitest';
import {Mdx} from '../ext/js/comm/mdx.js';

/**
 * @typedef {{stage: 'upload'|'convert'|'download', completed: number, total: number}} MdxProgressEvent
 */

/**
 * @param {string} name
 * @param {Uint8Array} bytes
 * @returns {File}
 */
function createFile(name, bytes) {
    const file = new NodeFile([bytes], name, {type: 'application/octet-stream'});
    Reflect.set(file, 'webkitRelativePath', '');
    return /** @type {File} */ (/** @type {unknown} */ (file));
}

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
        /** @type {{message: Array<(event: MessageEvent) => void>, error: Array<(event: ErrorEvent) => void>}} */
        this._listeners = {
            message: [],
            error: [],
        };
    }

    /**
     * @param {'message'|'error'} type
     * @param {(event: MessageEvent|ErrorEvent) => void} listener
     */
    addEventListener(type, listener) {
        if (type === 'message') {
            this._listeners.message.push(/** @type {(event: MessageEvent) => void} */ (listener));
        } else {
            this._listeners.error.push(/** @type {(event: ErrorEvent) => void} */ (listener));
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

describe('Mdx browser worker integration', () => {
    test('normalizes unsupported variant errors with actionable guidance', () => {
        const mdx = new Mdx();
        const error = mdx._normalizeError('MDX variant uses unsupported xxHash-backed LZO blocks');

        expect(error.message).toContain('unsupported compression, encryption, or format variant');
        expect(error.message).toContain('Worker detail: MDX variant uses unsupported xxHash-backed LZO blocks');
    });

    test('converts MDX files through the worker and reports upload and worker progress', async () => {
        /** @type {FakeWorker[]} */
        const workerInstances = [];
        vi.stubGlobal('Worker', vi.fn((url, options) => {
            const worker = new FakeWorker(url, options);
            workerInstances.push(worker);
            return worker;
        }));

        const mdx = new Mdx();
        const mdxFile = createFile('fixture.mdx', createBytes(12, 11));
        const mddFiles = [createFile('fixture.mdd', createBytes(8, 47))];
        /** @type {MdxProgressEvent[]} */
        const progressEvents = [];

        const invocationPromise = mdx.convertDictionary(
            {
                mdxFile,
                mddFiles,
                titleOverride: 'Fixture',
                descriptionOverride: 'Fixture description',
                revision: '2026.03.18',
                enableAudio: true,
            },
            (details) => {
                progressEvents.push(details);
            },
        );

        await vi.waitFor(() => {
            expect(workerInstances).toHaveLength(1);
        });

        const [worker] = workerInstances;
        expect(worker?.url).toBe('/js/dictionary/mdx-worker-main.js');
        expect(worker?.options).toStrictEqual({type: 'module'});
        expect(mdx.isConnected()).toBe(true);
        expect(mdx.isActive()).toBe(true);

        const postMessageCalls = worker?.postMessage.mock.calls ?? [];
        expect(postMessageCalls).toHaveLength(1);
        const [message, transferables] = /** @type {[{action: string, params: {mdxFileName: string, mdxBytes: ArrayBuffer, mddFiles: Array<{name: string, bytes: ArrayBuffer}>, options: Record<string, unknown>}}, Transferable[]]} */ (/** @type {unknown} */ (postMessageCalls[0]));
        expect(message.action).toBe('convertDictionary');
        expect(message.params.mdxFileName).toBe('fixture.mdx');
        expect(message.params.mddFiles.map(({name}) => name)).toStrictEqual(['fixture.mdd']);
        expect(message.params.options).toMatchObject({
            titleOverride: 'Fixture',
            descriptionOverride: 'Fixture description',
            revision: '2026.03.18',
            enableAudio: true,
            includeAssets: true,
            termBankSize: 10000,
        });
        expect(new Uint8Array(message.params.mdxBytes)).toStrictEqual(createBytes(12, 11));
        expect(new Uint8Array(message.params.mddFiles[0].bytes)).toStrictEqual(createBytes(8, 47));
        expect(transferables).toHaveLength(2);

        const archiveContent = createBytes(10, 99).buffer;
        worker?.emitMessage({
            action: 'progress',
            params: {
                details: {stage: 'convert', completed: 3, total: 5},
            },
        });
        worker?.emitMessage({
            action: 'complete',
            params: {
                result: {
                    archiveContent,
                    archiveFileName: 'fixture.zip',
                },
            },
        });

        await expect(invocationPromise).resolves.toStrictEqual({
            archiveContent,
            archiveFileName: 'fixture.zip',
        });
        expect(progressEvents).toStrictEqual([
            {stage: 'upload', completed: 12, total: 20},
            {stage: 'upload', completed: 20, total: 20},
            {stage: 'convert', completed: 3, total: 5},
        ]);
        expect(worker?.terminate).toHaveBeenCalledTimes(1);
        expect(mdx.isConnected()).toBe(false);
        expect(mdx.isActive()).toBe(false);
    });

    test('surfaces worker failures and disconnects cleanly', async () => {
        /** @type {FakeWorker[]} */
        const workerInstances = [];
        vi.stubGlobal('Worker', vi.fn((url, options) => {
            const worker = new FakeWorker(url, options);
            workerInstances.push(worker);
            return worker;
        }));

        const mdx = new Mdx();
        const invocationPromise = mdx.convertDictionary({mdxFile: createFile('fixture.mdx', createBytes(4, 7))});

        await vi.waitFor(() => {
            expect(workerInstances).toHaveLength(1);
        });

        workerInstances[0]?.emitError('MDX worker exploded');

        await expect(invocationPromise).rejects.toThrow('MDX worker exploded');
        expect(workerInstances[0]?.terminate).toHaveBeenCalledTimes(1);
        expect(mdx.isConnected()).toBe(false);
        expect(mdx.isActive()).toBe(false);
    });
});
