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

import {decodeRawTermContentBlockReference, decodeRawTermContentCompactBlockReference, getRawTermContentBlockCompressionDictName, RAW_TERM_CONTENT_BLOCK_REFERENCE_BYTES, RAW_TERM_CONTENT_COMPACT_BLOCK_REFERENCE_BYTES, RAW_TERM_CONTENT_DIRECT_BLOCK_DICT_NAME_PREFIX} from './raw-term-content.js';
import {TERM_CONTENT_BLOCK_ENVELOPE_BYTES, TERM_CONTENT_BLOCK_ENVELOPE_MAGIC} from './term-content-block-envelope.js';
import {getLegacyTermContentZstdCodecId} from './term-content-zstd-codec.js';
import {advanceZstdFrameInspection, beginZstdFrameInspection, validateZstdFrameInspectionCursor, ZstdFrameInspectionError} from './term-content-zstd-frame-inspector.js';

/** @typedef {import('./term-content-optimization-controller.js').DiscoveryItem} DiscoveryItem */
/** @typedef {import('./term-content-zstd-frame-inspector.js').ZstdFrameInspectionCursor} InspectionCursor */
/** @typedef {{logicalHighWater: number, readSlice: (offset: number, length: number) => Promise<Uint8Array>, assertCurrent: () => void}} LegacyEligibilitySource */
/** @typedef {{kind: 'eligible'|'skip'}|{kind: 'pending', cursor: InspectionCursor}} LegacyEligibilityResult */

const RAW_SELECTORS = new Set(['raw', 'raw-v2', 'raw-v3', 'raw-v4', 'raw-v6']);

/**
 * The validated legacy shard descriptor carries one codec selector. The
 * shared-glossary artifact is checked separately even when its records are raw.
 * @param {string} selector
 * @returns {boolean}
 */
export function skipLegacyEligibilitySelector(selector) {
    const blockCodec = getRawTermContentBlockCompressionDictName(selector);
    return RAW_SELECTORS.has(selector) || getLegacyTermContentZstdCodecId(blockCodec ?? selector) !== null;
}

/**
 * Validates the stored frame's format, extent and codec with small reads. It
 * yields after one bounded set of Zstd block headers. The normal root-backed
 * pass independently checks payloads before any frame replacement.
 * @param {LegacyEligibilitySource} source
 * @param {DiscoveryItem} item
 * @param {AbortSignal} signal
 * @param {InspectionCursor|null} [cursor]
 * @returns {Promise<LegacyEligibilityResult>}
 * @throws {Error} If reference or frame metadata is invalid, unavailable, or stale.
 */
export async function probeLegacyTermContentFrame(source, item, signal, cursor = null) {
    signal.throwIfAborted();
    source.assertCurrent();
    let frameOffset;
    let frameHighWater = source.logicalHighWater;
    /** @type {number|undefined} */
    let expectedDecodedLength;
    let exactExtent = false;

    if (item.kind === 'artifact') {
        const {contentOffset, contentLength, contentDictName, uncompressedLength} = item.artifact;
        if (contentDictName !== 'raw-v4') { return {kind: 'skip'}; }
        frameOffset = contentOffset;
        frameHighWater = contentOffset + contentLength;
        expectedDecodedLength = uncompressedLength;
        exactExtent = true;
    } else {
        const {entryContentOffset, entryContentLength, entryContentDictName} = item.reference;
        if (skipLegacyEligibilitySelector(entryContentDictName)) { return {kind: 'skip'}; }
        if (!Number.isSafeInteger(entryContentOffset) || entryContentOffset < 0 ||
        !Number.isSafeInteger(entryContentLength) || entryContentLength <= 0) {
            throw new ZstdFrameInspectionError('Invalid legacy term content reference');
        }
        frameOffset = entryContentOffset;
        if (typeof getRawTermContentBlockCompressionDictName(entryContentDictName) !== 'undefined') {
            const compact = entryContentDictName === RAW_TERM_CONTENT_DIRECT_BLOCK_DICT_NAME_PREFIX ||
                entryContentDictName.startsWith(RAW_TERM_CONTENT_DIRECT_BLOCK_DICT_NAME_PREFIX + ':');
            const reference = await source.readSlice(entryContentOffset, compact ?
                RAW_TERM_CONTENT_COMPACT_BLOCK_REFERENCE_BYTES :
                RAW_TERM_CONTENT_BLOCK_REFERENCE_BYTES);
            const block = compact ? decodeRawTermContentCompactBlockReference(reference, entryContentLength) :
                decodeRawTermContentBlockReference(reference);
            if (block === null || block.entryLength !== entryContentLength ||
            block.blockCompressedLength <= TERM_CONTENT_BLOCK_ENVELOPE_BYTES) {
                throw new ZstdFrameInspectionError('Invalid legacy term content block reference');
            }
            const envelope = await source.readSlice(block.blockOffset, TERM_CONTENT_BLOCK_ENVELOPE_BYTES);
            if (!TERM_CONTENT_BLOCK_ENVELOPE_MAGIC.every((value, index) => envelope[index] === value)) {
                throw new ZstdFrameInspectionError('Invalid legacy term content block envelope');
            }
            frameOffset = block.blockOffset + TERM_CONTENT_BLOCK_ENVELOPE_BYTES;
            frameHighWater = block.blockOffset + block.blockCompressedLength;
            expectedDecodedLength = block.blockUncompressedLength;
            exactExtent = true;
        }
    }

    if (!Number.isSafeInteger(frameOffset) || frameOffset < 0 || !Number.isSafeInteger(frameHighWater) ||
    frameHighWater <= frameOffset || frameHighWater > source.logicalHighWater ||
    (typeof expectedDecodedLength !== 'undefined' && (!Number.isSafeInteger(expectedDecodedLength) || expectedDecodedLength <= 0))) {
        throw new ZstdFrameInspectionError('Invalid legacy frame extent');
    }
    const options = {signal, assertCurrent: source.assertCurrent};
    const header = await beginZstdFrameInspection(source.readSlice, frameOffset, frameHighWater, {...options, expectedDecodedLength});
    if (header.dictionaryId !== 0 || header.decodedLength === 0) { return {kind: 'skip'}; }

    const resume = cursor === null ? header : validateZstdFrameInspectionCursor(cursor);
    if (resume.frameOffset !== header.frameOffset || resume.logicalHighWater > header.logicalHighWater ||
    (exactExtent && resume.logicalHighWater !== header.logicalHighWater) ||
    resume.dictionaryId !== header.dictionaryId || resume.decodedLength !== header.decodedLength ||
    resume.windowSize !== header.windowSize || resume.checksum !== header.checksum ||
    resume.nextOffset < header.nextOffset || resume.complete) {
        throw new ZstdFrameInspectionError('Legacy frame inspection no longer matches its source');
    }
    const result = await advanceZstdFrameInspection(source.readSlice, resume, options);
    if (result.sourceStoredLength === null) { return {kind: 'pending', cursor: result.cursor}; }
    if (exactExtent && result.cursor.nextOffset !== frameHighWater) {
        throw new ZstdFrameInspectionError('Legacy frame does not fill its referenced extent');
    }
    return {kind: 'eligible'};
}
