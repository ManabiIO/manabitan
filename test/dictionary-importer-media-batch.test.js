/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import {readFile} from 'node:fs/promises';
import {crc32, deflateRawSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {describe, expect, test, vi} from 'vitest';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';
import {RawZipPayloadReader} from '../ext/js/dictionary/term-bank-source-pipeline.js';

// Native WASM initialization is intentionally isolated from media-prefetch
// fixtures, which exercise the fallback importer with a minimal database.
describe('bounded media ZIP batching', () => {
    test.each(['ranged-blob', 'owned-buffer', 'cached-blob'])('resolves a %s image through a CRC-checked coalesced WASM batch', async (storage) => {
        const filename = new TextEncoder().encode('image0.png');
        const expected = Uint8Array.of(2, 9, 255);
        const compressed = Uint8Array.from(deflateRawSync(expected));
        const header = new Uint8Array(30 + filename.byteLength);
        const view = new DataView(header.buffer);
        view.setUint32(0, 0x04034b50, true);
        view.setUint16(8, 8, true);
        view.setUint16(26, filename.byteLength, true);
        header.set(filename, 30);
        const backing = new Blob([header, compressed, new Uint8Array(140_000)]);
        class LargeBlob extends Blob {
            /**
             * @override
             * @returns {number}
             */
            get size() { return 129 * 1024 * 1024; }
            /**
             * @override
             * @param {number} [start]
             * @param {number} [end]
             * @param {string} [type]
             * @returns {Blob}
             */
            slice(start = 0, end = this.size, type = '') {
                return backing.slice(start, Math.min(end, backing.size), type);
            }
        }
        /** @type {ArrayBuffer|Blob} */
        let archiveContent = backing;
        if (storage === 'ranged-blob') { archiveContent = new LargeBlob(); }
        if (storage === 'owned-buffer') { archiveContent = await backing.arrayBuffer(); }
        const originalFetch = globalThis.fetch;
        vi.stubGlobal('fetch', async (/** @type {RequestInfo|URL} */ resource) => {
            const url = resource instanceof URL ? resource : new URL(String(resource));
            return url.protocol === 'file:' ? new Response(await readFile(fileURLToPath(url))) : await originalFetch(resource);
        });
        const file = {
            filename: 'image0.png',
            rawFilename: filename,
            offset: 0,
            compressedSize: compressed.byteLength,
            uncompressedSize: expected.byteLength,
            compressionMethod: 8,
            signature: crc32(expected) >>> 0,
            getData() { throw new Error('zip.js fallback should not run for an eligible batch entry'); },
        };
        const rawReader = new RawZipPayloadReader(archiveContent);
        if (storage === 'cached-blob') {
            expect(rawReader.supportsBatchReads()).toBe(false);
            await rawReader.read(file, new AbortController().signal);
        }
        expect(rawReader.supportsBatchReads()).toBe(true);
        expect(rawReader.supportsCachedBatchReads()).toBe(storage !== 'ranged-blob');
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        Reflect.set(importer, '_skipImageMetadata', true);
        const entry = {dictionary: 'Media test', expression: 'term', reading: '', definitionTags: '', rules: '', score: 0, glossary: []};
        /** @type {import('dictionary-importer').ImportRequirement} */
        const requirement = {type: 'image', source: {type: 'image', path: 'image0.png'}, target: {type: 'image', path: ''}, entry};
        const fileMap = /** @type {import('dictionary-importer').ArchiveFileMap} */ (/** @type {unknown} */ (new Map([['image0.png', file]])));
        const metrics = {
            mediaZipBatchReadMs: 0,
            mediaZipBatchInflateMs: 0,
            mediaZipBatchCount: 0,
            mediaZipBatchEntryCount: 0,
            mediaZipBatchRangeBytes: 0,
            mediaZipBatchCompressedBytes: 0,
            mediaZipBatchUncompressedBytes: 0,
        };
        /** @type {import('dictionary-database').MediaDataArrayBufferContent[][]} */
        const written = [];
        try {
            const count = await importer._importDeferredMediaRequirements(
                [requirement],
                [],
                fileMap,
                async (media) => { written.push(media); },
                rawReader,
                metrics,
            );
            expect(count).toBe(1);
            expect(written).toHaveLength(1);
            expect(new Uint8Array(written[0][0].content)).toEqual(expected);
            expect(metrics.mediaZipBatchCount).toBe(1);
            expect(metrics.mediaZipBatchEntryCount).toBe(1);
            expect(metrics.mediaZipBatchUncompressedBytes).toBe(expected.byteLength);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});
