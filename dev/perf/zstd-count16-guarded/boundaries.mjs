/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile, writeFile} from 'node:fs/promises'
import {join, resolve} from 'node:path'

const [directoryPath, outputPath] = process.argv.slice(2)
assert(directoryPath && outputPath, 'Expected probe directory and new output path')
const directory = resolve(directoryPath)
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const modules = {}
const identities = {}
for (const name of ['baseline', 'superseded', 'guarded']) {
    const bytes = await readFile(join(directory, `${name}.wasm`))
    const {instance} = await WebAssembly.instantiate(bytes, {})
    instance.exports._initialize?.()
    const memory = instance.exports.memory
    assert(memory instanceof WebAssembly.Memory)
    assert.equal(memory.buffer.byteLength, 131072)
    modules[name] = {exports: instance.exports, bytes: new Uint8Array(memory.buffer)}
    identities[name] = {sha256: sha256(bytes), bytes: bytes.byteLength}
}
const end = modules.baseline.bytes.length
const originalScratchStart = 32768
const counts = {}
const supersededFailures = {traps: 0, wrongResults: 0, examples: []}
function record(category) { counts[category] = (counts[category] ?? 0) + 1 }
function fill(start, length, value = 0x41) {
    assert(start >= originalScratchStart && start + length <= end)
    for (const {bytes} of Object.values(modules)) bytes.fill(value, start, start + length)
}
function set(offset, value) {
    assert(offset >= originalScratchStart && offset < end)
    for (const {bytes} of Object.values(modules)) bytes[offset] = value
}
function byteOracle(input, match, limit) {
    const bytes = modules.baseline.bytes
    let result = 0
    while (input + result < limit && bytes[input + result] === bytes[match + result]) ++result
    return result
}
function verify(category, name, args, expected, observeSuperseded = false) {
    record(category)
    for (const variant of ['baseline', 'guarded']) {
        assert.equal(modules[variant].exports[name](...args), expected, `${category}: ${variant} ${name}(${args})`)
    }
    if (!observeSuperseded) {
        assert.equal(modules.superseded.exports[name](...args), expected, `${category}: superseded normal-span parity`)
        return
    }
    try {
        const actual = modules.superseded.exports[name](...args)
        if (actual !== expected) {
            ++supersededFailures.wrongResults
            if (supersededFailures.examples.length < 24) supersededFailures.examples.push({category, name, args, expected, actual})
        }
    } catch (error) {
        assert(error instanceof WebAssembly.RuntimeError)
        ++supersededFailures.traps
        if (supersededFailures.examples.length < 24) supersededFailures.examples.push({category, name, args, expected, error: error.message})
    }
}

// The unchanged normal-span behavior is checked against both original source
// and a byte oracle for every short mismatch and all input/match alignments.
for (let inputAlignment = 0; inputAlignment < 16; ++inputAlignment) {
    for (let matchAlignment = 0; matchAlignment < 16; ++matchAlignment) {
        const input = 32768 + inputAlignment
        const match = 65536 + matchAlignment
        fill(input, 66)
        fill(match, 66)
        for (let length = 0; length <= 65; ++length) {
            verify('normal-equal-all-alignments', 'countMatch', [input, match, input + length], length)
            for (let mismatch = 0; mismatch < length; ++mismatch) {
                set(match + mismatch, 0x40)
                verify('normal-mismatch-all-alignments', 'countMatch', [input, match, input + length], byteOracle(input, match, input + length))
                set(match + mismatch, 0x41)
            }
        }
    }
}

// A limit equal to or before input must not dereference either pointer, even
// when that pointer is the one-past-end address of linear memory.
for (let alignment = 0; alignment < 16; ++alignment) {
    for (const [input, match] of [[end, 65536 + alignment], [32768 + alignment, end], [end, end]]) {
        verify('empty-at-heap-end', 'countMatch', [input, match, input], 0)
        for (const delta of [1, 2, 3, 4, 7, 8, 15, 16, 17, 65]) {
            verify('reversed-limit-at-heap-end', 'countMatch', [input, match, input - delta], 0, true)
        }
    }
}
fill(32768, 64)
fill(65536, 64)
set(65543, 0x40)
verify('reversed-limit-interior-wrong-result', 'countMatch', [32768, 65536, 32765], 0, true)

