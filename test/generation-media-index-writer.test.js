/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test} from 'vitest'
import {createGenerationMediaIndex, createGenerationMediaIndexWriter} from '../ext/js/dictionary/dictionary-generation-media-store.js'

/** @typedef {import('../ext/js/dictionary/dictionary-generation-media-store.js').SourceMediaRange} SourceMediaRange */

/**
 * @param {string} path
 * @returns {SourceMediaRange}
 */
function range(path) {
    return {path, packedOffset: 0, packedLength: 4, uncompressedLength: 4, compressionMethod: 0, signature: 0xffffffff}
}

/**
 * @param {SourceMediaRange[]} records
 * @param {number} dataBytes
 * @returns {import('../ext/js/dictionary/dictionary-generation-media-store.js').GenerationMediaIndex|null}
 */
function write(records, dataBytes) {
    const writer = createGenerationMediaIndexWriter(records.length, (i) => records[i].path)
    if (writer === null) { return null }
    // Physical archive order and numeric image IDs need not match.
    for (let i = records.length - 1; i >= 0; --i) {
        const {path, packedOffset, packedLength, uncompressedLength, compressionMethod, signature} = records[i]
        if (!writer.write(i, path, packedOffset, packedLength, uncompressedLength, compressionMethod, signature)) { return null }
    }
    return writer.finish(dataBytes)
}

