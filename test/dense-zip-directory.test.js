/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test} from 'vitest';
import {readDenseZipDirectory} from '../ext/js/dictionary/dense-zip-directory.js';
// eslint-disable-next-line @stylistic/semi
import {RawZipPayloadReader} from '../ext/js/dictionary/term-bank-source-pipeline.js'

const count = 8192;
const filenameLength = 8;
const packedLength = 16 * 1024;
const directoryOffset = count * (30 + filenameLength + packedLength);

/** A virtual archive lets the fixture test directory reads without 128 MiB of payloads. */
class SparseZipDirectory extends Blob {
    /** @param {{zip64?: boolean, corrupt?: string}} [options] */
    constructor({zip64 = false, corrupt = ''} = {}) {
        super();
        const recordLength = 46 + filenameLength;
        const names = new TextEncoder();
        this.directory = new Uint8Array(recordLength * count);
        const view = new DataView(this.directory.buffer);
        for (let i = 0; i < count; ++i) {
            const cursor = i * recordLength;
            view.setUint32(cursor, 0x02014b50, true);
            view.setUint16(cursor + 10, 8, true);
            view.setUint32(cursor + 20, packedLength, true);
            view.setUint32(cursor + 24, packedLength + 4, true);
            view.setUint16(cursor + 28, filenameLength, true);
            view.setUint32(cursor + 42, i * (30 + filenameLength + packedLength), true);
            this.directory.set(names.encode(`${String(i).padStart(4, '0')}.png`), cursor + 46);
        }
        const trailerStart = zip64 ? 0 : 76;
        this.tail = new Uint8Array(98);
        const eocd = new DataView(this.tail.buffer);
        eocd.setUint32(76, 0x06054b50, true);
        eocd.setUint16(84, zip64 ? 0xffff : count, true);
        eocd.setUint16(86, zip64 ? 0xffff : count, true);
        eocd.setUint32(88, this.directory.length, true);
        eocd.setUint32(92, directoryOffset, true);
        if (zip64) {
            eocd.setUint32(0, 0x06064b50, true);
            eocd.setBigUint64(4, 44n, true);
            eocd.setBigUint64(24, BigInt(count), true);
            eocd.setBigUint64(32, BigInt(count), true);
            eocd.setBigUint64(40, BigInt(this.directory.length), true);
            eocd.setBigUint64(48, BigInt(directoryOffset), true);
            eocd.setUint32(56, 0x07064b50, true);
            eocd.setBigUint64(64, BigInt(directoryOffset + this.directory.length), true);
            eocd.setUint32(72, 1, true);
        }
        if (corrupt === 'filename') { this.directory[46] = 0xf3; }
        if (corrupt === 'length') { view.setUint16(28, 0xffff, true); }
        if (corrupt === 'overlap') { view.setUint32(recordLength + 42, 0, true); }
        if (corrupt === 'descriptor') { view.setUint16(8, 8, true); }
        if (corrupt === 'locator') { eocd.setUint32(72, 2, true); }
        this.archiveSize = directoryOffset + this.directory.length + 98 - trailerStart;
    }

    /** @override */
    get size() { return this.archiveSize; }

    /**
     * @override
     * @param {number} [start]
     * @param {number} [end]
     */
    slice(start, end) {
        if (start === this.size - 98 && typeof end === 'undefined') { return new Blob([this.tail]); }
        if (start === directoryOffset && end === directoryOffset + this.directory.length) { return new Blob([this.directory]); }
        throw new Error(`Unexpected archive read at ${start}:${end}`);
    }
}

