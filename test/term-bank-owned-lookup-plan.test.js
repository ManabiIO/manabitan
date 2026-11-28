/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {Worker} from 'node:worker_threads'
import {beforeAll, describe, expect, test} from 'vitest'
import {
    copyWasmBackedColumnChunk,
    parseTermBankWithWasmColumnChunks,
    setTermBankWasmModule,
} from '../ext/js/dictionary/term-bank-wasm-parser.js'
import {
    compactTermRecordPreinternedPlanRuns,
    sliceTermRecordPreinternedPlan,
} from '../ext/js/dictionary/term-record-preinterned-plan.js'
import {
    encodePersistedTermLookupIndexFromPreinternedPlan,
    findExactRows,
    parsePersistedTermLookupIndex,
} from '../ext/js/dictionary/term-lookup-index.js'

/** @typedef {Parameters<typeof copyWasmBackedColumnChunk>[0]} Chunk */
/** @typedef {{type: string, chunk?: Chunk, error?: unknown, transferObservation?: {count: number, uniqueCount: number, lookupOccurrences: number}}} WorkerReply */
const encoder = new TextEncoder()
const rows = [
    ['猫', 'ねこ', '', '', 2, ['first'], 1, ''],
    ['カタカナ', 'カタカナ', '', '', 0, ['same reading'], 2, ''],
    ['空', '', '', '', -1, ['empty reading'], -1, ''],
    ['quoted"', 'よみ', '', '', 4, ['escaped key'], 1, ''],
    ['𠮷', 'よし', '', '', 0, ['supplementary key'], 3, ''],
    ['猫', 'ねこ', '', '', 3, ['repeated key'], 1, ''],
]
const options = {
    singleChunk: true,
    emitTermByteLists: false,
    computeContentHashes: true,
    emitContentSlab: true,
    emitTokenBinaryContent: true,
    prepareLookupIndexes: true,
    experimentalNativeEscapedKeys: true,
    ownContentBytes: true,
}
/** @type {WebAssembly.Module} */
let module

beforeAll(async () => {
    module = await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url)))
    setTermBankWasmModule(module)
})

/**
 * @param {(chunk: Chunk) => Promise<void>|void} callback
 * @param {Partial<typeof options>} [overrides]
 * @returns {Promise<void>}
 */
async function parse(callback, overrides = {}) {
    await parseTermBankWithWasmColumnChunks(
        [encoder.encode(JSON.stringify(rows)), encoder.encode('[]')],
        3,
        callback,
        2,
        {...options, ...overrides},
    )
}

/** @param {Chunk} chunk */
function assertOwnedPlan(chunk) {
    const plan = chunk.termRecordPreinternedPlan
    const prepared = chunk.preparedLookupIndexes?.get(`0:${chunk.rowCount}`)
    expect(prepared).toBeDefined()
    if (!prepared) { throw new Error('Missing whole lookup index') }
    expect(prepared.preinternedPlan).toBe(plan)
    expect(plan.stringsBuffer.buffer).toBe(prepared.bytes.buffer)
    expect(plan.stringLengths.buffer).toBe(prepared.bytes.buffer)
    expect(plan.expressionIndexes).toBeInstanceOf(Uint16Array)
    expect(plan.expressionIndexes.buffer).toBe(prepared.bytes.buffer)
    expect(plan.readingIndexes).toBeInstanceOf(Uint32Array)
    expect(plan.readingIndexes.buffer).not.toBe(prepared.bytes.buffer)
    expect(plan.stringOffsets).toBeUndefined()
    expect(plan.stringHashes).toBeUndefined()
    const persisted = parsePersistedTermLookupIndex(prepared.bytes)
    expect(plan.stringsBuffer).toEqual(persisted.keyBytes)
    expect(plan.expressionIndexes).toEqual(persisted.expressionKeys)
    for (let i = 0; i < chunk.rowCount; ++i) {
        expect(plan.readingIndexes[i]).toBe(persisted.readingKeys[i] === 0xffff ? persisted.expressionKeys[i] : persisted.readingKeys[i])
    }
    expect(persisted.readingKeys[1]).toBe(0xffff)
    expect(persisted.readingKeys[2]).toBe(0xffff)
    expect([...findExactRows(persisted, encoder.encode('猫'), 'expression')]).toEqual([0, 5])
    expect([...findExactRows(persisted, encoder.encode('ねこ'), 'reading')]).toEqual([0, 5])
}

