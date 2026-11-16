/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {beforeAll, describe, expect, test} from 'vitest'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js'
import {setTermBankWasmModule} from '../ext/js/dictionary/term-bank-wasm-parser.js'
import {StructuredContentGenerator} from '../ext/js/display/structured-content-generator.js'
import {createDomTest} from './fixtures/dom-test.js'

const encoder = new TextEncoder()
const domTest = createDomTest()

beforeAll(async () => {
    setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))))
})

/**
 * Exercise the actual default native importer and content deserializer. Only
 * archive I/O and OPFS persistence are omitted; the bytes remain authoritative.
 * @param {import('dictionary-data').TermGlossary[]} glossary
 * @returns {Promise<import('dictionary-data').TermGlossary[]>}
 */
async function importNativeGlossary(glossary) {
    const importer = new DictionaryImporter({getImageDetails: async (content) => ({content, width: 0, height: 0})})
    importer._skipImageMetadata = true
    const database = new DictionaryDatabase()
    /** @type {import('dictionary-data').TermGlossary[]|null} */
    let result = null
    const source = encoder.encode(JSON.stringify([['term', '', '', '', 1, glossary, 1, '']]))
    await importer._readTermBankFileFast(
        /** @type {import('@zip.js/zip.js').Entry} */ (/** @type {unknown} */ ({filename: 'term_bank_1.json'})),
        3,
        'Images',
        false,
        true,
        true,
        'raw-bytes',
        async (payload) => {
            const chunk = /** @type {Parameters<DictionaryDatabase['bulkAddArtifactTermsChunk']>[0]} */ (/** @type {unknown} */ (payload))
            const metadata = /** @type {Uint32Array} */ (chunk.contentMetaList)
            const start = /** @type {number} */ (chunk.contentBytesBaseOffset) + metadata[0]
            const bytes = Uint8Array.from(/** @type {Uint8Array} */ (chunk.contentBytesBuffer).subarray(start, start + metadata[1]))
            const [span] = await database._termContentStore.appendBatch([bytes])
            const storedRow = {
                id: 1,
                dictionary: 'Images',
                expression: 'term',
                reading: 'term',
                entryContentOffset: span.offset,
                entryContentLength: span.length,
                entryContentDictName: chunk.uniformContentDictName,
                score: 1,
            }
            const row = await database._deserializeTermRow(storedRow)
            result = row.glossary
            // A cached sibling must see the same normalized content, including
            // the serialized cache form used for lazy glossary hydration.
            expect((await database._deserializeTermRow({...storedRow, id: 2})).glossary).toEqual(result)
            const cached = database._getCachedTermEntryContent(`span:${span.offset}:${span.length}:${chunk.uniformContentDictName}`)
            expect(JSON.parse(cached?.glossaryJson ?? 'null')).toEqual(result)
        },
        source,
    )
    if (result === null) { throw new Error('Expected native imported glossary') }
    return result
}

describe('native dictionary image sizing', () => {
    test.each([
        {source: {width: 32}, expected: {width: 0, height: 0, preferredWidth: 32}},
        {source: {height: 16}, expected: {width: 0, height: 0, preferredHeight: 16}},
        {source: {width: 32, height: 16}, expected: {width: 0, height: 0, preferredWidth: 32, preferredHeight: 16}},
    ])('retains authored top-level image dimensions: $source', async ({source, expected}) => {
        const glossary = await importNativeGlossary([{type: 'image', path: 'image.png', alt: 'caption', ...source}])
        expect(glossary).toEqual([{type: 'image', path: 'image.png', alt: 'caption', ...expected}])
    })

    domTest('retains em units and nested image attributes through native import and rendering', async ({window}) => {
        const data = {class: 'icon', id: 'example', tag: 'img'}
        const glossary = await importNativeGlossary([{
            type: 'structured-content',
            content: [{
                tag: 'div',
                content: [
                    'before',
                    {tag: 'img', path: 'image.png', width: 2, height: 1, sizeUnits: 'em', data, border: '1px solid', verticalAlign: 'middle'},
                    'after',
                ],
            }],
        }])
        const structured = /** @type {import('dictionary-data').TermGlossaryStructuredContent} */ (glossary[0])
        const manager = {
            loadMediaUrl: () => {},
            prepareLink: () => {},
            openMediaInTab: async () => {},
        }
        const generator = new StructuredContentGenerator(manager, window.document, /** @type {Window} */ (/** @type {unknown} */ (window)))
        const node = generator.createStructuredContent(structured.content, 'Images')
        const image = /** @type {HTMLElement} */ (node.querySelector('.gloss-image-link'))
        expect(image.dataset.sizeUnits).toBe('em')
        expect(image.dataset.scClass).toBe('icon')
        expect(image.dataset.scId).toBe('example')
        expect(image.dataset.verticalAlign).toBe('middle')
        expect(image.querySelector('.gloss-image-container')?.getAttribute('style')).toContain('width: 2em;')
        expect(image.querySelector('.gloss-image-sizer')?.getAttribute('style')).toBe('padding-top: 50%;')
    })

    test('leaves missing dimensions, resolved images, and unrelated structured data unchanged', async () => {
        const glossary = /** @type {import('dictionary-data').TermGlossary[]} */ ([
            {type: 'image', path: 'image.png'},
            {type: 'image', path: 'resolved.png', width: 80, height: 40, preferredWidth: 20},
            {
                type: 'structured-content',
                content: {
                    tag: 'span',
                    data: {example: {tag: 'img', path: 'not-an-image.png', width: 5}},
                    content: 'text',
                },
            },
        ])
        expect(await importNativeGlossary(glossary)).toEqual(glossary)
    })

    test('leaves intrinsic dimensions in resolved JSON content unchanged', async () => {
        const database = new DictionaryDatabase()
        const glossary = [{type: 'structured-content', content: {tag: 'img', path: 'image.png', width: 80, height: 40, sizeUnits: 'em'}}]
        const bytes = encoder.encode(JSON.stringify({rules: '', definitionTags: '', termTags: '', glossary}))
        const [span] = await database._termContentStore.appendBatch([bytes])
        const row = await database._deserializeTermRow({
            id: 1,
            dictionary: 'Images',
            expression: 'term',
            reading: 'term',
            entryContentOffset: span.offset,
            entryContentLength: span.length,
            entryContentDictName: 'raw',
            score: 1,
        })
        expect(row.glossary).toEqual(glossary)
    })
})
