/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {describe, test} from 'node:test'
import {MDX} from '../../ext/js/dictionary/mdx/vendor/js-mdict/mdx.js'
import {MDD} from '../../ext/js/dictionary/mdx/vendor/js-mdict/mdd.js'
import {FileScanner} from '../../ext/js/dictionary/mdx/vendor/js-mdict/scanner.js'
import {makeMdictFixture} from './mdict-binary-fixture.js'

describe('MDict borrowed parser ranges', () => {
    test('public scanner reads remain owned while the parser-only view aliases', () => {
        const parent = Buffer.from([99, 1, 2, 3, 4, 88])
        const source = parent.subarray(1, 5)
        const scanner = new FileScanner(source)
        try {
            const owned = scanner.readBuffer(0, 4)
            const number = scanner.readNumber(0, 4)
            const borrowed = scanner.readBufferView(0, 4)

            borrowed[0] = 9
            assert.equal(source[0], 9)
            assert.equal(owned[0], 1)
            assert.equal(number.getUint8(0), 1)

            number.setUint8(1, 7)
            assert.equal(source[1], 2)
            assert.equal(parent[0], 99)
            assert.equal(parent[5], 88)

            assert.throws(() => scanner.readBufferView(3, 2), /available file data/iu)
            assert.throws(() => scanner.readBufferView(-1, 1), /available file data/iu)
        } finally {
            scanner.close()
        }
    })

    for (const compression of /** @type {const} */ (['raw', 'zlib'])) {
        for (const mdd of [false, true]) {
            const ext = mdd ? 'mdd' : 'mdx'
            test(`${compression} ${ext} parsing and lookup never mutate borrowed source bytes`, () => {
                const values = mdd ?
                    [
                        Uint8Array.from({length: 257}, (_, index) => index & 0xff),
                        Uint8Array.from({length: 131}, (_, index) => (index * 7) & 0xff),
                    ] :
                    ['<div>first 日本語 definition</div>', '<p>second 😀 definition</p>']
                const fixture = makeMdictFixture([
                    {key: mdd ? '\\asset\\one.bin' : 'alpha', value: values[0]},
                    {key: mdd ? '\\asset\\two.bin' : 'beta', value: values[1]},
                ], {mdd, compression, recordBlockSize: 17, keysPerBlock: 1})
                const parent = Buffer.alloc(fixture.bytes.length + 23, 0xa5)
                Buffer.from(fixture.bytes).copy(parent, 11)
                const source = parent.subarray(11, 11 + fixture.bytes.length)
                const before = Buffer.from(parent)
                const dictionary = mdd ?
                    new MDD(`borrowed.${ext}`, source, {recordBlockCacheBytes: 4096}) :
                    new MDX(`borrowed.${ext}`, source, {recordBlockCacheBytes: 4096})
                try {
                    for (let index = 0; index < dictionary.keywordList.length; ++index) {
                        const item = dictionary.keywordList[index]
                        const first = dictionary.lookupRecordByKeyBlock(item)
                        assert.deepEqual(first, fixture.records[index])
                        first.fill(0)
                        assert.deepEqual(dictionary.lookupRecordByKeyBlock(item), fixture.records[index])
                    }
                    if (!mdd) {
                        const mdx = /** @type {MDX} */ (dictionary)
                        assert.equal(mdx.lookup('alpha').definition, '<div>first 日本語 definition</div>\0')
                        assert.equal(mdx.lookup('beta').definition, '<p>second 😀 definition</p>\0')
                    }
                    assert.deepEqual(parent, before)
                } finally {
                    dictionary.close()
                }
                assert.deepEqual(parent, before)
            })
        }
    }

    test('borrowed range works with bigint offsets and empty closed source', () => {
        const scanner = new FileScanner(Uint8Array.of(1, 2, 3))
        assert.deepEqual(scanner.readBufferView(1n, 2), Uint8Array.of(2, 3))
        scanner.close()
        assert.deepEqual(scanner.readBufferView(0, 0), new Uint8Array(0))
        assert.throws(() => scanner.readBufferView(0, 1), /available file data/iu)
    })
})
