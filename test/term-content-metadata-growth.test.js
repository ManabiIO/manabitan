/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test, vi} from 'vitest'
import fs from 'node:fs/promises'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'
import {NativeCanonicalScanner} from '../ext/js/dictionary/term-content-canonical-scan.js'
import {TermContentMetadataArena} from '../ext/js/dictionary/term-content-metadata-arena.js'

const canonicalModule = await WebAssembly.compile(await fs.readFile(new URL('../ext/lib/term-content-canonical-scan-v1.wasm', import.meta.url)))

const arenaColumnNames = /** @type {const} */ ([
    'hash1',
    'hash2',
    'state',
    'length',
    'signaturePresent',
    'signature1',
    'signature2',
    'signature3',
])
const databaseColumnNames = /** @type {const} */ ([
    '_termEntryContentMetaHash1Table',
    '_termEntryContentMetaHash2Table',
    '_termEntryContentMetaStateTable',
    '_termEntryContentMetaLengthTable',
    '_termEntryContentMetaSignaturePresentTable',
    '_termEntryContentMetaSignature1Table',
    '_termEntryContentMetaSignature2Table',
    '_termEntryContentMetaSignature3Table',
    '_termEntryContentMetaIdTable',
    '_termEntryContentMetaOffsetTable',
    '_termEntryContentMetaDictNameIdTable',
    '_termEntryContentMetaRecentSourceBatchIdTable',
    '_termEntryContentMetaRecentSourceOffsetTable',
])

/**
 * @param {DictionaryDatabase} database
 * @returns {TermContentMetadataArena}
 */
function getArena(database) {
    const arena = Reflect.get(database, '_termContentMetadataArena')
    if (arena === null) { throw new Error('Expected allocated metadata') }
    return arena
}

/** @returns {DictionaryDatabase} */
function createSparseDatabase() {
    const database = new DictionaryDatabase()
    // Every entry shares one probe chain; growth and rollback must retain it.
    vi.spyOn(database, '_getTermEntryContentMetaHashPairSlot').mockReturnValue(5)
    const set = Reflect.get(database, '_setTermEntryContentMetaByHashPair').bind(database)
    for (let i = 0; i < 5; ++i) {
        const metadata = {
            id: i + 1,
            offset: 100 + i * 10,
            length: i + 1,
            dictName: `source-${i}`,
            signature1: 1000 + i,
            signature2: 2000 + i,
            signature3: 3000 + i,
        }
        set(10 + i, 20 + i, metadata)
    }
    Reflect.get(database, '_stageArtifactTermContentMetadata').call(database, [50, 60], [70, 80], [Uint8Array.of(1, 2), Uint8Array.of(3, 4)], null)
    Reflect.get(database, '_rollbackStagedArtifactTermContentMetadata').call(database, {
        indexes: new Int32Array([2]),
        active: true,
    })
    expect(Reflect.get(database, '_termEntryContentMetaDenseCount')).toBe(7)
    expect(Reflect.get(database, '_termEntryContentMetaHashPairCount')).toBe(4)
    expect(Reflect.get(database, '_termEntryContentMetaHashPairPendingCount')).toBe(2)
    expect(Reflect.get(database, '_termEntryContentMetaFreeIndexes')).toEqual([2])
    Reflect.get(database, '_termEntryContentMetaRecentSourceBatchIdTable')[4] = 99
    Reflect.get(database, '_termEntryContentMetaRecentSourceOffsetTable')[4] = 123
    return database
}

