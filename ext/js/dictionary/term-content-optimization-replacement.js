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

import {promiseTimeout} from '../core/utilities.js';
import {TERM_CONTENT_BLOCK_ENVELOPE_BYTES, TERM_CONTENT_BLOCK_ENVELOPE_MAGIC} from './term-content-block-envelope.js';
import {TermContentFrameCodecError, TermContentFrameCodecWorkerOwner} from './term-content-frame-codec-worker-owner.js';
import {parseOnlineContentFrameDescriptor} from './term-content-optimization-checkpoint.js';
import {TermContentOptimizationIntegrityError, TermContentOptimizationUnsupportedFrameError} from './term-content-optimization-controller.js';

/** @typedef {import('./term-content-optimization-controller.js').OptimizationJob} Job */
/** @typedef {import('./term-content-optimization-checkpoint.js').OnlineContentFrameDescriptor} SourceFrame */
/** @typedef {import('./term-content-layout.js').Frame} ReplacementFrame */
/** @typedef {Pick<TermContentFrameCodecWorkerOwner, 'run'|'close'>} CodecOwner */
/** @typedef {import('./term-content-frame-codec-worker-owner.js').TermContentFrameCodecRequest} CodecRequest */
/** @typedef {Pick<import('./term-content-optimization-frame-reader.js').TermContentOptimizationFrameReader, 'readFrame'>} SourceReader */
/** @typedef {{fileId: string, physicalOffset: number}} Destination */

const MAX_CODEC_BYTES = 16 * 1024 * 1024;
const MAX_READ_CHUNK_BYTES = 4 * 1024 * 1024;
const COMPARE_CHUNK_BYTES = 1024 * 1024;
const MAX_DICTIONARY_BYTES = 112640;
const FILE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const SHA_256_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Performs the private codec work for one bounded frame. The host owns OPFS
 * writes, leases spanning layout staging, and publication. Verification always
 * reopens the closed bytes and uses fresh decoder contexts.
 */
export class TermContentOptimizationReplacement {
    /**
     * @param {{reader: SourceReader, createCodec?: () => CodecOwner}} options
     */
    constructor({reader, createCodec = () => new TermContentFrameCodecWorkerOwner()}) {
        /**
         *
         */
        this._reader = reader;
        /**
         *
         */
        this._createCodec = createCodec;
    }

    /**
     * @param {Job} job
     * @param {SourceFrame} source
     * @param {Uint8Array} dictionary
     * @param {Destination} destination
     * @param {AbortSignal} signal
     * @returns {Promise<{frame: ReplacementFrame, bytes: Uint8Array}>}
     * @throws {Error} If the frame or codec is unavailable, unsupported or invalid.
     */
    async recompress(job, source, dictionary, destination, signal) {
        signal.throwIfAborted();
        const original = admitSource(source);
        const {fileId, physicalOffset} = destination;
        assertDestination(fileId, physicalOffset, 0);
        const codec = await prepareDictionary(dictionary);
        signal.throwIfAborted();
        const canonical = await this._reader.readFrame(job, original, signal);
        signal.throwIfAborted();
        assertCanonicalLength(canonical, original.decodedLength);
        const decodedDigest = await digest(canonical);
        signal.throwIfAborted();
        if (original.decodedDigest !== null && original.decodedDigest !== decodedDigest) {
            throw new TermContentOptimizationIntegrityError('Original content digest disagrees with its checkpoint');
        }
        const bytes = await this._runCodec({id: 0,
            action: 'compress',
            bytes: canonical,
            codecId: codec.codecId,
            dictionary: codec.dictionary,
            level: job.checkpoint.parameters.level,
            wrap: true}, signal);
        if (bytes.byteLength > MAX_CODEC_BYTES) {
            throw new TermContentOptimizationUnsupportedFrameError('Replacement frame requires the streaming codec adapter');
        }
        assertEnvelope(bytes);
        assertDestination(fileId, physicalOffset, bytes.byteLength);
        return {
            frame: {
                ...original.identity,
                fileId,
                physicalOffset,
                storedLength: bytes.byteLength,
                codecId: codec.codecId,
                envelope: 'mbc2',
                decodedLength: original.decodedLength,
                decodedDigest,
            },
            bytes,
        };
    }

