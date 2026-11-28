/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createReadStream, openAsBlob} from 'node:fs'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {Worker as ThreadWorker} from 'node:worker_threads'
import {BlobReader, Uint8ArrayWriter, ZipReader} from '@zip.js/zip.js'

const [baselineRoot, candidateRoot, cacheRoot, output, dictionary = 'jmdict', armMode = 'both'] = process.argv.slice(2).map((value, index) => index < 4 ? path.resolve(value) : value)
assert(baselineRoot && candidateRoot && cacheRoot && output)
assert(['baseline', 'candidate', 'both'].includes(armMode))
const localImport = (root, filename) => import(pathToFileURL(path.join(root, filename)))
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const fileHash = async (filename) => {
    const digest = createHash('sha256')
    for await (const bytes of createReadStream(filename)) { digest.update(bytes) }
    return digest.digest('hex')
}
function fingerprint(value) {
    const digest = createHash('sha256')
    const add = (item) => {
        if (ArrayBuffer.isView(item)) {
            digest.update(`view:${item.constructor.name}:${item.byteLength}:`)
            digest.update(new Uint8Array(item.buffer, item.byteOffset, item.byteLength))
        } else if (item instanceof ArrayBuffer || item instanceof SharedArrayBuffer) {
            digest.update(`buffer:${item.byteLength}:`)
            digest.update(new Uint8Array(item))
        } else if (item instanceof Map) {
            digest.update(`map:${item.size}:`)
            for (const [key, entry] of item) { add(key); add(entry) }
        } else if (Array.isArray(item)) {
            digest.update(`array:${item.length}:`)
            for (const entry of item) { add(entry) }
        } else if (item !== null && typeof item === 'object') {
            const keys = Object.keys(item).sort()
            digest.update(`object:${keys.length}:`)
            for (const key of keys) { add(key); add(item[key]) }
        } else {
            assert.notEqual(typeof item, 'function', 'Unexpected callable column')
            const scalar = Object.is(item, -0) ? '-0' : JSON.stringify(item)
            digest.update(`${typeof item}:${scalar?.length ?? 0}:${scalar}:`)
        }
    }
    add(value)
    return digest.digest('hex')
}
const lock = await readFile(path.join(candidateRoot, 'test/perf/dictionaries.lock.json'))
assert.deepEqual(lock, await readFile(path.join(baselineRoot, 'test/perf/dictionaries.lock.json')))
const fixture = JSON.parse(lock).dictionaries[dictionary]
assert(fixture)
const archivePath = path.join(cacheRoot, fixture.cacheFile)
assert.equal(await fileHash(archivePath), fixture.sha256)
const wasmBytes = await readFile(path.join(candidateRoot, 'ext/lib/term-bank-parser.wasm'))
assert.deepEqual(wasmBytes, await readFile(path.join(baselineRoot, 'ext/lib/term-bank-parser.wasm')))
const wasm = await WebAssembly.compile(wasmBytes)
const report = {schema: 1, complete: false,
    scope: 'Complete pinned-corpus correctness replay through the actual source planner and parser workers with a fixed two-CPU/eight-GiB navigator hint. Candidate-only mode reuses a verified retained control; both mode runs serial arms. Every unchanged chunk field is compared by typed structural SHA-256; only media transport is normalized to row/path columns, exact diagnostic arena, fallback rows and source order. Timing fields and the callback-local release function are excluded. No persistence, browser timing, or peak-memory claim.',
    acquisitionMode: armMode,
    node: process.version, v8: process.versions.v8, dictionary, fixture, lockSha256: sha256(lock),
    parserWasmSha256: sha256(wasmBytes), hardware: {hardwareConcurrency: 2, deviceMemory: 8},
    runnerSha256: await fileHash(new URL(import.meta.url)), workerBridgeSha256: await fileHash(new URL('worker.mjs', import.meta.url)),
    arms: {}, comparisons: []}
