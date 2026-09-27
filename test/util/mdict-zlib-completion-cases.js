/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */
import assert from 'node:assert/strict'
import {describe, test} from 'node:test'
import {deflateSync, gzipSync, inflateSync as nativeInflate} from 'node:zlib'
import {inflateSync} from '../../ext/js/dictionary/mdx/vendor/pako.js'
import {MDX} from '../../ext/js/dictionary/mdx/vendor/js-mdict/mdx.js'
import {MDD} from '../../ext/js/dictionary/mdx/vendor/js-mdict/mdd.js'
import {makeMdictFixture} from './mdict-binary-fixture.js'

/**
 * @param {Uint8Array} bytes
 * @returns {number}
 */
function adler32(bytes) {
    let a = 1
    let b = 0
    for (const byte of bytes) {
        a = (a + byte) % 65521
        b = (b + a) % 65521
    }
    return ((b << 16) | a) >>> 0
}

/**
 * @param {Uint8Array} input
 * @returns {Uint8Array}
 */
function packZlib(input) {
    const compressed = deflateSync(input)
    const bytes = new Uint8Array(compressed.length + 8)
    const view = new DataView(bytes.buffer)
    view.setUint32(0, 2, true)
    view.setUint32(4, adler32(input))
    bytes.set(compressed, 8)
    return bytes
}

/**
 * Reframe a fixture after truncating one compressed section. The outer Adler-32
 * and declared uncompressed sizes stay valid; no parser under test creates it.
 * This helper supports one key block and one record block from the fixture writer.
 * @param {Uint8Array} source
 * @param {1|2} version
 * @param {'key-info'|'key-block'|'record'} section
 * @param {number} cut
 * @returns {Uint8Array}
 */
export function truncateFixtureZlib(source, version, section, cut) {
    const input = new DataView(source.buffer, source.byteOffset, source.byteLength)
    const width = version === 1 ? 4 : 8
    /**
     * @param {DataView} view
     * @param {number} offset
     * @returns {number}
     */
    const read = (view, offset) => (width === 8 ? Number(view.getBigUint64(offset)) : view.getUint32(offset))
    /**
     * @param {DataView} view
     * @param {number} offset
     * @param {number} value
     */
    const write = (view, offset, value) => {
        if (width === 8) {
            view.setBigUint64(offset, BigInt(value))
        } else {
            view.setUint32(offset, value)
        }
    }
    const headerEnd = input.getUint32(0) + 8
    const keyHeaderSize = width * (version === 1 ? 4 : 5)
    const keyHeader = source.slice(headerEnd, headerEnd + keyHeaderSize)
    const kh = new DataView(keyHeader.buffer)
    assert.equal(read(kh, 0), 1)
    const infoLengthOffset = width * (version === 1 ? 2 : 3)
    const keyLengthOffset = infoLengthOffset + width
    const infoStart = headerEnd + keyHeaderSize + (version === 1 ? 0 : 4)
    const keyStart = infoStart + read(kh, infoLengthOffset)
    const recordHeaderStart = keyStart + read(kh, keyLengthOffset)
    let keyInfo = source.slice(infoStart, keyStart)
    let keyBlock = source.slice(keyStart, recordHeaderStart)
    const recordHeader = source.slice(recordHeaderStart, recordHeaderStart + width * 4)
    const rh = new DataView(recordHeader.buffer)
    assert.equal(read(rh, 0), 1)
    const recordInfoStart = recordHeaderStart + width * 4
    const recordDataStart = recordInfoStart + read(rh, width * 2)
    const recordInfo = source.slice(recordInfoStart, recordDataStart)
    let recordBlock = source.slice(recordDataStart)
    switch (section) {
        case 'key-info':
            assert.equal(version, 2)
            assert.throws(() => nativeInflate(keyInfo.subarray(8, keyInfo.length - cut)))
            keyInfo = keyInfo.slice(0, -cut)
            break
        case 'key-block': {
            assert.throws(() => nativeInflate(keyBlock.subarray(8, keyBlock.length - cut)))
            keyBlock = keyBlock.slice(0, -cut)
            // The final two numbers in the one-block descriptor are its sizes.
            const decodedInfo = version === 1 ? keyInfo : new Uint8Array(nativeInflate(keyInfo.subarray(8)))
            write(new DataView(decodedInfo.buffer), decodedInfo.length - width * 2, keyBlock.length)
            keyInfo = version === 1 ? decodedInfo : packZlib(decodedInfo)
            break
        }
        case 'record':
            assert.throws(() => nativeInflate(recordBlock.subarray(8, recordBlock.length - cut)))
            recordBlock = recordBlock.slice(0, -cut)
            write(new DataView(recordInfo.buffer), 0, recordBlock.length)
            write(rh, width * 3, recordBlock.length)
            break
    }
    write(kh, infoLengthOffset, keyInfo.length)
    write(kh, keyLengthOffset, keyBlock.length)
    const checksum = new Uint8Array(version === 1 ? 0 : 4)
    if (version === 2) { new DataView(checksum.buffer).setUint32(0, adler32(keyHeader)) }
    return new Uint8Array(Buffer.concat([source.subarray(0, headerEnd), keyHeader, checksum, keyInfo, keyBlock, recordHeader, recordInfo, recordBlock]))
}

