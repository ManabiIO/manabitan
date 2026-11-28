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

import {readFile} from 'node:fs/promises';
import {afterEach, beforeAll, expect, test, vi} from 'vitest';
import {buildTermBankParserWorker} from '../dev/build-libs.js';

/** @typedef {ReturnType<typeof import('../ext/js/dictionary/term-bank-wasm-parser.js').copyWasmBackedColumnChunk>} WorkerChunk */
/** @typedef {{type: string, id?: number, error?: {name: string, message: string}, rowCount?: number, ownsContentBytes?: boolean, borrowsWorkerMemory?: boolean, chunk?: WorkerChunk|null}} WorkerResponse */

const bundleUrl = new URL('../ext/js/dictionary/term-bank-wasm-parser-worker.bundle.js', import.meta.url);
/** @type {import('esbuild').Metafile} */
let metadata;
let bundleSource = '';

beforeAll(async () => {
    metadata = await buildTermBankParserWorker();
    bundleSource = await readFile(bundleUrl, 'utf8');
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

test('builds a deterministic closed worker bundle with every source copyright notice', async () => {
    const output = Object.values(metadata.outputs);
    expect(output).toHaveLength(1);
    expect(output[0].imports).toEqual([]);
    expect(output[0].exports).toEqual([]);
    expect(bundleSource).toContain('GNU General Public License');
    expect(bundleSource).toContain('// @ts-nocheck');
    for (const fileName of Object.keys(metadata.inputs)) {
        const source = await readFile(new URL(`../${fileName}`, import.meta.url), 'utf8');
        for (const notice of source.match(/^ \* Copyright[^\n]*/gm) ?? []) {
            expect(bundleSource).toContain(notice);
        }
    }
    await buildTermBankParserWorker();
    expect(await readFile(bundleUrl, 'utf8')).toBe(bundleSource);
});

test.each(['https://reader.example/vendor/manabitan/v1/', 'chrome-extension://test/', 'moz-extension://test/'])('bundled resource URLs remain within %s', (root) => {
    const relativePaths = [...bundleSource.matchAll(/new URL\("([^"]+)", import\.meta\.url\)/g)].map((match) => match[1]);
    expect(relativePaths.sort()).toEqual(['../../lib/term-bank-parser.wasm', 'term-bank-wasm-parser-worker.bundle.js'].sort());
    const moduleUrl = `${root}js/dictionary/term-bank-wasm-parser-worker.bundle.js`;
    expect(new URL(relativePaths[0], moduleUrl).href).toBe(`${root}lib/term-bank-parser.wasm`);
    expect(new URL(relativePaths[1], moduleUrl).href).toBe(moduleUrl);
});

/**
 * Runs either real entry point with native WASM. Only browser message transport
 * is replaced; structured cloning exercises the actual transfer list.
 * @param {boolean} bundled
 * @returns {Promise<{send: (data: Record<string, unknown>) => Promise<WorkerResponse>}>}
 */
async function loadWorker(bundled) {
    vi.resetModules();
    vi.stubGlobal('__manabitanTermBankParserWorker', false);
    const bridge = {
        listener: /** @type {((event: MessageEvent<unknown>) => void)|null} */ (null),
        messages: /** @type {WorkerResponse[]} */ ([]),
    };
    vi.stubGlobal('self', {
        /**
         * @param {string} type
         * @param {(event: MessageEvent<unknown>) => void} listener
         */
        addEventListener(type, listener) {
            if (type === 'message') { bridge.listener = listener; }
        },
        /**
         * @param {WorkerResponse} message
         * @param {Transferable[]} [transfer]
         */
        postMessage(message, transfer = []) {
            bridge.messages.push(structuredClone(message, {transfer}));
        },
    });
    const url = bundled ? bundleUrl : new URL('../ext/js/dictionary/term-bank-wasm-parser-worker.js', import.meta.url);
    // eslint-disable-next-line no-unsanitized/method -- Both URLs name fixed repository-owned worker entries.
    await import(url.href);
    /**
     * @param {Record<string, unknown>} data
     * @returns {Promise<WorkerResponse>}
     */
    const send = async (data) => {
        if (bridge.listener === null) { throw new Error('Worker listener was not installed'); }
        const previous = bridge.messages.length;
        bridge.listener(new MessageEvent('message', {data: structuredClone(data)}));
        await vi.waitFor(() => { expect(bridge.messages).toHaveLength(previous + 1); });
        return bridge.messages[previous];
    };
    return {send};
}

test('bundled and source workers preserve native parsing, errors and owned result transfers', async () => {
    const wasm = await readFile(new URL('../dev/data/dictionary-wasm/term-bank-parser.wasm', import.meta.url));
    const module = await WebAssembly.compile(wasm);
    const source = new TextEncoder().encode(JSON.stringify([
        ['猫', 'ねこ', 'n', '', 100, ['cat'], 1, ''],
        ['犬', 'いぬ', 'n', '', -1000, ['dog'], 2, ''],
        ['猫', 'ねこ', 'n', '', 100, ['cat'], 1, ''],
        ['画像', 'がぞう', '', '', 0, [{type: 'image', path: 'media/cat.webp'}], 3, ''],
    ]));
    /** @type {WorkerResponse[]} */
    const results = [];
    for (const bundled of [false, true]) {
        const {send} = await loadWorker(bundled);
        expect(await send({type: 'initialize', module: null})).toMatchObject({
            type: 'initialization-error',
            error: {name: 'TypeError', message: 'Term-bank parser worker module is invalid'},
        });
        expect(await send({type: 'initialize', module})).toEqual({type: 'ready'});
        expect(await send({type: 'parse', id: 1, sourceBuffers: [null], version: 3})).toMatchObject({
            type: 'parse-error',
            id: 1,
            error: {name: 'TypeError', message: 'Term-bank parser worker source buffers are invalid'},
        });
        const result = await send({
            type: 'parse',
            id: 2,
            sourceBuffers: [Uint8Array.from(source).buffer],
            version: 3,
            options: {
                ownContentBytes: true,
                emitContentSlab: true,
                emitTokenBinaryContent: true,
                computeContentHashes: true,
                useNativeStringPlan: true,
                prepareLookupIndexes: true,
                prepareLookupRoute: true,
                validateGlossaryTypes: true,
            },
        });
        expect(result).toMatchObject({type: 'result', id: 2, rowCount: 4, ownsContentBytes: true, borrowsWorkerMemory: false});
        if (!result.chunk) { throw new Error('Missing native result chunk'); }
        expect([...result.chunk.scoreList]).toEqual([100, -1000, 100, 0]);
        expect([...result.chunk.sequenceList]).toEqual([1, 2, 1, 3]);
        expect(result.chunk.preparedLookupIndexes?.size).toBeGreaterThan(0);
        const {preparedLookupIndexEncodeMs: _elapsed, ...chunk} = result.chunk;
        results.push({type: result.type, rowCount: result.rowCount, chunk});
    }
    expect(results[1]).toEqual(results[0]);
}, 10_000);
