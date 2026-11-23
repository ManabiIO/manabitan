import {readFile, writeFile} from 'node:fs/promises'
import {deserialize} from 'node:v8'
import {createHash} from 'node:crypto'
import {pathToFileURL, fileURLToPath} from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'

const [baselineArgument, candidateArgument, inputsArgument, outputArgument, ...extra] = process.argv.slice(2)
assert(baselineArgument && candidateArgument && inputsArgument && outputArgument && extra.length === 0,
    'Usage: node --expose-gc compare.mjs baselineRoot candidateRoot inputs output')
const roots = {A: path.resolve(baselineArgument), B: path.resolve(candidateArgument)}
const inputDirectory = path.resolve(inputsArgument)
const output = path.resolve(outputArgument)
const hash = (value) => createHash('sha256').update(value).digest('hex')
const manifestBytes = await readFile(path.join(inputDirectory, 'manifest.json'))
const manifest = JSON.parse(manifestBytes)
const data = []
for (const group of manifest.groups) {
    const bytes = await readFile(path.join(inputDirectory, group.filename))
    assert.equal(bytes.length, group.bytes)
    assert.equal(hash(bytes), group.sha256)
    data.push(bytes)
}
const runtimeFile = 'ext/js/dictionary/dictionary-database.js'
const wasmPath = 'ext/lib/term-content-canonical-scan-v1.wasm'
const canonicalWasm = await readFile(path.join(roots.A, wasmPath))
assert.equal(hash(canonicalWasm), manifest.canonicalWasmSha256)
assert.equal(hash(await readFile(path.join(roots.B, wasmPath))), manifest.canonicalWasmSha256)
const canonicalModule = await WebAssembly.compile(canonicalWasm)
const groups = {}
const identities = {}
const digestBytes = (digest, bytes) => {
    digest.update(`${bytes.constructor.name}:${bytes.byteLength}:`)
    digest.update(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
}
for (const arm of ['A', 'B']) {
    const root = roots[arm]
    const {DictionaryDatabase} = await import(pathToFileURL(path.join(root, runtimeFile)).href)
    const {NativeCanonicalScanner} = await import(pathToFileURL(path.join(root, 'ext/js/dictionary/term-content-canonical-scan.js')).href)
    const prepared = []
    const digest = createHash('sha256')
    let rows = 0
    let uniqueCount = 0
    let storageCursor = 256
    for (let index = 0; index < data.length; index++) {
        // Node may deserialize typed-array views directly onto the input
        // Buffer. Give each arm a private serialization buffer before any
        // resolver scratch is written.
        const input = deserialize(Buffer.from(data[index]))
        const sourceBytes = new Uint8Array(new SharedArrayBuffer(input.contentBytesBuffer.byteLength))
        sourceBytes.set(input.contentBytesBuffer)
        input.contentBytesBuffer = sourceBytes
        const database = new DictionaryDatabase()
        const scanner = new NativeCanonicalScanner({loadModule: async () => canonicalModule})
        database._nativeCanonicalScanner = scanner
        const resolved = await database._resolveArtifactTermContentDedup(input)
        const spans = resolved.pendingContentSpans
        assert(spans && spans.lengths.length === resolved.pendingContentCount)
        const offsets = new Float64Array(spans.lengths.length)
        assert(offsets.length > 0, `Expected pending content for ${arm} group ${manifest.groups[index].group}`)
        // Match the strict 20-byte reference stride emitted by the production
        // reservation layout. Compression and physical OPFS placement are not
        // reproduced or timed by this component harness.
        for (let i = 0; i < offsets.length; i++) offsets[i] = storageCursor + i * 20
        storageCursor += offsets.length * 20 + 64
        const dictName = 'raw-block-v2:jmdict'
        const unregister = database._registerInFlightTermContentSources(offsets, spans.lengths, dictName, [], spans)
        assert.equal(database._inFlightTermContentSourceBatches.size, 1)
        const [batch] = database._inFlightTermContentSourceBatches
        assert.equal(batch.sortedOffsets, true)
        assert.equal(batch.minimumOffset, offsets[0])
        assert.equal(batch.maximumOffset, offsets[offsets.length - 1])
        assert.equal(batch.contentSpans, spans)
        for (const row of [0, Math.floor(offsets.length / 2), offsets.length - 1]) {
            assert.deepEqual(database._findInFlightTermContentSource(offsets[row], spans.lengths[row], dictName), {
                buffer: spans.buffer, offset: spans.offsets[row], length: spans.lengths[row],
            })
        }
        digest.update(JSON.stringify({group: manifest.groups[index].group, minimumOffset: batch.minimumOffset,
            maximumOffset: batch.maximumOffset, sortedOffsets: batch.sortedOffsets, dictName}))
        for (const bytes of [offsets, spans.offsets, spans.lengths, spans.buffer]) digestBytes(digest, bytes)
        unregister()
        assert.equal(database._inFlightTermContentSourceBatches.size, 0)
        prepared.push({database, spans, offsets, dictName})
        rows += input.rowCount
        uniqueCount += spans.lengths.length
    }
    groups[arm] = prepared
    identities[arm] = {root, sourceSha256: hash(await readFile(path.join(root, runtimeFile))),
        digest: digest.digest('hex'), rows, uniqueCount, groups: prepared.length}
}
assert.equal(identities.A.rows, manifest.rows)
assert.equal(identities.B.rows, manifest.rows)
assert.equal(identities.A.digest, identities.B.digest)
assert.equal(identities.A.uniqueCount, identities.B.uniqueCount)

const passesPerObservation = 20
function run(arm, passes = passesPerObservation) {
    for (let pass = 0; pass < passes; pass++) {
        for (const {database, spans, offsets, dictName} of groups[arm]) {
            database._registerInFlightTermContentSources(offsets, spans.lengths, dictName, [], spans)()
        }
    }
}
const observations = []
function observe(kind, pair, slot, arm) {
    globalThis.gc?.()
    const cpuStart = process.cpuUsage()
    const started = performance.now()
    run(arm)
    const elapsedMs = performance.now() - started
    const cpu = process.cpuUsage(cpuStart)
    const observation = {index: observations.length, kind, pair, slot, arm, elapsedMs,
        userMs: cpu.user / 1000, systemMs: cpu.system / 1000}
    observations.push(observation)
    return observation
}
for (let pair = 0; pair < 2; pair++) {
    for (const [slot, arm] of ['A', 'B'].entries()) observe('warmup', pair, slot, arm)
}
const comparisons = []
for (let pair = 0; pair < 10; pair++) {
    const control = pair === 0 || pair === 5
    const order = control ? ['A', 'A'] : pair % 2 === 0 ? ['A', 'B'] : ['B', 'A']
    const measured = order.map((arm, slot) => observe(control ? 'control' : 'candidate', pair, slot, arm))
    const baseline = control ? measured[0] : measured.find(({arm}) => arm === 'A')
    const candidate = control ? measured[1] : measured.find(({arm}) => arm === 'B')
    comparisons.push({pair, control, order, observations: measured.map(({index}) => index),
        elapsedChangePercent: (candidate.elapsedMs / baseline.elapsedMs - 1) * 100,
        cpuChangePercent: ((candidate.userMs + candidate.systemMs) / (baseline.userMs + baseline.systemMs) - 1) * 100})
}
// Count eliminated checks after timing, so this diagnostic never changes the
// functions used during the observations. No validation is disabled.
const integerCheckCounts = {}
const originalIntegerCheck = Number.isSafeInteger
try {
    for (const arm of ['A', 'B']) {
        let count = 0
        Number.isSafeInteger = (value) => { count++; return originalIntegerCheck(value) }
        run(arm, 1)
        integerCheckCounts[arm] = count
    }
} finally {
    Number.isSafeInteger = originalIntegerCheck
}
assert.equal(integerCheckCounts.A, identities.A.uniqueCount * 3)
assert.equal(integerCheckCounts.B, identities.B.uniqueCount)
const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}
const candidates = comparisons.filter(({control}) => !control)
const receipt = {
    description: 'Isolated synchronous in-flight registration replay, real native/resolver content columns for every pinned JMdict term bank. No archive parsing, canonical resolution, compression, persistent storage, transfer, or import wall time is included. Each group starts with an empty registration set and an independently resolved database; physical reference positions are modeled with the exact production 20-byte stride. No cross-group persisted deduplication is modeled.',
    node: process.version, inputManifestSha256: hash(manifestBytes), archiveSha256: manifest.archiveSha256,
    runnerSha256: hash(await readFile(fileURLToPath(import.meta.url))), identities,
    passesPerObservation, integerCheckCounts, observations, comparisons,
    medianElapsedChangePercent: median(candidates.map(({elapsedChangePercent}) => elapsedChangePercent)),
    medianCpuChangePercent: median(candidates.map(({cpuChangePercent}) => cpuChangePercent)),
    fasterPairs: candidates.filter(({elapsedChangePercent}) => elapsedChangePercent < 0).length,
}
await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`)
console.log(JSON.stringify({...receipt, observations: undefined, comparisons: undefined}))
