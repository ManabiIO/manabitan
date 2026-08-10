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

import {parseJson} from '../core/json.js';

const RAW_TERM_CONTENT_MAGIC = new Uint8Array([0x4d, 0x42, 0x52, 0x31]);
const RAW_TERM_CONTENT_HEADER_BYTES = 20;
const RAW_TERM_CONTENT_SHARED_GLOSSARY_MAGIC = new Uint8Array([0x4d, 0x42, 0x52, 0x32]);
const RAW_TERM_CONTENT_SHARED_GLOSSARY_HEADER_BYTES = 28;
const RAW_TERM_CONTENT_BLOCK_REFERENCE_MAGIC = new Uint8Array([0x4d, 0x42, 0x52, 0x35]);
const RAW_TERM_CONTENT_BLOCK_REFERENCE_MAGIC_U32 = 0x3552424d;
const RAW_TERM_CONTENT_TOKEN_MAGIC = new Uint8Array([0x4d, 0x42, 0x52, 0x36]);
const RAW_TERM_CONTENT_TOKEN_HEADER_BYTES = 4;
const U32_RANGE = 0x100000000;

export const RAW_TERM_CONTENT_BLOCK_REFERENCE_BYTES = 28;

export const RAW_TERM_CONTENT_DICT_NAME = 'raw-v2';

export const RAW_TERM_CONTENT_SHARED_GLOSSARY_DICT_NAME = 'raw-v3';

export const RAW_TERM_CONTENT_COMPRESSED_SHARED_GLOSSARY_DICT_NAME = 'raw-v4';

export const RAW_TERM_CONTENT_TOKEN_DICT_NAME = 'raw-v6';

export const RAW_TERM_CONTENT_BLOCK_DICT_NAME_PREFIX = 'raw-block-v1';

/**
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
export function isRawTermContentTokenBinary(bytes) {
    return (
        bytes.byteLength >= RAW_TERM_CONTENT_TOKEN_HEADER_BYTES &&
        bytes[0] === RAW_TERM_CONTENT_TOKEN_MAGIC[0] &&
        bytes[1] === RAW_TERM_CONTENT_TOKEN_MAGIC[1] &&
        bytes[2] === RAW_TERM_CONTENT_TOKEN_MAGIC[2] &&
        bytes[3] === RAW_TERM_CONTENT_TOKEN_MAGIC[3]
    );
}

/**
 * @param {string|null} compressionDictName
 * @returns {string}
 */
export function createRawTermContentBlockDictName(compressionDictName) {
    return compressionDictName === null ? RAW_TERM_CONTENT_BLOCK_DICT_NAME_PREFIX : `${RAW_TERM_CONTENT_BLOCK_DICT_NAME_PREFIX}:${compressionDictName}`;
}

/**
 * @param {string} contentDictName
 * @returns {string|null|undefined} Undefined when the name is not a block format.
 */
export function getRawTermContentBlockCompressionDictName(contentDictName) {
    if (contentDictName === RAW_TERM_CONTENT_BLOCK_DICT_NAME_PREFIX) { return null; }
    const prefix = `${RAW_TERM_CONTENT_BLOCK_DICT_NAME_PREFIX}:`;
    return contentDictName.startsWith(prefix) ? contentDictName.substring(prefix.length) : void 0;
}

/**
 * @param {number} blockOffset
 * @param {number} blockCompressedLength
 * @param {number} blockUncompressedLength
 * @param {number} entryOffset
 * @param {number} entryLength
 * @returns {Uint8Array}
 */
export function encodeRawTermContentBlockReference(blockOffset, blockCompressedLength, blockUncompressedLength, entryOffset, entryLength) {
    const bytes = new Uint8Array(RAW_TERM_CONTENT_BLOCK_REFERENCE_BYTES);
    writeRawTermContentBlockReference(
        new DataView(bytes.buffer),
        0,
        blockOffset,
        blockCompressedLength,
        blockUncompressedLength,
        entryOffset,
        entryLength,
    );
    return bytes;
}

/**
 * Writes a reference into an existing slab without allocating a per-reference view.
 * @param {DataView} view
 * @param {number} offset
 * @param {number} blockOffset
 * @param {number} blockCompressedLength
 * @param {number} blockUncompressedLength
 * @param {number} entryOffset
 * @param {number} entryLength
 */
export function writeRawTermContentBlockReference(
    view,
    offset,
    blockOffset,
    blockCompressedLength,
    blockUncompressedLength,
    entryOffset,
    entryLength,
) {
    view.setUint32(offset, RAW_TERM_CONTENT_BLOCK_REFERENCE_MAGIC_U32, true);
    view.setUint32(offset + 4, blockOffset, true);
    view.setUint32(offset + 8, Math.floor(blockOffset / U32_RANGE), true);
    view.setUint32(offset + 12, blockCompressedLength, true);
    view.setUint32(offset + 16, blockUncompressedLength, true);
    view.setUint32(offset + 20, entryOffset, true);
    view.setUint32(offset + 24, entryLength, true);
}

/**
 * @param {Uint8Array} bytes
 * @returns {{blockOffset: number, blockCompressedLength: number, blockUncompressedLength: number, entryOffset: number, entryLength: number}|null}
 */
