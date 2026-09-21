/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */
import assert from 'node:assert/strict'
import {readFile, writeFile} from 'node:fs/promises'
import * as parser from '../../../ext/js/dictionary/term-bank-wasm-parser.js'
import {DictionaryImporter} from '../../../ext/js/dictionary/dictionary-importer.js'
const encoder = new TextEncoder()
parser.setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../../../ext/lib/term-bank-parser.wasm', import.meta.url))))
const results = []
const unhandled = []
process.on('unhandledRejection', (error) => { unhandled.push(String(error)) })
const file = {filename: 'term_bank_1.json'}
function images(value) {
    if (Array.isArray(value)) { return value.flatMap(images) }
    if (value === null || typeof value !== 'object') { return [] }
    if (value.tag === 'img' || value.type === 'image') { return [value] }
    return Object.values(value).flatMap(images)
}
function content(entry) {
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(entry.termEntryContentBytes)))
}
async function check(name, run) {
    try {
        await run()
        results.push({name, passed: true})
    } catch (error) {
        results.push({name, passed: false, error: String(error), stack: error.stack})
    }
}
for (const mode of ['baseline', 'raw-bytes']) {
    for (const dedup of [false, true]) {
        for (const streamed of [false, true]) {
            for (const structured of [false, true]) {
                await check(`resolved media survives serialization: ${mode}, dedup=${dedup}, streamed=${streamed}, structured=${structured}`, async () => {
                    const importer = new DictionaryImporter({})
                    importer._skipImageMetadata = false
                    const source = structured ?
                        {type: 'structured-content', content: {tag: 'img', path: 'pixel.png', title: 'retained'}} :
                        {type: 'image', path: 'pixel.png', title: 'retained'}
                    const bank = encoder.encode(JSON.stringify([['media-word', 'media-reading', '', '', 7, [source], 9, '']]))
                    const entries = []
                    const finish = (rows, requirements) => {
                        assert.ok(Array.isArray(rows), 'this path must emit row objects')
                        assert.equal(requirements.length, 1)
                        for (const requirement of requirements) {
                            importer._assignResolvedImageData(requirement.target, requirement.source, 2, 3)
                        }
                        importer._prepareTermImportSerialization(rows, dedup)
                        const serialized = images(content(rows[0]).glossary)
                        assert.equal(serialized.length, 1)
                        assert.equal(serialized[0].path, 'pixel.png', 'serialized bytes must see resolved path')
                        assert.equal(serialized[0].width, 2)
                        assert.equal(serialized[0].height, 3)
                        assert.equal(serialized[0].title, 'retained')
                        entries.push(...rows)
                    }
                    const result = await importer._readTermBankFileFast(file, 3, 'fixture', false, true, dedup, mode, streamed ? finish : undefined, bank)
                    if (!streamed) { finish(result.termList, result.requirements) }
                    assert.equal(entries.length, 1)
                    assert.equal(entries[0].expression, 'media-word')
                    assert.notEqual(importer._lastFastTermBankReadProfile, null)
                })
            }
        }
    }
}
await check('ordinary rows retain eager serialization despite preceding media requirements', async () => {
    const importer = new DictionaryImporter({})
    importer._skipImageMetadata = false
    const bank = encoder.encode(JSON.stringify([
        ['first', '', '', '', 0, [{type: 'image', path: 'one.png'}], 1, ''],
        ['middle', '', '', '', 0, [{type: 'text', text: 'ordinary text'}], 2, ''],
        ['last', '', '', '', 0, [{type: 'image', path: 'two.png'}], 3, ''],
    ]))
    const {termList, requirements} = await importer._readTermBankFileFast(file, 3, 'fixture', false, true, true, 'raw-bytes', undefined, bank)
    assert.equal(requirements.length, 2)
    assert.deepEqual(content(termList[1]).glossary, ['ordinary text'])
})
await check('conservative image text without requirements preserves its formatted value', async () => {
    const importer = new DictionaryImporter({})
    importer._skipImageMetadata = false
    const value = '{"tag":"img"} is only text'
    const bank = encoder.encode(JSON.stringify([['text', '', '', '', 0, [{type: 'text', text: value}], 1, '']]))
    const {termList, requirements} = await importer._readTermBankFileFast(file, 3, 'fixture', false, true, true, 'raw-bytes', undefined, bank)
    assert.equal(requirements.length, 0)
    assert.deepEqual(content(termList[0]).glossary, [value])
})
await new Promise((resolve) => { setTimeout(resolve, 0) })
const report = {node: process.version, passed: results.filter(({passed}) => passed).length, failed: results.filter(({passed}) => !passed).length, unhandled, results}
if (process.argv[2]) { await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n') }
console.log(JSON.stringify(report, null, 2))
process.exitCode = report.failed || unhandled.length > 0 ? 1 : 0
