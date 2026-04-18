/*
 * Copyright (C) 2026 Manabitan authors
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

const RAW_TERM_CONTENT_MAGIC = new Uint8Array([0x4d, 0x42, 0x52, 0x31]);
const RAW_TERM_CONTENT_HEADER_BYTES = 20;
const RAW_TERM_CONTENT_SHARED_GLOSSARY_MAGIC = new Uint8Array([0x4d, 0x42, 0x52, 0x32]);
const RAW_TERM_CONTENT_SHARED_GLOSSARY_HEADER_BYTES = 28;

export const RAW_TERM_CONTENT_DICT_NAME = 'raw-v2';

export const RAW_TERM_CONTENT_SHARED_GLOSSARY_DICT_NAME = 'raw-v3';

export const RAW_TERM_CONTENT_COMPRESSED_SHARED_GLOSSARY_DICT_NAME = 'raw-v4';

/**
 * @param {number} h1
 * @param {number} h2
 * @param {Uint8Array} bytes
 * @returns {[number, number]}
 */
function hashRawTermContentBytesPairAppend(h1, h2, bytes) {
    for (let i = 0, ii = bytes.length; i < ii; ++i) {
        const code = bytes[i];
        h1 = Math.imul((h1 ^ code) >>> 0, 0x01000193);
        h2 = Math.imul((h2 ^ code) >>> 0, 0x85ebca6b);
        h2 = (h2 ^ (h2 >>> 13)) >>> 0;
    }
    return [h1 >>> 0, h2 >>> 0];
}

/**
 * @param {number} h1
 * @param {number} h2
 * @param {number} code
 * @returns {[number, number]}
 */
function hashRawTermContentByteAppend(h1, h2, code) {
    h1 = Math.imul((h1 ^ code) >>> 0, 0x01000193);
    h2 = Math.imul((h2 ^ code) >>> 0, 0x85ebca6b);
    h2 = (h2 ^ (h2 >>> 13)) >>> 0;
    return [h1 >>> 0, h2 >>> 0];
}

/**
 * @param {Uint8Array} target
 * @param {number} offset
 * @param {number} value
 * @returns {void}
 */
function writeUint32LE(target, offset, value) {
    target[offset] = value & 0xff;
    target[offset + 1] = (value >>> 8) & 0xff;
    target[offset + 2] = (value >>> 16) & 0xff;
    target[offset + 3] = (value >>> 24) & 0xff;
}

/**
 * @param {number} h1
 * @param {number} h2
 * @param {Uint8Array} target
 * @param {number} offset
 * @param {number} value
 * @returns {[number, number]}
 */
function writeUint32LEWithHash(h1, h2, target, offset, value) {
    const b0 = value & 0xff;
    const b1 = (value >>> 8) & 0xff;
    const b2 = (value >>> 16) & 0xff;
    const b3 = (value >>> 24) & 0xff;
    target[offset] = b0;
    target[offset + 1] = b1;
    target[offset + 2] = b2;
    target[offset + 3] = b3;
    [h1, h2] = hashRawTermContentByteAppend(h1, h2, b0);
    [h1, h2] = hashRawTermContentByteAppend(h1, h2, b1);
    [h1, h2] = hashRawTermContentByteAppend(h1, h2, b2);
    [h1, h2] = hashRawTermContentByteAppend(h1, h2, b3);
    return [h1, h2];
}

/**
 * @param {number} h1
 * @param {number} h2
 * @param {Uint8Array} target
 * @param {number} offset
 * @param {Uint8Array} source
 * @returns {[number, number]}
 */
function copyBytesWithHash(h1, h2, target, offset, source) {
    for (let i = 0, ii = source.byteLength; i < ii; ++i) {
        const code = source[i];
        target[offset + i] = code;
        [h1, h2] = hashRawTermContentByteAppend(h1, h2, code);
    }
    return [h1, h2];
}

/**
 * @param {Uint8Array} target
 * @param {number} offset
 * @param {Uint8Array} rulesBytes
 * @param {Uint8Array} definitionTagsBytes
 * @param {Uint8Array} termTagsBytes
 * @param {Uint8Array} glossaryJsonBytes
 * @returns {number}
 */
