/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {beforeAll, describe, expect, test} from 'vitest'
import {
    consumeLastTermBankWasmParseProfile,
    parseTermBankWithWasmChunks,
    parseTermBankWithWasmColumnChunks,
    setTermBankWasmModule,
} from '../ext/js/dictionary/term-bank-wasm-parser.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

beforeAll(async () => {
    setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))))
})

/**
 * Capture values while native spans remain valid. The generic row grammar is
 * an independent reference for valid inputs to strict format-3 validation.
 * @param {string} source
 * @param {boolean} strict
 * @param {boolean} columns
 * @param {boolean} [validatedReuse]
 * @param {string[]} [remainingSources]
 * @returns {Promise<{rows: unknown[], profile: ReturnType<typeof consumeLastTermBankWasmParseProfile>}>}
 */
async function parse(source, strict, columns, validatedReuse = true, remainingSources = ['[]']) {
    /** @type {unknown[]} */
    const rows = []
    const options = {validateGlossaryTypes: strict,
        mediaHintFastScan: true,
        experimentalNativeEscapedKeys: true,
        experimentalValidatedGlossaryReuse: validatedReuse,
        emitContentSlab: true,
        emitTokenBinaryContent: true,
        singleChunk: true}
    await (columns ?
parseTermBankWithWasmColumnChunks([source, ...remainingSources].map((bank) => encoder.encode(bank)), 3, (chunk) => {
    const plan = chunk.termRecordPreinternedPlan
    const offsets = plan.stringOffsets
    const metadata = chunk.contentMetaList
    const content = chunk.contentBytesBuffer
    if (!offsets || !metadata || !content) { throw new Error('Missing native columns') }
    const strings = Array.from(plan.stringLengths, (length, index) => decoder.decode(plan.stringsBuffer.subarray(offsets[index], offsets[index] + length)))
    for (let i = 0; i < chunk.rowCount; ++i) {
        const offset = metadata[i * 4] + (chunk.contentBytesBaseOffset ?? 0)
        rows.push({expression: strings[plan.expressionIndexes[i]],
            reading: strings[plan.readingIndexes[i]],
            score: chunk.scoreList[i],
            sequence: chunk.sequenceList[i],
            contentId: chunk.contentUniqueIndexList?.[i],
            content: createHash('sha256').update(content.subarray(offset, offset + metadata[i * 4 + 1])).digest('hex'),
            hashes: [metadata[i * 4 + 2], metadata[i * 4 + 3]],
            media: chunk.mediaRows.filter((entry) => entry.index === i).map((entry) => entry.row.glossaryJson)})
    }
}, 8192, options) :
parseTermBankWithWasmChunks(encoder.encode(source), 3, (chunk) => {
    for (const row of chunk) {
        rows.push({expression: row.expression,
            reading: row.reading,
            definitionTags: row.definitionTags,
            rules: row.rules,
            score: row.score,
            sequence: row.sequence,
            termTags: row.termTags,
            glossary: JSON.parse(row.glossaryJson),
            media: row.glossaryMayContainMedia})
    }
}, 2, options))
    return {rows, profile: consumeLastTermBankWasmParseProfile()}
}

