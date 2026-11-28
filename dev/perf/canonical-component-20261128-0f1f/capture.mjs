/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createReadStream, openAsBlob, writeFileSync, mkdirSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import {gzipSync} from 'node:zlib'
import {parseArgs} from 'node:util'
import {readFile, writeFile} from 'node:fs/promises'
import {join, resolve, dirname} from 'node:path'
import {pathToFileURL, fileURLToPath} from 'node:url'
import {Worker as ThreadWorker} from 'node:worker_threads'
import {BlobReader, Uint8ArrayWriter, ZipReader} from '@zip.js/zip.js'

// Capture native input/output state only; no timers or synthetic warmup.
const {values} = parseArgs({options: {
    'project-root': {type: 'string'}, fixtures: {type: 'string'}, output: {type: 'string'},
}})
assert(values['project-root'] && values.fixtures && values.output)
const toolingRoot = dirname(fileURLToPath(import.meta.url))
const protocol = JSON.parse(await readFile(join(toolingRoot, 'protocol.json')))
const parentRoot = resolve(values['project-root'])
const candidateRoot = parentRoot
const cachePath = resolve(values.fixtures)
const outputPath = resolve(values.output)
const dictionary = 'jmdict'
const cpus = protocol.capture.hardwareConcurrency
const memory = protocol.capture.deviceMemoryGiB
assert.equal(process.version, protocol.nodeVersion)
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], {cwd: parentRoot, encoding: 'utf8'}).trim(), protocol.baseline.sourceCommit)
execFileSync('git', ['diff', '--exit-code'], {cwd: parentRoot})
mkdirSync(outputPath, {recursive: true})
// The CLI explicitly selects the two local source trees to compare.
// eslint-disable-next-line no-unsanitized/method
const localImport = (root, filename) => import(pathToFileURL(join(root, filename)))
const parser = await localImport(candidateRoot, 'ext/js/dictionary/term-bank-wasm-parser.js')
const pipelineModule = await localImport(candidateRoot, 'ext/js/dictionary/term-bank-source-pipeline.js')
const parents = await localImport(parentRoot, 'ext/js/dictionary/dictionary-database.js')
const parentOwnership = await localImport(parentRoot, 'ext/js/dictionary/term-content-ownership.js')
const fetchOriginal = globalThis.fetch
globalThis.fetch = async (input, options) => {
    if (String(input).startsWith('file:')) { return new Response(await readFile(new URL(input))) }
    return fetchOriginal(input, options)
}
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const lockBytes = await readFile(join(candidateRoot, 'test/perf/dictionaries.lock.json'))
assert.equal(sha(lockBytes), protocol.fixture.lockSha256)
const fixture = JSON.parse(lockBytes).dictionaries[dictionary]
assert(fixture)
assert.equal(fixture.sha256, protocol.fixture.sha256)
assert.equal(fixture.sizeBytes, protocol.fixture.bytes)
const archivePath = join(cachePath, fixture.cacheFile)
const archiveHash = createHash('sha256')
for await (const bytes of createReadStream(archivePath)) { archiveHash.update(bytes) }
assert.equal(archiveHash.digest('hex'), fixture.sha256)
const archive = await openAsBlob(archivePath)
assert.equal(archive.size, fixture.sizeBytes)
const wasm = await readFile(join(candidateRoot, 'ext/lib/term-bank-parser.wasm'))
const nativeManifest = JSON.parse(await readFile(join(parentRoot, 'dev/data/dictionary-wasm/manifest.json')))
assert.equal(sha(wasm), nativeManifest.targets.find(({name}) => name === 'term-bank-parser.wasm').sha256)
parser.setTermBankWasmModule(await WebAssembly.compile(wasm))

const terminations = []
const sourceGroups = []
class BrowserWorker extends EventTarget {
    constructor(url) {
        super()
        this.worker = new ThreadWorker(pathToFileURL(join(candidateRoot, 'test/fixtures/parser-settlement/worker-node.mjs')), {workerData: {url: url.href}})
        this.worker.on('message', (data) => this.dispatchEvent(new MessageEvent('message', {data})))
        this.worker.on('error', (error) => {
            const event = new Event('error')
            Object.defineProperty(event, 'message', {value: error.message})
            this.dispatchEvent(event)
        })
        this.worker.on('messageerror', () => this.dispatchEvent(new MessageEvent('messageerror')))
    }

