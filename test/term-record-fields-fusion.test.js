/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {Buffer} from 'node:buffer'
import {readFileSync} from 'node:fs'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'
import {createImportRecordFieldEncoder} from '../ext/js/dictionary/term-record-fields.js'
import {createOwnedPreparedTermRecordPlan, createOwnedWholePreparedLookupIndexes, getOwnedWholePreparedLookupIndex} from '../ext/js/dictionary/term-record-prepared-fields.js'
import {createArtifactTermRecordChunkWithResolvedContent, TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js'
import {encodePersistedTermLookupIndexFromPreinternedPlan} from '../ext/js/dictionary/term-lookup-index.js'
import {copyWasmBackedColumnChunk, disposeParallelTermBankParser, parseTermBankWithWasmColumnChunksParallel} from '../ext/js/dictionary/term-bank-wasm-parser.js'

/** @typedef {NonNullable<Awaited<ReturnType<typeof createImportRecordFieldEncoder>>>} Encoder */
/** @typedef {import('../ext/js/dictionary/term-record-fields.js').RecordChunk} RecordChunk */
/** @typedef {import('../ext/js/dictionary/term-record-fields.js').References} References */
/** @typedef {import('../ext/js/dictionary/term-record-preinterned-plan.js').PreinternedTermRecordPlan} Plan */
/** @typedef {import('../ext/js/dictionary/term-lookup-index-preparation.js').PreparedTermLookupIndex} Prepared */
/** @typedef {{dictionary: string, rowCount: number, expressionBytesList: Uint8Array[], readingBytesList: Uint8Array[], readingEqualsExpressionList: Uint8Array, sequenceList: Int32Array, scoreList: Int32Array, resolvedContentReferences: References, preparedLookupIndexes?: Map<string, Prepared>}} FixtureChunk */
/** @typedef {{chunk: FixtureChunk, plan: Plan, bytes: Uint8Array, indexes: Map<string, Prepared>, entry: Prepared|undefined}} Fixture */
/** @typedef {Parameters<TermRecordOpfsStore['_appendEncodedChunk']>} AppendArguments */
/** @type {Encoder[]} */
let encoders = []
/** @type {WeakMap<object, References>} */
const references = new WeakMap()

/**
 * @param {number} [count]
 * @returns {Fixture}
 */
function fixture(count = 64) {
    const plan = createOwnedPreparedTermRecordPlan(
        new Uint16Array([1]),
        new Uint32Array([0]),
        new Uint32Array([42]),
        new Uint8Array([120]),
        new Uint32Array(count),
        new Uint32Array(count).fill(0xffffffff),
    )
    const readingEqualsExpressionList = new Uint8Array(count).fill(1)
    const sequenceList = new Int32Array(count).fill(-1)
    const bytes = encodePersistedTermLookupIndexFromPreinternedPlan(plan, readingEqualsExpressionList, sequenceList, count)
    const indexes = createOwnedWholePreparedLookupIndexes(count, bytes, plan)
    if (indexes === null) { throw new Error('Expected owned whole metadata') }
    const chunk = createArtifactTermRecordChunkWithResolvedContent({
        dictionary: 'fusion',
        rowCount: count,
        expressionBytesList: Array.from({length: count}, () => new Uint8Array([120])),
        readingBytesList: Array.from({length: count}, () => new Uint8Array()),
        readingEqualsExpressionList,
        sequenceList,
        scoreList: Int32Array.from({length: count}, (_, i) => [7, -2147483648, 2147483647][i % 3]),
    }, Uint32Array.from({length: count}, (_, i) => i % 2), new Float64Array([200, 100]), new Uint32Array([3, 4]), indexes)
    references.set(chunk, chunk.resolvedContentReferences)
    return {chunk, plan, bytes, indexes, entry: indexes.get(`0:${count}`)}
}

/**
 * @param {RecordChunk} chunk
 * @returns {References|null}
 */
function privateReferences(chunk) { return references.get(chunk) ?? null }

/** @returns {Promise<Encoder>} */
async function encoder() {
    const value = await createImportRecordFieldEncoder()
    if (value === null) { throw new Error('Expected the focused test native instance') }
    encoders.push(value)
    return value
}

/**
 * Explicit ready-instance injection is only a focused dispatch seam. It is
 * not a normal-startup import test and makes no readiness or timing claim.
 * @param {Encoder|null} native
 * @returns {{store: TermRecordOpfsStore, appended: AppendArguments[]}}
 */
function storeFixture(native) {
    const store = new TermRecordOpfsStore()
    store._importRecordFieldSession = {encoder: native, calls: 0, javascriptCalls: 0}
    /** @type {AppendArguments[]} */
    const appended = []
    vi.spyOn(store, '_appendEncodedChunk').mockImplementation(async (...args) => { appended.push(args) })
    return {store, appended}
}

/**
 * @param {TermRecordOpfsStore} store
 * @param {Fixture} value
 * @returns {ReturnType<TermRecordOpfsStore['_encodeAndAppendArtifactChunkForState']>}
 */
async function append(store, value) {
    return await store._encodeAndAppendArtifactChunkForState(
        /** @type {Parameters<TermRecordOpfsStore['_encodeAndAppendArtifactChunkForState']>[0]} */ ({}),
        value.chunk,
        1,
        [],
        [],
        value.plan,
        'raw',
        value.indexes,
    )
}

/**
 * @param {Uint8Array|null|undefined} actual
 * @param {Uint8Array|null|undefined} expected
 */
function bytesEqual(actual, expected) {
    if (!(actual instanceof Uint8Array) || !(expected instanceof Uint8Array)) { throw new Error('Expected complete field buffers') }
    expect(actual.byteLength).toBe(expected.byteLength)
    expect(Buffer.compare(Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength), Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength))).toBe(0)
}

