import {readFile, writeFile} from 'node:fs/promises'
import {deserialize} from 'node:v8'
import {createHash} from 'node:crypto'
import {pathToFileURL, fileURLToPath} from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'

const [baselineArgument, candidateArgument, inputsArgument, outputArgument, ...extra] = process.argv.slice(2)
assert(baselineArgument && candidateArgument && inputsArgument && outputArgument && extra.length === 0,
    'Usage: node --expose-gc verify-parity.mjs baselineRoot candidateRoot inputs output')
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


const modes = []
for (const [name, arm, forceGeneric] of [['baseline-generic', 'A', false], ['candidate-fast', 'B', false], ['candidate-unmarked-generic', 'B', true]]) {
    const digest = createHash('sha256')
    let checkedRows = 0
    let checkedBytes = 0
    let integerChecks = 0
    for (const group of groups[arm]) {
        const {database, offsets, dictName} = group
        const spans = forceGeneric ? {...group.spans} : group.spans
        const originalCheck = Number.isSafeInteger
        let unregister
        try {
            Number.isSafeInteger = (value) => { integerChecks++; return originalCheck(value) }
            unregister = database._registerInFlightTermContentSources(offsets, spans.lengths, dictName, [], spans)
        } finally {
            Number.isSafeInteger = originalCheck
        }
        const [batch] = database._inFlightTermContentSourceBatches
        digest.update(JSON.stringify({minimumOffset: batch.minimumOffset, maximumOffset: batch.maximumOffset, sortedOffsets: batch.sortedOffsets}))
        for (let i = 0; i < offsets.length; i++) {
            const found = database._findInFlightTermContentSource(offsets[i], spans.lengths[i], dictName)
            assert(found, `${name}: missing source ${i}`)
            assert.equal(found.buffer, spans.buffer)
            assert.equal(found.offset, spans.offsets[i])
            assert.equal(found.length, spans.lengths[i])
            digest.update(`${offsets[i]}:${found.offset}:${found.length}:${dictName}\n`)
            digest.update(found.buffer.subarray(found.offset, found.offset + found.length))
            checkedRows++
            checkedBytes += found.length
        }
        unregister()
        assert.equal(database._inFlightTermContentSourceBatches.size, 0)
    }
    assert.equal(integerChecks, identities[arm].uniqueCount * (name === 'candidate-fast' ? 1 : 3))
    modes.push({name, checkedRows, checkedBytes, integerChecks, fullLookupDigest: digest.digest('hex')})
}
assert(modes.every((mode) => mode.fullLookupDigest === modes[0].fullLookupDigest))
for (let i = 0; i < data.length; i++) assert.equal(hash(data[i]), manifest.groups[i].sha256)
const receipt = {
    description: 'Correctness-only exhaustive lookup parity for every real resolved content span. Baseline generic, current candidate fast, and current candidate generic (unmarked plain copy) register, find, and unregister every source with exact offset, length, shared-slab identity, byte digest, sorted bounds, and empty post-release set. No timing observations are collected.',
    node: process.version, inputManifestSha256: hash(manifestBytes), archiveSha256: manifest.archiveSha256,
    runnerSha256: hash(await readFile(fileURLToPath(import.meta.url))), identities, modes,
    originSemantics: 'Only spans objects created inside the resolver are weakly marked. Copying an otherwise identical plain object forces generic validation. Both descriptor values and all source/persisted bounds are freshly checked at registration, even after awaits; the origin mark is not a validity cache.',
}
await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`)
console.log(JSON.stringify(receipt))
