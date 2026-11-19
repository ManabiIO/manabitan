/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test, vi} from 'vitest'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'

/**
 * @param {DictionaryDatabase} database
 * @param {Uint8Array} source
 * @param {number[]} offsets
 * @param {number[]} lengths
 * @param {number} [seed]
 * @returns {{staged: {indexes: Int32Array, active: boolean}, metas: import('../ext/js/dictionary/dictionary-database.js').TermContentMeta[]}}
 */
function publish(database, source, offsets, lengths, seed = 1) {
    const hash1 = offsets.map((_, i) => seed * 100 + i)
    const hash2 = offsets.map((_, i) => seed * 200 + i)
    const spans = {buffer: source, offsets: Uint32Array.from(offsets), lengths: Uint32Array.from(lengths)}
    const staged = Reflect.get(database, '_stageArtifactTermContentMetadata').call(database, hash1, hash2, [], spans)
    Reflect.get(database, '_publishArtifactTermContentMetadata').call(database, {
        count: offsets.length,
        contentOffsets: new Float64Array(offsets.length),
        contentLengths: new Uint32Array(offsets.length),
        resolvedContentDictNames: 'raw',
        pendingRowToUniqueIndex: Int32Array.from(offsets, (_, i) => i),
        pendingContentBytes: [],
        pendingContentHash1s: hash1,
        pendingContentHash2s: hash2,
        pendingOffsets: offsets.map((_, i) => seed * 1000 + i * 100),
        pendingLengths: lengths,
        pendingResolvedDictNames: 'raw',
        pendingContentSpans: spans,
        stagedContentMetadata: staged,
    })
    const metas = hash1.map((value, i) => Reflect.get(database, '_getTermEntryContentMetaByHashPair').call(database, value, hash2[i]))
    return {staged, metas}
}

/**
 * @param {number} alignment
 * @param {number} length
 * @returns {Uint8Array}
 */
function sharedSource(alignment, length) {
    const source = new Uint8Array(new SharedArrayBuffer(alignment + length), alignment, length)
    for (let i = 0; i < length; ++i) { source[i] = (i * 31 + 7) & 255 }
    return source
}

/**
 * @param {DictionaryDatabase} database
 * @param {import('../ext/js/dictionary/dictionary-database.js').TermContentMeta} meta
 * @returns {{buffer: Uint8Array, offset: number, length: number}|undefined}
 */
function find(database, meta) {
    return Reflect.get(database, '_findRecentTermContentSource').call(database, meta)
}

const copyCases = Array.from({length: 8}, (_, alignment) => (
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 15, 16, 17, 511, 512].map((length) => ({alignment, length}))
)).flat()