export function writeRawTermContentBinaryBytesInto(target, offset, rulesBytes, definitionTagsBytes, termTagsBytes, glossaryJsonBytes) {
    target.set(RAW_TERM_CONTENT_MAGIC, offset);
    writeUint32LE(target, offset + 4, rulesBytes.byteLength);
    writeUint32LE(target, offset + 8, definitionTagsBytes.byteLength);
    writeUint32LE(target, offset + 12, termTagsBytes.byteLength);
    writeUint32LE(target, offset + 16, glossaryJsonBytes.byteLength);
    let cursor = offset + RAW_TERM_CONTENT_HEADER_BYTES;
    target.set(rulesBytes, cursor);
    cursor += rulesBytes.byteLength;
    target.set(definitionTagsBytes, cursor);
    cursor += definitionTagsBytes.byteLength;
    target.set(termTagsBytes, cursor);
    cursor += termTagsBytes.byteLength;
    target.set(glossaryJsonBytes, cursor);
    cursor += glossaryJsonBytes.byteLength;
    return cursor - offset;
}

/**
 * @param {Uint8Array} target
 * @param {number} offset
 * @param {Uint8Array} rulesBytes
 * @param {Uint8Array} definitionTagsBytes
 * @param {Uint8Array} termTagsBytes
 * @param {Uint8Array} glossaryJsonBytes
 * @returns {{bytesWritten: number, hash1: number, hash2: number}}
 */
export function writeRawTermContentBinaryBytesWithHashInto(target, offset, rulesBytes, definitionTagsBytes, termTagsBytes, glossaryJsonBytes) {
    let h1 = 0x811c9dc5;
    let h2 = 0x9e3779b9;
    let cursor = offset;
    [h1, h2] = copyBytesWithHash(h1, h2, target, cursor, RAW_TERM_CONTENT_MAGIC);
    cursor += RAW_TERM_CONTENT_MAGIC.byteLength;
    [h1, h2] = writeUint32LEWithHash(h1, h2, target, cursor, rulesBytes.byteLength);
    cursor += 4;
    [h1, h2] = writeUint32LEWithHash(h1, h2, target, cursor, definitionTagsBytes.byteLength);
    cursor += 4;
    [h1, h2] = writeUint32LEWithHash(h1, h2, target, cursor, termTagsBytes.byteLength);
    cursor += 4;
    [h1, h2] = writeUint32LEWithHash(h1, h2, target, cursor, glossaryJsonBytes.byteLength);
    cursor += 4;
    [h1, h2] = copyBytesWithHash(h1, h2, target, cursor, rulesBytes);
    cursor += rulesBytes.byteLength;
    [h1, h2] = copyBytesWithHash(h1, h2, target, cursor, definitionTagsBytes);
    cursor += definitionTagsBytes.byteLength;
    [h1, h2] = copyBytesWithHash(h1, h2, target, cursor, termTagsBytes);
    cursor += termTagsBytes.byteLength;
    [h1, h2] = copyBytesWithHash(h1, h2, target, cursor, glossaryJsonBytes);
    cursor += glossaryJsonBytes.byteLength;
    if ((h1 | h2) === 0) {
        h1 = 1;
    }
    return {bytesWritten: cursor - offset, hash1: h1 >>> 0, hash2: h2 >>> 0};
}

/**
 * @param {Uint8Array} rulesBytes
 * @param {Uint8Array} definitionTagsBytes
 * @param {Uint8Array} termTagsBytes
 * @param {Uint8Array} glossaryJsonBytes
 * @returns {{hash1: number, hash2: number}}
 */
