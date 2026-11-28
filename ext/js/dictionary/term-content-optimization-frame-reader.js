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

import {TermContentFrameCodecWorkerOwner} from './term-content-frame-codec-worker-owner.js';
import {TermContentOptimizationUnsupportedFrameError} from './term-content-optimization-controller.js';

/** @typedef {import('./term-content-optimization-controller.js').OptimizationJob} Job */
/** @typedef {import('./term-content-optimization-checkpoint.js').OnlineContentFrameDescriptor} Frame */
/** @typedef {ReturnType<import('./dictionary-database.js').DictionaryDatabase['acquireOnlineContentOptimizationSource']>} SourceLease */
/** @typedef {Pick<TermContentFrameCodecWorkerOwner, 'run'|'close'>} CodecOwner */

const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_DECODED_BYTES = 128 * 1024 * 1024;
const MAX_RECOMPRESSION_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_WINDOW_BYTES = 1024 * 1024;

/**
 * Private bounded sampling decoder. It owns one disposable CPU worker and a
 * real immutable source lease through every input read and decode. Foreground
 * admission terminates that worker through AbortSignal; no foreground cache or
 * import compression context is touched. Giant/unknown-size frames need the
 * streaming adapter. The controller releases this strategy’s job on those inputs.
 */
export class TermContentOptimizationFrameReader {
    /**
     * @param {{acquire: (job: Job, signal: AbortSignal) => SourceLease, assertOwned: (job: Job) => void, createCodec?: () => CodecOwner}} options
     */
    constructor({acquire, assertOwned, createCodec = () => new TermContentFrameCodecWorkerOwner()}) {
        /**
         *
         */
        this._acquire = acquire;
        /**
         *
         */
        this._assertOwned = assertOwned;
        /**
         *
         */
        this._createCodec = createCodec;
    }

    /**
     * @param {Job} job
     * @param {Frame} expected
     * @param {number} offset Canonical decoded offset, never a stored offset.
     * @param {number} length
     * @param {AbortSignal} signal
     * @returns {Promise<Uint8Array>}
     * @throws {Error} If ownership, physical identity or byte admission changes.
     */
    async readWindow(job, expected, offset, length, signal) {
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0 || length > MAX_WINDOW_BYTES) {
            throw new TypeError('Invalid private canonical window');
        }
        const decoded = await this._readDecodedFrame(job, expected, offset, length, signal);
        return new Uint8Array(decoded.subarray(offset, offset + length));
    }

    /**
     * @param {Job} job
     * @param {Frame} expected
     * @param {AbortSignal} signal
     * @returns {Promise<Uint8Array>}
     * @throws {Error} If the canonical frame needs streaming recompression.
     */
    async readFrame(job, expected, signal) {
        if (expected.decodedLength === null || expected.decodedLength > MAX_RECOMPRESSION_INPUT_BYTES) {
            throw new TermContentOptimizationUnsupportedFrameError('Training frame requires streaming recompression');
        }
        return await this._readDecodedFrame(job, expected, 0, expected.decodedLength, signal);
    }

    /**
     * @param {Job} job
     * @param {Frame} expected
     * @param {number} offset
     * @param {number} length
     * @param {AbortSignal} signal
     * @returns {Promise<Uint8Array>}
     */
    async _readDecodedFrame(job, expected, offset, length, signal) {
        this._check(job, signal);
        this._admit(expected, offset, length);
        const lease = this._acquire(job, signal);
        /** @type {CodecOwner|null} */
        let codec = null;
        const check = () => {
            this._check(job, signal);
            lease.source.assertCurrent();
        };
        try {
            const frame = await lease.source.describe(expected.identity);
            check();
            if (frame.physicalKey !== expected.physicalKey || frame.storedLength !== expected.storedLength ||
            frame.codecId !== expected.codecId || frame.envelope !== expected.envelope) {
                throw new Error('Private training frame physical identity changed');
            }
            // Legacy identities keep their original unknown length even after
            // private header inspection supplies a canonical sampling bound.
            // Reuse that bound only for the same original vanilla frame; never
            // change the immutable identity used by later override matching.
            const usesInspectedLength = frame.decodedLength === null &&
            expected.identity.kind === 'legacy-entry' && frame.identity.kind === 'legacy-entry' &&
            expected.identity.expectedDecodedLength === null && frame.identity.expectedDecodedLength === null &&
            expected.identity.originalCodecId === null && frame.identity.originalCodecId === null &&
            frame.envelope === frame.identity.originalEnvelope && frame.storedLength === frame.identity.sourceStoredLength;
            if (!usesInspectedLength && frame.decodedLength !== expected.decodedLength) {
                throw new Error('Private training frame physical identity changed');
            }
            const decodedLength = this._admit({...frame, decodedLength: usesInspectedLength ? expected.decodedLength : frame.decodedLength}, offset, length);
            const input = new Uint8Array(frame.storedLength);
            let cursor = 0;
            for await (const chunk of lease.readFrameChunks(frame.identity)) {
                check();
                if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0 || chunk.byteLength > 4 * 1024 * 1024 ||
                chunk.byteLength > input.byteLength - cursor) {
                    throw new Error('Private frame stream exceeded its immutable observation');
                }
                input.set(chunk, cursor);
                cursor += chunk.byteLength;
            }
            check();
            if (cursor !== input.byteLength) { throw new Error('Private frame stream ended before its immutable observation'); }
            codec = this._createCodec();
            const decoded = await codec.run({id: 0,
                action: 'decode',
                bytes: input,
                codecId: null,
                envelope: frame.envelope,
                expectedDecodedLength: decodedLength,
                maxOutputSize: decodedLength}, {signal});
            check();
            if (!(decoded instanceof Uint8Array) || decoded.byteLength !== decodedLength) {
                throw new Error('Private canonical decoder returned an inconsistent frame length');
            }
            return decoded;
        } finally {
            try {
                codec?.close();
            } finally {
                await lease.close();
            }
        }
    }

    /**
     * @param {Frame} frame
     * @param {number} offset
     * @param {number} length
     * @returns {number}
     * @throws {Error} If this frame needs streaming or is no longer vanilla.
     */
    _admit(frame, offset, length) {
        if (!frame || frame.codecId !== null) { throw new Error('Training frame is no longer vanilla ZSTD'); }
        if (!Number.isSafeInteger(frame.storedLength) || frame.storedLength <= 0) { throw new TypeError('Private frame stored length is invalid'); }
        if (frame.decodedLength === null || !Number.isSafeInteger(frame.decodedLength) || frame.decodedLength <= 0 ||
        frame.storedLength > MAX_INPUT_BYTES || frame.decodedLength > MAX_DECODED_BYTES) {
            throw new TermContentOptimizationUnsupportedFrameError('Training frame requires the streaming codec adapter');
        }
        if (offset > frame.decodedLength - length) { throw new RangeError('Canonical training window exceeds its decoded frame'); }
        return frame.decodedLength;
    }

    /**
     * @param {Job} job
     * @param {AbortSignal} signal
     * @throws {Error} If foreground work or another owner preempted this step.
     */
    _check(job, signal) {
        if (signal.aborted) { throw new DOMException('Private frame decode preempted', 'AbortError'); }
        this._assertOwned(job);
    }
}
