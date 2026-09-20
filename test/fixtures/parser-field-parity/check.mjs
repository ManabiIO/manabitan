/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */
import {readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import {createCases} from './cases.mjs'

const root = path.resolve(process.argv[2] ?? '.')
const parserFile = path.join(root, 'ext/js/dictionary/term-bank-wasm-parser.js')
const wasmFile = path.join(root, 'ext/lib/term-bank-parser.wasm')
// eslint-disable-next-line no-unsanitized/method -- The CLI intentionally selects a local red/green source root.
const parser = await import(pathToFileURL(parserFile))
// eslint-disable-next-line no-unsanitized/method -- The CLI intentionally selects a local red/green source root.
const lookup = await import(pathToFileURL(path.join(root, 'ext/js/dictionary/term-lookup-index.js')))
const wasmBytes = await readFile(wasmFile)
parser.setTermBankWasmModule(await WebAssembly.compile(wasmBytes))
const results = []
for (const entry of createCases(parser, lookup)) {
    try {
        await entry.run()
        results.push({name: entry.name, passed: true})
    } catch (error) {
        results.push({name: entry.name, passed: false, error: error.stack})
    }
}
const report = {
    node: process.version,
    parserSha256: createHash('sha256').update(await readFile(parserFile)).digest('hex'),
    wasmSha256: createHash('sha256').update(wasmBytes).digest('hex'),
    passed: results.filter((entry) => entry.passed).length,
    failed: results.filter((entry) => !entry.passed).length,
    results,
}
if (process.argv[3]) { await writeFile(process.argv[3], JSON.stringify(report, null, 2) + '\n') }
console.log(JSON.stringify({passed: report.passed, failed: report.failed}))
for (const entry of results.filter((value) => !value.passed)) { console.error(`${entry.name}: ${entry.error.split('\n')[0]}`) }
process.exitCode = report.failed > 0 ? 1 : 0
