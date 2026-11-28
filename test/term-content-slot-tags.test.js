/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {beforeAll, describe, expect, test} from 'vitest'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'
import {CANONICAL_SCAN_LAYOUT as layout} from '../ext/js/dictionary/term-content-canonical-layout.js'
import {NativeCanonicalScanner} from '../ext/js/dictionary/term-content-canonical-scan.js'
import {TermContentMetadataArena} from '../ext/js/dictionary/term-content-metadata-arena.js'

/** @type {WebAssembly.Module} */
let module
/** @type {Uint8Array} */
let wasmBytes
beforeAll(async () => {
    wasmBytes = new Uint8Array(await readFile(new URL('../ext/lib/term-content-canonical-scan-v1.wasm', import.meta.url)))
    module = await WebAssembly.compile(wasmBytes)
})

/**
 * @param {number} first
 * @param {number} second
 * @returns {number}
 */
function mixedHash(first, second) {
    const value = (first ^ Math.imul(second, 0x9e3779b1)) >>> 0
    return (value ^ (value >>> 16)) >>> 0
}

/**
 * @param {number} hash
 * @returns {[number, number]}
 */
function pairForHash(hash) {
    return [(hash ^ (hash >>> 16)) >>> 0, 0]
}

/** @returns {Array<[number, number]>} */
function collisionPairs() {
    const first = 0x12345678
    return [[first, 0], [(first ^ 0x9e3779b1) >>> 0, 1], pairForHash(mixedHash(first, 0) ^ 0x80000000)]
}

/**
 * @param {DictionaryDatabase} db
 * @returns {TermContentMetadataArena}
 */
function arenaFor(db) {
    const arena = Reflect.get(db, '_termContentMetadataArena')
    if (!(arena instanceof TermContentMetadataArena)) { throw new Error('Missing metadata arena') }
    return arena
}

/**
 * @param {DictionaryDatabase} db
 * @param {string} name
 * @param {...unknown} args
 * @returns {import('core').SafeAny}
 */
function call(db, name, ...args) {
    return Reflect.get(db, name).apply(db, args)
}

/**
 * @param {TermContentMetadataArena} arena
 * @returns {number[]}
 */
function checkSlots(arena) {
    const indexes = []
    for (const word of arena.slots) {
        if (word === 0) { continue }
        const index = (word & arena.slotIndexMask) - 1
        expect(index).toBeGreaterThanOrEqual(0)
        expect(index).toBeLessThan(arena.state.length)
        expect(word & ~arena.slotIndexMask).toBe(mixedHash(arena.hash1[index], arena.hash2[index]) & ~arena.slotIndexMask)
        indexes.push(index)
    }
    return indexes.sort((a, b) => a - b)
}

/**
 * Direct ABI fixture with the original source/identity/metadata validation.
 * @param {Array<[number, number]>} pairs
 * @returns {{arena: TermContentMetadataArena, scan: (...args: number[]) => number, config: Uint32Array, header: Uint32Array}}
 */
function nativeFixture(pairs) {
    const arena = new TermContentMetadataArena(16, 64)
    const exports = new WebAssembly.Instance(module, {env: {memory: arena.memory}}).exports
    const scan = /** @type {(...args: number[]) => number} */ (exports.scan_canonical)
    const config = new Uint32Array(arena.memory.buffer, 1088, 22)
    config.set([
        arena.slots.byteOffset,
        arena.slots.length,
        arena.hash1.byteOffset,
        arena.hash2.byteOffset,
        arena.state.byteOffset,
        arena.length.byteOffset,
        arena.signaturePresent.byteOffset,
        arena.signature1.byteOffset,
        arena.signature2.byteOffset,
        arena.signature3.byteOffset,
        arena.state.length,
        0,
        pairs.length,
        0,
        pairs.length,
        0,
        0,
        0,
        pairs.length * 4,
        1,
        1,
        0,
    ])
    const metadata = new Uint32Array(arena.memory.buffer, layout.META, pairs.length * 4)
    const identities = new Uint32Array(arena.memory.buffer, layout.IDENT, pairs.length)
    const rows = new Uint32Array(arena.memory.buffer, layout.ROWS, pairs.length)
    for (const [i, pair] of pairs.entries()) {
        metadata.set([i * 4, 4, ...pair], i * 4)
        identities[i] = rows[i] = i
    }
    return {arena, scan, config, header: new Uint32Array(arena.memory.buffer, 1024, 7)}
}

/**
 * @param {Array<[number, number]>} pairs
 * @param {WebAssembly.Module|null} [scannerModule]
 * @returns {{db: DictionaryDatabase, scanner: NativeCanonicalScanner, chunk: import('../ext/js/dictionary/dictionary-database.js').ArtifactTermContentChunk}}
 */