describe('dense ZIP directory', () => {
    test.each([false, true])('reads all checked members with ZIP64=%s', async (zip64) => {
        const entries = await readDenseZipDirectory(new SparseZipDirectory({zip64}));
        expect(entries).toHaveLength(count);
        expect(entries?.[0]).toMatchObject({filename: '0000.png', offset: 0, compressionMethod: 8, compressedSize: packedLength});
        expect(entries?.at(-1)?.filename).toBe('8191.png');
    });

    /* eslint-disable @stylistic/semi */
    test('retains exact, non-overlapping filename views without central headers', async () => {
        const entries = await readDenseZipDirectory(new SparseZipDirectory())
        expect(entries).not.toBeNull()
        if (entries === null) { throw new Error('Expected a dense directory'); }
        const backing = entries[0].rawFilename.buffer
        expect(backing.byteLength).toBe(count * filenameLength)
        const decoder = new TextDecoder()
        for (let i = 0; i < entries.length; ++i) {
            const {filename, rawFilename} = entries[i]
            expect(rawFilename.buffer).toBe(backing)
            expect(rawFilename.byteOffset).toBe(i * filenameLength)
            expect(rawFilename.byteLength).toBe(filenameLength)
            expect(decoder.decode(rawFilename)).toBe(filename)
        }
        entries[0].rawFilename[0] = 0x78
        expect(entries[0].filename).toBe('0000.png')
        expect(decoder.decode(entries[1].rawFilename)).toBe('0001.png')
    })

    test('copies both printable ASCII endpoints exactly', async () => {
        const archive = new SparseZipDirectory()
        archive.directory[46] = 0x20
        archive.directory[46 + filenameLength - 1] = 0x7e
        const entries = await readDenseZipDirectory(archive)
        expect(entries?.[0].filename).toBe(' 000.pn~')
        expect(entries?.[0].rawFilename).toEqual(new TextEncoder().encode(' 000.pn~'))
    })

    test.each([false, true])('preserves original raw names when logical names change after first read=%s', async (readBeforeChange) => {
        const entries = await readDenseZipDirectory(new SparseZipDirectory())
        if (entries === null) { throw new Error('Expected a dense directory') }
        const first = entries[0]
        const previous = readBeforeChange ? first.rawFilename : null
        first.filename = 'a much longer alias.png'
        expect(new TextDecoder().decode(first.rawFilename)).toBe('0000.png')
        expect(first.rawFilename.byteLength).toBe(filenameLength)
        const rawFilename = first.rawFilename
        rawFilename[0] = 0x78
        expect(first.rawFilename[0]).toBe(0x78)
        if (previous !== null) { expect(previous[0]).toBe(0x78) }
        expect(new TextDecoder().decode(entries[1].rawFilename)).toBe('0001.png')
    })

    test('checks local filenames against borrowed catalog views before returning payloads', async () => {
        const archive = new SparseZipDirectory()
        const directorySlice = archive.slice.bind(archive)
        archive.slice = (start, end) => {
            if (start !== 0) { return directorySlice(start, end) }
            if (typeof end !== 'number') { throw new Error('Expected a bounded local read') }
            const bytes = new Uint8Array(end)
            const view = new DataView(bytes.buffer)
            for (let i = 0; i < 2; i++) {
                const offset = i * (30 + filenameLength + packedLength)
                if (offset >= end) { break }
                view.setUint32(offset, 0x04034b50, true)
                view.setUint16(offset + 8, 8, true)
                view.setUint16(offset + 26, filenameLength, true)
                bytes.set(new TextEncoder().encode(`${String(i).padStart(4, '0')}.png`), offset + 30)
            }
            return new Blob([bytes])
        }
        const entries = await readDenseZipDirectory(archive)
        if (entries === null) { throw new Error('Expected a dense directory') }
        const reader = new RawZipPayloadReader(archive)
        // The real catalog receiver attaches getData directly to the entry.
        // Keep its prototype and getter intact when passing it to the reader.
        const entry = Object.assign(entries[0], {getData: () => {}})
        expect(await reader.read(entry, new AbortController().signal)).toEqual(new Uint8Array(packedLength))
        const batch = await reader.readBatch([entry, entries[1]], void 0, () => false, true)
        expect(batch?.sources.map(({bytes}) => bytes)).toEqual([new Uint8Array(packedLength), new Uint8Array(packedLength)])
        expect(batch?.sources[0].file).toBe(entry)
        expect(batch?.sources[1].file).toBe(entries[1])
        expect(batch?.sources[0].bytes.buffer).toBe(batch?.sources[1].bytes.buffer)
        entry.rawFilename[0] ^= 1
        await expect(reader.read(entry, new AbortController().signal)).rejects.toThrow('local filename disagrees')
        await expect(reader.readBatch([entry, entries[1]], void 0, () => false, true)).rejects.toThrow('local filename disagrees')
    })

    test('packs variable-length names without gaps or overlap', async () => {
        const archive = new SparseZipDirectory()
        const encoder = new TextEncoder()
        const first = encoder.encode('a.png')
        const second = encoder.encode('0000001.png')
        const firstHeader = archive.directory.slice(0, 46)
        const secondHeader = archive.directory.slice(54, 100)
        new DataView(firstHeader.buffer).setUint16(28, first.byteLength, true)
        const secondView = new DataView(secondHeader.buffer)
        secondView.setUint16(28, second.byteLength, true)
        secondView.setUint32(42, 30 + first.byteLength + packedLength, true)
        archive.directory.set(firstHeader, 0)
        archive.directory.set(first, 46)
        archive.directory.set(secondHeader, 46 + first.byteLength)
        archive.directory.set(second, 92 + first.byteLength)
        const entries = await readDenseZipDirectory(archive)
        expect(entries).not.toBeNull()
        expect(entries?.[0].rawFilename).toEqual(first)
        expect(entries?.[1].rawFilename).toEqual(second)
        expect(entries?.[1].rawFilename.byteOffset).toBe(first.byteLength)
        expect(entries?.[2].rawFilename.byteOffset).toBe(first.byteLength + second.byteLength)
        expect(entries?.[2].filename).toBe('0002.png')
        expect(entries?.[0].rawFilename.buffer.byteLength).toBe(count * filenameLength)
    })

    test('defers a directory whose declared entry count leaves insufficient filename space', async () => {
        const archive = new SparseZipDirectory()
        const tail = new DataView(archive.tail.buffer)
        tail.setUint16(84, count + 1, true)
        tail.setUint16(86, count + 1, true)
        expect(await readDenseZipDirectory(archive)).toBeNull()
    })

    test.each([0x1f, 0x7f])('defers non-printable filename byte %s to the generic reader', async (value) => {
        const archive = new SparseZipDirectory()
        archive.directory[46] = value
        expect(await readDenseZipDirectory(archive)).toBeNull()
    })

    test.each(['non-ASCII filename', 'invalid header', 'wrong final offset', 'short final payload'])('declines a late %s after earlier names passed validation', async (corrupt) => {
        const archive = new SparseZipDirectory({zip64: true})
        const last = archive.directory.length - 46 - filenameLength
        const view = new DataView(archive.directory.buffer)
        switch (corrupt) {
            case 'non-ASCII filename':
                archive.directory[last + 46 + filenameLength - 1] = 0xc2
                break
            case 'invalid header':
                archive.directory[last] ^= 1
                break
            case 'wrong final offset':
                view.setUint32(last + 42, view.getUint32(last + 42, true) - 1, true)
                break
            default:
                view.setUint32(last + 20, view.getUint32(last + 20, true) - 1, true)
                break
        }
        let checks = 0
        expect(await readDenseZipDirectory(archive, () => { checks++ })).toBeNull()
        expect(checks).toBe(3)
    })

    test('checks cancellation after the central read and before decoding any names', async () => {
        let checks = 0
        const cancelled = new DOMException('Dictionary import cancelled', 'AbortError')
        await expect(readDenseZipDirectory(new SparseZipDirectory(), () => {
            if (++checks === 3) { throw cancelled }
        })).rejects.toBe(cancelled)
        expect(checks).toBe(3)
    })

    /* eslint-enable @stylistic/semi */
    test('checks cancellation before reading the bounded central directory', async () => {
        let checks = 0;
        const error = new DOMException('Dictionary import cancelled', 'AbortError');
        await expect(readDenseZipDirectory(new SparseZipDirectory(), () => {
            if (++checks === 2) { throw error; }
        })).rejects.toBe(error);
        expect(checks).toBe(2);
    });

    test.each(['filename', 'length', 'overlap', 'descriptor', 'locator'])('defers unsupported %s to the generic reader', async (corrupt) => {
        expect(await readDenseZipDirectory(new SparseZipDirectory({zip64: true, corrupt}))).toBeNull();
    });
});
