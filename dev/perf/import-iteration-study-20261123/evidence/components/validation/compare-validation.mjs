import {readFile, writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {deserialize} from 'node:v8'
import {pathToFileURL, fileURLToPath} from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'
import {performance} from 'node:perf_hooks'

const [inputDirectoryArgument, baselineRootArgument, candidateRootArgument, outputArgument] = process.argv.slice(2)
assert(inputDirectoryArgument && baselineRootArgument && candidateRootArgument && outputArgument,
    'Usage: node --expose-gc compare-validation.mjs inputDirectory baselineRoot candidateRoot output.json')
const inputDirectory = path.resolve(inputDirectoryArgument)
const sourceRoots = {baseline: path.resolve(baselineRootArgument), candidate: path.resolve(candidateRootArgument)}
const hash = (value) => createHash('sha256').update(value).digest('hex')
const manifestBytes = await readFile(path.join(inputDirectory, 'manifest.json'))
const manifest = JSON.parse(manifestBytes)
const inputs = []
for (const group of manifest.groups) {
    const bytes = await readFile(path.join(inputDirectory, group.filename))
    assert.equal(hash(bytes), group.sha256)
    inputs.push(deserialize(bytes))
}
const sourceHashes = {}
const classes = {}
for (const [label, sourceRoot] of Object.entries(sourceRoots)) {
    const sourceFile = path.join(sourceRoot, 'ext/js/dictionary/term-record-opfs-store.js')
    sourceHashes[label] = hash(await readFile(sourceFile))
    classes[label] = (await import(pathToFileURL(sourceFile).href)).TermRecordOpfsStore
}
const emptyOffsets = new Float64Array(0)
const emptyLengths = new Uint32Array(0)
const dummyState = {}
const invoke = (store, chunk) => store._encodeAndAppendArtifactChunkForState(
    dummyState, chunk, 1, emptyOffsets, emptyLengths, chunk.termRecordPreinternedPlan, 'raw', chunk.preparedLookupIndexes,
)
async function verify(Store) {
    const store = new Store()
    const digest = createHash('sha256')
    let rows = 0
    let segments = 0
    let fieldBytes = 0
    let lookupBytes = 0
    store._appendEncodedChunk = async (_state, firstId, count, dictName, base, lookup, fields, format) => {
        digest.update(JSON.stringify([firstId, count, dictName, base, format, lookup.length, fields.length]))
        digest.update(lookup)
        digest.update(fields)
        rows += count
        segments++
        fieldBytes += fields.length
        lookupBytes += lookup.length
    }
    for (const input of inputs) await invoke(store, input)
    assert.equal(rows, manifest.rows)
    return {digest: digest.digest('hex'), rows, segments, fieldBytes, lookupBytes}
}
const oracles = {}
for (const [label, Store] of Object.entries(classes)) {
    oracles[label] = await verify(Store)
    globalThis.gc?.()
}
assert.deepEqual(oracles.candidate, oracles.baseline)
const stores = {}
for (const [label, Store] of Object.entries(classes)) {
    const store = stores[label] = new Store()
    store._encodeArtifactChunkRecords = async (_chunk, _offsets, _lengths, _plan, _prepared, base) => ({
        contentOffsetBase: base, lookupIndexBytes: null, recordFields: null, recordFieldsFormat: 1,
        validationMs: 0, recordFieldEncodeMs: 0, lookupIndexEncodeMs: 0,
    })
    store._appendEncodedChunk = async () => {}
}
async function run(label, repetitions) {
    let validationMs = 0
    const start = performance.now()
    for (let repetition = 0; repetition < repetitions; repetition++) {
        for (const input of inputs) validationMs += (await invoke(stores[label], input)).validationMs
    }
    return {label, validationMs: validationMs / repetitions, planningWallMs: (performance.now() - start) / repetitions}
}
for (let warmup = 0; warmup < 4; warmup++) {
    await run('baseline', 1)
    await run('candidate', 1)
}
const observations = []
const repetitions = 5
for (let pair = 0; pair < 12; pair++) {
    for (const label of pair % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) {
        globalThis.gc?.()
        observations.push({pair, repetitions, ...await run(label, repetitions)})
    }
}
const median = (values) => {
    const sorted = values.toSorted((a, b) => a - b)
    return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.ceil((sorted.length - 1) / 2)]) / 2
}
const summary = {}
for (const metric of ['validationMs', 'planningWallMs']) {
    const baseline = observations.filter((item) => item.label === 'baseline').map((item) => item[metric])
    const candidate = observations.filter((item) => item.label === 'candidate').map((item) => item[metric])
    const deltas = baseline.map((value, pair) => (candidate[pair] / value - 1) * 100)
    summary[metric] = {baselineMedian: median(baseline), candidateMedian: median(candidate), pairMedianChangePercent: median(deltas),
        candidateFasterPairs: deltas.filter((value) => value < 0).length, pairCount: deltas.length,
        baselineRange: [Math.min(...baseline), Math.max(...baseline)], candidateRange: [Math.min(...candidate), Math.max(...candidate)]}
}
const receipt = {
    description: 'Exact all-row record/lookup encoder oracle, followed by isolated validation/planning timing. Actual encoder and append are stubbed only in timing; this is not full import timing or persistent storage qualification.',
    dictionary: manifest.dictionary, node: process.version, archiveSha256: manifest.archiveSha256,
    inputManifestSha256: hash(manifestBytes), runnerSha256: hash(await readFile(fileURLToPath(import.meta.url))),
    sourceRoots, sourceHashes, rows: manifest.rows, contentRuns: manifest.contentRuns,
    repeatedValidationsRemoved: manifest.repeatedValidationsRemoved, oracles, summary, observations,
}
await writeFile(path.resolve(outputArgument), `${JSON.stringify(receipt, null, 2)}\n`)
console.log(JSON.stringify({...receipt, observations: undefined}))
