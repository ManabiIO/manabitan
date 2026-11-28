/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {expect, test, vi} from 'vitest'
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js'
import {snapshotTermBankExperiments} from '../ext/js/dictionary/term-bank-experiments.js'
import * as parser from '../ext/js/dictionary/term-bank-wasm-parser.js'
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js'

test.each([false, true])('materializes a ready direct chunk once when lookahead is %s', async (enabled) => {
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader())
    Reflect.set(importer, '_termBankExperiments', snapshotTermBankExperiments({experimentalDedupLookahead: enabled}))
    const firstProgress = {processedRows: 1, totalRows: 2, chunkIndex: 1, chunkCount: 2}
    const nextProgress = {processedRows: 2, totalRows: 2, chunkIndex: 2, chunkCount: 2}
    const next = /** @type {parser.TermBankColumnChunk} */ (/** @type {unknown} */ ({rowCount: 1, mediaRows: []}))
    const first = /** @type {parser.TermBankColumnChunk} */ (/** @type {unknown} */ ({
        rowCount: 1, mediaRows: [], peekNextReadyChunk: () => ({chunk: next, progress: nextProgress}),
    }))
    const parse = vi.spyOn(parser, 'parseTermBankWithWasmColumnChunksParallelLazy').mockImplementation(async (_loaders, _sizes, _version, sink) => {
        await sink(first, firstProgress)
        delete first.peekNextReadyChunk
        next.peekNextReadyChunk = () => null
        await sink(next, nextProgress)
        delete next.peekNextReadyChunk
        return true
    })
    /** @type {unknown} */
    let prepared = null
    /** @type {unknown[]} */
    const received = []
    try {
        await importer._readTermBankFileFast(
            /** @type {import('@zip.js/zip.js').Entry} */ ({filename: 'term_bank_1.json'}),
            3,
            'JMdict',
            false,
            false,
            true,
            'raw-bytes',
            async (chunk, requirements, progress) => {
                expect(requirements).toBeNull()
                received.push(chunk)
                const peek = Reflect.get(chunk, 'peekNextTermChunk')
                if (progress.chunkIndex === 1) {
                    if (enabled) {
                        if (typeof peek !== 'function') { throw new Error('Missing direct-chunk peek') }
                        prepared = peek()
                        expect(prepared).toMatchObject({dictionary: 'JMdict', dictionaryTotalRows: 2, rowCount: 1})
                        expect(peek()).toBe(prepared)
                    } else {
                        expect(peek).toBeUndefined()
                    }
                } else if (enabled) {
                    expect(chunk).toBe(prepared)
                    expect(typeof peek).toBe('function')
                    expect(peek()).toBeNull()
                }
            },
            {loaders: [async () => new Uint8Array([91, 93])], estimatedByteLengths: [2]},
        )
        expect(received).toHaveLength(2)
        expect(parse).toHaveBeenCalledOnce()
    } finally {
        parse.mockRestore()
    }
})
