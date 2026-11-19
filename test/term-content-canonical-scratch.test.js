/*
 * Copyright (C) 2023-2025  Yomitan Authors
 * Copyright (C) 2016-2022  Yomichan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {afterEach, expect, test, vi} from 'vitest'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'
import {NativeCanonicalScanner} from '../ext/js/dictionary/term-content-canonical-scan.js'
import {CANONICAL_SCAN_LAYOUT as layout} from '../ext/js/dictionary/term-content-canonical-layout.js'

const module = await WebAssembly.compile(await readFile(new URL('../ext/lib/term-content-canonical-scan-v1.wasm', import.meta.url)))

/**
 * @param {number} count
 * @param {import('../ext/js/dictionary/term-content-canonical-scan.js').ScanHooks} [hooks]
 * @returns {{db: DictionaryDatabase, chunk: import('../ext/js/dictionary/dictionary-database.js').ArtifactTermContentChunk, plan: import('../ext/js/dictionary/dictionary-database.js').ArtifactTermContentDedupPlan, scanner: NativeCanonicalScanner}}
 */
function fixture(count, hooks = {}) {
    const db = new DictionaryDatabase()
    const scanner = new NativeCanonicalScanner({loadModule: async () => module, hooks})
    db._nativeCanonicalScanner = scanner
    const bytes = new Uint8Array(count * 4)
    const meta = new Uint32Array(count * 4)
    const ids = Uint32Array.from({length: count}, (_, i) => i)
    for (let i = 0; i < count; ++i) {
        bytes.set([i & 255, (i >>> 8) & 255, 7, 9], i * 4)
        meta.set([i * 4, 4, i + 1, (i ^ 0x9e3779b9) >>> 0], i * 4)
    }
    const plan = {
        uniqueCount: count,
        sourceRowCount: count,
        uniqueRowIndexes: new Uint32Array(ids),
        uniqueSignatures: new Uint32Array(count * 3),
        resolvedFlags: new Uint8Array(count),
        resolvedOffsets: new Float64Array(count),
        resolvedLengths: new Uint32Array(count),
        resolvedDictNames: null,
        pendingEpochs: new Uint32Array(count).fill(87),
        pendingIndexes: new Uint32Array(count).fill(91),
        nextEpoch: 1,
        persistedLookupRequired: true,
    }
    const chunk = {
        rowCount: count,
        contentRowStart: 0,
        contentBytesList: [],
        contentHash1List: new Uint32Array(0),
        contentHash2List: new Uint32Array(0),
        contentBytesBuffer: bytes,
        contentBytesBaseOffset: 0,
        contentMetaList: meta,
        contentUniqueIndexList: ids,
        contentDedupPlan: plan,
        contentDictNameList: null,
        uniformContentDictName: 'raw',
        useResolvedContentReferences: true,
    }
    return {db, chunk, plan, scanner}
}

afterEach(() => { vi.restoreAllMocks() })

test.each(['success', 'native-trap', 'adoption-failure'])('canonical %s leaves generic epoch/index scratch untouched', async (fault) => {
    const {db, chunk, plan, scanner} = fixture(128, {
        trapAfter: fault === 'native-trap' ? 3 : 0,
        afterPlanWrite() {
            if (fault === 'adoption-failure') { throw new Error('adoption fault') }
        },
    })
    const scratchOperations = [plan.pendingEpochs, plan.pendingIndexes].flatMap((column) => [
        vi.spyOn(column, 'slice'),
        vi.spyOn(column, 'set'),
    ])
    if (fault === 'success') {
        const result = await db._resolveArtifactTermContentDedup(chunk, true)
        expect(result.pendingContentCount).toBe(128)
    } else {
        await expect(db._resolveArtifactTermContentDedup(chunk, true)).rejects.toThrow()
        expect(db._termEntryContentMetaDenseCount).toBe(0)
        expect(db._termEntryContentMetaHashPairPendingCount).toBe(0)
        expect(scanner.stats.synchronousRollbacks).toBe(1)
    }
    for (const operation of scratchOperations) { expect(operation).not.toHaveBeenCalled() }
    expect([...plan.pendingEpochs]).toEqual(new Array(128).fill(87))
    expect([...plan.pendingIndexes]).toEqual(new Array(128).fill(91))
    expect(scanner.stats.snapshotBytes).toBe(0)
    expect(scanner.stats.adoptedPlanBytes).toBe(0)
})

test('several exact-comparison waves do not snapshot unprocessed generic scratch', async () => {
    const count = 8200
    const {db, chunk, plan, scanner} = fixture(count)
    const bytes = /** @type {Uint8Array} */ (chunk.contentBytesBuffer)
    for (let i = 0; i < count; ++i) {
        db._setTermEntryContentMetaByHashPair(i + 1, (i ^ 0x9e3779b9) >>> 0, {
            id: i,
            offset: 100 + i * 4,
            length: 4,
            dictName: 'raw',
        })
    }
    vi.spyOn(db, '_readTermEntryContentBytesDetailed').mockImplementation(async (offset) => ({
        status: 'ok',
        bytes: bytes.subarray(offset - 100, offset - 96),
    }))
    const result = await db._resolveArtifactTermContentDedup(chunk, true)
    expect(result.persistedHitCount).toBe(count)
    expect(result.pendingContentCount).toBe(0)
    expect(scanner.stats.calls).toBe(3)
    expect(scanner.stats.snapshotBytes).toBe(0)
    expect(scanner.stats.adoptedPlanBytes).toBe(0)
    expect([...plan.pendingEpochs]).toEqual(new Array(count).fill(87))
    expect([...plan.pendingIndexes]).toEqual(new Array(count).fill(91))
})

test.each(['pendingEpochs', 'pendingIndexes'])('generic %s aliasing the native arena uses the portable path', async (column) => {
    const {db, chunk, plan, scanner} = fixture(8)
    db._ensureTermEntryContentMetaHashPairCapacity(8)
    const arena = db._termContentMetadataArena
    if (arena === null) { throw new Error('Missing metadata arena') }
    const key = /** @type {'pendingEpochs'|'pendingIndexes'} */ (column)
    plan[key] = new Uint32Array(arena.memory.buffer, key === 'pendingEpochs' ? layout.EPOCHS : layout.INDEXES, 8).fill(123)
    const result = await db._resolveArtifactTermContentDedup(chunk, true)
    expect(result.pendingContentCount).toBe(8)
    expect(scanner.stats.calls).toBe(0)
    expect(scanner.stats.fallbackEligibility).toBe(1)
    expect([...plan[key]]).toEqual(new Array(8).fill(123))
})
