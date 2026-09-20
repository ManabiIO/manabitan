/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', {ignoreBOM: true})

function equal(actual, expected, label) {
    if (actual !== expected) { throw new Error(`${label}: values differ (${String(actual).length} vs ${String(expected).length} characters)`) }
}

function check(condition, label) {
    if (!condition) { throw new Error(label) }
}

function row(expression, reading = 'reading', tags = 'tag', rules = 'rule', termTags = 'term') {
    return [expression, reading, tags, rules, 7, ['definition'], 41, termTags]
}

function keyAt(plan, index) {
    let offset = plan.stringOffsets?.[index]
    if (typeof offset !== 'number') {
        offset = 0
        for (let i = 0; i < index; ++i) { offset += plan.stringLengths[i] }
    }
    return decoder.decode(Uint8Array.from(plan.stringsBuffer.subarray(offset, offset + plan.stringLengths[index])))
}

function keyWithBytes(length, alphabet) {
    if (alphabet === 'ascii') { return 'x'.repeat(length) }
    if (alphabet === 'japanese') { return '語'.repeat(Math.floor(length / 3)) + 'x'.repeat(length % 3) }
    return '𠮷'.repeat(Math.floor(length / 4)) + 'x'.repeat(length % 4)
}

export function createCases(parser, lookup) {
    const cases = []
    const add = (name, run) => { cases.push({name, run}) }
    const parseRows = async (input, options = {}) => {
        const result = []
        await parser.parseTermBankWithWasmChunks(encoder.encode(input), 3, (rows) => { result.push(...rows) }, 1, {copyContentBytes: true, ...options})
        return result
    }
    const project = async (input, options = {}) => {
        const result = []
        await parser.parseTermBankWithWasmColumnChunks(encoder.encode(input), 3, (chunk) => {
            const plan = chunk.termRecordPreinternedPlan
            for (let i = 0; i < chunk.rowCount; ++i) {
                result.push({expression: keyAt(plan, plan.expressionIndexes[i]), reading: keyAt(plan, plan.readingIndexes[i])})
            }
            if (chunk.preparedLookupIndexes instanceof Map) {
                for (const [range, prepared] of chunk.preparedLookupIndexes) {
                    const [start, count] = range.split(':').map(Number)
                    const index = lookup.parsePersistedTermLookupIndex(prepared.bytes)
                    for (let i = 0; i < count; ++i) {
                        const expression = keyAt(plan, plan.expressionIndexes[start + i])
                        const matches = lookup.findExactRows(index, encoder.encode(expression), 'expression')
                        check(matches.includes(i), 'prepared index must find the original key')
                    }
                }
            }
        }, 2048, {singleChunk: true, emitContentSlab: true, emitTokenBinaryContent: true, prepareLookupIndexes: true, ...options})
        return {rows: result, profile: parser.consumeLastTermBankWasmParseProfile()}
    }

    for (const field of [0, 1, 2, 3, 7]) {
        for (const prefix of ['\ufeff', '\ufeff\ufeff']) {
            add(`row projection preserves ${prefix.length} leading U+FEFF in field ${field}`, async () => {
                const expected = row('expression')
                expected[field] = prefix + expected[field]
                const [actual] = await parseRows(JSON.stringify([expected]))
                for (const [name, column] of [['expression', 0], ['reading', 1], ['definitionTags', 2], ['rules', 3], ['termTags', 7]]) {
                    equal(actual[name], expected[column], name)
                }
            })
        }
    }
    for (const value of ['\ufeff', '中\ufeff文', '\ufeffword\\path', '\ufeffword"quote', 'normal', '']) {
        add(`token projection control ${JSON.stringify(value)}`, async () => {
            const expected = row(value, value, value, value, value)
            const [actual] = await parseRows(JSON.stringify([expected]))
            for (const key of ['expression', 'reading', 'definitionTags', 'rules', 'termTags']) { equal(actual[key], value, key) }
        })
    }
    add('literal and escaped U+FEFF have identical row projections', async () => {
        const json = JSON.stringify([row('\ufeffword', '\ufeffreading', '\ufefftag', '\ufeffrule', '\ufeffterm')])
        const [literal] = await parseRows(json)
        const [escaped] = await parseRows(json.replaceAll('\ufeff', '\\ufeff'))
        for (const key of ['expression', 'reading', 'definitionTags', 'rules', 'termTags']) { equal(literal[key], escaped[key], key) }
    })
    add('empty reading alias retains leading U+FEFF', async () => {
        const [actual] = await parseRows(JSON.stringify([row('\ufeffword', '')]), {reuseExpressionForReadingDecode: true})
        equal(actual.expression, '\ufeffword', 'expression')
        equal(actual.reading, '\ufeffword', 'reading alias')
    })
    add('row and column projection agree on leading U+FEFF keys', async () => {
        const json = JSON.stringify([row('\ufeffword', '\ufeffreading')])
        const [full] = await parseRows(json)
        const projected = await project(json)
        equal(full.expression, projected.rows[0].expression, 'expression parity')
        equal(full.reading, projected.rows[0].reading, 'reading parity')
    })
    add('multiple chunks reset decoder BOM state without consuming field characters', async () => {
        const values = ['\ufeffa', 'b', '\ufeff\ufeffc', '\ufeffd']
        const actual = await parseRows(JSON.stringify(values.map((value) => row(value))))
        for (let i = 0; i < values.length; ++i) { equal(actual[i].expression, values[i], `row ${i}`) }
    })

    const modes = [
        ['javascript', {useNativeStringPlan: false, experimentalSkipFusedParse: true}],
        ['native', {useNativeStringPlan: true, experimentalSkipFusedParse: true}],
        ['fused', {useNativeStringPlan: true, experimentalFusedSingleBank: true}],
    ]
    for (const [mode, options] of modes) {
        for (const alphabet of ['ascii', 'japanese', 'astral']) {
            for (const field of [0, 1]) {
                for (const length of [65534, 65535, 65536]) {
                    add(`${mode} ${alphabet} field ${field} UTF-8 length ${length}`, async () => {
                        const expected = row('word')
                        expected[field] = keyWithBytes(length, alphabet)
                        equal(encoder.encode(expected[field]).length, length, 'fixture UTF-8 byte length')
                        let value
                        try { value = await project(JSON.stringify([expected]), options) } catch (error) {
                            if (length <= 65535) { throw error }
                            check(/binary record limit/.test(error.message), 'oversize rejection must identify the record limit')
                            return
                        }
                        check(length <= 65535, '65536-byte key must be rejected')
                        equal(value.rows[0].expression, expected[0], 'expression')
                        equal(value.rows[0].reading, expected[1], 'reading')
                        if (mode === 'native') { equal(value.profile.nativeStringPlanFallbackChunkCount, 0, 'native fallback count') }
                        if (mode === 'fused') { equal(value.profile.fusedParseFallbacks, 0, 'fused fallback count') }
                    })
                }
            }
        }
    }
    for (const field of [0, 1]) {
        for (const length of [65534, 65535]) {
            for (const escaping of ['tab', 'unicode']) {
                add(`fused escaped ${escaping} field ${field} UTF-8 length ${length}`, async () => {
                    const expected = row('word')
                    expected[field] = escaping === 'tab' ? 'a'.repeat(length - 1) + '\t' : keyWithBytes(length, 'japanese')
                    let json = JSON.stringify([expected])
                    if (escaping === 'unicode') { json = json.replaceAll('語', '\\u8a9e') }
                    const value = await project(json, {experimentalFusedSingleBank: true, experimentalNativeEscapedKeys: true})
                    equal(value.rows[0].expression, expected[0], 'expression')
                    equal(value.rows[0].reading, expected[1], 'reading')
                    equal(value.profile.fusedParseFallbacks, 0, 'valid maximum decoded key must not force fused fallback')
                })
            }
        }
    }
    add('maximum-length repeated expression and empty-reading aliases remain searchable', async () => {
        const key = keyWithBytes(65535, 'japanese')
        const value = await project(JSON.stringify([row(key, ''), row(key, key), row('next', '')]), {experimentalFusedSingleBank: true})
        equal(value.rows[0].expression, key, 'maximum expression')
        equal(value.rows[0].reading, key, 'empty-reading alias')
        equal(value.rows[1].reading, key, 'explicit alias')
        equal(value.rows[2].expression, 'next', 'following row')
        equal(value.profile.fusedParseFallbacks, 0, 'fused fallback count')
    })
    return cases
}
