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

import {afterAll, beforeAll, describe, expect, test, vi} from 'vitest';
import {existsSync, openAsBlob} from 'node:fs';
import {mkdir, mkdtemp, open, readFile} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import path from 'node:path';
import {crc32, deflateRawSync, inflateRawSync} from 'node:zlib';
import {preparePackedSourceZipMedia} from '../ext/js/dictionary/source-zip-media-pack.js';
import {inflateCompressedTermBankSourcesWasm, setTermBankWasmModule} from '../ext/js/dictionary/term-bank-wasm-parser.js';
import {AbortableZipReadPool, RawZipPayloadReader, TermBankSourcePipeline} from '../ext/js/dictionary/term-bank-source-pipeline.js';
import {moveFixtureToTrash} from './util/move-fixture-to-trash.js';

const limit = 128 * 1024 * 1024;
const encoder = new TextEncoder();
const name = encoder.encode('term_bank_1.json');
const content = encoder.encode('["日本語", "escaped\\ntext"]');
/** @type {string} */
let directory;
/** @type {Blob} */
let padding;

beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'manabitan-zip-ranges-'));
    const filename = path.join(directory, 'sparse');
    const file = await open(filename, 'w');
    try {
        await file.truncate(limit + 1);
    } finally {
        await file.close();
    }
    padding = await openAsBlob(filename);
});
afterAll(async () => {
    const trash = path.join(homedir(), '.Trash');
    await mkdir(trash, {recursive: true});
    const destination = await mkdtemp(path.join(trash, 'manabitan-zip-ranges-'));
    moveFixtureToTrash(directory, path.join(destination, 'fixture'));
});

/** Real Blob I/O with byte-range accounting; no replacement ZIP/parser. */
class TrackedBlob extends Blob {
    /** @type {number[][]} */
    ranges = [];
    /**
     * @override
     * @returns {Promise<ArrayBuffer>}
     */
    async arrayBuffer() { throw new Error('Whole archive must not be materialized'); }
    /**
     * @override
     * @param {number} [start]
     * @param {number} [end]
     * @param {string} [type]
     * @returns {Blob}
     */
    slice(start = 0, end = this.size, type = '') {
        this.ranges.push([start, end]);
        return super.slice(start, end, type);
    }
}

/**
 * @param {BlobPart[]} parts
 * @returns {{archive: TrackedBlob, started: Promise<void>, release: () => void}}
 */
function delayedArchive(parts) {
    /** @type {() => void} */
    let release = () => {};
    const gate = new Promise((resolve) => { release = () => resolve(void 0); });
    /** @type {() => void} */
    let entered = () => {};
    const started = new Promise((resolve) => { entered = () => resolve(void 0); });
    class DelayedRange extends Blob {
        /**
         * @override
         * @returns {Promise<ArrayBuffer>}
         */
        async arrayBuffer() {
            const bytes = await super.arrayBuffer();
            entered();
            await gate;
            return bytes;
        }
    }
    class DelayedArchive extends TrackedBlob {
        /**
         * @override
         * @param {number} [start]
         * @param {number} [end]
         * @param {string} [type]
         * @returns {Blob}
         */
        slice(start, end, type) { return new DelayedRange([super.slice(start, end, type)]); }
    }
    return {archive: new DelayedArchive(parts), started, release};
}

/**
 * @param {number} method
 * @param {number} [extraLength]
 * @returns {{header: Uint8Array, payload: Uint8Array, file: {filename: string, rawFilename: Uint8Array, offset: number, compressionMethod: number, compressedSize: number, uncompressedSize: number, signature: number, getData: () => void}}}
 */
function entry(method, extraLength = 0) {
    const payload = method === 0 ? content : new Uint8Array(deflateRawSync(content));
    const header = new Uint8Array(30 + name.length + extraLength);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(6, 8, true); // central metadata authoritative with data descriptors
    view.setUint16(8, method, true);
    view.setUint16(26, name.length, true);
    view.setUint16(28, extraLength, true);
    header.set(name, 30);
    return {header,
        payload,
        file: {
            filename: 'term_bank_1.json',
            rawFilename: name,
            offset: 0,
            compressionMethod: method,
            compressedSize: payload.length,
            uncompressedSize: content.length,
            signature: 0,
            getData() {},
        }};
}

/** @returns {AbortSignal} */
function signal() { return new AbortController().signal; }

/**
 * @param {number} count
 * @param {number} [extraLength]
 * @returns {ReturnType<typeof entry>[]}
 */