function databaseFixture(pairs, scannerModule = module) {
    const db = new DictionaryDatabase()
    const scanner = new NativeCanonicalScanner({loadModule: async () => {
        if (scannerModule === null) { throw new Error('JavaScript oracle') }
        return scannerModule
    }})
    Reflect.set(db, '_nativeCanonicalScanner', scanner)
    const count = pairs.length
    const ids = Uint32Array.from({length: count}, (_, i) => i)
    const bytes = Uint8Array.from({length: count * 4}, (_, i) => i & 255)
    const metadata = new Uint32Array(count * 4)
    for (const [i, pair] of pairs.entries()) { metadata.set([i * 4, 4, ...pair], i * 4) }
    const plan = {
        uniqueCount: count,
        sourceRowCount: count,
        uniqueRowIndexes: new Uint32Array(ids),
        uniqueSignatures: new Uint32Array(count * 3),
        resolvedFlags: new Uint8Array(count),
        resolvedOffsets: new Float64Array(count),
        resolvedLengths: new Uint32Array(count),
        resolvedDictNames: new Array(count),
        pendingEpochs: new Uint32Array(count),
        pendingIndexes: new Uint32Array(count),
        nextEpoch: 1,
        persistedLookupRequired: true,
    }
    return {db,
        scanner,
        chunk: {
            rowCount: count,
            contentRowStart: 0,
            contentBytesList: [],
            contentHash1List: [],
            contentHash2List: [],
            contentBytesBuffer: bytes,
            contentBytesBaseOffset: 0,
            contentMetaList: metadata,
            contentUniqueIndexList: ids,
            contentDedupPlan: plan,
            contentDictNameList: null,
            uniformContentDictName: 'raw',
            useResolvedContentReferences: true,
        }}
}

