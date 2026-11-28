#!/usr/bin/env node
// Production parser worker replay. Local analysis tool, not extension code.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createReadStream, openAsBlob} from 'node:fs'
import {readFile, writeFile, mkdir} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {parseArgs} from 'node:util'
import {pathToFileURL, fileURLToPath} from 'node:url'
import {performance} from 'node:perf_hooks'
import path from 'node:path'
import os from 'node:os'
import {parentPort} from 'node:worker_threads'

const {values} = parseArgs({options: {
    'source-root': {type: 'string'},
    'variant-root': {type: 'string'},
    'cache-dir': {type: 'string'},
    'dictionary': {type: 'string', default: 'jmdict'},
    'parser-workers': {type: 'string', default: '3'},
    'warmups': {type: 'string', default: '1'},
    'runs': {type: 'string', default: '1'},
    'out': {type: 'string'},
    'serve': {type: 'boolean', default: false},
}})
assert(values['source-root'] && values['cache-dir'] && values.out)
const root = path.resolve(values['source-root'])
const workerCount = Number(values['parser-workers'])
const warmups = Number(values.warmups)
const runs = Number(values.runs)
assert([2, 3, 5].includes(workerCount))
assert(Number.isInteger(warmups) && warmups >= 0 && warmups <= 4)
assert(Number.isInteger(runs) && runs > 0 && runs <= 20)
assert.equal(typeof process.threadCpuUsage, 'function', 'Node22.22 current-thread CPU accounting required')
const sourceImport = (name) => import(pathToFileURL(path.join(root, name)))
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sourceFiles = [
    'ext/js/dictionary/term-bank-wasm-parser.js',
    'ext/js/dictionary/term-bank-wasm-parser-worker.js',
    'ext/js/dictionary/term-bank-experiments.js',
    'ext/js/dictionary/term-content-ownership.js',
    'ext/js/dictionary/term-bank-source-pipeline.js',
    'ext/js/dictionary/dense-zip-directory.js',
    'ext/js/dictionary/term-lookup-index-preparation.js',
    'ext/js/dictionary/term-lookup-index.js',
    'ext/js/dictionary/term-lookup-route.js',
    'ext/js/dictionary/term-record-preinterned-plan.js',
    'ext/js/dictionary/wasm/term-bank-parser.c',
    'ext/js/dictionary/wasm/term-bank-inflate.c',
    'dev/data/dictionary-wasm/manifest.json',
    'ext/lib/term-bank-parser.wasm',
    'package-lock.json',
]
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [file, sha256(await readFile(path.join(root, file)))])))
const identity = await sourceHashes()
const native = await sourceImport('dev/dictionary-wasm.js')
native.loadDictionaryWasm(root)
let moduleBytes = await readFile(path.join(root, 'ext/lib/term-bank-parser.wasm'))
assert.equal(sha256(moduleBytes), native.getDictionaryWasmManifest(root).targets.find((x) => x.name === 'term-bank-parser.wasm').sha256)
let diagnosticNativeOverride = null
if (values['variant-root']) {
    const variantRoot = path.resolve(values['variant-root'])
    const receipt = JSON.parse(await readFile(path.join(variantRoot, 'variant.json')))
    const sourceBytes = await readFile(path.join(variantRoot, 'ext/js/dictionary/wasm/term-bank-parser.c'))
    moduleBytes = await readFile(path.join(variantRoot, 'ext/lib/term-bank-parser.wasm'))
    assert.equal(sha256(sourceBytes), receipt.sourceSha256)
    assert.equal(sha256(moduleBytes), receipt.wasmSha256)
    assert.equal(moduleBytes.byteLength, receipt.wasmBytes)
    diagnosticNativeOverride = {root: variantRoot, ...receipt}
}
const lockBytes = await readFile(path.join(root, 'test/perf/dictionaries.lock.json'))
const fixture = JSON.parse(lockBytes).dictionaries[values.dictionary]
assert(fixture, 'Unknown locked dictionary')
const archivePath = path.join(values['cache-dir'], fixture.cacheFile)
const archiveDigest = createHash('sha256')
let archiveLength = 0
for await (const bytes of createReadStream(archivePath)) { archiveDigest.update(bytes); archiveLength += bytes.byteLength }
assert.equal(archiveLength, fixture.sizeBytes)
assert.equal(archiveDigest.digest('hex'), fixture.sha256)

