/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */
import {readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import assert from 'node:assert/strict'

const root = path.resolve(process.argv[2] ?? '.')
// eslint-disable-next-line no-unsanitized/method -- Select the explicitly provided local checkout for red/green testing.
const {DictionaryImporter} = await import(pathToFileURL(path.join(root, 'ext/js/dictionary/dictionary-importer.js')))
// eslint-disable-next-line no-unsanitized/method -- Select the same local checkout's actual native parser.
const parser = await import(pathToFileURL(path.join(root, 'ext/js/dictionary/term-bank-wasm-parser.js')))
parser.setTermBankWasmModule(await WebAssembly.compile(await readFile(path.join(root, 'ext/lib/term-bank-parser.wasm'))))
const encoder = new TextEncoder()
const results = []
const makeImporter = () => new DictionaryImporter({getImageDetails: async () => ({width: 1, height: 1})}, () => {})
async function check(name, run) {
    try { await run(); results.push({name, passed: true}) }
    catch (error) { results.push({name, passed: false, error: error.stack}) }
}
const escapedMarker = '[{"type":"im\\u0061ge","path":"one.png"}]'
const mixedPaths = '[{"type":"image","path":"one.png"},{"type":"image","pa\\u0074h":"two.png"}]'
for (const fast of [false, true]) {
    await check(`media predicate escaped marker; fast=${fast}`, () => {
        const importer = makeImporter()
        importer._glossaryMediaFastScan = fast
        assert.equal(importer._glossaryJsonLikelyContainsMedia(escapedMarker), true)
    })
}
for (const bytes of [false, true]) {
    await check(`partial raw/escaped path scan declines; bytes=${bytes}`, () => {
        const importer = makeImporter()
        const requirements = []
        const row = bytes ? {glossaryJsonBytes: encoder.encode(mixedPaths)} : {glossaryJson: mixedPaths}
        assert.equal(importer._tryAddFastMediaRequirementsFromFastRow(row, {}, requirements), false)
        assert.deepEqual(requirements, [])
    })
    await check(`ordinary path scan stays fast; bytes=${bytes}`, () => {
        const importer = makeImporter()
        const requirements = []
        const glossary = '[{"type":"image","path":"one.png"}]'
        const row = bytes ? {glossaryJsonBytes: encoder.encode(glossary)} : {glossaryJson: glossary}
        assert.equal(importer._tryAddFastMediaRequirementsFromFastRow(row, {}, requirements), true)
        assert.deepEqual(requirements.map(({source}) => source.path), ['one.png'])
    })
}
for (const skipImageMetadata of [false, true]) {
    for (const [name, glossary, expected] of [
        ['escaped marker', escapedMarker, ['one.png']],
        ['mixed path spellings', mixedPaths, ['one.png', 'two.png']],
        ['escaped nested tag and path', '[{"type":"structured-content","content":{"tag":"i\\u006dg","pa\\u0074h":"nested.png"}}]', ['nested.png']],
        ['ordinary control', '[{"type":"image","path":"one.png"}]', ['one.png']],
    ]) {
        await check(`actual parser/importer: ${name}; skipMetadata=${skipImageMetadata}`, async () => {
            const importer = makeImporter()
            importer._skipImageMetadata = skipImageMetadata
            const requirements = []
            const bank = encoder.encode(`[["猫","ねこ","","",1,${glossary},41,""]]`)
            await importer._readTermBankFileFast(
                {filename: 'term_bank_1.json'}, 3, 'Semantics', false, true, true, 'raw-bytes',
                (_rows, chunkRequirements) => { requirements.push(...(chunkRequirements ?? [])) }, bank,
            )
            assert.deepEqual(requirements.map(({source}) => source.path).sort(), expected.sort())
        })
    }
}
const report = {passed: results.filter((r) => r.passed).length, failed: results.filter((r) => !r.passed).length, results}
if (process.argv[3]) { await writeFile(process.argv[3], JSON.stringify(report, null, 2) + '\n') }
console.log(JSON.stringify(report))
process.exitCode = report.failed ? 1 : 0
