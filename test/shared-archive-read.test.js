/*
 * Copyright (C) 2026 Manabitan Authors
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

import {openAsBlob} from 'node:fs';
import {mkdtemp, open, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {inflateRawSync} from 'node:zlib';
import {TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter} from '@zip.js/zip.js';
import {describe, expect, test} from 'vitest';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {RawZipPayloadReader} from '../ext/js/dictionary/term-bank-source-pipeline.js';
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';

class ObservedBlob extends Blob {
    reads = 0;
    slices = 0;
    forbidSlices = false;
    /**
     * @override
     * @returns {Promise<ArrayBuffer>}
     */
    async arrayBuffer() { ++this.reads; return await super.arrayBuffer(); }
    /**
     * @override
     * @param {number} [start]
     * @param {number} [end]
     * @param {string} [type]
     * @returns {Blob}
     */
    slice(start, end, type) {
        ++this.slices;
        if (this.forbidSlices) { throw new Error('Unexpected duplicate Blob range read'); }
        return super.slice(start, end, type);
    }
}

/** @returns {{promise: Promise<void>, release: () => void}} */
function gate() {
    /** @type {() => void} */
    let release = () => {};
    const promise = new Promise((resolve) => { release = () => resolve(void 0); });
    return {promise, release};
}

/**
 * @param {number} [level]
 * @returns {Promise<{bytes: Uint8Array, image: Uint8Array, term: string}>}
 */
async function fixture(level = 0) {
    const writer = new ZipWriter(new Uint8ArrayWriter(), {level});
    const term = '[ ["日本", "にほん", "", "", 0, ["Japan"], 1, ""] ]';
    const image = Uint8Array.from({length: 65537}, (_, i) => i % 251);
    await writer.add('index.json', new TextReader('{"title":"Archive test","revision":"1","format":3}'));
    await writer.add('term_bank_1.json', new TextReader(term));
    await writer.add('image.png', new Uint8ArrayReader(image));
    return {bytes: new Uint8Array(await writer.close()), image, term};
}

/**
 * @param {Blob|ArrayBuffer} content
 * @param {RawZipPayloadReader} raw
 * @returns {ReturnType<DictionaryImporter['_getFilesFromArchive']>}
 */
async function openArchive(content, raw) {
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
    return await importer._getFilesFromArchive(content, raw);
}

/**
 * @param {import('dictionary-importer').ImportFileEntry|undefined} entry
 * @returns {Promise<Uint8Array>}
 */
async function readEntry(entry) {
    if (!entry || !('getData' in entry) || typeof entry.getData !== 'function') { throw new Error('Missing readable ZIP entry'); }
    return await entry.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true});
}

/**
 * @param {Map<string, import('dictionary-importer').ImportFileEntry>} files
 * @returns {import('@zip.js/zip.js').Entry}
 */
function termEntry(files) {
    const entry = files.get('term_bank_1.json');
    if (!entry || !('getData' in entry) || entry.directory) { throw new Error('Missing term bank'); }
    return entry;
}

