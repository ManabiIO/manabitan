/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test, vi} from 'vitest'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'

/** @typedef {NonNullable<Awaited<ReturnType<DictionaryDatabase['_resolveArtifactTermContentDedup']>>['pendingContentSpans']>} Spans */

/** @returns {Promise<{database: DictionaryDatabase, spans: Spans, persisted: Float64Array}>} */
async function createFixture() {
    const database = new DictionaryDatabase()
    const resolved = await Reflect.get(database, '_resolveArtifactTermContentDedup').call(database, {
        rowCount: 3,
        contentBytesList: [],
        contentHash1List: new Uint32Array(0),
        contentHash2List: new Uint32Array(0),
        contentBytesBuffer: Uint8Array.of(1, 2, 3, 4, 5, 6),
        contentBytesBaseOffset: 0,
        contentMetaList: new Uint32Array([0, 2, 10, 20, 2, 2, 11, 21, 4, 2, 12, 22]),
        contentUniqueIndexList: new Uint32Array([0, 1, 2]),
        contentDedupPlan: {
            resolvedFlags: new Uint8Array(3),
            resolvedOffsets: new Float64Array(3),
            resolvedLengths: new Uint32Array(3),
            resolvedDictNames: null,
            pendingEpochs: new Uint32Array(3),
            pendingIndexes: new Uint32Array(3),
            nextEpoch: 1,
            nextUnresolvedUniqueIndex: 0,
            persistedLookupRequired: false,
        },
        contentDictNameList: null,
        uniformContentDictName: 'raw',
    })
    const spans = resolved.pendingContentSpans
    if (spans === null) { throw new Error('Expected resolver-owned spans') }
    return {database, spans, persisted: new Float64Array([100, 200, 300])}
}

/**
 * @param {DictionaryDatabase} database
 * @param {Spans} spans
 * @param {number[]|Float64Array} persisted
 * @returns {() => void}
 */
function register(database, spans, persisted) {
    return Reflect.get(database, '_registerInFlightTermContentSources').call(database, persisted, spans.lengths, 'raw', [], spans)
}

