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

import {Buffer} from 'node:buffer';
import {deflateSync} from 'node:zlib';
import {afterEach, describe, expect, test, vi} from 'vitest';
import MDictBase from '../ext/js/dictionary/mdx/vendor/js-mdict/mdict-base.js';

/** @typedef {'utf-8'|'utf-16le'|'utf-16be'} Encoding */

afterEach(() => { vi.restoreAllMocks(); });

/**
 * @param {Encoding} [encoding]
 * @param {number} [numWidth]
 * @returns {MDictBase}
 */
function createContext(encoding = 'utf-8', numWidth = 8) {
    return /** @type {MDictBase} */ (Object.assign(Object.create(MDictBase.prototype), {
        meta: {
            encoding: encoding.startsWith('utf-16') ? 'UTF-16' : 'UTF-8',
            ext: 'mdx',
            numWidth,
            keyDecoder: new TextDecoder(encoding, {ignoreBOM: true}),
        },
        options: {maxDecompressedBlockBytes: 16 * 1024 * 1024},
    }));
}

/**
 * @param {string[]} keys
 * @param {Encoding} [encoding]
 * @param {number} [numWidth]
 * @returns {Buffer<ArrayBuffer>}
 */
function createKeys(keys, encoding = 'utf-8', numWidth = 8) {
    const width = encoding.startsWith('utf-16') ? 2 : 1;
    const parts = keys.map((key, index) => {
        const text = Buffer.from(key, width === 2 ? 'utf16le' : 'utf8');
        if (encoding === 'utf-16be') { text.swap16(); }
        const entry = Buffer.alloc(numWidth + text.length + width);
        if (numWidth === 8) {
            entry.writeBigUInt64BE(BigInt(index * 7));
        } else {
            entry.writeUInt32BE(index * 7);
        }
        entry.set(text, numWidth);
        return entry;
    });
    return Buffer.concat(parts);
}

/**
 * @param {Uint8Array} payload
 * @param {boolean} [compressed]
 * @returns {Uint8Array<ArrayBuffer>}
 */
function createBlock(payload, compressed = false) {
    const zipped = deflateSync(payload);
    const content = compressed ? zipped : payload;
    const block = new Uint8Array(8 + content.byteLength);
    block[0] = compressed ? 2 : 0;
    // Independent Adler-32 oracle: use the checksum from Node's zlib trailer.
    new DataView(block.buffer).setUint32(4, zipped.readUInt32BE(zipped.length - 4), false);
    block.set(content, 8);
    return block;
}

/**
 * @param {number[]} counts
 * @param {boolean} [compressed]
 * @returns {MDictBase}
 */
function createBlockContext(counts, compressed = false) {
    const context = createContext();
    const payloads = counts.map((count) => createKeys(Array.from({length: count}, (_value, i) => `key${i}`)));
    const blocks = payloads.map((payload) => createBlock(payload, compressed));
    let offset = 0;
    context.keyInfoList = blocks.map((block, index) => {
        const result = {
            keyBlockPackSize: block.length,
            keyBlockPackAccumulator: offset,
            keyBlockUnpackSize: payloads[index].length,
            keyBlockEntriesNum: counts[index],
        };
        offset += block.length;
        return result;
    });
    const bytes = new Uint8Array(Buffer.concat(blocks));
    context._keyBlockInfoEndOffset = 0;
    Object.assign(context, {
        keyHeader: {keywordNum: counts.reduce((sum, count) => sum + count, 0), keywordBlockPackedSize: bytes.length},
        scanner: {readBuffer: (/** @type {number} */ start, /** @type {number} */ length) => bytes.slice(start, start + length)},
    });
    return context;
}

describe('MDict empty key blocks', () => {
    for (const compressed of [false, true]) {
        test.each([
            {counts: [1, 0]},
            {counts: [1, 0, 1]},
            {counts: [0, 1, 0, 0, 1, 0]},
            {counts: [2, 0, 0]},
            {counts: [0, 0]},
            {counts: []},
            {counts: [0, 2]},
            {counts: [1, 1]},
        ])(`preserves block indexes and offsets for $counts, compressed=${String(compressed)}`, ({counts}) => {
            const context = createBlockContext(counts, compressed);
            context._readKeyBlocks();
            expect(context.keywordList).toHaveLength(counts.reduce((sum, count) => sum + count, 0));
            expect(context.keywordList.map((/** @type {{keyBlockIdx: number}} */ item) => item.keyBlockIdx)).toEqual(
                counts.flatMap((count, index) => Array.from({length: count}, () => index)),
            );
            expect(context._keyBlockEndOffset).toBe(context.keyHeader.keywordBlockPackedSize);
        });
    }

    test('does not bypass the declared entry-count check for an empty block', () => {
        const context = createBlockContext([1, 0, 1]);
        context.keyInfoList[1].keyBlockEntriesNum = 1;
        expect(() => context._readKeyBlocks()).toThrow('MDict key block entry count mismatch');
    });

    test('bridges non-empty entries across empty blocks', () => {
        const context = createBlockContext([1, 0, 0, 2]);
        context._readKeyBlocks();
        expect(context.keywordList.map((/** @type {{recordEndOffset: number}} */ item) => item.recordEndOffset)).toEqual([0, 7, -1]);
    });
});

