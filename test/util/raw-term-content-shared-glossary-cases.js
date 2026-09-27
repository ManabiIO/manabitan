/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {test} from 'node:test'
import {
    decodeRawTermContentSharedGlossaryHeader,
    encodeRawTermContentSharedGlossaryBinary,
    isRawTermContentSharedGlossaryBinary,
    rebaseRawTermContentSharedGlossaryBinary,
} from '../../ext/js/dictionary/raw-term-content.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const max = Number.MAX_SAFE_INTEGER
const u32 = 2 ** 32

/**
 * @param {number} offset
 * @param {number} length
 * @returns {Uint8Array}
 */
const encode = (offset, length) => encodeRawTermContentSharedGlossaryBinary('v1', '\ufefftag', '名詞', offset, length, encoder)
/**
 * @param {Uint8Array} bytes
 * @returns {ReturnType<typeof decodeRawTermContentSharedGlossaryHeader>}
 */
const decode = (bytes) => decodeRawTermContentSharedGlossaryHeader(bytes, decoder)

/**
 * Build the real raw-v3 format independently of the encoder under test.
 * @param {bigint} offset
 * @param {number} [length]
 * @returns {Uint8Array}
 */
function rawReference(offset, length = 2) {
    const tags = [encoder.encode('v1'), encoder.encode('\ufefftag'), encoder.encode('名詞')]
    const total = 28 + tags.reduce((sum, x) => sum + x.byteLength, 0)
    const bytes = new Uint8Array(total)
    bytes.set([0x4d, 0x42, 0x52, 0x32])
    const view = new DataView(bytes.buffer)
    view.setUint32(4, tags[0].byteLength, true)
    view.setUint32(8, tags[1].byteLength, true)
    view.setUint32(12, tags[2].byteLength, true)
    view.setBigUint64(16, offset, true)
    view.setUint32(24, length, true)
    let cursor = 28
    for (const tag of tags) {
        bytes.set(tag, cursor)
        cursor += tag.byteLength
    }
    assert.ok(isRawTermContentSharedGlossaryBinary(bytes), 'fixture must reach shared-glossary validation')
    return bytes
}

test('independent valid fixture is recognized, decoded and rebased', () => {
    const bytes = rawReference(17n, 2)
    assert.deepEqual(bytes, encode(17, 2))
    assert.deepEqual(decode(bytes), {
        rules: 'v1', definitionTags: '\ufefftag', termTags: '名詞', glossaryOffset: 17, glossaryLength: 2,
    })
    assert.deepEqual(rebaseRawTermContentSharedGlossaryBinary(bytes, 1), rawReference(18n, 2))
})

for (const offset of [-1, 0.5, Number.NaN, Infinity, -Infinity, 2 ** 53]) {
    test(`encode rejects unsafe offset ${String(offset)}`, () => {
        assert.throws(() => encode(offset, 2), RangeError)
    })
}

for (const length of [-1, 0.5, Number.NaN, Infinity, -Infinity, u32, u32 + 2, max]) {
    test(`encode rejects unsafe length ${String(length)}`, () => {
        assert.throws(() => encode(0, length), RangeError)
    })
}

for (const [offset, length] of [[max, 1], [max - 1, 2], [max - 3, 8]]) {
    test(`encode rejects unsafe interval end ${offset} + ${length}`, () => {
        assert.throws(() => encode(offset, length), RangeError)
    })
}

for (const [offset, length] of [[0, 0], [0, 2], [-0, 2], [u32 - 1, 2], [u32 + 7, 17], [2 ** 40 + 31, u32 - 1], [max - 5, 5], [max, 0]]) {
    test(`round trip preserves safe range ${offset} + ${length}`, () => {
        const bytes = encode(offset, length)
        assert.deepEqual(decode(bytes), {
            rules: 'v1',
            definitionTags: '\ufefftag',
            termTags: '名詞',
            glossaryOffset: offset === 0 ? 0 : offset,
            glossaryLength: length,
        })
    })
}

for (const offset of [2n ** 53n, 2n ** 53n + 1n, 2n ** 64n - 1n]) {
    test(`decode rejects unrepresentable uint64 offset ${offset}`, () => {
        assert.equal(decode(rawReference(offset)), null)
    })
    for (const delta of [1, -1]) {
        test(`rebase rejects unsafe source ${offset} shifted ${delta}`, () => {
            const bytes = rawReference(offset)
            const snapshot = Uint8Array.from(bytes)
            assert.throws(() => rebaseRawTermContentSharedGlossaryBinary(bytes, delta), RangeError)
            assert.deepEqual(bytes, snapshot)
        })
    }
}

test('decode rejects a safe offset whose interval end is unsafe', () => {
    assert.equal(decode(rawReference(BigInt(max), 1)), null)
})

for (const delta of [Number.NaN, Infinity, -Infinity, 0.5, max + 1]) {
    test(`rebase rejects invalid delta ${String(delta)}`, () => {
        const bytes = encode(20, 2)
        const snapshot = Uint8Array.from(bytes)
        assert.throws(() => rebaseRawTermContentSharedGlossaryBinary(bytes, delta), RangeError)
        assert.deepEqual(bytes, snapshot)
    })
}

for (const [offset, length, delta] of [[5, 2, -6], [max - 2, 2, 1], [max - 2, 2, 3], [max, 1, -1]]) {
    test(`rebase rejects invalid target interval ${offset} + ${length} shifted ${delta}`, () => {
        const bytes = rawReference(BigInt(offset), length)
        const snapshot = Uint8Array.from(bytes)
        assert.throws(() => rebaseRawTermContentSharedGlossaryBinary(bytes, delta), RangeError)
        assert.deepEqual(bytes, snapshot)
    })
}

test('zero rebase retains identity even for malformed shared data', () => {
    const bytes = rawReference(2n ** 53n)
    assert.equal(rebaseRawTermContentSharedGlossaryBinary(bytes, 0), bytes)
})

test('nonzero rebase rejects structurally truncated shared data', () => {
    const bytes = rawReference(17n, 2)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    view.setUint32(4, view.getUint32(4, true) + 1, true)
    const snapshot = Uint8Array.from(bytes)
    assert.throws(() => rebaseRawTermContentSharedGlossaryBinary(bytes, 1), RangeError)
    assert.deepEqual(bytes, snapshot)
})

for (const [offset, length, delta] of [[5, 2, -5], [0, 2, u32 + 1], [u32 - 1, 7, 1], [max - 10, 2, 8], [max, 0, -max]]) {
    test(`valid rebase preserves exact bytes for ${offset}, ${delta}`, () => {
        const original = encode(offset, length)
        const padded = new Uint8Array(original.length + 11).fill(0xa5)
        padded.set(original, 3)
        const bytes = padded.subarray(3, 3 + original.length)
        const snapshot = Uint8Array.from(padded)
        const result = rebaseRawTermContentSharedGlossaryBinary(bytes, delta)
        assert.notEqual(result, bytes)
        assert.deepEqual(padded, snapshot)
        assert.deepEqual(decode(result), {...decode(original), glossaryOffset: offset + delta})
    })
}

test('nonshared payloads retain passthrough behavior', () => {
    const bytes = encoder.encode('not shared content')
    assert.equal(rebaseRawTermContentSharedGlossaryBinary(bytes, 12), bytes)
})