const checkpoint = async () => { await mkdir(path.dirname(output), {recursive: true}); await writeFile(output, JSON.stringify(report, null, 2) + '\n') }
const sourceFiles = ['ext/js/dictionary/dictionary-importer.js', 'ext/js/dictionary/term-bank-wasm-parser.js',
    'ext/js/dictionary/term-bank-wasm-parser-worker.js', 'ext/js/dictionary/term-bank-source-pipeline.js',
    'ext/js/dictionary/term-content-ownership.js', 'ext/js/dictionary/term-bank-experiments.js',
    'ext/js/dictionary/term-lookup-index-preparation.js', 'ext/js/dictionary/term-lookup-route.js']
Object.defineProperty(globalThis, 'navigator', {configurable: true, value: report.hardware})
const fetchOriginal = globalThis.fetch
globalThis.fetch = async (input, options) => String(input).startsWith('file:') ? new Response(await readFile(new URL(input))) : fetchOriginal(input, options)

function normalizeMedia(chunk, importer) {
    let columns = chunk.projectedMedia
    const fallback = []
    const order = []
    if (columns === undefined) {
        const rowIndexes = []
        const pathEnds = []
        const paths = []
        for (const entry of chunk.mediaRows) {
            const {index, imagePaths} = entry
            if (imagePaths === undefined) { fallback.push(entry); order.push(['fallback', index]); continue }
            rowIndexes.push(index)
            paths.push(...imagePaths)
            pathEnds.push(paths.length)
            order.push(['projected', index])
        }
        columns = rowIndexes.length ? {rowIndexes: Uint32Array.from(rowIndexes), pathEnds: Uint32Array.from(pathEnds), paths,
            diagnosticKeys: importer.prototype._createMediaReferenceDiagnostics(chunk)} : null
    } else {
        let projectedIndex = 0
        for (const entry of chunk.mediaRows) {
            assert.equal(entry.imagePaths, undefined, 'A row occurs in both projected and fallback transport')
            while (projectedIndex < columns.rowIndexes.length && columns.rowIndexes[projectedIndex] < entry.index) {
                order.push(['projected', columns.rowIndexes[projectedIndex++]])
            }
            fallback.push(entry)
            order.push(['fallback', entry.index])
        }
        while (projectedIndex < columns.rowIndexes.length) { order.push(['projected', columns.rowIndexes[projectedIndex++]]) }
    }
    for (let i = 1; i < order.length; ++i) { assert(order[i][1] > order[i - 1][1], 'Media source order is not strictly increasing') }
    return {columns, fallback, order}
}
function summarize(chunk, importer, observation, source) {
    const columns = {}
    for (const key of Object.keys(chunk).sort()) {
        if (['mediaRows', 'projectedMedia', 'releaseBorrowedContent', 'preparedLookupIndexEncodeMs'].includes(key)) { continue }
        columns[key] = fingerprint(chunk[key])
    }
    const media = normalizeMedia(chunk, importer)
    const projectedRows = media.columns?.rowIndexes.length ?? 0
    const counts = {rows: chunk.rowCount, projectedRows, fallbackRows: media.fallback.length,
        paths: media.columns?.paths.length ?? 0, diagnosticBytes: media.columns?.diagnosticKeys?.bytes.byteLength ?? 0,
        diagnosticSpanBytes: media.columns?.diagnosticKeys?.spans.byteLength ?? 0,
        transmittedMediaRowObjects: chunk.mediaRows.length * 2,
        transmittedPerRowPathArrays: chunk.mediaRows.filter((entry) => entry.imagePaths !== undefined).length,
        transmittedProjectedRowColumnBytes: (chunk.projectedMedia?.rowIndexes.byteLength ?? 0) + (chunk.projectedMedia?.pathEnds.byteLength ?? 0)}
    return {source, columns, media: fingerprint(media), counts, observation}
}