function contiguousEntries(count, extraLength = 0) {
    let offset = 0;
    return Array.from({length: count}, (_, index) => {
        const source = entry(8, extraLength);
        const filename = `term_bank_${index + 1}.json`;
        const rawFilename = encoder.encode(filename);
        const header = new Uint8Array(30 + rawFilename.length + extraLength);
        header.set(source.header.subarray(0, 30));
        new DataView(header.buffer).setUint16(26, rawFilename.length, true);
        header.set(rawFilename, 30);
        source.header = header;
        Object.assign(source.file, {filename, rawFilename, offset, signature: crc32(content)});
        offset += header.byteLength + source.payload.byteLength;
        return source;
    });
}

describe('coalesced admitted compressed-source reads', () => {
    test('counts actual dispatched ranges and leaves cached whole-archive reads at zero', async () => {
        const sources = contiguousEntries(4);
        const parts = sources.flatMap(({header, payload}) => [header, payload]);
        const cached = new RawZipPayloadReader(new Blob(parts));
        await Promise.all(sources.map(({file}) => cached.read(file, signal(), true)));
        expect(cached.getCoalescedRangeReadCounts()).toEqual({logicalRequests: 0, physicalRanges: 0});
        const {archive, started, release} = delayedArchive([...parts, padding]);
        const reader = new RawZipPayloadReader(archive);
        const reads = Promise.all(sources.map(({file}) => reader.read(file, signal(), true)));
        try {
            expect(reader.getCoalescedRangeReadCounts()).toEqual({logicalRequests: 0, physicalRanges: 0});
            await started;
            expect(reader.getCoalescedRangeReadCounts()).toEqual({logicalRequests: 4, physicalRanges: 1});
        } finally { release(); }
        await reads;
        expect(reader.getCoalescedRangeReadCounts()).toEqual({logicalRequests: 4, physicalRanges: archive.ranges.length});
    });

    test('reduces adjacent reads without reading additional bytes or sharing transferable payloads', async () => {
        const sources = contiguousEntries(4);
        const parts = sources.flatMap(({header, payload}) => [header, payload]);
        const baseline = new TrackedBlob([...parts, padding]);
        const candidate = new TrackedBlob([...parts, padding]);
        const direct = new RawZipPayloadReader(baseline);
        const coalesced = new RawZipPayloadReader(candidate);
        const expected = await Promise.all(sources.map(({file}) => direct.read(file, signal())));
        const actual = await Promise.all(sources.map(({file}) => coalesced.read(file, signal(), true)));
        expect(actual).toEqual(expected);
        expect(baseline.ranges).toHaveLength(4);
        expect(candidate.ranges).toEqual([[0, parts.reduce((sum, part) => sum + part.byteLength, 0)]]);
        expect(candidate.ranges[0][1]).toBe(baseline.ranges.reduce((sum, [start, end]) => sum + end - start, 0));
        expect(new Set(actual.map(({buffer}) => buffer)).size).toBe(4);
        for (const bytes of actual) {
            expect(bytes.byteOffset).toBe(0);
            expect(bytes.buffer.byteLength).toBe(bytes.byteLength);
        }
        structuredClone(actual[0].buffer, {transfer: [actual[0].buffer]});
        expect(actual[0].byteLength).toBe(0);
        expect(actual.slice(1)).toEqual(expected.slice(1));
    });

    test('does not read an unclaimed entry between independently admitted groups', async () => {
        const sources = contiguousEntries(4);
        const archive = new TrackedBlob([...sources.flatMap(({header, payload}) => [header, payload]), padding]);
        const reader = new RawZipPayloadReader(archive);
        const selected = [sources[3], sources[0], sources[1]];
        const actual = await Promise.all(selected.map(({file}) => reader.read(file, signal(), true)));
        expect(actual).toEqual(selected.map(({payload}) => payload));
        expect(archive.ranges).toEqual([
            [0, sources[2].file.offset],
            [sources[3].file.offset, sources[3].file.offset + sources[3].header.byteLength + sources[3].payload.byteLength],
        ]);
    });

    test('caps merged requests while preserving every admitted byte', async () => {
        const sources = contiguousEntries(3);
        let offset = 0;
        for (const source of sources) {
            source.payload = new Uint8Array(1536 * 1024).fill(0x61);
            new DataView(source.header.buffer).setUint16(8, 0, true);
            Object.assign(source.file, {offset, compressionMethod: 0, compressedSize: source.payload.byteLength, uncompressedSize: source.payload.byteLength});
            offset += source.header.byteLength + source.payload.byteLength;
        }
        const archive = new TrackedBlob([...sources.flatMap(({header, payload}) => [header, payload]), padding]);
        const reader = new RawZipPayloadReader(archive);
        const actual = await Promise.all(sources.map(({file}) => reader.read(file, signal(), true)));
        expect(actual.map((bytes) => crc32(bytes))).toEqual(sources.map(({payload}) => crc32(payload)));
        expect(archive.ranges).toHaveLength(2);
        expect(archive.ranges.every(([start, end]) => end - start <= 4 * 1024 * 1024)).toBe(true);
        expect(archive.ranges.reduce((sum, [start, end]) => sum + end - start, 0)).toBe(offset);
    });

    test('retains independent ownership for overlapping exact payload reads after an extra field', async () => {
        const [source] = contiguousEntries(1, 32);
        const archive = new TrackedBlob([source.header, source.payload, padding]);
        const reader = new RawZipPayloadReader(archive);
        const actual = await Promise.all([0, 1].map(() => reader.read(source.file, signal(), true)));
        expect(actual).toEqual([source.payload, source.payload]);
        expect(archive.ranges).toHaveLength(2);
        expect(actual[0].buffer).not.toBe(actual[1].buffer);
        structuredClone(actual[0].buffer, {transfer: [actual[0].buffer]});
        expect(actual[1]).toEqual(source.payload);
    });

    test('retains the existing owned exact-read buffer when no peer can share its range', async () => {
        const [source] = contiguousEntries(1, 32);
        const archive = new TrackedBlob([source.header, source.payload, padding]);
        const reader = new RawZipPayloadReader(archive);
        const original = reader._readBlobRange.bind(reader);
        /** @type {Uint8Array[]} */
        const physicalReads = [];
        const read = vi.spyOn(reader, '_readBlobRange').mockImplementation(async (...args) => {
            const bytes = await original(...args);
            physicalReads.push(bytes);
            return bytes;
        });
        try {
            const actual = await reader.read(source.file, signal(), true);
            expect(actual).toEqual(source.payload);
            expect(physicalReads).toHaveLength(2);
            expect(actual).toBe(physicalReads[1]);
        } finally { read.mockRestore(); }
    });

    test.each(['signature', 'encrypted', 'method', 'filename', 'name-length'])('retains the exact local-header failure independently of an adjacent healthy entry: %s', async (kind) => {
        const sources = contiguousEntries(2);
        const damaged = sources[1];
        const view = new DataView(damaged.header.buffer);
        if (kind === 'signature') { view.setUint32(0, 0, true); }
        if (kind === 'encrypted') { view.setUint16(6, 1, true); }
        if (kind === 'method') { view.setUint16(8, 0, true); }
        if (kind === 'filename') { damaged.header[30] ^= 1; }
        if (kind === 'name-length') { view.setUint16(26, 0, true); }
        const parts = [...sources.flatMap(({header, payload}) => [header, payload]), padding];
        const baseline = new RawZipPayloadReader(new TrackedBlob(parts));
        const archive = new TrackedBlob(parts);
        const candidate = new RawZipPayloadReader(archive);
        const expected = await baseline.read(damaged.file, signal()).then(() => null, (error) => error);
        const [healthy, failure] = await Promise.allSettled(sources.map(({file}) => candidate.read(file, signal(), true)));
        expect(healthy).toEqual({status: 'fulfilled', value: sources[0].payload});
        expect(failure).toMatchObject({status: 'rejected', reason: {name: expected.name, message: expected.message}});
        expect(archive.ranges).toHaveLength(1);
    });

    test.skipIf(!existsSync(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url)))('retains the native inflater CRC error for coalesced source bytes', async () => {
        setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))));
        const sources = contiguousEntries(4);
        const archive = new TrackedBlob([...sources.flatMap(({header, payload}) => [header, payload]), padding]);
        const reader = new RawZipPayloadReader(archive);
        const direct = await Promise.all(sources.map(({file}) => reader.read(file, signal())));
        const coalesced = await Promise.all(sources.map(({file}) => reader.read(file, signal(), true)));
        /**
         * @param {Uint8Array[]} payloads
         * @returns {Parameters<typeof inflateCompressedTermBankSourcesWasm>[0]}
         */
        const makeSources = (payloads) => sources.map(({file}, index) => ({
            bytes: payloads[index],
            compressionMethod: /** @type {0|8} */ (file.compressionMethod),
            compressedSize: file.compressedSize,
            uncompressedSize: file.uncompressedSize,
            signature: file.signature,
            filename: file.filename,
        }));
        const inflated = await inflateCompressedTermBankSourcesWasm(makeSources(coalesced));
        expect(inflated.uncompressedBytes).toBe(content.byteLength * sources.length);
        sources[2].file.signature = (sources[2].file.signature ^ 1) >>> 0;
        const expected = await inflateCompressedTermBankSourcesWasm(makeSources(direct)).then(() => null, (error) => error);
        expect(expected).toMatchObject({name: 'DictionarySourceIntegrityError'});
        await expect(inflateCompressedTermBankSourcesWasm(makeSources(coalesced))).rejects.toMatchObject({name: expected.name, message: expected.message});
    });

    test('cancels one owner without dropping its adjacent peer or replacing its cancellation reason', async () => {
        const sources = contiguousEntries(2);
        const {archive, started, release} = delayedArchive([...sources.flatMap(({header, payload}) => [header, payload]), padding]);
        const reader = new RawZipPayloadReader(archive);
        const cancelled = new AbortController();
        const reason = new Error('Cancelled only the first source');
        const first = reader.read(sources[0].file, cancelled.signal, true);
        const second = reader.read(sources[1].file, signal(), true);
        const rejected = expect(first).rejects.toBe(reason);
        await started;
        cancelled.abort(reason);
        release();
        await rejected;
        expect(await second).toEqual(sources[1].payload);
        expect(archive.ranges).toHaveLength(1);
    });

    test('joins shared Blob I/O through pool disposal, including released owners', async () => {
        const sources = contiguousEntries(2);
        const {archive, started, release} = delayedArchive([...sources.flatMap(({header, payload}) => [header, payload]), padding]);
        const reader = new RawZipPayloadReader(archive);
        const pool = new AbortableZipReadPool(async (file, abortSignal) => await reader.read(file, abortSignal, true));
        const reads = sources.map(({file}) => pool.read(file));
        const settled = Promise.allSettled(reads);
        pool.release(sources[0].file);
        await started;
        let disposed = false;
        const disposal = pool.dispose().then(() => { disposed = true; });
        await Promise.resolve();
        expect(disposed).toBe(false);
        release();
        await disposal;
        const results = await settled;
        expect(results).toHaveLength(2);
        for (const result of results) { expect(result).toMatchObject({status: 'rejected', reason: {name: 'AbortError'}}); }
        expect(archive.ranges).toHaveLength(1);
    });

    test('cancels queued owners before physical I/O starts', async () => {
        const sources = contiguousEntries(2);
        const archive = new TrackedBlob([...sources.flatMap(({header, payload}) => [header, payload]), padding]);
        const reader = new RawZipPayloadReader(archive);
        const pool = new AbortableZipReadPool(async (file, abortSignal) => await reader.read(file, abortSignal, true));
        const reads = Promise.allSettled(sources.map(({file}) => pool.read(file)));
        await pool.dispose();
        for (const result of await reads) { expect(result).toMatchObject({status: 'rejected', reason: {name: 'AbortError'}}); }
        expect(archive.ranges).toEqual([]);
        expect(reader.getCoalescedRangeReadCounts()).toEqual({logicalRequests: 0, physicalRanges: 0});
    });
});