    postMessage(data, transfer) {
        if (data.type === 'parse') {
            sourceGroups.push({id: data.id, files: data.sourceMetadata?.map(({filename}) => filename) ?? null, bytes: data.sourceBuffers.map((buffer) => buffer.byteLength)})
        }
        this.worker.postMessage(data, transfer)
    }

    terminate() { terminations.push(this.worker.terminate()) }
}
globalThis.Worker = BrowserWorker
Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {hardwareConcurrency: Number(cpus), deviceMemory: Number(memory)}})

const reader = new ZipReader(new BlobReader(archive))
const entries = await reader.getEntries()
const termFiles = entries.filter(({filename}) => /^term_bank_\d+\.json$/.test(filename)).sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)))
const rawReader = new pipelineModule.RawZipPayloadReader(archive)
const sourcePipeline = new pipelineModule.TermBankSourcePipeline({
    termFiles,
    enabled: true,
    read: async (file) => await file.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true}),
    readCompressed: async (file, signal) => await rawReader.read(file, signal),
})
const groups = []
const profiles = []
let rowCount = 0
async function consume(chunk) {
    const plan = chunk.contentDedupPlan
    assert(plan && chunk.contentUniqueIndexList && chunk.contentMetaList)
    groups.push({
        rowCount: chunk.rowCount,
        dictionary: fixture.expectedTitle,
        dictionaryTotalRows: fixture.termRows,
        contentBytesBuffer: new Uint8Array(chunk.contentBytesBuffer),
        contentBytesBaseOffset: chunk.contentBytesBaseOffset,
        contentMetaByUniqueIndex: chunk.contentMetaByUniqueIndex,
        contentMetaList: new Uint32Array(chunk.contentMetaList),
        contentRowStart: chunk.contentRowStart,
        contentUniqueIndexList: new Uint32Array(chunk.contentUniqueIndexList),
        contentDedupPlan: structuredClone(plan),
        useResolvedContentReferences: true,
        uniformContentDictName: chunk.uniformContentDictName ?? 'raw',
        contentHash1List: new Uint32Array(0),
        contentHash2List: new Uint32Array(0),
    })
    rowCount += chunk.rowCount
}
const media = fixture.mediaFiles > 0
const options = {
    emitTermByteLists: false,
    computeContentHashes: true,
    emitContentSlab: true,
    emitTokenBinaryContent: true,
    mediaHintFastScan: media,
    projectImagePaths: media,
    validateGlossaryTypes: true,
    prepareLookupIndexes: true,
    maxPendingChunks: 2,
}
let complete = false
let error = null
try {
    for (let start = 0; start < termFiles.length;) {
        const compressedPlan = sourcePipeline.createCompressedImportRunPlan(start)
        if (compressedPlan !== null) {
            assert.equal(await parser.parseTermBankWithWasmColumnChunksParallelCompressedLazy(compressedPlan.loaders, compressedPlan.estimatedByteLengths, 3, consume, options), true)
            profiles.push(parser.consumeLastTermBankWasmParseProfile())
            sourcePipeline.releaseBatch(compressedPlan.files)
            start += compressedPlan.files.length
        } else {
            const files = sourcePipeline.getBatch(start)
            const batch = await sourcePipeline.readBatch(files)
            if (batch?.promises) {
                assert.equal(await parser.parseTermBankWithWasmColumnChunksParallelDeferred(batch.promises, batch.estimatedByteLengths, 3, consume, options), true)
            } else {
                await parser.parseTermBankWithWasmColumnChunks(batch, 3, consume, 2048, {...options, singleChunk: true})
            }
            profiles.push(parser.consumeLastTermBankWasmParseProfile())
            sourcePipeline.releaseBatch(files)
            start += files.length
        }
    }
    assert.equal(rowCount, fixture.termRows)
    assert.equal(rowCount, protocol.fixture.rows)
    complete = true
} catch (failure) {
    error = String(failure)
    throw failure
} finally {
    await sourcePipeline.dispose()
    await parser.disposeParallelTermBankParser()
    await Promise.all(terminations)
    await reader.close()

}
assert(complete)
sourceGroups.sort((a, b) => a.id - b.id)
assert.equal(groups.length, protocol.capture.expectedGroups)
assert.deepEqual(sourceGroups.map(({id}) => id), Array.from({length: groups.length}, (_, i) => i + 1))

