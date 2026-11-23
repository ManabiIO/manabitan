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
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {beforeAll, describe, expect, test, vi} from 'vitest'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'
import {NativeCanonicalScanner} from '../ext/js/dictionary/term-content-canonical-scan.js'

/** @typedef {Parameters<DictionaryDatabase['_resolveArtifactTermContentDedup']>[0]} ArtifactChunk */
/** @typedef {NonNullable<ArtifactChunk['contentDedupPlan']>} ContentPlan */

/** @type {WebAssembly.Module} */
let canonicalModule

beforeAll(async () => {
    canonicalModule = await WebAssembly.compile(await readFile(new URL('../ext/lib/term-content-canonical-scan-v2.wasm', import.meta.url)))
})

/**
 * @param {boolean} native
 * @returns {{database: DictionaryDatabase, scanner: NativeCanonicalScanner, chunk: ArtifactChunk, plan: ContentPlan}}
 */
function createFixture(native = false) {
    const database = new DictionaryDatabase()
    const scanner = new NativeCanonicalScanner({loadModule: async () => {
        if (!native) { throw new Error('Use JavaScript canonical fallback') }
        return canonicalModule
    }})
    Reflect.set(database, '_nativeCanonicalScanner', scanner)
    const plan = /** @type {ContentPlan} */ ({
        uniqueCount: 3,
        sourceRowCount: 4,
        uniqueRowIndexes: new Uint32Array([0, 2, 3]),
        uniqueSignatures: new Uint32Array([1, 1, 1, 2, 2, 2, 3, 3, 3]),
        resolvedFlags: new Uint8Array(3),
        resolvedOffsets: new Float64Array(3),
        resolvedLengths: new Uint32Array(3),
        resolvedDictNames: null,
        pendingEpochs: null,
        pendingIndexes: null,
        nextEpoch: 1,
        persistedLookupRequired: true,
    })
    const chunk = /** @type {ArtifactChunk} */ ({
        rowCount: 4,
        contentRowStart: 0,
        contentBytesList: [],
        contentHash1List: new Uint32Array(0),
        contentHash2List: new Uint32Array(0),
        contentBytesBuffer: new Uint8Array([1, 2, 3]),
        contentBytesBaseOffset: 0,
        contentMetaList: new Uint32Array([0, 1, 10, 20, 0, 1, 10, 20, 1, 1, 30, 40, 2, 1, 50, 60]),
        contentUniqueIndexList: new Uint32Array([0, 0, 1, 2]),
        contentDedupPlan: plan,
        contentDictNameList: null,
        uniformContentDictName: 'raw-v6',
    })
    return {database, scanner, chunk, plan}
}

/**
 * @param {DictionaryDatabase} database
 * @param {ArtifactChunk} chunk
 * @param {boolean} canonical
 * @param {boolean} [reserveMetadata]
 * @returns {ReturnType<DictionaryDatabase['_resolveArtifactTermContentDedup']>}
 */
async function resolve(database, chunk, canonical, reserveMetadata = false) {
    return await Reflect.get(database, '_resolveArtifactTermContentDedup').call(database, {
        ...chunk,
        contentRowStart: canonical ? chunk.contentRowStart : void 0,
    }, reserveMetadata)
}

/** @param {Awaited<ReturnType<typeof resolve>>} result */
function expectResolvedRows(result) {
    expect(result.pendingContentCount).toBe(3)
    expect(result.pendingHitCount).toBe(1)
    expect([...result.pendingContentHash1s]).toEqual([10, 30, 50])
    expect([...result.pendingContentHash2s]).toEqual([20, 40, 60])
    expect([...result.pendingPlanUniqueIndexes]).toEqual([0, 1, 2])
    expect(result.pendingContentSpans?.offsets).toEqual(new Uint32Array([0, 1, 2]))
    expect(result.pendingContentSpans?.lengths).toEqual(new Uint32Array([1, 1, 1]))
}

