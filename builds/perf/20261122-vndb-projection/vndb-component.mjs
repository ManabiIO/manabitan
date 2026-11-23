import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createReadStream, openAsBlob} from 'node:fs'
import {readFile, writeFile} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {performance} from 'node:perf_hooks'

const [mode, baselineRoot, candidateRoot, archivePath, outputPath, sampleCountValue = '0'] = process.argv.slice(2)
assert.ok(mode === 'oracle' || mode === 'measure')
const sampleCount = Number(sampleCountValue)
const options = {
    emitContentSlab: true,
    emitTokenBinaryContent: true,
    emitTermByteLists: false,
    mediaHintFastScan: true,
    projectImagePaths: true,
    validateGlossaryTypes: true,
    computeContentHashes: true,
    prepareLookupIndexes: true,
    experimentalNativeEscapedKeys: true,
    ownContentBytes: true,
    maxPendingChunks: 1,
    singleChunk: true,
}

async function loadParser(root) {
    const parser = await import(pathToFileURL(path.join(root, 'ext/js/dictionary/term-bank-wasm-parser.js')))
    const lookup = await import(pathToFileURL(path.join(root, 'ext/js/dictionary/term-lookup-index-preparation.js')))
    const experiments = await import(pathToFileURL(path.join(root, 'ext/js/dictionary/term-bank-experiments.js')))
    const bytes = await readFile(path.join(root, 'ext/lib/term-bank-parser.wasm'))
    parser.setTermBankWasmModule(await WebAssembly.compile(bytes))
    return {parser, lookup, experiments, wasmSha256: createHash('sha256').update(bytes).digest('hex')}
}

async function sourceIdentity(root) {
    const files = {}
    for (const name of ['ext/js/dictionary/term-bank-wasm-parser.js', 'ext/js/dictionary/term-lookup-index-preparation.js',
        'ext/js/dictionary/term-bank-experiments.js', 'ext/js/dictionary/dictionary-image-references.js',
        'ext/js/dictionary/term-bank-source-pipeline.js', 'ext/js/dictionary/dense-zip-directory.js',
        'ext/lib/term-bank-parser.wasm', 'package-lock.json']) {
        files[name] = createHash('sha256').update(await readFile(path.join(root, name))).digest('hex')
    }
    return {root, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(), files}
}

const identities = [await sourceIdentity(baselineRoot), await sourceIdentity(candidateRoot)]
const archiveHash = createHash('sha256')
for await (const bytes of createReadStream(archivePath)) archiveHash.update(bytes)
const fixtureSha256 = archiveHash.digest('hex')
assert.equal(fixtureSha256, 'da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792')

const baseline = await loadParser(baselineRoot)
const candidate = mode === 'oracle' ? await loadParser(candidateRoot) : baseline
assert.equal(candidate.wasmSha256, baseline.wasmSha256)
const {readDenseZipDirectory} = await import(pathToFileURL(path.join(baselineRoot, 'ext/js/dictionary/dense-zip-directory.js')))
const {RawZipPayloadReader} = await import(pathToFileURL(path.join(baselineRoot, 'ext/js/dictionary/term-bank-source-pipeline.js')))
const archive = await openAsBlob(archivePath)
assert.equal(archive.size, 291705969)
const directory = await readDenseZipDirectory(archive)
assert.ok(directory)
const banks = directory.filter(({filename}) => /^term_bank_\d+\.json$/.test(filename)).sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)))
assert.equal(banks.length, 665)
const reader = new RawZipPayloadReader(archive)
const signal = new AbortController().signal
const totalBytes = banks.reduce((sum, bank) => sum + bank.uncompressedSize, 0)
assert.equal(totalBytes, 4267992967)
// Same partition calculation as the production lazy parallel source path.
// All devices select ceil(totalBytes / 24 MiB) groups for this corpus.
const groupCount = Math.ceil(totalBytes / (24 * 1024 * 1024))
const groups = []
let start = 0
let consumedBytes = 0
for (let i = 0; i < groupCount - 1; ++i) {
    const remainingGroups = groupCount - i
    const targetBytes = (totalBytes - consumedBytes) / remainingGroups
    let end = start + 1
    let bytes = banks[start].uncompressedSize
    const maxEnd = banks.length - (remainingGroups - 1)
    while (end < maxEnd) {
        const nextBytes = bytes + banks[end].uncompressedSize
        if (Math.abs(nextBytes - targetBytes) > Math.abs(bytes - targetBytes)) break
        bytes = nextBytes
        ++end
    }
    groups.push(banks.slice(start, end))
    start = end
    consumedBytes += bytes
}
groups.push(banks.slice(start))
const selected = sampleCount > 0 && sampleCount < groups.length ?
    Array.from({length: sampleCount}, (_, i) => Math.floor(i * (groups.length - 1) / Math.max(1, sampleCount - 1))) :
    groups.map((_, i) => i)