describe('MDict key text views', () => {
    /** @type {Encoding[]} */
    const encodings = ['utf-8', 'utf-16le', 'utf-16be'];
    for (const encoding of encodings) {
        for (const numWidth of [4, 8]) {
            test(`preserves text, BOM, offsets and ownership: ${encoding}/${numWidth}`, () => {
                const keys = ['', 'ASCII', '日本語', '😀🧪', '\ufeffliteral', ' e\u0301 ', 'x'.repeat(65536)];
                const original = createKeys(keys, encoding, numWidth);
                const padded = Buffer.alloc(original.length + 41, 0xa5);
                padded.set(original, 17);
                const bytes = padded.subarray(17, 17 + original.length);
                const copy = vi.spyOn(bytes, 'slice');
                const context = createContext(encoding, numWidth);
                const entries = context.splitKeyBlock(bytes, 3);
                expect(copy).not.toHaveBeenCalled();
                copy.mockRestore();
                expect(entries.map((/** @type {{keyText: string}} */ item) => item.keyText)).toEqual(keys);
                expect(entries.map((/** @type {{recordStartOffset: number}} */ item) => item.recordStartOffset)).toEqual(keys.map((_key, i) => i * 7));
                expect(bytes).toEqual(original);
                expect(padded.subarray(0, 17).every((value) => value === 0xa5)).toBe(true);
                expect(padded.subarray(17 + original.length).every((value) => value === 0xa5)).toBe(true);
                bytes.fill(0xff);
                expect(entries.map((/** @type {{keyText: string}} */ item) => item.keyText)).toEqual(keys);
            });

            test(`rejects clipped numeric fields and terminators: ${encoding}/${numWidth}`, () => {
                const bytes = createKeys(['word'], encoding, numWidth);
                const context = createContext(encoding, numWidth);
                expect(() => context.splitKeyBlock(bytes.subarray(0, numWidth - 1), 0)).toThrow('Truncated MDict numeric field');
                expect(() => context.splitKeyBlock(bytes.subarray(0, -1), 0)).toThrow('Unterminated MDict key block entry');
            });
        }
    }
});

describe('MDict stored key-block allocation', () => {
    test.each([0, 1, 65535, 65537])('rejects a 65536-byte payload declaring %i bytes before copying', (size) => {
        const block = createBlock(new Uint8Array(65536));
        const copy = vi.spyOn(block, 'slice');
        expect(() => createContext().unpackKeyBlock(block, size)).toThrow(`MDict key block size mismatch: expected ${size}, got 65536`);
        expect(copy).not.toHaveBeenCalledWith(8);
    });

    test('preserves independent output ownership and checksum rejection', () => {
        const block = createBlock(new Uint8Array([1, 2, 3]));
        const context = createContext();
        const decoded = context.unpackKeyBlock(block, 3);
        decoded.fill(9);
        expect([...block.subarray(8)]).toEqual([1, 2, 3]);
        block[4] ^= 1;
        expect(() => context.unpackKeyBlock(block, 3)).toThrow('MDict key block checksum mismatch');
    });
});

/**
 * Creates complete binary dictionaries, including self-consistent metadata and checksums.
 * @param {number[]} counts
 * @param {Encoding} encoding
 * @param {number} version
 * @param {'mdx'|'mdd'} ext
 * @returns {{bytes: Uint8Array<ArrayBuffer>, entries: {keyText: string, recordStartOffset: number, recordEndOffset: number}[], fileName: string}}
 */
