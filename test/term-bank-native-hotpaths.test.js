/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */
import {readFile} from 'node:fs/promises'
import {beforeAll, expect, test} from 'vitest'
import {hashTermEntryContentBytesPair} from '../ext/js/dictionary/term-entry-content-hash.js'
import {parseTermBankWithWasmChunks, parseTermBankWithWasmColumnChunks, setTermBankWasmModule} from '../ext/js/dictionary/term-bank-wasm-parser.js'

beforeAll(async () => {
    setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))))
})

/**
 * @param {string} word
 * @param {number} mask
 * @returns {string}
 */
function quoted(word, mask) {
    return `"${[...word].map((char, index) => ((mask & (1 << index)) !== 0 ? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}` : char)).join('')}"`
}

/**
 * @param {string} glossary
 * @returns {Promise<{content: unknown, media: boolean|undefined}>}
 */
async function parse(glossary) {
    const bytes = new TextEncoder().encode(`[["head","","","",0,${glossary},1,""]]`)
    /** @type {unknown} */
    let content
    /** @type {boolean|undefined} */
    let media
    let count = 0
    await parseTermBankWithWasmChunks(bytes, 3, (rows) => {
        for (const row of rows) {
            ++count
            content = JSON.parse(new TextDecoder().decode(row.termEntryContentBytes))
            media = row.glossaryMayContainMedia
        }
    }, 2048, {copyContentBytes: true, mediaHintFastScan: true})
    expect(count).toBe(1)
    return {content, media}
}

for (const marker of ['img', 'image']) {
    for (let mask = 0; mask < (1 << marker.length); ++mask) {
        test(`recognizes ${marker} with Unicode escape mask ${mask}`, async () => {
            const glossary = `[{"type":"structured-content","content":{"tag":${quoted(marker, mask)},"path":"picture.png"}}]`
            const result = await parse(glossary)
            expect(result.media).toBe(true)
            expect(result.content).toEqual({rules: '', definitionTags: '', termTags: '', glossary: JSON.parse(glossary)})
        })
    }
}

for (let mask = 0; mask < 16; ++mask) {
    test(`normalizes text object with mixed escaped keys and value ${mask}`, async () => {
        const result = await parse(`[{${quoted('type', mask)}:${quoted('text', 15 - mask)},${quoted('text', mask)}:"payload"}]`)
        expect(result.content).toEqual({rules: '', definitionTags: '', termTags: '', glossary: ['payload']})
        expect(result.media).toBe(false)
    })
}

for (const marker of ['', 'i', 'im', 'imag', 'imagex', 'imgx', 'image ', 'imagination', 'Image', 'ximage']) {
    test(`does not treat near-match ${JSON.stringify(marker)} as an image marker`, async () => {
        const result = await parse(JSON.stringify([marker]))
        expect(result.media).toBe(false)
        expect(result.content).toEqual({rules: '', definitionTags: '', termTags: '', glossary: [marker]})
    })
}

test('does not normalize near-match type/text keys', async () => {
    for (const object of [{typex: 'text', text: 'payload'}, {type: 'textx', text: 'payload'}, {type: 'text', textx: 'payload'}]) {
        const result = await parse(JSON.stringify([object]))
        expect(result.content).toEqual({rules: '', definitionTags: '', termTags: '', glossary: [object]})
    }
})

test('rejects incomplete and malformed escaped markers', async () => {
    for (const glossary of ['["\\u0069mage', '["\\u00', '["\\u007xmage"]', '[{"ty\\u0070e":"te\\u007xt","text":"x"}]']) {
        await expect(parse(glossary)).rejects.toThrow()
    }
})

for (const tokenBinary of [false, true]) {
    test(`preserves both hash seeds across vector widths, tails and offsets; tokenBinary=${tokenBinary}`, async () => {
        const lengths = [...Array.from({length: 273}, (_, index) => index), 511, 512, 513, 1023, 1024, 1025, 4095, 4096, 4097, 65535]
        const rows = lengths.map((length, index) => [
            `word-${index}`,
            '',
            'tag'.repeat(index % 5),
            'v1'.repeat(index % 3),
            0,
            ['猫\\"\n😀'.repeat(Math.ceil(length / 7)).slice(0, length)],
            index,
            'term'.repeat(index % 7),
        ])
        let count = 0
        await parseTermBankWithWasmColumnChunks(new TextEncoder().encode(JSON.stringify(rows)), 3, (chunk) => {
            expect(chunk.contentBytesList).toHaveLength(chunk.rowCount)
            for (let index = 0; index < chunk.rowCount; ++index) {
                expect(hashTermEntryContentBytesPair(chunk.contentBytesList[index])).toEqual([
                    chunk.contentHash1List[index], chunk.contentHash2List[index],
                ])
                ++count
            }
        }, 2048, {computeContentHashes: true, emitTokenBinaryContent: tokenBinary})
        expect(count).toBe(lengths.length)
    })
}
