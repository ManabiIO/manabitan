/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test, vi} from 'vitest'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'

const MIB = 1024 * 1024

/**
 * @param {DictionaryDatabase} database
 * @param {Uint8Array} source
 * @param {number[]} offsets
 * @param {number[]} lengths
 * @param {number} [firstHash]
 */
function publish(database, source, offsets, lengths, firstHash = 1) {
    const indexes = new Int32Array(offsets.length)
    const metas = offsets.map((_, i) => {
        const hash = firstHash + i
        database._setTermEntryContentMetaByHashPair(hash, hash, {id: hash, offset: hash, length: lengths[i], dictName: 'raw'})
        indexes[i] = database._findTermEntryContentMetaHashPairIndex(hash, hash)
        const meta = database._getTermEntryContentMetaByHashPair(hash, hash)
        if (typeof meta === 'undefined') { throw new Error('Missing published metadata') }
        return meta
    })
    const bytes = database._cacheRecentPublishedTermContentSources(
        {indexes, active: false},
        {buffer: source, offsets: new Uint32Array(offsets), lengths: new Uint32Array(lengths)},
    )
    return {bytes, metas}
}

describe('bounded recent content tail admission', () => {
    test.each([false, true])('owns only complete tail entries, including unordered offsets; shared=%s', (shared) => {
        const size = 12 * MIB + 31
        const backing = shared ? new SharedArrayBuffer(size + 97) : new ArrayBuffer(size + 97)
        const source = new Uint8Array(backing, 67, size)
        source.fill(19)
        const database = new DictionaryDatabase()
        const {bytes, metas} = publish(database, source, [0, size - 20, size - 100, size - 8 * MIB - 7], [64, 20, 10, 10])
        expect(bytes).toBe(100)
        expect(database._findRecentTermContentSource(metas[0])).toBeUndefined()
        expect(database._findRecentTermContentSource(metas[3])).toBeUndefined()
        source.fill(255)
        for (const index of [1, 2]) {
            const recent = database._findRecentTermContentSource(metas[index])
            if (typeof recent === 'undefined') { throw new Error('Missing admitted tail entry') }
            expect(recent.buffer.byteLength).toBe(100)
            expect(Array.from(recent.buffer.subarray(recent.offset, recent.offset + recent.length))).toEqual(Array(recent.length).fill(19))
        }
        expect(database._recentTermContentSourceBatchBytes).toBe(100)
    })

    test('includes an entry exactly at the eight MiB boundary', () => {
        const database = new DictionaryDatabase()
        const source = new Uint8Array(9 * MIB)
        const {bytes, metas} = publish(database, source, [0, MIB], [MIB, 8 * MIB])
        expect(bytes).toBe(8 * MIB)
        expect(database._findRecentTermContentSource(metas[0])).toBeUndefined()
        expect(database._findRecentTermContentSource(metas[1])?.length).toBe(8 * MIB)
    })

    test('does not copy a partial oversized entry or a zero-length suffix', () => {
        const database = new DictionaryDatabase()
        const source = new Uint8Array(9 * MIB)
        const copy = vi.spyOn(source, 'slice')
        expect(publish(database, source, [0], [source.length]).bytes).toBe(0)
        expect(publish(database, source, [0, source.length], [source.length, 0], 100).bytes).toBe(0)
        expect(copy).not.toHaveBeenCalled()
        expect(database._recentTermContentSourceBatches.size).toBe(0)
    })

    test('serves an uncached earlier entry through the unchanged exact storage path', async () => {
        const database = new DictionaryDatabase()
        const source = new Uint8Array(9 * MIB)
        source.fill(19)
        const {metas} = publish(database, source, [0, source.length - 64], [64, 64])
        const expected = Uint8Array.from(source.subarray(0, 64))
        const readStorage = vi.fn(async () => [{status: 'ok', bytes: expected}])
        Reflect.set(database, '_readTermEntryContentBytesDetailedBatch', readStorage)
        const [result] = await database._findMatchingPersistedTermEntryContentMetaBatch([
            {hash1: 1, hash2: 1, contentBytes: expected, primary: metas[0]},
        ])
        expect(result).toEqual({existingMeta: metas[0], exactFallback: true})
        expect(readStorage).toHaveBeenCalledOnce()
    })

    test('does not equate different uncached bytes with matching hashes', async () => {
        const database = new DictionaryDatabase()
        const source = new Uint8Array(9 * MIB)
        source.fill(19)
        const {metas} = publish(database, source, [0, source.length - 64], [64, 64])
        Reflect.set(database, '_readTermEntryContentBytesDetailedBatch', vi.fn(async () => [{status: 'ok', bytes: new Uint8Array(64).fill(19)}]))
        const [result] = await database._findMatchingPersistedTermEntryContentMetaBatch([
            {hash1: 1, hash2: 1, contentBytes: new Uint8Array(64).fill(20), primary: metas[0]},
        ])
        expect(result.existingMeta).toBeUndefined()
    })

    test('keeps the total cache bounded and expires old batch mappings', () => {
        const database = new DictionaryDatabase()
        const source = new Uint8Array(9 * MIB)
        const first = publish(database, source, [0, MIB], [MIB, 8 * MIB])
        for (let i = 1; i < 7; ++i) {
            publish(database, source, [0, MIB], [MIB, 8 * MIB], 10 * i)
        }
        expect(database._recentTermContentSourceBatchBytes).toBe(48 * MIB)
        expect(database._recentTermContentSourceBatches.size).toBe(6)
        expect(database._findRecentTermContentSource(first.metas[1])).toBeUndefined()
    })
})