for (let length = 0; length <= 65; ++length) {
    for (let alignment = 0; alignment < 16; ++alignment) {
        for (const [input, match] of [[end - length, 65536 + alignment], [32768 + alignment, end - length]]) {
            fill(input, length)
            fill(match, length)
            verify('normal-exact-heap-end', 'countMatch', [input, match, input + length], length)
            for (const mismatch of new Set([0, length - 1].filter((x) => x >= 0 && x < length))) {
                set(match + mismatch, 0x40)
                verify('mismatch-exact-heap-end', 'countMatch', [input, match, input + length], mismatch)
                set(match + mismatch, 0x41)
            }
        }
    }
}

for (const distance of [0, 1, 2, 3, 7, 8, 15, 16, 17, 31]) {
    for (let length = 0; length <= 65; ++length) {
        const input = 65568
        const match = input - distance
        fill(match, length + distance)
        verify('identical-or-overlapping-spans', 'countMatch', [input, match, input + length], byteOracle(input, match, input + length))
        for (const mismatch of new Set([0, length - 1].filter((x) => x >= 0 && x < length))) {
            set(input + mismatch, 0x40)
            verify('overlapping-span-mismatches', 'countMatch', [input, match, input + length], byteOracle(input, match, input + length))
            set(input + mismatch, 0x41)
        }
    }
}

// Use the original two-segment helper, including exact continuation at the
// dictionary boundary. One span ends exactly at linear-memory end, so a load
// that crosses the valid input or match tail traps instead of reading padding.
for (let length = 0; length <= 65; ++length) {
    for (let remaining = 0; remaining <= 33; ++remaining) {
        for (let alignment = 0; alignment < 16; ++alignment) {
            for (const inputAtHeapEnd of [false, true]) {
                const input = inputAtHeapEnd ? end - length : 32768 + alignment
                const matchEnd = inputAtHeapEnd ? 65536 + alignment : end
                const match = matchEnd - remaining
                const prefix = 81920
                fill(input, length)
                fill(match, remaining)
                fill(prefix, length)
                const args = [input, match, input + length, matchEnd, prefix]
                verify('two-segment-exact-boundary', 'countSegments', args, length)
                const positions = new Set([0, remaining - 1, remaining, length - 1].filter((x) => x >= 0 && x < length))
                for (const mismatch of positions) {
                    const location = mismatch < remaining ? match + mismatch : prefix + mismatch - remaining
                    set(location, 0x40)
                    verify('two-segment-boundary-mismatch', 'countSegments', args, mismatch)
                    set(location, 0x41)
                }
            }
        }
    }
}

// lazy/optimal dictionary searches add cached common length to both pointers.
// If that passes matchEnd, the helper's virtual limit precedes current input.
for (let alignment = 0; alignment < 16; ++alignment) {
    for (const excess of [1, 2, 3, 4, 7, 8, 15, 16, 17]) {
        for (const [input, limit, matchEnd] of [[32768 + alignment, 32833 + alignment, end], [end, end, 65536 + alignment]]) {
            verify('cached-common-length-past-dictionary-end', 'countSegments', [input, matchEnd + excess, limit, matchEnd, 81920], 0, true)
        }
    }
}
assert(supersededFailures.traps > 0, 'The preserved old specialization must expose its boundary regression')
assert(supersededFailures.wrongResults > 0, 'The interior reversed span must show a wrong old result')
const report = {
    complete: true,
    node: process.version,
    scope: 'Direct source-bound helper correctness only; no compressor or importer timing. Production and probe share the complete patched upstream header, with unchanged source-body and two-segment delegation.',
    modules: identities,
    counts,
    totalCases: Object.values(counts).reduce((sum, count) => sum + count, 0),
    guardedMismatches: 0,
    supersededFailures,
    harnessSha256: sha256(await readFile(new URL(import.meta.url))),
}
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, {flag: 'wx'})
console.log(JSON.stringify({complete: report.complete, totalCases: report.totalCases, counts, supersededTraps: supersededFailures.traps, supersededWrongResults: supersededFailures.wrongResults}))
