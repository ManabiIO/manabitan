/* Copyright (C) 2026 Manabitan authors. SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */
import {readFile, writeFile} from 'node:fs/promises'
import {setTermBankWasmModule} from '../../../ext/js/dictionary/term-bank-wasm-parser.js'
import {runScoreCases} from './cases.mjs'
const wasm = await readFile(new URL('../../../ext/lib/term-bank-parser.wasm', import.meta.url))
setTermBankWasmModule(await WebAssembly.compile(wasm))
const cases = await runScoreCases()
const report = {cases, passed: cases.filter((x) => x.passed).length, failed: cases.filter((x) => !x.passed).length}
console.log(JSON.stringify(report, null, 2))
if (process.argv[2]) { await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n') }
process.exitCode = report.failed === 0 ? 0 : 1
