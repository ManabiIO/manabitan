/* Copyright (C) 2026 Manabitan authors. SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */
import {readFile, writeFile} from 'node:fs/promises'
import {setTermBankWasmModule} from '../../../ext/js/dictionary/term-bank-wasm-parser.js'
import {runNativePersistence} from './cases.mjs'
import {createNodeOpfs} from './node-opfs-adapter.mjs'
const wasm = await readFile(new URL('../../../ext/lib/term-bank-parser.wasm', import.meta.url))
setTermBankWasmModule(await WebAssembly.compile(wasm))
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const report = []
for (const [name, tokens] of [
    ['negative-only', ['1', '-0', '0', '-1']],
    ['repeated-negative', ['-0', '-0', '-0', '-0']],
    ['integer-control', ['0', '1', '-1', '2147483647']],
    ['mixed-fallback-control', ['1.5', '-0', '0', '1099511627776.5']],
]) {
    const fs = await createNodeOpfs()
    Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {storage: {getDirectory: async () => fs.root}}})
    try {
        const result = await runNativePersistence(tokens, false)
        report.push({name, ...result, realFileWrites: fs.operations.filter((x) => x.type === 'write').length})
    } catch (error) { report.push({name, passed: false, error: error.stack}) }
    finally { await fs.dispose() }
}
if (navigatorDescriptor) { Object.defineProperty(globalThis, 'navigator', navigatorDescriptor) }
else { delete globalThis.navigator }
console.log(JSON.stringify(report, null, 2))
if (process.argv[2]) { await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n') }
process.exitCode = report.every((x) => x.passed) ? 0 : 1
