/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */
import assert from 'node:assert/strict'
import {expect, test} from 'vitest'
import {FileScanner} from '../ext/js/dictionary/mdx/vendor/js-mdict/scanner.js'
import {MDX} from '../ext/js/dictionary/mdx/vendor/js-mdict/mdx.js'
import {MDD} from '../ext/js/dictionary/mdx/vendor/js-mdict/mdd.js'
import {makeMdictFixture} from './util/mdict-binary-fixture.js'

class BorrowingBytes extends Uint8Array {
    /**
     * @param {number} [start]
     * @param {number} [end]
     * @returns {Uint8Array}
     */
    slice(start, end) { return this.subarray(start, end) }
}

/**
 * @param {'buffer'|'uint8'|'array-buffer'|'subclass'} kind
 * @returns {{source: Uint8Array|ArrayBuffer, bytes: Uint8Array, parent: Uint8Array}}
 */
function input(kind) {
    const parent = new Uint8Array(64).fill(0xa5)
    parent.set([1, 2, 3, 4], 19)
    const bytes = parent.subarray(19, 23)
    /** @type {Uint8Array|ArrayBuffer} */
    let source = bytes
    switch (kind) {
        case 'buffer': source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength); break
        case 'subclass': source = new BorrowingBytes(bytes.buffer, bytes.byteOffset, bytes.byteLength); break
        case 'array-buffer': source = Uint8Array.from(bytes).buffer; break
    }
    return {source, bytes: source instanceof ArrayBuffer ? new Uint8Array(source) : source, parent}
}

for (const kind of /** @type {const} */ (['buffer', 'uint8', 'array-buffer', 'subclass'])) {
    test(`${kind}: mutating a read cannot change the source or later reads`, () => {
        const {source, bytes, parent} = input(kind)
        const scanner = new FileScanner(source)
        const before = Uint8Array.from(parent)
        const read = scanner.readBuffer(1, 2)
        expect([...read]).toEqual([2, 3])
        read[0] = 99
        expect([...bytes]).toEqual([1, 2, 3, 4])
        expect(parent).toEqual(before)
        expect([...scanner.readBuffer(1, 2)]).toEqual([2, 3])
    })
    test(`${kind}: a completed read is owned while the scanner still borrows its source`, () => {
        const {source, bytes} = input(kind)
        const scanner = new FileScanner(source)
        const read = scanner.readBuffer(1, 2)
        bytes[1] = 77
        expect([...read]).toEqual([2, 3])
        expect([...scanner.readBuffer(1, 2)]).toEqual([77, 3])
    })
    test(`${kind}: numeric reads also own their selected range`, () => {
        const {source, bytes} = input(kind)
        const scanner = new FileScanner(source)
        const view = scanner.readNumber(1, 2)
        expect(view.getUint16(0, false)).toBe(0x0203)
        view.setUint16(0, 0xffff)
        expect([...bytes]).toEqual([1, 2, 3, 4])
        expect(scanner.readNumber(1, 2).getUint16(0, false)).toBe(0x0203)
    })
    test(`${kind}: only the bounded payload is copied and close releases future reads`, () => {
        const {source, bytes} = input(kind)
        const scanner = new FileScanner(source)
        const read = scanner.readBuffer(1n, 2)
        expect(read.byteOffset).toBe(0)
        expect(read.buffer.byteLength).toBe(2)
        expect([...scanner.readBuffer(4, 0)]).toEqual([])
        expect(() => scanner.readBuffer(3, 2)).toThrow(RangeError)
        expect(() => scanner.readBuffer(-1, 0)).toThrow(RangeError)
        expect(() => scanner.readBuffer(0, 1.5)).toThrow(RangeError)
        scanner.close()
        bytes.fill(0)
        expect([...read]).toEqual([2, 3])
        expect(() => scanner.readBuffer(0, 1)).toThrow(RangeError)
        expect([...scanner.readBuffer(0, 0)]).toEqual([])
    })
}

for (const compression of /** @type {const} */ (['raw', 'zlib'])) {
    for (const mdd of [false, true]) {
        test(`real ${compression} ${mdd ? 'MDD' : 'MDX'} accepts bounded Buffer input without altering its parent`, () => {
            const expected = new TextEncoder().encode('日本語\0binary\uFEFF')
            const value = mdd ? expected : '<div>日本語 definition</div>'
            const fixture = makeMdictFixture([{key: 'sample', value}], {compression, mdd, recordBlockSize: 7})
            const parent = Buffer.alloc(fixture.bytes.length + 37, 0xa5)
            parent.set(fixture.bytes, 19)
            const before = Uint8Array.from(parent)
            const source = parent.subarray(19, 19 + fixture.bytes.length)
            const dictionary = mdd ? new MDD('sample.mdd', source) : new MDX('sample.mdx', source)
            try {
                const item = dictionary.lookupKeyBlockByWord('sample')
                const bytes = dictionary.lookupRecordByKeyBlock(item)
                assert.ok(bytes)
                if (mdd) {
                    expect(bytes).toEqual(expected)
                } else {
                    expect(new TextDecoder().decode(bytes)).toContain('<div>日本語 definition</div>')
                }
                expect(Uint8Array.from(parent)).toEqual(before)
                bytes.fill(0)
                expect(dictionary.lookupRecordByKeyBlock(item)).not.toEqual(bytes)
            } finally { dictionary.close() }
        })
    }
}
