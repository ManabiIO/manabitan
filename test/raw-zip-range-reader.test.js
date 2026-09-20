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
import {openAsBlob} from 'node:fs';
import {mkdtemp, open, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {deflateRawSync, inflateRawSync} from 'node:zlib';
import {AbortableZipReadPool, RawZipPayloadReader, TermBankSourcePipeline} from '../ext/js/dictionary/term-bank-source-pipeline.js';

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
afterAll(async () => { await rm(directory, {recursive: true, force: true}); });

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

describe('bounded large ZIP entry reads', () => {
    test.each([0, 8])('reads an exact owned payload with method %i and skips unrelated bytes', async (method) => {
        const {header, payload, file} = entry(method, 65535);
        const archive = new TrackedBlob([header, payload, padding]);
        const reader = new RawZipPayloadReader(archive);
        const actual = await reader.read(file, signal());
        expect(actual).toEqual(payload);
        expect(method === 8 ? new Uint8Array(inflateRawSync(actual)) : actual).toEqual(content);
        expect(archive.ranges).toEqual([[0, 30 + name.length], [header.length, header.length + payload.length]]);
        actual.fill(0);
        expect(await reader.read(file, signal())).toEqual(payload);
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
        expect(archive.ranges.every(([, end]) => end <= file.offset + 30 + name.length)).toBe(true);
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
        const {header, payload, file} = entry(8);
        const archive = new DelayedArchive([header, payload, padding]);
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
        expect(archive.ranges).toEqual([[0, 30 + name.length]]);
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

    test('activates coalesced reads through the compressed source pipeline', async () => {
        const {header, payload, file} = entry(8);
        const archive = new TrackedBlob([header, payload, padding]);
        const rawReader = new RawZipPayloadReader(archive);
        const fallbackRead = vi.fn(async () => content);
        const files = Array.from({length: 4}, (_, index) => ({...file, signature: index}));
        const pipeline = new TermBankSourcePipeline({
            termFiles: files,
            enabled: true,
            read: fallbackRead,
            readCompressed: async (termFile, abortSignal) => await rawReader.read(termFile, abortSignal),
        });
        const plan = pipeline.createCompressedImportRunPlan(0);
        if (plan === null) { throw new Error('Expected compressed import plan'); }

        expect((await plan.loaders[0]()).bytes).toEqual(payload);
        expect(fallbackRead).not.toHaveBeenCalled();
        expect(archive.ranges).toEqual([[0, 30 + name.length], [header.length, header.length + payload.length]]);
        await pipeline.dispose();
    });

    test.each([-1, 1])('rejects a local/central filename-length delta of %i before payload I/O', async (delta) => {
        const {header, payload, file} = entry(8);
        new DataView(header.buffer).setUint16(26, name.length + delta, true);
        const archive = new TrackedBlob([header, payload, padding]);

        await expect(new RawZipPayloadReader(archive).read(file, signal())).rejects.toThrow('local filename disagrees');
        expect(archive.ranges).toEqual([[0, 30 + name.length]]);
    });

    test('bounds the speculative prefix and retains valid long-filename fallback', async () => {
        const longName = new Uint8Array(4097).fill(0x61);
        const {payload, file} = entry(0);
        file.rawFilename = longName;
        const header = new Uint8Array(30 + longName.length);
        const view = new DataView(header.buffer);
        view.setUint32(0, 0x04034b50, true);
        view.setUint16(26, longName.length, true);
        header.set(longName, 30);
        const archive = new TrackedBlob([header, payload, padding]);

        expect(await new RawZipPayloadReader(archive).read(file, signal())).toEqual(payload);
        expect(archive.ranges).toEqual([
            [0, 30],
            [30, 30 + longName.length],
            [header.length, header.length + payload.length],
        ]);
    });
});