describe.each([false, true])('strict format-3 row grammar, columns=%s', (columns) => {
    test.each(['', ' ', '\r\n\t'])('preserves nullable fields, escapes and reused glossary hints with whitespace %j', async (space) => {
        const glossary = [{type: 'structured-content', content: [{tag: 'img', path: 'image.webp'}, 'definition'.repeat(600)]}]
        const rows = [
            ['first\\key', 'reading\n一', null, '', 1, glossary, null, 'tag'],
            ['second', '', 'noun', 'v1', 2, glossary, 123, ''],
            ['third', 'third', '', '', 0, ['plain'], -1, 'last'],
        ]
        const source = `[${space}${rows.map((row) => `[${space}${row.map((field) => JSON.stringify(field)).join(`${space},${space}`)}${space}]`).join(`${space},${space}`)}${space}]`
        const actual = await parse(source, true, columns)
        expect(actual.rows).toStrictEqual((await parse(source, false, columns)).rows)
        expect(actual.rows).toHaveLength(3)
        if (columns) {
            expect(actual.profile?.fusedParseAttempts).toBe(1)
            expect(actual.profile?.fusedParseFallbacks).toBe(0)
            expect(actual.profile?.validatedGlossaryReuseCount).toBeGreaterThan(0)
        }
    })

    test.each(['-0', '0.5', '1e3', '-2147483649'])('preserves valid numeric fallback for score %s', async (score) => {
        const source = `[["key","",null,"",${score},["meaning"],null,""]]`
        const actual = await parse(source, true, columns)
        expect(actual.rows).toStrictEqual((await parse(source, false, columns)).rows)
        if (columns) { expect(actual.profile?.fusedParseFallbacks).toBe(1) }
    })

    test.each(Array.from({length: 8}, (_, count) => count))('rejects a row truncated to %i fields after a valid row', async (count) => {
        const row = ['key', '', null, '', 0, ['meaning'], null, '']
        await expect(parse(JSON.stringify([row, row.slice(0, count)]), true, columns)).rejects.toThrow()
    })

    test('rejects extra fields', async () => {
        await expect(parse('[["key","",null,"",0,["meaning"],null,"","extra"]]', true, columns)).rejects.toThrow()
    })

    test.each([
        '["key","",nullx,"",0,["meaning"],null,""]',
        '["key","",null,"",0,["meaning"],null0,""]',
        '["key","",null,"",0,["meaning"],null,"",]',
        '["key","",null,"",01,["meaning"],null,""]',
        '["key","",null,"",0,["meaning"],1e,""]',
        '["key","",null,"",0,["meaning"],null,"\\q"]',
    ])('rejects malformed field boundaries %s', async (row) => {
        await expect(parse(`[${row}]`, true, columns)).rejects.toThrow()
    })
})