export function hashRawTermContentBinaryBytes(rulesBytes, definitionTagsBytes, termTagsBytes, glossaryJsonBytes) {
    let h1 = 0x811c9dc5;
    let h2 = 0x9e3779b9;
    [h1, h2] = hashRawTermContentBytesPairAppend(h1, h2, RAW_TERM_CONTENT_MAGIC);
    [h1, h2] = hashRawTermContentByteAppend(h1, h2, rulesBytes.byteLength & 0xff);
    [h1, h2] = hashRawTermContentByteAppend(h1, h2, (rulesBytes.byteLength >>> 8) & 0xff);
    [h1, h2] = hashRawTermContentByteAppend(h1, h2, (rulesBytes.byteLength >>> 16) & 0xff);
    [h1, h2] = hashRawTermContentByteAppend(h1, h2, (rulesBytes.byteLength >>> 24) & 0xff);
    [h1, h2] = hashRawTermContentByteAppend(h1, h2, definitionTagsBytes.byteLength & 0xff);
    [h1, h2] = hashRawTermContentByteAppend(h1, h2, (definitionTagsBytes.byteLength >>> 8) & 0xff);
    [h1, h2] = hashRawTermContentByteAppend(h1, h2, (definitionTagsBytes.byteLength >>> 16) & 0xff);
    [h1, h2] = hashRawTermContentByteAppend(h1, h2, (definitionTagsBytes.byteLength >>> 24) & 0xff);
    [h1, h2] = hashRawTermContentByteAppend(h1, h2, termTagsBytes.byteLength & 0xff);
    [h1, h2] = hashRawTermContentByteAppend(h1, h2, (termTagsBytes.byteLength >>> 8) & 0xff);
    [h1, h2] = hashRawTermContentByteAppend(h1, h2, (termTagsBytes.byteLength >>> 16) & 0xff);
    [h1, h2] = hashRawTermContentByteAppend(h1, h2, (termTagsBytes.byteLength >>> 24) & 0xff);
    [h1, h2] = hashRawTermContentByteAppend(h1, h2, glossaryJsonBytes.byteLength & 0xff);
    [h1, h2] = hashRawTermContentByteAppend(h1, h2, (glossaryJsonBytes.byteLength >>> 8) & 0xff);
    [h1, h2] = hashRawTermContentByteAppend(h1, h2, (glossaryJsonBytes.byteLength >>> 16) & 0xff);
    [h1, h2] = hashRawTermContentByteAppend(h1, h2, (glossaryJsonBytes.byteLength >>> 24) & 0xff);
    [h1, h2] = hashRawTermContentBytesPairAppend(h1, h2, rulesBytes);
    [h1, h2] = hashRawTermContentBytesPairAppend(h1, h2, definitionTagsBytes);
    [h1, h2] = hashRawTermContentBytesPairAppend(h1, h2, termTagsBytes);
    [h1, h2] = hashRawTermContentBytesPairAppend(h1, h2, glossaryJsonBytes);
    if ((h1 | h2) === 0) {
        h1 = 1;
    }
    return {hash1: h1 >>> 0, hash2: h2 >>> 0};
}

/**
 * @param {Uint8Array} bytes
 * @param {TextDecoder} textDecoder
 * @returns {{rules: string, definitionTags: string, termTags: string, glossaryJsonOffset: number, glossaryJsonLength: number}|null}
 */