describe('owned recent-source copy alignment', () => {
    test.each(copyCases)('copies exact bytes at alignment $alignment with length $length', ({alignment, length}) => {
        const database = new DictionaryDatabase()
        const sourceOffset = length % 2 === 0 ? 0 : 3
        const source = sharedSource(8 + alignment, sourceOffset + length + 2)
        const expected = source.slice(sourceOffset, sourceOffset + length)
        const {metas: [meta]} = publish(database, source, [sourceOffset], [length])
        const found = find(database, meta)
        const padding = (source.byteOffset + sourceOffset) % 8
        if (typeof found === 'undefined') { throw new Error('Expected an owned recent source') }
        expect(found.offset).toBe(0)
        expect(found.length).toBe(length)
        expect(found.buffer).toEqual(expected)
        expect(found.buffer.byteOffset).toBe(padding)
        expect(found.buffer.buffer.byteLength).toBe(length + padding)
        expect(found.buffer.buffer).toBeInstanceOf(ArrayBuffer)
        expect(Reflect.get(database, '_recentTermContentSourceBatchBytes')).toBe(length + padding)
        // Padding stays zero and is never populated from bytes before the view.
        expect(new Uint8Array(found.buffer.buffer, 0, padding)).toEqual(new Uint8Array(padding))
        new Uint8Array(source.buffer).fill(255)
        expect(found.buffer).toEqual(expected)
    })

    test.each(Array.from({length: 8}, (_, alignment) => alignment))('does not read past a one-byte source ending at alignment %i', (alignment) => {
        const database = new DictionaryDatabase()
        const source = sharedSource(alignment, 1)
        const {metas: [meta]} = publish(database, source, [0], [1])
        expect(find(database, meta)?.buffer).toEqual(Uint8Array.of(7))
    })

    test('keeps the ordinary ArrayBuffer copy unpadded', () => {
        const database = new DictionaryDatabase()
        const source = new Uint8Array(new ArrayBuffer(30), 7, 20).fill(42)
        const {metas: [meta]} = publish(database, source, [3], [9])
        expect(find(database, meta)?.buffer.byteOffset).toBe(0)
        expect(find(database, meta)?.buffer.buffer.byteLength).toBe(9)
        expect(Reflect.get(database, '_recentTermContentSourceBatchBytes')).toBe(9)
    })

    test.each([0, 513])('keeps existing cache exclusion for a shared definition of %i bytes', (length) => {
        const database = new DictionaryDatabase()
        const {metas: [meta]} = publish(database, sharedSource(3, length), [0], [length])
        expect(find(database, meta)).toBeUndefined()
        expect(Reflect.get(database, '_recentTermContentSourceBatchBytes')).toBe(0)
    })

    test('keeps relative span mappings and gap bytes within the same owned copy', () => {
        const database = new DictionaryDatabase()
        const source = sharedSource(6, 30)
        const expected = source.slice(3, 26)
        const {metas} = publish(database, source, [3, 12, 24], [4, 5, 2])
        source.fill(0)
        expect(find(database, metas[0])?.buffer).toEqual(expected)
        expect(find(database, metas[0])?.buffer.byteOffset).toBe(1)
        expect(Reflect.get(database, '_recentTermContentSourceBatchBytes')).toBe(24)
        for (const [i, offset, length] of [[0, 0, 4], [1, 9, 5], [2, 21, 2]]) {
            const found = find(database, metas[i])
            expect(found?.offset).toBe(offset)
            expect(found?.buffer.subarray(found.offset, found.offset + found.length)).toEqual(expected.subarray(offset, offset + length))
        }
    })

    test.each([14, 15])('enforces the backing-byte admission boundary with budget %i', (budget) => {
        const database = new DictionaryDatabase()
        Reflect.set(database, '_recentTermContentSourceCacheMaxBytes', budget)
        const {metas: [meta]} = publish(database, sharedSource(7, 8), [0], [8])
        expect(find(database, meta) !== void 0).toBe(budget === 15)
        expect(Reflect.get(database, '_recentTermContentSourceBatchBytes')).toBe(budget === 15 ? 15 : 0)
    })

    test('counts padding when deciding whether to evict an older batch', async () => {
        const database = new DictionaryDatabase()
        Reflect.set(database, '_recentTermContentSourceCacheMaxBytes', 16)
        const firstSource = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8)
        const {metas: [first]} = publish(database, firstSource, [0], [8])
        const {metas: [second]} = publish(database, sharedSource(1, 8), [0], [8], 2)
        expect(find(database, first)).toBeUndefined()
        expect(find(database, second)).toBeDefined()
        expect(Reflect.get(database, '_recentTermContentSourceBatchBytes')).toBe(9)
        const readStorage = vi.fn(async () => [{status: 'ok', bytes: firstSource}])
        Reflect.set(database, '_readTermEntryContentBytesDetailedBatch', readStorage)
        const [match] = await Reflect.get(database, '_findMatchingPersistedTermEntryContentMetaBatch').call(database, [
            {hash1: 100, hash2: 200, contentBytes: firstSource, primary: first},
        ])
        expect(match).toStrictEqual({existingMeta: first, exactFallback: true})
        expect(readStorage).toHaveBeenCalledOnce()
    })

    test('subtracts the evicted allocation including its padding', () => {
        const database = new DictionaryDatabase()
        Reflect.set(database, '_recentTermContentSourceCacheMaxBytes', 16)
        const {metas: [first]} = publish(database, sharedSource(7, 8), [0], [8])
        const {metas: [second]} = publish(database, sharedSource(0, 8), [0], [8], 2)
        expect(find(database, first)).toBeUndefined()
        expect(find(database, second)).toBeDefined()
        expect(Reflect.get(database, '_recentTermContentSourceBatchBytes')).toBe(8)
    })

    test('rejects an oversized padded allocation without evicting existing data', () => {
        const database = new DictionaryDatabase()
        Reflect.set(database, '_recentTermContentSourceCacheMaxBytes', 16)
        const {metas: [first]} = publish(database, sharedSource(0, 8), [0], [8])
        const {metas: [second]} = publish(database, sharedSource(7, 10), [0], [10], 2)
        expect(find(database, first)).toBeDefined()
        expect(find(database, second)).toBeUndefined()
        expect(Reflect.get(database, '_recentTermContentSourceBatchBytes')).toBe(8)
    })

    test('removes padding from retained-byte accounting on rollback', () => {
        const database = new DictionaryDatabase()
        const {staged, metas: [meta]} = publish(database, sharedSource(7, 8), [0], [8])
        expect(Reflect.get(database, '_recentTermContentSourceBatchBytes')).toBe(15)
        Reflect.get(database, '_rollbackStagedArtifactTermContentMetadata').call(database, staged)
        expect(find(database, meta)).toBeUndefined()
        expect(Reflect.get(database, '_recentTermContentSourceBatches').size).toBe(0)
        expect(Reflect.get(database, '_recentTermContentSourceBatchBytes')).toBe(0)
    })

    test('resets padded allocations and old mappings when batch IDs wrap', () => {
        const database = new DictionaryDatabase()
        const {metas: [first]} = publish(database, sharedSource(7, 8), [0], [8])
        Reflect.set(database, '_nextRecentTermContentSourceBatchId', 0x100000000)
        const {metas: [second]} = publish(database, sharedSource(3, 8), [0], [8], 2)
        expect(find(database, first)).toBeUndefined()
        expect(find(database, second)?.buffer.byteOffset).toBe(3)
        expect(Reflect.get(database, '_recentTermContentSourceBatches').size).toBe(1)
        expect(Reflect.get(database, '_recentTermContentSourceBatchBytes')).toBe(11)
        expect(Reflect.get(database, '_nextRecentTermContentSourceBatchId')).toBe(2)
    })
})
