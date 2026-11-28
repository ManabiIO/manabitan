import {readFile, writeFile} from 'node:fs/promises'
import {createReadStream, openAsBlob} from 'node:fs'
import {createHash} from 'node:crypto'
import {Worker as NodeWorker} from 'node:worker_threads'
import {pathToFileURL} from 'node:url'
import path from 'node:path'

const [sourceRoot, dictionary, hardwareText, outputPath, flagsText = '{}', cachePath] = process.argv.slice(2)
if (!sourceRoot || !dictionary || !hardwareText || !outputPath) throw new Error('sourceRoot dictionary hardwareConcurrency outputPath [flags]')
const hardwareConcurrency = Number(hardwareText)
const flags = JSON.parse(flagsText)
const cacheRoot = cachePath ?? path.join(sourceRoot, 'builds/e2e-dictionary-cache')
const sourceURL = (file) => pathToFileURL(path.join(sourceRoot, file))
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const {ZipReader, BlobReader, Uint8ArrayWriter} = await import(sourceURL('node_modules/@zip.js/zip.js/index.js'))
const {RawZipPayloadReader, TermBankSourcePipeline} = await import(sourceURL('ext/js/dictionary/term-bank-source-pipeline.js'))
const parser = await import(sourceURL('ext/js/dictionary/term-bank-wasm-parser.js'))
const {MIN_EXACT_LOOKUP_SOURCE_BYTES} = await import(sourceURL('ext/js/dictionary/term-lookup-route.js'))
const lockBytes = await readFile(sourceURL('test/perf/dictionaries.lock.json'))
const locked = JSON.parse(lockBytes).dictionaries[dictionary]
if (!locked) throw new Error('Unknown dictionary')
const archivePath = path.join(cacheRoot, locked.cacheFile)
const archive = await openAsBlob(archivePath)
const archiveHash = createHash('sha256')
for await (const chunk of createReadStream(archivePath)) archiveHash.update(chunk)
if (archive.size !== locked.sizeBytes || archiveHash.digest('hex') !== locked.sha256) throw new Error('Archive identity mismatch')
const wasmBytes = await readFile(sourceURL('ext/lib/term-bank-parser.wasm'))
parser.setTermBankWasmModule(await WebAssembly.compile(wasmBytes))
Object.defineProperty(globalThis, 'navigator', {value: {hardwareConcurrency, deviceMemory: 8}, configurable: true})

