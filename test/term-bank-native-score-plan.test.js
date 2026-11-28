/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {crc32} from 'node:zlib'
import {afterAll, beforeAll, describe, expect, test, vi} from 'vitest'
import {
    consumeLastTermBankWasmParseProfile,
    copyWasmBackedColumnChunk,
    copyWasmBackedWorkerColumnChunk,
    inflateCompressedTermBankSourcesWasm,
    parseTermBankWithWasmColumnChunks,
} from '../ext/js/dictionary/term-bank-wasm-parser.js'
import {isCanonicalTermScorePlan, readTermScore} from '../ext/js/dictionary/term-score-plan.js'

/** @typedef {import('../ext/js/dictionary/term-bank-wasm-parser.js').TermBankWasmExports & {build_term_score_plan: (...args: number[]) => number}} ScoreWasm */
/** @typedef {import('../ext/js/dictionary/term-bank-wasm-parser.js').TermBankColumnChunk} RawChunk */
/** @typedef {import('../ext/js/dictionary/term-bank-wasm-parser.js').TermBankWorkerColumnChunk} WorkerChunk */

const encoder = new TextEncoder()
const nativeFetch = globalThis.fetch
/** @type {ScoreWasm} */
let wasm

beforeAll(async () => {
    const bytes = await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))
    wasm = /** @type {ScoreWasm} */ (/** @type {unknown} */ ((await WebAssembly.instantiate(bytes, {})).instance.exports))
    vi.stubGlobal('fetch', async (/** @type {RequestInfo|URL} */ resource) => {
        const url = resource instanceof URL ? resource : new URL(String(resource))
        return url.protocol === 'file:' ? new Response(await readFile(fileURLToPath(url))) : nativeFetch(resource)
    })
})

afterAll(() => { vi.unstubAllGlobals() })

/**
 * @param {number[]} scores
 * @returns {{result: number, scores: Int32Array, before: Int32Array, values: Int32Array, keys: Uint16Array, heapBefore: number, heapAfter: number, pointers: number[]}}
 */
function build(scores) {
    wasm.wasm_reset_heap()
    const count = scores.length
    let slots = 1
    while (slots < count) { slots *= 2 }
    const scoresPtr = wasm.wasm_alloc(Math.max(4, count * 4))
    const valuesPtr = wasm.wasm_alloc(Math.max(4, count * 4))
    const keysPtr = wasm.wasm_alloc(Math.max(2, count * 2))
    const slotsPtr = wasm.wasm_alloc(slots * 2)
    const raw = new Int32Array(wasm.memory.buffer, scoresPtr, count)
    raw.set(scores)
    const before = new Int32Array(raw)
    const heapBefore = wasm.memory.buffer.byteLength
    const result = wasm.build_term_score_plan(scoresPtr, count, valuesPtr, keysPtr, slotsPtr, slots)
    return {
        result,
        scores: raw,
        before,
        values: new Int32Array(wasm.memory.buffer, valuesPtr, Math.max(0, result)),
        keys: new Uint16Array(wasm.memory.buffer, keysPtr, count),
        heapBefore,
        heapAfter: wasm.memory.buffer.byteLength,
        pointers: [scoresPtr, count, valuesPtr, keysPtr, slotsPtr, slots],
    }
}

/**
 * @param {number[]} scores
 * @param {import('../ext/js/dictionary/term-bank-wasm-parser.js').TermBankColumnParserOptions & {preloadedSource?: import('../ext/js/dictionary/term-bank-wasm-parser.js').PreloadedTermBankSource}} [options]
 * @returns {Promise<{raw: RawChunk, worker: WorkerChunk, profile: ReturnType<typeof consumeLastTermBankWasmParseProfile>}>}
 */