beforeEach(() => {
    encoders = []
    vi.stubGlobal('fetch', vi.fn(async (/** @type {URL|string} */ input) => {
        const url = new URL(String(input))
        const bytes = readFileSync(url)
        return new Response(new Uint8Array(bytes).buffer)
    }))
})

afterEach(async () => {
    await disposeParallelTermBankParser()
    for (const value of encoders) { value.dispose() }
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

describe('owned whole lookup metadata', () => {
    test('unknown maps and proxy columns decline without invoking their traps', () => {
        const value = fixture()
        const trap = vi.fn(() => { throw new Error('Unknown proxy inspection') })
        expect(getOwnedWholePreparedLookupIndex(new Proxy(value.indexes, {get: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap}), 64)).toBeNull()
        expect(createOwnedWholePreparedLookupIndexes(64, value.bytes, new Proxy(value.plan, {get: trap, getPrototypeOf: trap}))).toBeNull()
        const plan = createOwnedPreparedTermRecordPlan(new Proxy(value.plan.stringLengths, {get: trap, getPrototypeOf: trap}), void 0, void 0, value.plan.stringsBuffer, value.plan.expressionIndexes, value.plan.readingIndexes)
        const indexes = createOwnedWholePreparedLookupIndexes(64, value.bytes, plan)
        expect(getOwnedWholePreparedLookupIndex(indexes, 64)).toBeNull()
        expect(trap).not.toHaveBeenCalled()
        expect(getOwnedWholePreparedLookupIndex(new Map(value.indexes), 64)).toBeNull()
    })

    test('replaced entry and nested plan data decline without reading getters', () => {
        const value = fixture()
        expect(getOwnedWholePreparedLookupIndex(value.indexes, 64)).toBe(value.entry)
        const getter = vi.fn(() => { throw new Error('Nested getter') })
        Object.defineProperty(value.plan, 'stringLengths', {get: getter, configurable: true})
        expect(getOwnedWholePreparedLookupIndex(value.indexes, 64)).toBeNull()
        expect(getter).not.toHaveBeenCalled()
        const other = fixture()
        if (typeof other.entry === 'undefined') { throw new Error('Missing entry') }
        other.indexes.set('0:64', {...other.entry})
        expect(getOwnedWholePreparedLookupIndex(other.indexes, 64)).toBeNull()
    })

    test.each(['get', 'has', 'size'])('rejects an own Map %s getter before reading it', (key) => {
        const value = fixture()
        const getter = vi.fn(() => { throw new Error('Map accessor') })
        Object.defineProperty(value.indexes, key, {get: getter})
        expect(getOwnedWholePreparedLookupIndex(value.indexes, 64)).toBeNull()
        expect(getter).not.toHaveBeenCalled()
    })

    test.each(['length', 'byteLength', 'byteOffset', 'buffer', Symbol.toStringTag])('rejects shadowed view property %s without reading it', (key) => {
        const value = fixture()
        const getter = vi.fn(() => { throw new Error('View accessor') })
        Object.defineProperty(value.plan.stringLengths, key, {get: getter})
        expect(getOwnedWholePreparedLookupIndex(value.indexes, 64)).toBeNull()
        expect(getter).not.toHaveBeenCalled()
    })

    test('rejects forged element kinds and shared, resizable or detached backing', () => {
        for (const kind of ['forged', 'shared', 'resizable', 'detached']) {
            const value = fixture()
            /** @type {Uint8Array|Uint16Array} */
            let lengths
            switch (kind) {
                case 'forged':
                    lengths = new Uint8Array([1, 0])
                    Object.setPrototypeOf(lengths, Uint16Array.prototype)
                    break
                case 'shared':
                    lengths = new Uint16Array(new SharedArrayBuffer(2))
                    break
                case 'resizable': {
                    const Resizable = /** @type {new (bytes: number, options: {maxByteLength: number}) => ArrayBuffer} */ (ArrayBuffer)
                    lengths = new Uint16Array(new Resizable(2, {maxByteLength: 4}))
                    break
                }
                case 'detached':
                    lengths = new Uint16Array([1])
                    structuredClone(lengths.buffer, {transfer: [lengths.buffer]})
                    break
                default:
                    throw new Error('Unexpected focused backing case')
            }
            const plan = createOwnedPreparedTermRecordPlan(/** @type {Uint16Array} */ (lengths), void 0, void 0, value.plan.stringsBuffer, value.plan.expressionIndexes, value.plan.readingIndexes)
            expect(getOwnedWholePreparedLookupIndex(createOwnedWholePreparedLookupIndexes(64, value.bytes, plan), 64)).toBeNull()
        }
    })
})

describe('whole native field pass', () => {
    test.each([
        {offsets: [200, 100], base: 100},
        {offsets: [-1, -1], base: 0},
        {offsets: [0, -0], base: -0},
        {offsets: [-0, 0], base: -0},
        {offsets: [0, 0xfffffffe], base: 0},
        {offsets: [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 7], base: Number.MAX_SAFE_INTEGER - 7},
    ])('matches complete stock bytes and exact base for $offsets', async ({offsets, base}) => {
        const value = fixture()
        value.chunk.resolvedContentReferences.offsets.set(offsets)
        const native = await encoder()
        const actual = native.tryEncodeWhole(value.chunk, 64, privateReferences, () => true)
        expect(actual.copied).toBe(true)
        expect(Object.is(actual.contentOffsetBase, base)).toBe(true)
        const expected = new TermRecordOpfsStore()._encodeArtifactRecordFields(value.chunk, [], [], base)
        bytesEqual(actual.recordFields, expected)
        expect(native.getDiagnostics().inputCopiedBytes).toBe(64 * 8 + 2 * 12)
        expect(native.getDiagnostics().outputCopiedBytes).toBe(expected.byteLength + 8)
    })

    test('ignores unreferenced invalid slots and preserves owning output across reuse', async () => {
        const value = fixture()
        value.chunk.resolvedContentReferences.uniqueIndexList.fill(0)
        value.chunk.resolvedContentReferences.offsets[1] = Number.NaN
        value.chunk.resolvedContentReferences.lengths[1] = 0xffffffff
        const native = await encoder()
        const first = native.tryEncodeWhole(value.chunk, 64, privateReferences, () => true)
        const expected = new TermRecordOpfsStore()._encodeArtifactRecordFields(value.chunk, [], [], 200)
        bytesEqual(first.recordFields, expected)
        value.chunk.resolvedContentReferences.offsets[0] = 700
        value.chunk.scoreList.fill(-3)
        expect(native.tryEncodeWhole(value.chunk, 64, privateReferences, () => true).contentOffsetBase).toBe(700)
        bytesEqual(first.recordFields, expected)
    })

    test('declines larger spans and the strict compact cutoff without publishing a base', async () => {
        const wide = fixture()
        wide.chunk.resolvedContentReferences.offsets.set([0, 0xffffffff])
        const native = await encoder()
        const attempt = native.tryEncodeWhole(wide.chunk, 64, privateReferences, () => true)
        expect(attempt).toEqual({recordFields: null, contentOffsetBase: 0, copied: true})
        for (const count of [5, 6]) {
            const value = fixture(count)
            value.chunk.scoreList.fill(1)
            const result = native.tryEncodeWhole(value.chunk, count, privateReferences, () => true)
            expect(result.recordFields === null).toBe(count === 5)
        }
    })

    test('renews metadata admission after the private selector before any copy', async () => {
        const value = fixture()
        const native = await encoder()
        const selector = vi.fn((chunk) => {
            Object.defineProperty(value.indexes, 'get', {value: () => value.entry})
            return privateReferences(chunk)
        })
        const result = native.tryEncodeWhole(value.chunk, 64, selector, () => getOwnedWholePreparedLookupIndex(value.indexes, 64) !== null)
        expect(result.copied).toBe(false)
        expect(result.recordFields).toBeNull()
        expect(selector).toHaveBeenCalledTimes(1)
        expect(native.getDiagnostics()).toMatchObject({inputCopiedBytes: 0, nativeAttempts: 0, wholeAdmissionDeclines: {'prepared-metadata': 1}, declines: {}})
    })

    test('the private returned-base slot rejects overlap, misalignment and out-of-bounds before arena writes', () => {
        const memory = new WebAssembly.Memory({initial: 4, maximum: 1024})
        const module = new WebAssembly.Module(readFileSync(new URL('../ext/lib/term-record-fields.wasm', import.meta.url)))
        const instance = new WebAssembly.Instance(module, {env: {memory}})
        const encode = instance.exports.encode_whole_record_fields
        if (typeof encode !== 'function') { throw new Error('Missing whole encoder') }
        const row = 131072
        const score = row + 256
        const offset = score + 256
        const length = offset + 16
        const slots = length + 8
        const dictionary = slots + 512
        const keys = dictionary + 256
        const output = keys + 128
        const base = output + 768
        new Uint8Array(memory.buffer).fill(19)
        // The first128KiB are the reserved native stack/data prefix. The
        // range checker may use its stack while rejecting caller arguments.
        // eslint-disable-next-line unicorn/prefer-spread -- Keep an independent typed byte snapshot for complete Buffer comparison.
        const before = new Uint8Array(memory.buffer, 131072).slice()
        for (const target of [0, row, score, offset, length, slots, dictionary, keys, output, base + 4, memory.buffer.byteLength]) {
            expect(encode(64, 2, row, score, offset, length, slots, 128, dictionary, keys, output, 768, target)).toBeLessThan(0)
            bytesEqual(new Uint8Array(memory.buffer, 131072), before)
        }
    })
})

describe('whole owner integration and fallbacks', () => {
    test('uses one owned native result and preserves the ordinary async encoder boundary', async () => {
        const value = fixture()
        const native = await encoder()
        const {store, appended} = storeFixture(native)
        const whole = vi.spyOn(native, 'tryEncodeWhole')
        const normal = vi.spyOn(native, 'tryEncode')
        const encoded = vi.spyOn(store, '_encodeArtifactChunkRecords')
        const promise = append(store, value)
        expect(whole).toHaveBeenCalledTimes(1)
        expect(encoded).toHaveBeenCalledTimes(1)
        expect(appended).toHaveLength(0)
        await promise
        expect(normal).not.toHaveBeenCalled()
        expect(appended).toHaveLength(1)
        expect(appended[0][4]).toBe(100)
        bytesEqual(appended[0][6], new TermRecordOpfsStore()._encodeArtifactRecordFields(value.chunk, [], [], 100))
        expect(store._getImportRecordFieldMetrics()).toMatchObject({calls: 1, javascriptCalls: 0, native: {nativeCalls: 1, nativeRows: 64, nativeAttempts: 1, wholeNativeCalls: 1, wholeNativeRows: 64, wholeNativeAttempts: 1}})
    })

    test('refreshes rowCount after an existing completeness callback', async () => {
        const value = fixture()
        const native = await encoder()
        const {store} = storeFixture(native)
        const whole = vi.spyOn(native, 'tryEncodeWhole')
        Object.defineProperty(value.indexes, 'has', {configurable: true,
            value(key) {
                delete /** @type {{has?: unknown}} */ (value.indexes).has
                value.chunk.rowCount = 63
                return Map.prototype.has.call(this, key)
            }})
        await append(store, value)
        expect(whole).toHaveBeenCalledTimes(1)
        expect(whole.mock.results[0].value).toEqual({recordFields: null, contentOffsetBase: 0, copied: false})
        expect(native.getDiagnostics()).toMatchObject({nativeAttempts: 1, nativeRows: 63, wholeAdmissionDeclines: {eligibility: 1}, declines: {}})
    })

    test('rejects entry replacement after completeness and reads current column values', async () => {
        const value = fixture()
        if (typeof value.entry === 'undefined') { throw new Error('Missing entry') }
        const native = await encoder()
        const {store, appended} = storeFixture(native)
        const whole = vi.spyOn(native, 'tryEncodeWhole')
        const original = value.entry
        Object.defineProperty(value.indexes, 'has', {configurable: true,
            value(key) {
                delete /** @type {{has?: unknown}} */ (value.indexes).has
                value.indexes.set('0:64', {...original})
                value.chunk.resolvedContentReferences.offsets.set([901, 900])
                value.chunk.scoreList.fill(-47)
                return Map.prototype.has.call(this, key)
            }})
        await append(store, value)
        expect(whole).not.toHaveBeenCalled()
        expect(appended[0][4]).toBe(900)
        bytesEqual(appended[0][6], new TermRecordOpfsStore()._encodeArtifactRecordFields(value.chunk, [], [], 900))
    })

    test('preserves completeness Reflect.get order before encoding current references', async () => {
        const value = fixture()
        if (typeof value.entry === 'undefined') { throw new Error('Missing entry') }
        const entry = value.entry
        const getter = vi.fn(() => {
            Object.defineProperty(entry, 'bytes', {value: value.bytes, writable: true, configurable: true})
            value.chunk.resolvedContentReferences.offsets.set([501, 500])
            value.chunk.scoreList.fill(-71)
            return value.bytes
        })
        Object.defineProperty(entry, 'bytes', {get: getter, configurable: true})
        const native = await encoder()
        const {store, appended} = storeFixture(native)
        await append(store, value)
        expect(getter).toHaveBeenCalledTimes(1)
        expect(appended[0][4]).toBe(500)
        bytesEqual(appended[0][6], new TermRecordOpfsStore()._encodeArtifactRecordFields(value.chunk, [], [], 500))
        expect(native.getDiagnostics().nativeCalls).toBe(1)
    })

    test('an inherited score length hook stays on the original side of the late Map.get', async () => {
        const value = fixture()
        const native = await encoder()
        const {store} = storeFixture(native)
        /** @type {unknown} */
        const typedPrototype = Object.getPrototypeOf(Int32Array.prototype)
        const intrinsic = Object.getOwnPropertyDescriptor(typedPrototype, 'length')?.get
        if (typeof intrinsic !== 'function') { throw new Error('Missing intrinsic length') }
        const events = []
        const lateGet = vi.fn((key) => {
            events.push('late-get')
            return Map.prototype.get.call(value.indexes, key)
        })
        const getter = vi.fn(function readInheritedLength() {
            events.push('score-length')
            delete /** @type {{length?: unknown}} */ (Int32Array.prototype).length
            Object.defineProperty(value.indexes, 'get', {value: lateGet, configurable: true})
            return intrinsic.call(this)
        })
        // eslint-disable-next-line no-extend-native -- One-shot adversarial getter is removed by the getter and in finally.
        Object.defineProperty(Int32Array.prototype, 'length', {get: getter, configurable: true})
        try {
            await append(store, value)
        } finally {
            delete /** @type {{length?: unknown}} */ (Int32Array.prototype).length
        }
        // The stock map.get already happened when the normal field selector
        // invokes the one-shot inherited getter. Fusion must not move it ahead.
        expect(getter).toHaveBeenCalledTimes(1)
        expect(lateGet).not.toHaveBeenCalled()
        expect(events).toEqual(['score-length'])
        expect(native.getDiagnostics()).toMatchObject({nativeAttempts: 1, nativeCalls: 1, wholeAdmissionDeclines: {'view-prototype': 1}, declines: {}})
    })

    test.each(['column-proxy', 'view-prototype', 'buffer-prototype'])('%s keeps exactly the stock callback sequence on fallback', async (kind) => {
        /** @type {string[][]} */
        const observations = []
        /** @type {Uint8Array[]} */
        const outputs = []
        for (const owned of [false, true]) {
            const value = fixture()
            if (!owned) { value.indexes = new Map(value.indexes) }
            const events = []
            const column = value.chunk.resolvedContentReferences.uniqueIndexList
            if (kind === 'column-proxy') {
                value.chunk.resolvedContentReferences.uniqueIndexList = new Proxy(column, {
                    getPrototypeOf(target) { events.push('prototype'); return Object.getPrototypeOf(target) },
                    get(target, key) { events.push(String(key)); return Reflect.get(target, key, target) },
                })
            } else if (kind === 'view-prototype') {
                Object.setPrototypeOf(column, new Proxy({}, {
                    getPrototypeOf() { events.push('view-prototype'); return Uint32Array.prototype },
                    get(_target, key) { events.push(String(key)); return Reflect.get(Uint32Array.prototype, key, column) },
                }))
            } else {
                Object.setPrototypeOf(column.buffer, new Proxy({}, {
                    getPrototypeOf() { events.push('buffer-prototype'); return ArrayBuffer.prototype },
                }))
            }
            const native = await encoder()
            const {store, appended} = storeFixture(native)
            await append(store, value)
            observations.push(events)
            const bytes = appended[0][6]
            if (!(bytes instanceof Uint8Array)) { throw new Error('Missing fields') }
            outputs.push(bytes)
            expect(native.getDiagnostics().nativeAttempts).toBe(kind === 'buffer-prototype' ? 1 : 0)
            expect(store._getImportRecordFieldMetrics()).toMatchObject({calls: 1, javascriptCalls: kind === 'buffer-prototype' ? 0 : 1})
        }
        expect(observations[1]).toEqual(observations[0])
        bytesEqual(outputs[1], outputs[0])
    })

    test('records one final decline for pre-copy eligibility and memory-growth failures', async () => {
        for (const failure of ['eligibility', 'memory-growth']) {
            const value = fixture()
            if (failure === 'eligibility') {
                Object.defineProperty(value.chunk, 'scoreList', {value: new Float64Array(64).fill(3)})
            }
            const native = await encoder()
            const {store} = storeFixture(native)
            const growth = failure === 'memory-growth' ? vi.spyOn(WebAssembly.Memory.prototype, 'grow').mockImplementationOnce(() => { throw new Error('Focused growth failure') }) : null
            await append(store, value)
            growth?.mockRestore()
            const diagnostics = native.getDiagnostics()
            expect(diagnostics.nativeAttempts).toBe(0)
            expect(diagnostics.wholeNativeAttempts).toBe(0)
            expect(diagnostics.inputCopiedBytes).toBe(0)
            expect(diagnostics.wholeAdmissionDeclines[failure]).toBe(1)
            expect(diagnostics.declines).toEqual(failure === 'eligibility' ? {eligibility: 1} : {unavailable: 1})
            expect(store._getImportRecordFieldMetrics()).toMatchObject({calls: 1, javascriptCalls: 1})
        }
    })

    test('a copied unsplit decline is committed once and never repeats input copies', async () => {
        const value = fixture()
        value.chunk.resolvedContentReferences.lengths[0] = 65535
        const native = await encoder()
        const normal = vi.spyOn(native, 'tryEncode')
        const {store, appended} = storeFixture(native)
        await append(store, value)
        expect(normal).not.toHaveBeenCalled()
        expect(native.getDiagnostics()).toMatchObject({nativeAttempts: 1, wholeNativeAttempts: 1, wholeNativeCalls: 0, wholeNativeRows: 0, inputCopiedBytes: 64 * 8 + 2 * 12, declines: {'unsupported-compact': 1}, wholeCopiedDeclines: {'unsupported-compact': 1}})
        expect(store._getImportRecordFieldMetrics()).toMatchObject({calls: 1, javascriptCalls: 1})
        bytesEqual(appended[0][6], new TermRecordOpfsStore()._encodeArtifactRecordFields(value.chunk, [], [], 100))
        native.commitWholeFallback({recordFields: null, contentOffsetBase: 0, copied: true})
        expect(native.getDiagnostics().declines).toEqual({'unsupported-compact': 1})
    })

    test('a copied whole-span decline does not suppress later genuine split runs', async () => {
        const value = fixture()
        value.chunk.resolvedContentReferences.uniqueIndexList.fill(0, 0, 32)
        value.chunk.resolvedContentReferences.uniqueIndexList.fill(1, 32)
        value.chunk.resolvedContentReferences.offsets.set([0, 0xffffffff])
        const native = await encoder()
        const normal = vi.spyOn(native, 'tryEncode')
        const {store, appended} = storeFixture(native)
        await append(store, value)
        expect(appended.map((args) => args[2])).toEqual([32, 32])
        expect(appended.map((args) => args[4])).toEqual([0, 0xffffffff])
        expect(normal).toHaveBeenCalledTimes(2)
        expect(native.getDiagnostics()).toMatchObject({nativeAttempts: 3, nativeCalls: 2, nativeRows: 64, wholeNativeAttempts: 1, wholeNativeCalls: 0, wholeNativeRows: 0, declines: {}, wholeCopiedDeclines: {'unsupported-compact': 1}})
        expect(store._getImportRecordFieldMetrics()).toMatchObject({calls: 2, javascriptCalls: 0})
    })

    test('routeFilter stays a late read after the existing encoding await', async () => {
        const value = fixture()
        if (typeof value.entry === 'undefined') { throw new Error('Missing entry') }
        const native = await encoder()
        const {store, appended} = storeFixture(native)
        store._rawTermBankSourceBytes = 1024 ** 3
        const promise = append(store, value)
        const route = new Uint32Array([17])
        const getter = vi.fn(() => route)
        Object.defineProperty(value.entry, 'routeFilter', {get: getter, configurable: true})
        expect(getter).not.toHaveBeenCalled()
        expect(appended).toHaveLength(0)
        await promise
        expect(getter).toHaveBeenCalledTimes(1)
        expect(appended[0][8]).toBe(route)
        expect(native.getDiagnostics().nativeCalls).toBe(1)
    })
})

describe('producer and structured-clone ownership', () => {
    /**
     * @param {Fixture} value
     * @returns {Parameters<typeof copyWasmBackedColumnChunk>[0]}
     */
    function sourceChunk(value) {
        return {
            ...value.chunk,
            contentHash1List: new Uint32Array(value.chunk.rowCount),
            contentHash2List: new Uint32Array(value.chunk.rowCount),
            contentBytesList: [],
            contentBytesBuffer: new Uint8Array(),
            contentBytesBaseOffset: 0,
            contentBytesLength: 0,
            contentMetaList: new Uint32Array(),
            contentUniqueIndexList: null,
            contentDedupPlan: null,
            termRecordPreinternedPlan: value.plan,
            preparedLookupIndexes: value.indexes,
            mediaRows: [],
        }
    }

    test('copied whole metadata is owned without an extra source rowCount read', () => {
        const value = fixture()
        const source = sourceChunk(value)
        const getter = vi.fn(() => 64)
        Object.defineProperty(source, 'rowCount', {get: getter, enumerable: true})
        const result = copyWasmBackedColumnChunk(source)
        expect(getter).toHaveBeenCalledTimes(1)
        expect(getOwnedWholePreparedLookupIndex(result.preparedLookupIndexes ?? null, 64)).not.toBeNull()
        const clone = structuredClone(result)
        expect(getOwnedWholePreparedLookupIndex(clone.preparedLookupIndexes ?? null, 64)).toBeNull()
    })

    test('receiver renews fresh whole wrappers after clone before publishing the chunk', async () => {
        const source = sourceChunk(fixture())
        /** @type {Array<ReturnType<typeof sourceChunk>>} */
        const messages = []
        class CloneWorker {
            /** @type {Map<string, Set<(event: MessageEvent<unknown>) => void>>} */
            listeners = new Map()
            /**
             * @param {string} type
             * @param {(event: MessageEvent<unknown>) => void} listener
             */
            addEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener)) }
            /**
             * @param {string} type
             * @param {(event: MessageEvent<unknown>) => void} listener
             */
            removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener) }
            /** @param {{type: string, id?: number}} message */
            postMessage(message) {
                queueMicrotask(() => {
                    const chunk = structuredClone(source)
                    if (message.type !== 'initialize') { messages.push(chunk) }
                    const data = message.type === 'initialize' ?
{type: 'ready'} :
{
    type: 'result',
    id: message.id,
    rowCount: 64,
    resultSentEpochMs: Date.now(),
    chunk,
    ownsContentBytes: false,
    borrowsWorkerMemory: false,
    profile: {chunkDispatchMs: 0},
}
                    for (const listener of this.listeners.get('message') ?? []) { listener(new MessageEvent('message', {data})) }
                })
            }

            terminate() {}
        }
        vi.stubGlobal('Worker', CloneWorker)
        let received = 0
        const used = await parseTermBankWithWasmColumnChunksParallel(
            Array.from({length: 4}, () => new TextEncoder().encode('[]')),
            3,
            (chunk) => {
                ++received
                const entry = getOwnedWholePreparedLookupIndex(chunk.preparedLookupIndexes ?? null, 64)
                expect(entry).not.toBeNull()
                expect(entry?.preinternedPlan).toBe(chunk.termRecordPreinternedPlan)
                expect(entry?.preinternedPlan.stringsBuffer.buffer).toBe(chunk.termRecordPreinternedPlan.stringsBuffer.buffer)
            },
            {prepareLookupIndexes: true, emitContentSlab: true},
        )
        expect(used).toBe(true)
        expect(received).toBeGreaterThan(0)
        expect(messages).toHaveLength(received)
    })
})