    /**
     * Independently decodes the current original and closed staged span. The
     * reader must yield exactly the bytes at this replacement's physical span.
     * @param {Job} job
     * @param {SourceFrame} source
     * @param {ReplacementFrame} replacement
     * @param {Uint8Array} dictionary
     * @param {(frame: Readonly<ReplacementFrame>, signal: AbortSignal) => AsyncIterable<Uint8Array>} readClosedChunks
     * @param {AbortSignal} signal
     * @returns {Promise<void>}
     * @throws {Error} If the original or the independently read staged result is invalid.
     */
    async verify(job, source, replacement, dictionary, readClosedChunks, signal) {
        signal.throwIfAborted();
        const original = admitSource(source);
        const frame = Object.freeze({...replacement});
        assertDestination(frame.fileId, frame.physicalOffset, frame.storedLength);
        if (frame.storedLength > MAX_CODEC_BYTES) {
            throw new TermContentOptimizationUnsupportedFrameError('Staged frame requires the streaming codec adapter');
        }
        if (frame.storedLength <= TERM_CONTENT_BLOCK_ENVELOPE_BYTES || frame.envelope !== 'mbc2' ||
        frame.decodedLength !== original.decodedLength || typeof frame.decodedDigest !== 'string' || !SHA_256_PATTERN.test(frame.decodedDigest) ||
        (original.decodedDigest !== null && original.decodedDigest !== frame.decodedDigest) ||
        !sameIdentity(original.identity, frame)) {
            throw new TermContentOptimizationIntegrityError('Staged replacement metadata disagrees with the original frame');
        }

        const codec = await prepareDictionary(dictionary);
        signal.throwIfAborted();
        if (codec.codecId !== frame.codecId) {
            throw new TermContentOptimizationIntegrityError('Staged replacement dictionary disagrees with its codec identity');
        }
        const staged = new Uint8Array(frame.storedLength);
        let cursor = 0;
        for await (const chunk of readClosedChunks(frame, signal)) {
            signal.throwIfAborted();
            if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0 || chunk.byteLength > MAX_READ_CHUNK_BYTES ||
            chunk.byteLength > staged.byteLength - cursor) {
                throw new TermContentOptimizationIntegrityError('Staged replacement read exceeds its immutable span');
            }
            staged.set(chunk, cursor);
            cursor += chunk.byteLength;
        }
        signal.throwIfAborted();
        if (cursor !== staged.byteLength) {
            throw new TermContentOptimizationIntegrityError('Staged replacement read ended before its immutable span');
        }
        assertEnvelope(staged);

        // The source reader already creates an independent codec context and
        // joins the source file lease before returning these owned bytes.
        const canonical = await this._reader.readFrame(job, original, signal);
        signal.throwIfAborted();
        assertCanonicalLength(canonical, original.decodedLength);
        const observed = await this._runCodec({id: 0,
            action: 'decode',
            bytes: staged,
            codecId: codec.codecId,
            dictionary: codec.dictionary,
            envelope: 'mbc2',
            expectedDecodedLength: frame.decodedLength,
            maxOutputSize: frame.decodedLength}, signal);
        assertCanonicalLength(observed, frame.decodedLength);
        if (await digest(observed) !== frame.decodedDigest) {
            signal.throwIfAborted();
            throw new TermContentOptimizationIntegrityError('Staged replacement canonical digest disagrees with its manifest');
        }
        await verifyCanonicalBytes(canonical, observed, signal);
    }

    /**
     * @param {CodecRequest} request
     * @param {AbortSignal} signal
     * @returns {Promise<Uint8Array>}
     * @throws {Error} If the codec failed or foreground work arrived.
     */
    async _runCodec(request, signal) {
        signal.throwIfAborted();
        const codec = this._createCodec();
        try {
            const bytes = await codec.run(request, {signal});
            signal.throwIfAborted();
            if (!(bytes instanceof Uint8Array)) {
                throw new TermContentOptimizationIntegrityError('Replacement codec returned invalid bytes');
            }
            return bytes;
        } catch (error) {
            signal.throwIfAborted();
            if (error instanceof TermContentFrameCodecError && error.kind !== 'unavailable') {
                throw new TermContentOptimizationIntegrityError(error.message);
            }
            throw error;
        } finally {
            codec.close();
        }
    }
}