describe('packed canonical metadata slots', () => {
    test('keeps the index mask fixed for one generation, including its last dense ID', () => {
        const arena = new TermContentMetadataArena(16, 64)
        expect(arena.slotIndexMask).toBe(31)
        expect((16 & arena.slotIndexMask) - 1).toBe(15)
        expect(Reflect.set(arena, 'slotIndexMask', 15)).toBe(false)
        expect(Object.getOwnPropertyDescriptor(arena, 'slotIndexMask')).toMatchObject({writable: false, configurable: false})
        expect(() => Object.defineProperty(arena, 'slotIndexMask', {value: 15})).toThrow(TypeError)
        expect(arena.slotIndexMask).toBe(31)
    })

    test('does not copy packed slots across a mask change at identical slot capacity', () => {
        const previous = new TermContentMetadataArena(17, 64)
        const sameMask = new TermContentMetadataArena(31, 64)
        const changedMask = new TermContentMetadataArena(32, 64)
        previous.slots[7] = 0xa8000011
        previous.hash1[16] = 0x12345678
        sameMask.copyFrom(previous)
        changedMask.copyFrom(previous)
        expect(sameMask.slots).toEqual(previous.slots)
        expect(changedMask.slots.every((word) => word === 0)).toBe(true)
        expect(changedMask.hash1[16]).toBe(previous.hash1[16])
    })

    test.each(['omitted', 'zero'])('preserves untagged native slot ABI for %s argument', (mode) => {
        const {arena, scan, header} = nativeFixture(collisionPairs())
        expect(mode === 'omitted' ? scan() : scan(0)).toBe(0)
        expect(header[0]).toBe(3)
        expect([...arena.slots].filter((word) => word !== 0).sort((a, b) => a - b)).toEqual([1, 2, 3])
    })

    test('uses both full hashes after a tag collision and keeps different-tag bucket collisions', () => {
        const pairs = collisionPairs()
        const hashes = pairs.map(([first, second]) => mixedHash(first, second))
        expect(hashes[0]).toBe(hashes[1])
        expect(hashes[2]).not.toBe(hashes[0])
        expect(hashes.map((hash) => hash & 63)).toEqual([hashes[0] & 63, hashes[0] & 63, hashes[0] & 63])
        const {arena, scan, header} = nativeFixture(pairs)
        expect(scan(arena.slotIndexMask)).toBe(0)
        expect(header[0]).toBe(3)
        expect(header[3]).toBe(0)
        expect(checkSlots(arena)).toEqual([0, 1, 2])
        expect(arena.slots.some((word) => word > arena.slotIndexMask)).toBe(true)
    })

    test.each([14, 15])('rejects invalid or undersized mask %i before insertion', (mask) => {
        const {arena, scan, header} = nativeFixture(collisionPairs())
        expect(scan(mask)).toBe(-1)
        expect(header[0]).toBe(0)
        expect(arena.slots.every((word) => word === 0)).toBe(true)
    })

    test.each([0, 17])('checks malformed low index %i before a mismatching tag can skip it', (index) => {
        const {arena, scan, header} = nativeFixture([[1, 0]])
        arena.slots[1] = 0x80000000 | index
        expect(scan(arena.slotIndexMask)).toBe(-4)
        expect(header[0]).toBe(0)
        expect(arena.slots[1]).toBe((0x80000000 | index) >>> 0)
    })

    test('preserves probe exhaustion through a chain of tag rejections', () => {
        const {arena, scan, header} = nativeFixture([[1, 0]])
        arena.slots.fill(0x80000001)
        expect(scan(arena.slotIndexMask)).toBe(-4)
        expect(header[0]).toBe(0)
    })

    test('rehashes on a dense-mask boundary without changing slot capacity', () => {
        const db = new DictionaryDatabase()
        call(db, '_resizeTermContentMetadataArena', 16, 256)
        const pairs = Array.from({length: 17}, (_, i) => pairForHash((0x8abcde20 + i * 64) >>> 0))
        for (let i = 0; i < 16; ++i) {
            call(db, '_setTermEntryContentMetaByHashPair', ...pairs[i], {id: i, offset: 100 + i, length: 4, dictName: 'raw'})
        }
        const previous = arenaFor(db)
        const oldSlots = new Uint32Array(previous.slots)
        expect(previous.slotIndexMask).toBe(31)
        call(db, '_setTermEntryContentMetaByHashPair', ...pairs[16], {id: 16, offset: 116, length: 4, dictName: 'raw'})
        const current = arenaFor(db)
        expect(current.slotIndexMask).toBe(63)
        expect(current.slots.length).toBe(previous.slots.length)
        expect(previous.slots).toEqual(oldSlots)
        expect(checkSlots(current)).toEqual(Array.from({length: 17}, (_, i) => i))
        for (const [i, pair] of pairs.entries()) {
            expect(call(db, '_getTermEntryContentMetaByHashPair', ...pair)).toMatchObject({id: i, offset: 100 + i, tableIndex: i})
        }
    })

    test('decodes sparse slot traversal with the old mask before repacking reused high IDs', () => {
        const db = new DictionaryDatabase()
        const values = Array.from({length: 70}, (_, i) => (0x80000100 + i * 64) >>> 0)
        const staged = call(db, '_stageArtifactTermContentMetadata', values, values, values.map(() => Uint8Array.of(1, 2, 3, 4)), null)
        call(db, '_rollbackStagedArtifactTermContentMetadata', staged)
        const pair = pairForHash(0xabcde100)
        call(db, '_setTermEntryContentMetaByHashPair', ...pair, {id: 99, offset: 999, length: 4, dictName: 'raw'})
        const previous = arenaFor(db)
        expect(Reflect.get(db, '_termEntryContentMetaDenseCount')).toBeGreaterThan(previous.slots.length)
        const index = call(db, '_findTermEntryContentMetaHashPairIndex', ...pair)
        expect(index).toBeGreaterThan(previous.slots.length)
        call(db, '_ensureTermEntryContentMetaHashPairCapacity', 128)
        expect(arenaFor(db).slotIndexMask).not.toBe(previous.slotIndexMask)
        expect(checkSlots(arenaFor(db))).toEqual([index])
        expect(call(db, '_getTermEntryContentMetaByHashPair', ...pair)).toMatchObject({id: 99, offset: 999, tableIndex: index})
    })

    test.each([false, true])('JavaScript and native reservations preserve tag-colliding entries, native=%s', async (native) => {
        const {db, scanner, chunk} = databaseFixture(collisionPairs(), native ? module : null)
        const result = await call(db, '_resolveArtifactTermContentDedup', chunk, true)
        expect(result.pendingContentCount).toBe(3)
        expect(checkSlots(arenaFor(db))).toEqual([0, 1, 2])
        expect(scanner.stats.calls).toBe(native ? 1 : 0)
        expect(Reflect.get(db, '_termEntryContentMetaHashPairPendingCount')).toBe(3)
        call(db, '_rollbackStagedArtifactTermContentMetadata', result.stagedContentMetadata)
        expect(arenaFor(db).slots.every((word) => word === 0)).toBe(true)
    })

    test('falls back to packed-aware JavaScript before calling an otherwise-valid module without tag capability', async () => {
        // Keep every existing ABI export and the real scan body, but remove the
        // new capability name without changing any section length or function.
        const older = new Uint8Array(wasmBytes)
        const encoded = Buffer.from(older.buffer)
        const offset = encoded.indexOf('canonical_slot_tag_version')
        expect(offset).toBeGreaterThan(0)
        expect(encoded.lastIndexOf('canonical_slot_tag_version')).toBe(offset)
        older[offset] = 0x78
        const oldModule = await WebAssembly.compile(older)
        const {db, scanner, chunk} = databaseFixture(collisionPairs(), oldModule)
        const result = await call(db, '_resolveArtifactTermContentDedup', chunk, true)
        expect(scanner.stats.calls).toBe(0)
        expect(scanner.stats.inserted).toBe(0)
        expect(scanner.stats.fallbackUnsupported).toBe(1)
        expect(result.pendingContentCount).toBe(3)
        expect(Array.isArray(result.pendingPlanUniqueIndexes)).toBe(true)
        expect(checkSlots(arenaFor(db))).toEqual([0, 1, 2])
    })
})
