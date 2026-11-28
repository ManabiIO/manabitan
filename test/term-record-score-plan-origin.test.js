/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {afterEach, describe, expect, test, vi} from 'vitest'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'
import {createArtifactTermRecordChunkWithResolvedContent, TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js'

/** @typedef {Parameters<TermRecordOpfsStore['appendBatchFromArtifactChunkResolvedContent']>[0]} ArtifactChunk */
/** @typedef {import('../ext/js/dictionary/term-score-plan.js').TermScorePlan} TermScorePlan */
/** @typedef {ArtifactChunk & {scoreList: null, scorePlan: TermScorePlan, resolvedContentReferences: NonNullable<ArtifactChunk['resolvedContentReferences']>}} ProvenChunk */
/**
 * @typedef {object} EncodedRun
 * @property {number} firstId
 * @property {number} count
 * @property {string|null|undefined} dictionary
 * @property {number|undefined} base
 * @property {Uint8Array|null|undefined} lookup
 * @property {Uint8Array|null|undefined} fields
 * @property {number|undefined} format
 */

/**
 * @param {number} [count=16]
 * @returns {ProvenChunk}
 */
function fixture(count = 16) {
    const buffer = new ArrayBuffer(8 + count * 2)
    const values = new Int32Array(buffer, 0, 2)
    values.set([5, 7])
    const keys = new Uint16Array(buffer, 8, count)
    for (let i = 0; i < count; ++i) { keys[i] = i % 2 }
    const term = new TextEncoder().encode('term')
    return createArtifactTermRecordChunkWithResolvedContent({
        dictionary: 'Compact score origin',
        dictionaryTotalRows: 1_000_000,
        rowCount: count,
        expressionBytesList: Array.from({length: count}, () => term),
        readingBytesList: Array.from({length: count}, () => term),
        readingEqualsExpressionList: new Uint8Array(count).fill(1),
        scoreList: null,
        scorePlan: {values, keys},
        sequenceList: new Int32Array(count).fill(-1),
    }, new Uint32Array(count), Float64Array.of(100), Uint32Array.of(8))
}

/**
 * @param {ProvenChunk} chunk
 * @returns {ArtifactChunk}
 */
function rawChunk(chunk) {
    return {...chunk, scoreList: Int32Array.from(chunk.scorePlan.keys, (key) => chunk.scorePlan.values[key])}
}

/**
 * @param {ArtifactChunk} chunk
 * @param {boolean} [normalize=false]
 * @returns {Uint8Array}
 */
function fields(chunk, normalize = false) {
    return new TermRecordOpfsStore()._encodeArtifactRecordFields(chunk, [], [], 100, normalize)
}

/**
 * Keep actual record validation, encoding, format selection and lookup bytes.
 * Stub filesystem setup and the final immutable-byte append only.
 * @param {(() => void)|null} [afterFirstAppend=null]
 * @returns {Promise<{store: TermRecordOpfsStore, append: import('vitest').MockInstance<TermRecordOpfsStore['_appendEncodedChunk']>}>}
 */
async function createStore(afterFirstAppend = null) {
    const store = new TermRecordOpfsStore()
    await store.beginImportSession()
    vi.spyOn(store, '_getOrCreateShardState').mockResolvedValue(
        /** @type {Awaited<ReturnType<TermRecordOpfsStore['_getOrCreateShardState']>>} */ ({}),
    )
    let calls = 0
    const append = vi.spyOn(store, '_appendEncodedChunk').mockImplementation(async () => {
        if (++calls === 1) { afterFirstAppend?.() }
    })
    return {store, append}
}

/**
 * @param {Awaited<ReturnType<typeof createStore>>} capture
 * @returns {EncodedRun[]}
 */
function output(capture) {
    return capture.append.mock.calls.map((args) => ({
        firstId: args[1],
        count: args[2],
        dictionary: args[3],
        base: args[4],
        lookup: args[5],
        fields: args[6],
        format: args[7],
    }))
}

/**
 * @param {ArtifactChunk} chunk
 * @param {number[]|Float64Array} [offsets=[]]
 * @param {number[]|Uint32Array} [lengths=[]]
 * @param {string|string[]} [names='raw']
 * @returns {Promise<EncodedRun[]>}
 */
async function append(chunk, offsets = [], lengths = [], names = 'raw') {
    const capture = await createStore()
    await capture.store.appendBatchFromArtifactChunkResolvedContent(chunk, offsets, lengths, names)
    return output(capture)
}

afterEach(() => { vi.restoreAllMocks() })

describe('compact record score source origins', () => {
    test.each(['plain-copy', 'source-proxy', 'plan-proxy'])('rejects an unproven %s at the authoritative encoder', (kind) => {
        let chunk = fixture()
        const descriptorTrap = vi.fn(Reflect.getOwnPropertyDescriptor)
        if (kind === 'plain-copy') { chunk = {...chunk} }
        if (kind === 'source-proxy') {
            chunk = new Proxy(chunk, /** @type {ProxyHandler<ProvenChunk>} */ ({getOwnPropertyDescriptor: descriptorTrap}))
        }
        if (kind === 'plan-proxy') {
            chunk.scorePlan = new Proxy(chunk.scorePlan, /** @type {ProxyHandler<TermScorePlan>} */ ({getOwnPropertyDescriptor: descriptorTrap}))
        }
        expect(() => fields(chunk)).toThrow(TypeError)
        expect(descriptorTrap).not.toHaveBeenCalled()
    })

    test.each([false, true])('does not normalize a replaced plan on a proven source (permission=%s)', (permission) => {
        const chunk = fixture()
        const trap = vi.fn(Reflect.getOwnPropertyDescriptor)
        chunk.scorePlan = new Proxy(chunk.scorePlan, /** @type {ProxyHandler<TermScorePlan>} */ ({getOwnPropertyDescriptor: trap}))
        expect(() => fields(chunk, permission)).toThrow(TypeError)
        expect(trap).not.toHaveBeenCalled()
    })

    test('factory snapshots the incoming plan container while retaining live private views', () => {
        const original = fixture()
        const inputPlan = original.scorePlan
        const trap = vi.fn(Reflect.getOwnPropertyDescriptor)
        const input = {...original, scorePlan: new Proxy(inputPlan, /** @type {ProxyHandler<TermScorePlan>} */ ({getOwnPropertyDescriptor: trap}))}
        const references = original.resolvedContentReferences
        const owned = createArtifactTermRecordChunkWithResolvedContent(
            input,
            references.uniqueIndexList,
            references.offsets,
            references.lengths,
        )
        expect(owned).not.toBe(input)
        expect(owned.scorePlan).not.toBe(input.scorePlan)
        expect(owned.scorePlan.values).toBe(inputPlan.values)
        expect(owned.scorePlan.keys).toBe(inputPlan.keys)
        expect(input.scorePlan).not.toBe(owned.scorePlan)
        trap.mockClear()
        inputPlan.values[0] = 13
        expect(fields(owned)).toEqual(fields(rawChunk(owned)))
        expect(trap).not.toHaveBeenCalled()
        inputPlan.values = new Int32Array([99, 99])
        expect(fields(owned)).toEqual(fields(rawChunk(owned)))
        expect(owned.scorePlan.values[0]).toBe(13)
    })

    for (const legacy of [false, true]) {
        test.each(['raw', 'plan', 'values', 'keys'])(`rejects final-row %s replacement after a content getter (legacy=${legacy})`, (change) => {
            const chunk = fixture()
            let reads = 0
            let changed = false
            // The legacy route first tests row zero's length, then scans all rows.
            const lastRead = (chunk.rowCount + (legacy ? 1 : 0)) * 2
            Object.defineProperty(chunk, 'fixedContentLength', {
                get() {
                    if (++reads === lastRead) {
                        changed = true
                        if (change === 'raw') { Reflect.set(chunk, 'scoreList', new Int32Array(chunk.rowCount).fill(99)) }
                        if (change === 'plan') { chunk.scorePlan = {...chunk.scorePlan} }
                        if (change === 'values') { chunk.scorePlan.values = new Int32Array(chunk.scorePlan.values) }
                        if (change === 'keys') { chunk.scorePlan.keys = new Uint16Array(chunk.scorePlan.keys) }
                    }
                    return legacy ? 65535 : 8
                },
            })
            expect(() => fields(chunk)).toThrow(TypeError)
            expect(changed).toBe(true)
            expect(reads).toBe(lastRead)
        })
    }

    test('keeps in-place generic getter changes live without accepting a representation replacement', () => {
        const chunk = fixture()
        chunk.scorePlan.keys.fill(0)
        const rawScores = new Int32Array(chunk.rowCount).fill(5)
        const raw = {...chunk, scoreList: rawScores}
        let compactReads = 0
        let rawReads = 0
        Object.defineProperty(chunk, 'fixedContentLength', {get() {
            if (++compactReads === chunk.rowCount * 2) { chunk.scorePlan.values[0] = 99 }
            return 8
        }})
        Object.defineProperty(raw, 'fixedContentLength', {get() {
            if (++rawReads === chunk.rowCount * 2) { rawScores[chunk.rowCount - 1] = 99 }
            return 8
        }})
        expect(fields(chunk)).toEqual(fields(raw))
        expect(compactReads).toBe(chunk.rowCount * 2)
        expect(rawReads).toBe(compactReads)
    })

    test.each(['values', 'keys'])('revalidates current %s after a previous encoding', (column) => {
        const chunk = fixture()
        const before = fields(chunk)
        if (column === 'values') {
            chunk.scorePlan.values[1] = 5
        } else {
            chunk.scorePlan.keys.fill(0)
        }
        expect(fields(chunk)).toEqual(fields(rawChunk(chunk)))
        expect(fields(chunk)).not.toEqual(before)
    })

    test('normalizes an actual non-reference append without granting direct-encoder origin to its input', async () => {
        const proven = fixture()
        /** @type {ArtifactChunk} */
        const input = {...proven}
        delete input.resolvedContentReferences
        const offsets = Float64Array.from({length: input.rowCount}, (_, i) => 100 + i * 8)
        const lengths = new Uint32Array(input.rowCount).fill(8)
        const recordChunk = new DictionaryDatabase()._createResolvedArtifactTermRecordChunk(
            /** @type {Parameters<DictionaryDatabase['_createResolvedArtifactTermRecordChunk']>[0]} */ (input),
            null,
            null,
            false,
        )
        expect(recordChunk).toBe(input)
        const expected = await append({...input, scoreList: /** @type {Int32Array} */ (rawChunk(proven).scoreList)}, offsets, lengths)
        const actual = await append(recordChunk, offsets, lengths)
        expect(actual).toEqual(expected)
        expect(actual).toHaveLength(1)
        expect(actual[0].format).toBe(2)
        expect(input.scoreList).toBeNull()
        expect(() => fields(input)).toThrow(TypeError)
    })

    test.each([false, true])('normalizes actual database no-dedup record append (fixed packing=%s)', async (fixed) => {
        const proven = fixture()
        const capture = await createStore()
        const baseline = await createStore()
        for (const {recordStore, raw} of [{recordStore: capture.store, raw: false}, {recordStore: baseline.store, raw: true}]) {
            const database = new DictionaryDatabase()
            Reflect.set(database, '_bulkImportTransactionOpen', true)
            Reflect.set(database, '_deferTermsVirtualTableSync', true)
            Reflect.set(database, '_termRecordStore', recordStore)
            if (fixed) {
                Reflect.set(database, '_termContentStorageMode', 'raw-bytes')
                Reflect.set(database, '_artifactFixedPackMinTotalRows', 0)
            }
            Reflect.set(database, '_termContentStore', {appendBatchToArrays: async (
                /** @type {Uint8Array[]} */ chunks,
                /** @type {number[]} */ offsets,
                /** @type {number[]} */ lengths,
            ) => {
                let cursor = 100
                for (let i = 0; i < chunks.length; ++i) {
                    offsets[i] = cursor
                    lengths[i] = chunks[i].byteLength
                    cursor += lengths[i]
                }
            }})
            const chunk = {
                ...proven,
                ...(raw ? {scoreList: rawChunk(proven).scoreList} : {}),
                readingEqualsExpressionList: Array.from({length: proven.rowCount}, () => true),
                sequenceList: [...proven.sequenceList],
                contentBytesList: Array.from({length: proven.rowCount}, () => new Uint8Array(8)),
                contentDictNameList: null,
                uniformContentDictName: 'raw',
            }
            Reflect.deleteProperty(chunk, 'resolvedContentReferences')
            await database._bulkAddArtifactTermsChunkWithoutContentDedup(chunk)
        }
        expect(output(capture)).toEqual(output(baseline))
        expect(capture.append).toHaveBeenCalledOnce()
        expect(capture.append.mock.calls[0][7]).toBe(2)
    })

    test.each(['offset', 'dictionary', 'both'])('admits an initially unproven compact append through its first %s split', async (kind) => {
        const proven = fixture(32)
        /** @type {ArtifactChunk} */
        const compact = {...proven}
        const raw = rawChunk(proven)
        delete compact.resolvedContentReferences
        delete raw.resolvedContentReferences
        const offsets = Float64Array.from({length: proven.rowCount}, (_, i) => {
            const distant = kind === 'both' ? (i >>> 3) % 2 === 1 : kind === 'offset' && i >= 16
            return 100 + (distant ? 0x100000000 : 0)
        })
        const lengths = new Uint32Array(proven.rowCount).fill(8)
        const names = kind === 'offset' ? 'raw' : Array.from({length: proven.rowCount}, (_, i) => (i < 16 ? 'raw' : 'other'))
        const actual = await append(compact, offsets, lengths, names)
        expect(actual.map(({count}) => count)).toEqual(kind === 'both' ? [8, 8, 8, 8] : [16, 16])
        expect(actual).toEqual(await append(raw, offsets, lengths, names))
        expect(compact.scoreList).toBeNull()
    })

    test('constructs fresh compact origins across dictionary and offset splits', async () => {
        const chunk = fixture(32)
        chunk.resolvedContentReferences.uniqueIndexList.set(Uint32Array.from({length: 32}, (_, i) => (i >>> 3) % 2))
        chunk.resolvedContentReferences.offsets = Float64Array.of(100, 100 + 0x100000000)
        chunk.resolvedContentReferences.lengths = Uint32Array.of(8, 8)
        const names = Array.from({length: 32}, (_, i) => (i < 16 ? 'raw' : 'other'))
        const actual = await append(chunk, [], [], names)
        expect(actual.map(({count}) => count)).toEqual([8, 8, 8, 8])
        expect(actual).toEqual(await append(rawChunk(chunk), [], [], names))
    })

    test('rejects a replaced parent plan before the next awaited split can wrap it', async () => {
        const chunk = fixture()
        chunk.resolvedContentReferences.uniqueIndexList.fill(1, 8)
        chunk.resolvedContentReferences.offsets = Float64Array.of(100, 100 + 0x100000000)
        chunk.resolvedContentReferences.lengths = Uint32Array.of(8, 8)
        const trap = vi.fn(Reflect.getOwnPropertyDescriptor)
        const capture = await createStore(() => {
            chunk.scorePlan = new Proxy(chunk.scorePlan, /** @type {ProxyHandler<TermScorePlan>} */ ({getOwnPropertyDescriptor: trap}))
        })
        await expect(capture.store.appendBatchFromArtifactChunkResolvedContent(chunk, [], [], 'raw')).rejects.toThrow(TypeError)
        expect(capture.append).toHaveBeenCalledOnce()
        expect(trap).not.toHaveBeenCalled()
    })

    test.each(['integer', 'float64'])('retains raw %s getter order without observing Proxy descriptors or keys', async (kind) => {
        const proven = fixture()
        const count = proven.rowCount
        const raw = rawChunk(proven)
        let scoreReads = 0
        Object.defineProperty(raw, 'scoreList', {get() {
            const value = (++scoreReads % 2) + (kind === 'float64' ? 0.5 : 0)
            return kind === 'float64' ? new Float64Array(count).fill(value) : new Int32Array(count).fill(value)
        }})
        const proxied = new Proxy(raw, {
            ownKeys() { throw new Error('Raw source was unexpectedly snapshotted') },
            getOwnPropertyDescriptor() { throw new Error('Raw source descriptors were unexpectedly observed') },
        })
        const expectedScores = Array.from({length: count}, (_, i) => ((i + 3) % 2) + (kind === 'float64' ? 0.5 : 0))
        const expected = await append({...rawChunk(proven), scoreList: kind === 'float64' ? Float64Array.from(expectedScores) : Int32Array.from(expectedScores)})
        expect(await append(proxied)).toEqual(expected)
        expect(scoreReads).toBe(count + 2)
    })

    test.each(['integer', 'float64'])('rejects late raw-to-compact transition in the %s scalar loop', (kind) => {
        const proven = fixture()
        const raw = {...proven, scoreList: kind === 'float64' ? new Float64Array(proven.rowCount).fill(1.5) : new Int32Array(proven.rowCount).fill(5)}
        let reads = 0
        Object.defineProperty(raw, 'fixedContentLength', {get() {
            if (++reads === raw.rowCount * 2) { Reflect.set(raw, 'scoreList', null) }
            return 8
        }})
        expect(() => fields(raw)).toThrow(TypeError)
        expect(reads).toBe(raw.rowCount * 2)
    })
})
