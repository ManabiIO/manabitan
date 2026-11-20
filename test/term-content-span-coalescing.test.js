/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {afterAll, beforeAll, beforeEach, describe, expect, test, vi} from 'vitest'
import {TermContentBlockStore} from '../ext/js/dictionary/term-content-block-store.js'
import {TermContentOpfsStore} from '../ext/js/dictionary/term-content-opfs-store.js'
import {
    beginCompressWrappedTermContentZstdSpansBatch,
    compressWrappedTermContentZstd,
    compressWrappedTermContentZstdSpansBatch,
    finishWrappedTermContentZstdSpans,
    initializeTermContentZstd,
    prepareWrappedTermContentZstdSpans,
} from '../ext/js/dictionary/zstd-term-content.js'

vi.mock('../ext/js/dictionary/zstd-term-content.js', async (importOriginal) => {
    const actual = /** @type {typeof import('../ext/js/dictionary/zstd-term-content.js')} */ (await importOriginal())
    /** @type {typeof actual.compressWrappedTermContentZstdSpansBatch} */
    const compressSpans = async (source, offsets, lengths, starts, blockLengths, dictName, options) => ({
        chunks: Array.from(blockLengths, (bytes, block) => actual.compressWrappedTermContentZstdSpans(
            source,
            offsets.subarray(starts[block], starts[block + 1]),
            lengths.subarray(starts[block], starts[block + 1]),
            bytes,
            dictName,
            options,
        ).bytes),
        envelopeMs: 0,
        wrapped: true,
    })
    /** @type {typeof actual.beginCompressWrappedTermContentZstdSpansBatch} */
    const beginCompression = (...args) => {
        const completion = compressSpans(...args)
        return {sourceConsumed: completion.then(() => {}), completion}
    }
    return {
        ...actual,
        compressWrappedTermContentZstdSpansBatch: vi.fn(compressSpans),
        beginCompressWrappedTermContentZstdSpansBatch: vi.fn(beginCompression),
    }
})

const originalFetch = globalThis.fetch
beforeAll(async () => {
    globalThis.fetch = async (input, init) => {
        const resource = new URL(String(input))
        if (resource.protocol !== 'file:') { return await originalFetch(input, init) }
        return new Response(await readFile(resource), {headers: {'Content-Type': 'application/wasm'}})
    }
    await initializeTermContentZstd()
})
afterAll(() => { globalThis.fetch = originalFetch })
beforeEach(() => { vi.clearAllMocks() })

/** @typedef {NonNullable<Awaited<ReturnType<TermContentBlockStore['tryAppendSpans']>>>} StoredResult */

/**
 * @param {number} length
 * @param {number} [alignment]
 * @returns {Uint8Array}
 */
function createSource(length, alignment = 0) {
    const source = new Uint8Array(new SharedArrayBuffer(length + alignment + 8), alignment, length)
    for (let i = 0; i < source.length; ++i) { source[i] = (i * 23 + (i >>> 4)) & 0xff }
    return source
}

/**
 * @param {Uint32Array} values
 * @returns {Uint32Array}
 */
function sharedColumn(values) {
    const result = new Uint32Array(new SharedArrayBuffer(values.byteLength))
    result.set(values)
    return result
}

/**
 * @param {number} blockTargetBytes
 * @returns {{contentStore: TermContentOpfsStore, blockStore: TermContentBlockStore}}
 */
function createStore(blockTargetBytes) {
    const contentStore = new TermContentOpfsStore()
    const blockStore = new TermContentBlockStore(contentStore, {
        blockTargetBytes,
        referencePackTargetBytes: 80,
        minInputBytes: 0,
    })
    return {contentStore, blockStore}
}

/**
 * @param {string} mode
 * @param {TermContentBlockStore} store
 * @param {Uint8Array} source
 * @param {Uint32Array} offsets
 * @param {Uint32Array} lengths
 * @returns {Promise<StoredResult>}
 */
async function append(mode, store, source, offsets, lengths) {
    if (mode === 'reserved') {
        const operation = store.tryBeginAppendSpans(source, offsets, lengths, 'jmdict', true)
        if (operation === null) { throw new Error('Expected shared append reservation') }
        await operation.sourceConsumed
        return await operation.completion
    }
    const result = await store.tryAppendSpans(source, offsets, lengths, 'jmdict', true)
    if (result === null) { throw new Error('Expected shared append') }
    return result
}

/**
 * @param {{contentStore: TermContentOpfsStore}} store
 * @returns {Promise<Uint8Array|null>}
 */
async function storedBytes(store) {
    return await store.contentStore.readSlice(0, Reflect.get(store.contentStore, '_length'))
}

