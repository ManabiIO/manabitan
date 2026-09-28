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

import assert from 'node:assert/strict';
import {test} from 'vitest';
import {RawZipPayloadReader} from '../ext/js/dictionary/term-bank-source-pipeline.js';

/** A small backing Blob with an unused logical suffix exercises ranged reads. */
class RangedBlob extends Blob {
    /** @param {Uint8Array<ArrayBuffer>} bytes */
    constructor(bytes) {
        super([bytes]);
        /** @type {number[][]} */
        this.ranges = [];
        /** @type {((index: number) => void)|null} */
        this.onRead = null;
        this.truncateRead = -1;
    }

    /** @returns {number} */
    get size() { return 128 * 1024 * 1024 + super.size; }

    /** @returns {Promise<ArrayBuffer>} */
    async arrayBuffer() { throw new Error('Whole archive reads are forbidden'); }

    /**
     * @param {number} [start]
     * @param {number} [end]
     * @param {string} [type]
     * @returns {Blob}
     */
    slice(start = 0, end = this.size, type = '') {
        const index = this.ranges.length;
        this.ranges.push([start, end]);
        const result = super.slice(start, end - (index === this.truncateRead ? 1 : 0), type);
        const read = result.arrayBuffer.bind(result);
        result.arrayBuffer = async () => {
            const bytes = await read();
            this.onRead?.(index);
            return bytes;
        };
        return result;
    }
}

/**
 * @param {{offset?: number, name?: Uint8Array<ArrayBuffer>, extra?: number, method?: number, flags?: number, payloadSize?: number}} [options]
 * @returns {{bytes: Uint8Array<ArrayBuffer>, file: {filename: string, offset: number, compressionMethod: number, compressedSize: number, rawFilename?: Uint8Array<ArrayBuffer>}, payload: Uint8Array<ArrayBuffer>, dataOffset: number}}
 */
function fixture({offset = 7, name = new TextEncoder().encode('term_bank_1.json'), extra = 13, method = 8, flags = 0, payloadSize = 513} = {}) {
    const payload = Uint8Array.from({length: payloadSize}, (_, index) => index & 255);
    const dataOffset = offset + 30 + name.length + extra;
    const bytes = new Uint8Array(dataOffset + payload.length);
    const view = new DataView(bytes.buffer);
    view.setUint32(offset, 0x04034b50, true);
    view.setUint16(offset + 6, flags, true);
    view.setUint16(offset + 8, method, true);
    view.setUint16(offset + 26, name.length, true);
    view.setUint16(offset + 28, extra, true);
    bytes.set(name, offset + 30);
    bytes.set(payload, dataOffset);
    return {bytes, file: {filename: 'term_bank_1.json', offset, compressionMethod: method, compressedSize: payload.length, rawFilename: name}, payload, dataOffset};
}

for (const method of [0, 8]) {
    for (const payloadSize of [0, 1, 65536]) {
        test(`ranged method ${method}, ${payloadSize} bytes uses two bounded reads`, async () => {
            const {bytes, file, payload, dataOffset} = fixture({method, payloadSize});
            const blob = new RangedBlob(bytes);
            const result = await new RawZipPayloadReader(blob).read(file, new AbortController().signal);
            assert.deepEqual(result, payload);
            assert.deepEqual(blob.ranges, [[file.offset, file.offset + 30 + (file.rawFilename?.length ?? 0)], [dataOffset, dataOffset + payload.length]]);
            assert.notEqual(result.buffer, bytes.buffer);
            if (result.length > 0) { result[0] ^= 255; }
            assert.deepEqual(bytes.subarray(dataOffset), payload);
        });
    }
}

for (const name of [new Uint8Array(0), new Uint8Array(65535).fill(65), new TextEncoder().encode('辞書/term_bank_1.json')]) {
    test(`supports a ${name.length}-byte name`, async () => {
        const {bytes, file, payload} = fixture({name});
        const blob = new RangedBlob(bytes);
        assert.deepEqual(await new RawZipPayloadReader(blob).read(file, new AbortController().signal), payload);
        assert.equal(blob.ranges.length, 2);
    });
}

test('missing raw filename keeps two-read transport', async () => {
    const {bytes, file, payload} = fixture();
    delete file.rawFilename;
    const blob = new RangedBlob(bytes);
    assert.deepEqual(await new RawZipPayloadReader(blob).read(file, new AbortController().signal), payload);
    assert.deepEqual(blob.ranges[0], [file.offset, file.offset + 30]);
    assert.equal(blob.ranges.length, 2);
});

for (const representation of ['buffer', 'blob']) {
    test(`preserves the small ${representation} path`, async () => {
        const {bytes, file, payload} = fixture();
        const source = representation === 'blob' ? new Blob([bytes]) : bytes.buffer;
        assert.deepEqual(await new RawZipPayloadReader(source).read(file, new AbortController().signal), payload);
    });
}

for (const mutation of ['name-byte', 'name-length', 'method', 'encryption', 'signature', 'bounds']) {
    test(`rejects ${mutation} before payload I/O`, async () => {
        const {bytes, file} = fixture();
        const view = new DataView(bytes.buffer);
        switch (mutation) {
            case 'name-byte': bytes[file.offset + 30] ^= 1; break;
            case 'name-length': view.setUint16(file.offset + 26, 1, true); break;
            case 'method': view.setUint16(file.offset + 8, 0, true); break;
            case 'encryption': view.setUint16(file.offset + 6, 1, true); break;
            case 'signature': bytes[file.offset] ^= 1; break;
            case 'bounds':
                file.compressedSize = 128 * 1024 * 1024;
                view.setUint16(file.offset + 28, 65535, true);
                break;
        }
        const blob = new RangedBlob(bytes);
        await assert.rejects(new RawZipPayloadReader(blob).read(file, new AbortController().signal));
        assert.equal(blob.ranges.length, 1);
    });
}

test('rejects impossible central name lengths before I/O', async () => {
    const {bytes, file} = fixture();
    file.rawFilename = new Uint8Array(65536);
    const blob = new RangedBlob(bytes);
    await assert.rejects(new RawZipPayloadReader(blob).read(file, new AbortController().signal), /filename disagrees/);
    assert.equal(blob.ranges.length, 0);
});

for (const phase of [-1, 0, 1]) {
    test(`cancellation at phase ${phase} never returns bytes`, async () => {
        const {bytes, file} = fixture();
        const blob = new RangedBlob(bytes);
        const controller = new AbortController();
        if (phase < 0) { controller.abort(); }
        blob.onRead = (index) => { if (index === phase) { controller.abort(); } };
        await assert.rejects(new RawZipPayloadReader(blob).read(file, controller.signal), {name: 'AbortError'});
        assert.equal(blob.ranges.length, phase + 1);
    });
}

for (const phase of [0, 1]) {
    test(`rejects incomplete range ${phase}`, async () => {
        const {bytes, file} = fixture();
        const blob = new RangedBlob(bytes);
        blob.truncateRead = phase;
        await assert.rejects(new RawZipPayloadReader(blob).read(file, new AbortController().signal), /range read is incomplete/);
    });
}

for (const representation of ['buffer', 'blob']) {
    test(`rejects a central filename beyond the small ${representation} boundary`, async () => {
        const {bytes, file} = fixture();
        file.offset = bytes.byteLength - 30;
        const source = representation === 'blob' ? new Blob([bytes]) : bytes.buffer;
        await assert.rejects(new RawZipPayloadReader(source).read(file, new AbortController().signal), /filename disagrees/);
    });
}
