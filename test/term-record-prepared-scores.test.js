/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {Worker} from 'node:worker_threads'
import {afterEach, describe, expect, test, vi} from 'vitest'
import {prepareTermLookupIndexesFromPreinternedPlan, prepareTermRecordScores} from '../ext/js/dictionary/term-lookup-index-preparation.js'
import {createTermRecordPreinternedPlanBuilder} from '../ext/js/dictionary/term-record-preinterned-plan.js'
import {createArtifactTermRecordChunkWithResolvedContent, TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js'

/** @typedef {import('../ext/js/dictionary/term-lookup-index-preparation.js').PreparedTermRecordScores} PreparedScores */
/** @typedef {ReturnType<typeof createArtifactTermRecordChunkWithResolvedContent> & {dictionary: string, rowCount: number, expressionBytesList: Uint8Array[], readingBytesList: Uint8Array[], readingEqualsExpressionList: Uint8Array, scoreList: Int32Array, sequenceList: Int32Array, termRecordPreinternedPlan: import('../ext/js/dictionary/term-record-preinterned-plan.js').PreinternedTermRecordPlan}} Fixture */

/**
 * @param {number} [count]
 * @returns {Fixture}
 */
function fixture(count = 128) {
    const builder = createTermRecordPreinternedPlanBuilder(1)
    builder.internStringBytes(new TextEncoder().encode('word'))
    const indexes = new Uint32Array(count)
    const values = [-2147483648, 256, -257, 7, 2147483647, 0]
    return createArtifactTermRecordChunkWithResolvedContent({
        dictionary: 'Prepared record scores',
        rowCount: count,
        expressionBytesList: [],
        readingBytesList: [],
        readingEqualsExpressionList: new Uint8Array(count).fill(1),
        scoreList: Int32Array.from({length: count}, (_, i) => values[i % values.length]),
        sequenceList: new Int32Array(count).fill(-1),
        termRecordPreinternedPlan: builder.buildPlan(indexes, indexes),
    }, Uint32Array.from({length: count}, (_, i) => i % 2), Float64Array.of(16, 90), Uint32Array.of(7, 9))
}

/**
 * @param {Fixture} chunk
 * @returns {PreparedScores}
 */
function prepare(chunk) {
    const result = prepareTermRecordScores(chunk.scoreList, 0, chunk.rowCount)
    if (result === null) { throw new Error('Missing prepared scores') }
    return result
}

/**
 * @param {Fixture} chunk
 * @param {PreparedScores|null} [prepared]
 * @returns {Uint8Array}
 */
function encode(chunk, prepared = null) {
    return new TermRecordOpfsStore()._encodeArtifactRecordFields(chunk, [], [], 16, prepared)
}

afterEach(() => { vi.restoreAllMocks() })

describe('prepared compact record scores', () => {
    test('preserves every field byte and first-use score order, including legacy fallback', () => {
        for (const length of [7, 65534, 65535]) {
            const chunk = fixture()
            chunk.resolvedContentReferences.lengths[0] = length
            const prepared = prepare(chunk)
            const snapshot = structuredClone(prepared)
            expect(encode(chunk, prepared)).toEqual(encode(chunk))
            expect(prepared).toEqual(snapshot)
            expect([...prepared.scores]).toEqual([-2147483648, 256, -257, 7, 2147483647, 0])
        }
    })

    test.each(['range', 'first-use', 'duplicate', 'unused', 'stale', 'short'])('falls back without changing bytes for a %s score plan', (kind) => {
        const chunk = fixture()
        const prepared = prepare(chunk)
        if (kind === 'range') { prepared.keys[64] = 65535 }
        if (kind === 'first-use') {
            const first = prepared.scores[0]
            prepared.scores[0] = prepared.scores[1]
            prepared.scores[1] = first
            for (let i = 0; i < prepared.keys.length; ++i) {
                if (prepared.keys[i] < 2) { prepared.keys[i] ^= 1 }
            }
        }
        if (kind === 'duplicate') {
            prepared.scores = Int32Array.from([...prepared.scores, prepared.scores[0]])
            prepared.keys[6] = 6
        }
        if (kind === 'unused') { prepared.scores = Int32Array.from([...prepared.scores, 12345]) }
        if (kind === 'stale') { chunk.scoreList[64] = -901 }
        if (kind === 'short') { prepared.keys = prepared.keys.subarray(1) }
        expect(encode(chunk, prepared)).toEqual(encode(chunk))
    })

    test('does not call score-plan accessors or trust shared, detached, or spoofed columns', () => {
        const chunk = fixture()
        const expected = encode(chunk)
        const accessor = vi.fn(() => prepare(chunk).scores)
        const withAccessor = {keys: prepare(chunk).keys}
        Object.defineProperty(withAccessor, 'scores', {get: accessor})
        const shared = prepare(chunk)
        shared.keys = new Uint16Array(new SharedArrayBuffer(shared.keys.byteLength))
        shared.keys.set(prepare(chunk).keys)
        const detached = prepare(chunk)
        structuredClone(detached.keys, {transfer: [(detached.keys.buffer)]})
        const spoofed = prepare(chunk)
        const impostor = Float32Array.from(spoofed.scores)
        Object.setPrototypeOf(impostor, Int32Array.prototype)
        spoofed.scores = /** @type {Int32Array} */ (/** @type {unknown} */ (impostor))
        for (const plan of [withAccessor, shared, detached, spoofed]) {
            expect(encode(chunk, /** @type {PreparedScores} */ (plan))).toEqual(expected)
        }
        expect(accessor).not.toHaveBeenCalled()
    })

    test('revalidates exact score segments after an awaited append and keeps owned output stable', async () => {
        const chunk = fixture(65536)
        const indexes = prepareTermLookupIndexesFromPreinternedPlan(chunk)?.indexes
        if (!(indexes instanceof Map)) { throw new Error('Missing prepared lookup ranges') }
        for (const [range, prepared] of indexes) {
            const [first, count] = range.split(':').map(Number)
            prepared.preparedScores = prepareTermRecordScores(chunk.scoreList, first, count) ?? undefined
        }
        const store = new TermRecordOpfsStore()
        /** @type {Uint8Array[]} */
        const output = []
        vi.spyOn(store, '_appendEncodedChunk').mockImplementation(async (...args) => {
            const fields = /** @type {Uint8Array} */ (args[6])
            output.push(Uint8Array.from(fields))
            await Promise.resolve()
            if (output.length === 1) { chunk.scoreList[30000] = -901 }
        })
        await store._encodeAndAppendArtifactChunkForState(
            /** @type {Parameters<typeof store._encodeAndAppendArtifactChunkForState>[0]} */ ({}),
            chunk,
            1,
            [],
            [],
            chunk.termRecordPreinternedPlan,
            'raw',
            indexes,
        )
        expect(output).toHaveLength(3)
        for (let i = 0; i < output.length; ++i) {
            const first = i * 30000
            const count = Math.min(30000, chunk.rowCount - first)
            const part = fixture(count)
            part.scoreList.set(chunk.scoreList.subarray(first, first + count))
            expect(output[i]).toEqual(encode(part))
        }
    })

    test('transfers exact-range score plans from the real parser worker and survives worker reuse', async () => {
        const worker = new Worker(new URL('fixtures/parser-settlement/worker-node.mjs', import.meta.url), {
            workerData: {url: new URL('../ext/js/dictionary/term-bank-wasm-parser-worker.js', import.meta.url).href},
        })
        /**
         * @param {object} message
         * @returns {Promise<Record<string, unknown>>}
         */
        const request = async (message) => await new Promise((resolve, reject) => {
            const onError = (/** @type {Error} */ error) => {
                worker.off('message', onMessage)
                reject(error)
            }
            const onMessage = (/** @type {Record<string, unknown>} */ result) => {
                worker.off('error', onError)
                resolve(result)
            }
            worker.once('message', onMessage)
            worker.once('error', onError)
            worker.postMessage(message)
        })
        try {
            const module = await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url)))
            expect((await request({type: 'initialize', module})).type).toBe('ready')
            /** @type {PreparedScores|null} */
            let previous = null
            for (const score of [7, -901]) {
                const rows = Array.from({length: 24}, (_, i) => [`word-${i}`, '', '', '', i % 3 === 0 ? score : 256, ['definition'], i, ''])
                const sourceBuffers = [rows.slice(0, 12), rows.slice(12)].map((bank) => new TextEncoder().encode(JSON.stringify(bank)).buffer)
                const result = await request({type: 'parse',
                    id: 1,
                    version: 3,
                    sourceBuffers,
                    options: {computeContentHashes: true,
                        emitContentSlab: true,
                        emitTokenBinaryContent: true,
                        emitTermByteLists: false,
                        mediaHintFastScan: true,
                        validateGlossaryTypes: true,
                        prepareLookupIndexes: true}})
                expect(result.type).toBe('result')
                const parsed = /** @type {import('../ext/js/dictionary/term-bank-wasm-parser.js').TermBankColumnChunk} */ (result.chunk)
                const prepared = parsed.preparedLookupIndexes?.get('0:24')?.preparedScores
                expect(prepared).toEqual(prepareTermRecordScores(parsed.scoreList, 0, 24))
                expect(prepared?.scores.buffer).toBeInstanceOf(ArrayBuffer)
                expect(prepared?.keys.buffer).toBeInstanceOf(ArrayBuffer)
                if (previous !== null) { expect([...previous.scores]).toEqual([7, 256]) }
                previous = prepared ?? null
            }
        } finally { await worker.terminate() }
    })
})
