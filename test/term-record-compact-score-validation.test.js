/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test} from 'vitest'
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js'
import {encodePersistedTermLookupIndex} from '../ext/js/dictionary/term-lookup-index.js'

/**
 * @param {number} count
 * @returns {{store: TermRecordOpfsStore, fields: Uint8Array, payload: Uint8Array, count: number, base: number, scoreCount: number, scoreKeysOffset: number}}
 */
function fixture(count) {
    const store = new TermRecordOpfsStore()
    const base = 2 ** 40
    const values = Int32Array.of(-2147483648, 7, 2147483647)
    const fields = store._encodeArtifactRecordFields(
        {rowCount: count, scoreList: Int32Array.from({length: count}, (_, index) => values[index % values.length])},
        Float64Array.from({length: count}, (_, index) => base + index * 13),
        new Uint32Array(count).fill(8),
        base,
    )
    const header = new DataView(fields.buffer, fields.byteOffset, fields.byteLength)
    expect(header.getUint32(0, true)).toBe(0x3246524d)
    expect(header.getUint32(12, true)).toBe(2)
    const scoreCount = header.getUint32(8, true)
    const encoder = new TextEncoder()
    const payload = encodePersistedTermLookupIndex(Array.from({length: count}, (_, index) => ({
        expressionBytes: encoder.encode(`term-${index}`),
        readingBytes: null,
        sequence: index,
    })))
    return {store, fields, payload, count, base, scoreCount, scoreKeysOffset: 16 + scoreCount * 4 + count * 6}
}

/**
 * @param {Uint8Array} bytes
 * @param {boolean} shared
 * @param {number} byteOffset
 * @returns {Uint8Array}
 */
function moveToView(bytes, shared, byteOffset) {
    const length = byteOffset + bytes.byteLength + 12
    const buffer = shared ? new SharedArrayBuffer(length) : new ArrayBuffer(length)
    const storage = new Uint8Array(buffer)
    storage.fill(0xa5)
    const view = new Uint8Array(buffer, byteOffset, bytes.byteLength)
    view.set(bytes)
    return view
}

/**
 * @param {ReturnType<typeof fixture>} data
 * @param {Uint8Array} fields
 * @returns {Uint8Array}
 */
function createSidecar(data, fields) {
    return data.store._createLookupIndexChunk(37, data.count, data.base, data.payload, fields, 2)
}

describe('compact score validation before sidecar publication', () => {
    test.each([9, 10])('preserves %i compact rows in shifted and shared views', (count) => {
        const data = fixture(count)
        const expected = createSidecar(data, data.fields)
        for (const shared of [false, true]) {
            for (const byteOffset of [0, 4, 12]) {
                const fields = moveToView(data.fields, shared, byteOffset)
                const before = new Uint8Array(fields.buffer).slice()
                expect(createSidecar(data, fields)).toEqual(expected)
                expect(new Uint8Array(fields.buffer)).toEqual(before)
            }
        }
    })

    test.each([
        [9, 0],
        [9, 4],
        [9, 8],
        [10, 0],
        [10, 5],
        [10, 9],
    ])('rejects an invalid score key at row %i / index %i', (count, index) => {
        const data = fixture(count)
        for (const shared of [false, true]) {
            for (const invalidKey of [data.scoreCount, 0xffff]) {
                const fields = moveToView(data.fields, shared, 12)
                new DataView(fields.buffer, fields.byteOffset, fields.byteLength).setUint16(
                    data.scoreKeysOffset + index * 2,
                    invalidKey,
                    true,
                )
                expect(() => createSidecar(data, fields)).toThrow('Compact term-record score key is invalid')
            }
        }
    })

    test.each([0, 0xffff])('rejects invalid score-table size %i before reading keys', (scoreCount) => {
        const data = fixture(9)
        const fields = moveToView(data.fields, true, 4)
        new DataView(fields.buffer, fields.byteOffset, fields.byteLength).setUint32(8, scoreCount, true)
        expect(() => createSidecar(data, fields)).toThrow('Invalid compact term-record fields dimensions')
    })

    test('rejects a mismatched row count and incomplete or oversized fields', () => {
        const data = fixture(9)
        const badCount = data.fields.slice()
        new DataView(badCount.buffer).setUint32(4, data.count + 1, true)
        expect(() => createSidecar(data, badCount)).toThrow('Invalid compact term-record fields dimensions')
        expect(() => createSidecar(data, data.fields.subarray(0, 15))).toThrow('Invalid compact term-record fields header')
        expect(() => createSidecar(data, data.fields.subarray(0, -1))).toThrow('Invalid authoritative term-record fields')
        const oversized = new Uint8Array(data.fields.byteLength + 1)
        oversized.set(data.fields)
        expect(() => createSidecar(data, oversized)).toThrow('Invalid authoritative term-record fields')
    })
})