const database = new parents.DictionaryDatabase()
const captures = []
let currentGroup = 0
let beforeBytes = null
let storageCursor = 1
let compressedTotal = 0
const totals = {uniqueRows: 0, pendingRows: 0, exactRows: 0, recentHits: 0}
const contentDigest = createHash('sha256')
database._readTermEntryContentBytesDetailedBatch = async () => { throw new Error('Unexpected storage read in locked JMdict capture') }

function saveBlob(name, bytes) {
    const compressed = gzipSync(bytes, {level: 9})
    compressedTotal += compressed.byteLength
    assert.ok(compressedTotal < 100 * 1024 * 1024, 'Snapshot capture exceeds 100 MiB compressed bound')
    writeFileSync(join(outputPath, name), compressed)
    return {path: name, bytes: bytes.byteLength, sha256: sha(bytes), compressedBytes: compressed.byteLength, compressedSha256: sha(compressed)}
}

database._nativeCanonicalScanner._hooks.beforeNative = ({a}) => {
    assert.equal(beforeBytes, null)
    assert.equal(captures.length, currentGroup)
    beforeBytes = new Uint8Array(a.memory.buffer).slice()
    const config = Array.from(new Uint32Array(a.memory.buffer, 1088, 22))
    const before = saveBlob(`group-${String(currentGroup + 1).padStart(2, '0')}.before.bin.gz`, beforeBytes)
    captures.push({
        group: currentGroup + 1,
        rowCount: groups[currentGroup].rowCount,
        uniqueRows: config[14] - config[13],
        expectedReturn: 0,
        memoryPages: beforeBytes.byteLength / 65536,
        sourceGroup: sourceGroups[currentGroup],
        config,
        before,
    })
}
database._nativeCanonicalScanner._hooks.beforeOutputView = ({a, column}) => {
    if (column !== 0) { return }
    assert(beforeBytes)
    const after = new Uint8Array(a.memory.buffer)
    const capture = captures[currentGroup]
    capture.afterSha256 = sha(after)
    capture.afterHeader = Array.from(new Uint32Array(a.memory.buffer, 1024, 7))
    assert.equal(capture.afterHeader[1], capture.uniqueRows)
    assert.ok(capture.afterHeader[3] < 4096)
    assert.equal(capture.afterHeader[2] + capture.afterHeader[3] + capture.afterHeader[4], capture.uniqueRows)
    for (let i = 0; i < beforeBytes.length; ++i) { beforeBytes[i] ^= after[i] }
    capture.afterXor = saveBlob(`group-${String(currentGroup + 1).padStart(2, '0')}.after-xor.bin.gz`, beforeBytes)
    beforeBytes = null
}

