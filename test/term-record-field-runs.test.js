/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {describe, expect, test, vi} from 'vitest'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'
import {createArtifactTermRecordChunkWithResolvedContent, TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js'
import {copyWasmBackedColumnChunk, parseTermBankWithWasmColumnChunks, setTermBankWasmModule} from '../ext/js/dictionary/term-bank-wasm-parser.js'

/** @typedef {Parameters<TermRecordOpfsStore['_encodeArtifactRecordFields']>[0]} FieldChunk */

/**
 * @param {number} [count]
 * @returns {FieldChunk & {resolvedContentReferences: {uniqueIndexList: Uint32Array, offsets: Float64Array, lengths: Uint32Array}}}
 */
function createChunk(count = 240) {
    return createArtifactTermRecordChunkWithResolvedContent(
        {rowCount: count, scoreList: Int32Array.from({length: count}, (_, index) => (index < count / 3 ? 75 : 50)), contentMetaByUniqueIndex: true},
        Uint32Array.from({length: count}, (_, index) => (index < count / 2 ? 0 : 1)),
        Float64Array.of(2 ** 40, 2 ** 40 + 4096),
        Uint32Array.of(7, 65534),
    )
}

/**
 * @param {FieldChunk} chunk
 * @returns {Uint8Array}
 */
function encode(chunk) {
    return new TermRecordOpfsStore()._encodeArtifactRecordFields(chunk, [], [], 2 ** 40)
}

/**
 * Decode the wire fields independently of the encoder's scalar/run paths.
 * @param {Uint8Array} bytes
 * @param {number} count
 * @returns {Array<{offset: number, length: number, score: number}>}
 */
function decode(bytes, count) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (bytes.byteLength === count * 12 || bytes.byteLength === count * 16) {
        const stride = bytes.byteLength / count
        return Array.from({length: count}, (_, row) => ({
            offset: view.getUint32(row * stride, true),
            length: view.getUint32(row * stride + 4, true),
            score: stride === 16 ? view.getFloat64(row * stride + 8, true) : view.getInt32(row * stride + 8, true),
        }))
    }
    expect(view.getUint32(0, true)).toBe(0x3246524d)
    expect(view.getUint32(4, true)).toBe(count)
    expect(view.getUint32(12, true)).toBe(2)
    const scoreCount = view.getUint32(8, true)
    const offsetsStart = 16 + scoreCount * 4
    const lengthsStart = offsetsStart + count * 4
    const keysStart = lengthsStart + count * 2
    expect(bytes.byteLength).toBe(keysStart + count * 2)
    return Array.from({length: count}, (_, row) => ({
        offset: view.getUint32(offsetsStart + row * 4, true),
        length: view.getUint16(lengthsStart + row * 2, true),
        score: view.getInt32(16 + view.getUint16(keysStart + row * 2, true) * 4, true),
    }))
}

/**
 * @param {ReturnType<typeof createChunk>} chunk
 */
function expectExactFields(chunk) {
    const actual = encode(chunk)
    // A spread removes only the private factory witness. The same ordinary
    // columns then take the established scalar implementation.
    expect(actual).toStrictEqual(encode({...chunk}))
    const {uniqueIndexList, offsets, lengths} = chunk.resolvedContentReferences
    const expected = Array.from({length: chunk.rowCount}, (_, row) => {
        const offset = offsets[uniqueIndexList[row]]
        return {
            offset: offset < 0 ? 0xffffffff : offset - 2 ** 40,
            length: chunk.fixedContentLength ?? lengths[uniqueIndexList[row]],
            score: chunk.scoreList[row] ?? 0,
        }
    })
    expect(decode(actual, chunk.rowCount)).toStrictEqual(expected)
}

