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

const FRAME_MAGIC = 0xfd2fb528;
const MAX_FRAME_BYTES = 2 ** 40;
const MAX_ADDRESS = Number.MAX_SAFE_INTEGER;
const MAX_BLOCK_BYTES = 128 * 1024;

/** @typedef {{version: 1, frameOffset: number, logicalHighWater: number, nextOffset: number, blocks: number, decodedLength: number|null, windowSize: number, dictionaryId: number, checksum: boolean, complete: boolean}} ZstdFrameInspectionCursor */
/** @typedef {(offset: number, length: number) => Promise<Uint8Array>} ZstdInspectionReader */

export class ZstdFrameInspectionError extends Error {
    /**
     * @param {string} message
     */
    constructor(message) {
        super(message);
        /** @type {string} */
        this.name = 'ZstdFrameInspectionError';
    }
}

/**
 * @param {unknown} value
 * @param {number} minimum
 * @param {number} maximum
 * @returns {number}
 * @throws {Error} If metadata, resource admission, I/O or generation ownership fails.
 */
function integer(value, minimum, maximum) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new TypeError('Invalid ZSTD frame inspection dimension');
    }
    return value;
}

/**
 * @param {AbortSignal|undefined} signal
 * @param {(() => void)|undefined} assertCurrent
 * @throws {Error} If metadata, resource admission, I/O or generation ownership fails.
 */
function check(signal, assertCurrent) {
    if (signal?.aborted) { throw new DOMException('ZSTD frame inspection was preempted', 'AbortError'); }
    assertCurrent?.();
}

/**
 * Reads metadata only. A canonical decode must independently validate the
 * complete frame before a job can publish replacements or reclaim its bytes.
 * @param {ZstdInspectionReader} read
 * @param {number} offset
 * @param {number} highWater
 * @param {{expectedDecodedLength?: number, signal?: AbortSignal, assertCurrent?: () => void}} [options]
 * @returns {Promise<ZstdFrameInspectionCursor>}
 * @throws {Error} If metadata, resource admission, I/O or generation ownership fails.
 */
export async function beginZstdFrameInspection(read, offset, highWater, {expectedDecodedLength, signal, assertCurrent} = {}) {
    integer(offset, 0, MAX_ADDRESS);
    integer(highWater, offset, MAX_ADDRESS);
    if (typeof expectedDecodedLength !== 'undefined') { integer(expectedDecodedLength, 0, MAX_FRAME_BYTES); }
    check(signal, assertCurrent);
    if (highWater - offset < 6) { throw new ZstdFrameInspectionError('Committed ZSTD frame header is truncated'); }
    const prefix = await read(offset, Math.min(18, highWater - offset));
    check(signal, assertCurrent);
    if (!(prefix instanceof Uint8Array) || prefix.byteLength !== Math.min(18, highWater - offset)) {
        throw new Error('ZSTD frame header read was unavailable or short');
    }
    const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
    if (view.getUint32(0, true) !== FRAME_MAGIC) { throw new ZstdFrameInspectionError('Expected one ordinary ZSTD frame'); }
    const descriptor = prefix[4];
    if ((descriptor & 8) !== 0) { throw new ZstdFrameInspectionError('Reserved ZSTD frame-header flag is set'); }
    const singleSegment = (descriptor & 32) !== 0;
    const contentSizeFlag = descriptor >>> 6;
    let cursor = 5;
    let windowSize = 0;
    if (!singleSegment) {
        const window = prefix[cursor++];
        const base = 2 ** (10 + (window >>> 3));
        windowSize = base + (base / 8) * (window & 7);
    }
    const dictionaryBytes = [0, 1, 2, 4][descriptor & 3];
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][contentSizeFlag];
    if (cursor + dictionaryBytes + contentSizeBytes > prefix.byteLength) {
        throw new ZstdFrameInspectionError('Committed ZSTD frame header fields are truncated');
    }
    let dictionaryId = 0;
    for (let index = 0; index < dictionaryBytes; ++index) { dictionaryId += prefix[cursor++] * 2 ** (8 * index); }
    let decodedLength = null;
    if (contentSizeBytes !== 0) {
        let value = 0n;
        for (let index = 0; index < contentSizeBytes; ++index) { value += BigInt(prefix[cursor++]) << BigInt(8 * index); }
        if (contentSizeBytes === 2) { value += 256n; }
        if (value > BigInt(MAX_FRAME_BYTES)) { throw new RangeError('ZSTD decoded frame exceeds maintenance resource admission'); }
        decodedLength = Number(value);
        if (typeof expectedDecodedLength !== 'undefined' && decodedLength !== expectedDecodedLength) {
            throw new ZstdFrameInspectionError('ZSTD frame content size disagrees with its canonical reference');
        }
    } else if (typeof expectedDecodedLength !== 'undefined') {
        decodedLength = expectedDecodedLength;
    }
    if (singleSegment) { windowSize = decodedLength ?? 0; }
    return {version: 1,
        frameOffset: offset,
        logicalHighWater: highWater,
        nextOffset: offset + cursor,
        blocks: 0,
        decodedLength,
        windowSize,
        dictionaryId,
        checksum: (descriptor & 4) !== 0,
        complete: false};
}