export function decodeRawTermContentHeader(bytes, textDecoder) {
    if (!isRawTermContentBinary(bytes)) {
        return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const rulesLength = view.getUint32(4, true);
    const definitionTagsLength = view.getUint32(8, true);
    const termTagsLength = view.getUint32(12, true);
    const glossaryJsonLength = view.getUint32(16, true);
    const totalLength = RAW_TERM_CONTENT_HEADER_BYTES + rulesLength + definitionTagsLength + termTagsLength + glossaryJsonLength;
    if (totalLength !== bytes.byteLength) {
        return null;
    }
    let offset = RAW_TERM_CONTENT_HEADER_BYTES;
    const rules = textDecoder.decode(bytes.subarray(offset, offset + rulesLength));
    offset += rulesLength;
    const definitionTags = textDecoder.decode(bytes.subarray(offset, offset + definitionTagsLength));
    offset += definitionTagsLength;
    const termTags = textDecoder.decode(bytes.subarray(offset, offset + termTagsLength));
    offset += termTagsLength;
    return {rules, definitionTags, termTags, glossaryJsonOffset: offset, glossaryJsonLength};
}

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @param {number} length
 * @returns {Uint8Array}
 */
export function getRawTermContentGlossaryJsonBytes(bytes, offset, length) {
    return bytes.subarray(offset, offset + length);
}

/**
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
export function isRawTermContentBinary(bytes) {
    return (
        bytes.byteLength >= RAW_TERM_CONTENT_HEADER_BYTES &&
        bytes[0] === RAW_TERM_CONTENT_MAGIC[0] &&
        bytes[1] === RAW_TERM_CONTENT_MAGIC[1] &&
        bytes[2] === RAW_TERM_CONTENT_MAGIC[2] &&
        bytes[3] === RAW_TERM_CONTENT_MAGIC[3]
    );
}

/**
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
export function isRawTermContentSharedGlossaryBinary(bytes) {
    return (
        bytes.byteLength >= RAW_TERM_CONTENT_SHARED_GLOSSARY_HEADER_BYTES &&
        bytes[0] === RAW_TERM_CONTENT_SHARED_GLOSSARY_MAGIC[0] &&
        bytes[1] === RAW_TERM_CONTENT_SHARED_GLOSSARY_MAGIC[1] &&
        bytes[2] === RAW_TERM_CONTENT_SHARED_GLOSSARY_MAGIC[2] &&
        bytes[3] === RAW_TERM_CONTENT_SHARED_GLOSSARY_MAGIC[3]
    );
}

/**
 * @param {Uint8Array} rulesBytes
 * @param {Uint8Array} definitionTagsBytes
 * @param {Uint8Array} termTagsBytes
 * @param {Uint8Array} glossaryJsonBytes
 * @returns {Uint8Array}
 */
export function encodeRawTermContentBinaryBytes(rulesBytes, definitionTagsBytes, termTagsBytes, glossaryJsonBytes) {
    const totalBytes = (
        RAW_TERM_CONTENT_HEADER_BYTES +
        rulesBytes.byteLength +
        definitionTagsBytes.byteLength +
        termTagsBytes.byteLength +
        glossaryJsonBytes.byteLength
    );
    const bytes = new Uint8Array(totalBytes);
    writeRawTermContentBinaryBytesInto(bytes, 0, rulesBytes, definitionTagsBytes, termTagsBytes, glossaryJsonBytes);
    return bytes;
}

/**
 * @param {Uint8Array} rulesBytes
 * @param {Uint8Array} definitionTagsBytes
 * @param {Uint8Array} termTagsBytes
 * @param {Uint8Array} glossaryJsonBytes
 * @returns {{bytes: Uint8Array, hash1: number, hash2: number}}
 */
export function encodeRawTermContentBinaryBytesWithHash(rulesBytes, definitionTagsBytes, termTagsBytes, glossaryJsonBytes) {
    const totalBytes = (
        RAW_TERM_CONTENT_HEADER_BYTES +
        rulesBytes.byteLength +
        definitionTagsBytes.byteLength +
        termTagsBytes.byteLength +
        glossaryJsonBytes.byteLength
    );
    const bytes = new Uint8Array(totalBytes);
    const {hash1, hash2} = writeRawTermContentBinaryBytesWithHashInto(
        bytes,
        0,
        rulesBytes,
        definitionTagsBytes,
        termTagsBytes,
        glossaryJsonBytes,
    );
    return {bytes, hash1, hash2};
}

/**
 * @param {string} rules
 * @param {string} definitionTags
 * @param {string} termTags
 * @param {Uint8Array} glossaryJsonBytes
 * @param {TextEncoder} textEncoder
 * @returns {Uint8Array}
 */
export function encodeRawTermContentBinary(rules, definitionTags, termTags, glossaryJsonBytes, textEncoder) {
    return encodeRawTermContentBinaryBytes(
        textEncoder.encode(rules),
        textEncoder.encode(definitionTags),
        textEncoder.encode(termTags),
        glossaryJsonBytes,
    );
}

/**
 * @param {string} rules
 * @param {string} definitionTags
 * @param {string} termTags
 * @param {number} glossaryOffset
 * @param {number} glossaryLength
 * @param {TextEncoder} textEncoder
 * @returns {Uint8Array}
 */
export function encodeRawTermContentSharedGlossaryBinary(rules, definitionTags, termTags, glossaryOffset, glossaryLength, textEncoder) {
    const rulesBytes = textEncoder.encode(rules);
    const definitionTagsBytes = textEncoder.encode(definitionTags);
    const termTagsBytes = textEncoder.encode(termTags);
    const totalBytes = (
        RAW_TERM_CONTENT_SHARED_GLOSSARY_HEADER_BYTES +
        rulesBytes.byteLength +
        definitionTagsBytes.byteLength +
        termTagsBytes.byteLength
    );
    const bytes = new Uint8Array(totalBytes);
    bytes.set(RAW_TERM_CONTENT_SHARED_GLOSSARY_MAGIC, 0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(4, rulesBytes.byteLength, true);
    view.setUint32(8, definitionTagsBytes.byteLength, true);
    view.setUint32(12, termTagsBytes.byteLength, true);
    view.setBigUint64(16, BigInt(glossaryOffset), true);
    view.setUint32(24, glossaryLength, true);
    let offset = RAW_TERM_CONTENT_SHARED_GLOSSARY_HEADER_BYTES;
    bytes.set(rulesBytes, offset);
    offset += rulesBytes.byteLength;
    bytes.set(definitionTagsBytes, offset);
    offset += definitionTagsBytes.byteLength;
    bytes.set(termTagsBytes, offset);
    return bytes;
}

/**
 * @param {Uint8Array} bytes
 * @param {number} baseOffset
 * @returns {Uint8Array}
 */
export function rebaseRawTermContentSharedGlossaryBinary(bytes, baseOffset) {
    if (!isRawTermContentSharedGlossaryBinary(bytes) || baseOffset === 0) {
        return bytes;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const rulesLength = view.getUint32(4, true);
    const definitionTagsLength = view.getUint32(8, true);
    const termTagsLength = view.getUint32(12, true);
    const totalLength = RAW_TERM_CONTENT_SHARED_GLOSSARY_HEADER_BYTES + rulesLength + definitionTagsLength + termTagsLength;
    if (totalLength !== bytes.byteLength) {
        return bytes;
    }
    const rebasedBytes = Uint8Array.from(bytes);
    const rebasedView = new DataView(rebasedBytes.buffer, rebasedBytes.byteOffset, rebasedBytes.byteLength);
    const glossaryOffset = Number(rebasedView.getBigUint64(16, true));
    rebasedView.setBigUint64(16, BigInt(glossaryOffset + baseOffset), true);
    return rebasedBytes;
}

/**
 * @param {Uint8Array} bytes
 * @param {TextDecoder} textDecoder
 * @returns {{rules: string, definitionTags: string, termTags: string, glossaryOffset: number, glossaryLength: number}|null}
 */
export function decodeRawTermContentSharedGlossaryHeader(bytes, textDecoder) {
    if (!isRawTermContentSharedGlossaryBinary(bytes)) {
        return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const rulesLength = view.getUint32(4, true);
    const definitionTagsLength = view.getUint32(8, true);
    const termTagsLength = view.getUint32(12, true);
    const glossaryOffset = Number(view.getBigUint64(16, true));
    const glossaryLength = view.getUint32(24, true);
    const totalLength = RAW_TERM_CONTENT_SHARED_GLOSSARY_HEADER_BYTES + rulesLength + definitionTagsLength + termTagsLength;
    if (totalLength !== bytes.byteLength) {
        return null;
    }
    let offset = RAW_TERM_CONTENT_SHARED_GLOSSARY_HEADER_BYTES;
    const rules = textDecoder.decode(bytes.subarray(offset, offset + rulesLength));
    offset += rulesLength;
    const definitionTags = textDecoder.decode(bytes.subarray(offset, offset + definitionTagsLength));
    offset += definitionTagsLength;
    const termTags = textDecoder.decode(bytes.subarray(offset, offset + termTagsLength));
    return {rules, definitionTags, termTags, glossaryOffset, glossaryLength};
}

/**
 * @param {Uint8Array} bytes
 * @param {TextDecoder} textDecoder
 * @returns {{rules: string, definitionTags: string, termTags: string, glossaryJson: string}|null}
 */
export function decodeRawTermContentBinary(bytes, textDecoder) {
    const header = decodeRawTermContentHeader(bytes, textDecoder);
    if (header === null) {
        return null;
    }
    const glossaryJson = textDecoder.decode(getRawTermContentGlossaryJsonBytes(bytes, header.glossaryJsonOffset, header.glossaryJsonLength));
    return {rules: header.rules, definitionTags: header.definitionTags, termTags: header.termTags, glossaryJson};
}
