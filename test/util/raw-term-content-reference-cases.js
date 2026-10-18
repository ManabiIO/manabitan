/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {test} from 'node:test'
import {
    decodeRawTermContentBlockReference,
    decodeRawTermContentCompactBlockReference,
    encodeRawTermContentBlockReference,
    encodeRawTermContentCompactBlockReference,
    writeRawTermContentBlockReference,
    writeRawTermContentCompactBlockReference,
} from '../../ext/js/dictionary/raw-term-content.js'

const u32 = 2 ** 32
const max = Number.MAX_SAFE_INTEGER

/**
 * @param {number[]} fields
 * @returns {Uint8Array}
 */
function encode(fields) {
    return encodeRawTermContentBlockReference(fields[0], fields[1], fields[2], fields[3], fields[4])
}

/**
 * @param {number[]} fields
 * @returns {Uint8Array}
 */
function encodeCompact(fields) {
    return encodeRawTermContentCompactBlockReference(fields[0], fields[1], fields[2], fields[3])
}

/**
 * @param {number[]} fields
 * @returns {{blockOffset: number, blockCompressedLength: number, blockUncompressedLength: number, entryOffset: number, entryLength: number}}
 */
function expected(fields) {
    const [blockOffset, blockCompressedLength, blockUncompressedLength, entryOffset, entryLength] = fields
    return {blockOffset, blockCompressedLength, blockUncompressedLength, entryOffset, entryLength}
}

/**
 * @param {number[]} fields
 * @param {number} [offset]
 * @param {number} [viewLength]
 */
function rejectsWithoutWriting(fields, offset = 3, viewLength = 48) {
    const slab = new Uint8Array(72).fill(0xa5)
    const before = Uint8Array.from(slab)
    const view = new DataView(slab.buffer, 7, viewLength)
    assert.throws(() => writeRawTermContentBlockReference(view, offset, fields[0], fields[1], fields[2], fields[3], fields[4]), RangeError)
    assert.deepEqual(slab, before, 'rejected legacy write changed the destination')
}

/**
 * @param {number[]} fields
 * @param {number} [offset]
 * @param {number} [viewLength]
 */
function compactRejectsWithoutWriting(fields, offset = 3, viewLength = 48) {
    const slab = new Uint8Array(72).fill(0xa5)
    const before = Uint8Array.from(slab)
    const view = new DataView(slab.buffer, 7, viewLength)
    assert.throws(() => writeRawTermContentCompactBlockReference(view, offset, fields[0], fields[1], fields[2], fields[3]), RangeError)
    assert.deepEqual(slab, before, 'rejected compact write changed the destination')
}

const validFields = [
    [0, 1, 1, 0, 1],
    [u32 - 1, 2, 100, 20, 80],
    [u32 + 17, 123, 456, 123, 333],
    [max - 1, 1, 1, 0, 1],
    [max - (u32 - 1), u32 - 1, u32 - 1, 0, u32 - 1],
    [123, 123, u32 - 1, u32 - 2, 1],
]

for (const [index, fields] of validFields.entries()) {
    test(`both reference formats preserve valid boundary ${index}`, () => {
        const legacy = encode(fields)
        const compact = encodeCompact(fields)
        assert.deepEqual(decodeRawTermContentBlockReference(legacy), expected(fields))
        assert.deepEqual(decodeRawTermContentCompactBlockReference(compact, fields[4]), expected(fields))
        assert.deepEqual(legacy.subarray(4, 24), compact)
        const oracle = new Uint8Array(28)
        const view = new DataView(oracle.buffer)
        view.setUint32(0, 0x3552424d, true)
        view.setBigUint64(4, BigInt(fields[0]), true)
        for (let i = 1; i < fields.length; ++i) { view.setUint32(8 + i * 4, fields[i], true) }
        assert.deepEqual(legacy, oracle)
    })
}

for (const column of [0, 1, 2, 3, 4]) {
    for (const invalid of [-1, -0.5, 0.5, Number.NaN, Infinity, -Infinity, max + 1]) {
        test(`reject invalid value ${String(invalid)} in reference column ${column}`, () => {
            const fields = [10, 30, 100, 20, 40]
            fields[column] = invalid
            assert.throws(() => encode(fields), RangeError)
            rejectsWithoutWriting(fields)
            if (column < 4) {
                assert.throws(() => encodeCompact(fields), RangeError)
                compactRejectsWithoutWriting(fields)
            }
        })
    }
}