describe('reuse the raw reader archive only after it is buffered', () => {
    test.each([0, 6])('real ZIP media and terms reuse the existing buffer at level %i', async (level) => {
        const {bytes, image, term} = await fixture(level);
        const blob = new ObservedBlob([bytes]);
        const raw = new RawZipPayloadReader(blob);
        const {fileMap, zipReader} = await openArchive(blob, raw);
        try {
            expect(blob.reads).toBe(0);
            expect(raw.readBufferedRange(0, 1)).toBeNull();
            const entry = termEntry(fileMap);
            const payload = await raw.read(entry, new AbortController().signal);
            const inflated = entry.compressionMethod === 8 ? new Uint8Array(inflateRawSync(payload)) : payload;
            expect(new TextDecoder().decode(inflated)).toBe(term);
            expect(blob.reads).toBe(1);
            blob.forbidSlices = true;
            expect(await readEntry(fileMap.get('image.png'))).toEqual(image);
            expect(new TextDecoder().decode(await readEntry(entry))).toBe(term);
            expect(JSON.parse(new TextDecoder().decode(await readEntry(fileMap.get('index.json')))).title).toBe('Archive test');
            const first = raw.readBufferedRange(0, 7);
            const second = raw.readBufferedRange(7, 3);
            expect(first?.buffer).not.toBe(second?.buffer);
            expect(first?.byteOffset).toBe(0);
            expect(first?.buffer.byteLength).toBe(7);
            first?.fill(0);
            expect(raw.readBufferedRange(0, bytes.length)).toEqual(bytes);
            payload.fill(0);
            expect(new TextDecoder().decode(await readEntry(entry))).toBe(term);
            expect(blob.reads).toBe(1);
        } finally { await zipReader.close(); }
    });

    test('metadata-only and media-only reads do not allocate a whole archive', async () => {
        const {bytes, image} = await fixture(6);
        const blob = new ObservedBlob([bytes]);
        const raw = new RawZipPayloadReader(blob);
        const {fileMap, zipReader} = await openArchive(blob, raw);
        try {
            await readEntry(fileMap.get('index.json'));
            expect(await readEntry(fileMap.get('image.png'))).toEqual(image);
            expect(blob.slices).toBeGreaterThan(0);
            expect(blob.reads).toBe(0);
            expect(raw.readBufferedRange(0, bytes.length)).toBeNull();
        } finally { await zipReader.close(); }
    });

    test('already-owned ArrayBuffer inputs reuse their original backing storage', async () => {
        const {bytes} = await fixture();
        const buffer = Uint8Array.from(bytes).buffer;
        const raw = new RawZipPayloadReader(buffer);
        const {fileMap, zipReader} = await openArchive(buffer, raw);
        try {
            expect(raw.readBufferedRange(0, 1)).toBeNull();
            await raw.read(termEntry(fileMap), new AbortController().signal);
            const range = raw.readBufferedRange(0, bytes.length);
            expect(range?.buffer).not.toBe(buffer);
            expect(range).toEqual(bytes);
            expect(await readEntry(fileMap.get('image.png'))).toHaveLength(65537);
        } finally { await zipReader.close(); }
    });

    test('valid empty ranges work; clipping, fractional and invalid ranges fall back', async () => {
        const {bytes} = await fixture();
        const raw = new RawZipPayloadReader(bytes.buffer);
        const {fileMap, zipReader} = await openArchive(bytes.buffer, raw);
        try {
            await raw.read(termEntry(fileMap), new AbortController().signal);
            expect(raw.readBufferedRange(bytes.length, 0)).toEqual(new Uint8Array());
            for (const [offset, length] of [[-1, 1], [0, -1], [0.5, 1], [0, 1.5], [Number.NaN, 1], [0, Infinity], [bytes.length, 1], [1, bytes.length], [Number.MAX_SAFE_INTEGER, 1]]) {
                expect(raw.readBufferedRange(offset, length)).toBeNull();
            }
            expect(raw.readBufferedRange(1, bytes.length - 1)).toEqual(bytes.subarray(1));
        } finally { await zipReader.close(); }
    });

    test('parallel raw reads share one pending allocation without blocking metadata reads', async () => {
        const started = gate();
        const resume = gate();
        class DelayedBlob extends ObservedBlob {
            /**
             * @override
             * @returns {Promise<ArrayBuffer>}
             */
            async arrayBuffer() {
                const bytes = await super.arrayBuffer();
                started.release();
                await resume.promise;
                return bytes;
            }
        }
        const {bytes, image} = await fixture();
        const blob = new DelayedBlob([bytes]);
        const raw = new RawZipPayloadReader(blob);
        const {fileMap, zipReader} = await openArchive(blob, raw);
        try {
            const entry = termEntry(fileMap);
            const first = raw.read(entry, new AbortController().signal);
            const second = raw.read(entry, new AbortController().signal);
            await started.promise;
            expect(raw.readBufferedRange(0, 1)).toBeNull();
            expect(await readEntry(fileMap.get('image.png'))).toEqual(image);
            expect(blob.reads).toBe(1);
            resume.release();
            expect(await first).toEqual(await second);
            blob.forbidSlices = true;
            expect(await readEntry(fileMap.get('image.png'))).toEqual(image);
        } finally { resume.release(); await zipReader.close(); }
    });

    test('failed full-buffer reads never publish a cached range; a fresh import recovers', async () => {
        class FailingBlob extends ObservedBlob {
            /**
             * @override
             * @returns {Promise<ArrayBuffer>}
             */
            async arrayBuffer() { throw new Error('injected I/O failure'); }
        }
        const {bytes, image} = await fixture();
        const blob = new FailingBlob([bytes]);
        const raw = new RawZipPayloadReader(blob);
        const {fileMap, zipReader} = await openArchive(blob, raw);
        try {
            await expect(raw.read(termEntry(fileMap), new AbortController().signal)).rejects.toThrow('injected I/O failure');
            expect(raw.readBufferedRange(0, 1)).toBeNull();
            expect(await readEntry(fileMap.get('image.png'))).toEqual(image);
            const recovered = new RawZipPayloadReader(new Blob([bytes]));
            await recovered.read(termEntry(fileMap), new AbortController().signal);
            expect(recovered.readBufferedRange(0, bytes.length)).toEqual(bytes);
            expect(raw.readBufferedRange(0, 1)).toBeNull();
        } finally { await zipReader.close(); }
    });

    test('large real files stay range-backed even after a raw read', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'manabitan-lazy-zip-'));
        try {
            const filename = path.join(directory, 'large');
            const file = await open(filename, 'w');
            try {
                await file.truncate(128 * 1024 * 1024 + 1);
            } finally {
                await file.close();
            }
            const {bytes} = await fixture();
            const small = new Blob([bytes]);
            const {fileMap, zipReader} = await openArchive(small, new RawZipPayloadReader(small));
            try {
                const blob = new ObservedBlob([bytes, await openAsBlob(filename)]);
                const raw = new RawZipPayloadReader(blob);
                expect(await raw.read(termEntry(fileMap), new AbortController().signal)).toBeInstanceOf(Uint8Array);
                expect(blob.reads).toBe(0);
                expect(raw.readBufferedRange(0, bytes.length)).toBeNull();
                expect(blob.slices).toBe(3);
            } finally { await zipReader.close(); }
        } finally { await rm(directory, {recursive: true, force: true}); }
    });
});
