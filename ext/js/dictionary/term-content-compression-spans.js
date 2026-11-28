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
/* eslint @stylistic/semi: ['error', 'never'] */

const ARRAY_BUFFER_BYTE_LENGTH_DESCRIPTOR = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')
const ARRAY_BUFFER_RESIZABLE_DESCRIPTOR = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')
const SHARED_BUFFER_BYTE_LENGTH_DESCRIPTOR = typeof SharedArrayBuffer === 'function' ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength') : void 0

/** @typedef {{uncompressedBytes: number, compressionRunCount: number, compressionBlockCount: number, compressionTargetBytes: number|null}} SpanValidation */

/**
 * Validates every original span. Stable private columns can also count the
 * compression ranges using these same reads, without allocating run metadata.
 * @param {Uint8Array} sourceBytes
 * @param {Uint32Array} sourceOffsets
 * @param {Uint32Array} sourceLengths
 * @param {number|null} compressionTargetBytes
 * @returns {SpanValidation}
 * @throws {TypeError|RangeError} If the original span columns are invalid.
 */
export function validateTermContentSpans(sourceBytes, sourceOffsets, sourceLengths, compressionTargetBytes) {
    if (!(sourceBytes instanceof Uint8Array)) {
        throw new TypeError('Term content source must be a Uint8Array')
    }
    if (
        !(sourceOffsets instanceof Uint32Array) ||
        !(sourceLengths instanceof Uint32Array) ||
        sourceOffsets.length !== sourceLengths.length
    ) {
        throw new TypeError('Term content span offsets and lengths must be equally sized Uint32Arrays')
    }
    const countRuns = compressionTargetBytes !== null && canCompactSpans(sourceBytes, sourceOffsets, sourceLengths)
    const targetBytes = compressionTargetBytes ?? 0
    let totalBytes = 0
    let runCount = 0
    let blockCount = 0
    let blockBytes = 0
    let previousEnd = -1
    for (let i = 0; i < sourceOffsets.length; ++i) {
        const start = sourceOffsets[i]
        const length = sourceLengths[i]
        if (start > sourceBytes.byteLength || length > sourceBytes.byteLength - start) {
            throw new RangeError(`Term content span ${i} is out of bounds`)
        }
        totalBytes += length
        if (countRuns) {
            if (blockBytes > 0 && blockBytes + length > targetBytes && length > 0) {
                ++blockCount
                blockBytes = 0
                previousEnd = -1
            }
            if (start !== previousEnd) { ++runCount }
            previousEnd = start + length
            blockBytes += length
        }
    }
    if (countRuns && sourceOffsets.length > 0) { ++blockCount }
    return {uncompressedBytes: totalBytes, compressionRunCount: runCount, compressionBlockCount: blockCount, compressionTargetBytes}
}

/**
 * Consumes the immediately preceding validation synchronously, before any await
 * or source reuse. Reference blocks retain their original row partition.
 * @param {Uint32Array} sourceOffsets
 * @param {Uint32Array} sourceLengths
 * @param {number} targetBytes
 * @param {SpanValidation|null} [validation=null]
 * @returns {{packedChunkLengths: Uint32Array, blockStartIndexes: Uint32Array, compressionSourceOffsets: Uint32Array, compressionSourceLengths: Uint32Array, compressionBlockStartIndexes: Uint32Array}}
 * @throws {RangeError} If a block exceeds the storage format or stable columns changed.
 */