// Read compressed bank payloads before timing. The exact production ZIP reader
// validates local headers and boundaries, and the native worker validates CRCs.
const archive = await openAsBlob(archivePath)
const {readDenseZipDirectory} = await sourceImport('ext/js/dictionary/dense-zip-directory.js')
const {RawZipPayloadReader} = await sourceImport('ext/js/dictionary/term-bank-source-pipeline.js')
const {getImageMediaTypeFromFileName} = await sourceImport('ext/js/media/media-util.js')
let entries = await readDenseZipDirectory(archive)
let zipReader
if (entries === null) {
    const require = createRequire(path.join(root, 'package.json'))
    const {ZipReader, BlobReader} = await import(pathToFileURL(require.resolve('@zip.js/zip.js')))
    zipReader = new ZipReader(new BlobReader(archive), {useWebWorkers: false})
    entries = await zipReader.getEntries()
}
const hasMedia = entries.some((entry) => !entry.directory && getImageMediaTypeFromFileName(entry.filename) !== null)
const banks = entries.filter((entry) => /^term_bank_\d+\.json$/.test(entry.filename))
    .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)))
const sourceBytes = banks.reduce((total, bank) => total + bank.uncompressedSize, 0)
const payloadReader = new RawZipPayloadReader(archive)
const signal = new AbortController().signal
const resident = []
for (const entry of banks) {
    const bytes = await payloadReader.read(entry, signal)
    resident.push({buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        metadata: {filename: entry.filename, compressedSize: entry.compressedSize,
            uncompressedSize: entry.uncompressedSize, compressionMethod: entry.compressionMethod,
            signature: entry.signature}})
}
await zipReader?.close()

// These are the existing lazy planner constants and partition algorithm, not
// tuning knobs. Groups execute serially here; worker count only selects the
// source grouping which that production policy would select.
const parserSource = await readFile(path.join(root, sourceFiles[0]), 'utf8')
assert(parserSource.includes('const PLAIN_PARALLEL_SOURCE_PIPELINE_GROUPS_PER_WORKER = 4;'))
assert(parserSource.includes('const MEDIA_PARALLEL_SOURCE_PIPELINE_GROUPS_PER_WORKER = 3;'))
assert(parserSource.includes('const LAZY_PARALLEL_SOURCE_TARGET_GROUP_BYTES = 24 * 1024 * 1024;'))
assert(parserSource.includes('const OWNED_PROJECTED_CONTENT_MIN_SOURCE_BYTES = 512 * 1024 * 1024;'))
const groupCount = Math.min(banks.length, Math.max(workerCount * (hasMedia ? 3 : 4), Math.ceil(sourceBytes / (24 * 1024 * 1024))))
const groups = []
let start = 0
let consumed = 0
for (let group = 0; group < groupCount - 1; ++group) {
    const target = (sourceBytes - consumed) / (groupCount - group)
    let end = start + 1
    let bytes = banks[start].uncompressedSize
    const maximumEnd = banks.length - (groupCount - group - 1)
    while (end < maximumEnd) {
        const next = bytes + banks[end].uncompressedSize
        if (Math.abs(next - target) > Math.abs(bytes - target)) { break }
        bytes = next
        ++end
    }
    groups.push(resident.slice(start, end))
    start = end
    consumed += bytes
}
groups.push(resident.slice(start))
const {MIN_EXACT_LOOKUP_SOURCE_BYTES} = await sourceImport('ext/js/dictionary/term-lookup-route.js')
const options = {
    copyContentBytes: false,
    includeContentMetadata: true,
    initialContentBytesPerRow: 48,
    minimalDecode: true,
    reuseExpressionForReadingDecode: true,
    preallocateChunkRows: true,
    skipTagRuleDecode: hasMedia,
    lazyGlossaryDecode: true,
    mediaHintFastScan: hasMedia,
    projectImagePaths: hasMedia,
    validateGlossaryTypes: true,
    computeContentHashes: true,
    emitContentSlab: true,
    emitTokenBinaryContent: true,
    emitTermByteLists: false,
    prepareLookupIndexes: true,
    prepareLookupRoute: sourceBytes >= MIN_EXACT_LOOKUP_SOURCE_BYTES,
    ownContentBytes: hasMedia && sourceBytes >= 512 * 1024 * 1024,
    experimentalNativeEscapedKeys: hasMedia && sourceBytes >= 512 * 1024 * 1024,
    maxPendingChunks: 2,
}

