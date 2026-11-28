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

import {getLegacyTermContentZstdCodecId} from './term-content-zstd-codec.js';
import {decodeRawTermContentBlockReference, decodeRawTermContentCompactBlockReference, getRawTermContentBlockCompressionDictName, RAW_TERM_CONTENT_BLOCK_REFERENCE_BYTES, RAW_TERM_CONTENT_COMPACT_BLOCK_REFERENCE_BYTES, RAW_TERM_CONTENT_DIRECT_BLOCK_DICT_NAME_PREFIX} from './raw-term-content.js';
import {advanceZstdFrameInspection, beginZstdFrameInspection, validateZstdFrameInspectionCursor} from './term-content-zstd-frame-inspector.js';

/** @typedef {import('./term-content-layout.js').FrameIdentity} FrameIdentity */
/** @typedef {import('./term-content-optimization-checkpoint.js').OnlineContentFrameDescriptor} FrameDescriptor */
/** @typedef {import('./term-record-opfs-store.js').ContentReference} ContentReference */
/**
 * @typedef {object} CandidateFrameSource
 * @property {number} logicalHighWater
 * @property {(offset: number, length: number) => Promise<Uint8Array|null>} readSlice
 * @property {(identity: FrameIdentity) => Promise<FrameDescriptor>} describe
 * @property {(query: {kind: FrameIdentity['kind'], logicalOffset: number, recordLength: number, originalCodecId: string|null}) => Promise<FrameIdentity|null>} findOverride
 * @property {() => void} assertCurrent
 */
/** @typedef {{kind: 'frame', frame: FrameDescriptor}|{kind: 'skip', reason: 'raw'|'custom'|'empty'}|{kind: 'pending', cursor: import('./term-content-zstd-frame-inspector.js').ZstdFrameInspectionCursor}} CandidateReferenceResult */
const RAW_SELECTORS = new Set(['raw', 'raw-v2', 'raw-v3', 'raw-v4', 'raw-v6']);

/** @param {string} selector */
export function isRawTermContentTrainingSelector(selector) {
    return RAW_SELECTORS.has(selector);
}

/**
 * @param {CandidateFrameSource} source
 * @param {AbortSignal} signal
 * @throws {Error} If the lease, target generation or foreground admission changed.
 */
function check(source, signal) {
    if (signal.aborted) { throw new DOMException('Content discovery was preempted', 'AbortError'); }
    source.assertCurrent();
}

/**
 * Actual frame codec determines eligibility, including globally shared blocks.
 * This routine never loads presets, touches foreground caches or reads payload.
 * @param {CandidateFrameSource} source
 * @param {FrameIdentity} identity
 * @param {AbortSignal} signal
 * @param {number|null} [knownDecodedLength]
 * @returns {Promise<CandidateReferenceResult>}
 * @throws {Error} If generation or source frame metadata changed.
 */
async function eligible(source, identity, signal, knownDecodedLength = null) {
    const frame = await source.describe(identity);
    check(source, signal);
    if (frame.codecId !== null) { return {kind: 'skip', reason: 'custom'}; }
    if (knownDecodedLength !== null && frame.decodedLength !== null && frame.decodedLength !== knownDecodedLength) { throw new TypeError('Canonical frame length changed during discovery'); }
    const decodedLength = frame.decodedLength ?? knownDecodedLength;
    if (decodedLength === 0) { return {kind: 'skip', reason: 'empty'}; }
    return {kind: 'frame', frame: {...frame, decodedLength}};
}

/**
 * One bounded reference step. Legacy recordLength is kept separate from the
 * exact physical frame span. Caller persists pending references and inspection
 * cursors with its discovery CAS before advancing the metadata iterator.
 * @param {CandidateFrameSource} source
 * @param {ContentReference} reference
 * @param {AbortSignal} signal
 * @param {import('./term-content-zstd-frame-inspector.js').ZstdFrameInspectionCursor|null} [cursor]
 * @returns {Promise<CandidateReferenceResult>}
 * @throws {Error} If source metadata is inconsistent or temporarily unavailable.
 */
