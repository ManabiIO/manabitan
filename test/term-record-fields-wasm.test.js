/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {afterEach, describe, expect, test, vi} from 'vitest'
import {NativeRecordFieldEncoder} from '../ext/js/dictionary/term-record-fields-wasm.js'
import {createArtifactTermRecordChunkWithResolvedContent, TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js'
import {createTermRecordPreinternedPlanBuilder} from '../ext/js/dictionary/term-record-preinterned-plan.js'

const module = new WebAssembly.Module(readFileSync(new URL('../dev/data/dictionary-wasm/term-record-fields-v1.wasm', import.meta.url)))
/** @typedef {ReturnType<typeof fixture>} Fixture */
/** @typedef {Parameters<TermRecordOpfsStore['appendBatchFromArtifactChunkResolvedContent']>[0]} ArtifactChunk */

/**
 * @param {number} [count=128]
 * @returns {ArtifactChunk & {scoreList: Int32Array, termRecordPreinternedPlan: import('../ext/js/dictionary/term-record-preinterned-plan.js').PreinternedTermRecordPlan, resolvedContentReferences: {uniqueIndexList: Uint32Array, offsets: Float64Array, lengths: Uint32Array}}}
 */
function fixture(count = 128) {
    const values = [-256, 255, 256, -257, -2147483648, 2147483647, 0]
    const expression = new TextEncoder().encode('辞書')
    const builder = createTermRecordPreinternedPlanBuilder(1)
    builder.internStringBytes(expression)
    const keys = new Uint32Array(count)
    return createArtifactTermRecordChunkWithResolvedContent(
        {
            dictionary: 'Native record fields', rowCount: count,
            expressionBytesList: new Array(count).fill(expression),
            readingBytesList: new Array(count).fill(expression),
            readingEqualsExpressionList: new Uint8Array(count).fill(1),
            sequenceList: new Int32Array(count).fill(-1),
            termRecordPreinternedPlan: builder.buildPlan(keys, keys),
            scoreList: Int32Array.from({length: count}, (_, index) => values[index % values.length]),
        },
        Uint32Array.from({length: count}, (_, index) => (index * 17) % count),
        Float64Array.from({length: count}, (_, index) => 2 ** 40 + index * 19),
        Uint32Array.from({length: count}, (_, index) => index % 31),
    )
}

/** @returns {Promise<NativeRecordFieldEncoder>} */
async function encoder() {
    const result = new NativeRecordFieldEncoder({loadModule: async () => module})
    expect(await result.prepare()).toBe(true)
    return result
}

/**
 * @param {Fixture} chunk
 * @param {number} [base=2 ** 40]
 * @returns {Uint8Array}
 */
function baseline(chunk, base = 2 ** 40) {
    return new TermRecordOpfsStore()._encodeArtifactRecordFields(chunk, [], [], base)
}

/**
 * @param {Fixture} chunk
 * @param {number} [base=2 ** 40]
 * @returns {Promise<{native: NativeRecordFieldEncoder, bytes: Uint8Array}>}
 */
async function compare(chunk, base = 2 ** 40) {
    const native = await encoder()
    const bytes = native.encode(chunk.rowCount, chunk.scoreList, chunk.resolvedContentReferences, base)
    expect(bytes).not.toBeNull()
    assert.deepEqual(bytes, baseline(chunk, base))
    return {native, bytes: /** @type {Uint8Array} */ (bytes)}
}

/**
 * @param {TermRecordOpfsStore} store
 * @param {Fixture} chunk
 * @param {Map<string, import('../ext/js/dictionary/term-lookup-index-preparation.js').PreparedTermLookupIndex>|null} [prepared=null]
 * @returns {Promise<void>}
 */
async function append(store, chunk, prepared = null) {
    await store._encodeAndAppendArtifactChunkForState(
        /** @type {Parameters<TermRecordOpfsStore['_encodeAndAppendArtifactChunkForState']>[0]} */ ({}),
        chunk, 1, [], [], chunk.termRecordPreinternedPlan, 'raw', prepared,
    )
}

afterEach(() => { vi.restoreAllMocks() })

describe('native compact record fields', () => {
    test('matches exact compact bytes, first-use scores, aliased IDs and owned output', async () => {
        const chunk = fixture()
        chunk.resolvedContentReferences.offsets[2] = -1
        chunk.resolvedContentReferences.lengths[3] = 65534
        chunk.resolvedContentReferences.uniqueIndexList[4] = 3
        chunk.resolvedContentReferences.uniqueIndexList[5] = 3
        const {native, bytes} = await compare(chunk)
        expect(bytes.byteLength).toBe(16 + 7 * 4 + 128 * 8)
        const retained = Uint8Array.from(bytes)
        chunk.scoreList.fill(123)
        chunk.resolvedContentReferences.lengths.fill(19)
        const next = native.encode(chunk.rowCount, chunk.scoreList, chunk.resolvedContentReferences, 2 ** 40)
        assert.deepEqual(next, baseline(chunk))
        assert.deepEqual(bytes, retained)
        expect(bytes.buffer).not.toBe(next?.buffer)
    })

    test.each([-1, 0, -0, 2 ** 40, Number.MAX_SAFE_INTEGER])('preserves offset %s and its supplied base', async (offset) => {
        const chunk = fixture()
        chunk.resolvedContentReferences.offsets.fill(offset)
        await compare(chunk, offset < 0 ? 0 : offset)
    })

    test('accepts the last representable non-null delta and declines the reserved delta', async () => {
        const chunk = fixture()
        chunk.resolvedContentReferences.offsets[0] = 2 ** 40 + 0xfffffffe
        const {native} = await compare(chunk)
        chunk.resolvedContentReferences.offsets[0] = 2 ** 40 + 0xffffffff
        expect(native.encode(chunk.rowCount, chunk.scoreList, chunk.resolvedContentReferences, 2 ** 40)).toBeNull()
    })

    test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -2, 1.5, Number.MAX_SAFE_INTEGER + 1])('declines invalid current offset %s', async (offset) => {
        const chunk = fixture()
        chunk.resolvedContentReferences.offsets[0] = offset
        expect((await encoder()).encode(chunk.rowCount, chunk.scoreList, chunk.resolvedContentReferences, 2 ** 40)).toBeNull()
    })

    test.each([65535, 65536, 0xffffffff])('preserves the JS format fallback for length %i', async (length) => {
        const chunk = fixture()
        chunk.resolvedContentReferences.lengths[0] = length
        const store = new TermRecordOpfsStore()
        store._recordFieldEncoder = await encoder()
        const encode = vi.spyOn(store._recordFieldEncoder, 'encode')
        assert.deepEqual(store._encodeArtifactRecordFields(chunk, [], [], 2 ** 40), baseline(chunk))
        expect(encode).toHaveReturnedWith(null)
    })

    test('keeps the strict compact-size boundary and bounded score table fallback', async () => {
        const native = await encoder()
        for (const count of [5, 6]) {
            const chunk = fixture(count)
            chunk.scoreList.fill(-200)
            const result = native.encode(count, chunk.scoreList, chunk.resolvedContentReferences, 2 ** 40)
            if (count === 5) { expect(result).toBeNull() } else { assert.deepEqual(result, baseline(chunk)) }
        }
        for (const uniqueScores of [1024, 1025]) {
            const chunk = fixture(uniqueScores * 2)
            chunk.scoreList = Int32Array.from({length: chunk.rowCount}, (_, index) => index % uniqueScores)
            const result = native.encode(chunk.rowCount, chunk.scoreList, chunk.resolvedContentReferences, 2 ** 40)
            if (uniqueScores === 1025) { expect(result).toBeNull() } else { assert.deepEqual(result, baseline(chunk)) }
        }
    })

    test.each(['byteOffset', 'byteLength', 'subarray', 'constructor'])('never calls a shadowed %s during marshaling', async (name) => {
        const chunk = fixture()
        for (const column of [chunk.scoreList, ...Object.values(chunk.resolvedContentReferences)]) {
            Object.defineProperty(column, name, {get() { throw new Error(`Unexpected ${name}`) }})
        }
        await compare(chunk)
    })

    test('uses intrinsic buffer identity to reject shared or forged views', async () => {
        const native = await encoder()
        const chunk = fixture()
        const references = chunk.resolvedContentReferences
        const shared = new Uint32Array(new SharedArrayBuffer(references.uniqueIndexList.byteLength))
        shared.set(references.uniqueIndexList)
        expect(native.encode(chunk.rowCount, chunk.scoreList, {...references, uniqueIndexList: shared}, 2 ** 40)).toBeNull()
        const fake = Object.create(Uint32Array.prototype)
        expect(native.encode(chunk.rowCount, chunk.scoreList, {...references, uniqueIndexList: fake}, 2 ** 40)).toBeNull()
        expect(native.encode(chunk.rowCount, chunk.scoreList, {...references, uniqueIndexList: new Proxy(references.uniqueIndexList, {})}, 2 ** 40)).toBeNull()
    })

    test('requires current private chunk origin before entering native code', async () => {
        const chunk = fixture()
        const store = new TermRecordOpfsStore()
        store._recordFieldEncoder = await encoder()
        const encode = vi.spyOn(store._recordFieldEncoder, 'encode')
        assert.deepEqual(store._encodeArtifactRecordFields({...chunk}, [], [], 2 ** 40), baseline(chunk))
        expect(encode).not.toHaveBeenCalled()
        assert.deepEqual(store._encodeArtifactRecordFields(chunk, [], [], 2 ** 40), baseline(chunk))
        expect(encode).toHaveBeenCalledTimes(1)
        chunk.resolvedContentReferences = {...chunk.resolvedContentReferences}
        store._encodeArtifactRecordFields(chunk, [], [], 2 ** 40)
        expect(encode).toHaveBeenCalledTimes(1)
    })

    test('declines aliases of native scratch before growth can detach caller storage', async () => {
        const native = await encoder()
        const chunk = fixture(10_000)
        assert(native._memory)
        const buffer = native._memory.buffer
        const indexes = new Uint32Array(buffer, 0, chunk.rowCount)
        indexes.fill(0)
        const references = {...chunk.resolvedContentReferences, uniqueIndexList: indexes}
        expect(native.encode(chunk.rowCount, chunk.scoreList, references, 2 ** 40)).toBeNull()
        expect(native._memory.buffer).toBe(buffer)
        expect(indexes.length).toBe(chunk.rowCount)
        expect(indexes.every((value) => value === 0)).toBe(true)
    })

    test('preserves fixed-length and float64-score overrides', async () => {
        const chunk = fixture()
        const store = new TermRecordOpfsStore()
        store._recordFieldEncoder = await encoder()
        const encode = vi.spyOn(store._recordFieldEncoder, 'encode')
        const fixed = {...chunk, fixedContentLength: 9, fixedContentOffsetBase: 2 ** 40}
        assert.deepEqual(store._encodeArtifactRecordFields(fixed, [], [], 2 ** 40), new TermRecordOpfsStore()._encodeArtifactRecordFields(fixed, [], [], 2 ** 40))
        const wide = {...chunk, scoreList: new Float64Array(chunk.rowCount).fill(-0)}
        assert.deepEqual(store._encodeArtifactRecordFields(wide, [], [], 2 ** 40), new TermRecordOpfsStore()._encodeArtifactRecordFields(wide, [], [], 2 ** 40))
        expect(encode).not.toHaveBeenCalled()
    })

    test.each(['split-slice', 'prepared-get'])('encodes after %s callbacks mutate validated columns', async (mode) => {
        const outputs = []
        for (const useNative of [false, true]) {
            const chunk = fixture()
            const store = new TermRecordOpfsStore()
            if (useNative) { store._recordFieldEncoder = await encoder() }
            const writes = vi.spyOn(store, '_appendEncodedChunk').mockResolvedValue()
            let mutations = 0
            const mutate = () => {
                ++mutations
                chunk.resolvedContentReferences.lengths.fill(47 + mutations)
                chunk.scoreList.fill(-999 - mutations)
            }
            let prepared = null
            if (mode === 'split-slice') {
                chunk.resolvedContentReferences.uniqueIndexList = Uint32Array.from({length: chunk.rowCount}, (_, index) => index < 64 ? 0 : 1)
                chunk.resolvedContentReferences.offsets = Float64Array.of(16, 16 + 0xffffffff)
                chunk.resolvedContentReferences.lengths = Uint32Array.of(7, 9)
                const original = chunk.expressionBytesList.slice
                chunk.expressionBytesList.slice = function (...args) { mutate(); return original.apply(this, args) }
            } else {
                prepared = store.prepareArtifactChunkLookupIndexes(chunk)?.indexes ?? null
                assert(prepared)
                const original = prepared.get
                prepared.get = function (...args) { mutate(); return original.apply(this, args) }
            }
            await append(store, chunk, prepared)
            outputs.push(writes.mock.calls)
        }
        assert.deepEqual(outputs[1], outputs[0])
    })

    test('revalidates changed columns after awaiting the first split append', async () => {
        const chunk = fixture()
        chunk.resolvedContentReferences.uniqueIndexList = Uint32Array.from({length: chunk.rowCount}, (_, index) => index < 64 ? 0 : 1)
        chunk.resolvedContentReferences.offsets = Float64Array.of(16, 16 + 0xffffffff)
        chunk.resolvedContentReferences.lengths = Uint32Array.of(7, 9)
        const store = new TermRecordOpfsStore()
        store._recordFieldEncoder = await encoder()
        const encode = vi.spyOn(store._recordFieldEncoder, 'encode')
        vi.spyOn(store, '_appendEncodedChunk').mockImplementationOnce(async () => { chunk.resolvedContentReferences.lengths[1] = 0xffffffff })
        await expect(append(store, chunk)).rejects.toThrow('Invalid term content length: 4294967295')
        expect(encode).toHaveBeenCalledTimes(1)
    })

    test.each(['endImportSession', '_abandonImportWritesForRollback', '_prepare'])('releases an import owner before late preparation after %s', async (method) => {
        let resolveModule = /** @type {(value: WebAssembly.Module) => void} */ (() => {})
        const native = new NativeRecordFieldEncoder({loadModule: () => new Promise((resolve) => { resolveModule = resolve })})
        const pending = native.prepare()
        const store = new TermRecordOpfsStore()
        store._recordFieldEncoder = native
        vi.spyOn(store, '_ensureRecordsDirectoryHandle').mockResolvedValue()
        if (method === 'endImportSession') { await store.endImportSession() }
        if (method === '_abandonImportWritesForRollback') { await store._abandonImportWritesForRollback() }
        if (method === '_prepare') { await store._prepare() }
        resolveModule(module)
        expect(await pending).toBe(false)
        expect(await native.prepare()).toBe(false)
        expect(native._memory).toBeNull()
        expect(store._recordFieldEncoder).toBeNull()
    })

    test('retains fallback before readiness, after a module failure, and after a native trap', async () => {
        const chunk = fixture()
        const failed = new NativeRecordFieldEncoder({loadModule: async () => { throw new Error('Unavailable module') }})
        expect(failed.encode(chunk.rowCount, chunk.scoreList, chunk.resolvedContentReferences, 2 ** 40)).toBeNull()
        expect(await failed.prepare()).toBe(false)
        expect(failed.encode(chunk.rowCount, chunk.scoreList, chunk.resolvedContentReferences, 2 ** 40)).toBeNull()
        const native = await encoder()
        native._encode = () => { throw new WebAssembly.RuntimeError('Test trap') }
        expect(native.encode(chunk.rowCount, chunk.scoreList, chunk.resolvedContentReferences, 2 ** 40)).toBeNull()
        expect(native._memory).toBeNull()
    })
})
