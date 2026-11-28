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

import {afterEach, describe, expect, test, vi} from 'vitest';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import * as parser from '../ext/js/dictionary/term-bank-wasm-parser.js';
import {createArtifactTermChunkSinkCompletion, takeArtifactTermChunkSinkCompletion} from '../ext/js/dictionary/term-content-ownership.js';
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';

/** @typedef {Parameters<DictionaryImporter['_readTermBankFileFast']>[8]} Sources */
/** @typedef {Parameters<typeof parser.parseTermBankWithWasmColumnChunksParallel>[2]} ParallelCallback */

const source = new TextEncoder().encode('[]');
const file = /** @type {import('@zip.js/zip.js').Entry} */ (/** @type {unknown} */ ({filename: 'term_bank_1.json'}));
const chunk = /** @type {import('../ext/js/dictionary/term-bank-wasm-parser.js').TermBankColumnChunk} */ (
    /** @type {unknown} */ ({rowCount: 1, mediaRows: [], contentBytesBuffer: new Uint8Array([1, 2, 3])})
);
const progress = {processedRows: 1, totalRows: 1, chunkIndex: 0, chunkCount: 1};

/** @returns {{promise: Promise<void>, resolve: () => void, reject: (reason: unknown) => void}} */
function deferred() {
    /** @type {() => void} */
    let resolve = () => {};
    /** @type {(reason: unknown) => void} */
    let reject = () => {};
    /** @type {Promise<void>} */
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    void promise.catch(() => {});
    return {promise, resolve, reject};
}

/**
 * Native parsing is controlled here so the actual importer callback adapters can
 * be tested independently of worker availability. Parser lifetime and actual
 * storage ordering are covered by the adjacent pipeline and database suites.
 * @param {'array'|'deferred'|'lazy'|'compressed'} mode
 * @returns {Sources}
 */
function createSources(mode) {
    switch (mode) {
        case 'array': return [source];
        case 'deferred':
            return /** @type {Sources} */ (/** @type {unknown} */ ({
                promises: [Promise.resolve(source)],
                estimatedByteLengths: [source.byteLength],
                readAll: async () => [source],
            }));
        case 'lazy': return {loaders: [async () => source], estimatedByteLengths: [source.byteLength]};
        case 'compressed':
            return {
                compressed: true,
                estimatedByteLengths: [source.byteLength],
                loaders: [async () => ({bytes: source, compressionMethod: 0, compressedSize: source.byteLength, uncompressedSize: source.byteLength, signature: 0, filename: file.filename})],
            };
    }
}

afterEach(() => { vi.restoreAllMocks(); });

