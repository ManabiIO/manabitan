/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test, vi} from 'vitest'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'
import {createArtifactTermRecordChunkWithResolvedContent, TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js'

/** @typedef {import('../ext/js/dictionary/term-score-plan.js').TermScorePlan} TermScorePlan */
/** @typedef {Parameters<TermRecordOpfsStore['_encodeAndAppendArtifactChunkForState']>[1]} ArtifactChunk */

/**
 * @param {number} [count=128]
 * @returns {ArtifactChunk & {scoreList: null, scorePlan: TermScorePlan, resolvedContentReferences: NonNullable<ArtifactChunk['resolvedContentReferences']>}}
 */
function fixture(count = 128) {
    const buffer = new ArrayBuffer(12 + count * 2)
    const values = new Int32Array(buffer, 0, 3)
    values.set([-2147483648, 17, 2147483647])
    const keys = new Uint16Array(buffer, 12, count)
    const pattern = [0, 1, 2, 0, 2, 1, 2]
    for (let i = 0; i < count; ++i) { keys[i] = pattern[i % pattern.length] }
    const text = new TextEncoder().encode('term')
    return createArtifactTermRecordChunkWithResolvedContent({
        dictionary: 'Prepared score plan',
        rowCount: count,
        expressionBytesList: Array.from({length: count}, () => text),
        readingBytesList: Array.from({length: count}, () => text),
        readingEqualsExpressionList: new Uint8Array(count).fill(1),
        scoreList: null,
        scorePlan: {values, keys},
        sequenceList: new Int32Array(count).fill(-1),
    }, new Uint32Array(count), Float64Array.of(2 ** 40), Uint32Array.of(8))
}

/**
 * @param {ReturnType<typeof fixture>} chunk
 * @returns {Omit<ReturnType<typeof fixture>, 'scoreList'> & {scoreList: Int32Array}}
 */
function rawChunk(chunk) {
    return {...chunk, scoreList: Int32Array.from(chunk.scorePlan.keys, (key) => chunk.scorePlan.values[key])}
}

/**
 * @param {ArtifactChunk} chunk
 * @returns {Uint8Array}
 */
function fields(chunk) {
    return new TermRecordOpfsStore()._encodeArtifactRecordFields(chunk, [], [], 2 ** 40)
}

/**
 * Run actual validation and encoding while intercepting only persistence.
 * @param {ArtifactChunk} chunk
 * @param {(() => void)|null} [afterFirstAppend=null]
 * @returns {Promise<Array<{firstId: number, count: number, base: number|undefined, lookup: Uint8Array|null|undefined, fields: Uint8Array|null|undefined, format: number|undefined}>>}
 */
async function captureRuns(chunk, afterFirstAppend = null) {
    const store = new TermRecordOpfsStore()
    let calls = 0
    const append = vi.spyOn(store, '_appendEncodedChunk').mockImplementation(async () => {
        if (++calls === 1) { afterFirstAppend?.() }
    })
    await store._encodeAndAppendArtifactChunkForState(
        /** @type {Parameters<TermRecordOpfsStore['_encodeAndAppendArtifactChunkForState']>[0]} */ ({}),
        chunk,
        1,
        [],
        [],
        null,
        'raw',
    )
    return append.mock.calls.map((args) => ({
        firstId: args[1], count: args[2], base: args[4], lookup: args[5], fields: args[6], format: args[7],
    }))
}

describe('prepared score plans in authoritative records', () => {
    test('preserves whole-plan first-use bytes and signed extremes', () => {
        const chunk = fixture()
        const actual = fields(chunk)
        expect(actual).toEqual(fields(rawChunk(chunk)))
        expect(new DataView(actual.buffer).getUint32(8, true)).toBe(3)
        expect(chunk.scoreList).toBeNull()
    })

    test.each(['reordered', 'duplicate-values', 'unused-values'])('reinterns a value-valid %s plan', (change) => {
        const chunk = fixture()
        if (change === 'reordered') { chunk.scorePlan.keys[0] = 1 }
        if (change === 'duplicate-values') { chunk.scorePlan.values[1] = chunk.scorePlan.values[0] }
        if (change === 'unused-values') { chunk.scorePlan.keys.fill(0) }
        expect(fields(chunk)).toEqual(fields(rawChunk(chunk)))
    })

    test('returns an owned snapshot and validates current values on every invocation', () => {
        const chunk = fixture()
        const first = fields(chunk)
        const saved = Uint8Array.from(first)
        chunk.scorePlan.values[1] = chunk.scorePlan.values[0]
        chunk.scorePlan.keys[0] = 2
        expect(first).toEqual(saved)
        expect(fields(chunk)).toEqual(fields(rawChunk(chunk)))
        expect(fields(chunk)).not.toEqual(first)
    })

    test.each([65535, 65536, 0xfffffffe])('preserves legacy fallback for content length %i', (length) => {
        const chunk = fixture()
        chunk.resolvedContentReferences.lengths[0] = length
        expect(fields(chunk)).toEqual(fields(rawChunk(chunk)))
        expect(fields(chunk).byteLength).toBe(chunk.rowCount * 12)
    })

    test.each([false, true])('rejects a late invalid score key before publication (legacy=%s)', async (legacy) => {
        const chunk = fixture()
        if (legacy) { chunk.resolvedContentReferences.lengths[0] = 65535 }
        chunk.scorePlan.keys[chunk.rowCount - 1] = 0xffff
        const store = new TermRecordOpfsStore()
        const append = vi.spyOn(store, '_appendEncodedChunk').mockResolvedValue()
        await expect(store._encodeAndAppendArtifactChunkForState(
            /** @type {Parameters<TermRecordOpfsStore['_encodeAndAppendArtifactChunkForState']>[0]} */ ({}),
            chunk,
            1,
            [],
            [],
            null,
            'raw',
        )).rejects.toThrow('Compact term score key is out of bounds')
        expect(append).not.toHaveBeenCalled()
    })

    test('uses current first-use order after a 30K-row split', async () => {
        const chunk = fixture(30_008)
        const expected = await captureRuns(rawChunk(chunk))
        const actual = await captureRuns(chunk)
        expect(actual.map(({count}) => count)).toEqual([30_000, 8])
        expect(actual).toEqual(expected)
        expect(chunk.scoreList).toBeNull()
    })

    test('uses current first-use order after a content-offset split', async () => {
        const chunk = fixture(16)
        chunk.resolvedContentReferences.offsets = Float64Array.of(2 ** 40, 2 ** 40 + 0x100000000)
        chunk.resolvedContentReferences.lengths = Uint32Array.of(8, 8)
        chunk.resolvedContentReferences.uniqueIndexList.fill(1, 8)
        const actual = await captureRuns(chunk)
        expect(actual.map(({count}) => count)).toEqual([8, 8])
        expect(actual).toEqual(await captureRuns(rawChunk(chunk)))
    })

    test('rejects score-key mutation across an awaited split', async () => {
        const chunk = fixture(30_008)
        const store = new TermRecordOpfsStore()
        const append = vi.spyOn(store, '_appendEncodedChunk').mockImplementation(async () => {
            chunk.scorePlan.keys[30_000] = 0xffff
        })
        await expect(store._encodeAndAppendArtifactChunkForState(
            /** @type {Parameters<TermRecordOpfsStore['_encodeAndAppendArtifactChunkForState']>[0]} */ ({}),
            chunk,
            1,
            [],
            [],
            null,
            'raw',
        )).rejects.toThrow('Compact term score key is out of bounds')
        expect(append).toHaveBeenCalledTimes(1)
    })

    test('keeps scalar scores in small-record and database materialization', async () => {
        const chunk = fixture(16)
        const expected = [...rawChunk(chunk).scoreList]
        const store = new TermRecordOpfsStore()
        await store.appendBatchFromArtifactChunkResolvedContent(chunk, [], [], 'raw')
        expect(expected.map((_, i) => store.getById(i + 1)?.score)).toEqual(expected)
        const db = new DictionaryDatabase()
        const rows = db._materializeArtifactChunkTermEntries({
            ...chunk,
            readingEqualsExpressionList: Array.from(chunk.readingEqualsExpressionList, Boolean),
            sequenceList: [...chunk.sequenceList],
            contentBytesList: Array.from({length: chunk.rowCount}, () => new Uint8Array(0)),
            contentDictNameList: null,
        })
        expect(rows.map(({score}) => score)).toEqual(expected)
    })

    test('rejects a replaced score-plan Proxy before descriptor traps', () => {
        const chunk = fixture(16)
        const plan = chunk.scorePlan
        let injected = false
        chunk.scorePlan = new Proxy(plan, {
            getOwnPropertyDescriptor(target, property) {
                if (property === 'values' && !injected) {
                    injected = true
                    Object.defineProperty(chunk, 'fixedContentLength', {
                        get() { plan.values.fill(5); return 8 },
                    })
                }
                return Reflect.getOwnPropertyDescriptor(target, property)
            },
        })
        expect(() => fields(chunk)).toThrow('Term score source changed during capture')
        expect(injected).toBe(false)
    })

    test('validates changed resolved content before encoding a proven score source', () => {
        const chunk = fixture()
        chunk.resolvedContentReferences.offsets[0] = Number.NaN
        expect(() => fields(chunk)).toThrow('Invalid term content offset: NaN')
    })

    test.each(['raw-scores', 'replacement-plan'])('rejects a replaced plan before its %s descriptor trap', (change) => {
        const chunk = fixture()
        const plan = chunk.scorePlan
        let descriptorCalls = 0
        chunk.scorePlan = new Proxy(plan, {
            getOwnPropertyDescriptor(target, property) {
                ++descriptorCalls
                if (property === 'values') {
                    if (change === 'raw-scores') {
                        Reflect.set(chunk, 'scoreList', new Float64Array(chunk.rowCount).fill(1.5))
                    } else {
                        chunk.scorePlan = {...plan}
                    }
                }
                return Reflect.getOwnPropertyDescriptor(target, property)
            },
        })
        expect(() => fields(chunk)).toThrow('Term score source changed during capture')
        expect(descriptorCalls).toBe(0)
    })

    test('rejects a compact accessor that changes to fractional raw scores', () => {
        const chunk = fixture()
        let reads = 0
        Object.defineProperty(chunk, 'scoreList', {
            get: () => (++reads === 1 ? null : new Float64Array(chunk.rowCount).fill(1.5)),
        })
        expect(() => fields(chunk)).toThrow('Term score source changed during capture')
    })

    for (const legacy of [false, true]) {
        test.each(['plan', 'values', 'keys', 'raw-scores'])(`rejects %s replacement by generic content reads (legacy=${legacy})`, (change) => {
            const chunk = fixture()
            let reads = 0
            Object.defineProperty(chunk, 'fixedContentLength', {
                get() {
                    if (++reads >= (legacy ? 3 : 1)) {
                        if (change === 'plan') { chunk.scorePlan = fixture().scorePlan }
                        if (change === 'values') { chunk.scorePlan.values = new Int32Array(chunk.scorePlan.values) }
                        if (change === 'keys') { chunk.scorePlan.keys = new Uint16Array(chunk.scorePlan.keys) }
                        if (change === 'raw-scores') { Reflect.set(chunk, 'scoreList', new Float64Array(chunk.rowCount).fill(1.5)) }
                    }
                    return legacy ? 65535 : 8
                },
            })
            expect(() => fields(chunk)).toThrow('Term score source changed during content access')
        })
    }
})
