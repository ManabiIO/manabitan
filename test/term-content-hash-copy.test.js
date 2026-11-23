/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */
import {readFile} from 'node:fs/promises'
import {beforeAll, expect, test} from 'vitest'
import {hashTermEntryContentBytesPair} from '../ext/js/dictionary/term-entry-content-hash.js'
import {parseTermBankWithWasmColumnChunks, setTermBankWasmModule} from '../ext/js/dictionary/term-bank-wasm-parser.js'

const encoder = new TextEncoder()

beforeAll(async () => {
    setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))))
})

/**
 * @param {Array<{rules: string, definitionTags: string|null, termTags: string, glossary: unknown[], normalizedGlossary?: unknown[]}>} cases
 * @param {boolean} fused
 */
async function verify(cases, fused) {
    const rows = cases.map(({rules, definitionTags, termTags, glossary}, index) => [
        `entry-${index}`, '', definitionTags, rules, index, glossary, index, termTags,
    ])
    const expected = cases.map(({rules, definitionTags, termTags, glossary, normalizedGlossary}) => encoder.encode(
        `MBR6${JSON.stringify(rules)}\0${JSON.stringify(definitionTags ?? '')}\0${JSON.stringify(termTags)}\0${JSON.stringify(normalizedGlossary ?? glossary)}`,
    ))
    let offset = 0
    const sources = fused ? [encoder.encode(JSON.stringify(rows.slice(0, 1))), encoder.encode(JSON.stringify(rows.slice(1)))] : encoder.encode(JSON.stringify(rows))
    await parseTermBankWithWasmColumnChunks(sources, 3, (chunk) => {
        for (let index = 0; index < chunk.rowCount; ++index) {
            const content = expected[offset + index]
            expect(Buffer.compare(chunk.contentBytesList[index], content)).toBe(0)
            expect([chunk.contentHash1List[index], chunk.contentHash2List[index]]).toEqual(hashTermEntryContentBytesPair(content))
        }
        offset += chunk.rowCount
    }, 73, {computeContentHashes: true, emitTokenBinaryContent: true, initialContentBytesPerRow: 16, validateGlossaryTypes: true})
    expect(offset).toBe(cases.length)
}

for (const fused of [false, true]) {
    test(`preserves content and hashes at every header join and suffix tail; fused=${fused}`, async () => {
        const cases = []
        for (let header = 0; header < 16; ++header) {
            for (let length = 508; length < 544; ++length) {
                cases.push({rules: 'v1', definitionTags: 't'.repeat(header), termTags: '', glossary: ['x'.repeat(length)]})
            }
        }
        await verify(cases, fused)
    })

    test(`retains escaped tokens, null normalization and large output growth; fused=${fused}`, async () => {
        const text = '猫\\"\n😀'.repeat(160000)
        await verify([
            {rules: '', definitionTags: null, termTags: '', glossary: [text]},
            {rules: 'v1', definitionTags: 'quoted"tag', termTags: '日本語', glossary: [{type: 'structured-content', content: {tag: 'div', content: text}}]},
            {rules: '', definitionTags: '', termTags: '', glossary: [{type: 'text', text}], normalizedGlossary: [text]},
            {rules: 'v1', definitionTags: 'quoted"tag', termTags: '日本語', glossary: [{type: 'structured-content', content: {tag: 'div', content: text}}]},
            {rules: '', definitionTags: null, termTags: '', glossary: [text]},
        ], fused)
    })
}