describe('importer completion-ticket adapters', () => {
    test.each([
        {name: 'numeric result', value: 12},
        {name: 'ordinary object', value: {completed: true}},
        {name: 'incidental completion', value: {completion: deferred().promise}},
        {name: 'completion getter', value: Object.defineProperty({}, 'completion', {get: () => { throw new Error('Incidental property was read'); }})},
        {name: 'fulfilled ordinary promise', value: Promise.resolve({completion: deferred().promise})},
    ])('ignores the legacy $name without creating a storage ticket', async ({value}) => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const parallel = vi.spyOn(parser, 'parseTermBankWithWasmColumnChunksParallel').mockImplementation(async (_sources, _version, callback) => {
            const result = await callback(chunk, progress);
            expect(result).toBeUndefined();
            expect(takeArtifactTermChunkSinkCompletion(result)).toBeNull();
            return true;
        });
        await expect(importer._readTermBankFileFast(
            file, 3, 'Legacy callback result', false, false, true, 'raw-bytes', () => value, [source],
        )).resolves.toEqual({termList: [], requirements: null});
        expect(parallel).toHaveBeenCalledTimes(1);
    });

    test.each(/** @type {const} */ (['array', 'deferred', 'lazy', 'compressed']))('forwards pending completion through the %s parallel callback', async (mode) => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const completed = deferred();
        const published = deferred();
        let readSettled = false;
        let now = 10;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        /**
         * @param {ParallelCallback} callback
         * @returns {Promise<boolean>}
         */
        const consume = async (callback) => {
            const result = await callback(chunk, progress);
            const completion = takeArtifactTermChunkSinkCompletion(result);
            expect(completion).not.toBeNull();
            if (completion === null) { throw new Error('Parallel adapter lost authentic completion'); }
            published.resolve();
            await completion;
            return true;
        };
        const direct = vi.spyOn(parser, 'parseTermBankWithWasmColumnChunksParallel').mockImplementation(async (_sources, _version, callback) => await consume(callback));
        const deferredParser = vi.spyOn(parser, 'parseTermBankWithWasmColumnChunksParallelDeferred').mockImplementation(async (_sources, _lengths, _version, callback) => await consume(callback));
        const lazy = vi.spyOn(parser, 'parseTermBankWithWasmColumnChunksParallelLazy').mockImplementation(async (_sources, _lengths, _version, callback) => await consume(callback));
        const compressed = vi.spyOn(parser, 'parseTermBankWithWasmColumnChunksParallelCompressedLazy').mockImplementation(async (_sources, _lengths, _version, callback) => await consume(callback));
        const read = importer._readTermBankFileFast(file, 3, 'Completion test', false, false, true, 'raw-bytes', () => createArtifactTermChunkSinkCompletion(completed.promise), createSources(mode));
        void read.then(
            () => { readSettled = true; },
            () => { readSettled = true; },
        );

        await published.promise;
        expect(readSettled).toBe(false);
        expect(Reflect.get(importer, '_lastFastTermBankReadProfile')).toBeNull();
        const selected = {array: direct, deferred: deferredParser, lazy, compressed}[mode];
        expect(selected).toHaveBeenCalledTimes(1);
        expect([direct, deferredParser, lazy, compressed].reduce((count, mock) => count + mock.mock.calls.length, 0)).toBe(1);

        now = 110;
        completed.resolve();
        await expect(read).resolves.toEqual({termList: [], requirements: null});
        expect(Reflect.get(importer, '_lastFastTermBankReadProfile')).toMatchObject({chunkSinkMs: 100, chunkCount: 1, totalRows: 1});
    });

    test.each([false, true])('retains the completion-only native callback contract, overlapped=%s', async (overlapped) => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const completed = deferred();
        const entered = deferred();
        let callbackReturned = false;
        vi.spyOn(parser, 'parseTermBankWithWasmColumnChunksParallel').mockResolvedValue(false);
        /**
         * @param {Parameters<typeof parser.parseTermBankWithWasmColumnChunks>[2]} callback
         * @returns {Promise<void>}
         */
        const consume = async (callback) => {
            const result = await callback(chunk, progress);
            expect(result).toBeUndefined();
            callbackReturned = true;
        };
        const sequentialParser = vi.spyOn(parser, 'parseTermBankWithWasmColumnChunks').mockImplementation(async (_sources, _version, callback) => { await consume(callback); });
        const overlappedParser = vi.spyOn(parser, 'parseTermBankWithWasmColumnChunksOverlapped').mockImplementation(async (_sources, _version, callback) => {
            await consume(callback);
            return true;
        });
        const read = importer._readTermBankFileFast(file, 3, 'Completion test', false, false, true, 'raw-bytes', () => {
            entered.resolve();
            return createArtifactTermChunkSinkCompletion(completed.promise);
        }, overlapped ? [source] : source);

        await entered.promise;
        expect(callbackReturned).toBe(false);
        completed.resolve();
        await read;
        expect(callbackReturned).toBe(true);
        expect(overlapped ? overlappedParser : sequentialParser).toHaveBeenCalledTimes(1);
        expect(overlapped ? sequentialParser : overlappedParser).not.toHaveBeenCalled();
    });

    test('propagates a failure occurring after a parallel publication ticket', async () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const completed = deferred();
        const published = deferred();
        const failure = new Error('record persistence failed after publication');
        vi.spyOn(parser, 'parseTermBankWithWasmColumnChunksParallel').mockImplementation(async (_sources, _version, callback) => {
            const result = await callback(chunk, progress);
            const completion = takeArtifactTermChunkSinkCompletion(result);
            if (completion === null) { throw new Error('Missing authentic completion'); }
            published.resolve();
            await completion;
            return true;
        });
        const read = importer._readTermBankFileFast(file, 3, 'Completion test', false, false, true, 'raw-bytes', () => createArtifactTermChunkSinkCompletion(completed.promise), [source]);
        const rejection = expect(read).rejects.toBe(failure);
        await published.promise;
        completed.reject(failure);
        await rejection;
        expect(Reflect.get(importer, '_lastFastTermBankReadProfile')).toBeNull();
    });
});
