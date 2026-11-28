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
import {crc32, deflateRawSync, inflateRawSync} from 'node:zlib';
import {afterEach, beforeAll, describe, expect, test, vi} from 'vitest';
import {inflateCompressedTermBankSourcesWasm, setTermBankWasmModule} from '../ext/js/dictionary/term-bank-wasm-parser.js';

const encoder = new TextEncoder();
const NativeDecompressionStream = DecompressionStream;
const paddedEmptyBank = ' '.repeat(64) + '[]';

/**
 * Node accepts concatenated members. This small test decoder supplies the Web
 * API's strict member boundary; the actual browser decoder is covered in CI.
 * @param {CompressionFormat} format
 * @param {((chunk: Uint8Array) => void)|null} [onChunk]
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
function strictGzipStream(format, onChunk = null) {
    if (format !== 'gzip') { throw new TypeError('Expected gzip'); }
    /** @type {Uint8Array[]} */
    const chunks = [];
    return new TransformStream({
        transform(chunk) {
            onChunk?.(chunk);
            chunks.push(Uint8Array.from(chunk));
        },
        flush(controller) {
            const bytes = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.byteLength, 0));
            let offset = 0;
            for (const chunk of chunks) {
                bytes.set(chunk, offset);
                offset += chunk.byteLength;
            }
            const result = /** @type {{buffer: Buffer, engine: {bytesWritten: number}}} */ (
                /** @type {unknown} */ (inflateRawSync(bytes.subarray(10), {info: true}))
            );
            if (result.engine.bytesWritten !== bytes.length - 18) { throw new TypeError('Trailing gzip input'); }
            const trailer = new DataView(bytes.buffer, bytes.length - 8);
            if (crc32(result.buffer) !== trailer.getUint32(0, true) || result.buffer.length !== trailer.getUint32(4, true)) {
                throw new TypeError('Invalid gzip trailer');
            }
            controller.enqueue(new Uint8Array(result.buffer));
        },
    });
}

/**
 * @param {string} text
 * @param {0|8} [method]
 * @returns {import('../ext/js/dictionary/term-bank-wasm-parser.js').CompressedTermBankSource}
 */
function source(text, method = 8) {
    const decoded = encoder.encode(text);
    const bytes = method === 8 ? new Uint8Array(deflateRawSync(decoded)) : decoded;
    return {bytes, compressionMethod: method, compressedSize: bytes.length, uncompressedSize: decoded.length, signature: crc32(decoded)};
}

/**
 * @param {Awaited<ReturnType<typeof inflateCompressedTermBankSourcesWasm>>} result
 * @returns {{bytes: Uint8Array, spans: number[], count: number}}
 */
function snapshot(result) {
    return {
        bytes: Uint8Array.from(new Uint8Array(result.wasm.memory.buffer, result.jsonPtr, result.jsonLength)),
        spans: [...new Uint32Array(result.wasm.memory.buffer, result.bankSpansPtr, (result.bankSpanCount ?? 0) * 2)],
        count: result.sourceCount,
    };
}

/**
 * @param {Parameters<typeof inflateCompressedTermBankSourcesWasm>[0]} sources
 * @returns {Promise<{name: string, message: string}>}
 */
async function failure(sources) {
    try {
        await inflateCompressedTermBankSourcesWasm(sources);
    } catch (error) {
        if (error instanceof Error) { return {name: error.name, message: error.message}; }
        throw error;
    }
    throw new Error('Expected source validation to reject');
}