describe('direct generation media index writer', () => {
    test('matches every index byte for unsorted IDs, holes, maximum IDs and mixed compression', () => {
        for (const start of [1, 131_070, 0xfffffff6]) {
            const records = [8, 0, 9, 2, 3, 6, 5, 7].map((offset, i) => ({
                ...range(`img/card${start + offset}.webp`),
                packedOffset: i * 17,
                packedLength: 17,
                uncompressedLength: i % 2 === 0 ? 17 : 123,
                compressionMethod: i % 2 === 0 ? 0 : 8,
                signature: (0x6fff1234 + i * 45678) >>> 0,
            }))
            const baseline = createGenerationMediaIndex(records, 256)
            expect(baseline).not.toBeNull()
            expect(write(records, 256)).toEqual(baseline)
        }
    })

    test.each([
        [],
        ['img/cc1.webp', 'img/cc1.webp'],
        ['img/cc1.webp', 'img/cc4.webp'],
        ['img/cc1.webp', 'img/cd2.webp'],
        ['img/cc1.webp', 'img/cc2.png'],
        ['img/cc0.webp'],
        ['img/cc01.webp'],
        ['img/cc1.webp', 'img/cc+2.webp'],
        ['img/cc1e0.webp'],
        ['img/cc4294967296.webp'],
        ['img/cc1.json'],
        ['1.webp'],
        ['img/\ncc1.webp'],
        [`${'x'.repeat(129)}1.webp`],
    ].map((paths) => ({paths})))('preserves path admission for $paths', ({paths}) => {
        const records = paths.map(range)
        expect(createGenerationMediaIndex(records, 4)).toBeNull()
        expect(createGenerationMediaIndexWriter(records.length, (i) => records[i].path)).toBeNull()
    })

    test.each([0, -1, 0.5, 300_001, Infinity, Number.NaN])('rejects invalid count %s without reading paths', (count) => {
        expect(createGenerationMediaIndexWriter(count, () => { throw new Error('Unexpected path access') })).toBeNull()
    })

    test.each([
        {packedOffset: -1},
        {packedOffset: 0.5},
        {packedOffset: 256 * 1024 * 1024 - 3},
        {packedLength: 0},
        {packedLength: 4 * 1024 * 1024 + 1},
        {uncompressedLength: 0},
        {uncompressedLength: 4 * 1024 * 1024 + 1},
        {compressionMethod: 9},
        {uncompressedLength: 5},
        {signature: -1},
        {signature: 0.5},
        {signature: 0x100000000},
    ])('preserves invalid range rejection for %j', (override) => {
        const records = [{...range('img/cc1.webp'), ...override}]
        expect(createGenerationMediaIndex(records, 256 * 1024 * 1024)).toBeNull()
        expect(write(records, 256 * 1024 * 1024)).toBeNull()
    })

    test.each([0, -1, 3, 4.5, 256 * 1024 * 1024 + 1, Infinity, Number.NaN])('refuses a final payload span of %s bytes', (dataBytes) => {
        const records = [range('img/cc1.webp')]
        expect(createGenerationMediaIndex(records, dataBytes)).toBeNull()
        expect(write(records, dataBytes)).toBeNull()
    })

    test('snapshots path identities without invoking their callback after allocation', () => {
        const paths = ['img/cc3.webp', 'img/cc2.webp', 'img/cc1.webp']
        let reads = 0
        const writer = createGenerationMediaIndexWriter(paths.length, (i) => {
            ++reads
            return paths[i]
        })
        if (writer === null) { throw new Error('Expected index writer') }
        const initialReads = reads
        paths.fill('mutated-after-allocation')
        for (let i = 0; i < paths.length; ++i) {
            expect(writer.write(i, `img/cc${3 - i}.webp`, i * 4, 4, 4, 0, i)).toBe(true)
        }
        expect(writer.finish(12)).not.toBeNull()
        expect(reads).toBe(initialReads)
    })

    test.each([
        'img/cc01.webp',
        'img/cc+1.webp',
        'img/cc1.0.webp',
        'img/cc1e0.webp',
        'img/cc 1.webp',
        'img/cc1 .webp',
        'img/cc0x1.webp',
        'img/cc１.webp',
        'img/cc1.WebP',
        'img/cc1.webp.webp',
        'other/cc1.webp',
        'img/cc2.webp',
        'img/cc4294967297.webp',
    ])('rejects a different spelling or identity at write: %s', (path) => {
        const writer = createGenerationMediaIndexWriter(1, () => 'img/cc1.webp')
        if (writer === null) { throw new Error('Expected index writer') }
        expect(writer.write(0, path, 0, 4, 4, 0, 0)).toBe(false)
        expect(writer.write(0, 'img/cc1.webp', 0, 4, 4, 0, 0)).toBe(false)
        expect(writer.finish(4)).toBeNull()
    })

    test.each([null, undefined, 1, true, Object('img/cc1.webp'), {startsWith() { throw new Error('Must not inspect non-string paths') }}])('rejects a non-string write path without coercion: %s', (path) => {
        const writer = createGenerationMediaIndexWriter(1, () => 'img/cc1.webp')
        if (writer === null) { throw new Error('Expected index writer') }
        expect(writer.write(0, /** @type {string} */ (/** @type {unknown} */ (path)), 0, 4, 4, 0, 0)).toBe(false)
        expect(writer.finish(4)).toBeNull()
    })

    test('retains the final checked callback identity when an early read changes', () => {
        let calls = 0
        const writer = createGenerationMediaIndexWriter(1, () => ++calls < 3 ? 'img/cc1.webp' : 'img/cc4294967295.webp')
        if (writer === null) { throw new Error('Expected index writer') }
        expect(writer.write(0, 'img/cc4294967295.webp', 0, 4, 4, 0, 123)).toBe(true)
        expect(writer.finish(4)).toEqual(createGenerationMediaIndex([{...range('img/cc4294967295.webp'), signature: 123}], 4))
        expect(calls).toBe(3)
    })

    test.each(['wrong-path', 'replaced-namespace', 'duplicate', 'missing', 'fractional-index', 'negative-index', 'past-index'])('does not publish a %s completion', (mode) => {
        const paths = ['img/cc1.webp', 'img/cc2.webp']
        const writer = createGenerationMediaIndexWriter(paths.length, (i) => paths[i])
        if (writer === null) { throw new Error('Expected index writer') }
        expect(writer.write(0, paths[0], 0, 4, 4, 0, 0)).toBe(true)
        if (mode === 'duplicate') { expect(writer.write(0, paths[0], 0, 4, 4, 0, 0)).toBe(false) }
        if (mode === 'wrong-path') { expect(writer.write(1, paths[0], 4, 4, 4, 0, 1)).toBe(false) }
        if (mode === 'replaced-namespace') { expect(writer.write(1, 'else/cc2.webp', 4, 4, 4, 0, 1)).toBe(false) }
        if (mode === 'fractional-index') { expect(writer.write(0.5, paths[1], 4, 4, 4, 0, 1)).toBe(false) }
        if (mode === 'negative-index') { expect(writer.write(-1, paths[1], 4, 4, 4, 0, 1)).toBe(false) }
        if (mode === 'past-index') { expect(writer.write(2, paths[1], 4, 4, 4, 0, 1)).toBe(false) }
        expect(writer.finish(8)).toBeNull()
        expect(writer.write(1, paths[1], 4, 4, 4, 0, 1)).toBe(false)
        expect(writer.finish(8)).toBeNull()
    })

    test('cannot mutate or republish a completed index', () => {
        const writer = createGenerationMediaIndexWriter(1, () => 'img/cc1.webp')
        if (writer === null) { throw new Error('Expected index writer') }
        expect(writer.write(0, 'img/cc1.webp', 0, 4, 4, 0, 0)).toBe(true)
        const plan = writer.finish(4)
        if (plan === null) { throw new Error('Expected complete index') }
        const snapshot = Uint8Array.from(plan.index)
        expect(writer.write(0, 'img/cc1.webp', 0, 4, 4, 0, 123)).toBe(false)
        expect(writer.finish(4)).toBeNull()
        expect(plan.index).toEqual(snapshot)
    })
})
