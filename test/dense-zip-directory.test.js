/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {readFile} from 'node:fs/promises';
import {crc32} from 'node:zlib';
import {describe, expect, test} from 'vitest';
import {TextWriter, Uint8ArrayWriter} from '../ext/lib/zip.js';
import {readDenseZipDirectory, readDenseZipFileMap} from '../ext/js/dictionary/dense-zip-directory.js';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {setTermBankWasmModule} from '../ext/js/dictionary/term-bank-wasm-parser.js';
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';

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
        this.directoryOffset = directoryOffset;
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
        if (start === this.directoryOffset && end === this.directoryOffset + this.directory.length) { return new Blob([this.directory]); }
        throw new Error(`Unexpected archive read at ${start}:${end}`);
    }
}

/**
 * @param {SparseZipDirectory} archive
 * @param {(index: number) => string|undefined} getName Name override by entry index.
 */
function setSparseZipNames(archive, getName) {
    const oldDirectory = archive.directory;
    const oldRecordLength = 46 + filenameLength;
    const names = Array.from({length: count}, (_, index) => new TextEncoder().encode(getName(index) ?? new TextDecoder().decode(oldDirectory.subarray(index * oldRecordLength + 46, index * oldRecordLength + oldRecordLength))));
    const directoryLength = names.reduce((total, name) => total + 46 + name.byteLength, 0);
    const directory = new Uint8Array(directoryLength);
    let directoryPosition = 0;
    let localOffset = 0;
    for (let index = 0; index < count; ++index) {
        const oldHeader = oldDirectory.subarray(index * oldRecordLength, index * oldRecordLength + 46);
        const header = directory.subarray(directoryPosition, directoryPosition + 46);
        header.set(oldHeader);
        const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
        view.setUint16(28, names[index].byteLength, true);
        view.setUint32(42, localOffset, true);
        directoryPosition += 46;
        directory.set(names[index], directoryPosition);
        directoryPosition += names[index].byteLength;
        localOffset += 30 + names[index].byteLength + packedLength;
    }
    archive.directory = directory;
    archive.directoryOffset = localOffset;
    archive.archiveSize = localOffset + directory.byteLength + 22;
    const end = new DataView(archive.tail.buffer);
    end.setUint32(88, directory.byteLength, true);
    end.setUint32(92, localOffset, true);
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

/* eslint-disable @stylistic/semi */
describe('compact dense ZIP catalog', () => {
    const getData = async () => null

    test.each([false, true])('preserves complete directory metadata with ZIP64=%s', async (zip64) => {
        const archive = new SparseZipDirectory({zip64})
        const entries = await readDenseZipDirectory(archive)
        const map = await readDenseZipFileMap(archive, getData)
        if (entries === null || map === null) { throw new Error('Expected supported dense directory') }
        expect([...map.keys()]).toEqual(entries.map(({filename}) => filename))
        expect(map.size).toBe(count)
        for (const expected of entries) {
            const entry = map.get(expected.filename)
            expect(entry).toEqual({...expected, getData})
            expect(map.get(expected.filename)).toBe(entry)
        }
    })

    test('decodes maximum-length filenames across bounded ASCII windows', async () => {
        const archive = new SparseZipDirectory()
        const longestName = 'a'.repeat(65_535)
        setSparseZipNames(archive, (index) => {
            if (index === 0) { return longestName; }
            if (index === 1) { return 'b'; }
            if (index === 2) { return 'c'.repeat(65_535); }
        })
        const map = await readDenseZipFileMap(archive, getData)
        if (map === null) { throw new Error('Expected supported dense directory') }
        expect([...map.keys()].slice(0, 3)).toEqual([longestName, 'b', 'c'.repeat(65_535)])
        const longestEntry = map.get(longestName)
        const shortEntry = map.get('b')
        if (typeof longestEntry === 'undefined' || !('rawFilename' in longestEntry) || typeof shortEntry === 'undefined' || !('rawFilename' in shortEntry)) {
            throw new Error('Expected dense ZIP entries')
        }
        expect(longestEntry.rawFilename).toHaveLength(65_535)
        expect(shortEntry.rawFilename).toEqual(new TextEncoder().encode('b'))
        const entries = await readDenseZipDirectory(archive)
        expect(entries?.slice(0, 3).map(({filename}) => filename)).toEqual([longestName, 'b', 'c'.repeat(65_535)])
    })

    test('reports the first duplicate after complete directory validation', async () => {
        const archive = new SparseZipDirectory()
        setSparseZipNames(archive, (index) => {
            if (index < 2) { return 'first-duplicate.png'; }
            if (index < 4) { return 'later-duplicate.png'; }
        })
        await expect(readDenseZipFileMap(archive, getData)).rejects.toThrow("Duplicate archive filename: 'first-duplicate.png'")
        new DataView(archive.directory.buffer).setUint32(archive.directory.length - 54 + 42, 0, true)
        await expect(readDenseZipFileMap(archive, getData)).resolves.toBeNull()
    })

    test('rejects duplicate names only after completing directory validation', async () => {
        const archive = new SparseZipDirectory()
        archive.directory.copyWithin(54 + 46, 46, 46 + filenameLength)
        await expect(readDenseZipFileMap(archive, getData)).rejects.toThrow("Duplicate archive filename: '0000.png'")
        expect(await readDenseZipDirectory(archive)).toHaveLength(count)
        new DataView(archive.directory.buffer).setUint32((count - 1) * 54, 0, true)
        await expect(readDenseZipFileMap(archive, getData)).resolves.toBeNull()
    })

    test.each(['filename', 'length', 'overlap', 'descriptor', 'locator'])('retains generic ZIP fallback for %s', async (corrupt) => {
        expect(await readDenseZipFileMap(new SparseZipDirectory({zip64: true, corrupt}), getData)).toBeNull()
    })

    test('keeps small archives on the ordinary ZIP reader', async () => {
        expect(await readDenseZipFileMap(new Blob(), getData)).toBeNull()
        expect(await readDenseZipFileMap(new Blob([new Uint8Array(22)]), getData)).toBeNull()
    })

    test('checks cancellation at the same read boundaries', async () => {
        let calls = 0
        const error = new DOMException('Cancelled dense catalog', 'AbortError')
        await expect(readDenseZipFileMap(new SparseZipDirectory(), getData, () => {
            if (++calls === 3) { throw error }
        })).rejects.toBe(error)
        expect(calls).toBe(3)
    })

    test('rejects a late duplicate filename when the importer builds the decoded catalog', async () => {
        const archive = new SparseZipDirectory()
        const last = archive.directory.length - 46 - filenameLength
        archive.directory.set(new TextEncoder().encode('0000.png'), last + 46)
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader())
        await expect(importer._getFilesFromArchive(archive)).rejects.toThrow("Duplicate archive filename: '0000.png'")
    })

    test('decodes dense small entries through the importer text and byte writers', async () => {
        setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))))
        const archive = new SparseZipDirectory()
        const content = new Uint8Array(packedLength - 5).fill(0x61)
        const stored = new Uint8Array(packedLength)
        const header = new DataView(stored.buffer)
        stored[0] = 1
        header.setUint16(1, content.length, true)
        header.setUint16(3, content.length ^ 0xffff, true)
        stored.set(content, 5)
        const directory = new DataView(archive.directory.buffer)
        directory.setUint32(16, crc32(content), true)
        directory.setUint32(24, content.length, true)
        const directorySlice = archive.slice.bind(archive)
        archive.slice = (start, end) => {
            if (start !== 0) { return directorySlice(start, end) }
            if (typeof end !== 'number') { throw new Error('Expected a bounded local read') }
            const bytes = new Uint8Array(end)
            const view = new DataView(bytes.buffer)
            view.setUint32(0, 0x04034b50, true)
            view.setUint16(8, 8, true)
            view.setUint16(26, filenameLength, true)
            bytes.set(new TextEncoder().encode('0000.png'), 30)
            bytes.set(stored, 30 + filenameLength)
            return new Blob([bytes])
        }
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader())
        const {fileMap, zipReader, catalog} = await importer._getFilesFromArchive(archive)
        try {
            expect(catalog).toBe('dense-zip')
            const entry = fileMap.get('0000.png')
            if (typeof entry === 'undefined') { throw new Error('Expected the first dense entry') }
            const textWriter = /** @type {import('@zip.js/zip.js').Writer<string>} */ (/** @type {unknown} */ (new TextWriter()));
            const byteWriter = /** @type {import('@zip.js/zip.js').Writer<Uint8Array>} */ (/** @type {unknown} */ (new Uint8ArrayWriter()));
            expect(await importer._getData(entry, textWriter)).toBe('a'.repeat(content.length));
            expect(await importer._getData(entry, byteWriter)).toEqual(content);
        } finally {
            await zipReader.close()
        }
    })
})
/* eslint-enable @stylistic/semi */