describe('bounded large ZIP entry reads', () => {
    test('batches owned or already cached bytes while retaining large-Blob ranged policy', async () => {
        const source = entry(8);
        let wholeArchiveReads = 0;
        class TrackedSmallBlob extends Blob {
            /** @returns {Promise<ArrayBuffer>} */
            async arrayBuffer() {
                ++wholeArchiveReads;
                return await super.arrayBuffer();
            }
        }
        const smallBlob = new TrackedSmallBlob([source.header, source.payload]);
        const smallReader = new RawZipPayloadReader(smallBlob);
        expect(smallReader.supportsBatchReads()).toBe(false);
        expect(smallReader.supportsCachedBatchReads()).toBe(false);
        expect(wholeArchiveReads).toBe(0);
        await smallReader.read(source.file, signal());
        expect(smallReader.supportsBatchReads()).toBe(true);
        expect(smallReader.supportsCachedBatchReads()).toBe(true);
        expect(wholeArchiveReads).toBe(1);

        const smallBuffer = new ArrayBuffer(64);
        const bufferReader = new RawZipPayloadReader(smallBuffer);
        expect(bufferReader.supportsBatchReads()).toBe(true);
        expect(bufferReader.supportsCachedBatchReads()).toBe(true);

        const largeReader = new RawZipPayloadReader(padding);
        expect(largeReader.supportsBatchReads()).toBe(true);
        expect(largeReader.supportsCachedBatchReads()).toBe(false);
    });

    test('coalesces nearby payloads and validates every local entry header', async () => {
        const first = entry(8, 4);
        const second = entry(0, 2);
        second.file.filename = 'term_bank_2.json';
        second.file.rawFilename = encoder.encode(second.file.filename);
        const secondHeader = Uint8Array.from(second.header);
        secondHeader.set(second.file.rawFilename, 30);
        second.file.offset = first.header.length + first.payload.length;
        const archive = new TrackedBlob([first.header, first.payload, secondHeader, second.payload, padding]);
        const reader = new RawZipPayloadReader(archive);

        const batch = await reader.readBatch([second.file, first.file], signal());

        expect(batch?.rangeReadCount).toBe(1);
        expect(batch?.rangeReadBytes).toBe(archive.ranges[0][1] - archive.ranges[0][0]);
        expect(archive.ranges).toHaveLength(1);
        expect(batch?.sources.map(({filename}) => filename)).toEqual(['term_bank_1.json', 'term_bank_2.json']);
        expect(batch?.sources.map(({bytes}) => bytes)).toEqual([first.payload, second.payload]);
    });

    test('borrows payload subviews only from bounded large-Blob ranges', async () => {
        const first = entry(8, 4);
        const second = entry(0, 2);
        second.file.filename = 'term_bank_2.json';
        second.file.rawFilename = encoder.encode(second.file.filename);
        const secondHeader = Uint8Array.from(second.header);
        secondHeader.set(second.file.rawFilename, 30);
        second.file.offset = first.header.length + first.payload.length;
        const archive = new TrackedBlob([first.header, first.payload, secondHeader, second.payload, padding]);
        const reader = new RawZipPayloadReader(archive);

        const batch = await reader.readBatch([second.file, first.file], signal(), () => false, true);

        expect(batch?.sources.map(({bytes}) => bytes)).toEqual([first.payload, second.payload]);
        expect(batch?.sources[0].bytes.buffer).toBe(batch?.sources[1].bytes.buffer);
        expect(batch?.sources[0].bytes.byteOffset).toBeGreaterThan(0);
        expect(batch?.sources[0].bytes.buffer.byteLength).toBe(batch?.rangeReadBytes);
        expect(archive.ranges).toHaveLength(1);

        const smallArchive = new TrackedBlob([first.header, first.payload]);
        expect(await new RawZipPayloadReader(smallArchive).readBatch([first.file], signal(), () => false, true)).toBeNull();
        expect(smallArchive.ranges).toEqual([]);
    });

    test('coalesces the full deferred media entry limit in a bounded Blob range', async () => {
        const entries = Array.from({length: 1024}, (_, index) => {
            const result = entry(0);
            result.file.filename = 'image-' + String(index).padStart(5, '0') + '.webp';
            result.file.rawFilename = encoder.encode(result.file.filename);
            result.file.offset = index * (result.header.length + result.payload.length);
            result.header.set(result.file.rawFilename, 30);
            return result;
        });
        const archive = new TrackedBlob([...entries.flatMap(({header, payload}) => [header, payload]), padding]);
        const batch = await new RawZipPayloadReader(archive).readBatch(entries.map(({file}) => file), signal());

        expect(batch?.rangeReadCount).toBe(1);
        expect(batch?.sources.map(({filename}) => filename)).toEqual(entries.map(({file}) => file.filename));
        expect(batch?.sources.map(({bytes}) => bytes)).toEqual(entries.map(({payload}) => payload));
    });

    /* eslint-disable @stylistic/semi */
    test.skipIf(!existsSync(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))).each(['ascending', 'descending', 'inverted batch boundary'])('projects checked stored and compressed payloads in %s request order into one source span', async (order) => {
        const nativeFetch = globalThis.fetch;
        vi.stubGlobal('fetch', async (/** @type {RequestInfo|URL} */ resource) => {
            const url = resource instanceof URL ? resource : new URL(String(resource));
            return url.protocol === 'file:' ? new Response(await readFile(url)) : await nativeFetch(resource);
        });
        try {
            const image = Uint8Array.from({length: 512}, (_, index) => index & 7);
            const deflated = new Uint8Array(deflateRawSync(image));
            const stored = new Uint8Array(image.length + 5);
            stored[0] = 1;
            const deflateHeader = new DataView(stored.buffer);
            deflateHeader.setUint16(1, image.length, true);
            deflateHeader.setUint16(3, image.length ^ 0xffff, true);
            stored.set(image, 5);
            const signature = crc32(image);
            const row = {dictionary: 'Media ZIP test', expression: 'term', reading: '', definitionTags: '', rules: '', score: 0, glossary: []};
            /** @type {import('dictionary-importer').ImportRequirement[]} */
            const requests = [];
            /** @type {BlobPart[]} */
            const parts = [];
            /** @type {Map<string, {offset: number, signature: number}>} */
            const entryMap = new Map();
            let offset = 0;
            for (let i = 0; i < 8192; ++i) {
                const filename = `image${i}.webp`;
                const rawFilename = encoder.encode(filename);
                const data = i === 0 ? deflated : stored;
                const header = new Uint8Array(30 + rawFilename.length);
                const view = new DataView(header.buffer);
                view.setUint32(0, 0x04034b50, true);
                view.setUint16(8, 8, true);
                view.setUint16(26, rawFilename.length, true);
                header.set(rawFilename, 30);
                parts.push(header, data);
                const metadata = {
                    filename,
                    rawFilename,
                    compressionMethod: 8,
                    offset,
                    signature,
                    compressedSize: data.length,
                    uncompressedSize: image.length,
                    encrypted: false,
                };
                entryMap.set(filename, metadata);
                requests.push(i % 3 === 0 ?
                    {type: 'image', source: {type: 'image', path: filename}, target: {type: 'image', path: ''}, entry: row} :
                    (i % 3 === 1 ?
                        {type: 'image-reference', source: {path: filename}, entry: row} :
                        {type: 'projected-image-reference', source: {path: filename}, dictionary: row.dictionary, diagnosticKeys: {bytes: new Uint8Array(0), spans: new Uint32Array(4), decodedKeys: null}, diagnosticIndex: 0}))
                offset += header.length + data.length;
            }
            const archive = new TrackedBlob([...parts, padding]);
            const files = /** @type {import('dictionary-importer').ArchiveFileMap} */ (/** @type {unknown} */ (entryMap));
            const reader = new RawZipPayloadReader(archive);
            if (order === 'descending') { requests.reverse() }
            if (order === 'inverted batch boundary') { [requests[1023], requests[1024]] = [requests[1024], requests[1023]] }
            const prepared = await preparePackedSourceZipMedia(archive, requests, files, reader, () => {})
            expect(prepared?.records).toHaveLength(8192);
            expect(prepared?.blob.size).toBe(offset);
            if (prepared === null) { throw new Error('Expected the dense source span'); }
            expect(prepared.records.map(({path}) => path)).toEqual(requests.map(({source}) => source.path))
            const head = prepared.records.find(({path}) => path === 'image8191.webp')
            const tail = prepared.records.find(({path}) => path === 'image0.webp')
            if (typeof head === 'undefined' || typeof tail === 'undefined') { throw new Error('Missing physical boundary images') }
            expect(head).toMatchObject({path: 'image8191.webp', compressionMethod: 0, packedLength: image.length});
            expect(tail).toMatchObject({path: 'image0.webp', compressionMethod: 8, packedLength: deflated.length});
            expect(new Uint8Array(await prepared.blob.slice(head.packedOffset, head.packedOffset + head.packedLength).arrayBuffer())).toEqual(image);
            const deflatedBody = new Uint8Array(await prepared.blob.slice(tail.packedOffset, tail.packedOffset + tail.packedLength).arrayBuffer());
            expect(new Uint8Array(inflateRawSync(deflatedBody))).toEqual(image);

            const batchRead = vi.spyOn(reader, 'readBatch')
            const duplicate = [...requests]
            duplicate[duplicate.length - 1] = duplicate[0]
            expect(await preparePackedSourceZipMedia(archive, duplicate, files, reader, () => {})).toBeNull()
            expect(batchRead).not.toHaveBeenCalled()
            const cancelled = new Error('cancelled before the first media batch')
            await expect(preparePackedSourceZipMedia(archive, requests, files, reader, () => { throw cancelled; })).rejects.toBe(cancelled)
            expect(batchRead).not.toHaveBeenCalled()
            batchRead.mockRestore()

            const alias = entryMap.get('image1.webp')
            if (typeof alias === 'undefined') { throw new Error('Missing duplicate-offset metadata') }
            const originalOffset = alias.offset
            alias.offset = 0
            await expect(preparePackedSourceZipMedia(archive, requests, files, reader, () => {})).rejects.toThrow('local filename disagrees')
            alias.offset = originalOffset

            const corrupt = entryMap.get('image0.webp');
            if (typeof corrupt === 'undefined') { throw new Error('Missing test fixture metadata'); }
            corrupt.signature ^= 1;
            corrupt.signature >>>= 0;
            await expect(preparePackedSourceZipMedia(archive, requests, files, reader, () => {})).rejects.toThrow('CRC32');
        } finally {
            vi.unstubAllGlobals();
        }
    });

    /* eslint-enable @stylistic/semi */
    test('validates each batched filename against its ZIP central metadata', async () => {
        const first = entry(8);
        const second = entry(8);
        const wrongLocalName = encoder.encode('term_bank_2.json');
        const wrongHeader = Uint8Array.from(second.header);
        wrongHeader.set(wrongLocalName, 30);
        second.file.filename = 'term_bank_2.json';
        second.file.rawFilename = encoder.encode('term_bank_1.json');
        second.file.offset = first.header.length + first.payload.length;
        const archive = new TrackedBlob([first.header, first.payload, wrongHeader, second.payload, padding]);

        await expect(new RawZipPayloadReader(archive).readBatch([first.file, second.file], signal())).rejects.toThrow('local filename disagrees');
    });

    test.each(['signature', 'encrypted', 'method'])('rejects a malformed second batch header: %s', async (kind) => {
        const first = entry(8);
        const second = entry(8);
        second.file.filename = 'term_bank_2.json';
        second.file.rawFilename = encoder.encode(second.file.filename);
        second.header.set(second.file.rawFilename, 30);
        second.file.offset = first.header.length + first.payload.length;
        const view = new DataView(second.header.buffer);
        if (kind === 'signature') { view.setUint32(0, 0, true); }
        if (kind === 'encrypted') { view.setUint16(6, 1, true); }
        if (kind === 'method') { view.setUint16(8, 0, true); }
        const archive = new TrackedBlob([first.header, first.payload, second.header, second.payload, padding]);

        await expect(new RawZipPayloadReader(archive).readBatch([first.file, second.file], signal())).rejects.toThrow('Raw ZIP local header');
        expect(archive.ranges).toHaveLength(1);
    });

    test.each(['raw-filename', 'compressed-budget', 'uncompressed-budget', 'source-count', 'unsafe-offset'])('declines ineligible batches before I/O: %s', async (kind) => {
        const first = entry(8);
        const second = entry(8);
        let files = [first.file, second.file];
        if (kind === 'raw-filename') { Reflect.deleteProperty(second.file, 'rawFilename'); }
        if (kind === 'compressed-budget') {
            first.file.compressedSize = 3 * 1024 * 1024;
            second.file.compressedSize = 3 * 1024 * 1024;
        }
        if (kind === 'uncompressed-budget') {
            first.file.uncompressedSize = 3 * 1024 * 1024;
            second.file.uncompressedSize = 3 * 1024 * 1024;
        }
        if (kind === 'source-count') { files = Array.from({length: 1025}, () => first.file); }
        if (kind === 'unsafe-offset') { second.file.offset = Number.MAX_SAFE_INTEGER; }
        const archive = new TrackedBlob([first.header, first.payload, padding]);

        expect(await new RawZipPayloadReader(archive).readBatch(files, signal())).toBeNull();
        expect(archive.ranges).toEqual([]);
    });

    test('supports the maximum local extra field without reading an unknown filename allowance', async () => {
        const {header, payload, file} = entry(8, 65535);
        const archive = new TrackedBlob([header, payload, padding]);
        const batch = await new RawZipPayloadReader(archive).readBatch([file], signal());
        expect(batch?.sources[0].bytes).toEqual(payload);
        expect(archive.ranges).toEqual([[0, header.byteLength + payload.byteLength]]);
    });

    test.each([false, true])('joins a cancelled batch Blob read before exposing bytes (borrowed=%s)', async (borrowPayloadViews) => {
        const {header, payload, file} = entry(8);
        const {archive, started, release} = delayedArchive([header, payload, padding]);
        const controller = new AbortController();
        const pending = new RawZipPayloadReader(archive).readBatch([file], controller.signal, () => false, borrowPayloadViews);
        let settled = false;
        const markSettled = () => { settled = true; };
        void pending.then(markSettled, markSettled);
        await started;
        const rejected = expect(pending).rejects.toMatchObject({name: 'AbortError'});
        try {
            controller.abort();
            await Promise.resolve();
            expect(settled).toBe(false);
        } finally {
            release();
        }
        await rejected;
        expect(archive.ranges).toHaveLength(1);
    });

    test.each([0, 8])('reads an exact owned payload with method %i and skips unrelated bytes', async (method) => {
        const {header, payload, file} = entry(method, 65535);
        const archive = new TrackedBlob([header, payload, padding]);
        const reader = new RawZipPayloadReader(archive);
        const actual = await reader.read(file, signal());
        expect(actual).toEqual(payload);
        expect(method === 8 ? new Uint8Array(inflateRawSync(actual)) : actual).toEqual(content);
        expect(archive.ranges).toEqual([[0, 30 + name.length + payload.length], [header.length, header.length + payload.length]]);
        expect(actual.byteOffset).toBe(0);
        expect(actual.buffer.byteLength).toBe(actual.byteLength);
        actual.fill(0);
        expect(await reader.read(file, signal())).toEqual(payload);
    });
    test('reads a fixed header when central filename bytes are unavailable', async () => {
        const {header, payload, file} = entry(8, 12);
        const archive = new TrackedBlob([header, payload, padding]);
        const reader = new RawZipPayloadReader(archive);
        expect(await reader.read({...file, rawFilename: void 0}, signal())).toEqual(payload);
        expect(archive.ranges).toEqual([[0, 30], [header.length, header.length + payload.length]]);
    });
    test('bounds the coalesced metadata read at a truncated local name', async () => {
        const {header, file} = entry(0);
        const archive = new TrackedBlob([padding, header.subarray(0, 31)]);
        file.offset = padding.size;
        file.compressedSize = 0;
        const reader = new RawZipPayloadReader(archive);
        await expect(reader.read(file, signal())).rejects.toThrow('payload is out of bounds');
        expect(archive.ranges).toEqual([[file.offset, archive.size]]);
    });
    test('reads a local header beyond the old archive ceiling', async () => {
        const {header, payload, file} = entry(8);
        const archive = new TrackedBlob([padding, header, payload]);
        file.offset = padding.size;
        expect(await new RawZipPayloadReader(archive).read(file, signal())).toEqual(payload);
        expect(archive.ranges.every(([start]) => start >= padding.size)).toBe(true);
    });
    test.each(['signature', 'encrypted', 'method', 'filename', 'name-length', 'extra-length', 'truncated-payload'])('rejects malformed large entry: %s', async (kind) => {
        const {header, payload, file} = entry(8);
        const view = new DataView(header.buffer);
        if (kind === 'signature') { view.setUint32(0, 0, true); }
        if (kind === 'encrypted') { view.setUint16(6, 1, true); }
        if (kind === 'method') { view.setUint16(8, 0, true); }
        if (kind === 'filename') { header[30] ^= 1; }
        if (kind === 'name-length') { view.setUint16(26, 65535, true); }
        if (kind === 'extra-length') { view.setUint16(28, 65535, true); }
        if (kind === 'truncated-payload') { ++file.compressedSize; }
        file.offset = padding.size;
        const archive = new TrackedBlob([padding, header, payload]);
        await expect(new RawZipPayloadReader(archive).read(file, signal())).rejects.toThrow(/Raw ZIP/);
        expect(archive.ranges.every(([, end]) => end <= file.offset + 30 + name.length + file.compressedSize)).toBe(true);
    });
    test.each([-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER])('rejects invalid offset before I/O: %s', async (offset) => {
        const {header, payload, file} = entry(8);
        const archive = new TrackedBlob([header, payload, padding]);
        file.offset = offset;
        await expect(new RawZipPayloadReader(archive).read(file, signal())).rejects.toThrow('metadata');
        expect(archive.ranges).toEqual([]);
    });
    test('does not start I/O for an already cancelled request', async () => {
        const {header, payload, file} = entry(8);
        const archive = new TrackedBlob([header, payload, padding]);
        const controller = new AbortController();
        controller.abort();
        await expect(new RawZipPayloadReader(archive).read(file, controller.signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(archive.ranges).toEqual([]);
    });
    test('joins an in-flight real Blob read on disposal without starting its payload', async () => {
        const {header, payload, file} = entry(8);
        const {archive, started, release} = delayedArchive([header, payload, padding]);
        const reader = new RawZipPayloadReader(archive);
        const pool = new AbortableZipReadPool(async (value, abortSignal) => await reader.read(value, abortSignal));
        const pending = pool.read(file);
        await started;
        const rejected = expect(pending).rejects.toMatchObject({name: 'AbortError'});
        let disposed = false;
        const disposal = pool.dispose().then(() => { disposed = true; });
        await Promise.resolve();
        expect(disposed).toBe(false);
        release();
        await disposal;
        await rejected;
        expect(archive.ranges).toEqual([[0, 30 + name.length + payload.length]]);
    });
    test.each([2, 8])('retains the compressed-source budget on deviceMemory=%i', async (deviceMemory) => {
        const lowMemory = deviceMemory === 2;
        const admittedCount = lowMemory ? 8 : 4;
        const files = Array.from({length: lowMemory ? 12 : 4}, (_, i) => ({
            ...entry(8).file,
            filename: `term_bank_${i + 1}.json`,
            compressedSize: (lowMemory ? 8 : 32) * 1024 * 1024,
            uncompressedSize: 8 * 1024 * 1024,
        }));
        let reads = 0;
        const pipeline = new TermBankSourcePipeline({
            termFiles: files,
            enabled: true,
            deviceMemory,
            read: async () => { ++reads; return content; },
            readCompressed: async () => { ++reads; return content; },
        });
        expect(pipeline.createCompressedImportRunPlan(0)?.files).toHaveLength(admittedCount);
        ++files[admittedCount - 1].compressedSize;
        expect(pipeline.createCompressedImportRunPlan(0)).toBeNull();
        expect(reads).toBe(0);
        await pipeline.dispose();
    });
    test('rejects a single oversized compressed entry before reading it', async () => {
        const {header, payload, file} = entry(8);
        const archive = new TrackedBlob([header, payload, padding]);
        file.compressedSize = limit + 1;
        await expect(new RawZipPayloadReader(archive).read(file, signal())).rejects.toThrow('metadata');
        expect(archive.ranges).toEqual([]);
    });
    test('small Blob and ArrayBuffer paths retain owned payload copies', async () => {
        const {header, payload, file} = entry(8);
        const blob = new Blob([header, payload]);
        const buffer = await blob.arrayBuffer();
        const first = await new RawZipPayloadReader(buffer).read(file, signal());
        new Uint8Array(buffer).fill(0);
        expect(first).toEqual(payload);
        expect(await new RawZipPayloadReader(blob).read(file, signal())).toEqual(payload);
    });
});
