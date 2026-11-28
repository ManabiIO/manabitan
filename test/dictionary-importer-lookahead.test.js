/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {expect, test, vi} from 'vitest'
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js'
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js'
import {parseTermBankWithWasmColumnChunksParallelLazy} from '../ext/js/dictionary/term-bank-wasm-parser.js'

vi.mock('../ext/js/dictionary/term-bank-wasm-parser.js', async (importOriginal) => {
    const original = /** @type {typeof import('../ext/js/dictionary/term-bank-wasm-parser.js')} */ (await importOriginal())
    return {...original, parseTermBankWithWasmColumnChunksParallelLazy: vi.fn()}
})

test.each([false, true])('forwards next-group content only on the direct path without media preparation (media=%s)', async (media) => {
    /** @typedef {Parameters<Parameters<typeof parseTermBankWithWasmColumnChunksParallelLazy>[3]>[0]} ParsedChunk */
    /** @type {ParsedChunk} */
    const next = {
        rowCount: 1,
        contentRowStart: 0,
        expressionBytesList: [],
        readingBytesList: [],
        readingEqualsExpressionList: new Uint8Array([1]),
        scoreList: new Int32Array(1),
        sequenceList: new Int32Array([-1]),
        contentBytesList: [],
        contentHash1List: new Uint32Array(0),
        contentHash2List: new Uint32Array(0),
        contentBytesBuffer: new Uint8Array(new SharedArrayBuffer(3)),
        contentBytesBaseOffset: 0,
        contentMetaList: new Uint32Array([0, 3, 10, 20]),
        contentUniqueIndexList: new Uint32Array([0]),
        contentDedupPlan: {resolutionDeferred: true},
        termRecordPreinternedPlan: {
            stringLengths: new Uint16Array(0),
            stringsBuffer: new Uint8Array(0),
            expressionIndexes: new Uint32Array(1),
            readingIndexes: new Uint32Array(1),
        },
        mediaRows: [],
    }
    const first = {...next, contentDedupPlan: {}, peekNextChunk: () => next}
    vi.mocked(parseTermBankWithWasmColumnChunksParallelLazy).mockImplementationOnce(async (_loaders, _sizes, _version, onChunk) => {
        await onChunk(first, {processedRows: 1, totalRows: 2, chunkIndex: 1, chunkCount: 2})
        await onChunk(next, {processedRows: 2, totalRows: 2, chunkIndex: 2, chunkCount: 2})
        return true
    })
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader())
    Reflect.set(importer, '_skipImageMetadata', true)
    Reflect.set(importer, '_wasmPassThroughTermContent', true)
    Reflect.set(importer, '_usePrecomputedContentForMediaRows', true)
    /** @type {Record<string, import('core').SafeAny>[]} */
    const emitted = []
    /** @type {Record<string, import('core').SafeAny>[]} */
    const preparations = []
    await Reflect.get(importer, '_readTermBankFileFast').call(
        importer,
        {filename: 'term_bank_1.json'},
        3,
        'Import title',
        false,
        media,
        true,
        'raw-bytes',
        (/** @type {Record<string, import('core').SafeAny>} */ chunk) => {
            emitted.push(chunk)
            if (emitted.length === 1) {
                expect(chunk.peekNextChunk).toBeUndefined()
                if (media) {
                    expect(chunk.peekNextContentChunk).toBeUndefined()
                } else {
                    preparations.push(chunk.peekNextContentChunk())
                }
            }
        },
        {loaders: [async () => new Uint8Array([91, 93])], estimatedByteLengths: [2]},
    )
    expect(emitted).toHaveLength(2)
    if (!media) {
        const prepared = preparations[0]
        expect(prepared).toMatchObject({dictionary: 'Import title', dictionaryTotalRows: 2, contentDictNameList: null, uniformContentDictName: 'raw-v6'})
        expect(prepared?.contentDedupPlan).toBe(emitted[1].contentDedupPlan)
        expect(prepared?.contentBytesBuffer).toBe(emitted[1].contentBytesBuffer)
        expect(prepared?.contentMetaList).toBe(emitted[1].contentMetaList)
        expect(prepared?.contentUniqueIndexList).toBe(emitted[1].contentUniqueIndexList)
    }
})