for (const sourceChunk of groups) {
    const chunk = {...sourceChunk, contentDedupPlan: structuredClone(sourceChunk.contentDedupPlan)}
    if (parentOwnership.shouldOwnTermContentBytes(chunk.contentBytesBuffer.byteLength, chunk.contentDedupPlan.uniqueCount, chunk.contentDedupPlan.sourceRowCount, chunk.rowCount)) {
        parentOwnership.registerOwnedTermContent(chunk.contentBytesBuffer)
    }
    const dedup = await database._resolveArtifactTermContentDedup(chunk, true)
    assert.equal(captures.length, currentGroup + 1)
    assert(dedup.contentDedupPlan && dedup.pendingContentSpans)
    const pendingOffsets = Float64Array.from({length: dedup.pendingContentCount}, (_, i) => storageCursor + i)
    const pendingLengths = dedup.pendingContentSpans.lengths
    storageCursor += dedup.pendingContentCount
    database._publishResolvedArtifactTermContentPlan(dedup.contentDedupPlan, dedup.pendingPlanUniqueStart, dedup.pendingPlanUniqueIndexes, pendingOffsets, pendingLengths, 'raw')
    database._publishArtifactTermContentMetadata({
        ...dedup,
        count: chunk.rowCount,
        pendingOffsets,
        pendingLengths,
        pendingResolvedDictNames: 'raw',
        contentUniqueIndexList: chunk.contentUniqueIndexList,
        metadataValidated: true,
        useResolvedContentReferences: true,
    })
    totals.uniqueRows += captures[currentGroup].uniqueRows
    totals.pendingRows += dedup.pendingContentCount
    totals.exactRows += dedup.exactFallbackCount
    totals.recentHits += dedup.recentSourceHitCount
    captures[currentGroup].dedup = {pending: dedup.pendingContentCount, exact: dedup.exactFallbackCount, recent: dedup.recentSourceHitCount}
    for (const value of [dedup.contentDedupPlan.resolvedFlags, dedup.contentDedupPlan.resolvedOffsets, dedup.contentDedupPlan.resolvedLengths]) {
        contentDigest.update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
    }
    ++currentGroup
    writeFileSync(join(outputPath, 'capture-progress.json'), JSON.stringify({complete: false, totals, compressedTotal, groups: captures}, null, 2) + '\n')
    process.stderr.write(`Captured native group ${currentGroup}: ${captures[currentGroup - 1].uniqueRows} rows; ${compressedTotal} compressed bytes total\n`)
}
assert.equal(totals.uniqueRows, protocol.capture.expectedUniqueRows)
assert.equal(totals.pendingRows, protocol.capture.expectedPendingRows)
assert.equal(totals.exactRows, protocol.capture.expectedExactRows)
assert.equal(totals.recentHits, protocol.capture.expectedExactRows)
assert.equal(database._nativeCanonicalScanner.stats.calls, groups.length)
const canonicalBytes = await readFile(join(parentRoot, 'ext/lib/term-content-canonical-scan-v1.wasm'))
assert.equal(sha(canonicalBytes), protocol.baseline.sha256)
const protectedPaths = [
    'package-lock.json', 'test/perf/dictionaries.lock.json',
    'ext/js/dictionary/dictionary-database.js', 'ext/js/dictionary/term-bank-wasm-parser.js',
    'ext/js/dictionary/term-bank-wasm-parser-worker.js', 'ext/js/dictionary/term-bank-source-pipeline.js',
    'ext/js/dictionary/term-content-canonical-scan.js', 'ext/js/dictionary/term-content-canonical-layout.js',
    'ext/js/dictionary/term-content-metadata-arena.js', 'ext/js/dictionary/term-content-ownership.js',
    'ext/js/dictionary/wasm/term-content-canonical-scan-v1.c',
    'dev/data/dictionary-wasm/manifest.json', 'test/fixtures/parser-settlement/worker-node.mjs',
]
const sourceFiles = []
for (const path of protectedPaths) {
    const bytes = await readFile(join(parentRoot, path))
    sourceFiles.push({path, bytes: bytes.byteLength, sha256: sha(bytes)})
}
const inventory = {
    schemaVersion: 1,
    complete: true,
    scope: 'Exact native states from production JMdict grouping and baseline dedup/publication; deterministic surrogate persistence offsets do not enter the native arena. Excludes compression, records, OPFS and import timing.',
    sourceCommit: protocol.baseline.sourceCommit,
    sourceTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {cwd: parentRoot, encoding: 'utf8'}).trim(),
    sourceFiles,
    captureScriptSha256: sha(await readFile(new URL(import.meta.url))),
    parserWasmSha256: sha(wasm),
    canonicalWasmSha256: sha(canonicalBytes),
    nodeVersion: process.version,
    fixture: protocol.fixture,
    hardwareConcurrency: cpus,
    deviceMemoryGiB: memory,
    parserWorkers: 3,
    sourceRows: rowCount,
    totals,
    metadataDigest: contentDigest.digest('hex'),
    compressedTotal,
    groups: captures,
}
await writeFile(join(outputPath, 'inventory.json'), JSON.stringify(inventory, null, 2) + '\n', {flag: 'wx'})
console.log(JSON.stringify({complete: true, groups: captures.length, totals, compressedTotal, inventorySha256: sha(await readFile(join(outputPath, 'inventory.json')))}))