export function planTermContentCompressionSpans(sourceOffsets, sourceLengths, targetBytes, validation = null) {
    const expectedRuns = validation?.compressionRunCount ?? 0
    const expectedBlocks = validation?.compressionBlockCount ?? 0
    // The single-block path does not allocate a shared descriptor snapshot.
    // For pooled blocks, count both exact private staging and the unchanged
    // pool snapshot. Fragmented inputs allocate no speculative run columns.
    const compact = (
        validation?.compressionTargetBytes === targetBytes && expectedBlocks >= 2 &&
        expectedRuns * 16 + (expectedBlocks + 1) * 4 < sourceOffsets.byteLength + sourceLengths.byteLength
    )
    if (!compact) {
        const plan = planContentSpansIntoSlabs(sourceLengths, targetBytes)
        return {
            ...plan,
            compressionSourceOffsets: sourceOffsets,
            compressionSourceLengths: sourceLengths,
            compressionBlockStartIndexes: plan.blockStartIndexes,
        }
    }
    const columns = new Uint32Array(expectedRuns * 2 + expectedBlocks + 1)
    const offsets = columns.subarray(0, expectedRuns)
    const lengths = columns.subarray(expectedRuns, expectedRuns * 2)
    const compressionStarts = columns.subarray(expectedRuns * 2)
    /** @type {number[]} */
    const packedChunkLengths = []
    /** @type {number[]} */
    const blockStartIndexes = [0]
    let runCount = 0
    let blockCount = 0
    /**
     * @param {number} offset
     * @param {number} length
     * @throws {RangeError} If the validated run count changed.
     */
    const appendRun = (offset, length) => {
        if (runCount >= expectedRuns) { throw new RangeError('Term content compression span plan changed') }
        offsets[runCount] = offset
        lengths[runCount] = length
        ++runCount
    }

    let startIndex = 0
    while (startIndex < sourceLengths.length) {
        let totalBytes = 0
        let endIndex = startIndex
        let runOffset = sourceOffsets[startIndex]
        let runEnd = runOffset
        while (endIndex < sourceLengths.length) {
            const nextBytes = sourceLengths[endIndex]
            if (totalBytes > 0 && totalBytes + nextBytes > targetBytes && nextBytes > 0) { break }
            totalBytes += nextBytes
            const offset = sourceOffsets[endIndex]
            if (offset !== runEnd) {
                appendRun(runOffset, runEnd - runOffset)
                runOffset = offset
            }
            runEnd = offset + nextBytes
            ++endIndex
        }
        if (totalBytes > 0xffffffff) {
            throw new RangeError('Packed term content block exceeds the 32-bit storage format')
        }
        appendRun(runOffset, runEnd - runOffset)
        ++blockCount
        compressionStarts[blockCount] = runCount
        packedChunkLengths.push(totalBytes)
        blockStartIndexes.push(endIndex)
        startIndex = endIndex
    }
    if (runCount !== expectedRuns || blockCount !== expectedBlocks) {
        throw new RangeError('Term content compression span plan changed')
    }
    const starts = Uint32Array.from(blockStartIndexes)
    return {
        packedChunkLengths: Uint32Array.from(packedChunkLengths),
        blockStartIndexes: starts,
        compressionSourceOffsets: offsets,
        compressionSourceLengths: lengths,
        compressionBlockStartIndexes: compressionStarts,
    }
}

/**
 * @param {Uint32Array} sourceLengths
 * @param {number} targetBytes
 * @returns {{packedChunkLengths: Uint32Array, blockStartIndexes: Uint32Array}}
 * @throws {RangeError} If a planned block cannot use the 32-bit storage format.
 */
export function planContentSpansIntoSlabs(sourceLengths, targetBytes) {
    /** @type {number[]} */
    const packedChunkLengths = []
    /** @type {number[]} */
    const blockStartIndexes = [0]
    let startIndex = 0
    while (startIndex < sourceLengths.length) {
        let totalBytes = 0
        let endIndex = startIndex
        while (endIndex < sourceLengths.length) {
            const nextBytes = sourceLengths[endIndex]
            if (totalBytes > 0 && (totalBytes + nextBytes) > targetBytes && nextBytes > 0) {
                break
            }
            totalBytes += nextBytes
            ++endIndex
        }
        if (totalBytes > 0xffffffff) {
            throw new RangeError('Packed term content block exceeds the 32-bit storage format')
        }
        packedChunkLengths.push(totalBytes)
        blockStartIndexes.push(endIndex)
        startIndex = endIndex
    }
    return {
        packedChunkLengths: Uint32Array.from(packedChunkLengths),
        blockStartIndexes: Uint32Array.from(blockStartIndexes),
    }
}

/**
 * @param {Uint8Array} source
 * @param {Uint32Array} sourceOffsets
 * @param {Uint32Array} sourceLengths
 * @returns {boolean}
 */
function canCompactSpans(source, sourceOffsets, sourceLengths) {
    if (
        !ArrayBuffer.isView(source) || Object.getPrototypeOf(source) !== Uint8Array.prototype ||
        Object.hasOwn(source, 'byteLength') || Object.hasOwn(source, 'buffer') ||
        Object.hasOwn(source, 'byteOffset') || Object.hasOwn(source, 'length') || Object.hasOwn(source, 'subarray') ||
        typeof SHARED_BUFFER_BYTE_LENGTH_DESCRIPTOR?.get !== 'function' ||
        !isStableSpanColumn(sourceOffsets) || !isStableSpanColumn(sourceLengths)
    ) {
        return false
    }
    try {
        SHARED_BUFFER_BYTE_LENGTH_DESCRIPTOR.get.call(source.buffer)
        return true
    } catch {
        return false
    }
}

/**
 * @param {Uint32Array} column
 * @returns {boolean}
 */
function isStableSpanColumn(column) {
    if (
        !ArrayBuffer.isView(column) || Object.getPrototypeOf(column) !== Uint32Array.prototype ||
        Object.hasOwn(column, 'buffer') || Object.hasOwn(column, 'length') ||
        Object.hasOwn(column, 'byteLength') || Object.hasOwn(column, 'byteOffset') ||
        typeof ARRAY_BUFFER_BYTE_LENGTH_DESCRIPTOR?.get !== 'function'
    ) {
        return false
    }
    try {
        ARRAY_BUFFER_BYTE_LENGTH_DESCRIPTOR.get.call(column.buffer)
        return ARRAY_BUFFER_RESIZABLE_DESCRIPTOR?.get?.call(column.buffer) !== true
    } catch {
        return false
    }
}