describe('deferred term-content plan scratch', () => {
    test.each([false, true])('keeps unused epoch scratch absent with native canonical scan=%s', async (native) => {
        const {database, scanner, chunk, plan} = createFixture(native)
        for (let i = 0; i < 2; ++i) {
            expectResolvedRows(await resolve(database, chunk, true))
            expect(plan.pendingEpochs).toBeNull()
            expect(plan.pendingIndexes).toBeNull()
            expect(plan.pendingSpanOffsetsScratch).toHaveLength(3)
            expect(plan.pendingSpanLengthsScratch).toHaveLength(3)
        }
        expect(scanner.stats.calls > 0).toBe(native)
    })

    test.each([false, true])('preserves grouping across canonical and generic scans, generic first=%s', async (genericFirst) => {
        const {database, chunk, plan} = createFixture()
        plan.nextEpoch = 37
        /** @type {Uint32Array|null} */
        let allocatedEpochs = null
        /** @type {Uint32Array|null} */
        let allocatedIndexes = null
        for (const canonical of [!genericFirst, genericFirst, !genericFirst]) {
            const beforeEpoch = plan.nextEpoch
            const result = await resolve(database, chunk, canonical)
            expectResolvedRows(result)
            expect(plan.nextEpoch).toBe(beforeEpoch + 1)
            if (!canonical) {
                expect(result.pendingRowToUniqueIndex).toEqual(new Int32Array([0, 0, 1, 2]))
                expect(plan.pendingEpochs).toBeInstanceOf(Uint32Array)
                expect(plan.pendingIndexes).toEqual(new Uint32Array([0, 1, 2]))
                allocatedEpochs ??= plan.pendingEpochs
                allocatedIndexes ??= plan.pendingIndexes
            }
            if (allocatedEpochs) {
                expect(plan.pendingEpochs).toBe(allocatedEpochs)
                expect(plan.pendingIndexes).toBe(allocatedIndexes)
            }
        }
    })

    test.each([false, true])('handles epoch wrap before first generic allocation, canonical first=%s', async (canonicalFirst) => {
        const {database, chunk, plan} = createFixture()
        plan.nextEpoch = 0
        if (canonicalFirst) {
            expectResolvedRows(await resolve(database, chunk, true))
            expect(plan.pendingEpochs).toBeNull()
            plan.nextEpoch = 0
        }
        expectResolvedRows(await resolve(database, chunk, false))
        expect(plan.nextEpoch).toBe(2)
        expect(plan.pendingEpochs).toEqual(new Uint32Array([1, 1, 1]))
        plan.nextEpoch = 0
        expectResolvedRows(await resolve(database, chunk, true))
        expect(plan.pendingEpochs).toEqual(new Uint32Array(3))
        expectResolvedRows(await resolve(database, chunk, false))
        expect(plan.pendingEpochs).toEqual(new Uint32Array([2, 2, 2]))
    })

    test.each(['pendingEpochs', 'pendingIndexes'])('does not accept a half-deferred %s pair', async (property) => {
        const {database, scanner, chunk, plan} = createFixture(true)
        Reflect.set(plan, property, new Uint32Array(3))
        const result = await resolve(database, chunk, true)
        expect(result.contentDedupPlan).toBeNull()
        expect(scanner.stats.calls).toBe(0)
        expect(result.pendingContentCount).toBe(3)
        expect(result.pendingHitCount).toBe(1)
    })

    test.each(['pendingEpochs', 'pendingIndexes'])('retains short %s native rejection', async (property) => {
        const {database, scanner, chunk, plan} = createFixture(true)
        plan.pendingEpochs = new Uint32Array(3)
        plan.pendingIndexes = new Uint32Array(3)
        Reflect.set(plan, property, new Uint32Array(1))
        expectResolvedRows(await resolve(database, chunk, true))
        expect(scanner.stats.calls).toBe(0)
        expect(scanner.stats.fallbackEligibility).toBe(1)
        expect(Reflect.get(plan, property)).toHaveLength(1)
    })

    test.each([0, 37, 0xffffffff])('keeps both deferred columns intact if allocation fails at epoch %s', async (nextEpoch) => {
        const {database, chunk, plan} = createFixture()
        plan.nextEpoch = nextEpoch
        const failedScanEpoch = nextEpoch === 0 ? 1 : nextEpoch
        const OriginalUint32Array = globalThis.Uint32Array
        let calls = 0
        vi.stubGlobal('Uint32Array', new Proxy(OriginalUint32Array, {
            construct(target, args) {
                if (args.length === 1 && args[0] === 3 && ++calls === 2) { throw new RangeError('scratch allocation failed') }
                return Reflect.construct(target, args)
            },
        }))
        try {
            await expect(resolve(database, chunk, false)).rejects.toThrow('scratch allocation failed')
            expect(plan.pendingEpochs).toBeNull()
            expect(plan.pendingIndexes).toBeNull()
            expect(plan.nextEpoch).toBe((failedScanEpoch + 1) >>> 0)
            expect(plan.resolvedFlags).toEqual(new Uint8Array(3))
        } finally {
            vi.unstubAllGlobals()
        }
        const retryEpoch = plan.nextEpoch === 0 ? 1 : plan.nextEpoch
        expectResolvedRows(await resolve(database, chunk, false))
        expect(plan.pendingEpochs).toEqual(new OriginalUint32Array([retryEpoch, retryEpoch, retryEpoch]))
        expect(plan.nextEpoch).toBe((retryEpoch + 1) >>> 0)
    })
})
