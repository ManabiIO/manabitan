/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {test} from 'node:test'
import {
    decodeRawTermContentBinary,
    encodeRawTermContentBinary,
} from '../../ext/js/dictionary/raw-term-content.js'

const encoder = new TextEncoder()

/**
 * Independent format oracle, deliberately using the original three encodes.
 * @param {string[]} tags
 * @param {Uint8Array} glossary
 * @returns {Uint8Array}
 */
function expectedBytes(tags, glossary) {
    const encoded = tags.map((tag) => encoder.encode(tag))
    const length = 20 + glossary.byteLength + encoded.reduce((sum, bytes) => sum + bytes.byteLength, 0)
    const bytes = new Uint8Array(length)
    bytes.set([0x4d, 0x42, 0x52, 0x31])
    const view = new DataView(bytes.buffer)
    let offset = 20
    for (let i = 0; i < encoded.length; ++i) {
        view.setUint32(4 + 4 * i, encoded[i].byteLength, true)
        bytes.set(encoded[i], offset)
        offset += encoded[i].byteLength
    }
    view.setUint32(16, glossary.byteLength, true)
    bytes.set(glossary, offset)
    return bytes
}

/**
 * @param {string[]} tags
 * @param {Uint8Array} glossary
 * @returns {Uint8Array}
 */
function encode(tags, glossary) {
    return encodeRawTermContentBinary(tags[0], tags[1], tags[2], glossary, encoder)
}

const tagSets = [
    ['v1', 'noun', 'common'],
    ['読み', '名詞', '頻出'],
    ['\\"\n\t', '\0', '\r'],
    ['\ufeffnoun', '\ufeff', 'tag\ufeff'],
    ['\ud800', '\udc00', 'a\ud800z'],
    ['🐱', '𠮷', 'e\u0301'],
]

for (const [setIndex, tags] of tagSets.entries()) {
    for (let mask = 0; mask < 8; ++mask) {
        test(`exact raw-v2 bytes for metadata set ${setIndex}, empty-field mask ${mask}`, () => {
            const values = tags.map((tag, i) => mask & (1 << i) ? '' : tag)
            const glossary = encoder.encode('["meaning",{"type":"text","text":"猫\\n犬"}]')
            const actual = encode(values, glossary)
            assert.deepEqual(actual, expectedBytes(values, glossary))
            const decoded = decodeRawTermContentBinary(actual, new TextDecoder())
            assert.notEqual(decoded, null)
            const normalized = values.map((tag) => new TextDecoder('utf-8', {ignoreBOM: true}).decode(encoder.encode(tag)))
            assert.deepEqual(decoded, {rules: normalized[0], definitionTags: normalized[1], termTags: normalized[2], glossaryJson: new TextDecoder().decode(glossary)})
        })
    }
}

for (const size of [0, 1, 2, 255, 256, 65535, 65536]) {
    test(`empty metadata preserves a ${size}-byte glossary subview and does not alias it`, () => {
        const backing = new Uint8Array(size + 14).fill(0xa5)
        const glossary = backing.subarray(7, 7 + size)
        for (let i = 0; i < glossary.length; ++i) { glossary[i] = i & 255 }
        const before = Uint8Array.from(backing)
        const bytes = encode(['', '', ''], glossary)
        const expected = expectedBytes(['', '', ''], glossary)
        assert.deepEqual(bytes, expected)
        assert.deepEqual(backing, before)
        assert.equal(bytes.byteOffset, 0)
        assert.equal(bytes.buffer.byteLength, size + 20)
        assert.notEqual(bytes.buffer, backing.buffer)
        glossary.fill(0x13)
        assert.deepEqual(bytes, expected)
        const after = Uint8Array.from(backing)
        bytes.fill(0x17)
        assert.deepEqual(backing, after)
    })
}

class CountingEncoder extends TextEncoder {
    calls = 0

    /**
     * @param {string} [value]
     * @returns {Uint8Array}
     */
    encode(value) {
        ++this.calls
        return super.encode(value)
    }
}

for (let mask = 0; mask < 8; ++mask) {
    test(`skip metadata encoding only when every field is empty, mask ${mask}`, () => {
        const tags = ['v1', 'noun', 'common'].map((tag, i) => mask & (1 << i) ? '' : tag)
        const counted = new CountingEncoder()
        const glossary = encoder.encode('["meaning"]')
        const bytes = encodeRawTermContentBinary(tags[0], tags[1], tags[2], glossary, counted)
        assert.deepEqual(bytes, expectedBytes(tags, glossary))
        assert.equal(counted.calls, mask === 7 ? 0 : 3)
    })
}

test('successive empty-metadata results have independent storage', () => {
    const glossary = encoder.encode('["meaning"]')
    const a = encode(['', '', ''], glossary)
    const b = encode(['', '', ''], glossary)
    const expected = Uint8Array.from(b)
    assert.notEqual(a.buffer, b.buffer)
    a.fill(0)
    assert.deepEqual(b, expected)
})

test('seeded mixed metadata and arbitrary glossary bytes preserve the complete binary format', () => {
    let state = 0x6d616e61
    const next = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0
        return state
    }
    const alphabet = ['', 'noun', '猫', '\0', '\n', '\\', '"', '\ud800', '\udc00', '\ufeff', '🐱']
    for (let row = 0; row < 4000; ++row) {
        const tags = Array.from({length: 3}, () => {
            if (next() % 4 !== 0) { return '' }
            return alphabet[next() % alphabet.length] + alphabet[next() % alphabet.length]
        })
        const glossary = new Uint8Array(next() % 257)
        for (let i = 0; i < glossary.length; ++i) { glossary[i] = next() & 255 }
        assert.deepEqual(encode(tags, glossary), expectedBytes(tags, glossary))
    }
})