describe('bounded metadata arena copies', () => {
    test('keeps the complete-column and same-capacity slot-copy defaults', () => {
        const previous = new TermContentMetadataArena(17, 64)
        const next = new TermContentMetadataArena(32, 64)
        for (const [i, name] of arenaColumnNames.entries()) { previous[name].fill(i + 1) }
        previous.slots[63] = 17

        next.copyFrom(previous)

        for (const name of arenaColumnNames) {
            expect(next[name].subarray(0, 17)).toEqual(previous[name])
            expect([...next[name].subarray(17)]).toEqual(new Array(15).fill(0))
        }
        expect(next.slots).toEqual(previous.slots)
    })

    test.each([0, 3, 17])('copies exactly the allocated dense prefix of %s IDs and leaves slots to the caller', (denseCount) => {
        const previous = new TermContentMetadataArena(17, 64)
        const next = new TermContentMetadataArena(32, 64)
        for (const [i, name] of arenaColumnNames.entries()) { previous[name].fill(i + 1) }
        previous.slots.fill(17)
        next.slots[0] = 9

        next.copyFrom(previous, denseCount, false)

        for (const name of arenaColumnNames) {
            expect(next[name].subarray(0, denseCount)).toEqual(previous[name].subarray(0, denseCount))
            expect([...next[name].subarray(denseCount)]).toEqual(new Array(32 - denseCount).fill(0))
        }
        expect([...next.slots]).toEqual([9, ...new Array(63).fill(0)])
    })

    test.each([-1, 0.5, Number.NaN, Infinity, 18])('rejects invalid prefix %s before any destination write', (denseCount) => {
        const previous = new TermContentMetadataArena(17, 64)
        const next = new TermContentMetadataArena(32, 64)
        previous.hash1.fill(7)
        previous.slots[0] = 1
        next.hash1[0] = 99

        expect(() => next.copyFrom(previous, denseCount)).toThrow('Invalid term content metadata dense count')
        expect(next.hash1[0]).toBe(99)
        expect(next.state.every((state) => state === 0)).toBe(true)
        expect(next.slots.every((slot) => slot === 0)).toBe(true)
    })

    test('rejects a destination that cannot contain the requested prefix before copying any column', () => {
        const previous = new TermContentMetadataArena(17, 64)
        const next = new TermContentMetadataArena(16, 64)
        next.hash1[0] = 99

        expect(() => next.copyFrom(previous)).toThrow('Invalid term content metadata dense count')
        expect(next.hash1[0]).toBe(99)
        expect(next.slots.every((slot) => slot === 0)).toBe(true)
    })
})

