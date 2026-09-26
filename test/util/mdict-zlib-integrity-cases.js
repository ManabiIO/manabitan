/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {deflateSync} from 'node:zlib'
import {describe, test} from 'node:test'
import {inflateSync} from '../../ext/js/dictionary/mdx/vendor/pako.js'
import {MDX} from '../../ext/js/dictionary/mdx/vendor/js-mdict/mdx.js'
import mdictCommon from '../../ext/js/dictionary/mdx/vendor/js-mdict/utils.js'
import {makeMdictFixture} from './mdict-binary-fixture.js'

const source = new Uint8Array(Buffer.from('complete zlib payload '.repeat(512), 'utf8'))
const compressed = new Uint8Array(deflateSync(source))

/**
 * @param {Uint8Array} payload
 * @returns {Uint8Array}
 */
function mdictZlibBlock(payload) {
    const result = new Uint8Array(8 + payload.length)
    result.set([2, 0, 0, 0], 0)
    const checksum = mdictCommon.adler32(source)
    result[4] = (checksum >>> 24) & 0xff
    result[5] = (checksum >>> 16) & 0xff
    result[6] = (checksum >>> 8) & 0xff
    result[7] = checksum & 0xff
    result.set(payload, 8)
    return result
}

describe('bounded MDict zlib stream integrity', () => {
    test('accepts a complete stream and preserves exact bytes', () => {
        assert.deepEqual(inflateSync(compressed, source.length), source)
    })

    for (let missing = 1; missing <= 4; ++missing) {
        test(`rejects a zlib stream missing ${missing} trailer byte(s)`, () => {
            assert.throws(
                () => inflateSync(compressed.subarray(0, compressed.length - missing), source.length),
                /zlib.*(?:incomplete|end|trunc)/iu,
            )
        })
    }

    test('rejects bytes following a complete zlib stream', () => {
        const withTrailing = new Uint8Array(compressed.length + 1)
        withTrailing.set(compressed)
        withTrailing[compressed.length] = 0x7f
        assert.throws(() => inflateSync(withTrailing, source.length), /trailing compressed input/iu)
    })

    test('retains the declared output-size limit', () => {
        assert.throws(() => inflateSync(compressed, source.length - 1), /declared size/iu)
    })

    test('accepts a valid empty zlib stream', () => {
        const empty = new Uint8Array(deflateSync(new Uint8Array(0)))
        assert.deepEqual(inflateSync(empty, 0), new Uint8Array(0))
    })

    for (let missing = 1; missing <= 4; ++missing) {
        test(`MDict block decoding rejects ${missing} missing zlib trailer byte(s)`, () => {
            const fixture = makeMdictFixture([{key: 'control', value: 'definition'}], {compression: 'raw'})
            const mdx = new MDX('zlib-integrity.mdx', fixture.bytes)
            try {
                const truncated = compressed.subarray(0, compressed.length - missing)
                assert.throws(
                    () => mdx.decompressBuff(mdictZlibBlock(truncated), source.length),
                    /zlib.*(?:incomplete|end|trunc)/iu,
                )
            } finally {
                mdx.close()
            }
        })
    }
})
