/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', {ignoreBOM: true})

function equal(actual, expected, message) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
    }
}

function normalize(value) {
    if (Array.isArray(value)) { return value.map(normalize) }
    if (value !== null && typeof value === 'object' && value.type === 'text' && typeof value.text === 'string' &&
    Object.keys(value).every((key) => key === 'type' || key === 'text')) { return value.text }
    return value
}

function containsMedia(value) {
    if (value === null || typeof value !== 'object') { return false }
    if (value.type === 'image' || value.tag === 'img') { return true }
    return Object.values(value).some(containsMedia)
}

function token(value, mask) {
    return `"${[...value].map((c, i) => ((mask & (1 << i)) ? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}` : c)).join('')}"`
}

function decodeContent(bytes) {
    const text = decoder.decode(Uint8Array.from(bytes))
    return text.startsWith('MBR6') ? JSON.parse(text.split('\0').at(-1)) : JSON.parse(text).glossary
}

export function createCases(parser) {
    const cases = []
    const add = (name, run) => { cases.push({name, run}) }
    const fixtures = []
    for (let mask = 0; mask < 32; ++mask) {
        fixtures.push({name: `image marker mask ${mask}`, glossary: `[{"type":${token('image', mask)},"path":"cat.png"}]`})
    }
    for (let mask = 0; mask < 8; ++mask) {
        fixtures.push({name: `nested img marker mask ${mask}`, glossary: `[{"type":"structured-content","content":{"tag":${token('img', mask)},"path":"cat.png"}}]`})
    }
    for (let mask = 0; mask < 16; ++mask) {
        fixtures.push(
            {name: `text key mask ${mask}`, glossary: `[{"type":"text",${token('text', mask)}:"RIGHT"}]`},
            {name: `type key mask ${mask}`, glossary: `[{${token('type', mask)}:"text","text":"RIGHT"}]`},
            {name: `text value mask ${mask}`, glossary: `[{"type":${token('text', mask)},"text":"RIGHT"}]`},
        )
    }
    fixtures.push(
        {name: 'all escaped reversed keys', glossary: `[{${token('text', 15)}:"RIGHT",${token('type', 15)}:${token('text', 15)}}]`},
        {name: 'last literal text wins', glossary: '[{"type":"text","text":"WRONG","text":"RIGHT"}]'},
        {name: 'last escaped text wins', glossary: '[{"type":"text","text":"WRONG","te\\u0078t":"RIGHT"}]'},
        {name: 'last literal overrides escaped text', glossary: '[{"type":"text","te\\u0078t":"WRONG","text":"RIGHT"}]'},
        {name: 'last type wins', glossary: '[{"type":"image","type":"text","text":"RIGHT"}]'},
        {name: 'last escaped type wins', glossary: '[{"type":"image","ty\\u0070e":"te\\u0078t","text":"RIGHT"}]'},
        {name: 'invalid first text replaced', glossary: '[{"type":"text","text":null,"text":"RIGHT"}]'},
        {name: 'last text invalidates earlier string', glossary: '[{"type":"text","text":"WRONG","text":null}]'},
        {name: 'last type invalidates earlier match', glossary: '[{"type":"text","text":"WRONG","type":"other"}]'},
        {name: 'reversed duplicate keys', glossary: '[{"text":"WRONG","type":"image","type":"text","text":"RIGHT"}]'},
        {name: 'unknown shapes remain intact', glossary: '[{"content":["large"],"type":"structured-content"}]'},
        {name: 'nested arrays', glossary: '[[{"ty\\u0070e":"text","text":"RIGHT"}]]'},
        {name: 'quoted text payload intact', glossary: '[{"type":"text","text":"\\uFEFF語\\n\\"image\\""}]'},
        {name: 'near-match names', glossary: '[{"type":"textual","text":"RIGHT"},{"type":"te\\u0078tx","text":"RIGHT"}]'},
        {name: 'near-match image markers', glossary: '[{"type":"im\\u0061gex"},{"tag":"im\\u0067x"}]'},
        {name: 'literal backslash-u is not escape', glossary: '[{"type":"im\\\\u0061ge"},{"type":"te\\\\u0078t","text":"RIGHT"}]'},
        {name: 'uppercase Unicode hex', glossary: '[{"type":"i\\u006Dage","path":"cat.png"}]'},
        {name: 'ordinary strings and scalars', glossary: '["ordinary",12,true,null]'},
        {name: 'large text first', glossary: JSON.stringify([{text: '語'.repeat(5000), type: 'text'}])},
    )
    const variants = [
        {name: 'row-json', mode: 'row', options: {mediaHintFastScan: true, copyContentBytes: true}},
        {name: 'column-token', mode: 'column', options: {mediaHintFastScan: true, emitContentSlab: true, emitTokenBinaryContent: true, singleChunk: true}},
        {name: 'column-experiments', mode: 'column', options: {mediaHintFastScan: true, emitContentSlab: true, emitTokenBinaryContent: true, singleChunk: true, experimentalNativeEscapedKeys: true, experimentalValidatedGlossaryReuse: true, experimentalFastGlossaryNormalization: true}},
    ]
    for (const variant of variants) {
        for (const fixture of fixtures) {
            add(`${variant.name}: ${fixture.name}`, async () => {
                const expected = normalize(JSON.parse(fixture.glossary))
                const source = encoder.encode(`[["猫","ねこ","tag","rule",3,${fixture.glossary},41,"term"]]`)
                const before = [...source]
                let rows = 0
                if (variant.mode === 'row') {
                    const onRows = (chunk) => {
                        for (const row of chunk) {
                            equal(decodeContent(row.termEntryContentBytes), expected, 'encoded glossary')
                            if (containsMedia(expected)) { equal(row.glossaryMayContainMedia, true, 'media hint') }
                            equal([row.expression, row.reading, row.score, row.sequence], ['猫', 'ねこ', 3, 41], 'row metadata')
                            ++rows
                        }
                    }
                    await parser.parseTermBankWithWasmChunks(source, 3, onRows, 1, variant.options)
                } else {
                    const onColumns = (chunk) => {
                        for (let i = 0; i < chunk.rowCount; ++i) {
                            const meta = chunk.contentMetaList
                            const start = meta[i * 4] + (chunk.contentBytesBaseOffset ?? 0)
                            equal(decodeContent(chunk.contentBytesBuffer.subarray(start, start + meta[i * 4 + 1])), expected, 'encoded glossary')
                            if (containsMedia(expected)) { equal(chunk.mediaRows.some((row) => row.index === i), true, 'media row retained') }
                            equal([chunk.scoreList[i], chunk.sequenceList[i]], [3, 41], 'column metadata')
                            ++rows
                        }
                    }
                    await parser.parseTermBankWithWasmColumnChunks([source, encoder.encode('[]')], 3, onColumns, 1, variant.options)
                }
                equal(rows, 1, 'row count')
                equal([...source], before, 'input immutability')
            })
        }
    }
    return cases
}