const rss = {maxBytes: process.memoryUsage().rss}
const memorySampler = setInterval(() => { rss.maxBytes = Math.max(rss.maxBytes, process.memoryUsage().rss) }, 100)
const workerReports = []
const workerClosures = []
class BrowserWorker {
    constructor(url) {
        this.listeners = new Map()
        this.requests = new Map()
        const bootstrap = `
            import {parentPort} from 'node:worker_threads'
            const nativeInstantiate = WebAssembly.instantiate.bind(WebAssembly)
            let allocations = []
            let calls = []
            WebAssembly.instantiate = async (...args) => {
                const instance = await nativeInstantiate(...args)
                if (!(instance instanceof WebAssembly.Instance)) throw new Error('Expected precompiled module')
                const exports = instance.exports
                const wrapped = {...exports,
                    wasm_alloc(size) {
                        const pointer = exports.wasm_alloc(size)
                        allocations.push({pointer, size})
                        return pointer
                    },
                    encode_term_lookup_index(...args) {
                        const status = exports.encode_term_lookup_index(...args)
                        const allocation = allocations.find(({pointer}) => pointer === args[15])
                        calls.push({rows: args[10], keys: args[5], output: args[11], outputCapacity: args[12],
                            slots: args[15], slotBytes: args[16] * 2,
                            aliased: args[15] >= args[11] && args[15] + args[16] * 2 <= args[11] + args[12],
                            slotsPastEncodedKeyPrefix: args[15] >= args[11] + 48 + ((args[1] + 3) & ~3),
                            slotAlignment: args[15] % 4,
                            allocationStartingAtSlotBytes: allocation?.size ?? null,
                            shared: exports.memory.buffer instanceof SharedArrayBuffer, status})
                        return status
                    }
                }
                return {exports: wrapped}
            }
            globalThis.self = {
                addEventListener: (_, fn) => parentPort.on('message', data => {
                    if (data.type === 'parse') { allocations = []; calls = [] }
                    fn({data})
                }),
                postMessage: (data, transfer) => {
                    if (data.type === 'result') {
                        data.sequenceScratchProof = {calls, requestedWasmAllocationBytes: allocations.reduce((sum, item) => sum + item.size, 0)}
                    }
                    parentPort.postMessage(data, transfer)
                }
            }
            await import(${JSON.stringify(url.href)})
        `
        this.worker = new NodeWorker(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`))
        this.worker.on('message', (data) => {
            if (data.type === 'result') {
                const request = this.requests.get(data.id)
                const profile = data.profile
                workerReports.push({id: data.id, rows: data.rowCount,
                    firstSource: request.sourceMetadata[0].filename,
                    lastSource: request.sourceMetadata.at(-1).filename,
                    sourceCount: request.sourceMetadata.length,
                    fusedParseAttempts: profile.fusedParseAttempts,
                    fusedParseFallbacks: profile.fusedParseFallbacks,
                    sourceUncompressedBytes: profile.sourceUncompressedBytes,
                    mediaRows: data.chunk?.mediaRows?.length ?? 0,
                    uniqueContents: data.chunk?.contentDedupPlan?.uniqueCount ?? 0,
                    nativeScratchReusedBytes: profile.nativeLookupScratchReusedBytes,
                    nativeScratchReuseMisses: profile.nativeLookupScratchReuseMisses,
                    nativeSegmentedLookupSegments: profile.nativeSegmentedLookupSegments,
                    maxWasmHeapBytes: profile.maxWasmHeapBytes,
                    ...data.sequenceScratchProof})
            }
            if (data.type === 'result' || data.type === 'parse-error') this.requests.delete(data.id)
            this.emit('message', {data})
        })
        this.worker.on('error', (error) => this.emit('error', {message: error.message}))
        this.worker.on('messageerror', (error) => this.emit('messageerror', {message: String(error)}))
    }
    addEventListener(type, callback) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set())
        this.listeners.get(type).add(callback)
    }
    removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback) }
    emit(type, event) { for (const callback of this.listeners.get(type) ?? []) callback(event) }
    postMessage(data, transfer) {
        if (data.type === 'parse') this.requests.set(data.id, data)
        this.worker.postMessage(data, transfer)
    }
    terminate() { workerClosures.push(this.worker.terminate()) }
}
globalThis.Worker = BrowserWorker

const reader = new ZipReader(new BlobReader(archive))
const entries = []
for await (const entry of reader.getEntriesGenerator()) {
    if (/^term_bank_\d+\.json$/.test(entry.filename)) entries.push(entry)
}
entries.sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)))
const raw = new RawZipPayloadReader(archive)
const pipeline = new TermBankSourcePipeline({termFiles: entries, enabled: true, deviceMemory: 8,
    read: async (entry, signal) => entry.getData(new Uint8ArrayWriter(), {signal, checkSignature: true, useWebWorkers: false}),
    readCompressed: (entry, signal) => raw.read(entry, signal, true)})
const run = pipeline.createCompressedImportRunPlan(0)
if (!run || run.files.length !== entries.length) throw new Error('Expected complete production compressed run')
const hasMedia = locked.mediaFiles > 0
const totalSourceBytes = run.estimatedByteLengths.reduce((a, b) => a + b, 0)
const options = {...flags,
    copyContentBytes: false, includeContentMetadata: true, initialContentBytesPerRow: 48,
    minimalDecode: true, reuseExpressionForReadingDecode: true, preallocateChunkRows: true,
    skipTagRuleDecode: hasMedia, lazyGlossaryDecode: true, mediaHintFastScan: hasMedia,
    projectImagePaths: hasMedia, validateGlossaryTypes: true, computeContentHashes: true,
    emitContentSlab: true, emitTokenBinaryContent: true, emitTermByteLists: false,
    prepareLookupIndexes: true, prepareLookupRoute: totalSourceBytes >= MIN_EXACT_LOOKUP_SOURCE_BYTES,
    maxPendingChunks: 2}
const groups = []
const digest = createHash('sha256')
let totalRows = 0
let totalIndexBytes = 0
let totalCanonicalBytes = 0
let totalMediaRows = 0
let largestMediaGroup = 0
const fullDigest = createHash('sha256')
const mediaDigest = createHash('sha256')
const addValue = (hash, value) => {
    if (value === null || value === undefined) { hash.update(String(value) + ';'); return }
    if (ArrayBuffer.isView(value)) {
        hash.update(`view:${value.constructor.name}:${value.byteLength}:`)
        hash.update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
        return
    }
    if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
        hash.update(`buffer:${value.byteLength}:`)
        hash.update(new Uint8Array(value))
        return
    }
    if (typeof value === 'number') { hash.update(`number:${Object.is(value, -0) ? '-0' : String(value)};`); return }
    if (typeof value === 'string' || typeof value === 'boolean') { hash.update(`${typeof value}:${JSON.stringify(value)};`); return }
    if (Array.isArray(value)) {
        hash.update(`array:${value.length}:[`)
        for (const item of value) addValue(hash, item)
        hash.update(']')
        return
    }
    if (value instanceof Map) {
        hash.update(`map:${value.size}:[`)
        for (const [key, item] of value) { addValue(hash, key); addValue(hash, item) }
        hash.update(']')
        return
    }
    if (typeof value === 'object') {
        hash.update('object:{')
        for (const key of Object.keys(value).sort()) {
            if (key === 'releaseBorrowedContent' || key === 'preparedLookupIndexEncodeMs') continue
            addValue(hash, key)
            addValue(hash, value[key])
        }
        hash.update('}')
        return
    }
    throw new Error(`Unexpected oracle value ${typeof value}`)
}
const addView = (hash, view) => {
    if (!ArrayBuffer.isView(view)) throw new Error('Missing digest column')
    hash.update(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
}
try {
    const success = await parser.parseTermBankWithWasmColumnChunksParallelCompressedLazy(
        run.loaders, run.estimatedByteLengths, 3, (chunk, progress) => {
            const completeHash = createHash('sha256')
            const mediaHash = createHash('sha256')
            addValue(completeHash, chunk)
            addValue(mediaHash, chunk.mediaRows)
            const completeValue = completeHash.digest('hex')
            const mediaValue = mediaHash.digest('hex')
            fullDigest.update(`${progress.chunkIndex}:${chunk.rowCount}:${completeValue}\n`)
            mediaDigest.update(`${progress.chunkIndex}:${chunk.rowCount}:${mediaValue}\n`)
            totalMediaRows += chunk.mediaRows.length
            largestMediaGroup = Math.max(largestMediaGroup, chunk.mediaRows.length)
            const hash = createHash('sha256')
            if (!(chunk.preparedLookupIndexes instanceof Map)) throw new Error('Missing prepared indexes')
            for (const [key, entry] of chunk.preparedLookupIndexes) {
                hash.update(key)
                addView(hash, entry.bytes)
                totalIndexBytes += entry.bytes.length
                for (const value of Object.values(entry.preinternedPlan)) {
                    if (ArrayBuffer.isView(value)) addView(hash, value)
                }
                if (entry.routeFilter) addView(hash, entry.routeFilter)
            }
            for (const name of ['readingEqualsExpressionList', 'scoreList', 'sequenceList', 'contentMetaList', 'contentUniqueIndexList']) {
                if (chunk[name] !== null) addView(hash, chunk[name])
            }
            const bytes = chunk.contentBytesBuffer.subarray(chunk.contentBytesBaseOffset, chunk.contentBytesBaseOffset + chunk.contentBytesLength)
            if (bytes.length !== chunk.contentBytesLength) throw new Error('Invalid canonical content span')
            addView(hash, bytes)
            totalCanonicalBytes += bytes.length
            totalRows += chunk.rowCount
            const digestValue = hash.digest('hex')
            digest.update(`${progress.chunkIndex}:${chunk.rowCount}:${digestValue}\n`)
            groups.push({group: progress.chunkIndex, rows: chunk.rowCount, indexCount: chunk.preparedLookupIndexes.size,
                canonicalBytes: bytes.length, mediaRows: chunk.mediaRows.length, mediaDigest: mediaValue, fullDigest: completeValue, digest: digestValue})
            if (groups.length % 20 === 0) console.log(JSON.stringify({dictionary, groups: groups.length, totalRows, rssBytes: process.memoryUsage().rss}))
        }, options)
    if (!success || totalRows !== locked.termRows) throw new Error(`Incomplete replay ${success} ${totalRows}/${locked.termRows}`)
} finally {
    await parser.disposeParallelTermBankParser()
    await pipeline.dispose()
    await reader.close()
    await Promise.all(workerClosures)
    clearInterval(memorySampler)
}
workerReports.sort((a, b) => a.id - b.id)
const sourceHashes = {}
for (const file of ['ext/js/dictionary/term-bank-wasm-parser.js', 'ext/js/dictionary/term-lookup-index.js', 'ext/js/dictionary/term-bank-experiments.js', 'ext/js/dictionary/term-bank-wasm-parser-worker.js', 'ext/js/dictionary/wasm/term-bank-parser.c']) {
    sourceHashes[file] = sha256(await readFile(sourceURL(file)))
}
const sum = (project) => workerReports.reduce((total, group) => total + project(group), 0)
const uniqueSlots = (group) => [...new Map(group.calls.map((call) => [call.slots, call])).values()]
const summary = {
    nativeCalls: sum((group) => group.calls.length),
    nativeLookupRows: sum((group) => group.calls.reduce((total, call) => total + call.rows, 0)),
    separateSequenceScratchReservationBytes: sum((group) => uniqueSlots(group).reduce((total, call) => total + (call.aliased ? 0 : call.slotBytes), 0)),
    avoidedSequenceScratchReservationBytes: sum((group) => uniqueSlots(group).reduce((total, call) => total + (call.aliased ? call.slotBytes : 0), 0)),
    separateSequenceScratchAllocationBytes: sum((group) => group.nativeScratchReusedBytes > 0 ? 0 : uniqueSlots(group).reduce((total, call) => total + (call.aliased ? 0 : call.allocationStartingAtSlotBytes ?? 0), 0)),
    requestedWasmAllocationBytes: sum((group) => group.requestedWasmAllocationBytes),
    nativeScratchReusedBytes: sum((group) => group.nativeScratchReusedBytes ?? 0),
    nativeScratchReuseMisses: sum((group) => group.nativeScratchReuseMisses ?? 0),
}
const report = {dictionary, sourceRoot, node: process.version, hardwareConcurrency, deviceMemory: 8,
    boundary: 'Production compressed source planning and parser workers through owned lookup construction; excludes global canonical dedup, Zstd, storage, media reads and UI. Instrumented correctness/resource accounting only; no timing claim.',
    runnerSha256: sha256(await readFile(new URL(import.meta.url))), fixture: locked, lockSha256: sha256(lockBytes), wasmSha256: sha256(wasmBytes), sourceHashes,
    options, totalSourceBytes, totalRows, totalIndexBytes, totalCanonicalBytes, totalMediaRows, largestMediaGroup, maxRssBytes: rss.maxBytes,
    oracle: 'Full recursive value hash of all chunk fields including every media row, index and byte view; excludes only preparedLookupIndexEncodeMs and releaseBorrowedContent. Original byte digest retained separately.',
    fullDigest: fullDigest.digest('hex'), mediaDigest: mediaDigest.digest('hex'), digest: digest.digest('hex'), summary, groups, workerReports}
await writeFile(outputPath, JSON.stringify(report, null, 2))
console.log(JSON.stringify({dictionary, sourceRoot, totalRows, groups: groups.length, totalMediaRows, largestMediaGroup, fullDigest: report.fullDigest, mediaDigest: report.mediaDigest, digest: report.digest, maxRssBytes: rss.maxBytes, ...summary}))