describe('repeated artifact record fields', () => {
    test.each([63, 64, 65, 240, 2048, 30000])('preserves all fields and exact bytes at %i rows', (count) => {
        expectExactFields(createChunk(count))
    })

    test('fills only complete adjacent reference and score runs', () => {
        const chunk = createChunk()
        const fill = vi.spyOn(Uint32Array.prototype, 'fill')
        try {
            const bytes = encode(chunk)
            expect(fill.mock.calls).toStrictEqual([[0, 0, 80], [0, 80, 120], [4096, 120, 240]])
            expect(bytes).toStrictEqual(encode({...chunk}))
        } finally {
            fill.mockRestore()
        }
    })

    test('preserves alternating scores, score-table boundaries and nonconsecutive aliases', () => {
        const chunk = createChunk()
        const scores = Int32Array.of(-257, -256, 255, 256, -0x80000000, 0x7fffffff)
        for (let row = 0; row < chunk.rowCount; ++row) {
            chunk.scoreList[row] = scores[row % scores.length]
            chunk.resolvedContentReferences.uniqueIndexList[row] = row % 3 === 0 ? 1 : 0
        }
        expectExactFields(chunk)
    })

    test('limits runs to rowCount and rereads changed columns on each encode', () => {
        const chunk = createChunk(241)
        chunk.rowCount = 240
        chunk.resolvedContentReferences.uniqueIndexList[240] = 0xffffffff
        expectExactFields(chunk)
        chunk.scoreList[120] = 100
        chunk.resolvedContentReferences.offsets[0] = -1
        chunk.resolvedContentReferences.lengths[1] = 0
        expectExactFields(chunk)
    })

    test.each([0, 1, 119, 239])('rejects an invalid content reference at row %i', (index) => {
        const chunk = createChunk()
        chunk.resolvedContentReferences.uniqueIndexList[index] = 2
        expect(() => encode(chunk)).toThrow('Invalid resolved term content reference index: 2')
        expect(() => encode({...chunk})).toThrow('Invalid resolved term content reference index: 2')
    })

    test.each([65535, 65536, 0xfffffffe])('preserves legacy fields for content length %i after a compact prefix', (length) => {
        const chunk = createChunk()
        chunk.resolvedContentReferences.lengths[1] = length
        expect(encode(chunk)).toHaveLength(chunk.rowCount * 12)
        expectExactFields(chunk)
    })

    test('preserves float64 scores and fixed content length overrides', () => {
        const chunk = createChunk()
        chunk.scoreList = Float64Array.from(chunk.scoreList, (score, row) => (row === 120 ? -0 : score + 0.25))
        expect(encode(chunk)).toHaveLength(chunk.rowCount * 16)
        expectExactFields(chunk)
        chunk.scoreList = new Int32Array(chunk.rowCount).fill(75)
        chunk.fixedContentLength = 17
        expectExactFields(chunk)
    })

    test.each(['external', 'chunk-proxy', 'accessor', 'score-proxy', 'subclass', 'shared', 'shared-prototype', 'own-buffer', 'own-length', 'reference-replaced', 'ordinary-metadata'])('keeps %s columns on the scalar path', (kind) => {
        let chunk = createChunk()
        switch (kind) {
            case 'external': {
                chunk = {...chunk}

                break
            }
            case 'chunk-proxy': {
                chunk = new Proxy(chunk, {})

                break
            }
            case 'accessor': {
                const scores = chunk.scoreList
                Object.defineProperty(chunk, 'scoreList', {get: () => scores})

                break
            }
            case 'score-proxy': {
                chunk.scoreList = new Proxy(chunk.scoreList, {})

                break
            }
            case 'subclass': {
                class Scores extends Int32Array {}
                chunk.scoreList = new Scores(chunk.scoreList)

                break
            }
            case 'shared':
            case 'shared-prototype': {
                const shared = new SharedArrayBuffer(chunk.rowCount * 4)
                const scores = new Int32Array(shared)
                scores.set(chunk.scoreList)
                if (kind === 'shared-prototype') { Object.setPrototypeOf(shared, ArrayBuffer.prototype) }
                chunk.scoreList = scores

                break
            }
            case 'own-buffer': {
                Object.defineProperty(chunk.scoreList, 'buffer', {value: new ArrayBuffer(chunk.rowCount * 4)})

                break
            }
            case 'own-length': {
                Object.defineProperty(chunk.scoreList, 'length', {value: chunk.rowCount})

                break
            }
            case 'ordinary-metadata': {
                delete chunk.contentMetaByUniqueIndex

                break
            }
            default: {
                chunk.resolvedContentReferences = {...chunk.resolvedContentReferences}
            }
        }
        const fill = vi.spyOn(Uint32Array.prototype, 'fill')
        try {
            expectExactFields(chunk)
            expect(fill).not.toHaveBeenCalled()
        } finally {
            fill.mockRestore()
        }
    })

    test('uses native compact metadata after owned worker copying and the database-to-store handoff', async () => {
        const module = await WebAssembly.compile(await readFile(new URL('../dev/data/dictionary-wasm/term-bank-parser.wasm', import.meta.url)))
        setTermBankWasmModule(module)
        const rows = Array.from({length: 240}, (_, index) => [`name-${index}`, '', 'name', '', index < 120 ? 75 : 50, [`meaning-${Math.floor(index / 120)}`], 1, ''])
        const encoder = new TextEncoder()
        /** @type {import('../ext/js/dictionary/term-bank-wasm-parser.js').TermBankColumnChunk[]} */
        const chunks = []
        await parseTermBankWithWasmColumnChunks([
            encoder.encode(JSON.stringify(rows.slice(0, 120))),
            encoder.encode(JSON.stringify(rows.slice(120))),
        ], 3, (chunk) => {
            chunks.push(structuredClone(copyWasmBackedColumnChunk(chunk)))
        }, 8192, {
            emitContentSlab: true,
            emitTokenBinaryContent: true,
            emitTermByteLists: false,
            mediaHintFastScan: true,
            singleChunk: true,
            compactContentMetadata: true,
            prepareLookupIndexes: true,
            validateGlossaryTypes: true,
        })
        expect(chunks).toHaveLength(1)
        const chunk = chunks[0]
        expect(chunk.contentMetaByUniqueIndex).toBe(true)
        expect(chunk.scoreList).toBeInstanceOf(Int32Array)
        expect(chunk.scoreList.buffer).toBeInstanceOf(ArrayBuffer)
        const plan = chunk.contentDedupPlan
        const metadata = chunk.contentMetaList
        if (!plan || !metadata) { throw new Error('Native content metadata was not produced') }
        for (let index = 0; index < plan.uniqueCount; ++index) {
            plan.resolvedOffsets[index] = 2 ** 40 + metadata[index * 4]
            plan.resolvedLengths[index] = metadata[index * 4 + 1]
        }
        const database = new DictionaryDatabase()
        const resolved = database._createResolvedArtifactTermRecordChunk({
            ...chunk,
            dictionary: 'Native record runs',
            contentDictNameList: null,
        }, chunk.preparedLookupIndexes ?? null, plan, true)
        expect(resolved.contentMetaByUniqueIndex).toBe(true)
        const store = new TermRecordOpfsStore()
        const append = vi.spyOn(store, '_appendEncodedChunk').mockResolvedValue()
        const open = vi.spyOn(store, '_getOrCreateShardState').mockResolvedValue(
            /** @type {ReturnType<TermRecordOpfsStore['_createShardState']>} */ ({}),
        )
        const fill = vi.spyOn(Uint32Array.prototype, 'fill')
        try {
            await store.appendBatchFromArtifactChunkResolvedContent(resolved, [], [], 'raw')
            expect(append).toHaveBeenCalledTimes(1)
            expect(fill.mock.calls).toContainEqual([0, 0, 120])
            expect(fill.mock.calls).toContainEqual([metadata[4], 120, 240])
            const fields = append.mock.calls[0][6]
            expect(fields).toStrictEqual(encode({...resolved}))
        } finally {
            fill.mockRestore()
            open.mockRestore()
            append.mockRestore()
        }
    })
})