beforeAll(async () => {
    setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))));
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('native gzip validation of raw ZIP term banks', () => {
    test.each([
        ['single compact', ['[["猫","ねこ","","",0,["cat"],1,""]]'], false],
        ['single padded', [' \n[ \t["猫","ねこ","","",0,["cat"],1,""] \r]\n '], false],
        ['single empty', [paddedEmptyBank], false],
        ['independent banks', ['[ ["a","","","",0,["A"],1,""] ]', paddedEmptyBank, '[["b","","","",0,["B"],2,""]]'], false],
        ['explicit single boundary', [' \t[ ["a","","","",0,["A"],1,""] ]\n'], true],
    ])('matches the native parser arena for %s', async (_name, texts, forceSpans) => {
        const sources = texts.map((text) => source(text));
        const options = {experimentalTermBankSpans: forceSpans};
        const baseline = await inflateCompressedTermBankSourcesWasm(sources, options);
        const expected = snapshot(baseline);
        const wasmInflate = vi.spyOn(baseline.wasm, 'inflate_and_join_term_banks');
        const constructors = vi.fn(function strictStream(/** @type {CompressionFormat} */ format) { return strictGzipStream(format); });
        vi.stubGlobal('DecompressionStream', constructors);
        vi.stubGlobal('__manabitanTermBankParserWorker', true);
        const result = await inflateCompressedTermBankSourcesWasm(sources, options);
        expect(snapshot(result)).toEqual(expected);
        expect(result.compressedBytes).toBe(sources.reduce((sum, item) => sum + item.compressedSize, 0));
        expect(result.uncompressedBytes).toBe(sources.reduce((sum, item) => sum + item.uncompressedSize, 0));
        expect(constructors).toHaveBeenCalledTimes(sources.length + 2);
        expect(wasmInflate).not.toHaveBeenCalled();
    });

    test.each(['crc', 'short-size', 'long-size', 'truncated', 'trailing', 'array-wrapper'])('preserves the existing %s error', async (kind) => {
        const item = source(kind === 'array-wrapper' ? '{"bad":[]}' : '[["a","","","",0,["x"],1,""]]');
        if (kind === 'crc') { item.signature = (item.signature ^ 1) >>> 0; }
        if (kind === 'short-size') { --item.uncompressedSize; }
        if (kind === 'long-size') { ++item.uncompressedSize; }
        if (kind === 'truncated') {
            item.bytes = item.bytes.slice(0, -2);
            item.compressedSize = item.bytes.length;
        }
        if (kind === 'trailing') {
            item.bytes = Uint8Array.from([...item.bytes, 0xde, 0xad]);
            item.compressedSize = item.bytes.length;
        }
        const sources = [source(paddedEmptyBank), item, source(paddedEmptyBank)];
        const expected = await failure(sources);
        vi.stubGlobal('DecompressionStream', function strictStream(/** @type {CompressionFormat} */ format) { return strictGzipStream(format); });
        vi.stubGlobal('__manabitanTermBankParserWorker', true);
        expect(await failure(sources)).toEqual(expected);
    });

    test('preserves the first bank failure when CRC and DEFLATE failures coexist', async () => {
        const badCrc = source(paddedEmptyBank);
        badCrc.signature = (badCrc.signature ^ 1) >>> 0;
        const badDeflate = source(paddedEmptyBank);
        badDeflate.bytes = badDeflate.bytes.slice(0, -2);
        badDeflate.compressedSize = badDeflate.bytes.length;
        vi.stubGlobal('DecompressionStream', function strictStream(/** @type {CompressionFormat} */ format) { return strictGzipStream(format); });
        for (const sources of [[badCrc, badDeflate], [badDeflate, badCrc]]) {
            vi.stubGlobal('__manabitanTermBankParserWorker', false);
            const expected = await failure(sources);
            vi.stubGlobal('__manabitanTermBankParserWorker', true);
            expect(await failure(sources)).toEqual(expected);
        }
    });

    test('rejects raw payloads that become concatenated gzip members', async () => {
        const item = source(`[${Array.from({length: 8}, () => '["a","","","",0,["x"],1,""]').join(',')}]`);
        // A permissive gzip decoder accepts an empty first member and then the
        // real bank. The combined output still has the bank's exact CRC/size,
        // so output checks alone cannot prove complete raw-DEFLATE consumption.
        item.bytes = Uint8Array.from([
            ...deflateRawSync(new Uint8Array(0)),
            ...new Uint8Array(8),
            ...new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255]),
            ...item.bytes,
        ]);
        item.compressedSize = item.bytes.length;
        expect(item.compressedSize).toBeLessThanOrEqual(item.uncompressedSize);
        const expected = await failure([item]);
        expect(expected.name).toBe('DictionarySourceIntegrityError');
        expect(expected.message).toContain('inflated size does not match ZIP metadata');
        vi.stubGlobal('__manabitanTermBankParserWorker', true);
        expect(await failure([item])).toEqual(expected);
    });

    test('disables a permissive gzip implementation after one cached capability check', async () => {
        const sources = [source(paddedEmptyBank)];
        const baseline = await inflateCompressedTermBankSourcesWasm(sources);
        const expected = snapshot(baseline);
        const wasmInflate = vi.spyOn(baseline.wasm, 'inflate_and_join_term_banks');
        const constructors = vi.fn(function permissiveStream(/** @type {CompressionFormat} */ format) { return new NativeDecompressionStream(format); });
        vi.stubGlobal('DecompressionStream', constructors);
        vi.stubGlobal('__manabitanTermBankParserWorker', true);
        expect(snapshot(await inflateCompressedTermBankSourcesWasm(sources))).toEqual(expected);
        expect(snapshot(await inflateCompressedTermBankSourcesWasm(sources))).toEqual(expected);
        expect(constructors).toHaveBeenCalledTimes(2);
        expect(wasmInflate).toHaveBeenCalledTimes(2);
    });

    test('bounds compressed input bursts against the declared output', async () => {
        const sources = [source(JSON.stringify([['a', '', '', '', 0, ['x'.repeat(8192)], 1, '']]))];
        const expected = snapshot(await inflateCompressedTermBankSourcesWasm(sources));
        /** @type {number[]} */
        const chunks = [];
        let calls = 0;
        vi.stubGlobal('DecompressionStream', function strictStream(/** @type {CompressionFormat} */ format) {
            ++calls;
            return strictGzipStream(format, calls > 2 ? (chunk) => { chunks.push(chunk.byteLength); } : null);
        });
        vi.stubGlobal('__manabitanTermBankParserWorker', true);
        expect(snapshot(await inflateCompressedTermBankSourcesWasm(sources))).toEqual(expected);
        expect(chunks[0]).toBe(10);
        expect(chunks.at(-1)).toBe(8);
        const payload = chunks.slice(1, -1);
        expect(payload.length).toBeGreaterThan(1);
        expect(payload.reduce((sum, length) => sum + length, 0)).toBe(sources[0].compressedSize);
        expect(payload.every((length) => length * 1032 <= sources[0].uncompressedSize)).toBe(true);
    });

    test.each(['unsupported', 'mixed', 'outside-worker', 'expanding-deflate'])('retains the WASM route for %s sources', async (kind) => {
        const sources = [source(paddedEmptyBank), source(kind === 'expanding-deflate' ? '[]' : paddedEmptyBank, kind === 'mixed' ? 0 : 8)];
        const baseline = await inflateCompressedTermBankSourcesWasm(sources);
        const expected = snapshot(baseline);
        const wasmInflate = vi.spyOn(baseline.wasm, 'inflate_and_join_term_banks');
        vi.stubGlobal('__manabitanTermBankParserWorker', kind !== 'outside-worker');
        const constructors = vi.fn(() => { throw new TypeError('unsupported'); });
        vi.stubGlobal('DecompressionStream', constructors);
        expect(snapshot(await inflateCompressedTermBankSourcesWasm(sources))).toEqual(expected);
        expect(wasmInflate).toHaveBeenCalledOnce();
        expect(constructors).toHaveBeenCalledTimes(kind === 'unsupported' ? 1 : 0);
    });
});

