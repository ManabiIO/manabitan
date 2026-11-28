/* SPDX-License-Identifier: GPL-3.0-or-later */

import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile, writeFile} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'

const [wrapperPath, wasmPath, outputPath] = process.argv.slice(2)
assert(wrapperPath && wasmPath && outputPath)
const {createNativeChecksum} = await import(pathToFileURL(wrapperPath))
const {hashTermKeyByteRange} = await import('../../../ext/js/dictionary/term-key-hash.js')
const wasm = await readFile(wasmPath)
const instantiate = WebAssembly.instantiate
const actual = await instantiate(wasm)
const counters = {init: 0, update: 0, finish: 0}
const tracked = {...actual.instance.exports}
for (const name of ['init', 'update', 'finish']) {
    const fn = actual.instance.exports[`xxh32_${name}`]
    tracked[`xxh32_${name}`] = (...args) => {
        ++counters[name]
        return fn(...args)
    }
}
let checksum
try {
    WebAssembly.instantiate = async () => ({instance: {exports: tracked}})
    checksum = await createNativeChecksum(wasm)
} finally {
    WebAssembly.instantiate = instantiate
}
const results = []
const snapshot = (bytes) => Array.from(bytes)
const makeBytes = (length = 70003, offset = 0, shared = false, resizable = false) => {
    const buffer = shared ? new SharedArrayBuffer(length + offset) :
        new ArrayBuffer(length + offset, resizable ? {maxByteLength: length + offset + 65536} : undefined)
    const bytes = new Uint8Array(buffer, offset, length)
    for (let i = 0; i < length; ++i) { bytes[i] = ((i * 131) ^ (i >>> 7) ^ length) & 255 }
    return bytes
}

function outcome(fn) {
    try { return {value: fn()} } catch (error) { return {error: {name: error.constructor.name, message: error.message}} }
}

function compare(name, make, start, end, expectNative) {
    const before = make()
    const baseline = outcome(() => hashTermKeyByteRange(before.bytes, start, end))
    const beforeReads = before.reads?.() ?? 0
    const after = make()
    const calls = counters.init
    const candidate = outcome(() => checksum.hashByteRange(after.bytes, start, end))
    assert.deepEqual(candidate, baseline, name)
    assert.equal(after.reads?.() ?? 0, beforeReads, `${name}: metadata read order/count`)
    assert.equal(counters.init > calls, expectNative, `${name}: admission`)
    if (before.storage && after.storage) { assert.deepEqual(snapshot(after.storage), snapshot(before.storage), `${name}: input bytes`) }
    results.push({name, native: counters.init > calls, ...candidate})
}

for (const offset of [0, 1, 3, 7]) {
    for (const [start, end] of [[0, 70003], [1, 70002], [5, 65542], [1000, 2024]]) {
        compare(`private offset=${offset} range=${start}:${end}`, () => {
            const bytes = makeBytes(70003, offset)
            return {bytes, storage: bytes}
        }, start, end, true)
    }
}

for (const kind of ['shared', 'resizable', 'subclass', 'node-buffer', 'proxy', 'detached']) {
    compare(kind, () => {
        let bytes = makeBytes(70003, 3, kind === 'shared', kind === 'resizable')
        if (kind === 'subclass') {
            class Bytes extends Uint8Array {}
            bytes = new Bytes(bytes)
        }
        if (kind === 'node-buffer') { bytes = Buffer.from(bytes) }
        if (kind === 'proxy') { bytes = new Proxy(bytes, {}) }
        if (kind === 'detached') { structuredClone(bytes.buffer, {transfer: [bytes.buffer]}) }
        return {bytes}
    }, 0, 70000, false)
}

for (const property of ['buffer', 'byteOffset', 'byteLength']) {
    for (const getter of [false, true]) {
        compare(`own ${property} ${getter ? 'getter' : 'data'}`, () => {
            const bytes = makeBytes(70003, 3)
            const value = bytes[property]
            let reads = 0
            Object.defineProperty(bytes, property, getter ? {get() { ++reads; return value }} : {value})
            return {bytes, reads: () => reads}
        }, 1, 70000, false)
    }
}

// Constructor/species and source copy methods are irrelevant to the baseline
// byte reader, so admission must not invoke them while moving native input.
for (const property of ['constructor', 'slice', 'subarray', Symbol.species]) {
    compare(`unused source property ${String(property)}`, () => {
        const bytes = makeBytes()
        let reads = 0
        Object.defineProperty(bytes, property, {get() { ++reads; throw new Error('Unexpected source callback') }})
        return {bytes, reads: () => reads}
    }, 1, 70000, true)
}

for (const [start, end] of [[0, 1023], [0, 0], [-1, 1024], [1.5, 2048], [0, 70004], [2048, 1024], [NaN, 1024], [0, NaN]]) {
    compare(`fallback range ${start}:${end}`, () => ({bytes: makeBytes()}), start, end, false)
}

// Even a regular view on the module's own memory must use the existing reader:
// streamed scratch writes could otherwise overwrite source bytes not read yet.
const nativeMemoryView = new Uint8Array(actual.instance.exports.memory.buffer, 0, 65536)
nativeMemoryView.fill(0x55, 0, 1024)
const beforeAlias = counters.init
assert.equal(checksum.hashByteRange(nativeMemoryView, 0, 65536), hashTermKeyByteRange(nativeMemoryView, 0, 65536))
assert.equal(counters.init, beforeAlias)
results.push({name: 'own native memory alias', native: false})

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const report = {
    complete: true,
    node: process.version,
    wrapperPath,
    wrapperSha256: hash(await readFile(wrapperPath)),
    wasmPath,
    wasmSha256: hash(wasm),
    cases: results.length,
    counters,
    results,
    notes: 'Admission and exact fallback semantics only; native export counters are wrapped in a test-only instance adapter.',
}
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, {flag: 'wx'})
process.stdout.write(`${JSON.stringify({complete: true, cases: results.length, counters, wrapperSha256: report.wrapperSha256})}\n`)
