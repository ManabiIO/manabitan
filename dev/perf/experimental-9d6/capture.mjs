/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createReadStream, openAsBlob} from 'node:fs'
import {readFile, writeFile, mkdir} from 'node:fs/promises'
import {serialize} from 'node:v8'
import {join, resolve} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {gzipSync} from 'node:zlib'
import {Worker as ThreadWorker} from 'node:worker_threads'
import {BlobReader, Uint8ArrayWriter, ZipReader} from '@zip.js/zip.js'

// Replay the actual source planner and parser workers. Only persistence is
// intercepted. Resolved spans use native content lengths at deterministic
// offsets; this checks record bytes, not compression or whole-database parity.
const [parentPath, candidatePath, cachePath, outputPath, dictionary = 'jmdict', cpus = '4', memory = '8'] = process.argv.slice(2)
assert(parentPath && candidatePath && cachePath && outputPath, 'Usage: capture.mjs <baselineRoot> <candidateRoot> <cacheDir> <outDir> [jmdict] [cpus=4] [memory=8]')
assert.equal(dictionary, 'jmdict', 'This capture is qualified only for the plain JMdict parser policy; media corpora need importer-equivalent options and separate validation')
const parentRoot = resolve(parentPath)
const candidateRoot = resolve(candidatePath)
// The CLI explicitly selects the two local source trees to compare.
// eslint-disable-next-line no-unsanitized/method
const localImport = (root, filename) => import(pathToFileURL(join(root, filename)))
const parser = await localImport(candidateRoot, 'ext/js/dictionary/term-bank-wasm-parser.js')
const pipelineModule = await localImport(candidateRoot, 'ext/js/dictionary/term-bank-source-pipeline.js')
const {DictionaryDatabase} = await localImport(candidateRoot, 'ext/js/dictionary/dictionary-database.js')
const {NativeCanonicalScanner} = await localImport(candidateRoot, 'ext/js/dictionary/term-content-canonical-scan.js')
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const fixtureLockPath = join(candidateRoot, 'test/perf/dictionaries.lock.json')
const lockBytes = await readFile(fixtureLockPath)
assert.deepEqual(lockBytes, await readFile(join(parentRoot, 'test/perf/dictionaries.lock.json')))
const fixture = JSON.parse(lockBytes).dictionaries[dictionary]
assert(fixture)
const archivePath = resolve(cachePath, fixture.cacheFile)
const archiveHash = createHash('sha256')
for await (const bytes of createReadStream(archivePath)) { archiveHash.update(bytes) }
assert.equal(archiveHash.digest('hex'), fixture.sha256)
const archive = await openAsBlob(archivePath)
assert.equal(archive.size, fixture.sizeBytes)
const wasm = await readFile(join(candidateRoot, 'ext/lib/term-bank-parser.wasm'))
assert.deepEqual(wasm, await readFile(join(parentRoot, 'ext/lib/term-bank-parser.wasm')))
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
const fullDigest = createHash('sha256')
let rowCount = 0
let contentBase = 0
const virtualDictName = 'raw-block-v2:jmdict'
const database = new DictionaryDatabase()
const canonicalWasm = await readFile(join(candidateRoot, 'ext/lib/term-content-canonical-scan-v1.wasm'))
const canonicalModule = await WebAssembly.compile(canonicalWasm)
database._nativeCanonicalScanner = new NativeCanonicalScanner({loadModule: async () => canonicalModule})
const storage = new Map()
database._readTermEntryContentBytesDetailedBatch = async (requests) => requests.map(({contentOffset, contentLength, contentDictName}) => {
    const entry = storage.get(contentOffset)
    assert(entry && contentDictName === virtualDictName && entry.byteLength === contentLength)
    return {status: 'ok', bytes: entry}
})
await mkdir(outputPath, {recursive: true})
const originalCache = database._cacheRecentPublishedTermContentSources.bind(database)
let cacheDiagnostic = null
database._cacheRecentPublishedTermContentSources = (staged, spans, metrics) => {
    const indexes = staged.indexes
    let minimum = Infinity
    let end = 0
    let published = 0
    let contiguous = true
    let bytes = 0
    const stateTable = database._termEntryContentMetaStateTable
    const first = indexes[0]
    const states = Uint8Array.from(indexes, (i) => i < 0 ? 0 : stateTable[i])
    for (let i = 0; i < indexes.length; ++i) {
        if (indexes[i] !== first + i) { contiguous = false }
        if (indexes[i] < 0 || states[i] !== 1) { continue }
        ++published
        minimum = Math.min(minimum, spans.offsets[i])
        end = Math.max(end, spans.offsets[i] + spans.lengths[i])
        bytes += spans.lengths[i]
    }
    const result = originalCache(staged, spans, metrics)
    cacheDiagnostic = {count: indexes.length, first, contiguous, stateValues: [...new Set(states)], published,
        minimum, end, bytes, sourceLength: spans.buffer.byteLength, sourceBufferLength: spans.buffer.buffer.byteLength,
        shared: !(spans.buffer.buffer instanceof ArrayBuffer), retainedBytes: result,
        cacheBytes: database._recentTermContentSourceBatchBytes,
        states, indexes: indexes.slice(), offsets: spans.offsets.slice(), lengths: spans.lengths.slice(),
        source: spans.buffer.slice(), stateCapacity: stateTable.length,
        hash1s: Uint32Array.from(indexes, (index) => database._termEntryContentMetaHash1Table[index]),
        hash2s: Uint32Array.from(indexes, (index) => database._termEntryContentMetaHash2Table[index]),
        persistedOffsets: Float64Array.from(indexes, (index) => database._termEntryContentMetaOffsetTable[index]),
        persistedLengths: spans.lengths.slice(), virtualDictName, owned: (metrics.dedupRecentSourceAdoptedBytes ?? 0) > 0,
    }
    return result
}

