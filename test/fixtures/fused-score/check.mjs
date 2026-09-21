/* Copyright (C) 2026 Manabitan authors. SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */
import assert from 'node:assert/strict'
import {readFile, writeFile} from 'node:fs/promises'
import * as parser from '../../../ext/js/dictionary/term-bank-wasm-parser.js'

// Exercise the actual compiled parser, not an integer-decoder model.
parser.setTermBankWasmModule(await WebAssembly.compile(
    await readFile(new URL('../../../ext/lib/term-bank-parser.wasm', import.meta.url)),
))
const encoder = new TextEncoder()
const cases = [
    {name: 'negative-zero-first', scores: ['-0', '1', '2'], fallback: 1},
    {name: 'negative-zero-middle', scores: ['1', '-0', '2'], fallback: 1},
    {name: 'negative-zero-last', scores: ['1', '2', '-0'], fallback: 1},
    {name: 'ordinary-zero', scores: ['0', '1', '-2'], fallback: 0},
    {name: 'int32-boundaries', scores: ['-2147483648', '2147483647', '0'], fallback: 0},
    {name: 'fractional-zero', scores: ['1', '-0.0', '2'], fallback: 1},
    {name: 'exponent-zero', scores: ['1', '-0e0', '2'], fallback: 1},
    {name: 'underflow-zero', scores: ['1', '-1e-999', '2'], fallback: 1},
]
const results = []
for (const {name, scores, fallback} of cases) {
    try {
        // A fractional sibling must not be allowed to hide the raw -0 defect.
        const rows = scores.map((score, i) => `["term-${i}","","","",${score},["g"],${i},""]`)
        const banks = [encoder.encode(`[${rows[0]}]`), encoder.encode(`[${rows.slice(1).join(',')}]`)]
        const actual = []
        const sequences = []
        const expected = scores.map(Number)
        await parser.parseTermBankWithWasmColumnChunks(banks, 3, (chunk) => {
            actual.push(...chunk.scoreList)
            sequences.push(...chunk.sequenceList)
        }, 64, {
            emitContentSlab: true,
            emitTokenBinaryContent: true,
            prepareLookupIndexes: true,
            singleChunk: true,
        })
        const profile = parser.consumeLastTermBankWasmParseProfile()
        assert.equal(profile?.fusedParseAttempts, 1, `${name}: must enter fused parsing`)
        assert.equal(actual.length, expected.length)
        for (let i = 0; i < expected.length; ++i) {
            assert.ok(Object.is(actual[i], expected[i]), `${name}: score ${i} lost numeric identity`)
        }
        assert.equal(profile?.fusedParseFallbacks ?? 0, fallback, `${name}: incorrect execution path`)
        assert.deepEqual(sequences, [0, 1, 2], `${name}: sequence decoding changed`)
        results.push({name, passed: true})
    } catch (error) {
        results.push({name, passed: false, error: String(error)})
    }
}
const report = {node: process.version, passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length, results}
if (process.argv[2]) { await writeFile(process.argv[2], `${JSON.stringify(report, null, 2)}\n`) }
console.log(JSON.stringify(report, null, 2))
if (report.failed !== 0) { process.exitCode = 1 }