describe('complete validated format-3 suffix reuse', () => {
    test.each([1, 2, 3, 4])('reuses a short suffix at distance %i without copying the current prefix', async (distance) => {
        const glossary = [{type: 'structured-content', content: {tag: 'span', content: ['meaning', '色']}}]
        const rows = [
            ['first', 'reading', null, 'v1', 1, glossary, null, 'tag\\value'],
            ...Array.from({length: distance - 1}, (_, index) => [`gap${index}`, '', '', '', index, [`different${index}`], index, '']),
            ['last\\key', 'reading\n一', 'noun', 'v5', 17, glossary, null, 'tag\\value'],
        ]
        const source = JSON.stringify(rows)
        const actual = await parse(source, true, true)
        const reference = await parse(source, true, true, false)
        expect(actual.rows).toStrictEqual(reference.rows)
        expect(actual.rows.at(-1)).toMatchObject({expression: 'last\\key', reading: 'reading\n一', score: 17, sequence: -1})
        expect(actual.profile?.fusedParseFallbacks).toBe(0)
        expect(actual.profile?.validatedGlossaryReuseCount).toBe(1)
        expect(reference.profile?.validatedGlossaryReuseCount).toBe(0)
    })

    test('retains canonical IDs when a nearer equal content row has a different sequence', async () => {
        const rows = [7, 8, 7, 8, 7, 8, 7].map((sequence, index) => [
            `key${index}`, '', 'noun', '', index, ['same definition'], sequence, '',
        ])
        const source = JSON.stringify(rows)
        const actual = await parse(source, true, true)
        expect(actual.rows).toStrictEqual((await parse(source, true, true, false)).rows)
        expect(actual.rows).toMatchObject(rows.map((row) => ({sequence: row[6], contentId: 0})))
        expect(actual.profile?.validatedGlossaryReuseCount).toBeGreaterThan(0)
    })

    test('reuses a short whitespace-delimited suffix across nonempty source banks', async () => {
        const space = '\r\n\t '
        const glossary = [{type: 'text', text: 'short " value'}]
        const rows = [
            ['first', 'reading', null, 'v1', 1, glossary, 73, 'tag\\value'],
            ['gap', '', '', '', 0, ['other'], 42, ''],
            ['last\\key', 'reading\n一', 'noun', 'v5', 17, glossary, 73, 'tag\\value'],
        ].map((row) => `[${space}${row.map((field) => JSON.stringify(field)).join(`${space},${space}`)}${space}]`)
        const firstBank = `[${space}${rows.slice(0, 2).join(`${space},${space}`)}${space}]`
        const secondBank = `[${space}${rows[2]}${space}]`
        const actual = await parse(firstBank, true, true, true, [secondBank])
        const reference = await parse(firstBank, true, true, false, [secondBank])
        expect(actual.rows).toStrictEqual(reference.rows)
        expect(actual.rows).toHaveLength(3)
        expect(actual.rows.at(-1)).toMatchObject({expression: 'last\\key', reading: 'reading\n一', score: 17, sequence: 73})
        expect(actual.profile?.bankSpanCount).toBe(2)
        expect(actual.profile?.fusedParseAttempts).toBe(1)
        expect(actual.profile?.fusedParseFallbacks).toBe(0)
        expect(actual.profile?.validatedGlossaryReuseCount).toBe(1)
        expect(reference.profile?.validatedGlossaryReuseCount).toBe(0)
    })

    test.each([0, -0, 2147483647, null])('preserves sequence %j and media/normalization hints', async (sequence) => {
        const glossary = [{type: 'image', path: 'image.webp'}, {type: 'text', text: 'quoted " value'}]
        const rows = [
            ['first', '', '', '', 0, glossary, sequence, ''],
            ['different', '', '', '', 0, ['other'], 42, ''],
            ['second', '', '', '', 1, glossary, sequence, ''],
        ]
        let source = JSON.stringify(rows)
        if (Object.is(sequence, -0)) { source = source.replaceAll('],0,""]', '],-0,""]') }
        const actual = await parse(source, true, true)
        expect(actual.rows).toStrictEqual((await parse(source, true, true, false)).rows)
    })

    test('requires full byte equality beyond matching glossary samples', async () => {
        const text = 'x'.repeat(80)
        const source = JSON.stringify([
            ['first', '', '', '', 0, [text], 1, ''],
            ['second', '', '', '', 1, [`${text.slice(0, 10)}y${text.slice(11)}`], 1, ''],
        ])
        const actual = await parse(source, true, true)
        expect(actual.rows).toStrictEqual((await parse(source, true, true, false)).rows)
        expect(actual.profile?.validatedGlossaryReuseCount).toBe(0)
    })

    test('retains the existing four-row bound', async () => {
        const rows = [
            ['first', '', '', '', 0, ['same'], 1, ''],
            ...Array.from({length: 4}, (_, index) => [`gap${index}`, '', '', '', 0, [`different${index}`], 1, '']),
            ['last', '', '', '', 1, ['same'], 1, ''],
        ]
        const source = JSON.stringify(rows)
        const actual = await parse(source, true, true)
        expect(actual.rows).toStrictEqual((await parse(source, true, true, false)).rows)
        expect(actual.profile?.validatedGlossaryReuseCount).toBe(0)
    })

    test.each([
        '["second","","","",1,["same"],nullx,""]',
        '["second","","","",1,["same"],null,"\\q"]',
        '["second","","","",1,["same"],null,"","extra"]',
        '["second","","","",1,["same"],null,"",]',
        '["second","","","",1,["same"],null,""}',
    ])('rejects malformed successor suffix %s', async (row) => {
        const first = '["first","","","",0,["same"],null,""]'
        await expect(parse(`[${first},${row}]`, true, true)).rejects.toThrow()
    })

    test('never completes a truncated suffix from the following source bank', async () => {
        const first = '["first","","","",0,["same"],null,"tag"]'
        const second = '["second","","","",1,["same"],null,"tag"]'
        for (let length = second.indexOf('["same"]'); length < second.length; ++length) {
            await expect(parse(`[${first},${second.slice(0, length)}`, true, true)).rejects.toThrow()
        }
    })
})