/**
 * Fixed JSON checkpoint. No block/payload array grows with frame size.
 * @param {unknown} value
 * @returns {ZstdFrameInspectionCursor}
 * @throws {Error} If metadata, resource admission, I/O or generation ownership fails.
 */
export function validateZstdFrameInspectionCursor(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new TypeError('Invalid ZSTD frame inspection checkpoint'); }
    const fields = ['version', 'frameOffset', 'logicalHighWater', 'nextOffset', 'blocks', 'decodedLength', 'windowSize', 'dictionaryId', 'checksum', 'complete'];
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== fields.length || fields.some((key) => !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value'))) {
        throw new TypeError('Invalid ZSTD frame inspection checkpoint fields');
    }
    const data = /** @type {Record<string, unknown>} */ (value);
    if (data.version !== 1 || typeof data.checksum !== 'boolean' || typeof data.complete !== 'boolean') {
        throw new TypeError('Unsupported ZSTD frame inspection checkpoint');
    }
    const frameOffset = integer(data.frameOffset, 0, MAX_ADDRESS);
    const logicalHighWater = integer(data.logicalHighWater, frameOffset, MAX_ADDRESS);
    const nextOffset = integer(data.nextOffset, frameOffset + 5, logicalHighWater);
    const blocks = integer(data.blocks, 0, Math.floor((nextOffset - frameOffset) / 3));
    const decodedLength = data.decodedLength === null ? null : integer(data.decodedLength, 0, MAX_FRAME_BYTES);
    const windowSize = integer(data.windowSize, 0, 2 ** 42);
    const dictionaryId = integer(data.dictionaryId, 0, 0xffffffff);
    if (data.complete && blocks === 0) { throw new TypeError('Completed ZSTD frame has no final block'); }
    return {version: 1,
        frameOffset,
        logicalHighWater,
        nextOffset,
        blocks,
        decodedLength,
        windowSize,
        dictionaryId,
        checksum: data.checksum,
        complete: data.complete};
}

/**
 * Visits at most maxBlockHeaders tiny headers, skipping payload by validated
 * lengths. The caller persists this cursor with its generation-pinned job.
 * @param {ZstdInspectionReader} read
 * @param {unknown} checkpoint
 * @param {{maxBlockHeaders?: number, signal?: AbortSignal, assertCurrent?: () => void}} [options]
 * @returns {Promise<{cursor: ZstdFrameInspectionCursor, sourceStoredLength: number|null}>}
 * @throws {Error} If metadata, resource admission, I/O or generation ownership fails.
 */
export async function advanceZstdFrameInspection(read, checkpoint, {maxBlockHeaders = 64, signal, assertCurrent} = {}) {
    integer(maxBlockHeaders, 1, 256);
    const state = validateZstdFrameInspectionCursor(checkpoint);
    check(signal, assertCurrent);
    if (state.complete) { return {cursor: state, sourceStoredLength: state.nextOffset - state.frameOffset}; }
    for (let index = 0; index < maxBlockHeaders; ++index) {
        if (state.nextOffset > state.logicalHighWater - 3) { throw new ZstdFrameInspectionError('Committed ZSTD block header is truncated'); }
        const bytes = await read(state.nextOffset, 3);
        check(signal, assertCurrent);
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 3) { throw new Error('ZSTD block header read was unavailable or short'); }
        const header = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16);
        const last = (header & 1) !== 0;
        const kind = (header >>> 1) & 3;
        const blockSize = header >>> 3;
        if (kind === 3 || blockSize > Math.min(MAX_BLOCK_BYTES, state.windowSize)) {
            throw new ZstdFrameInspectionError('ZSTD block type or size is invalid');
        }
        const storedSize = kind === 1 ? 1 : blockSize;
        const suffix = last && state.checksum ? 4 : 0;
        const next = state.nextOffset + 3 + storedSize + suffix;
        if (next - state.frameOffset > MAX_FRAME_BYTES) { throw new RangeError('ZSTD stored frame exceeds maintenance resource admission'); }
        if (next > state.logicalHighWater) { throw new ZstdFrameInspectionError('Committed ZSTD block or checksum is truncated'); }
        state.nextOffset = next;
        ++state.blocks;
        if (last) {
            state.complete = true;
            return {cursor: state, sourceStoredLength: next - state.frameOffset};
        }
    }
    return {cursor: state, sourceStoredLength: null};
}
