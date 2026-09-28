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
import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {DictionaryWorkerHandler} from '../ext/js/dictionary/dictionary-worker-handler.js';

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
 * @param {boolean} [cloneMessages]
 * @returns {Promise<{send: (data: unknown, transfer?: Transferable[]) => Promise<void>, responses: Array<{message: WorkerResponse, transfer?: Transferable[]}>}>}
 */
async function loadWorker(cloneMessages = false) {
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
        postMessage(message, transfer) {
            const received = cloneMessages ? structuredClone(message, {transfer: transfer ?? []}) : message;
            responses.push({message: received, transfer});
        },
    });
    await import('../ext/js/dictionary/mdx-worker-main.js');
    const handler = state.handler;
    assert.notEqual(handler, null);
    return {
        responses,
        send: async (data, transfer = []) => {
            const received = cloneMessages ? structuredClone(data, {transfer}) : data;
            await /** @type {MessageHandler} */ (handler)({data: received});
        },
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
    await send({
        action: 'convertDictionary',
        params: {
            mdxBytes: new ArrayBuffer(2),
            mddFiles: [{name: 'first.mdd', bytes: first}, {bytes: second}],
        },
    });
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

// Exercise actual structured cloning and buffer detachment, not only transfer
// list identity. The converter remains mocked; this is not a browser Worker.
test('preserves bytes and progress across input and output transfers', async () => {
    const mdx = new Uint8Array([3, 1, 4]).buffer;
    const first = new Uint8Array([2, 7]).buffer;
    const second = new Uint8Array([1, 8, 2, 8]).buffer;
    const archiveContent = new Uint8Array([9, 0, 5, 7]).buffer;
    const progress = {step: 1};
    convertMdxToArchive.mockImplementation((name, options, bytes, resources, onProgress) => {
        assert.equal(name, 'input.mdx');
        assert.deepEqual(options, {title: 'Transfer fixture'});
        assert.deepEqual([...bytes], [3, 1, 4]);
        assert.deepEqual(resources.map((resource) => resource.name), ['first.mdd', 'second.mdd']);
        assert.deepEqual(resources.map((resource) => [...resource.bytes]), [[2, 7], [1, 8, 2, 8]]);
        assert.notEqual(bytes.buffer, mdx);
        onProgress(progress);
        progress.step = 2;
        return Promise.resolve({archiveContent});
    });
    const {send, responses} = await loadWorker(true);
    await send({
        action: 'convertDictionary',
        params: {
            mdxFileName: 'input.mdx',
            mdxBytes: mdx,
            options: {title: 'Transfer fixture'},
            mddFiles: [{name: 'first.mdd', bytes: first}, {name: 'second.mdd', bytes: second}],
        },
    }, [mdx, first, second]);
    assert.deepEqual([mdx.byteLength, first.byteLength, second.byteLength, archiveContent.byteLength], [0, 0, 0, 0]);
    assert.equal(convertMdxToArchive.mock.calls.length, 1);
    assert.deepEqual(responses.map(({message}) => message.action), ['progress', 'complete']);
    assert.deepEqual(responses[0].message.params.details, {step: 1});
    const result = responses[1].message.params.result;
    assert.ok(result);
    assert.notEqual(result.archiveContent, archiveContent);
    assert.deepEqual([...new Uint8Array(result.archiveContent)], [9, 0, 5, 7]);
});

test('rejects a cloned typed-array resource without dropping valid transferred resources', async () => {
    const mdx = new ArrayBuffer(2);
    const valid = new ArrayBuffer(3);
    const malformed = new Uint8Array([4, 5]);
    const {send, responses} = await loadWorker(true);
    await send({
        action: 'convertDictionary',
        params: {mdxBytes: mdx, mddFiles: [{bytes: valid}, {bytes: malformed}]},
    }, [mdx, valid, malformed.buffer]);
    assert.deepEqual([mdx.byteLength, valid.byteLength, malformed.byteLength], [0, 0, 0]);
    assert.equal(convertMdxToArchive.mock.calls.length, 0);
    assert.equal(responses.length, 1);
    assert.equal(responses[0].message.action, 'complete');
    assert.match(responses[0].message.params.error ?? '', /MDD bytes at index 1/);
});

test('rejects sparse resource lists after structured cloning', async () => {
    const mdx = new ArrayBuffer(2);
    const {send, responses} = await loadWorker(true);
    await send({action: 'convertDictionary', params: {mdxBytes: mdx, mddFiles: new Array(2)}}, [mdx]);
    assert.equal(mdx.byteLength, 0);
    assert.equal(convertMdxToArchive.mock.calls.length, 0);
    assert.equal(responses.length, 1);
    assert.equal(responses[0].message.action, 'complete');
    assert.match(responses[0].message.params.error ?? '', /invalid MDD file at index 0/);
});

test('accepts a valid transfer after settling an invalid request on the same worker', async () => {
    const archiveContent = new Uint8Array([6, 2, 6]).buffer;
    convertMdxToArchive.mockResolvedValue({archiveContent});
    const {send, responses} = await loadWorker(true);
    await send({action: 'convertDictionary', params: null});
    assert.equal(convertMdxToArchive.mock.calls.length, 0);
    assert.equal(responses.length, 1);
    assert.equal(typeof responses[0].message.params.error, 'string');
    const mdx = new ArrayBuffer(2);
    await send({action: 'convertDictionary', params: {mdxBytes: mdx}}, [mdx]);
    assert.equal(convertMdxToArchive.mock.calls.length, 1);
    assert.deepEqual(responses.map(({message}) => message.action), ['complete', 'complete']);
    const result = responses[1].message.params.result;
    assert.ok(result);
    assert.deepEqual([...new Uint8Array(result.archiveContent)], [6, 2, 6]);
    assert.equal(mdx.byteLength, 0);
    assert.equal(archiveContent.byteLength, 0);
});


/**
 * @param {Partial<import('dictionary-worker-handler').ImportMdxDictionaryMessageParams>} overrides
 * @returns {Promise<unknown>}
 */
async function importThroughDictionaryWorker(overrides) {
    const handler = new DictionaryWorkerHandler();
    const importDictionary = vi.fn(async () => ({result: null, errors: [], debug: null}));
    Reflect.set(handler, '_importDictionary', importDictionary);
    const params = {
        details: {},
        mdxFileName: 'fixture.mdx',
        mdxBytes: new ArrayBuffer(2),
        mddFiles: [],
        options: {},
        ...overrides,
    };
    return await Reflect.get(handler, '_importMdxDictionary').call(handler, params, () => {});
}

test('dictionary worker rejects a non-array MDD collection before conversion', async () => {
    await expect(importThroughDictionaryWorker({mddFiles: /** @type {import('core').SafeAny} */ (null)}))
        .rejects.toThrow('invalid MDD files');
    expect(convertMdxToArchive).not.toHaveBeenCalled();
});

test('dictionary worker rejects malformed MDD entries before conversion', async () => {
    await expect(importThroughDictionaryWorker({
        mddFiles: /** @type {import('core').SafeAny} */ ([{name: 'valid.mdd', bytes: new ArrayBuffer(2)}, null]),
    })).rejects.toThrow('invalid MDD file at index 1');
    expect(convertMdxToArchive).not.toHaveBeenCalled();
});

test('dictionary worker rejects non-ArrayBuffer MDD bytes instead of fabricating empty content', async () => {
    await expect(importThroughDictionaryWorker({
        mddFiles: /** @type {import('core').SafeAny} */ ([{name: 'invalid.mdd', bytes: new Uint8Array(3)}]),
    })).rejects.toThrow('did not receive MDD bytes at index 0');
    expect(convertMdxToArchive).not.toHaveBeenCalled();
});

test('dictionary worker rejects sparse MDD lists instead of dropping holes', async () => {
    await expect(importThroughDictionaryWorker({
        mddFiles: /** @type {import('core').SafeAny} */ (new Array(2)),
    })).rejects.toThrow('invalid MDD file at index 0');
    expect(convertMdxToArchive).not.toHaveBeenCalled();
});

test('dictionary worker preserves valid MDD order, bytes, and filename defaults', async () => {
    const first = new ArrayBuffer(2);
    const second = new ArrayBuffer(3);
    convertMdxToArchive.mockResolvedValue({archiveContent: new ArrayBuffer(8)});
    await importThroughDictionaryWorker({
        mddFiles: [{name: 'first.mdd', bytes: first}, {name: /** @type {import('core').SafeAny} */ (undefined), bytes: second}],
    });
    expect(convertMdxToArchive).toHaveBeenCalledTimes(1);
    const resources = /** @type {Array<{name: string, bytes: Uint8Array}>} */ (convertMdxToArchive.mock.calls[0][3]);
    expect(resources).toHaveLength(2);
    expect(resources[0].name).toBe('first.mdd');
    expect(resources[1].name).toBe('dictionary.mdd');
    expect(resources[0].bytes.buffer).toBe(first);
    expect(resources[1].bytes.buffer).toBe(second);
});
