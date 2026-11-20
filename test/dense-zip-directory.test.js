/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test} from 'vitest';
import {readDenseZipDirectory} from '../ext/js/dictionary/dense-zip-directory.js';

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