describe('metadata growth with reusable dense IDs', () => {
    test.each(['dense', 'slots', 'same-capacity rehash'])('preserves sparse high IDs, pending entries and collision chains during %s replacement', (mode) => {
        const database = createSparseDatabase()
        const previous = getArena(database)
        const before = databaseColumnNames.map((name) => Reflect.get(database, name).slice(0, 7))
        const resize = Reflect.get(database, '_resizeTermContentMetadataArena').bind(database)

        resize(mode === 'dense' ? 33 : 7, mode === 'slots' ? 64 : previous.slots.length, mode === 'same-capacity rehash')

        const next = getArena(database)
        expect(next).not.toBe(previous)
        expect(previous.memory.buffer.byteLength).toBeGreaterThan(0)
        for (const [i, name] of databaseColumnNames.entries()) {
            expect(Reflect.get(database, name).subarray(0, 7)).toEqual(before[i])
        }
        expect(next.state[6]).toBe(previous.state[6])
        expect(next.state[6]).not.toBe(0)
        expect(next.state[2]).toBe(0)
        const get = Reflect.get(database, '_getTermEntryContentMetaByHashPair').bind(database)
        for (const i of [0, 1, 3, 4]) {
            expect(get(10 + i, 20 + i)).toMatchObject({id: i + 1, offset: 100 + i * 10, tableIndex: i})
        }
        expect(get(12, 22)).toBeUndefined()
        expect(get(50, 70)).toBeUndefined()
        expect(get(60, 80)).toBeUndefined()
        expect([...next.slots].filter((index) => index !== 0).sort((a, b) => a - b)).toEqual([1, 2, 4, 5, 6, 7])

        Reflect.get(database, '_setTermEntryContentMetaByHashPair').call(database, 90, 100, {
            id: 99, offset: 999, length: 4, dictName: 'reused',
        })
        expect(get(90, 100)).toMatchObject({id: 99, tableIndex: 2})
        expect(Reflect.get(database, '_termEntryContentMetaDenseCount')).toBe(7)
        expect(Reflect.get(database, '_termEntryContentMetaFreeIndexes')).toEqual([])
    })

    test('keeps all old columns and probe chains after a replacement copy fails', () => {
        const database = createSparseDatabase()
        const previous = getArena(database)
        const columns = databaseColumnNames.map((name) => Reflect.get(database, name))
        const values = columns.map((column) => column.slice(0, column.length))
        const oldSlots = new Uint32Array(previous.slots)
        const failure = new Error('injected metadata copy failure')
        const copy = TermContentMetadataArena.prototype.copyFrom
        /**
         * @this {TermContentMetadataArena}
         * @param {Parameters<TermContentMetadataArena['copyFrom']>} args
         */
        function failAfterCopy(...args) {
            copy.apply(this, args)
            throw failure
        }
        const fault = vi.spyOn(TermContentMetadataArena.prototype, 'copyFrom').mockImplementationOnce(failAfterCopy)
        try {
            expect(() => Reflect.get(database, '_ensureTermEntryContentMetaDenseCapacity').call(database, 33)).toThrow(failure)
        } finally {
            fault.mockRestore()
        }
        expect(getArena(database)).toBe(previous)
        expect(previous.slots).toEqual(oldSlots)
        for (const [i, name] of databaseColumnNames.entries()) {
            expect(Reflect.get(database, name)).toBe(columns[i])
            expect(columns[i]).toEqual(values[i])
        }
        expect(Reflect.get(database, '_termEntryContentMetaDenseCount')).toBe(7)
        expect(Reflect.get(database, '_termEntryContentMetaFreeIndexes')).toEqual([2])
        Reflect.get(database, '_ensureTermEntryContentMetaDenseCapacity').call(database, 33)
        expect(getArena(database)).not.toBe(previous)
        expect(getArena(database).state[6]).toBe(previous.state[6])
    })
})

