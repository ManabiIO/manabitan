/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createThreeStreamChecksum, hashThreeJavascript} from './native-three.mjs'
import {createNativeChecksum} from '../native-sidecar-hash-prototype/native-checksum.mjs'

const [inputDirectory, outputPath, roundsArg = '7', repeatsArg = '128'] = process.argv.slice(2)
assert(inputDirectory && outputPath)
const rounds = Number(roundsArg)
const repeats = Number(repeatsArg)
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const tripleModule = await readFile(new URL('./xxh32-three.wasm', import.meta.url))
const singleModule = await readFile(new URL('../native-sidecar-hash-prototype/xxh32-stream-simd.wasm', import.meta.url))
const triple = await createThreeStreamChecksum(tripleModule)
const single = await createNativeChecksum(singleModule)
const algorithms = {
    js: hashThreeJavascript,
    single: (a, b, c) => [single.hashBytes(a), single.hashBytes(b), single.hashBytes(c)],
    triple: triple.hashThree,
}
const manifestBytes = await readFile(join(inputDirectory, 'manifest.json'))
const manifest = JSON.parse(manifestBytes)
let randomState = 0xbeb52027
const next = () => {
    randomState ^= randomState << 13
    randomState ^= randomState >>> 17
    randomState ^= randomState << 5
    return randomState >>> 0
}
const orders = [['js', 'single', 'triple'], ['js', 'triple', 'single'], ['single', 'js', 'triple'],
    ['single', 'triple', 'js'], ['triple', 'js', 'single'], ['triple', 'single', 'js']]
const median = (values) => {
    const sorted = values.toSorted((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
let sink = 0
const results = []
for (const item of manifest.dictionaries) {
    const inputs = []
    for (let offset = 0; offset < item.inputs.length; offset += 3) {
        const group = []
        for (const input of item.inputs.slice(offset, offset + 3)) {
            const file = await readFile(join(inputDirectory, input.filename))
            assert.equal(sha256(file), input.sha256)
            group.push(new Uint8Array(file))
        }
        const expected = item.inputs.slice(offset, offset + 3).map((input) => input.xxh32)
        for (const algorithm of Object.values(algorithms)) assert.deepEqual(algorithm(...group), expected)
        inputs.push(group)
    }
    const run = (algorithm, count) => {
        const startedAt = performance.now()
        for (let i = 0; i < count; i++) {
            for (const group of inputs) {
                const hashes = algorithm(...group)
                sink ^= hashes[0] ^ hashes[1] ^ hashes[2]
            }
        }
        return performance.now() - startedAt
    }
    for (let i = 0; i < 3; i++) for (const algorithm of Object.values(algorithms)) run(algorithm, 32)
    const samples = []
    for (let round = 0; round < rounds; round++) {
        const permutation = orders[next() % orders.length]
        const order = [...permutation, ...permutation.toReversed()]
        const sample = {round, order, js: [], single: [], triple: []}
        for (const arm of order) sample[arm].push(run(algorithms[arm], repeats))
        sample.jsMs = (sample.js[0] + sample.js[1]) / 2
        sample.singleMs = (sample.single[0] + sample.single[1]) / 2
        sample.tripleMs = (sample.triple[0] + sample.triple[1]) / 2
        sample.tripleOverJs = sample.tripleMs / sample.jsMs
        sample.singleOverJs = sample.singleMs / sample.jsMs
        sample.tripleOverSingle = sample.tripleMs / sample.singleMs
        const control = {order: next() % 2 ? ['a', 'b', 'b', 'a'] : ['b', 'a', 'a', 'b'], a: [], b: []}
        for (const arm of control.order) control[arm].push(run(algorithms.js, repeats))
        control.bOverA = (control.b[0] + control.b[1]) / (control.a[0] + control.a[1])
        sample.control = control
        samples.push(sample)
    }
    const result = {dictionary: item.dictionary, groupIndex: item.groupIndex, rows: item.rows,
        inputBytes: item.inputs.reduce((sum, input) => sum + input.bytes, 0),
        spans: item.inputs.map(({bytes, section}) => ({bytes, section})),
        rounds, repeats, samples, tripleOverJs: median(samples.map((sample) => sample.tripleOverJs)),
        singleOverJs: median(samples.map((sample) => sample.singleOverJs)),
        tripleOverSingle: median(samples.map((sample) => sample.tripleOverSingle)),
        controlBOverA: median(samples.map((sample) => sample.control.bOverA)),
    }
    results.push(result)
    console.log(JSON.stringify(result))
}
const summaries = []
for (const dictionary of new Set(results.map((result) => result.dictionary))) {
    const groups = results.filter((result) => result.dictionary === dictionary)
    const totals = []
    for (let round = 0; round < rounds; round++) {
        let jsMs = 0
        let singleMs = 0
        let tripleMs = 0
        let controlAMs = 0
        let controlBMs = 0
        for (const group of groups) {
            const sample = group.samples[round]
            jsMs += sample.jsMs
            singleMs += sample.singleMs
            tripleMs += sample.tripleMs
            controlAMs += (sample.control.a[0] + sample.control.a[1]) / 2
            controlBMs += (sample.control.b[0] + sample.control.b[1]) / 2
        }
        totals.push({round, jsMs, singleMs, tripleMs, singleOverJs: singleMs / jsMs,
            tripleOverJs: tripleMs / jsMs, tripleOverSingle: tripleMs / singleMs,
            controlBOverA: controlBMs / controlAMs})
    }
    summaries.push({dictionary, groups: groups.length, rows: groups.reduce((sum, group) => sum + group.rows, 0),
        inputBytes: groups.reduce((sum, group) => sum + group.inputBytes, 0), totals,
        medianSingleOverJs: median(totals.map((sample) => sample.singleOverJs)),
        medianTripleOverJs: median(totals.map((sample) => sample.tripleOverJs)),
        medianTripleOverSingle: median(totals.map((sample) => sample.tripleOverSingle)),
        medianControlBOverA: median(totals.map((sample) => sample.controlBOverA))})
}
const report = {scope: 'Local bounded first-group component screen; all guard, copy and ABI work included; no whole-import claim',
    node: process.version, memoryBytes: triple.memoryBytes, capacityPerStream: triple.capacityPerStream,
    tripleModuleSha256: sha256(tripleModule), singleModuleSha256: sha256(singleModule),
    wrapperSha256: sha256(await readFile(new URL('./native-three.mjs', import.meta.url))),
    inputManifestSha256: sha256(manifestBytes), seed: '0xbeb52027', sink, results, summaries}
await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'})