function createBinaryFixture(counts, encoding, version, ext) {
    const width = version >= 2 ? 8 : 4;
    const unit = encoding.startsWith('utf-16') ? 2 : 1;
    /**
     * @param {number} value
     * @param {number} [bytes]
     * @param {boolean} [littleEndian]
     * @returns {Buffer}
     */
    const number = (value, bytes = width, littleEndian = false) => {
        const result = Buffer.alloc(bytes);
        if (bytes === 8) {
            result.writeBigUInt64BE(BigInt(value));
        } else if (littleEndian) {
            result.writeUIntLE(value, 0, bytes);
        } else {
            result.writeUIntBE(value, 0, bytes);
        }
        return result;
    };
    /**
     * @param {string} value
     * @returns {Buffer}
     */
    const text = (value) => {
        const bytes = Buffer.from(value, unit === 2 ? 'utf16le' : 'utf8');
        if (encoding === 'utf-16be') { bytes.swap16(); }
        return bytes;
    };
    /**
     * @param {Uint8Array} value
     * @returns {number}
     */
    const checksum = (value) => {
        const zipped = deflateSync(value);
        return zipped.readUInt32BE(zipped.length - 4);
    };
    const headerText = `<Dictionary GeneratedByEngineVersion="${version}.0" Encoding="${encoding}" KeyCaseSensitive="Yes" StripKey="No"/>\0`;
    const headerBytes = Buffer.from(headerText, 'utf16le');
    const header = Buffer.concat([number(headerBytes.length, 4), headerBytes, number(checksum(headerBytes), 4, true)]);
    /** @type {Buffer[]} */
    const records = [];
    /** @type {{keyText: string, recordStartOffset: number, recordEndOffset: number}[]} */
    const entries = [];
    let recordOffset = 0;
    /** @type {Buffer[]} */
    const keyInfos = [];
    /** @type {Uint8Array[]} */
    const keyBlocks = [];
    for (const count of counts) {
        /** @type {Buffer[]} */
        const keys = [];
        /** @type {Buffer[]} */
        const rows = [];
        for (let index = 0; index < count; ++index) {
            const key = `語${String(entries.length).padStart(4, '0')}`;
            const record = text(`definition${entries.length}\0`);
            const keyBytes = text(key);
            keys.push(keyBytes);
            rows.push(Buffer.concat([number(recordOffset), keyBytes, Buffer.alloc(unit)]));
            entries.push({keyText: key, recordStartOffset: recordOffset, recordEndOffset: recordOffset + record.length});
            records.push(record);
            recordOffset += record.length;
        }
        const payload = Buffer.concat(rows);
        const encoded = createBlock(payload);
        keyBlocks.push(encoded);
        const first = keys[0] ?? Buffer.alloc(0);
        const last = keys.at(-1) ?? Buffer.alloc(0);
        keyInfos.push(Buffer.concat([
            number(count),
            number(first.length / unit, width / 4),
            first,
            version >= 2 ? Buffer.alloc(unit) : Buffer.alloc(0),
            number(last.length / unit, width / 4),
            last,
            version >= 2 ? Buffer.alloc(unit) : Buffer.alloc(0),
            number(encoded.length),
            number(payload.length),
        ]));
    }
    const keyInfoBytes = Buffer.concat(keyInfos);
    const keyInfo = version >= 2 ? createBlock(keyInfoBytes, true) : keyInfoBytes;
    const encodedKeys = Buffer.concat(keyBlocks);
    const fields = [number(counts.length), number(entries.length)];
    if (version >= 2) { fields.push(number(keyInfoBytes.length)); }
    fields.push(number(keyInfo.length), number(encodedKeys.length));
    const keyHeaderBytes = Buffer.concat(fields);
    const keyHeader = version >= 2 ? Buffer.concat([keyHeaderBytes, number(checksum(keyHeaderBytes), 4)]) : keyHeaderBytes;
    const data = entries.length > 0 ? createBlock(Buffer.concat(records)) : Buffer.alloc(0);
    const recordInfo = entries.length > 0 ? Buffer.concat([number(data.length), number(recordOffset)]) : Buffer.alloc(0);
    const recordHeader = Buffer.concat([number(entries.length > 0 ? 1 : 0), number(entries.length), number(recordInfo.length), number(data.length)]);
    return {
        bytes: new Uint8Array(Buffer.concat([header, keyHeader, keyInfo, encodedKeys, recordHeader, recordInfo, data])),
        entries,
        fileName: `fixture.${ext}`,
    };
}

describe('MDict complete binary empty-block fixtures', () => {
    /** @type {{encoding: Encoding, ext: 'mdx'|'mdd'}[]} */
    const variants = [
        {encoding: 'utf-8', ext: 'mdx'},
        {encoding: 'utf-16le', ext: 'mdx'},
        {encoding: 'utf-16be', ext: 'mdx'},
        {encoding: 'utf-16le', ext: 'mdd'},
    ];
    for (const version of [1, 2]) {
        for (const {encoding, ext} of variants) {
            test.each([
                {counts: [1, 0]},
                {counts: [1, 0, 1]},
                {counts: [0, 1, 0, 0, 1, 0]},
                {counts: [2, 0, 0]},
                {counts: [0, 0]},
                {counts: []},
                {counts: [0, 2]},
                {counts: [1, 1]},
            ])(`reads complete v${version} ${encoding} ${ext} fixture $counts`, ({counts}) => {
                const fixture = createBinaryFixture(counts, encoding, version, ext);
                const padded = new Uint8Array(fixture.bytes.length + 41).fill(0xa5);
                padded.set(fixture.bytes, 17);
                const view = padded.subarray(17, 17 + fixture.bytes.length);
                const context = new MDictBase(fixture.fileName, view, '', {
                    encryptType: -1,
                    maxDecompressedBlockBytes: 16 * 1024 * 1024,
                });
                expect(context.keywordList.map((/** @type {{keyText: string, recordStartOffset: number, recordEndOffset: number}} */ item) => ({
                    keyText: item.keyText,
                    recordStartOffset: item.recordStartOffset,
                    recordEndOffset: item.recordEndOffset,
                }))).toEqual(fixture.entries);
                expect(view).toEqual(fixture.bytes);
                expect(padded.subarray(0, 17).every((value) => value === 0xa5)).toBe(true);
                expect(padded.subarray(17 + fixture.bytes.length).every((value) => value === 0xa5)).toBe(true);
            });
        }
    }
});