describe('native replacement-slot rebuild', () => {
    /** @returns {NativeCanonicalScanner} */
    function loadedScanner() {
        const scanner = new NativeCanonicalScanner()
        Reflect.set(scanner, '_module', canonicalModule)
        return scanner
    }

    /**
     * @param {number} count
     * @returns {DictionaryDatabase}
     */
    function collisionDatabase(count) {
        const database = new DictionaryDatabase()
        if (count === 0) { Reflect.get(database, '_ensureTermEntryContentMetaHashPairCapacity').call(database, 1) }
        for (let i = 0; i < count; ++i) {
            const seed = i + 1
            Reflect.get(database, '_setTermEntryContentMetaByHashPair').call(database, (seed << 16) | (seed ^ 63), 0, {
                id: seed,
                offset: seed * 10,
                length: seed,
                dictName: 'native-rehash',
                signature1: seed,
                signature2: seed + 1,
                signature3: seed + 2,
            })
        }
        return database
    }

    test.each([0, 1, 31, 129])('matches complete JS slot layout and all metadata for %s colliding rows', (count) => {
        const js = collisionDatabase(count)
        const native = collisionDatabase(count)
        const scanner = loadedScanner()
        Reflect.set(native, '_nativeCanonicalScanner', scanner)
        const before = getArena(native)
        // eslint-disable-next-line unicorn/prefer-spread -- Preserve the owned Uint32Array type for exact slot comparisons.
        const oldSlots = before.slots.slice()
        // eslint-disable-next-line unicorn/prefer-spread -- Preserve each owned typed column's element type for exact comparisons.
        const previousColumns = arenaColumnNames.map((name) => before[name].slice())
        for (const database of [js, native]) {
            Reflect.get(database, '_resizeTermContentMetadataArena').call(database, count + 17, Math.max(32, before.slots.length * 2), true)
        }
        const actual = getArena(native)
        const expected = getArena(js)
        expect(actual.slots).toEqual(expected.slots)
        for (const name of databaseColumnNames) { expect(Reflect.get(native, name)).toEqual(Reflect.get(js, name)) }
        expect(before.slots).toEqual(oldSlots)
        for (const [i, name] of arenaColumnNames.entries()) { expect(before[name]).toEqual(previousColumns[i]) }
        expect(scanner.stats.instances).toBe(count === 0 ? 0 : 1)
    })

    test('retains holes, pending states and high IDs in the dense branch', () => {
        const previous = new TermContentMetadataArena(32, 64)
        for (let i = 0; i < 32; ++i) {
            previous.hash1[i] = (i << 16) | (i ^ 63)
            previous.hash2[i] = 0
            previous.state[i] = i % 3 === 0 ? 0 : i % 2 + 1
        }
        const next = new TermContentMetadataArena(64, 128)
        next.copyFrom(previous, 32, false)
        expect(loadedScanner().rehash(next, 32, previous.slots.length)).toBe(true)
        const expected = new Uint32Array(128)
        for (let i = 0; i < 32; ++i) {
            if (previous.state[i] === 0) { continue }
            let slot = 63
            while (expected[slot] !== 0) { slot = (slot + 1) & 127 }
            expected[slot] = i + 1
        }
        expect(next.slots).toEqual(expected)
        for (const name of arenaColumnNames) { expect(next[name].subarray(0, 32)).toEqual(previous[name]) }
    })

    test('keeps a synchronous cold fallback without loading a module', () => {
        const loadModule = vi.fn(async () => canonicalModule)
        const scanner = new NativeCanonicalScanner({loadModule})
        const arena = new TermContentMetadataArena(16, 32)
        arena.state[0] = 1
        arena.hash1[0] = 99
        expect(scanner.rehash(arena, 1, 16)).toBe(false)
        expect(loadModule).not.toHaveBeenCalled()
        expect(arena.slots.every((value) => value === 0)).toBe(true)
    })

    test('retains sparse old-slot order without constructing a native instance', () => {
        const scanner = loadedScanner()
        const arena = new TermContentMetadataArena(32, 32)
        arena.state[31] = 2
        const instance = vi.spyOn(scanner, '_getInstance')
        expect(scanner.rehash(arena, 32, 16)).toBe(false)
        expect(instance).not.toHaveBeenCalled()
        expect(arena.slots.every((value) => value === 0)).toBe(true)
    })

    test('clears a partial native failure before the unchanged JS rebuild and publishes atomically', () => {
        const js = collisionDatabase(31)
        const native = collisionDatabase(31)
        const previous = getArena(native)
        // eslint-disable-next-line unicorn/prefer-spread -- Preserve the owned Uint32Array type for exact slot comparisons.
        const oldSlots = previous.slots.slice()
        const scanner = loadedScanner()
        Reflect.set(native, '_nativeCanonicalScanner', scanner)
        vi.spyOn(scanner, '_getInstance').mockImplementationOnce((arena) => ({
            module: canonicalModule,
            scan: () => 0,
            rehash: () => {
                expect(getArena(native)).toBe(previous)
                arena.slots[0] = 999
                arena.slots[127] = 998
                throw new WebAssembly.RuntimeError('injected partial rehash trap')
            },
        }))
        for (const database of [js, native]) {
            Reflect.get(database, '_resizeTermContentMetadataArena').call(database, 64, 128, true)
        }
        expect(getArena(native).slots).toEqual(getArena(js).slots)
        expect(previous.slots).toEqual(oldSlots)
        for (const name of databaseColumnNames) { expect(Reflect.get(native, name)).toEqual(Reflect.get(js, name)) }
    })

    test('clears partial native output after a bounded full-table error', () => {
        const arena = new TermContentMetadataArena(2, 1)
        arena.state.fill(1)
        expect(loadedScanner().rehash(arena, 2, 2)).toBe(false)
        expect([...arena.slots]).toEqual([0])
        expect([...arena.state]).toEqual([1, 1])
    })
})