for (const column of [1, 2, 3, 4]) {
    for (const invalid of [u32, u32 + 1]) {
        test(`reject uint32 narrowing ${invalid} in reference column ${column}`, () => {
            const fields = [10, 30, 100, 20, 40]
            fields[column] = invalid
            assert.throws(() => encode(fields), RangeError)
            rejectsWithoutWriting(fields)
            if (column < 4) {
                assert.throws(() => encodeCompact(fields), RangeError)
                compactRejectsWithoutWriting(fields)
            }
        })
    }
}

for (const column of [1, 2, 4]) {
    test(`reject zero length in reference column ${column}`, () => {
        const fields = [10, 30, 100, 20, 40]
        fields[column] = 0
        assert.throws(() => encode(fields), RangeError)
        rejectsWithoutWriting(fields)
        if (column < 4) { compactRejectsWithoutWriting(fields) }
    })
}

for (const entryOffset of [100, 101, u32 - 1]) {
    test(`reject entry offset ${entryOffset} outside its uncompressed block`, () => {
        const fields = [10, 30, 100, entryOffset, 1]
        assert.throws(() => encode(fields), RangeError)
        assert.throws(() => encodeCompact(fields), RangeError)
        rejectsWithoutWriting(fields)
        compactRejectsWithoutWriting(fields)
    })
}

test('reject an entry whose end is beyond the uncompressed block', () => {
    const fields = [10, 30, 100, 50, 51]
    assert.throws(() => encode(fields), RangeError)
    rejectsWithoutWriting(fields)
    assert.equal(decodeRawTermContentCompactBlockReference(encodeCompact(fields), fields[4]), null)
})

test('reject an unsafe block end even when the block offset is safe', () => {
    const fields = [max - 1, 2, 100, 20, 40]
    assert.throws(() => encode(fields), RangeError)
    assert.throws(() => encodeCompact(fields), RangeError)
    rejectsWithoutWriting(fields)
    compactRejectsWithoutWriting(fields)
})

for (const offset of [-1, -0.5, 0.5, Number.NaN, Infinity, max + 1, 21, 48]) {
    test(`reject invalid legacy destination ${String(offset)} without partial writes`, () => {
        rejectsWithoutWriting([10, 30, 100, 20, 40], offset)
    })
}

for (const length of [0, 4, 8, 12, 16, 20, 24, 27]) {
    test(`reject truncated legacy destination of ${length} bytes without partial writes`, () => {
        rejectsWithoutWriting([10, 30, 100, 20, 40], 0, length)
    })
}

test('writers honor destination subview and exact end boundaries', () => {
    for (const compact of [false, true]) {
        const fields = validFields[2]
        const length = compact ? 20 : 28
        const slab = new Uint8Array(80).fill(0xa5)
        const view = new DataView(slab.buffer, 7, 3 + length)
        if (compact) {
            writeRawTermContentCompactBlockReference(view, 3, fields[0], fields[1], fields[2], fields[3])
        } else {
            writeRawTermContentBlockReference(view, 3, fields[0], fields[1], fields[2], fields[3], fields[4])
        }
        assert.deepEqual(slab.subarray(0, 10), new Uint8Array(10).fill(0xa5))
        assert.deepEqual(slab.subarray(10, 10 + length), compact ? encodeCompact(fields) : encode(fields))
        assert.deepEqual(slab.subarray(10 + length), new Uint8Array(70 - length).fill(0xa5))
    }
})

test('a rejected write does not prevent a subsequent valid write', () => {
    const slab = new Uint8Array(28).fill(0xa5)
    const view = new DataView(slab.buffer)
    assert.throws(() => writeRawTermContentBlockReference(view, 0, 0, 1, 100, 0, u32 + 1), RangeError)
    writeRawTermContentBlockReference(view, 0, 0, 1, 100, 0, 1)
    assert.deepEqual(decodeRawTermContentBlockReference(slab), expected([0, 1, 100, 0, 1]))
})

test('both formats preserve negative zero as a zero offset', () => {
    assert.deepEqual(decodeRawTermContentBlockReference(encode([-0, 1, 1, -0, 1])), expected([0, 1, 1, 0, 1]))
    assert.deepEqual(decodeRawTermContentCompactBlockReference(encodeCompact([-0, 1, 1, -0, 1]), 1), expected([0, 1, 1, 0, 1]))
})
