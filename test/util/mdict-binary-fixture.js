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

import {deflateSync} from 'node:zlib';

/**
 * @param {Uint8Array} bytes
 * @returns {number}
 */
function adler32(bytes) {
    let a = 1;
    let b = 0;
    for (const byte of bytes) {
        a = (a + byte) % 65521;
        b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
}

/**
 * @param {number} value
 * @param {number} width
 * @param {boolean} [littleEndian]
 * @returns {Buffer}
 */
function integer(value, width, littleEndian = false) {
    if (!Number.isSafeInteger(value) || value < 0) { throw new RangeError('Invalid fixture integer'); }
    const bytes = Buffer.alloc(width);
    if (width === 8) {
        bytes.writeBigUInt64BE(BigInt(value));
    } else if (littleEndian) {
        bytes.writeUIntLE(value, 0, width);
    } else {
        bytes.writeUIntBE(value, 0, width);
    }
    return bytes;
}

/**
 * @param {Buffer} bytes
 * @param {'raw'|'zlib'} compression
 * @returns {Buffer}
 */
function packBlock(bytes, compression) {
    return Buffer.concat([
        integer(compression === 'raw' ? 0 : 2, 4, true),
        integer(adler32(bytes), 4),
        compression === 'raw' ? bytes : deflateSync(bytes),
    ]);
}

/**
 * @param {string} value
 * @returns {string}
 */
function xmlAttribute(value) {
    return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}

/**
 * @param {'utf8'|'utf16le'} encoding
 * @returns {(value: string) => Uint8Array}
 */
function createFixtureTextEncoder(encoding) {
    /**
     * @param {string} value
     * @returns {Uint8Array}
     */
    return function encodeFixtureText(value) {
        return new Uint8Array(Buffer.from(value, encoding));
    };
}

/**
 * Independent, deterministic writer for raw/zlib, unencrypted MDict fixtures.
 * Does not import the parser under test. Record blocks may split Unicode scalars.
 * Optional metadata overrides are only for negative regression cases.
 * @param {Array<{key: string, value: string|Uint8Array}>} entries
 * @param {{mdd?: boolean, encoding?: 'utf8'|'utf16le', encodingLabel?: string, textEncoder?: ((value: string) => Uint8Array), encrypted?: string|number, compression?: 'raw'|'zlib', recordBlockSize?: number, keysPerBlock?: number, title?: string, version?: string, keyBlockUnpackSizeDelta?: number, keyBlockEntryCounts?: number[], keyInfoTrailer?: Uint8Array, keyInfoTerminatorByte?: number}} [options]
 * @returns {{bytes: Uint8Array, records: Uint8Array[], recordDataOffset: number}}
 */
export function makeMdictFixture(entries, options = {}) {
    const {
        mdd = false,
        encoding = 'utf8',
        encodingLabel = encoding === 'utf16le' ? 'UTF-16' : 'UTF-8',
        textEncoder = createFixtureTextEncoder(encoding),
        encrypted = 0,
        compression = 'zlib',
        recordBlockSize = 64,
        keysPerBlock = 2,
        title = 'MDict binary regression fixture',
        version = '2.0',
        keyBlockUnpackSizeDelta = 0,
        keyBlockEntryCounts = [],
        keyInfoTrailer = new Uint8Array(0),
        keyInfoTerminatorByte = 0,
    } = options;
    if (!Number.isSafeInteger(recordBlockSize) || recordBlockSize < 1 ||
    !Number.isSafeInteger(keysPerBlock) || keysPerBlock < 1) {
        throw new RangeError('Fixture block sizes must be positive safe integers');
    }
    // MDict key blocks are ordered by key. Keep the fixture writer independent
    // from the parser while still emitting a valid dictionary for unsorted input.
    const orderedEntries = [...entries].sort((a, b) => a.key.localeCompare(b.key));
    const v2 = Number.parseFloat(version) >= 2;
    const numWidth = v2 ? 8 : 4;
    const keyEncoding = mdd ? 'utf16le' : encoding;
    const keyUnit = keyEncoding === 'utf16le' ? 2 : 1;
    const terminator = Buffer.alloc(keyUnit);
    const keyInfoTerminator = Buffer.alloc(keyUnit, keyInfoTerminatorByte);
    /**
     * @param {string} value
     * @returns {Buffer}
     */
    const encodeDictionaryText = (value) => Buffer.from(textEncoder(value));
    const records = orderedEntries.map(({value}) => {
        const bytes = typeof value === 'string' ? (mdd ? Buffer.from(value, 'utf8') : encodeDictionaryText(value)) : Buffer.from(value);
        return mdd ? bytes : Buffer.concat([bytes, Buffer.alloc(encoding === 'utf16le' ? 2 : 1)]);
    });
    let position = 0;
    const offsets = records.map((record) => {
        const start = position;
        position += record.length;
        return start;
    });
    const allRecords = Buffer.concat(records);
    /** @type {Buffer[]} */
    const packedRecords = [];
    /** @type {Buffer[]} */
    const recordInfo = [];
    for (let start = 0; start < allRecords.length; start += recordBlockSize) {
        const part = allRecords.subarray(start, Math.min(start + recordBlockSize, allRecords.length));
        const packed = packBlock(part, compression);
        packedRecords.push(packed);
        recordInfo.push(integer(packed.length, numWidth), integer(part.length, numWidth));
    }
    /** @type {Buffer[]} */
    const packedKeys = [];
    /** @type {Buffer[]} */
    const keyInfo = [];
    for (let index = 0; index < orderedEntries.length; index += keysPerBlock) {
        const count = Math.min(keysPerBlock, orderedEntries.length - index);
        const keyParts = [];
        for (let i = index; i < index + count; i += 1) {
            keyParts.push(integer(offsets[i], numWidth), mdd ? Buffer.from(orderedEntries[i].key, keyEncoding) : encodeDictionaryText(orderedEntries[i].key), terminator);
        }
        const unpacked = Buffer.concat(keyParts);
        const packed = packBlock(unpacked, compression);
        const first = mdd ? Buffer.from(orderedEntries[index].key, keyEncoding) : encodeDictionaryText(orderedEntries[index].key);
        const last = mdd ? Buffer.from(orderedEntries[index + count - 1].key, keyEncoding) : encodeDictionaryText(orderedEntries[index + count - 1].key);
        keyInfo.push(
            integer(keyBlockEntryCounts[packedKeys.length] ?? count, numWidth),
            integer(first.length / keyUnit, v2 ? 2 : 1),
            first,
            v2 ? keyInfoTerminator : Buffer.alloc(0),
            integer(last.length / keyUnit, v2 ? 2 : 1),
            last,
            v2 ? keyInfoTerminator : Buffer.alloc(0),
            integer(packed.length, numWidth),
            integer(unpacked.length + keyBlockUnpackSizeDelta, numWidth),
        );
        packedKeys.push(packed);
    }
    const keyInfoBytes = Buffer.concat([...keyInfo, keyInfoTrailer]);
    const packedKeyInfo = v2 ? packBlock(keyInfoBytes, 'zlib') : keyInfoBytes;
    const keyBytes = Buffer.concat(packedKeys);
    const keyHeader = Buffer.concat([
        integer(packedKeys.length, numWidth),
        integer(orderedEntries.length, numWidth),
        ...(v2 ? [integer(keyInfoBytes.length, numWidth)] : []),
        integer(packedKeyInfo.length, numWidth),
        integer(keyBytes.length, numWidth),
    ]);
    const encodingAttribute = mdd ? '' : ` Encoding="${xmlAttribute(encodingLabel)}"`;
    const tag = mdd ? 'Library_Data' : 'Dictionary';
    const header = Buffer.from(`<${tag} GeneratedByEngineVersion="${version}" RequiredEngineVersion="${version}" Encrypted="${xmlAttribute(String(encrypted))}"${encodingAttribute} Title="${xmlAttribute(title)}" Description="Generated regression fixture"/>\0`, 'utf16le');
    const recordInfoBytes = Buffer.concat(recordInfo);
    const packedRecordBytes = Buffer.concat(packedRecords);
    const beforeRecordData = Buffer.concat([
        integer(header.length, 4),
        header,
        integer(adler32(header), 4, true),
        keyHeader,
        ...(v2 ? [integer(adler32(keyHeader), 4)] : []),
        packedKeyInfo,
        keyBytes,
        integer(packedRecords.length, numWidth),
        integer(orderedEntries.length, numWidth),
        integer(recordInfoBytes.length, numWidth),
        integer(packedRecordBytes.length, numWidth),
        recordInfoBytes,
    ]);
    return {
        bytes: new Uint8Array(Buffer.concat([beforeRecordData, packedRecordBytes])),
        records: records.map((record) => new Uint8Array(record)),
        recordDataOffset: beforeRecordData.length,
    };
}

/**
 * @param {Uint8Array} bytes
 * @returns {number}
 */
function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Create a valid one-pixel RGBA image.
 * @param {[number, number, number, number]} rgba
 * @returns {Uint8Array}
 */
export function makeFixturePng(rgba) {
    /**
     * @param {string} type
     * @param {Buffer} data
     * @returns {Buffer}
     */
    const chunk = (type, data) => {
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        return Buffer.concat([integer(data.length, 4), body, integer(crc32(body), 4)]);
    };
    const ihdr = Buffer.concat([integer(1, 4), integer(1, 4), Buffer.from([8, 6, 0, 0, 0])]);
    return new Uint8Array(Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(Buffer.from([0, ...rgba]))),
        chunk('IEND', Buffer.alloc(0)),
    ]));
}
