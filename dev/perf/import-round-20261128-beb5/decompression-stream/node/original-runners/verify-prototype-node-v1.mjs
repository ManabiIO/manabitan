import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createGzipInflater} from '../decompression-stream-browser/dev/perf/decompression-stream-chromium/gzip-inflater.mjs'

const directory = '/tmp/beb5-decompression-stream-jmdict-inputs'
const root = '/workspace/scratch/beb5caac0497/decompression-stream-browser'
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const manifestBytes = await readFile(join(directory, 'manifest.json'))
const manifest = JSON.parse(manifestBytes)
const moduleBytes = await readFile(join(root, 'dev/data/dictionary-wasm/term-bank-parser.wasm'))
const inflater = await createGzipInflater(await WebAssembly.compile(moduleBytes))
const groups = []
for (const group of manifest.groups) {
    const sources = []
    for (const bank of group.banks) {
        const bytes = new Uint8Array(await readFile(join(directory, bank.filename)))
        assert.equal(sha256(bytes), bank.compressedSha256)
        sources.push({...bank, bytes})
    }
    const result = await inflater.inflate(sources)
    assert.equal(result.jsonLength, group.decodedBytes)
    assert.equal(result.bankSpanCount, group.banks.length)
    const bytes = new Uint8Array(result.wasm.memory.buffer, result.jsonPtr, result.jsonLength)
    assert.equal(sha256(bytes), group.decodedSha256)
    const spans = new Uint32Array(result.wasm.memory.buffer, result.bankSpansPtr, group.banks.length * 2)
    let offset = 0
    for (const [index, bank] of group.banks.entries()) {
        assert.equal(spans[index * 2], offset)
        assert.equal(spans[index * 2 + 1], bank.uncompressedSize)
        assert.equal(sha256(bytes.subarray(offset, offset + bank.uncompressedSize)), bank.decodedSha256)
        offset += bank.uncompressedSize
    }
    groups.push({groupIndex: group.groupIndex, banks: group.banks.length, rows: group.rows,
        decodedBytes: result.jsonLength, decodedSha256: sha256(bytes), inputChunks: result.inputChunks,
        decodedChunks: result.decodedChunks, outputCopiedBytes: result.outputCopiedBytes})
}
const conformance = JSON.parse(await readFile(join(directory, 'conformance.json')))
const cases = []
for (const entry of conformance.cases) {
    const sources = []
    for (const source of entry.sources) { sources.push({...source, bytes: new Uint8Array(await readFile(join(directory, source.filename)))}) }
    let actual
    try {
        const result = await inflater.inflate(sources)
        const bytes = new Uint8Array(result.wasm.memory.buffer, result.jsonPtr, result.jsonLength)
        actual = {accepted: true, decodedBytes: result.jsonLength, decodedSha256: sha256(bytes)}
    } catch (error) { actual = {accepted: false, error: {name: error.name, message: error.message}} }
    if (actual.accepted && entry.expected.accepted) {
        assert.equal(actual.decodedBytes, entry.expected.decodedBytes)
        assert.equal(actual.decodedSha256, entry.expected.decodedSha256)
    }
    cases.push({name: entry.name, nativeAccepted: entry.expected.accepted, ...actual,
        acceptanceMatches: actual.accepted === entry.expected.accepted})
}
const mismatches = cases.filter((entry) => !entry.acceptanceMatches)
assert.equal(mismatches.length, 12)
assert(mismatches.every((entry) => entry.name.endsWith('/hidden-second-gzip-member')))
const report = {
    scope: 'Correctness only, no clocks or performance claim. All ordinary JMdict bytes/spans match; Node remains ineligible because the exact helper accepts hidden second gzip members.',
    node: process.version, manifestSha256: sha256(manifestBytes), wasmSha256: sha256(moduleBytes),
    helperSha256: sha256(await readFile(join(root, 'dev/perf/decompression-stream-chromium/gzip-inflater.mjs'))),
    runnerSha256: sha256(await readFile(new URL(import.meta.url))),
    groups, cases, summary: {groups: groups.length, banks: groups.reduce((sum, group) => sum + group.banks, 0),
        rows: groups.reduce((sum, group) => sum + group.rows, 0), sourceConformanceCases: cases.length,
        sourceAcceptanceMismatches: mismatches.length, eligibleForProduction: false},
}
await writeFile('/workspace/scratch/beb5caac0497/results/decompression-stream-prototype-node-correctness.json', JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report.summary))