describe('resolver-owned in-flight source registration', () => {
    test('keeps exact lookup and cleanup for ordered private columns', async () => {
        const {database, spans, persisted} = await createFixture()
        const unregister = register(database, spans, persisted)
        expect(Reflect.get(database, '_findInFlightTermContentSource').call(database, 200, 2, 'raw'))
            .toEqual({buffer: spans.buffer, offset: 2, length: 2})
        expect([...Reflect.get(database, '_inFlightTermContentSourceBatches')]).toMatchObject([
            {minimumOffset: 100, maximumOffset: 300, sortedOffsets: true},
        ])
        unregister()
        expect(Reflect.get(database, '_inFlightTermContentSourceBatches').size).toBe(0)
    })

    test.each([Number.NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects a late invalid persisted offset %s without registration', async (offset) => {
        const {database, spans, persisted} = await createFixture()
        persisted[2] = offset
        expect(() => register(database, spans, persisted)).toThrow('Invalid in-flight term content source at index 2')
        expect(Reflect.get(database, '_inFlightTermContentSourceBatches').size).toBe(0)
    })

    test('rechecks caller mutations after a previous valid registration', async () => {
        const {database, spans, persisted} = await createFixture()
        register(database, spans, persisted)()
        spans.offsets[2] = 7
        expect(() => register(database, spans, persisted)).toThrow('Invalid in-flight term content source at index 2')
        expect(Reflect.get(database, '_inFlightTermContentSourceBatches').size).toBe(0)
    })

    test('preserves duplicate rejection and unordered lookup', async () => {
        const {database, spans, persisted} = await createFixture()
        persisted[1] = 100
        expect(() => register(database, spans, persisted)).toThrow('Duplicate in-flight term content storage reference')
        expect(Reflect.get(database, '_inFlightTermContentSourceBatches').size).toBe(0)
        persisted.set([300, 100, 200])
        const unregister = register(database, spans, persisted)
        expect(Reflect.get(database, '_findInFlightTermContentSource').call(database, 100, 2, 'raw'))
            .toEqual({buffer: spans.buffer, offset: 2, length: 2})
        expect([...Reflect.get(database, '_inFlightTermContentSourceBatches')][0].sortedOffsets).toBe(false)
        unregister()
    })

    test('allows equal offsets with distinct lengths and detects active duplicates', async () => {
        const {database, spans, persisted} = await createFixture()
        persisted[1] = 100
        spans.lengths[1] = 1
        const unregister = register(database, spans, persisted)
        const find = Reflect.get(database, '_findInFlightTermContentSource').bind(database)
        expect(find(100, 1, 'raw')).toEqual({buffer: spans.buffer, offset: 2, length: 1})
        expect(find(100, 2, 'raw')).toEqual({buffer: spans.buffer, offset: 0, length: 2})
        expect(() => register(database, spans, persisted)).toThrow('Duplicate in-flight term content storage reference')
        expect(Reflect.get(database, '_inFlightTermContentSourceBatches').size).toBe(1)
        unregister()
    })

    test('retains per-row accessor reads on a changed resolver record', async () => {
        const {database, spans, persisted} = await createFixture()
        const offsets = spans.offsets
        let reads = 0
        const get = vi.fn(() => {
            if (++reads === 3) { offsets[2] = 100 }
            return offsets
        })
        Object.defineProperty(spans, 'offsets', {get})
        expect(() => register(database, spans, persisted)).toThrow('Invalid in-flight term content source at index 2')
        expect(get).toHaveBeenCalledTimes(3)
        expect(Reflect.get(database, '_inFlightTermContentSourceBatches').size).toBe(0)
    })

    test('keeps proxy records on the general path without descriptor probes', async () => {
        const {database, spans, persisted} = await createFixture()
        let offsetReads = 0
        const proxy = new Proxy(spans, {
            get(target, key) {
                if (key === 'offsets' && ++offsetReads === 3) { target.offsets[2] = 100 }
                return Reflect.get(target, key)
            },
            getOwnPropertyDescriptor() { throw new Error('Unexpected proxy descriptor probe') },
        })
        expect(() => register(database, proxy, persisted)).toThrow('Invalid in-flight term content source at index 2')
        expect(offsetReads).toBe(3)
        expect(Reflect.get(database, '_inFlightTermContentSourceBatches').size).toBe(0)
    })

    test('does not inspect proxy numeric-column prototypes', async () => {
        const {database, spans, persisted} = await createFixture()
        spans.offsets = new Proxy(spans.offsets, {
            get(target, key) { return Reflect.get(target, key, target) },
            getPrototypeOf() { throw new Error('Unexpected numeric proxy prototype probe') },
        })
        const unregister = register(database, spans, persisted)
        expect(Reflect.get(database, '_inFlightTermContentSourceBatches').size).toBe(1)
        unregister()
    })

    test('retains source view accessors on the general path', async () => {
        const {database, spans, persisted} = await createFixture()
        const get = vi.fn(() => 6)
        Object.defineProperty(spans.buffer, 'byteLength', {get})
        const unregister = register(database, spans, persisted)
        expect(get).toHaveBeenCalledTimes(3)
        unregister()
    })

    test('supports shared numeric columns and overlapping input views', async () => {
        const {database, spans, persisted} = await createFixture()
        const shared = new Uint32Array(new SharedArrayBuffer(12))
        shared.set([1, 1, 1])
        spans.offsets = shared
        spans.lengths = shared
        register(database, spans, persisted)()
        const alias = new Uint32Array([1, 1, 1])
        spans.offsets = alias
        spans.lengths = alias
        const unregister = register(database, spans, persisted)
        expect(Reflect.get(database, '_findInFlightTermContentSource').call(database, 200, 1, 'raw'))
            .toEqual({buffer: spans.buffer, offset: 1, length: 1})
        unregister()
    })

    test('rejects columns detached by memory growth without partial registration', async () => {
        const {database, spans, persisted} = await createFixture()
        const memory = new WebAssembly.Memory({initial: 1, maximum: 2})
        spans.offsets = new Uint32Array(memory.buffer, 0, 3)
        spans.offsets.set([0, 2, 4])
        memory.grow(1)
        expect(() => register(database, spans, persisted)).toThrow('Invalid in-flight term content source at index 0')
        expect(Reflect.get(database, '_inFlightTermContentSourceBatches').size).toBe(0)
    })

    test.each([Number.NaN, 0.5, -1])('rejects a disguised floating-point source offset %s', async (offset) => {
        const {database, spans, persisted} = await createFixture()
        const disguised = new Float64Array([0, 2, offset])
        Object.setPrototypeOf(disguised, Uint32Array.prototype)
        Object.defineProperty(disguised, Symbol.toStringTag, {value: 'Uint32Array'})
        spans.offsets = /** @type {Uint32Array} */ (/** @type {unknown} */ (disguised))
        expect(() => register(database, spans, persisted)).toThrow('Invalid in-flight term content source at index 2')
        expect(Reflect.get(database, '_inFlightTermContentSourceBatches').size).toBe(0)
    })

    test('keeps a disguised DataView on the general indexed-value path', async () => {
        const {database, spans, persisted} = await createFixture()
        const disguised = new DataView(new ArrayBuffer(12))
        Object.assign(disguised, {0: 0, 1: 2, 2: 4})
        Object.setPrototypeOf(disguised, Uint32Array.prototype)
        spans.offsets = /** @type {Uint32Array} */ (/** @type {unknown} */ (disguised))
        const unregister = register(database, spans, persisted)
        expect(Reflect.get(database, '_findInFlightTermContentSource').call(database, 200, 2, 'raw'))
            .toEqual({buffer: spans.buffer, offset: 2, length: 2})
        unregister()
    })

    test.each(['persisted', 'offsets', 'lengths'])('keeps prototype-disguised shared %s columns on the full validator', async (column) => {
        const fixture = await createFixture()
        const {database, spans} = fixture
        const shared = new SharedArrayBuffer(column === 'persisted' ? 24 : 12)
        if (column === 'persisted') {
            const values = new Float64Array(shared)
            values.set(fixture.persisted)
            fixture.persisted = values
        } else {
            const values = new Uint32Array(shared)
            values.set(column === 'offsets' ? spans.offsets : spans.lengths)
            if (column === 'offsets') {
                spans.offsets = values
            } else {
                spans.lengths = values
            }
        }
        Object.setPrototypeOf(shared, ArrayBuffer.prototype)
        expect(shared instanceof ArrayBuffer).toBe(true)
        // The full validator checks source integers as well as persisted
        // offsets. Observe that route deterministically instead of racing a
        // writer thread against unsafe acceptance of shared numeric columns.
        const check = vi.spyOn(Number, 'isSafeInteger')
        let unregister
        try {
            unregister = register(database, spans, fixture.persisted)
            expect(check).toHaveBeenCalledWith(0)
        } finally {
            check.mockRestore()
            unregister?.()
        }
    })

    test('retains fallback for disguised shared aliases and detached buffers', async () => {
        const {database, spans, persisted} = await createFixture()
        const shared = new SharedArrayBuffer(12)
        const values = new Uint32Array(shared)
        values.set([1, 1, 1])
        Object.setPrototypeOf(shared, ArrayBuffer.prototype)
        spans.offsets = values
        spans.lengths = values
        register(database, spans, persisted)()
        const memory = new WebAssembly.Memory({initial: 1, maximum: 2})
        const detached = memory.buffer
        spans.offsets = new Uint32Array(detached, 0, 3)
        spans.offsets.set([0, 2, 4])
        memory.grow(1)
        Object.setPrototypeOf(detached, SharedArrayBuffer.prototype)
        expect(() => register(database, spans, persisted)).toThrow('Invalid in-flight term content source at index 0')
        expect(Reflect.get(database, '_inFlightTermContentSourceBatches').size).toBe(0)
    })

    test('preserves empty-batch bounds', async () => {
        const {database, spans} = await createFixture()
        spans.offsets = new Uint32Array(0)
        spans.lengths = new Uint32Array(0)
        const unregister = register(database, spans, new Float64Array(0))
        expect([...Reflect.get(database, '_inFlightTermContentSourceBatches')]).toMatchObject([
            {minimumOffset: Infinity, maximumOffset: -Infinity, sortedOffsets: true},
        ])
        unregister()
    })
})
