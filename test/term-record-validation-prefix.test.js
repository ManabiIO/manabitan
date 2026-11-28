/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {afterEach, describe, expect, test, vi} from 'vitest'
import {createArtifactTermRecordChunkWithResolvedContent, TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js'

/** @typedef {Parameters<TermRecordOpfsStore['_encodeAndAppendArtifactChunkForState']>[1]} ArtifactChunk */
/** @typedef {NonNullable<ArtifactChunk['resolvedContentReferences']>} ContentReferences */
/** @typedef {ArtifactChunk & {resolvedContentReferences: ContentReferences}} OwnedChunk */

/**
 * @param {Uint32Array} indexes
 * @param {Float64Array} [offsets]
 * @param {Uint32Array} [lengths]
 * @returns {OwnedChunk}
 */
function fixture(indexes, offsets = Float64Array.of(2 ** 40 + 101, 2 ** 40 + 120, 2 ** 40 + 139), lengths = Uint32Array.of(7, 9, 11)) {
    const expression = new TextEncoder().encode('辞書')
    const rowCount = indexes.length
    return createArtifactTermRecordChunkWithResolvedContent(
        {
            dictionary: 'Repeated span validation',
            rowCount,
            expressionBytesList: Array.from({length: rowCount}, () => expression),
            readingBytesList: Array.from({length: rowCount}, () => expression),
            readingEqualsExpressionList: new Uint8Array(rowCount).fill(1),
            scoreList: Int32Array.from({length: rowCount}, (_, i) => i % 5 - 2),
            sequenceList: new Int32Array(rowCount).fill(-1),
        },
        indexes,
        offsets,
        lengths,
    )
}

/**
 * Run the real validators and record/lookup encoders, intercepting only storage.
 * @param {(() => void|Promise<void>)|null} [afterAppend=null]
 * @returns {{store: TermRecordOpfsStore, append: import('vitest').MockInstance<TermRecordOpfsStore['_appendEncodedChunk']>}}
 */
function createStore(afterAppend = null) {
    const store = new TermRecordOpfsStore()
    const append = vi.spyOn(store, '_appendEncodedChunk').mockImplementation(async () => { await afterAppend?.() })
    return {store, append}
}

/**
 * @param {TermRecordOpfsStore} store
 * @param {ArtifactChunk} chunk
 * @param {Parameters<TermRecordOpfsStore['_encodeAndAppendArtifactChunkForState']>[7]} [prepared=null]
 * @returns {ReturnType<TermRecordOpfsStore['_encodeAndAppendArtifactChunkForState']>}
 */
function encode(store, chunk, prepared = null) {
    return store._encodeAndAppendArtifactChunkForState(
        /** @type {Parameters<TermRecordOpfsStore['_encodeAndAppendArtifactChunkForState']>[0]} */ ({}),
        chunk, 1, [], [], null, 'raw', prepared,
    )
}

/**
 * Count real value checks without altering columns, getters or control flow.
 * High offsets distinguish span checks from unrelated header/count validation.
 * @returns {{checks: number[], restore: () => void}}
 */
function observeSpanValidation() {
    const original = Number.isSafeInteger
    /** @type {number[]} */
    const checks = []
    const spy = vi.spyOn(Number, 'isSafeInteger').mockImplementation((value) => {
        if (typeof value === 'number' && value >= 2 ** 40) { checks.push(value) }
        return original(value)
    })
    return {checks, restore: () => spy.mockRestore()}
}

afterEach(() => { vi.restoreAllMocks() })

describe('repeated private content spans within one validation run', () => {
    test('validates nonconsecutive aliases once and preserves exact complete encoder bytes', async () => {
        const chunk = fixture(Uint32Array.from({length: 120}, (_, i) => Math.floor(i / 2) % 3))
        const generic = createStore()
        await encode(generic.store, {...chunk})
        const owned = createStore()
        const observation = observeSpanValidation()
        await encode(owned.store, chunk)
        observation.restore()
        expect(observation.checks).toEqual([...chunk.resolvedContentReferences.offsets])
        assert.deepStrictEqual(owned.append.mock.calls, generic.append.mock.calls)
    })

    test.each([
        {ids: [2, 0, 2, 1, 2, 0, 1, 2], expectedChecks: [2, 0, 2, 1, 2]},
        {ids: [1, 2, 1, 2], expectedChecks: [1, 2, 1, 2]},
        {ids: [0, 2, 0, 2], expectedChecks: [0, 2, 2]},
    ])('keeps sparse or out-of-order IDs conservative (%#)', async ({ids, expectedChecks}) => {
        const chunk = fixture(Uint32Array.from(ids))
        const generic = createStore()
        await encode(generic.store, {...chunk})
        const owned = createStore()
        const observation = observeSpanValidation()
        await encode(owned.store, chunk)
        observation.restore()
        expect(observation.checks).toEqual(expectedChecks.map((id) => chunk.resolvedContentReferences.offsets[id]))
        assert.deepStrictEqual(owned.append.mock.calls, generic.append.mock.calls)
    })

    test('keeps missing spans and exact offset-range split boundaries', async () => {
        const base = 2 ** 40
        const chunk = fixture(
            Uint32Array.of(0, 1, 0, 2, 1, 3, 0, 1),
            Float64Array.of(base, base + 0xfffffffe, -1, base + 0xffffffff),
            Uint32Array.of(7, 9, 0, 11),
        )
        const generic = createStore()
        const owned = createStore()
        await encode(generic.store, {...chunk})
        await encode(owned.store, chunk)
        assert.deepStrictEqual(owned.append.mock.calls, generic.append.mock.calls)
        expect(owned.append.mock.calls.map((args) => [args[2], args[4]])).toEqual([
            [5, base], [1, base + 0xffffffff], [2, base],
        ])
    })

    test.each(['offset', 'length', 'index', 'unsafe-offset', 'fractional-offset'])('rejects invalid %s after already-seen aliases', async (kind) => {
        const chunk = fixture(Uint32Array.of(0, 1, 0, 1, 2))
        const references = chunk.resolvedContentReferences
        if (kind === 'offset') { references.offsets[2] = Number.NaN }
        if (kind === 'length') { references.lengths[2] = 0xffffffff }
        if (kind === 'index') { references.uniqueIndexList[4] = 3 }
        if (kind === 'unsafe-offset') { references.offsets[2] = Number.MAX_SAFE_INTEGER + 1 }
        if (kind === 'fractional-offset') { references.offsets[2] = 12.5 }
        const {store, append} = createStore()
        await expect(encode(store, chunk)).rejects.toThrow(/Invalid (term content|resolved term content reference)/)
        expect(append).not.toHaveBeenCalled()
    })

    test.each([-1, -0.5, 0.5, Number.NaN, Number.POSITIVE_INFINITY])('retains invalid ID failure for a spoofed typed kind (%s)', async (invalidId) => {
        const indexes = Float64Array.of(0, 1, invalidId)
        Object.setPrototypeOf(indexes, Uint32Array.prototype)
        const chunk = fixture(/** @type {Uint32Array} */ (/** @type {unknown} */ (indexes)))
        const owned = createStore()
        const generic = createStore()
        await expect(encode(owned.store, chunk)).rejects.toThrow(/Invalid (term content|resolved term content reference)/)
        await expect(encode(generic.store, {...chunk})).rejects.toThrow(/Invalid (term content|resolved term content reference)/)
        expect(owned.append).not.toHaveBeenCalled()
        expect(generic.append).not.toHaveBeenCalled()
    })

    test.each(['external', 'shared-indexes', 'shared-offsets', 'shared-lengths', 'accessor', 'replacement', 'subclass'])('keeps %s references on the original per-row path', async (kind) => {
        let chunk = fixture(Uint32Array.from({length: 120}, (_, i) => i % 3))
        const references = chunk.resolvedContentReferences
        if (kind === 'external') { chunk = {...chunk} }
        if (kind === 'shared-indexes') {
            const shared = new Uint32Array(new SharedArrayBuffer(references.uniqueIndexList.byteLength))
            shared.set(references.uniqueIndexList)
            references.uniqueIndexList = shared
        }
        if (kind === 'shared-offsets') {
            const shared = new Float64Array(new SharedArrayBuffer(references.offsets.byteLength))
            shared.set(references.offsets)
            references.offsets = shared
        }
        if (kind === 'shared-lengths') {
            const shared = new Uint32Array(new SharedArrayBuffer(references.lengths.byteLength))
            shared.set(references.lengths)
            references.lengths = shared
        }
        if (kind === 'accessor') {
            Object.defineProperty(chunk, 'resolvedContentReferences', {get: () => references})
        }
        if (kind === 'replacement') { chunk.resolvedContentReferences = {...references} }
        if (kind === 'subclass') {
            class Offsets extends Float64Array {}
            references.offsets = new Offsets(references.offsets)
        }
        const generic = createStore()
        await encode(generic.store, {...chunk})
        const fallback = createStore()
        const observation = observeSpanValidation()
        await encode(fallback.store, chunk)
        observation.restore()
        expect(observation.checks).toHaveLength(chunk.rowCount)
        assert.deepStrictEqual(fallback.append.mock.calls, generic.append.mock.calls)
    })

    test('observes an external indexed accessor that invalidates a revisited span', async () => {
        const chunk = fixture(Uint32Array.of(0, 1, 0))
        const references = chunk.resolvedContentReferences
        const indexes = [0, 1, 0]
        Object.defineProperty(indexes, 2, {get() { references.offsets[0] = Number.NaN; return 0 }})
        references.uniqueIndexList = /** @type {Uint32Array} */ (/** @type {unknown} */ (indexes))
        const {store, append} = createStore()
        await expect(encode(store, chunk)).rejects.toThrow('Invalid term content offset: NaN')
        expect(append).not.toHaveBeenCalled()
    })

    test.each(['offset', 'length', 'index', 'replacement', 'accessor'])('revalidates previously accepted ID zero after an awaited row-limit split (%s)', async (kind) => {
        const chunk = fixture(Uint32Array.from({length: 30002}, (_, i) => i % 2))
        const references = chunk.resolvedContentReferences
        const {store, append} = createStore(async () => {
            await Promise.resolve()
            if (kind === 'offset') { references.offsets[0] = Number.NaN }
            if (kind === 'length') { references.lengths[0] = 0xffffffff }
            if (kind === 'index') { references.uniqueIndexList[30000] = 3 }
            if (kind === 'replacement') {
                chunk.resolvedContentReferences = {...references, offsets: Float64Array.of(Number.NaN, 16, 32)}
            }
            if (kind === 'accessor') {
                Object.defineProperty(references, 'offsets', {get: () => Float64Array.of(Number.NaN, 16, 32)})
            }
        })
        await expect(encode(store, chunk)).rejects.toThrow(/Invalid (term content|resolved term content reference)/)
        expect(append).toHaveBeenCalledTimes(1)
        expect(append.mock.calls[0][2]).toBe(30000)
    })

    test('accepts valid new spans after an awaited row-limit split and resets their base', async () => {
        const original = Float64Array.of(2 ** 40 + 101, 2 ** 40 + 120, 2 ** 40 + 139)
        const create = () => fixture(Uint32Array.from({length: 30002}, (_, i) => i % 2), original.slice())
        const ownedChunk = create()
        const genericChunk = create()
        const owned = createStore(async () => { await Promise.resolve(); ownedChunk.resolvedContentReferences.offsets[0] = 2 ** 40 + 77 })
        const generic = createStore(async () => { await Promise.resolve(); genericChunk.resolvedContentReferences.offsets[0] = 2 ** 40 + 77 })
        await encode(owned.store, ownedChunk)
        await encode(generic.store, {...genericChunk})
        assert.deepStrictEqual(owned.append.mock.calls, generic.append.mock.calls)
        expect(owned.append.mock.calls.map((args) => [args[2], args[4]])).toEqual([
            [30000, 2 ** 40 + 101], [2, 2 ** 40 + 77],
        ])
    })

    test('revalidates an earlier ID after an awaited offset-range split', async () => {
        const chunk = fixture(
            Uint32Array.of(0, 1, 0, 2, 0),
            Float64Array.of(16, 32, 16 + 0xffffffff),
        )
        const {store, append} = createStore(async () => {
            await Promise.resolve()
            chunk.resolvedContentReferences.offsets[0] = Number.NaN
        })
        await expect(encode(store, chunk)).rejects.toThrow('Invalid term content offset: NaN')
        expect(append).toHaveBeenCalledTimes(1)
        expect(append.mock.calls[0][2]).toBe(3)
    })

    test('keeps a complete prepared whole-group index beyond the ordinary row limit', async () => {
        const chunk = fixture(Uint32Array.from({length: 30002}, (_, i) => i % 3))
        const owned = createStore()
        const expression = chunk.expressionBytesList[0]
        const prepared = owned.store.prepareArtifactChunkLookupIndexes({
            ...chunk,
            termRecordPreinternedPlan: {
                stringLengths: Uint16Array.of(expression.byteLength),
                stringOffsets: Uint32Array.of(0),
                stringsBuffer: expression,
                expressionIndexes: new Uint32Array(chunk.rowCount),
                readingIndexes: new Uint32Array(chunk.rowCount),
            },
        })
        expect(prepared?.indexes.size).toBe(1)
        const generic = createStore()
        await encode(generic.store, {...chunk}, prepared?.indexes)
        const observation = observeSpanValidation()
        await encode(owned.store, chunk, prepared?.indexes)
        observation.restore()
        expect(observation.checks).toEqual([...chunk.resolvedContentReferences.offsets])
        expect(owned.append).toHaveBeenCalledTimes(1)
        assert.deepStrictEqual(owned.append.mock.calls, generic.append.mock.calls)
    })
})
