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

import {describe, expect, test} from 'vitest'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'

/**
 * @param {DictionaryDatabase} database
 * @param {Uint8Array} buffer
 * @param {number[]} offsets
 * @param {number[]} lengths
 */
function cacheSpans(database, buffer, offsets, lengths) {
    const indexes = new Int32Array(offsets.length)
    for (let i = 0; i < offsets.length; ++i) {
        database._setTermEntryContentMetaByHashPair(i, i + 1, {id: i, offset: 1000 + i, length: lengths[i], dictName: 'raw'})
        indexes[i] = database._findTermEntryContentMetaHashPairIndex(i, i + 1)
    }
    return database._cacheRecentPublishedTermContentSources(
        {indexes, active: false},
        {buffer, offsets: new Uint32Array(offsets), lengths: new Uint32Array(lengths)},
    )
}

describe('owned recent term-content copies', () => {
    test.each([false, true])('copies only the covered range with nonzero view and span offsets; shared=%s', (shared) => {
        const database = new DictionaryDatabase()
        const backing = shared ? new SharedArrayBuffer(256) : new ArrayBuffer(256)
        const source = new Uint8Array(backing, 29, 150)
        for (let i = 0; i < source.length; ++i) { source[i] = i }
        const offsets = [47, 9, 9, 85]
        const lengths = [11, 20, 0, 7]
        const expected = offsets.map((offset, i) => Array.from(source.subarray(offset, offset + lengths[i])))
        expect(cacheSpans(database, source, offsets, lengths)).toBe(92 - 9)
        expect(database._recentTermContentSourceBatchBytes).toBe(83)
        const owned = [...database._recentTermContentSourceBatches.values()][0]
        expect(owned.buffer).toBeInstanceOf(ArrayBuffer)
        expect(owned.buffer).not.toBe(backing)
        expect(owned.byteLength).toBe(83)
        source.fill(255)
        for (let i = 0; i < offsets.length; ++i) {
            const meta = database._getTermEntryContentMetaByHashPair(i, i + 1)
            expect(meta).toBeDefined()
            if (typeof meta === 'undefined') { throw new Error('Missing published metadata') }
            const recent = database._findRecentTermContentSource(meta)
            expect(recent).toBeDefined()
            if (typeof recent === 'undefined') { throw new Error('Missing recent bytes') }
            expect(Array.from(recent.buffer.subarray(recent.offset, recent.offset + recent.length))).toEqual(expected[i])
        }
        if (!shared) {
            structuredClone(backing, {transfer: [backing]})
            expect(source.byteLength).toBe(0)
            expect(owned.byteLength).toBe(83)
        }
    })

    test.each([false, true])('owns WASM source bytes across memory growth and reuse; shared=%s', (shared) => {
        const database = new DictionaryDatabase()
        const memory = new WebAssembly.Memory({initial: 1, maximum: 2, shared})
        const source = new Uint8Array(memory.buffer, 31, 100)
        source.fill(19)
        expect(cacheSpans(database, source, [1], [98])).toBe(98)
        memory.grow(1)
        new Uint8Array(memory.buffer).fill(255)
        const owned = [...database._recentTermContentSourceBatches.values()][0]
        expect(Array.from(owned)).toEqual(Array(98).fill(19))
        expect(owned.buffer).toBeInstanceOf(ArrayBuffer)
        expect(owned.buffer).not.toBe(memory.buffer)
    })

    test('does not allocate a snapshot for an empty span', () => {
        const database = new DictionaryDatabase()
        expect(cacheSpans(database, new Uint8Array(0), [0], [0])).toBe(0)
        expect(database._recentTermContentSourceBatches.size).toBe(0)
        expect(database._recentTermContentSourceBatchBytes).toBe(0)
    })

    test('preserves exact bytes for a multi-megabyte borrowed slab', () => {
        const database = new DictionaryDatabase()
        const source = new Uint8Array(new SharedArrayBuffer(2 * 1024 * 1024 + 67))
        for (let i = 0; i < source.length; ++i) { source[i] = (i * 19 + (i >>> 7)) & 255 }
        const expected = Buffer.from(source.subarray(31, source.length - 13))
        expect(cacheSpans(database, source, [31], [expected.length])).toBe(expected.length)
        source.fill(0)
        const owned = [...database._recentTermContentSourceBatches.values()][0]
        expect(Buffer.from(owned).equals(expected)).toBe(true)
    })
})
