/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'

// This executes the real compiled parser, not a replacement scanner. C admits
// JSON number grammar; the JavaScript materializer separately requires finite
// scores. Infinity-producing but grammatical tokens are controls at this layer.
const wasmPath = process.argv[2] ?? new URL('../../../ext/lib/term-bank-parser.wasm', import.meta.url)
const bytes = await readFile(wasmPath)
const {instance} = await WebAssembly.instantiate(bytes)
const wasm = instance.exports
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const modes = ['contiguous', 'contiguous-hints', 'spans', 'spans-hints']

function parse(token, mode) {
    const row = `["word","reading","tag","",${token},["gloss"],1,""]`
    const inputBanks = mode.startsWith('spans') ? ['[]', `[${row}]`, '[]'] : [`[${row}]`]
    const banks = inputBanks.map((input) => encoder.encode(input))
    const source = encoder.encode(inputBanks.join(' '))
    wasm.wasm_reset_heap()
    const sourcePtr = wasm.wasm_alloc(source.length)
    const outPtr = wasm.wasm_alloc(68 * 4)
    const spansPtr = mode.startsWith('spans') ? wasm.wasm_alloc(banks.length * 8) : 0
    const heap = new Uint8Array(wasm.memory.buffer)
    heap.set(source, sourcePtr)
    if (spansPtr !== 0) {
        const spans = new Uint32Array(wasm.memory.buffer, spansPtr, banks.length * 2)
        let offset = 0
        for (let index = 0; index < banks.length; ++index) {
            spans[index * 2] = offset
            spans[index * 2 + 1] = banks[index].length
            offset += banks[index].length + 1
        }
    }
    const fn = mode.endsWith('hints') ? wasm.parse_term_bank_with_media_hints : wasm.parse_term_bank
    const count = fn(sourcePtr, source.length, outPtr, 4, spansPtr, spansPtr === 0 ? 0 : banks.length)
    if (count !== 1) { return {accepted: false} }
    const meta = new Uint32Array(wasm.memory.buffer, outPtr, 17)
    const begin = meta[8]
    let end = begin
    while (end < source.length && source[end] !== 0x2c && source[end] !== 0x5d && source[end] > 0x20) { ++end }
    return {accepted: true, score: Number(decoder.decode(source.subarray(begin, end)))}
}

const named = [
    '01', '00', '-01', '-00', '1e+', '1e-', '1e', '1E', '1.', '1..2', '1e2e3', '0x10', '1_2',
    '+1', '--1', '-+1', '-', '.', 'NaN', 'Infinity', '-Infinity', 'null', 'true', '"1"', '[]', '{}',
    '0', '-0', '1', '-1', '1.0', '-0.0', '1e0', '-0e0', '1E+2', '2.5e-2', '2147483648', '-2147483649',
    '1099511627776.5', '1e309', '-1e309', '1e-400', ' 1 ', '\t-0\r\n',
]
let seed = 0x92a46e3b
function random() {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return seed >>> 0
}
const alphabet = '0123456789-+.eE_x'
const tokens = [...named]
for (let i = 0; i < 20000; ++i) {
    const length = 1 + random() % 14
    let token = ''
    for (let j = 0; j < length; ++j) { token += alphabet[random() % alphabet.length] }
    tokens.push(token)
}
const failures = []
let total = 0
let failed = 0
for (const token of tokens) {
    let valid = false
    let expected
    try {
        const values = JSON.parse(`[${token}]`)
        valid = values.length === 1 && typeof values[0] === 'number'
        expected = values[0]
    } catch {
        valid = false
    }
    for (const mode of modes) {
        const actual = parse(token, mode)
        ++total
        if (actual.accepted !== valid || (valid && !Object.is(expected, actual.score))) {
            ++failed
            if (failures.length < 40) { failures.push({token, mode, valid, actual}) }
        }
    }
}
const report = {wasmSha256: createHash('sha256').update(bytes).digest('hex'), total, failed, passed: total - failed, failures}
console.log(JSON.stringify(report, null, 2))
process.exitCode = failed === 0 ? 0 : 1