export function decodeRawTermContentBlockReference(bytes) {
    if (
        bytes.byteLength !== RAW_TERM_CONTENT_BLOCK_REFERENCE_BYTES ||
        bytes[0] !== RAW_TERM_CONTENT_BLOCK_REFERENCE_MAGIC[0] ||
        bytes[1] !== RAW_TERM_CONTENT_BLOCK_REFERENCE_MAGIC[1] ||
        bytes[2] !== RAW_TERM_CONTENT_BLOCK_REFERENCE_MAGIC[2] ||
        bytes[3] !== RAW_TERM_CONTENT_BLOCK_REFERENCE_MAGIC[3]
    ) {
        return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const blockOffset = view.getUint32(4, true) + view.getUint32(8, true) * U32_RANGE;
    const blockCompressedLength = view.getUint32(12, true);
    const blockUncompressedLength = view.getUint32(16, true);
    const entryOffset = view.getUint32(20, true);
    const entryLength = view.getUint32(24, true);
    if (
        !Number.isSafeInteger(blockOffset) ||
        blockCompressedLength <= 0 ||
        blockUncompressedLength <= 0 ||
        entryLength <= 0 ||
        entryOffset + entryLength > blockUncompressedLength
    ) {
        return null;
    }
    return {blockOffset, blockCompressedLength, blockUncompressedLength, entryOffset, entryLength};
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
 * @param {string} rules
 * @param {string} definitionTags
 * @param {string} termTags
 * @param {Uint8Array} glossaryJsonBytes
 * @param {TextEncoder} textEncoder
 * @returns {Uint8Array}
 */
export function encodeRawTermContentBinary(rules, definitionTags, termTags, glossaryJsonBytes, textEncoder) {
    const rulesBytes = textEncoder.encode(rules);
    const definitionTagsBytes = textEncoder.encode(definitionTags);
    const termTagsBytes = textEncoder.encode(termTags);
    const totalBytes = (
        RAW_TERM_CONTENT_HEADER_BYTES +
        rulesBytes.byteLength +
        definitionTagsBytes.byteLength +
        termTagsBytes.byteLength +
        glossaryJsonBytes.byteLength
    );
    const bytes = new Uint8Array(totalBytes);
    bytes.set(RAW_TERM_CONTENT_MAGIC, 0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(4, rulesBytes.byteLength, true);
    view.setUint32(8, definitionTagsBytes.byteLength, true);
    view.setUint32(12, termTagsBytes.byteLength, true);
    view.setUint32(16, glossaryJsonBytes.byteLength, true);
    let offset = RAW_TERM_CONTENT_HEADER_BYTES;
    bytes.set(rulesBytes, offset);
    offset += rulesBytes.byteLength;
    bytes.set(definitionTagsBytes, offset);
    offset += definitionTagsBytes.byteLength;
    bytes.set(termTagsBytes, offset);
    offset += termTagsBytes.byteLength;
    bytes.set(glossaryJsonBytes, offset);
    return bytes;
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

/**
 * @param {Uint8Array} bytes
 * @param {TextDecoder} textDecoder
 * @returns {{rules: string, definitionTags: string, termTags: string, glossaryJsonOffset: number, glossaryJsonLength: number}|null}
 */
export function decodeRawTermContentTokenHeader(bytes, textDecoder) {
    if (!isRawTermContentTokenBinary(bytes)) {
        return null;
    }
    let offset = RAW_TERM_CONTENT_TOKEN_HEADER_BYTES;
    const decodeToken = () => {
        const end = bytes.indexOf(0, offset);
        if (end < 0) { return null; }
        const start = offset;
        offset = end + 1;
        if (end - start >= 2 && bytes[start] === 0x22 && bytes[end - 1] === 0x22) {
            if (end - start === 2) { return ''; }
            const escapeIndex = bytes.indexOf(0x5c, start + 1);
            if (escapeIndex < 0 || escapeIndex >= end - 1) {
                return textDecoder.decode(bytes.subarray(start + 1, end - 1));
            }
        }
        const token = textDecoder.decode(bytes.subarray(start, end));
        try {
            const value = /** @type {unknown} */ (parseJson(token));
            return typeof value === 'string' ? value : null;
        } catch {
            return null;
        }
    };
    const rules = decodeToken();
    const definitionTags = decodeToken();
    const termTags = decodeToken();
    if (rules === null || definitionTags === null || termTags === null) {
        return null;
    }
    const glossaryJsonOffset = offset;
    const glossaryJsonLength = bytes.byteLength - glossaryJsonOffset;
    if (glossaryJsonLength <= 0) { return null; }
    return {rules, definitionTags, termTags, glossaryJsonOffset, glossaryJsonLength};
}

/**
 * @param {Uint8Array} bytes
 * @param {TextDecoder} textDecoder
 * @returns {{rules: string, definitionTags: string, termTags: string, glossaryJson: string}|null}
 */
export function decodeRawTermContentTokenBinary(bytes, textDecoder) {
    const header = decodeRawTermContentTokenHeader(bytes, textDecoder);
    if (header === null) {
        return null;
    }
    const glossaryJson = textDecoder.decode(bytes.subarray(
        header.glossaryJsonOffset,
        header.glossaryJsonOffset + header.glossaryJsonLength,
    ));
    return {rules: header.rules, definitionTags: header.definitionTags, termTags: header.termTags, glossaryJson};
}