for (const [encoding, compress] of /** @type {const} */ ([['zlib', deflateSync], ['gzip', gzipSync]])) {
    for (const length of [0, 1, 20, 16383, 16384, 16385, 32768]) {
        describe(`${encoding} completion, ${length} decoded bytes`, () => {
            const expected = new Uint8Array(length).fill(0x61)
            const packed = new Uint8Array(compress(expected))
            test('complete stream remains accepted at the exact output limit', () => {
                const parent = new Uint8Array(packed.length + 17).fill(0x7f)
                parent.set(packed, 7)
                const before = Uint8Array.from(parent)
                assert.deepEqual(inflateSync(parent.subarray(7, 7 + packed.length), length), expected)
                assert.deepEqual(parent, before)
            })
            for (const cut of [1, 2, 3, 4]) {
                test(`missing ${cut} trailer bytes is not successful completion`, () => {
                    const truncated = packed.subarray(0, packed.length - cut)
                    assert.throws(() => inflateSync(truncated, length), /incomplete|decompression failed/u)
                })
            }
        })
    }
}

test('every proper prefix of a small zlib stream is rejected', () => {
    const plain = new TextEncoder().encode('日本語\0 exact record payload')
    const packed = new Uint8Array(deflateSync(plain))
    for (let length = 0; length < packed.length; length++) {
        assert.throws(() => inflateSync(packed.subarray(0, length), plain.length), /./u, `prefix ${length}`)
    }
    assert.deepEqual(inflateSync(packed, plain.length), plain)
})

test('complete end marker does not permit unused or concatenated input', () => {
    const plain = new TextEncoder().encode('payload')
    const packed = deflateSync(plain)
    for (const extra of [Buffer.from([0]), packed]) {
        assert.throws(() => inflateSync(new Uint8Array(Buffer.concat([packed, extra])), plain.length), /trailing compressed input/u)
    }
})

test('corrupt trailer and too-small output limits still reject', () => {
    const plain = new Uint8Array(32768).fill(97)
    const packed = new Uint8Array(deflateSync(plain))
    assert.throws(() => inflateSync(packed, plain.length - 1), /exceeds declared/u)
    packed[packed.length - 1] ^= 1
    assert.throws(() => inflateSync(packed, plain.length), /data check|decompression/u)
})

for (const version of /** @type {const} */ ([1, 2])) {
    for (const mdd of [false, true]) {
        const ext = mdd ? 'mdd' : 'mdx'
        describe(`native ${ext} v${version} compressed section completeness`, () => {
            const entries = [{key: 'first', value: 'one 日本語'}, {key: 'last', value: 'two'}]
            const fixture = makeMdictFixture(entries, {mdd, version: `${version}.0`, compression: 'zlib', keysPerBlock: 10, recordBlockSize: 4096})
            test('complete input preserves all record bytes', () => {
                const dict = mdd ? new MDD(`complete.${ext}`, fixture.bytes) : new MDX(`complete.${ext}`, fixture.bytes)
                try {
                    for (const [i, key] of dict.keywordList.entries()) {
                        assert.deepEqual(dict.lookupRecordByKeyBlock(key), fixture.records[i])
                    }
                } finally { dict.close() }
            })
            const sections = version === 1 ? /** @type {const} */ (['key-block', 'record']) : /** @type {const} */ (['key-info', 'key-block', 'record'])
            for (const section of sections) {
                for (const cut of [1, 2, 3, 4]) {
                    test(`${section} rejects ${cut} missing trailer bytes despite a valid outer checksum`, () => {
                        const bytes = truncateFixtureZlib(fixture.bytes, version, section, cut)
                        const before = Uint8Array.from(bytes)
                        if (section === 'record') {
                            const dict = mdd ? new MDD(`truncated.${ext}`, bytes, {recordBlockCacheBytes: 4096}) : new MDX(`truncated.${ext}`, bytes, {recordBlockCacheBytes: 4096})
                            try {
                                assert.throws(() => dict.lookupRecordByKeyBlock(dict.keywordList[0]), /incomplete|decompression failed/u)
                                assert.equal(dict._recordBlockCache.size, 0)
                            } finally { dict.close() }
                        } else {
                            assert.throws(() => (mdd ? new MDD(`truncated.${ext}`, bytes) : new MDX(`truncated.${ext}`, bytes)), /incomplete|decompression failed/u)
                        }
                        assert.deepEqual(bytes, before)
                    })
                }
            }
        })
    }
}
