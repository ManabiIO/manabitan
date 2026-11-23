/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test, vi} from 'vitest'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'
import {createArtifactTermRecordChunkWithResolvedContent, TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js'

/** @typedef {Parameters<TermRecordOpfsStore['_encodeAndAppendArtifactChunkForState']>[1]} ArtifactChunk */
/** @typedef {NonNullable<ArtifactChunk['resolvedContentReferences']>} ContentReferences */

/**
 * @param {ContentReferences} references
 * @param {number} [rowCount]
 * @returns {ArtifactChunk}
 */
function createChunk(references, rowCount = references.uniqueIndexList.length) {
    const expression = new TextEncoder().encode('term')
    return {
        dictionary: 'Reference origin validation',
        rowCount,
        expressionBytesList: Array.from({length: rowCount}, () => expression),
        readingBytesList: Array.from({length: rowCount}, () => expression),
        readingEqualsExpressionList: new Uint8Array(rowCount).fill(1),
        scoreList: new Int32Array(rowCount),
        sequenceList: new Int32Array(rowCount).fill(-1),
        resolvedContentReferences: references,
    }
}

/**
 * @param {ContentReferences} references
 * @returns {ArtifactChunk}
 */
function createOwnedChunk(references) {
    return createArtifactTermRecordChunkWithResolvedContent(
        createChunk(references),
        references.uniqueIndexList,
        references.offsets,
        references.lengths,
    )
}

/** @returns {ContentReferences} */
function references() {
    return {uniqueIndexList: Uint32Array.of(0, 0), offsets: Float64Array.of(16), lengths: Uint32Array.of(7)}
}

/**
 * @param {(() => void|Promise<void>)|null} [afterAppend=null]
 * @returns {{store: TermRecordOpfsStore, append: import('vitest').MockInstance<TermRecordOpfsStore['_appendEncodedChunk']>}}
 */
function createStore(afterAppend = null) {
    const store = new TermRecordOpfsStore()
    // Run the real validation, record-field encoder and lookup encoder. Only
    // the storage boundary is intercepted so tests can inspect exact bytes.
    const append = vi.spyOn(store, '_appendEncodedChunk').mockImplementation(async () => { await afterAppend?.() })
    return {store, append}
}

/**
 * @param {TermRecordOpfsStore} store
 * @param {ArtifactChunk} chunk
 * @returns {ReturnType<TermRecordOpfsStore['_encodeAndAppendArtifactChunkForState']>}
 */
function encode(store, chunk) {
    return store._encodeAndAppendArtifactChunkForState(
        /** @type {Parameters<TermRecordOpfsStore['_encodeAndAppendArtifactChunkForState']>[0]} */ ({}),
        chunk,
        1,
        new Float64Array(0),
        new Uint32Array(0),
        null,
        'raw',
    )
}

describe('resolved content reference origin', () => {
    test.each(['external', 'factory-wrapper'])('rejects a %s Proxy whose descriptor and ordinary reference reads differ', async (kind) => {
        const valid = references()
        const invalid = {...valid, offsets: Float64Array.of(Number.NaN)}
        const target = kind === 'external' ? createChunk(valid) : createOwnedChunk(valid)
        const chunk = new Proxy(target, {
            get(object, key, receiver) {
                return key === 'resolvedContentReferences' ? invalid : Reflect.get(object, key, receiver)
            },
        })
        expect(Object.getOwnPropertyDescriptor(chunk, 'resolvedContentReferences')?.value.offsets[0]).toBe(16)
        const {store, append} = createStore()
        await expect(encode(store, chunk)).rejects.toThrow('Invalid term content offset: NaN')
        expect(append).not.toHaveBeenCalled()
    })

    test('rejects a replaced reference Proxy whose data descriptors disagree with getters', async () => {
        const valid = references()
        const chunk = createOwnedChunk(valid)
        chunk.resolvedContentReferences = new Proxy(valid, {
            get(object, key, receiver) {
                return key === 'offsets' ? Float64Array.of(Number.NaN) : Reflect.get(object, key, receiver)
            },
        })
        const {store, append} = createStore()
        await expect(encode(store, chunk)).rejects.toThrow('Invalid term content offset: NaN')
        expect(append).not.toHaveBeenCalled()
    })

    test.each(['reference-object', 'offset-column'])('keeps normal reads after an %s accessor replacement', async (kind) => {
        const chunk = createOwnedChunk(references())
        const original = /** @type {ContentReferences} */ (chunk.resolvedContentReferences)
        let reads = 0
        if (kind === 'reference-object') {
            Object.defineProperty(chunk, 'resolvedContentReferences', {
                get() { ++reads; return {...original, offsets: Float64Array.of(Number.NaN)} },
            })
        } else {
            Object.defineProperty(original, 'offsets', {
                get() { ++reads; return Float64Array.of(Number.NaN) },
            })
        }
        const {store, append} = createStore()
        await expect(encode(store, chunk)).rejects.toThrow('Invalid term content offset: NaN')
        expect(reads).toBeGreaterThan(0)
        expect(append).not.toHaveBeenCalled()
    })

    test('creates fresh ordinary objects without modifying the producer input', () => {
        const original = references()
        const input = createChunk(original)
        const output = createArtifactTermRecordChunkWithResolvedContent(
            input,
            original.uniqueIndexList,
            original.offsets,
            original.lengths,
        )
        expect(output).not.toBe(input)
        expect(Object.getPrototypeOf(output)).toBe(Object.prototype)
        expect(output.resolvedContentReferences).not.toBe(original)
        expect(Object.getPrototypeOf(output.resolvedContentReferences)).toBe(Object.prototype)
        expect(output.resolvedContentReferences?.offsets).toBe(original.offsets)
        expect(input.resolvedContentReferences).toBe(original)
    })

    test.each(['external', 'factory'])('preserves per-row accessor reads for a %s chunk', async (kind) => {
        const chunk = kind === 'external' ? createChunk(references()) : createOwnedChunk(references())
        const columns = /** @type {ContentReferences} */ (chunk.resolvedContentReferences)
        const offsets = columns.offsets
        let reads = 0
        Object.defineProperty(columns, 'offsets', {
            get() {
                if (++reads > 2) { offsets[0] = Number.NaN }
                return offsets
            },
        })
        const {store, append} = createStore()
        await expect(encode(store, chunk)).rejects.toThrow('Invalid term content offset: NaN')
        expect(reads).toBe(4)
        expect(append).not.toHaveBeenCalled()
    })

    test.each(['factory', 'database-producer'])('retains consecutive-ID work reduction and exact actual encoder output for %s chunks', async (kind) => {
        const offset = 2 ** 40 + 123
        const columns = {uniqueIndexList: new Uint32Array(120), offsets: Float64Array.of(offset), lengths: Uint32Array.of(7)}
        const generic = createStore()
        const owned = createStore()
        const originalIsSafeInteger = Number.isSafeInteger
        let checks = 0
        const validation = vi.spyOn(Number, 'isSafeInteger').mockImplementation((value) => {
            if (value === offset) { ++checks }
            return originalIsSafeInteger(value)
        })
        try {
            await encode(generic.store, createChunk(columns))
            const genericChecks = checks
            checks = 0
            const ownedChunk = kind === 'factory' ?
                createOwnedChunk(columns) :
                new DictionaryDatabase()._createResolvedArtifactTermRecordChunk(
                    /** @type {Parameters<DictionaryDatabase['_createResolvedArtifactTermRecordChunk']>[0]} */ ({
                        ...createChunk(columns), contentUniqueIndexList: columns.uniqueIndexList,
                    }),
                    null,
                    /** @type {Parameters<DictionaryDatabase['_createResolvedArtifactTermRecordChunk']>[2]} */ ({
                        resolvedOffsets: columns.offsets, resolvedLengths: columns.lengths,
                    }),
                    true,
                )
            await encode(owned.store, ownedChunk)
            expect(genericChecks).toBe(120)
            expect(checks).toBe(1)
            expect(owned.append.mock.calls).toStrictEqual(generic.append.mock.calls)
        } finally {
            validation.mockRestore()
        }
    })

    test.each(['shared', 'subclass', 'accessor', 'replacement'])('keeps %s columns on per-row validation with identical encoded bytes', async (kind) => {
        const offset = 2 ** 40 + 123
        const columns = {uniqueIndexList: new Uint32Array(120), offsets: Float64Array.of(offset), lengths: Uint32Array.of(7)}
        if (kind === 'shared') {
            columns.offsets = new Float64Array(new SharedArrayBuffer(8))
            columns.offsets[0] = offset
        } else if (kind === 'subclass') {
            class Offsets extends Float64Array {}
            columns.offsets = new Offsets([offset])
        }
        const chunk = createOwnedChunk(columns)
        if (kind === 'accessor') {
            Object.defineProperty(chunk.resolvedContentReferences, 'offsets', {get: () => columns.offsets})
        } else if (kind === 'replacement') {
            chunk.resolvedContentReferences = {...columns}
        }
        const generic = createStore()
        await encode(generic.store, createChunk(columns))
        const originalIsSafeInteger = Number.isSafeInteger
        let checks = 0
        const validation = vi.spyOn(Number, 'isSafeInteger').mockImplementation((value) => {
            if (value === offset) { ++checks }
            return originalIsSafeInteger(value)
        })
        try {
            const fallback = createStore()
            await encode(fallback.store, chunk)
            expect(checks).toBe(120)
            expect(fallback.append.mock.calls).toStrictEqual(generic.append.mock.calls)
        } finally {
            validation.mockRestore()
        }
    })

    test.each(['offset', 'length', 'index', 'replace', 'accessor'])('revalidates %s mutation across an actual encoded and awaited split', async (change) => {
        const chunk = createOwnedChunk({
            uniqueIndexList: Uint32Array.of(0, 0, 1, 1),
            offsets: Float64Array.of(16, 16 + 0xffffffff),
            lengths: Uint32Array.of(7, 9),
        })
        const columns = /** @type {ContentReferences} */ (chunk.resolvedContentReferences)
        const {store, append} = createStore(async () => {
            await Promise.resolve()
            switch (change) {
                case 'offset': columns.offsets[1] = Number.NaN; break
                case 'length': columns.lengths[1] = 0xffffffff; break
                case 'index': columns.uniqueIndexList[2] = 2; break
                case 'replace':
                    chunk.resolvedContentReferences = {...columns, offsets: Float64Array.of(16, Number.NaN)}
                    break
                case 'accessor':
                    Object.defineProperty(columns, 'offsets', {get: () => Float64Array.of(16, Number.NaN)})
                    break
            }
        })
        await expect(encode(store, chunk)).rejects.toThrow(/Invalid (term content|resolved term content reference)/)
        expect(append).toHaveBeenCalledTimes(1)
        expect(append.mock.calls[0][2]).toBe(2)
        expect(append.mock.calls[0][4]).toBe(16)
        const recordFields = /** @type {Uint8Array} */ (append.mock.calls[0][6])
        expect([...recordFields]).toEqual([0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0])
    })

    test.each(['offset', 'length'])('a typed-kind prototype spoof still validates its first %s value', async (field) => {
        const columns = references()
        if (field === 'offset') {
            const invalid = Float32Array.of(Number.NaN)
            Object.setPrototypeOf(invalid, Float64Array.prototype)
            columns.offsets = /** @type {Float64Array} */ (/** @type {unknown} */ (invalid))
        } else {
            const invalid = Float64Array.of(Number.NaN)
            Object.setPrototypeOf(invalid, Uint32Array.prototype)
            columns.lengths = /** @type {Uint32Array} */ (/** @type {unknown} */ (invalid))
        }
        const {store, append} = createStore()
        await expect(encode(store, createOwnedChunk(columns))).rejects.toThrow(`Invalid term content ${field}: NaN`)
        expect(append).not.toHaveBeenCalled()
    })
})