describe('bounded compression span coalescing', () => {
    test.each([
        {mode: 'reserved', alignment: 0},
        {mode: 'reserved', alignment: 3},
        {mode: 'completed', alignment: 0},
        {mode: 'completed', alignment: 3},
    ])('preserves all compressed frames and row references for $mode appends at alignment $alignment', async ({mode, alignment}) => {
        const source = createSource(32, alignment)
        const offsets = Uint32Array.from({length: 16}, (_, i) => i * 2)
        const lengths = new Uint32Array(16).fill(2)
        const candidate = createStore(8)
        const control = createStore(8)
        const stored = await append(mode, candidate.blockStore, source, offsets, lengths)
        const baseline = await append(mode, control.blockStore, source, sharedColumn(offsets), sharedColumn(lengths))
        const dispatch = mode === 'reserved' ?
            vi.mocked(beginCompressWrappedTermContentZstdSpansBatch) :
            vi.mocked(compressWrappedTermContentZstdSpansBatch)
        expect(dispatch).toHaveBeenCalledTimes(2)
        const [, runs, runLengths, runStarts, blockLengths] = dispatch.mock.calls[0]
        expect(runs).toEqual(Uint32Array.of(0, 8, 16, 24))
        expect(runLengths).toEqual(Uint32Array.of(8, 8, 8, 8))
        expect(runStarts).toEqual(Uint32Array.of(0, 1, 2, 3, 4))
        expect(blockLengths).toEqual(Uint32Array.of(8, 8, 8, 8))
        expect(dispatch.mock.calls[1][1]).toHaveLength(offsets.length)
        expect(stored.contentOffsets).toEqual(baseline.contentOffsets)
        expect(stored.contentLengths).toBe(lengths)
        expect(await storedBytes(candidate)).toEqual(await storedBytes(control))
        for (let i = 0; i < lengths.length; ++i) {
            expect(await candidate.blockStore.read(stored.contentOffsets[i], lengths[i], stored.contentDictName))
                .toEqual(source.slice(offsets[i], offsets[i] + lengths[i]))
        }
    })

    test('keeps zero-length entries and oversized-entry boundaries in the original reference plan', async () => {
        const source = createSource(40, 5)
        const offsets = Uint32Array.of(0, 0, 1, 2, 3, 4, 4, 4, 16, 28, 28, 29, 30, 31, 32, 32)
        const lengths = Uint32Array.of(0, 1, 1, 1, 1, 0, 0, 0, 12, 0, 1, 1, 1, 1, 0, 0)
        const candidate = createStore(4)
        const control = createStore(4)
        const stored = await append('reserved', candidate.blockStore, source, offsets, lengths)
        const baseline = await append('reserved', control.blockStore, source, sharedColumn(offsets), sharedColumn(lengths))
        const [, runs, runLengths, runStarts, blockLengths] = vi.mocked(beginCompressWrappedTermContentZstdSpansBatch).mock.calls[0]
        expect(runs).toEqual(Uint32Array.of(0, 16, 28))
        expect(runLengths).toEqual(Uint32Array.of(4, 12, 4))
        expect(runStarts).toEqual(Uint32Array.of(0, 1, 2, 3))
        expect(blockLengths).toEqual(Uint32Array.of(4, 12, 4))
        expect(stored.contentOffsets).toHaveLength(16)
        expect(stored.contentOffsets).toEqual(baseline.contentOffsets)
        expect(await storedBytes(candidate)).toEqual(await storedBytes(control))
        for (let i = 0; i < lengths.length; ++i) {
            const expected = lengths[i] === 0 ? null : source.slice(offsets[i], offsets[i] + lengths[i])
            expect(await candidate.blockStore.read(stored.contentOffsets[i], lengths[i], stored.contentDictName)).toEqual(expected)
        }
    })

    test.each([
        {name: 'gapped', offsets: [0, 2, 4, 6, 8, 10, 12, 14]},
        {name: 'reversed', offsets: [7, 6, 5, 4, 3, 2, 1, 0]},
        {name: 'repeated', offsets: [0, 0, 0, 0, 0, 0, 0, 0]},
    ])('abandons unhelpful $name coalescing and preserves exact bytes', async ({offsets: values}) => {
        const source = createSource(32)
        const offsets = Uint32Array.from(values)
        const lengths = new Uint32Array(offsets.length).fill(1)
        const candidate = createStore(32)
        const control = createStore(32)
        await append('reserved', candidate.blockStore, source, offsets, lengths)
        await append('reserved', control.blockStore, source, sharedColumn(offsets), sharedColumn(lengths))
        const [, actualOffsets, actualLengths] = vi.mocked(beginCompressWrappedTermContentZstdSpansBatch).mock.calls[0]
        expect(actualOffsets).toBe(offsets)
        expect(actualLengths).toBe(lengths)
        expect(await storedBytes(candidate)).toEqual(await storedBytes(control))
    })

    test('caps temporary columns when a large fragmented batch exceeds the run budget', async () => {
        const source = createSource(40000)
        const offsets = Uint32Array.from({length: 20000}, (_, i) => i * 2)
        const lengths = new Uint32Array(offsets.length).fill(1)
        const store = createStore(40000)
        const stored = await append('reserved', store.blockStore, source, offsets, lengths)
        const [, actualOffsets, actualLengths] = vi.mocked(beginCompressWrappedTermContentZstdSpansBatch).mock.calls[0]
        expect(actualOffsets).toBe(offsets)
        expect(actualLengths).toBe(lengths)
        expect(stored.contentOffsets).toHaveLength(offsets.length)
        const last = offsets.length - 1
        expect(await store.blockStore.read(stored.contentOffsets[last], lengths[last], stored.contentDictName))
            .toEqual(source.slice(offsets[last], offsets[last] + 1))
    })

    test.each([0, 1])('validates an invalid final original span of length %i before any reservation or compression', (invalidLength) => {
        const source = createSource(16)
        const offsets = Uint32Array.from({length: 16}, (_, i) => i)
        const lengths = new Uint32Array(16).fill(1)
        offsets[15] = 17
        lengths[15] = invalidLength
        const {blockStore, contentStore} = createStore(32)
        const reserve = vi.spyOn(contentStore, 'beginAppendBatchWithDerivedPrefix')
        expect(() => blockStore.tryBeginAppendSpans(source, offsets, lengths, 'jmdict', true)).toThrow('span 15 is out of bounds')
        expect(reserve).not.toHaveBeenCalled()
        expect(beginCompressWrappedTermContentZstdSpansBatch).not.toHaveBeenCalled()
    })

    test('keeps the compression-owned copy valid after source consumption and immediate slab reuse', async () => {
        const source = createSource(2048, 3)
        const expected = new Uint8Array(source)
        const expectedFrame = compressWrappedTermContentZstd(expected, 'jmdict').bytes
        const offsets = Uint32Array.from({length: 16}, (_, i) => i * 128)
        const lengths = new Uint32Array(16).fill(128)
        /** @type {() => void} */
        let finish = () => {}
        vi.mocked(beginCompressWrappedTermContentZstdSpansBatch).mockImplementationOnce((bytes, runs, sizes, starts, blockLengths, dictName) => {
            expect(runs).toHaveLength(1)
            expect(starts).toEqual(Uint32Array.of(0, 1))
            const prepared = prepareWrappedTermContentZstdSpans(bytes, runs, sizes, blockLengths[0], dictName)
            /** @type {ReturnType<typeof beginCompressWrappedTermContentZstdSpansBatch>['completion']} */
            const completion = new Promise((resolve) => {
                finish = () => {
                    const {bytes: frame} = finishWrappedTermContentZstdSpans(prepared)
                    expect(frame).toEqual(expectedFrame)
                    resolve({chunks: [frame], envelopeMs: 0, wrapped: true})
                }
            })
            return {sourceConsumed: Promise.resolve(), completion}
        })
        const {blockStore} = createStore(4096)
        const operation = blockStore.tryBeginAppendSpans(source, offsets, lengths, 'jmdict', true)
        if (operation === null) { throw new Error('Expected source-owned operation') }
        await operation.sourceConsumed
        source.fill(0xff)
        finish()
        const stored = await operation.completion
        for (let i = 0; i < lengths.length; ++i) {
            expect(await blockStore.read(stored.contentOffsets[i], lengths[i], stored.contentDictName))
                .toEqual(expected.slice(offsets[i], offsets[i] + lengths[i]))
        }
    })

    test('uses the original row block plan for fallback before source consumption', async () => {
        const source = createSource(32)
        const offsets = Uint32Array.from({length: 16}, (_, i) => i * 2)
        const lengths = new Uint32Array(16).fill(2)
        const failure = new Error('injected coalesced dispatch failure')
        vi.mocked(beginCompressWrappedTermContentZstdSpansBatch).mockImplementationOnce(() => ({
            sourceConsumed: Promise.reject(failure),
            completion: Promise.reject(failure),
        }))
        const candidate = createStore(8)
        const control = createStore(8)
        const stored = await append('reserved', candidate.blockStore, source, offsets, lengths)
        const baseline = await append('reserved', control.blockStore, source, sharedColumn(offsets), sharedColumn(lengths))
        expect(stored.contentOffsets).toEqual(baseline.contentOffsets)
        expect(stored.contentLengths).toEqual(baseline.contentLengths)
        expect(await storedBytes(candidate)).toEqual(await storedBytes(control))
    })
})
