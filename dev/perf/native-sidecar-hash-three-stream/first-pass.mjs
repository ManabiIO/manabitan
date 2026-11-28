/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

const [inputDirectory, outputPath, arm] = process.argv.slice(2)
assert(inputDirectory && outputPath && ['js', 'single', 'triple'].includes(arm))
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const processStartedAt = performance.now()
const manifestBytes = await readFile(join(inputDirectory, 'manifest.json'))
const manifest = JSON.parse(manifestBytes)
const dictionaryKeys = [...new Set(manifest.dictionaries.map((group) => group.dictionary))]
assert.equal(dictionaryKeys.length, 1, 'One locked dictionary per fresh process')

// No XXH32 call, vector check, or warmup precedes the measured pass. Module
// loading, WASM file acquisition and compile/instance creation are measured.
const initializationStartedAt = performance.now()
let algorithm
let moduleReadMs = 0
let compileAndInitializeMs = 0
let helperLoadMs = 0
let wasmSha256 = null
let memoryBytes = 0
if (arm === 'js') {
    const helper = await import('../../../ext/js/dictionary/term-key-hash.js')
    helperLoadMs = performance.now() - initializationStartedAt
    algorithm = (a, b, c) => [helper.hashTermKeyBytes(a), helper.hashTermKeyBytes(b), helper.hashTermKeyBytes(c)]
} else {
    const helper = arm === 'single' ?
        await import('../native-sidecar-hash-prototype/native-checksum.mjs') : await import('./native-three.mjs')
    helperLoadMs = performance.now() - initializationStartedAt
    const readStartedAt = performance.now()
    const wasmBytes = await readFile(new URL(arm === 'single' ? '../native-sidecar-hash-prototype/xxh32-stream-simd.wasm' : './xxh32-three.wasm', import.meta.url))
    moduleReadMs = performance.now() - readStartedAt
    const compileStartedAt = performance.now()
    const native = arm === 'single' ? await helper.createNativeChecksum(wasmBytes) : await helper.createThreeStreamChecksum(wasmBytes)
    compileAndInitializeMs = performance.now() - compileStartedAt
    wasmSha256 = sha256(wasmBytes)
    memoryBytes = native.memoryBytes
    algorithm = arm === 'single' ? (a, b, c) => [native.hashBytes(a), native.hashBytes(b), native.hashBytes(c)] : native.hashThree
}
const initializationMs = performance.now() - initializationStartedAt

const groups = []
const digest = createHash('sha256')
let inputBytes = 0
let rows = 0
let sectionHashCount = 0
let hashMs = 0
for (const item of manifest.dictionaries) {
    assert.equal(item.inputs.length % 3, 0)
    let groupHashMs = 0
    let groupBytes = 0
    for (let index = 0; index < item.inputs.length; index += 3) {
        const inputs = []
        const metadata = item.inputs.slice(index, index + 3)
        assert.deepEqual(metadata.map((entry) => entry.section), ['base', 'derived', 'records'])
        for (const entry of metadata) {
            const bytes = await readFile(join(inputDirectory, entry.filename))
            assert.equal(bytes.byteLength, entry.bytes)
            assert.equal(sha256(bytes), entry.sha256)
            inputs.push(new Uint8Array(bytes))
            groupBytes += bytes.byteLength
        }
        const startedAt = performance.now()
        const actual = algorithm(inputs[0], inputs[1], inputs[2])
        groupHashMs += performance.now() - startedAt
        // Verify after measurement without executing a comparator checksum.
        assert.deepEqual(actual, metadata.map((entry) => entry.xxh32))
        const output = new Uint32Array(actual)
        digest.update(new Uint8Array(output.buffer))
        sectionHashCount += 3
    }
    hashMs += groupHashMs
    inputBytes += groupBytes
    rows += item.rows
    groups.push({rows: item.rows, bytes: groupBytes, sections: item.inputs.length, hashMs: groupHashMs})
}
const report = {
    complete: true, arm, dictionary: dictionaryKeys[0], node: process.version,
    scope: 'Fresh Node process, first checksum pass over every captured section exactly once; no warmup; not a browser or complete import',
    warmupCalls: 0, repetitions: 1, rows, inputBytes, sectionHashCount, groups,
    initializationMs, helperLoadMs, moduleReadMs, compileAndInitializeMs,
    hashMs, totalMs: initializationMs + hashMs,
    processWallMs: performance.now() - processStartedAt,
    totalScope: 'Helper module load + WASM file read/compile/instance + checksum calls; excludes fixture reads/SHA verification and result checks',
    memoryBytes, wasmSha256, outputHashesSha256: digest.digest('hex'),
    inputManifestSha256: sha256(manifestBytes),
    harnessSha256: sha256(await readFile(new URL('./first-pass.mjs', import.meta.url))),
    compileCacheDisabled: process.env.NODE_DISABLE_COMPILE_CACHE === '1',
}
await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'})
console.log(JSON.stringify({arm, dictionary: report.dictionary, rows, inputBytes, sectionHashCount, initializationMs, hashMs, totalMs: report.totalMs, outputHashesSha256: report.outputHashesSha256}))