// Run the actual browser worker module with a small message boundary adapter.
// No worker implementation is copied here. postMessage/structured cloning,
// concurrency and scheduling are outside this explicitly sequential boundary.
let messageHandler
let pending
globalThis.self = {
    addEventListener(type, handler) { assert.equal(type, 'message'); assert.equal(messageHandler, undefined); messageHandler = handler },
    postMessage(message, transfer = []) {
        const finished = performance.now()
        assert(pending, 'Unsolicited worker reply')
        const request = pending
        pending = null
        if (message.type.endsWith('error')) { request.reject(new Error(JSON.stringify(message.error))); return }
        request.resolve({message, transfer, finished})
    },
}
await sourceImport('ext/js/dictionary/term-bank-wasm-parser-worker.js')
const send = (data) => new Promise((resolve, reject) => {
    assert(!pending)
    pending = {resolve, reject}
    messageHandler({data})
})
await send({type: 'initialize', module: await WebAssembly.compile(moduleBytes)})

// Hash complete deterministic worker output, including every content byte,
// per-row mapping, key-plan column, lookup byte, media row, and route filter.
// Typed array constructor names and lengths are part of the digest. No output
// normalization masks candidate differences.
function digestValue(hash, value) {
    if (ArrayBuffer.isView(value)) {
        hash.update(`view:${value.constructor.name}:${value.byteLength}:`)
        hash.update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
    } else if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
        hash.update(`buffer:${value.byteLength}:`)
        hash.update(new Uint8Array(value))
    } else if (value instanceof Map) {
        hash.update(`map:${value.size}:`)
        for (const [key, item] of value) { digestValue(hash, key); digestValue(hash, item) }
    } else if (Array.isArray(value)) {
        hash.update(`array:${value.length}:`)
        for (const item of value) { digestValue(hash, item) }
    } else if (value !== null && typeof value === 'object') {
        const keys = Object.keys(value).sort()
        hash.update(`object:${keys.length}:`)
        for (const key of keys) { digestValue(hash, key); digestValue(hash, value[key]) }
    } else {
        assert.notEqual(typeof value, 'function', 'Worker output must be structured-cloneable')
        const text = Object.is(value, -0) ? '-0' : String(value)
        hash.update(`${typeof value}:${Buffer.byteLength(text)}:${text}`)
    }
}
function dedupWorkCounts(message, verification) {
    const chunk = message.chunk
    const plan = chunk.contentDedupPlan
    assert(plan && Number.isSafeInteger(plan.uniqueCount))
    assert.equal(plan.sourceRowCount, message.rowCount)
    assert.equal(chunk.contentRowStart ?? 0, 0)
    const recentContentDedupHitCount = message.profile.recentContentDedupHitCount
    assert(Number.isSafeInteger(recentContentDedupHitCount))
    const duplicateRows = message.rowCount - plan.uniqueCount
    const lateCanonicalDuplicateRows = duplicateRows - recentContentDedupHitCount
    assert(lateCanonicalDuplicateRows >= 0)
    const counts = {rows: message.rowCount, uniqueCount: plan.uniqueCount,
        recentContentDedupHitCount, duplicateRows, lateCanonicalDuplicateRows}
    if (verification) {
        const indexes = chunk.contentUniqueIndexList
        const metas = chunk.contentMetaList
        assert(indexes instanceof Uint32Array && metas instanceof Uint32Array)
        assert.equal(indexes.length, message.rowCount)
        assert.equal(plan.uniqueRowIndexes.length, plan.uniqueCount)
        let duplicateEncodedBytes = 0
        let uniqueEncodedBytes = 0
        for (let row = 0; row < indexes.length; ++row) {
            const uniqueIndex = indexes[row]
            assert(uniqueIndex < plan.uniqueCount)
            const length = metas[(chunk.contentMetaByUniqueIndex === true ? uniqueIndex : row) * 4 + 1]
            if (plan.uniqueRowIndexes[uniqueIndex] === row) { uniqueEncodedBytes += length }
            else { duplicateEncodedBytes += length }
        }
        counts.duplicateEncodedBytes = duplicateEncodedBytes
        counts.uniqueEncodedBytes = uniqueEncodedBytes
    }
    return counts
}
const report = {
    schema: 3,
    boundary: 'Sequential actual parser-worker transactions: resident compressed bank bytes through native inflate/CRC, parse, canonical content and lookup generation, worker ownership copies, media projection and transfer-list construction. Excludes ZIP directory/payload reads, module initialization, IPC and structured cloning, parallel scheduling, compression/storage, media payload import, browser UI and first lookup. A separate final verification pass hashes all outputs; measured passes contain no output hashing and remain bound to unchanged source/module/fixture identities.',
    complete: false,
    dictionary: values.dictionary,
    root,
    node: process.version,
    v8: process.versions.v8,
    host: {cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, load: os.loadavg(), memoryBytes: os.totalmem()},
    identity,
    diagnosticNativeOverride,
    injectedWasmSha256: sha256(moduleBytes),
    runnerSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    fixture: {sha256: fixture.sha256, sizeBytes: fixture.sizeBytes, rows: fixture.termRows, lockSha256: sha256(lockBytes)},
    grouping: {workerCountPolicy: workerCount, groupCount, hasMedia, sourceBytes, bankCount: banks.length,
        groups: groups.map((group) => group.map(({metadata}) => metadata.filename))},
    options,
    workCountsCaveat: 'O(1) canonical unique/recent/late row counters are collected after each timed transaction. Duplicate byte totals are scanned only in the separate verification pass. Late canonical duplicate rows are an upper bound on raw-identical opportunities: canonical equality can normalize different raw input. Final row-to-unique metadata does not identify which duplicate bytes belong specifically to late versus recent matches.',
    observations: [],
}
const output = path.resolve(values.out)
await mkdir(path.dirname(output), {recursive: true})
const save = () => writeFile(output, JSON.stringify(report, null, 2) + '\n')
let id = 0
let verifiedDigest = null
async function runPass({warmup = false, verification = false, block = null} = {}) {
        const pass = report.observations.length
        globalThis.gc?.()
        const timed = !warmup && !verification
        const digest = verification ? createHash('sha256') : null
        const observation = {pass, block, warmup, verification, timed, workerMs: 0, cpuMs: 0, cpuUserMs: 0, cpuSystemMs: 0, threadCpuMs: 0, threadCpuUserMs: 0, threadCpuSystemMs: 0, rows: 0, transferBytes: 0, workCounts: {}, groups: []}
        report.observations.push(observation)
        for (let groupIndex = 0; groupIndex < groups.length; ++groupIndex) {
            const group = groups[groupIndex]
            const request = {type: 'parse', id: ++id, sourceBuffers: group.map((source) => source.buffer),
                sourceMetadata: group.map((source) => source.metadata), version: 3, chunkSize: 2048, options}
            const cpuBegan = process.cpuUsage()
            const threadCpuBegan = process.threadCpuUsage()
            const began = performance.now()
            const {message, transfer, finished} = await send(request)
            const threadCpu = process.threadCpuUsage(threadCpuBegan)
            const cpu = process.cpuUsage(cpuBegan)
            assert.equal(message.type, 'result')
            assert.equal(message.id, id)
            const workerMs = finished - began
            observation.workerMs += workerMs
            observation.cpuUserMs += cpu.user / 1000
            observation.cpuSystemMs += cpu.system / 1000
            observation.cpuMs += (cpu.user + cpu.system) / 1000
            observation.threadCpuUserMs += threadCpu.user / 1000
            observation.threadCpuSystemMs += threadCpu.system / 1000
            observation.threadCpuMs += (threadCpu.user + threadCpu.system) / 1000
            observation.rows += message.rowCount
            observation.transferBytes += transfer.reduce((sum, buffer) => sum + buffer.byteLength, 0)
            assert(message.chunk && message.chunk.preparedLookupIndexes instanceof Map)
            const workCounts = dedupWorkCounts(message, verification)
            for (const [name, value] of Object.entries(workCounts)) {
                observation.workCounts[name] = (observation.workCounts[name] ?? 0) + value
            }
            if (verification) {
                // Timing fields describe execution, not dictionary semantics.
                const {preparedLookupIndexEncodeMs, ...semanticChunk} = message.chunk
                digestValue(digest, semanticChunk)
            }
            observation.groups.push({index: groupIndex, workerMs, cpuMs: (cpu.user + cpu.system) / 1000, rows: message.rowCount,
                threadCpuMs: (threadCpu.user + threadCpu.system) / 1000,
                borrowsWorkerMemory: message.borrowsWorkerMemory, ownsContentBytes: message.ownsContentBytes,
                workCounts, profile: message.profile})
        }
        assert.equal(observation.rows, fixture.termRows)
        if (verification) {
            observation.digest = digest.digest('hex')
            if (verifiedDigest === null) { verifiedDigest = observation.digest }
            assert.equal(observation.digest, verifiedDigest, 'Repeated same-source output changed')
        }
        observation.memory = process.memoryUsage()
        observation.maxRSSKiB = process.resourceUsage().maxRSS
        await save()
        console.log(JSON.stringify({dictionary: values.dictionary, pass, warmup, verification, timed, workerMs: observation.workerMs, cpuMs: observation.cpuMs,
            threadCpuMs: observation.threadCpuMs,
            rows: observation.rows, digest: observation.digest ?? null}))
        return observation
}
async function finish() {
    assert.deepEqual(await sourceHashes(), identity, 'Source changed during replay')
    if (diagnosticNativeOverride) {
        assert.equal(sha256(await readFile(path.join(diagnosticNativeOverride.root, 'ext/js/dictionary/wasm/term-bank-parser.c'))), diagnosticNativeOverride.sourceSha256)
        assert.equal(sha256(await readFile(path.join(diagnosticNativeOverride.root, 'ext/lib/term-bank-parser.wasm'))), diagnosticNativeOverride.wasmSha256)
    }
    report.complete = true
    await save()
    return {identity: report.identity, injectedWasmSha256: report.injectedWasmSha256,
        runnerSha256: report.runnerSha256, digest: verifiedDigest, observations: report.observations.length}
}
async function fail(error) {
    report.error = {message: error.message, stack: error.stack}
    await save()
}
if (values.serve) {
    assert(parentPort, 'Server mode requires a parent worker port')
    let busy = false
    parentPort.on('message', async (command) => {
        try {
            assert(!busy, 'Overlapping benchmark commands')
            busy = true
            let result
            if (command.type === 'run') { result = await runPass(command) }
            else if (command.type === 'close') { result = await finish() }
            else { throw new Error('Unknown benchmark server command') }
            busy = false
            parentPort.postMessage({id: command.id, ok: true, result})
            if (command.type === 'close') { parentPort.close() }
        } catch (error) {
            await fail(error)
            parentPort.postMessage({id: command.id, ok: false, error: {message: error.message, stack: error.stack}})
            parentPort.close()
        }
    })
    parentPort.postMessage({type: 'ready', root, diagnosticNativeOverride,
        injectedWasmSha256: report.injectedWasmSha256, runnerSha256: report.runnerSha256,
        options: report.options, grouping: report.grouping, fixture: report.fixture,
        gcExposed: typeof globalThis.gc === 'function'})
} else {
    try {
        for (let pass = 0; pass < warmups + runs + 1; ++pass) {
            await runPass({warmup: pass < warmups, verification: pass === warmups + runs})
        }
        await finish()
    } catch (error) {
        await fail(error)
        throw error
    }
}