describe('native writer and reader settlement', () => {
    test('releases the reader if acquiring the writer fails before fallback', async () => {
        const sources = [source(paddedEmptyBank)];
        const baseline = await inflateCompressedTermBankSourcesWasm(sources);
        const expected = snapshot(baseline);
        const readable = new ReadableStream();
        const writable = new WritableStream();
        const injected = new Error('Injected writer acquisition failure');
        vi.spyOn(writable, 'getWriter').mockImplementation(() => { throw injected; });
        const originalInflate = baseline.wasm.inflate_and_join_term_banks;
        const wasmInflate = vi.spyOn(baseline.wasm, 'inflate_and_join_term_banks').mockImplementation((...args) => {
            expect(readable.locked).toBe(false);
            expect(writable.locked).toBe(false);
            return originalInflate(...args);
        });
        let instances = 0;
        vi.stubGlobal('DecompressionStream', function strictThenControlled(/** @type {CompressionFormat} */ format) {
            return ++instances <= 2 ? strictGzipStream(format) : {readable, writable};
        });
        vi.stubGlobal('__manabitanTermBankParserWorker', true);
        expect(snapshot(await inflateCompressedTermBankSourcesWasm(sources))).toEqual(expected);
        expect(instances).toBe(3);
        expect(wasmInflate).toHaveBeenCalledOnce();
    });

    test.each(['header', 'payload', 'trailer', 'close'])('joins reader cancellation after a %s failure before fallback', async (phase) => {
        const sources = [source(paddedEmptyBank)];
        const baseline = await inflateCompressedTermBankSourcesWasm(sources);
        const expected = snapshot(baseline);
        const wasmReset = vi.spyOn(baseline.wasm, 'wasm_reset_heap');
        const wasmInflate = vi.spyOn(baseline.wasm, 'inflate_and_join_term_banks');
        const cancelEntered = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        const cancelGate = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        const injected = new Error(`Injected ${phase} failure`);
        let cancelSettled = false;
        let writes = 0;
        const readable = new ReadableStream({
            async cancel(reason) {
                expect(reason).toBe(injected);
                cancelEntered.resolve();
                await cancelGate.promise;
                cancelSettled = true;
                if (phase === 'close') { throw new Error('Injected cancellation rejection'); }
            },
        });
        const writable = new WritableStream({
            write(chunk) {
                ++writes;
                if ((phase === 'header' && writes === 1) || (phase === 'payload' && writes === 2) ||
                (phase === 'trailer' && chunk.byteLength === 8)) { throw injected; }
            },
            close() { throw injected; },
        });
        let instances = 0;
        const constructors = vi.fn(function strictThenControlled(/** @type {CompressionFormat} */ format) {
            return ++instances <= 2 ? strictGzipStream(format) : {readable, writable};
        });
        vi.stubGlobal('DecompressionStream', constructors);
        vi.stubGlobal('__manabitanTermBankParserWorker', true);
        const operation = inflateCompressedTermBankSourcesWasm(sources);
        let settled = false;
        void operation.then(
            () => { settled = true; },
            () => { settled = true; },
        );
        try {
            await cancelEntered.promise;
            await new Promise((resolve) => { setImmediate(resolve); });
            expect(settled).toBe(false);
            expect(wasmReset).toHaveBeenCalledOnce();
            expect(wasmInflate).not.toHaveBeenCalled();
            expect(readable.locked).toBe(true);
            expect(writable.locked).toBe(true);
        } finally {
            cancelGate.resolve();
        }
        expect(snapshot(await operation)).toEqual(expected);
        expect(constructors).toHaveBeenCalledTimes(3);
        expect(cancelSettled).toBe(true);
        expect(readable.locked).toBe(false);
        expect(writable.locked).toBe(false);
        expect(wasmReset).toHaveBeenCalledTimes(2);
        expect(wasmInflate).toHaveBeenCalledOnce();
    });

    test.each([false, true])('joins an in-flight write and abort after a read failure (abort rejects: %s)', async (abortRejects) => {
        const sources = [source(paddedEmptyBank)];
        const baseline = await inflateCompressedTermBankSourcesWasm(sources);
        const expected = snapshot(baseline);
        const wasmReset = vi.spyOn(baseline.wasm, 'wasm_reset_heap');
        const wasmInflate = vi.spyOn(baseline.wasm, 'inflate_and_join_term_banks');
        const writeGate = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        const abortRequested = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        const abortEntered = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        const abortGate = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        const injected = new Error('Injected native read failure');
        let failRead = () => {};
        let writes = 0;
        let writeSettled = false;
        let abortSettled = false;
        const readable = new ReadableStream({
            start(controller) { failRead = () => { controller.error(injected); }; },
        });
        const writable = new WritableStream({
            async write() {
                ++writes;
                failRead();
                await writeGate.promise;
                writeSettled = true;
            },
            async abort(reason) {
                expect(reason).toBe(injected);
                abortEntered.resolve();
                await abortGate.promise;
                abortSettled = true;
                if (abortRejects) { throw new Error('Injected abort rejection'); }
            },
        });
        const getWriter = writable.getWriter.bind(writable);
        vi.spyOn(writable, 'getWriter').mockImplementation(() => {
            const writer = getWriter();
            const abort = writer.abort.bind(writer);
            vi.spyOn(writer, 'abort').mockImplementation((reason) => {
                abortRequested.resolve();
                return abort(reason);
            });
            return writer;
        });
        let instances = 0;
        vi.stubGlobal('DecompressionStream', function strictThenControlled(/** @type {CompressionFormat} */ format) {
            return ++instances <= 2 ? strictGzipStream(format) : {readable, writable};
        });
        vi.stubGlobal('__manabitanTermBankParserWorker', true);
        const operation = inflateCompressedTermBankSourcesWasm(sources);
        let settled = false;
        void operation.then(
            () => { settled = true; },
            () => { settled = true; },
        );
        try {
            await abortRequested.promise;
            expect(writeSettled).toBe(false);
            expect(wasmReset).toHaveBeenCalledOnce();
            expect(wasmInflate).not.toHaveBeenCalled();
            writeGate.resolve();
            await abortEntered.promise;
            await new Promise((resolve) => { setImmediate(resolve); });
            expect(settled).toBe(false);
            expect(writeSettled).toBe(true);
            expect(abortSettled).toBe(false);
            expect(wasmReset).toHaveBeenCalledOnce();
            expect(wasmInflate).not.toHaveBeenCalled();
        } finally {
            writeGate.resolve();
            abortGate.resolve();
        }
        expect(snapshot(await operation)).toEqual(expected);
        expect(instances).toBe(3);
        expect(writes).toBe(1);
        expect(abortSettled).toBe(true);
        expect(readable.locked).toBe(false);
        expect(writable.locked).toBe(false);
        expect(wasmReset).toHaveBeenCalledTimes(2);
        expect(wasmInflate).toHaveBeenCalledOnce();
    });

    test.each([false, true])('waits for writer close after readable EOF (close rejects: %s)', async (closeRejects) => {
        const sources = [source(paddedEmptyBank)];
        const baseline = await inflateCompressedTermBankSourcesWasm(sources);
        const expected = snapshot(baseline);
        const wasmInflate = vi.spyOn(baseline.wasm, 'inflate_and_join_term_banks');
        const closeEntered = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        const closeGate = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        let closeSettled = false;
        const readable = new ReadableStream({
            start(controller) {
                controller.enqueue(encoder.encode(paddedEmptyBank));
                controller.close();
            },
        });
        const writable = new WritableStream({
            async close() {
                closeEntered.resolve();
                await closeGate.promise;
                closeSettled = true;
                if (closeRejects) { throw new Error('Injected late close failure'); }
            },
        });
        let instances = 0;
        vi.stubGlobal('DecompressionStream', function strictThenControlled(/** @type {CompressionFormat} */ format) {
            return ++instances <= 2 ? strictGzipStream(format) : {readable, writable};
        });
        vi.stubGlobal('__manabitanTermBankParserWorker', true);
        const operation = inflateCompressedTermBankSourcesWasm(sources);
        let settled = false;
        void operation.then(
            () => { settled = true; },
            () => { settled = true; },
        );
        try {
            await closeEntered.promise;
            await new Promise((resolve) => { setImmediate(resolve); });
            expect(settled).toBe(false);
            expect(wasmInflate).not.toHaveBeenCalled();
        } finally {
            closeGate.resolve();
        }
        expect(snapshot(await operation)).toEqual(expected);
        expect(instances).toBe(3);
        expect(closeSettled).toBe(true);
        expect(readable.locked).toBe(false);
        expect(writable.locked).toBe(false);
        expect(wasmInflate).toHaveBeenCalledTimes(closeRejects ? 1 : 0);
    });
});