async function consume(chunk) {
    chunk.dictionary = fixture.expectedTitle
    chunk.dictionaryTotalRows = fixture.termRows
    chunk.uniformContentDictName = virtualDictName
    chunk.useResolvedContentReferences = true
    const dedup = await database._resolveArtifactTermContentDedup(chunk, true)
    const plan = dedup.contentDedupPlan
    assert(plan && dedup.pendingContentSpans)
    const offsets = new Float64Array(dedup.pendingContentCount)
    const lengths = dedup.pendingContentSpans.lengths
    for (let i = 0; i < dedup.pendingContentCount; ++i) {
        const spans = dedup.pendingContentSpans
        const entry = spans.buffer.slice(spans.offsets[i], spans.offsets[i] + spans.lengths[i])
        offsets[i] = contentBase
        lengths[i] = entry.byteLength
        storage.set(contentBase, entry)
        contentBase += Math.max(1, entry.byteLength)
    }
    database._publishResolvedArtifactTermContentPlan(plan, dedup.pendingPlanUniqueStart, dedup.pendingPlanUniqueIndexes,
        offsets, lengths, virtualDictName)
    const metrics = {contentMetadataProjectionMs: 0, contentMetadataIndexPublishMs: 0, dedupRecentSourceCacheMs: 0, dedupRecentSourceCacheBytes: 0}
    const resolvedNames = database._publishArtifactTermContentMetadata({
        ...dedup, count: chunk.rowCount, contentUniqueIndexList: chunk.contentUniqueIndexList,
        pendingOffsets: offsets, pendingLengths: lengths, pendingResolvedDictNames: virtualDictName,
        useResolvedContentReferences: true, metadataValidated: true, importMetrics: metrics,
    })
    assert.equal(resolvedNames, virtualDictName)
    assert(cacheDiagnostic)
    const cache = cacheDiagnostic
    const cacheName = `group-${String(groups.length + 1).padStart(2, '0')}.bin.gz`
    const serialized = serialize(cache)
    const compressed = gzipSync(serialized)
    await writeFile(join(outputPath, cacheName), compressed, {flag: 'wx'})
    const {source, states, indexes, offsets: spanOffsets, lengths: spanLengths, hash1s, hash2s, persistedOffsets, persistedLengths, ...info} = cache
    groups.push({rows: chunk.rowCount, pending: dedup.pendingContentCount, persistedHits: dedup.persistedHitCount,
        recentSourceHits: dedup.recentSourceHitCount ?? 0, cacheFile: cacheName,
        cacheSha256: sha(compressed), serializedSha256: sha(serialized),
        serializedBytes: serialized.byteLength, compressedBytes: compressed.byteLength, ...info, metrics})
    for (let row = 0; row < chunk.rowCount; ++row) {
        const uniqueIndex = chunk.contentUniqueIndexList[row]
        assert.equal(plan.resolvedFlags[uniqueIndex], 1)
        const stored = storage.get(plan.resolvedOffsets[uniqueIndex])
        const meta = (chunk.contentMetaByUniqueIndex ? uniqueIndex : plan.uniqueRowIndexes[uniqueIndex]) * 4
        const expected = chunk.contentBytesBuffer.subarray(chunk.contentMetaList[meta], chunk.contentMetaList[meta] + chunk.contentMetaList[meta + 1])
        assert.deepEqual(stored, expected)
        fullDigest.update(stored)
    }
    rowCount += chunk.rowCount
    chunk.releaseBorrowedContent?.()
    cacheDiagnostic = null
    process.stderr.write(`${dictionary}: ${rowCount}/${fixture.termRows} rows, cache ${cache.minimum}/${cache.count}\n`)
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
    complete = true
} catch (failure) {
    error = String(failure)
    throw failure
} finally {
    await sourcePipeline.dispose()
    await parser.disposeParallelTermBankParser()
    await Promise.all(terminations)
    await reader.close()
    const summary = {
        rows: rowCount,
        groups: groups.length,
        cacheRows: groups.reduce((n, group) => n + group.count, 0),
        nonzeroOriginGroups: groups.filter((group) => group.minimum > 0 && group.minimum !== null).length,
        nonzeroOriginRows: groups.filter((group) => group.minimum > 0 && group.minimum !== null).reduce((n, group) => n + group.count, 0),
        contiguousGroups: groups.filter((group) => group.contiguous).length,
        retainedBytes: groups.reduce((n, group) => n + group.retainedBytes, 0),
    }
    const sourceFiles = [
        'ext/js/dictionary/dictionary-database.js',
        'ext/js/dictionary/term-bank-wasm-parser.js',
        'ext/js/dictionary/term-bank-wasm-parser-worker.js',
        'ext/js/dictionary/term-bank-source-pipeline.js',
        'ext/js/dictionary/term-content-canonical-scan.js',
        'test/fixtures/parser-settlement/worker-node.mjs',
        'dev/data/dictionary-wasm/manifest.json',
        'package-lock.json',
    ]
    const sourceIdentities = Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [file, sha(await readFile(join(candidateRoot, file)))])))
    const report = {
        complete,
        error,
        node: process.version,
        v8: process.versions.v8,
        scriptSha256: sha(await readFile(fileURLToPath(import.meta.url))),
        sourceRoots: {parent: parentRoot, candidate: candidateRoot},
        sourceIdentities,
        fixtureLockPath,
        fixturePath: archivePath,
        fixtureVerification: {sha256: fixture.sha256, sizeBytes: archive.size, expectedTermRows: fixture.termRows, observedTermRows: rowCount},
        captureFormat: {version: 1, serialization: 'node:v8', compression: 'gzip', sourceOwnership: 'Restore captured shared source bytes into SharedArrayBuffer before replay; v8 deserialization does not establish parser ownership'},
        profileTimingCaveat: 'Instrumentation copies and hashes data inside the publication hook. These phase values are not performance observations.',
        dictionary,
        hardwareConcurrency: Number(cpus),
        deviceMemory: Number(memory),
        fixture,
        lockSha256: sha(lockBytes),
        parserWasmSha256: sha(wasm),
        canonicalWasmSha256: sha(canonicalWasm),
        databaseSourceSha256: sha(await readFile(join(candidateRoot, 'ext/js/dictionary/dictionary-database.js'))),
        scope: 'Actual plain JMdict source planner, native parser workers and canonical dedup resolver with deterministic virtual offsets and exact-byte storage. Complete per-row equality and component replay input only; compression, OPFS, UI and end-to-end timing are excluded. Virtual dictionary naming is a reference namespace, not a codec policy.',
        summary,
        encodedByteSha256: fullDigest.digest('hex'),
        captureCompression: {kind: 'gzip', files: groups.length, serializedBytes: groups.reduce((n, g) => n + g.serializedBytes, 0), compressedBytes: groups.reduce((n, g) => n + g.compressedBytes, 0)},
        groups,
        sourceGroups,
        profiles,
    }
    await writeFile(join(outputPath, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, {flag: 'wx'})
    console.log(JSON.stringify({complete, error, ...summary}))
}
