/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test, vi} from 'vitest'
import {MDD} from '../ext/js/dictionary/mdx/vendor/js-mdict/mdd.js'
import {MDX} from '../ext/js/dictionary/mdx/vendor/js-mdict/mdx.js'
import {makeMdictFixture} from './util/mdict-binary-fixture.js'

/**
 * @param {number[]} sizes
 * @param {'raw'|'zlib'} compression
 * @param {Record<string, unknown>} options
 * @param {number} [blockSize]
 */
function open(sizes, compression, options, blockSize = 64) {
    const entries = sizes.map((size, index) => ({
        key: `image-${index}`,
        value: new Uint8Array(size).fill(index + 1),
    }))
    const fixture = makeMdictFixture(entries, {mdd: true, compression, recordBlockSize: blockSize})
    const dictionary = new MDD('bounded.mdd', fixture.bytes, options)
    const decompress = vi.spyOn(dictionary, 'decompressBuff')
    const read = (/** @type {number} */ index) => {
        const bytes = dictionary.lookupRecordByKeyBlock(dictionary.keywordList[index])
        if (bytes === null) { throw new Error('Missing fixture record') }
        return bytes
    }
    return {dictionary, decompress, read, fixture, entries}
}

const enabled = {recordBlockCacheBytes: 16, oversizedRecordBlockCacheBytes: 64}

describe('bounded oversized MDict record cache', () => {
    test.each([-1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '64', true])(
        'rejects invalid separate budget %s',
        (value) => {
            expect(() => new MDD('invalid.mdd', new Uint8Array(), {oversizedRecordBlockCacheBytes: value}))
                .toThrow('Invalid MDict oversized record block cache budget')
        },
    )

    for (const compression of /** @type {const} */ (['raw', 'zlib'])) {
        test(`${compression}: repeated reads promote only after the second decode`, () => {
            const {dictionary, decompress, read, entries} = open([32, 32], compression, enabled)
            try {
                expect(read(0)).toEqual(entries[0].value)
                expect(dictionary._oversizedRecordBlock).toBeNull()
                expect(read(1)).toEqual(entries[1].value)
                expect(dictionary._oversizedRecordBlock?.byteLength).toBe(64)
                const returned = read(0)
                returned.fill(0xff)
                expect(read(0)).toEqual(entries[0].value)
                expect(decompress).toHaveBeenCalledTimes(2)
                expect(dictionary._recordBlockCacheSize).toBe(0)
            } finally {
                dictionary.close()
            }
            expect(dictionary._oversizedRecordBlock).toBeNull()
            expect(dictionary._oversizedRecordBlockCandidateIndex).toBe(-1)
            expect(dictionary._oversizedRecordBlockIndex).toBe(-1)
        })

        test.each([
            {recordBlockCacheBytes: 16},
            {recordBlockCacheBytes: 16, oversizedRecordBlockCacheBytes: 0},
            {recordBlockCacheBytes: 0, oversizedRecordBlockCacheBytes: 64},
        ])(`${compression}: opt-in policy remains disabled for %j`, (options) => {
            const {dictionary, decompress, read} = open([32, 32], compression, options)
            try {
                for (let i = 0; i < 4; ++i) { read(0) }
                expect(decompress).toHaveBeenCalledTimes(4)
                expect(dictionary._oversizedRecordBlock).toBeNull()
            } finally {
                dictionary.close()
            }
        })

        test.each([63, 64, 65])(`${compression}: separate byte limit %s is exact`, (limit) => {
            const {dictionary, decompress, read} = open(
                [32, 32],
                compression,
                {...enabled, oversizedRecordBlockCacheBytes: limit},
            )
            try {
                for (let i = 0; i < 4; ++i) { read(0) }
                expect(decompress).toHaveBeenCalledTimes(limit < 64 ? 4 : 2)
                expect(dictionary._oversizedRecordBlock?.byteLength ?? 0).toBe(limit < 64 ? 0 : 64)
            } finally {
                dictionary.close()
            }
        })

        test(`${compression}: alternating blocks never promote`, () => {
            const {dictionary, decompress, read} = open([32, 32, 32, 32], compression, enabled)
            try {
                for (const index of [0, 2, 0, 2, 0, 2]) {
                    read(index)
                    expect(dictionary._oversizedRecordBlock).toBeNull()
                }
                expect(decompress).toHaveBeenCalledTimes(6)
            } finally {
                dictionary.close()
            }
        })

        test(`${compression}: a normal-cache hit releases the transient block`, () => {
            const {dictionary, read} = open([32, 32, 16], compression, enabled)
            try {
                read(2)
                read(0)
                read(1)
                expect(dictionary._oversizedRecordBlock?.byteLength).toBe(64)
                read(2)
                expect(dictionary._oversizedRecordBlock).toBeNull()
                expect(dictionary._oversizedRecordBlockCandidateIndex).toBe(-1)
            } finally {
                dictionary.close()
            }
        })

        test(`${compression}: validation failure releases candidate state`, () => {
            const {dictionary, read, fixture} = open([32, 32, 32, 32], compression, enabled)
            try {
                read(0)
                read(1)
                const info = dictionary.recordInfoList[1]
                const checksumOffset = fixture.recordDataOffset + info.packAccumulateOffset + 4
                fixture.bytes[checksumOffset] ^= 1
                expect(() => read(2)).toThrow(/checksum/u)
                expect(dictionary._oversizedRecordBlock).toBeNull()
                expect(dictionary._oversizedRecordBlockCandidateIndex).toBe(-1)
            } finally {
                dictionary.close()
            }
        })
    }

    test('a block above the extra allowance is never retained', () => {
        const limit = 2 * 1024 * 1024
        const {dictionary, decompress, read} = open([limit + 1], 'zlib', {
            recordBlockCacheBytes: 1024 * 1024,
            oversizedRecordBlockCacheBytes: limit,
        }, limit + 1)
        try {
            for (let i = 0; i < 3; ++i) {
                expect(read(0).byteLength).toBe(limit + 1)
                expect(dictionary._oversizedRecordBlock).toBeNull()
            }
            expect(decompress).toHaveBeenCalledTimes(3)
        } finally {
            dictionary.close()
        }
    }, 10000)

    test('MDX UTF-16 definitions and empty records are unchanged', () => {
        const entries = [
            {key: 'a', value: '日本語𠮷'},
            {key: 'b', value: ''},
            {key: 'c', value: '最後'},
        ]
        const fixture = makeMdictFixture(entries, {encoding: 'utf16le', recordBlockSize: 128})
        const dictionary = new MDX('unicode.mdx', fixture.bytes, {
            recordBlockCacheBytes: 1,
            oversizedRecordBlockCacheBytes: 128,
        })
        try {
            for (let repeat = 0; repeat < 3; ++repeat) {
                for (const {key, value} of entries) {
                    expect(dictionary.lookup(key).definition).toBe(`${value}\0`)
                }
            }
        } finally {
            dictionary.close()
        }
    })
})
