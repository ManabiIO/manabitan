/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
const MAX_ROWS = 262144
const MAX_UNIQUE = 262144
const MAX_BYTES = 8 * 1024 * 1024
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const getBuffer = Object.getOwnPropertyDescriptor(typedPrototype, 'buffer').get
const getByteOffset = Object.getOwnPropertyDescriptor(typedPrototype, 'byteOffset').get
const getLength = Object.getOwnPropertyDescriptor(typedPrototype, 'length').get
export function createRecordFieldEncoder(module) {
    const memory = new WebAssembly.Memory({initial: 2, maximum: MAX_BYTES / 65536})
    const instance = new WebAssembly.Instance(module, {env: {memory}})
    const start = instance.exports.record_fields_scratch_start()

    function encodeRecordFields(count, scores, references, base) {
    const uniqueCount = getLength.call(references.offsets)
    if (!Number.isInteger(count) || count <= 0 || count > MAX_ROWS || uniqueCount <= 0 || uniqueCount > MAX_UNIQUE) { return null }
    if (getLength.call(scores) < count || getLength.call(references.uniqueIndexList) < count || getLength.call(references.lengths) !== uniqueCount) { return null }
    const scoresPointer = start + count * 4
    const offsetsPointer = scoresPointer + count * 4
    const lengthsPointer = offsetsPointer + uniqueCount * 8
    const outputPointer = (lengthsPointer + uniqueCount * 4 + count * 2 + 3) & ~3
    const required = outputPointer + count * 12
    if (required > MAX_BYTES) { return null }
    const pages = Math.ceil(required / 65536)
    if (memory.buffer.byteLength < pages * 65536) { memory.grow(pages - memory.buffer.byteLength / 65536) }
    const indexes = new Uint32Array(getBuffer.call(references.uniqueIndexList), getByteOffset.call(references.uniqueIndexList), count)
    const scoreInput = new Int32Array(getBuffer.call(scores), getByteOffset.call(scores), count)
    new Uint32Array(memory.buffer, start, count).set(indexes)
    new Int32Array(memory.buffer, scoresPointer, count).set(scoreInput)
    new Float64Array(memory.buffer, offsetsPointer, uniqueCount).set(references.offsets)
    new Uint32Array(memory.buffer, lengthsPointer, uniqueCount).set(references.lengths)
    const length = instance.exports.encode_record_fields(count, uniqueCount, base)
    if (length === 0) { return null }
    return new Uint8Array(memory.buffer, outputPointer, length).slice()
    }

    function allocationInfo(count, uniqueCount) {
    return {
        scratchStart: start,
        inputBytes: count * 8 + uniqueCount * 12,
        requiredHeapBytes: ((start + count * 10 + uniqueCount * 12 + 3) & ~3) + count * 12,
        allocatedHeapBytes: memory.buffer.byteLength,
        outputMaximumBytes: count * 12,
    }
    }
    return {encodeRecordFields, allocationInfo}
}