export async function inspectTermContentTrainingReference(source, reference, signal, cursor = null) {
    check(source, signal);
    const {entryContentOffset: offset, entryContentLength: length, entryContentDictName: selector} = reference;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0 || typeof selector !== 'string') {
        throw new TypeError('Invalid content training reference');
    }
    if (isRawTermContentTrainingSelector(selector)) {
        if (cursor !== null) { throw new TypeError('Unexpected legacy cursor on raw content'); }
        return {kind: 'skip', reason: 'raw'};
    }
    const blockCodec = getRawTermContentBlockCompressionDictName(selector);
    if (typeof blockCodec !== 'undefined') {
        if (cursor !== null) { throw new TypeError('Unexpected legacy frame cursor on a block reference'); }
        const compact = selector === RAW_TERM_CONTENT_DIRECT_BLOCK_DICT_NAME_PREFIX || selector.startsWith(RAW_TERM_CONTENT_DIRECT_BLOCK_DICT_NAME_PREFIX + ':');
        const bytes = await source.readSlice(offset, compact ? RAW_TERM_CONTENT_COMPACT_BLOCK_REFERENCE_BYTES : RAW_TERM_CONTENT_BLOCK_REFERENCE_BYTES);
        check(source, signal);
        if (!(bytes instanceof Uint8Array)) { throw new Error('Content training reference is temporarily unavailable'); }
        const block = compact ? decodeRawTermContentCompactBlockReference(bytes, length) : decodeRawTermContentBlockReference(bytes);
        if (block === null || block.entryLength !== length) { throw new TypeError('Content training block reference is inconsistent'); }
        return await eligible(source, {kind: 'block',
            logicalOffset: block.blockOffset,
            recordLength: block.blockCompressedLength,
            sourceStoredLength: block.blockCompressedLength,
            originalCodecId: getLegacyTermContentZstdCodecId(blockCodec),
            expectedDecodedLength: block.blockUncompressedLength,
            originalEnvelope: 'mbc2'}, signal);
    }
    const originalCodecId = getLegacyTermContentZstdCodecId(selector);
    const override = await source.findOverride({kind: 'legacy-entry', logicalOffset: offset, recordLength: length, originalCodecId});
    check(source, signal);
    if (override !== null) { return await eligible(source, override, signal); }
    if (originalCodecId !== null) { return {kind: 'skip', reason: 'custom'}; }
    /**
     * @param {number} position
     * @param {number} count
     * @returns {Promise<Uint8Array>}
     */
    const read = async (position, count) => {
        const bytes = await source.readSlice(position, count);
        check(source, signal);
        if (!(bytes instanceof Uint8Array)) { throw new Error('Legacy frame metadata is temporarily unavailable'); }
        return bytes;
    };
    let state = cursor === null ? null : validateZstdFrameInspectionCursor(cursor);
    if (state === null) {
        state = await beginZstdFrameInspection(read, offset, source.logicalHighWater, {signal, assertCurrent: () => source.assertCurrent()});
    } else if (state.frameOffset !== offset || state.logicalHighWater > source.logicalHighWater) {
        throw new TypeError('Legacy frame inspection belongs to a different immutable source');
    }
    const result = await advanceZstdFrameInspection(read, state, {signal, assertCurrent: () => source.assertCurrent()});
    check(source, signal);
    if (result.sourceStoredLength === null) { return {kind: 'pending', cursor: result.cursor}; }
    return await eligible(source, {kind: 'legacy-entry',
        logicalOffset: offset,
        recordLength: length,
        sourceStoredLength: result.sourceStoredLength,
        originalCodecId,
        expectedDecodedLength: null,
        originalEnvelope: 'none'}, signal, result.cursor.decodedLength);
}

/**
 * raw-v4 glossary metadata stores the actual physical compressed length. Raw
 * per-entry headers remain untouched while their shared artifact is optimized.
 * @param {CandidateFrameSource} source
 * @param {{contentOffset: number, contentLength: number, contentDictName: string, uncompressedLength: number}} artifact
 * @param {AbortSignal} signal
 * @returns {Promise<CandidateReferenceResult>}
 * @throws {Error} If generation or source frame metadata changed.
 */
export async function inspectSharedGlossaryTrainingArtifact(source, artifact, signal) {
    check(source, signal);
    if (artifact.contentDictName !== 'raw-v4') { return {kind: 'skip', reason: 'raw'}; }
    if (!Number.isSafeInteger(artifact.contentOffset) || artifact.contentOffset < 0 ||
    !Number.isSafeInteger(artifact.contentLength) || artifact.contentLength <= 0 ||
    !Number.isSafeInteger(artifact.uncompressedLength) || artifact.uncompressedLength <= 0) {
        throw new TypeError('Invalid shared glossary training artifact');
    }
    return await eligible(source, {kind: 'shared-glossary',
        logicalOffset: artifact.contentOffset,
        recordLength: artifact.contentLength,
        sourceStoredLength: artifact.contentLength,
        originalCodecId: null,
        expectedDecodedLength: artifact.uncompressedLength,
        originalEnvelope: 'none'}, signal);
}