/**
 * @param {SourceFrame} source
 * @returns {SourceFrame & {decodedLength: number}}
 * @throws {Error} If the frame is invalid or outside the whole-frame bounds.
 */
function admitSource(source) {
    const frame = parseOnlineContentFrameDescriptor(source);
    if (frame.codecId !== null) {
        throw new TermContentOptimizationIntegrityError('Replacement source no longer uses vanilla Zstd');
    }
    if (frame.decodedLength === null || frame.decodedLength > MAX_CODEC_BYTES || frame.storedLength > MAX_CODEC_BYTES) {
        throw new TermContentOptimizationUnsupportedFrameError('Original frame requires the streaming codec adapter');
    }
    return {...frame, decodedLength: frame.decodedLength};
}

/**
 * @param {string} fileId
 * @param {number} physicalOffset
 * @param {number} storedLength
 * @throws {Error} If the destination is outside the supported physical address space.
 */
function assertDestination(fileId, physicalOffset, storedLength) {
    if (typeof fileId !== 'string' || !FILE_ID_PATTERN.test(fileId) || !Number.isSafeInteger(physicalOffset) || physicalOffset < 0 ||
    !Number.isSafeInteger(storedLength) || storedLength < 0 || physicalOffset > Number.MAX_SAFE_INTEGER - storedLength) {
        throw new TermContentOptimizationIntegrityError('Invalid replacement frame physical destination');
    }
}

/**
 * @param {import('./term-content-layout.js').FrameIdentity} original
 * @param {ReplacementFrame} frame
 * @returns {boolean}
 */
function sameIdentity(original, frame) {
    return original.kind === frame.kind && original.logicalOffset === frame.logicalOffset &&
    original.recordLength === frame.recordLength && original.sourceStoredLength === frame.sourceStoredLength &&
    original.originalCodecId === frame.originalCodecId && original.expectedDecodedLength === frame.expectedDecodedLength &&
    original.originalEnvelope === frame.originalEnvelope;
}

/**
 * @param {Uint8Array} bytes
 * @throws {Error} If a frame lacks its mandatory envelope.
 */
function assertEnvelope(bytes) {
    if (bytes.byteLength <= TERM_CONTENT_BLOCK_ENVELOPE_BYTES ||
    TERM_CONTENT_BLOCK_ENVELOPE_MAGIC.some((value, index) => bytes[index] !== value)) {
        throw new TermContentOptimizationIntegrityError('Replacement frame has no MBC2 envelope');
    }
}

/**
 * @param {Uint8Array} bytes
 * @param {number} length
 * @throws {Error} If canonical output disagrees with the declared length.
 */
function assertCanonicalLength(bytes, length) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) {
        throw new TermContentOptimizationIntegrityError('Replacement verification canonical length mismatch');
    }
}

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<{codecId: string, dictionary: Uint8Array}>}
 * @throws {Error} If dictionary bytes are outside the foreground codec bounds.
 */
async function prepareDictionary(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 8 || bytes.byteLength > MAX_DICTIONARY_BYTES) {
        throw new TermContentOptimizationIntegrityError('Replacement Zstd dictionary size exceeds admission');
    }
    const dictionary = new Uint8Array(bytes);
    return {codecId: 'manabitan-zstd-' + await digest(dictionary), dictionary};
}

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<string>}
 */
async function digest(bytes) {
    const owned = bytes.buffer instanceof ArrayBuffer ? /** @type {Uint8Array<ArrayBuffer>} */ (bytes) : new Uint8Array(bytes);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', owned));
    return [...hash].map((value) => value.toString(16).padStart(2, '0')).join('');
}

/**
 * @param {Uint8Array} original
 * @param {Uint8Array} replacement
 * @param {AbortSignal} signal
 * @returns {Promise<void>}
 * @throws {Error} If canonical equality fails or foreground work arrives.
 */
async function verifyCanonicalBytes(original, replacement, signal) {
    for (let start = 0; start < original.byteLength; start += COMPARE_CHUNK_BYTES) {
        signal.throwIfAborted();
        const end = Math.min(start + COMPARE_CHUNK_BYTES, original.byteLength);
        for (let index = start; index < end; ++index) {
            if (original[index] !== replacement[index]) {
                throw new TermContentOptimizationIntegrityError('Staged replacement canonical bytes differ from the original');
            }
        }
        if (end < original.byteLength) { await promiseTimeout(1); }
    }
}