async function parse(scores, options = {}) {
    const bytes = encoder.encode(JSON.stringify(scores.map((score, i) => [`term${i}`, '', '', '', score, ['definition'], i, ''])))
    /** @type {Array<{raw: RawChunk, worker: WorkerChunk}>} */
    const results = []
    await parseTermBankWithWasmColumnChunks([bytes, encoder.encode('[]')], 3, (chunk) => {
        const original = [...chunk.scoreList]
        results.push({raw: copyWasmBackedColumnChunk(chunk), worker: copyWasmBackedWorkerColumnChunk(chunk)})
        expect([...chunk.scoreList]).toEqual(original)
    }, scores.length, {
        emitContentSlab: true,
        emitTokenBinaryContent: true,
        emitTermByteLists: false,
        prepareLookupIndexes: true,
        prepareWorkerScorePlan: true,
        singleChunk: true,
        ...options,
    })
    expect(results).toHaveLength(1)
    const result = results[0]
    if (typeof result === 'undefined') { throw new Error('Expected parsed columns') }
    return {...result, profile: consumeLastTermBankWasmParseProfile()}
}

describe('bounded native score plans', () => {
    test('preserves signed extremes, exact collision identity and first-use order without growing memory', () => {
        const scores = [-2147483648, 2147483647, 0, -1, 256, -256, 0, -1, -2147483648, 256, -256, 2147483647]
        const result = build(scores)
        expect(result.result).toBe(6)
        expect([...result.values]).toEqual([-2147483648, 2147483647, 0, -1, 256, -256])
        expect([...result.keys]).toEqual([0, 1, 2, 3, 4, 5, 2, 3, 0, 4, 5, 1])
        expect(result.scores).toEqual(result.before)
        expect(result.heapAfter).toBe(result.heapBefore)
    })

    test.each([0, 1, 2, 8, 16, 256, 32768, 65534, 65535])('declines %i unique rows without altering raw scores or growing memory', (count) => {
        const result = build(Array.from({length: count}, (_, i) => i))
        expect(result.result).toBe(0)
        expect(result.scores).toEqual(result.before)
        expect(result.heapAfter).toBe(result.heapBefore)
    })

    test('accepts the budget boundary and declines one extra distinct score', () => {
        const accepted = build([7, 2, 9, 3, 7, 2, 9, 3])
        expect(accepted.result).toBe(4)
        expect(accepted.scores).toEqual(accepted.before)
        const declined = build([7, 2, 9, 3, 5, 2, 9, 3])
        expect(declined.result).toBe(0)
        expect(declined.scores).toEqual(declined.before)
    })

    test('rejects aliased, misaligned, out-of-bounds and invalid slot geometry before changing input', () => {
        const initial = build([1, 2, 1, 2, 1, 2, 1, 2])
        const [scoresPtr, count, valuesPtr, keysPtr, slotsPtr, slots] = initial.pointers
        const invalid = [
            [scoresPtr, count, scoresPtr, keysPtr, slotsPtr, slots],
            [scoresPtr, count, valuesPtr, scoresPtr, slotsPtr, slots],
            [scoresPtr, count, valuesPtr, keysPtr, scoresPtr, slots],
            [scoresPtr + 1, count, valuesPtr, keysPtr, slotsPtr, slots],
            [scoresPtr, count, wasm.memory.buffer.byteLength - 4, keysPtr, slotsPtr, slots],
            [scoresPtr, count, valuesPtr, keysPtr, slotsPtr, 7],
        ]
        for (const pointers of invalid) {
            expect(wasm.build_term_score_plan(...pointers)).toBe(0)
            expect(initial.scores).toEqual(initial.before)
        }
    })
})