function hashChunk(chunk) {
    const hash = createHash('sha256')
    function append(value) {
        if (ArrayBuffer.isView(value)) {
            hash.update(`${value.constructor.name}:${value.byteLength}:`)
            hash.update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
        } else if (Array.isArray(value)) {
            hash.update(`Array:${value.length}:`)
            for (const item of value) append(item)
        } else if (value instanceof Map) {
            hash.update(`Map:${value.size}:`)
            for (const [key, item] of value) {
                append(key)
                append(item)
            }
            hash.update('EndMap:')
        } else if (value !== null && typeof value === 'object') {
            const keys = Object.keys(value).sort()
            hash.update(`Object:${keys.length}:`)
            for (const key of keys) {
                append(key)
                append(value[key])
            }
            hash.update('EndObject:')
        } else {
            hash.update(`${typeof value}:${JSON.stringify(value)}:`)
        }
    }
    for (const key of [
        'rowCount', 'contentRowStart', 'expressionBytesList', 'readingBytesList',
        'readingEqualsExpressionList', 'scoreList', 'sequenceList', 'contentBytesList',
        'contentHash1List', 'contentHash2List', 'contentBytesBuffer', 'contentBytesBaseOffset',
        'contentBytesLength', 'contentMetaList', 'contentUniqueIndexList',
        'contentDedupPlan', 'useResolvedContentReferences', 'termRecordPreinternedPlan', 'preparedLookupIndexes', 'mediaRows',
    ]) {
        append(key)
        append(chunk[key])
    }
    return hash.digest('hex')
}

async function parseGroup(loaded, sources) {
    const started = performance.now()
    const preloadedSource = await loaded.parser.inflateCompressedTermBankSourcesWasm(sources, options)
    let stable = null
    await loaded.parser.parseTermBankWithWasmColumnChunks(new Uint8Array(0), 3, (chunk) => {
        assert.equal(stable, null)
        stable = loaded.parser.copyWasmBackedColumnChunk(chunk, false, true)
    }, 262144, {...options, preloadedSource})
    const profile = loaded.parser.consumeLastTermBankWasmParseProfile()
    assert.ok(stable)
    if (!(stable.preparedLookupIndexes instanceof Map)) {
        const prepared = loaded.lookup.prepareTermLookupIndexesFromPreinternedPlan(stable, null, loaded.experiments.snapshotTermBankExperiments(options))
        if (prepared !== null) stable.preparedLookupIndexes = prepared.indexes
    }
    const elapsedMs = performance.now() - started
    assert.ok(profile)
    assert.equal(profile.fusedParseFallbacks, 0)
    return {stable, profile, elapsedMs, sourceInflateMs: preloadedSource.inflateMs}
}

const observations = []
let termRows = 0
let mediaRows = 0
let rowsWithoutMediaProjection = 0
// Cached compressed payloads are read before each measured parser interval.
for (const index of selected) {
    const files = groups[index]
    const sources = []
    for (const file of files) sources.push({...file, bytes: await reader.read(file, signal)})
    const first = await parseGroup(baseline, sources)
    const rowCount = first.stable.rowCount
    const mediaCount = first.stable.mediaRows.length
    let digest = null
    if (mode === 'oracle') {
        const second = await parseGroup(candidate, sources)
        digest = hashChunk(first.stable)
        assert.equal(hashChunk(second.stable), digest, `Output mismatch in group ${index}`)
        assert.equal(second.stable.rowCount, rowCount)
        assert.equal(second.stable.mediaRows.length, mediaCount)
    }
    termRows += rowCount
    mediaRows += mediaCount
    rowsWithoutMediaProjection += rowCount - mediaCount
    observations.push({index, banks: files.map(({filename}) => filename), termRows: rowCount, mediaRows: mediaCount, digest,
        ...(mode === 'measure' ? {elapsedMs: first.elapsedMs, sourceInflateMs: first.sourceInflateMs, rowDecodeMs: first.profile.rowDecodeMs, parseBankMs: first.profile.parseBankMs, resultFallbacks: first.profile.fusedParseFallbacks} : {})})
    if (observations.length % 10 === 0) console.log(JSON.stringify({completedGroups: observations.length, totalGroups: selected.length, termRows}))
}
if (selected.length === groups.length) assert.equal(termRows, 6648310)
const report = {schemaVersion: 1, mode, boundary: 'serialized compressed source inflation + fused column parser + owned result/image projection + prepared lookup indexes; excludes browser, parallel overlap, storage, input reads, validation hashing',
    runtime: process.version, v8: process.versions.v8, baselineRoot, candidateRoot, archivePath,
    fixtureSha256, identities,
    wasmSha256: baseline.wasmSha256, options, totalBanks: banks.length, sourceBytes: totalBytes, productionGroupCount: groups.length,
    selectedGroupCount: selected.length, termRows, mediaRows, rowsWithoutMediaProjection, observations}
assert.deepEqual(await sourceIdentity(baselineRoot), identities[0], 'Baseline source changed during the run')
assert.deepEqual(await sourceIdentity(candidateRoot), identities[1], 'Candidate source changed during the run')
await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({outputPath, termRows, mediaRows, selectedGroupCount: selected.length,
    ...(mode === 'measure' ? {totalComponentMs: observations.reduce((sum, row) => sum + row.elapsedMs, 0), totalRowDecodeMs: observations.reduce((sum, row) => sum + row.rowDecodeMs, 0)} : {})}))
