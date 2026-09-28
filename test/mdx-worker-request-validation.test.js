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

import assert from 'node:assert/strict';
import {afterEach, beforeEach, test, vi} from 'vitest';

/** @typedef {(name: string, options: Record<string, unknown>, mdx: Uint8Array, mdd: Array<{name: string, bytes: Uint8Array}>, onProgress: (details: unknown) => void) => Promise<{archiveContent: ArrayBuffer}>} ConversionFunction */
const {convertMdxToArchive} = vi.hoisted(() => ({
    convertMdxToArchive: vi.fn(/** @type {ConversionFunction} */ (async () => {
        throw new Error('Unexpected converter invocation');
    })),
}));
vi.mock('../ext/js/dictionary/mdx/mdx-converter.js', () => ({convertMdxToArchive}));

beforeEach(() => {
    vi.resetModules();
    convertMdxToArchive.mockReset();
});
afterEach(() => { vi.unstubAllGlobals(); });

/**
 * @typedef {{action: string, params: {error?: string, result?: {archiveContent: ArrayBuffer}, details?: unknown}}} WorkerResponse
 */
/** @typedef {(event: {data: unknown}) => Promise<void>} MessageHandler */

/**
 * @returns {Promise<{send: (data: unknown) => Promise<void>, responses: Array<{message: WorkerResponse, transfer?: Transferable[]}>}>}
 */
async function loadWorker() {
    /** @type {{handler: MessageHandler|null}} */
    const state = {handler: null};
    /** @type {Array<{message: WorkerResponse, transfer?: Transferable[]}>} */
    const responses = [];
    vi.stubGlobal('self', {
        /**
         * @param {string} type
         * @param {MessageHandler} handler
         */
        addEventListener(type, handler) {
            assert.equal(type, 'message');
            state.handler = handler;
        },
        /**
         * @param {WorkerResponse} message
         * @param {Transferable[]} [transfer]
         */
        postMessage(message, transfer) { responses.push({message, transfer}); },
    });
    await import('../ext/js/dictionary/mdx-worker-main.js');
    const handler = state.handler;
    assert.notEqual(handler, null);
    return {
        responses,
        send: async (data) => { await /** @type {MessageHandler} */ (handler)({data}); },
    };
}

/**
 * @param {unknown} params
 * @returns {Promise<void>}
 */
async function expectInvalid(params) {
    const {send, responses} = await loadWorker();
    await send({action: 'convertDictionary', params});
    assert.equal(convertMdxToArchive.mock.calls.length, 0);
    assert.equal(responses.length, 1);
    assert.equal(responses[0].message.action, 'complete');
    assert.equal(typeof responses[0].message.params.error, 'string');
    assert.ok((responses[0].message.params.error?.length ?? 0) > 0);
}

for (const params of [undefined, null, 3, 'invalid']) {
    test(`settles invalid conversion parameters: ${String(params)}`, async () => {
        await expectInvalid(params);
    });
}

for (const mddFiles of [null, {}, 'files', 4]) {
    test(`rejects a non-array MDD collection: ${String(mddFiles)}`, async () => {
        await expectInvalid({mdxBytes: new ArrayBuffer(2), mddFiles});
    });
}

for (const [index, entry] of [null, 3, 'file', {}, [], {bytes: new Uint8Array(3)}, {bytes: null}].entries()) {
    test(`rejects invalid MDD entry ${index} before conversion`, async () => {
        await expectInvalid({
            mdxBytes: new ArrayBuffer(2),
            mddFiles: [{name: 'valid.mdd', bytes: new ArrayBuffer(2)}, entry],
        });
    });
}

test('rejects holes in an MDD list instead of passing a sparse resource array', async () => {
    await expectInvalid({mdxBytes: new ArrayBuffer(2), mddFiles: new Array(2)});
});

test('accepts omitted optional MDD files and preserves output transfer', async () => {
    const archiveContent = new ArrayBuffer(8);
    convertMdxToArchive.mockResolvedValue({archiveContent});
    const {send, responses} = await loadWorker();
    await send({action: 'convertDictionary', params: {mdxBytes: new ArrayBuffer(2)}});
    assert.equal(convertMdxToArchive.mock.calls.length, 1);
    assert.deepEqual(convertMdxToArchive.mock.calls[0][3], []);
    assert.equal(responses.length, 1);
    assert.equal(responses[0].message.params.result?.archiveContent, archiveContent);
    assert.deepEqual(responses[0].transfer, [archiveContent]);
});

test('accepts an empty MDD list', async () => {
    convertMdxToArchive.mockResolvedValue({archiveContent: new ArrayBuffer(8)});
    const {send, responses} = await loadWorker();
    await send({action: 'convertDictionary', params: {mdxBytes: new ArrayBuffer(2), mddFiles: []}});
    assert.equal(convertMdxToArchive.mock.calls.length, 1);
    assert.equal(responses[0].message.params.error, undefined);
});

test('preserves valid resource order, bytes, and filename defaults', async () => {
    const first = new ArrayBuffer(2);
    const second = new ArrayBuffer(3);
    convertMdxToArchive.mockResolvedValue({archiveContent: new ArrayBuffer(8)});
    const {send, responses} = await loadWorker();
    await send({action: 'convertDictionary', params: {
        mdxBytes: new ArrayBuffer(2),
        mddFiles: [{name: 'first.mdd', bytes: first}, {bytes: second}],
    }});
    assert.equal(convertMdxToArchive.mock.calls.length, 1);
    /** @type {Array<{name: string, bytes: Uint8Array}>} */
    const resources = convertMdxToArchive.mock.calls[0][3];
    assert.equal(resources.length, 2);
    assert.equal(resources[0].name, 'first.mdd');
    assert.equal(resources[1].name, 'dictionary.mdd');
    assert.equal(resources[0].bytes.buffer, first);
    assert.equal(resources[1].bytes.buffer, second);
    assert.equal(responses[0].message.params.error, undefined);
});

test('forwards progress before completion', async () => {
    const archiveContent = new ArrayBuffer(8);
    convertMdxToArchive.mockImplementation((...args) => {
        /** @type {(details: unknown) => void} */
        const onProgress = args[4];
        onProgress({step: 1});
        return Promise.resolve({archiveContent});
    });
    const {send, responses} = await loadWorker();
    await send({action: 'convertDictionary', params: {mdxBytes: new ArrayBuffer(2)}});
    assert.deepEqual(responses.map(({message}) => message.action), ['progress', 'complete']);
    assert.deepEqual(responses[0].message.params.details, {step: 1});
});

test('returns converter failures through the completion protocol', async () => {
    convertMdxToArchive.mockRejectedValue(new Error('conversion failed'));
    const {send, responses} = await loadWorker();
    await send({action: 'convertDictionary', params: {mdxBytes: new ArrayBuffer(2)}});
    assert.equal(convertMdxToArchive.mock.calls.length, 1);
    assert.equal(responses.length, 1);
    assert.equal(responses[0].message.params.error, 'conversion failed');
});

test('rejects missing MDX bytes', async () => { await expectInvalid({}); });

for (const data of [null, {action: 'unrelated', params: null}]) {
    test(`ignores unrelated messages: ${JSON.stringify(data)}`, async () => {
        const {send, responses} = await loadWorker();
        await send(data);
        assert.equal(responses.length, 0);
        assert.equal(convertMdxToArchive.mock.calls.length, 0);
    });
}
