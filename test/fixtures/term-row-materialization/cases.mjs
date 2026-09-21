/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

function equal(actual, expected, label) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`)
    }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', {ignoreBOM: true})
const text = (bytes) => decoder.decode(Uint8Array.from(bytes))
const rows = [
    ['日本語', 'にほんご', 'noun', '', 42, ['Japanese'], 12, 'common'],
    ['literal', '', null, '', -2, ['definition'], 13, ''],
    ['quoted "term"', 'literal-reading', '', '', 3, ['quoted'], 14, ''],
    ['literal-expression', 'reading "two"', '', '', 4, ['mixed'], 15, ''],
    ['same', 'same', '', '', 5, [], 16, ''],
    ['\uFEFF\uFEFFword', '\uFEFFreading', '', '', 6, ['BOM is field data'], 17, ''],
    ['𠮷野家', '', '', '', 7, ['supplementary Unicode'], 18, ''],
]

function sourceRows(values, escapeNonAscii = false) {
    const json = JSON.stringify(values)
    return encoder.encode(escapeNonAscii ? json.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`) : json)
}

// Runs production parser and importer; no archive, media, or database I/O.
export function createCases(parser, DictionaryImporter, lookup) {
    const cases = []
    const add = (name, run) => cases.push({name, run})
    const makeImporter = () => new DictionaryImporter({})
    const file = {filename: 'term_bank_1.json'}
    const expectedKeys = rows.map(([expression, reading]) => [expression, reading || expression])
    const assertKeys = (entries) => equal(entries.map(({expression, reading}) => [expression, reading]), expectedKeys, 'materialized keys')
    const assertContent = (entries) => {
        equal(entries.map(({score, sequence}) => [score, sequence]), rows.map((row) => [row[4], row[6]]), 'numeric fields')
        equal(entries.map(({termEntryContentBytes}) => JSON.parse(text(termEntryContentBytes)).glossary), rows.map((row) => row[5]), 'authoritative content')
    }

    for (const streamed of [false, true]) {
        for (const escaped of [false, true]) {
            for (const dedup of [false, true]) {
                add(`row keys: ${streamed ? 'streamed' : 'collected'}, ${escaped ? 'escaped' : 'literal'}, dedup=${dedup}`, async () => {
                    const importer = makeImporter()
                    const entries = []
                    const callback = streamed ? (chunk) => { entries.push(...chunk) } : undefined
                    const result = await importer._readTermBankFileFast(file, 3, 'fixture', false, false, dedup, 'baseline', callback, sourceRows(rows, escaped), 2)
                    if (!streamed) { entries.push(...result.termList) }
                    assertKeys(entries)
                    assertContent(entries)
                    equal(entries.map(({glossaryJson}) => JSON.parse(glossaryJson)), rows.map((row) => row[5]), 'materialized glossary JSON')
                    equal(entries.every(({dictionary}) => dictionary === 'fixture'), true, 'dictionary identity')
                })
            }
        }
    }

    for (const streamed of [false, true]) {
        for (const minimal of [false, true]) {
            add(`prefix reverse fields: streamed=${streamed}, minimal=${minimal}`, async () => {
                const importer = makeImporter()
                importer._wasmCanonicalRowsFastPath = minimal
                const entries = []
                const callback = streamed ? (chunk) => { entries.push(...chunk) } : undefined
                const result = await importer._readTermBankFileFast(file, 3, 'fixture', true, false, true, 'baseline', callback, sourceRows(rows), 2)
                if (!streamed) { entries.push(...result.termList) }
                equal(entries.map(({expressionReverse, readingReverse}) => [expressionReverse, readingReverse]), expectedKeys.map((pair) => pair.map((s) => [...s].reverse().join(''))), 'reverse keys')
            })
        }
    }

    for (const mode of ['baseline', 'raw-bytes']) {
        add(`full-decode control: ${mode}`, async () => {
            const importer = makeImporter()
            importer._wasmCanonicalRowsFastPath = false
            const {termList} = await importer._readTermBankFileFast(file, 3, 'fixture', false, false, true, mode, undefined, sourceRows(rows))
            assertKeys(termList)
            equal(termList.every((row) => !('expressionReverse' in row)), true, 'no unwanted reverse fields')
        })
    }

    for (const glossary of [[], ['ordinary'], ['\uFEFFtext', 'escaped "quote"'], [{type: 'image', path: 'picture.png'}]]) {
        for (const lazy of [false, true]) {
            for (const metadata of [false, true]) {
                add(`minimal glossary: lazy=${lazy}, metadata=${metadata}, ${JSON.stringify(glossary)}`, async () => {
                    const importer = makeImporter()
                    await parser.parseTermBankWithWasmChunks(sourceRows([['key', '', '', '', 1, glossary, 3, '']]), 3, (chunk) => {
                        equal(JSON.parse(importer._getFastRowGlossaryJson(chunk[0])), glossary, 'glossary selected by importer')
                    }, 1, {minimalDecode: true, lazyGlossaryDecode: lazy, includeContentMetadata: metadata})
                })
            }
        }
    }

    for (const path of ['plain.png', '\uFEFFpicture.png', '\uFEFF\uFEFFpicture.png', 'dir/\uFEFFpicture.png', 'é/𠮷.png']) {
        for (const escaped of [false, true]) {
            add(`image path token: ${JSON.stringify(path)}, escaped=${escaped}`, () => {
                const importer = makeImporter()
                const bytes = sourceRows([{type: 'image', path}], escaped)
                equal(importer._extractImagePathsFromGlossaryJsonBytes(bytes), [path], 'exact asset path')
            })
        }
    }

    for (const escaped of [false, true]) {
        add(`actual column media requirements: escaped=${escaped}`, async () => {
            const importer = makeImporter()
            importer._skipImageMetadata = true
            const paths = ['\uFEFFone.png', '\uFEFF\uFEFFtwo.png', 'dir/\uFEFFthree.png']
            const bank = paths.map((path, i) => [`\uFEFFkey-${i}`, `\uFEFFread-${i}`, '', '', i, [{type: 'image', path}], i, ''])
            const requirements = []
            await importer._readTermBankFileFast(file, 3, 'fixture', false, true, true, 'raw-bytes', (chunk, requested) => {
                equal(chunk.rowCount, bank.length, 'column rows')
                requirements.push(...requested)
            }, sourceRows(bank, escaped))
            equal(requirements.map((item) => [item.source.path, item.entry.expression, item.entry.reading]), bank.map((row) => [row[5][0].path, row[0], row[1]]), 'media requirements retain field identity')
        })
    }

    add('collected keys and content survive a following native parse', async () => {
        const importer = makeImporter()
        const {termList} = await importer._readTermBankFileFast(file, 3, 'fixture', false, false, true, 'baseline', undefined, sourceRows(rows))
        await parser.parseTermBankWithWasm(sourceRows(Array.from({length: 4096}, (_, i) => [`replacement-${i}`, '', '', '', i, ['replacement content'], i, ''])), 3)
        assertKeys(termList)
        assertContent(termList)
    })

    add('materialized rows build searchable persisted-format lookup bytes', async () => {
        const importer = makeImporter()
        const {termList} = await importer._readTermBankFileFast(file, 3, 'fixture', false, false, true, 'baseline', undefined, sourceRows(rows))
        const bytes = lookup.encodePersistedTermLookupIndex(termList.map((entry) => ({
            expressionBytes: encoder.encode(entry.expression),
            readingBytes: encoder.encode(entry.reading),
            sequence: entry.sequence,
        })))
        const index = lookup.parsePersistedTermLookupIndex(bytes)
        for (let i = 0; i < rows.length; ++i) {
            equal(lookup.findExactRows(index, encoder.encode(expectedKeys[i][0]), 'expression'), [i], 'indexed expression')
            equal(lookup.findExactRows(index, encoder.encode(expectedKeys[i][1]), 'reading'), [i], 'indexed reading')
            equal(lookup.findSequenceRows(index, rows[i][6]), [i], 'indexed sequence')
        }
    })

    add('shared WASM field decoding does not depend on the global constructor', () => {
        const bytes = new Uint8Array(new WebAssembly.Memory({initial: 1, maximum: 1, shared: true}).buffer, 0, 12)
        bytes.set(encoder.encode('["shared"]'))
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'SharedArrayBuffer')
        const decode = TextDecoder.prototype.decode
        try {
            Object.defineProperty(globalThis, 'SharedArrayBuffer', {configurable: true, value: undefined})
            TextDecoder.prototype.decode = function rejectSharedInput(input, options) {
                if (ArrayBuffer.isView(input) && !(input.buffer instanceof ArrayBuffer)) {
                    throw new Error('Shared bytes must be copied before TextDecoder')
                }
                return decode.call(this, input, options)
            }
            equal(makeImporter()._getFastRowGlossaryJson({glossaryJson: '', glossaryJsonBytes: bytes.subarray(0, 10)}), '["shared"]', 'hidden constructor decoding')
        } finally {
            TextDecoder.prototype.decode = decode
            if (descriptor) {
                Object.defineProperty(globalThis, 'SharedArrayBuffer', descriptor)
            } else {
                delete globalThis.SharedArrayBuffer
            }
        }
    })

    add('whole JSON decoder still strips a document BOM', () => {
        const importer = makeImporter()
        const row = {glossaryJson: '', glossaryJsonBytes: encoder.encode('\uFEFF["document"]')}
        equal(JSON.parse(importer._getFastRowGlossaryJson(row)), ['document'], 'document BOM semantics')
    })
    return cases
}