/**
 * @param {Worker} worker
 * @param {unknown} request
 * @returns {Promise<WorkerReply>}
 */
function requestWorker(worker, request) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup()
            reject(new Error('Parser worker timed out'))
        }, 30000)
        const cleanup = () => {
            clearTimeout(timeout)
            worker.off('message', message)
            worker.off('error', error)
        }
        /** @param {WorkerReply} reply */
        const message = (reply) => {
            cleanup()
            resolve(reply)
        }
        /** @param {Error} reason */
        const error = (reason) => {
            cleanup()
            reject(reason)
        }
        worker.once('message', message)
        worker.once('error', error)
        if (request !== null) { worker.postMessage(request) }
    })
}

describe('owned whole native lookup plans', () => {
    test('adopts validated owned columns once and preserves slicing and compaction', async () => {
        await parse((chunk) => {
            const copied = copyWasmBackedColumnChunk(chunk, false, false, true, void 0, true)
            assertOwnedPlan(copied)
            const plan = copied.termRecordPreinternedPlan
            const wide = {...plan, expressionIndexes: Uint32Array.from(plan.expressionIndexes)}
            const sliced = sliceTermRecordPreinternedPlan(plan, 1, 3)
            expect(sliced?.expressionIndexes).toBeInstanceOf(Uint16Array)
            expect(sliced?.expressionIndexes.buffer).toBe(plan.expressionIndexes.buffer)
            expect(encodePersistedTermLookupIndexFromPreinternedPlan(plan, copied.readingEqualsExpressionList, copied.sequenceList, copied.rowCount))
                .toEqual(encodePersistedTermLookupIndexFromPreinternedPlan(wide, copied.readingEqualsExpressionList, copied.sequenceList, copied.rowCount))
            expect(compactTermRecordPreinternedPlanRuns(plan, copied.rowCount, 2, new Uint32Array(plan.stringLengths.length), copied.readingEqualsExpressionList))
                .toEqual(compactTermRecordPreinternedPlanRuns(wide, copied.rowCount, 2, new Uint32Array(plan.stringLengths.length), copied.readingEqualsExpressionList))
            const again = copyWasmBackedColumnChunk(chunk, false, false, false, void 0, true)
            expect(again.termRecordPreinternedPlan.expressionIndexes).toBeInstanceOf(Uint32Array)
            expect(again.termRecordPreinternedPlan.stringsBuffer.buffer).not.toBe(plan.stringsBuffer.buffer)
        })
    })

    test('keeps general copying independent from mutable prepared and source views', async () => {
        await parse((chunk) => {
            const copied = copyWasmBackedColumnChunk(chunk)
            const plan = copied.termRecordPreinternedPlan
            const before = structuredClone(plan)
            const prepared = copied.preparedLookupIndexes?.get(`0:${copied.rowCount}`)
            expect(plan.expressionIndexes).toBeInstanceOf(Uint32Array)
            expect(plan.stringsBuffer.buffer).not.toBe(prepared?.bytes.buffer)
            chunk.termRecordPreinternedPlan.stringsBuffer.fill(0)
            chunk.termRecordPreinternedPlan.stringLengths.fill(0)
            chunk.termRecordPreinternedPlan.expressionIndexes.fill(0)
            chunk.termRecordPreinternedPlan.readingIndexes.fill(0)
            prepared?.bytes.fill(0)
            expect(plan).toEqual(before)
        })
    })

    test.each(['plan', 'strings', 'expressions', 'map', 'bytes', 'header'])('rejects replaced or invalid %s', async (replace) => {
        await parse((chunk) => {
            const plan = chunk.termRecordPreinternedPlan
            const prepared = chunk.preparedLookupIndexes?.get(`0:${chunk.rowCount}`)
            if (!prepared) { throw new Error('Missing prepared native index') }
            switch (replace) {
                case 'plan': chunk.termRecordPreinternedPlan = {...plan}; break
                case 'strings': plan.stringsBuffer = new Uint8Array(plan.stringsBuffer); break
                case 'expressions': plan.expressionIndexes = new Uint32Array(plan.expressionIndexes); break
                case 'map': chunk.preparedLookupIndexes = new Map(chunk.preparedLookupIndexes); break
                case 'bytes': prepared.bytes = new Uint8Array(prepared.bytes); break
                case 'header': prepared.bytes[4] = 8; break
            }
            const copied = copyWasmBackedColumnChunk(chunk, false, false, false, void 0, true)
            expect(copied.termRecordPreinternedPlan.expressionIndexes).toBeInstanceOf(Uint32Array)
            expect(copied.termRecordPreinternedPlan.stringsBuffer.buffer).not.toBe(prepared.bytes.buffer)
        })
    })

    test('does not adopt outside the synchronous producer scope or from a partial group', async () => {
        await parse(async (chunk) => {
            await Promise.resolve()
            expect(copyWasmBackedColumnChunk(chunk, false, false, false, void 0, true).termRecordPreinternedPlan.expressionIndexes)
                .toBeInstanceOf(Uint32Array)
        })
        let chunks = 0
        await parse((chunk) => {
            ++chunks
            const copied = copyWasmBackedColumnChunk(chunk, false, false, false, void 0, true)
            expect(copied.termRecordPreinternedPlan.expressionIndexes).toBeInstanceOf(Uint32Array)
        }, {singleChunk: false})
        expect(chunks).toBe(3)
    })

    test('leaves empty groups and unsupported native lookup layouts on the existing path', async () => {
        let emptyChunks = 0
        await parseTermBankWithWasmColumnChunks(encoder.encode('[]'), 3, () => { ++emptyChunks }, 2, options)
        expect(emptyChunks).toBe(0)
        const wideSequenceRows = [['long'.repeat(1000), '', '', '', 0, ['wide sequence'], 2 ** 40, '']]
        await parseTermBankWithWasmColumnChunks(encoder.encode(JSON.stringify(wideSequenceRows)), 3, (chunk) => {
            expect(chunk.preparedLookupIndexes).toBeUndefined()
            const copied = copyWasmBackedColumnChunk(chunk, false, false, false, void 0, true)
            expect(copied.termRecordPreinternedPlan.expressionIndexes).toBeInstanceOf(Uint32Array)
            expect(copied.termRecordPreinternedPlan.stringsBuffer).toEqual(encoder.encode('long'.repeat(1000)))
            expect(copied.sequenceList[0]).toBe(2 ** 40)
        }, 2, options)
    })

    test('transfers aliased columns once and preserves the complete plan through worker reuse', async () => {
        const workerUrl = new URL('../ext/js/dictionary/term-bank-wasm-parser-worker.js', import.meta.url).href
        const bridge = `import {parentPort} from 'node:worker_threads'
            globalThis.self = {addEventListener: (_, fn) => parentPort.on('message', data => fn({data})),
                postMessage: (data, transfer = []) => {
                    if (data.type === 'result' && data.chunk) {
                        const lookup = data.chunk.preparedLookupIndexes.get('0:' + data.chunk.rowCount).bytes.buffer
                        data.transferObservation = {count: transfer.length, uniqueCount: new Set(transfer).size,
                            lookupOccurrences: transfer.filter(buffer => buffer === lookup).length}
                    }
                    parentPort.postMessage(data, transfer)
                }}
            await import(${JSON.stringify(workerUrl)})
            parentPort.postMessage({type: 'loaded'})`
        const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(bridge)}`))
        try {
            expect((await requestWorker(worker, null)).type).toBe('loaded')
            expect((await requestWorker(worker, {type: 'initialize', module})).type).toBe('ready')
            let prior
            let snapshot
            for (let id = 1; id <= 2; ++id) {
                const reply = await requestWorker(worker, {type: 'parse',
                    id,
                    version: 3,
                    sourceBuffers: [encoder.encode(JSON.stringify(rows)).buffer, encoder.encode('[]').buffer],
                    options})
                expect(reply.type, JSON.stringify(reply.error)).toBe('result')
                if (!reply.chunk || !reply.transferObservation) { throw new Error('Missing worker result') }
                assertOwnedPlan(reply.chunk)
                expect(reply.transferObservation.count).toBe(reply.transferObservation.uniqueCount)
                expect(reply.transferObservation.lookupOccurrences).toBe(1)
                if (prior) { expect(prior).toEqual(snapshot) }
                prior = reply.chunk
                snapshot = structuredClone(prior)
            }
        } finally { await worker.terminate() }
    })
})
