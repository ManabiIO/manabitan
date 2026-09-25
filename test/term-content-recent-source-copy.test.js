/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test, vi} from 'vitest'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'

/**
 * @param {Uint8Array} source
 * @param {number} start
 * @param {number} length
 * @returns {{database: DictionaryDatabase, owned: Uint8Array, offsets: Uint32Array, lengths: Uint32Array, indexes: Int32Array}}
 */
function publish(source, start, length) {
    const database = new DictionaryDatabase()
    const count = Math.ceil(length / 256)
    const offsets = Uint32Array.from({length: count}, (_, i) => start + i * 256)
    const lengths = Uint32Array.from({length: count}, (_, i) => Math.min(256, length - i * 256))
    const hashes1 = Array.from({length: count}, (_, i) => i + 1)
    const hashes2 = Array.from({length: count}, (_, i) => i + 1000)
    const spans = {buffer: source, offsets, lengths}
    const staged = database._stageArtifactTermContentMetadata(hashes1, hashes2, [], spans)
    database._publishArtifactTermContentMetadata({
        count,
        contentOffsets: new Float64Array(count),
        contentLengths: new Uint32Array(count),
        pendingRowToUniqueIndex: Int32Array.from({length: count}, (_, i) => i),
        pendingContentBytes: [],
        pendingContentHash1s: hashes1,
        pendingContentHash2s: hashes2,
        pendingOffsets: Array.from({length: count}, (_, i) => 100 + i * 20),
        pendingLengths: [...lengths],
        pendingResolvedDictNames: 'raw-block-v2',
        resolvedContentDictNames: 'raw-block-v2',
        pendingContentSpans: spans,
        stagedContentMetadata: staged,
    })
    const owned = database._recentTermContentSourceBatches.values().next().value
    if (!(owned instanceof Uint8Array)) { throw new Error('Expected a retained source batch') }
    return {database, owned, offsets, lengths, indexes: staged.indexes}
}

/**
 * @param {number} length
 * @param {number} viewOffset
 * @param {boolean} [shared=true]
 * @returns {Uint8Array}
 */
function sourceBytes(length, viewOffset, shared = true) {
    const buffer = shared ? new SharedArrayBuffer(length + viewOffset) : new ArrayBuffer(length + viewOffset)
    const source = new Uint8Array(buffer, viewOffset, length)
    for (let i = 0; i < length; ++i) { source[i] = (i * 131 + (i >>> 5)) & 255 }
    return source
}

describe('recent published source copy', () => {
    for (let alignment = 0; alignment < 8; ++alignment) {
        for (let tail = 0; tail < 8; ++tail) {
            test(`preserves bounded shared bytes and ownership at alignment ${alignment}, tail ${tail}`, () => {
                const length = (2 * 1024 * 1024) + tail
                const start = 9
                const viewOffset = (alignment + 8 - (start % 8)) % 8
                // The copied range ends at the physical end of the buffer.
                const source = sourceBytes(length + start, viewOffset)
                const expected = source.slice(start)
                const {database, owned, offsets, indexes} = publish(source, start, length)
                expect(Buffer.compare(owned, expected)).toBe(0)
                expect(owned.buffer).toBeInstanceOf(ArrayBuffer)
                expect(owned.buffer).not.toBe(source.buffer)
                expect(owned.buffer.byteLength).toBe(length)
                expect(database._recentTermContentSourceBatchBytes).toBe(length)
                for (let i = 0; i < indexes.length; ++i) {
                    expect(database._termEntryContentMetaRecentSourceOffsetTable[indexes[i]]).toBe(offsets[i] - start)
                }
                source.fill(0)
                expect(Buffer.compare(owned, expected)).toBe(0)
            })
        }
    }

    test('avoids the unaligned whole shared-byte slice for large retained ranges', () => {
        const source = sourceBytes(2 * 1024 * 1024, 1)
        const slice = vi.spyOn(source, 'slice')
        try {
            const {owned} = publish(source, 0, source.length)
            expect(Buffer.compare(owned, source)).toBe(0)
            expect(slice).not.toHaveBeenCalled()
        } finally { slice.mockRestore() }
    })

    for (const [length, shared, alignment] of [[1048576, true, 7], [2097151, true, 1], [2097152, false, 1], [2097152, true, 0]]) {
        test(`retains the existing copy for length=${length}, shared=${shared}, alignment=${alignment}`, () => {
            const source = sourceBytes(Number(length), Number(alignment), Boolean(shared))
            const slice = vi.spyOn(source, 'slice')
            try {
                const {owned} = publish(source, 0, source.length)
                expect(Buffer.compare(owned, source)).toBe(0)
                expect(slice).toHaveBeenCalledOnce()
            } finally { slice.mockRestore() }
        })
    }

    test('retains exact-dedupe bytes after shared memory growth and source reuse', async () => {
        const memory = new WebAssembly.Memory({initial: 33, maximum: 64, shared: true})
        const source = new Uint8Array(memory.buffer, 3, 2 * 1024 * 1024)
        source.fill(73)
        const {database, owned} = publish(source, 0, source.length)
        const expected = owned.slice(256, 512)
        const meta = database._getTermEntryContentMetaByHashPair(2, 1001)
        if (typeof meta === 'undefined') { throw new Error('Expected published metadata') }
        memory.grow(1)
        new Uint8Array(memory.buffer).fill(0)
        const read = vi.spyOn(database, '_readTermEntryContentBytesDetailedBatch')
        try {
            const [result] = await database._findMatchingPersistedTermEntryContentMetaBatch([
                {hash1: 2, hash2: 1001, contentBytes: expected, primary: meta},
            ])
            expect(result).toMatchObject({existingMeta: meta, recentSourceHit: true})
            expect(read).not.toHaveBeenCalled()
            expect(owned.every((value) => value === 73)).toBe(true)
        } finally { read.mockRestore() }
    })
})
