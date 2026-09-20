/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */
import {readFile, writeFile} from 'node:fs/promises'
import * as parser from '../../../ext/js/dictionary/term-bank-wasm-parser.js'
import {DictionaryImporter} from '../../../ext/js/dictionary/dictionary-importer.js'
import * as lookup from '../../../ext/js/dictionary/term-lookup-index.js'
import {createCases} from './cases.mjs'
const unhandled = []
process.on('unhandledRejection', (error) => { unhandled.push(String(error)) })
parser.setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../../../ext/lib/term-bank-parser.wasm', import.meta.url))))
const results = []
for (const {name, run} of createCases(parser, DictionaryImporter, lookup)) {
    try {
        await run()
        results.push({name, passed: true})
    } catch (error) {
        results.push({name, passed: false, error: String(error), stack: error.stack})
    }
}
await new Promise((resolve) => { setTimeout(resolve, 0) })
const report = {node: process.version, passed: results.filter(({passed}) => passed).length, failed: results.filter(({passed}) => !passed).length, unhandled, results}
if (process.argv[2]) { await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n') }
console.log(JSON.stringify(report, null, 2))
process.exitCode = report.failed || unhandled.length ? 1 : 0