describe('private worker score ownership', () => {
    test('retains public raw columns while replacing only the opted-in owned worker column', async () => {
        const scores = [900, -3, 900, 0, -3, 900, 0, 900]
        const {raw, worker, profile} = await parse(scores)
        expect(raw.scoreList).toEqual(new Int32Array(scores))
        expect(Object.hasOwn(raw, 'scorePlan')).toBe(false)
        expect(worker.scoreList).toBeNull()
        const plan = worker.scorePlan
        expect(plan).toBeDefined()
        if (typeof plan === 'undefined') { throw new Error('Expected worker score plan') }
        expect(plan.values.buffer).toBe(plan.keys.buffer)
        expect(plan.values.buffer).toBeInstanceOf(ArrayBuffer)
        expect(plan.values.buffer).not.toBe(raw.scoreList.buffer)
        expect(isCanonicalTermScorePlan(plan)).toBe(true)
        expect(scores.map((_, i) => readTermScore(worker, i))).toEqual(scores)
        expect(worker.preparedLookupIndexes?.get(`0:${scores.length}`)?.bytes).toEqual(raw.preparedLookupIndexes?.get(`0:${scores.length}`)?.bytes)
        expect(profile?.nativeScorePlanGroups).toBe(1)
        expect(profile?.nativeScorePlanRows).toBe(scores.length)
        const clone = structuredClone(worker, {transfer: [plan.values.buffer]})
        expect(plan.values.byteLength).toBe(0)
        await parse([5, 6, 5, 6, 5, 6])
        expect(scores.map((_, i) => readTermScore(clone, i))).toEqual(scores)
        expect(clone.scorePlan?.values.buffer).toBe(clone.scorePlan?.keys.buffer)
    })

    test.each([
        {prepareWorkerScorePlan: false},
        {prepareLookupIndexes: false},
        {experimentalSkipFusedParse: true},
    ])('keeps raw fallback for unsupported producer options %j', async (options) => {
        const {raw, worker} = await parse([3, 3, 3, 3], options)
        expect(worker.scoreList).toEqual(raw.scoreList)
        expect([...(worker.scoreList ?? [])]).toEqual([3, 3, 3, 3])
        expect(worker.scorePlan).toBeUndefined()
    })

    test('keeps partial parser callbacks on raw score columns', async () => {
        const source = encoder.encode(JSON.stringify(Array.from({length: 8}, () => ['x', '', '', '', 700, ['a'], 1, ''])))
        let chunks = 0
        await parseTermBankWithWasmColumnChunks([source, encoder.encode('[]')], 3, (chunk) => {
            const copy = copyWasmBackedWorkerColumnChunk(chunk)
            expect(copy.scoreList).toEqual(new Int32Array(2).fill(700))
            expect(copy.scorePlan).toBeUndefined()
            ++chunks
        }, 2, {emitContentSlab: true, emitTokenBinaryContent: true, prepareLookupIndexes: true, prepareWorkerScorePlan: true})
        expect(chunks).toBe(4)
    })

    test('declines high-cardinality groups and preserves floating and negative-zero raw fallback', async () => {
        expect((await parse([0, 1, 2, 3, 4, 5, 6, 7])).worker.scoreList).toEqual(new Int32Array([0, 1, 2, 3, 4, 5, 6, 7]))
        const floats = await parse([0.5, 0.5, 0.5, 0.5])
        expect(floats.worker.scoreList).toEqual(new Float64Array([0.5, 0.5, 0.5, 0.5]))
        expect(floats.worker.scorePlan).toBeUndefined()
        const bytes = encoder.encode('[["x","","","",-0,["a"],1,""],["x","","","",-0,["a"],1,""]]')
        await parseTermBankWithWasmColumnChunks(bytes, 3, (chunk) => {
            const copy = copyWasmBackedWorkerColumnChunk(chunk)
            expect(copy.scorePlan).toBeUndefined()
            expect(Object.is(copy.scoreList?.[0], -0)).toBe(true)
        }, 2, {singleChunk: true, emitTokenBinaryContent: true, prepareLookupIndexes: true, prepareWorkerScorePlan: true})
    })

    test('retires the borrowed plan capability before an awaited callback resumes', async () => {
        const source = encoder.encode(JSON.stringify(Array.from({length: 8}, () => ['x', '', '', '', 700, ['a'], 1, ''])))
        await parseTermBankWithWasmColumnChunks([source, encoder.encode('[]')], 3, async (chunk) => {
            expect(copyWasmBackedWorkerColumnChunk(chunk).scoreList).toBeNull()
            await Promise.resolve()
            const delayed = copyWasmBackedWorkerColumnChunk(chunk)
            expect(delayed.scoreList).toEqual(new Int32Array(8).fill(700))
            expect(delayed.scorePlan).toBeUndefined()
        }, 8, {singleChunk: true, emitContentSlab: true, emitTokenBinaryContent: true, prepareLookupIndexes: true, prepareWorkerScorePlan: true})
    })

    test('keeps raw fallback when the optional native score export is absent', async () => {
        const source = encoder.encode(JSON.stringify(Array.from({length: 8}, () => ['x', '', '', '', 700, ['a'], 1, ''])))
        const preloadedSource = await inflateCompressedTermBankSourcesWasm([source, encoder.encode('[]')].map((bytes) => ({
            bytes,
            compressionMethod: 0,
            compressedSize: bytes.length,
            uncompressedSize: bytes.length,
            signature: crc32(bytes),
        })))
        const buildScorePlan = preloadedSource.wasm.build_term_score_plan
        preloadedSource.wasm.build_term_score_plan = void 0
        try {
            const {worker} = await parse(Array.from({length: 8}, () => 700), {preloadedSource})
            expect(worker.scoreList).toEqual(new Int32Array(8).fill(700))
            expect(worker.scorePlan).toBeUndefined()
        } finally {
            preloadedSource.wasm.build_term_score_plan = buildScorePlan
        }
    })

    test('actual worker messages opt in explicitly and transfer the compact buffer once', async () => {
        /** @type {(event: MessageEvent<unknown>) => void} */
        let listener = (event) => { throw new Error(`Worker listener is unavailable: ${event.type}`) }
        /** @type {(message: {type: string, chunk?: WorkerChunk, error?: unknown}) => void} */
        let receive = (message) => { throw new Error(`Unexpected worker message: ${message.type}`) }
        /** @type {ArrayBuffer[]} */
        let transfers = []
        vi.stubGlobal('__manabitanTermBankParserWorker', false)
        vi.stubGlobal('self', {
            addEventListener: (/** @type {string} */ type, /** @type {typeof listener} */ callback) => {
                expect(type).toBe('message')
                listener = callback
            },
            postMessage: (/** @type {{type: string, chunk?: WorkerChunk, error?: unknown}} */ message, /** @type {ArrayBuffer[]} */ transfer = []) => {
                transfers = transfer
                receive(structuredClone(message, {transfer}))
            },
        })
        await import('../ext/js/dictionary/term-bank-wasm-parser-worker.js')
        /**
         * @param {unknown} data
         * @returns {Promise<{type: string, chunk?: WorkerChunk, error?: unknown}>}
         */
        const request = (data) => new Promise((resolve) => {
            receive = resolve
            listener(new MessageEvent('message', {data}))
        })
        const module = await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url)))
        expect((await request({type: 'initialize', module})).type).toBe('ready')
        const bytes = encoder.encode(JSON.stringify(Array.from({length: 8}, () => ['x', '', '', '', 700, ['a'], 1, ''])))
        for (const prepareWorkerScorePlan of [false, true]) {
            const message = await request({
                type: 'parse',
                id: prepareWorkerScorePlan ? 2 : 1,
                version: 3,
                sourceBuffers: [new Uint8Array(bytes).buffer, encoder.encode('[]').buffer],
                options: {prepareWorkerScorePlan, prepareLookupIndexes: true, emitContentSlab: true, emitTokenBinaryContent: true, emitTermByteLists: false},
            })
            expect(message.error).toBeUndefined()
            expect(message.type).toBe('result')
            const chunk = message.chunk
            if (typeof chunk === 'undefined') { throw new Error('Expected worker result') }
            expect(Array.from({length: chunk.rowCount}, (_, i) => readTermScore(chunk, i))).toEqual(Array.from({length: 8}, () => 700))
            expect(transfers.length).toBe(new Set(transfers).size)
            if (prepareWorkerScorePlan) {
                expect(chunk.scoreList).toBeNull()
                expect(chunk.scorePlan?.values.buffer).toBe(chunk.scorePlan?.keys.buffer)
                expect(chunk.scorePlan?.values.buffer.byteLength).toBe(20)
            } else {
                expect(chunk.scoreList).toEqual(new Int32Array(8).fill(700))
                expect(chunk.scorePlan).toBeUndefined()
            }
        }
    })
})