async function runArm(arm, root) {
    const parser = await localImport(root, 'ext/js/dictionary/term-bank-wasm-parser.js')
    const pipelineModule = await localImport(root, 'ext/js/dictionary/term-bank-source-pipeline.js')
    const {DictionaryImporter} = await localImport(root, 'ext/js/dictionary/dictionary-importer.js')
    parser.setTermBankWasmModule(wasm)
    const terminations = []
    const observations = new WeakMap()
    const proofs = []
    const sourceRequests = new Map()
    let nextWorker = 0
    class BrowserWorker extends EventTarget {
        constructor(url) {
            super()
            this.id = nextWorker++
            this.worker = new ThreadWorker(new URL('worker.mjs', import.meta.url), {workerData: {url: url.href}})
            this.waitingProofs = new Map()
            this.worker.on('message', (data) => {
                if (data.type === 'oracle-transfer-proof') {
                    assert.equal(data.projectedBuffersDetached, true)
                    this.waitingProofs.get(data.id)?.()
                    this.waitingProofs.delete(data.id)
                    return
                }
                if (data.type === 'result' && data.chunk) {
                    observations.set(data.chunk, {observation: data.oracleObservation, source: sourceRequests.get(`${this.id}:${data.id}`)})
                }
                this.dispatchEvent(new MessageEvent('message', {data}))
            })
            this.worker.on('error', (error) => {
                const event = new Event('error')
                Object.defineProperty(event, 'message', {value: error.message})
                this.dispatchEvent(event)
            })
            this.worker.on('messageerror', () => this.dispatchEvent(new Event('messageerror')))
        }
        postMessage(data, transfer) {
            if (data.type === 'parse') {
                sourceRequests.set(`${this.id}:${data.id}`, data.sourceMetadata?.map(({filename, uncompressedSize, signature}) => ({filename, uncompressedSize, signature})) ?? data.sourceBuffers.map((buffer) => ({bytes: buffer.byteLength})))
                proofs.push(new Promise((resolve) => this.waitingProofs.set(data.id, resolve)))
            }
            this.worker.postMessage(data, transfer)
        }
        terminate() { terminations.push(this.worker.terminate()) }
    }
    globalThis.Worker = BrowserWorker
    const archive = await openAsBlob(archivePath)
    assert.equal(archive.size, fixture.sizeBytes)
    const reader = new ZipReader(new BlobReader(archive), {useWebWorkers: false})
    const entries = await reader.getEntries()
    const termFiles = entries.filter(({filename}) => /^term_bank_\d+\.json$/.test(filename)).sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)))
    const rawReader = new pipelineModule.RawZipPayloadReader(archive)
    const sourcePipeline = new pipelineModule.TermBankSourcePipeline({termFiles, enabled: true,
        read: (file) => file.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true}),
        readCompressed: (file, signal) => rawReader.read(file, signal)})
    const media = fixture.mediaFiles > 0
    const options = {emitTermByteLists: false, computeContentHashes: true, emitContentSlab: true,
        emitTokenBinaryContent: true, mediaHintFastScan: media, projectImagePaths: media,
        validateGlossaryTypes: true, prepareLookupIndexes: true, prepareLookupRoute: true, maxPendingChunks: 2}
    const result = {root, runnerSha256: report.runnerSha256, workerBridgeSha256: report.workerBridgeSha256, sourceIdentity: Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [file, await fileHash(path.join(root, file))]))),
        options, workerCount: parser.getParallelTermBankParserWorkerCount(options), groups: [], totals: {}}
    if (arm === 'candidate') { result.sourceIdentity['ext/js/dictionary/dictionary-media-diagnostics.js'] = await fileHash(path.join(root, 'ext/js/dictionary/dictionary-media-diagnostics.js')) }
    report.arms[arm] = result
    const consume = (chunk) => {
        const captured = observations.get(chunk)
        assert(captured, 'Result bypassed actual worker transport')
        const group = summarize(chunk, DictionaryImporter, captured.observation, captured.source)
        result.groups.push(group)
        for (const [key, count] of Object.entries(group.counts)) { result.totals[key] = (result.totals[key] ?? 0) + count }
        if (arm === 'candidate') {
            const baseline = report.arms.baseline.groups[result.groups.length - 1]
            assert(baseline, 'Candidate emitted extra group')
            assert.deepEqual(group.source, baseline.source, 'Source planner grouping changed')
            assert.deepEqual(group.columns, baseline.columns, 'Unchanged column differs')
            assert.equal(group.media, baseline.media, 'Normalized media or fallback row differs')
            assert.deepEqual(group.observation.native, baseline.observation.native, 'Native projection changed')
            for (const key of ['borrowsWorkerMemory', 'ownsContentBytes']) { assert.equal(group.observation[key], baseline.observation[key], key) }
        }
        if (result.groups.length % 10 === 0) { process.stderr.write(`${dictionary} ${arm}: ${result.groups.length} groups, ${result.totals.rows} rows\n`) }
    }
    try {
        for (let start = 0; start < termFiles.length;) {
            const compressed = sourcePipeline.createCompressedImportRunPlan(start)
            if (compressed !== null) {
                assert.equal(await parser.parseTermBankWithWasmColumnChunksParallelCompressedLazy(compressed.loaders, compressed.estimatedByteLengths, 3, consume, options), true)
                sourcePipeline.releaseBatch(compressed.files)
                start += compressed.files.length
            } else {
                const files = sourcePipeline.getBatch(start)
                const batch = await sourcePipeline.readBatch(files)
                assert(batch?.promises, 'Expected production deferred or compressed source plan')
                assert.equal(await parser.parseTermBankWithWasmColumnChunksParallelDeferred(batch.promises, batch.estimatedByteLengths, 3, consume, options), true)
                sourcePipeline.releaseBatch(files)
                start += files.length
            }
        }
        assert.equal(result.totals.rows, fixture.termRows)
        await Promise.all(proofs)
        result.transferProofsPassed = true
        if (media && result.totals.projectedRows > 0) {
            assert(result.groups.some(({observation}) => observation.native.calls > 0), 'Native projection was not exercised')
        }
    } finally {
        await sourcePipeline.dispose()
        await parser.disposeParallelTermBankParser()
        await Promise.all(terminations)
        await reader.close()
    }
    await checkpoint()
}
if (armMode === 'candidate') {
    const previous = JSON.parse(await readFile(output, 'utf8'))
    assert.equal(previous.dictionary, dictionary)
    assert.equal(previous.fixture.sha256, fixture.sha256)
    assert.equal(previous.parserWasmSha256, report.parserWasmSha256)
    assert.equal(previous.lockSha256, report.lockSha256)
    assert.equal(previous.arms.baseline.totals.rows, fixture.termRows)
    for (const [filename, digest] of Object.entries(previous.arms.baseline.sourceIdentity)) {
        assert.equal(await fileHash(path.join(baselineRoot, filename)), digest, 'Preserved baseline source changed')
    }
    report.arms.baseline = {...previous.arms.baseline,
        runnerSha256: previous.arms.baseline.runnerSha256 ?? previous.runnerSha256,
        workerBridgeSha256: previous.arms.baseline.workerBridgeSha256 ?? previous.workerBridgeSha256}
    report.interruptions = previous.interruptions ?? []
    report.resumedCandidateInFreshProcess = true
} else {
    await runArm('baseline', baselineRoot)
}
if (armMode !== 'baseline') {
    await runArm('candidate', candidateRoot)
    assert.equal(report.arms.candidate.groups.length, report.arms.baseline.groups.length)
    report.complete = true
    report.comparisons.push({groupsEqual: true, allUnchangedColumnsEqual: true, exactNormalizedMediaEqual: true,
        nativeProjectionCountsEqual: true, ownershipFlagsEqual: true, transferCanariesPassed: true})
}
await checkpoint()
console.log(JSON.stringify({output, dictionary, complete: report.complete,
    baseline: report.arms.baseline.totals, candidate: report.arms.candidate?.totals ?? null}))
