import {readFile, writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {pathToFileURL} from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'
import {ZipReader, Uint8ArrayReader, Uint8ArrayWriter} from '@zip.js/zip.js'

const [dictionary, sourceRoot, output] = process.argv.slice(2)
const baselineRoot = '/workspace/scratch/71149a79699f/manabitan'
const locks = JSON.parse(await readFile(path.join(baselineRoot, 'test/perf/dictionaries.lock.json'), 'utf8')).dictionaries
locks.vndb = {
    cacheFile: '/workspace/scratch/fcfffdc555c8/fixtures/vndb_characters_by_bee.zip',
    sha256: 'da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792',
    termRows: 6648310,
}
const spec = locks[dictionary]
assert(spec)
const hash = (value) => createHash('sha256').update(value).digest('hex')
const archivePath = dictionary === 'vndb' ? spec.cacheFile : path.join(baselineRoot, 'builds/e2e-dictionary-cache', spec.cacheFile)
const archive = await readFile(archivePath)
assert.equal(hash(archive), spec.sha256)
const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(archive.buffer, archive.byteOffset, archive.byteLength)))
const entries = (await reader.getEntries()).filter((entry) => /^term_bank_\d+\.json$/.test(entry.filename))
    .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)))
const byFilename = new Map(entries.map((entry) => [entry.filename, entry]))
const parserPath = path.join(sourceRoot, 'ext/js/dictionary/term-bank-wasm-parser.js')
const parser = await import(pathToFileURL(parserPath).href)
const {DictionaryDatabase} = await import(pathToFileURL(path.join(sourceRoot, 'ext/js/dictionary/dictionary-database.js')).href)
const {NativeCanonicalScanner} = await import(pathToFileURL(path.join(sourceRoot, 'ext/js/dictionary/term-content-canonical-scan.js')).href)
const wasm = await readFile(path.join(sourceRoot, 'ext/lib/term-bank-parser.wasm'))
const canonicalModule = await WebAssembly.compile(await readFile(path.join(sourceRoot, 'ext/lib/term-content-canonical-scan-v1.wasm')))
parser.setTermBankWasmModule(await WebAssembly.compile(wasm))

// Exercise the unmodified planner without running five parser heaps at once.
// The shim records planned jobs and acknowledges empty results; actual corpus
// bytes are then parsed sequentially below. Its synthetic profiles are unused.
const jobs = []
class PlanningWorker extends EventTarget {
    postMessage(message) {
        if (message.type === 'initialize') {
            queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {data: {type: 'ready'}})))
            return
        }
        assert.equal(message.type, 'parse')
        jobs.push({id: message.id, metadata: message.sourceMetadata, options: message.options})
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {data: {
            type: 'result', id: message.id, rowCount: 0, resultSentEpochMs: Date.now(),
            chunk: null, profile: {rowCount: 0},
        }})))
    }
    terminate() {}
}
const previousWorker = globalThis.Worker
globalThis.Worker = PlanningWorker
const media = dictionary !== 'jmdict'
const options = {
    emitTermByteLists: false,
    computeContentHashes: true,
    emitContentSlab: true,
    emitTokenBinaryContent: true,
    mediaHintFastScan: media,
    projectImagePaths: media,
    validateGlossaryTypes: true,
    prepareLookupIndexes: true,
}
const plannerWorkerCount = parser.getParallelTermBankParserWorkerCount(options)
try {
    assert.equal(await parser.parseTermBankWithWasmColumnChunksParallelCompressedLazy(
        entries.map((entry) => async () => ({
            bytes: new Uint8Array(0), compressionMethod: 0, compressedSize: 0,
            uncompressedSize: entry.uncompressedSize, signature: 0, filename: entry.filename,
        })),
        entries.map((entry) => entry.uncompressedSize),
        3,
        () => { throw new Error('Planning shim must emit no content') },
        options,
    ), true)
} finally {
    await parser.disposeParallelTermBankParser()
    globalThis.Worker = previousWorker
}
jobs.sort((a, b) => a.id - b.id)
assert.deepEqual(jobs.flatMap((job) => job.metadata.map(({filename}) => filename)), entries.map(({filename}) => filename))

const scratchProperties = ['pendingEpochs', 'pendingIndexes', 'pendingSpanOffsetsScratch', 'pendingSpanLengthsScratch']
const scratchBytes = (plan) => Object.fromEntries(scratchProperties.map((key) => [key, plan[key]?.byteLength ?? 0]))
const byteTotal = (counts) => Object.values(counts).reduce((sum, value) => sum + value, 0)
const records = []
function addDigest(digest, value) {
    if (ArrayBuffer.isView(value)) {
        digest.update(value.constructor.name)
        digest.update(`${value.byteLength}:`)
        digest.update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
    } else if (value instanceof Map) {
        for (const [key, item] of value) {
            digest.update(key)
            addDigest(digest, item)
        }
    } else if (Array.isArray(value)) {
        for (const item of value) { addDigest(digest, item) }
    } else if (value && typeof value === 'object') {
        for (const key of Object.keys(value).sort()) {
            if (key.endsWith('Ms') || typeof value[key] === 'function') { continue }
            digest.update(key)
            addDigest(digest, value[key])
        }
    } else {
        digest.update(JSON.stringify(value) ?? 'undefined')
    }
}
try {
    for (const job of jobs) {
        const sources = []
        for (const {filename} of job.metadata) {
            sources.push(await byFilename.get(filename).getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true}))
        }
        await parser.parseTermBankWithWasmColumnChunks(sources, 3, async (chunk) => {
            const before = scratchBytes(chunk.contentDedupPlan)
            const digest = createHash('sha256')
            const {contentBytesBuffer, contentBytesBaseOffset, contentBytesLength, contentDedupPlan, ...fields} = chunk
            addDigest(digest, fields)
            addDigest(digest, contentBytesBuffer.subarray(contentBytesBaseOffset, contentBytesBaseOffset + contentBytesLength))
            addDigest(digest, {uniqueCount: contentDedupPlan.uniqueCount, sourceRowCount: contentDedupPlan.sourceRowCount,
                uniqueRowIndexes: contentDedupPlan.uniqueRowIndexes, uniqueSignatures: contentDedupPlan.uniqueSignatures})
            const database = new DictionaryDatabase()
            const scanner = new NativeCanonicalScanner({loadModule: async () => canonicalModule})
            Reflect.set(database, '_nativeCanonicalScanner', scanner)
            const result = await Reflect.get(database, '_resolveArtifactTermContentDedup').call(database, {...chunk, uniformContentDictName: 'raw-v6'})
            const after = scratchBytes(contentDedupPlan)
            const resolvedDigest = createHash('sha256')
            addDigest(resolvedDigest, {
                contentOffsets: result.contentOffsets, contentLengths: result.contentLengths,
                resolvedContentDictNames: result.resolvedContentDictNames,
                pendingContentHash1s: result.pendingContentHash1s, pendingContentHash2s: result.pendingContentHash2s,
                pendingContentCount: result.pendingContentCount, pendingPlanUniqueIndexes: result.pendingPlanUniqueIndexes,
                pendingPlanUniqueStart: result.pendingPlanUniqueStart,
                pendingSpanOffsets: result.pendingContentSpans?.offsets.subarray(0, result.pendingContentCount),
                pendingSpanLengths: result.pendingContentSpans?.lengths.subarray(0, result.pendingContentCount),
            })
            records.push({group: job.id, banks: job.metadata.map(({filename}) => filename),
                rowCount: chunk.rowCount, uniqueCount: contentDedupPlan.uniqueCount,
                parserScratchBytes: before, canonicalScratchBytes: after,
                parserDigest: digest.digest('hex'), canonicalDigest: resolvedDigest.digest('hex'),
                nativeCalls: scanner.stats.calls, nativeFallbacks: scanner.stats.fallbacks})
        }, 2048, {...job.options, singleChunk: true, maxPendingChunks: 1})
        globalThis.gc?.()
        if (job.id % 20 === 0 || job.id === jobs.length) { process.stderr.write(`${dictionary}: ${job.id}/${jobs.length} groups\n`) }
    }
} finally {
    await reader.close()
}
assert.equal(records.reduce((sum, item) => sum + item.rowCount, 0), spec.termRows)
const receipt = {
    description: 'Deterministic scratch allocation receipt; production group planner with metadata-only worker shim, then real full-corpus native parser and isolated canonical resolver, sequential. Not import timing or a persistent storage benchmark.',
    sourceRoot, dictionary, archiveSha256: spec.sha256, archiveBytes: archive.byteLength,
    node: process.version, hardwareConcurrency: navigator.hardwareConcurrency, plannerWorkerCount,
    sourceBytes: entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0),
    sourceBanks: entries.length, groups: records.length, rows: spec.termRows,
    sourceHashes: Object.fromEntries(await Promise.all(['ext/js/dictionary/term-bank-wasm-parser.js', 'ext/js/dictionary/dictionary-database.js', 'ext/js/dictionary/term-content-canonical-scan.js'].map(async (file) => [file, hash(await readFile(path.join(sourceRoot, file)))]))),
    wasmSha256: hash(wasm),
    parserScratchBytes: records.reduce((sum, item) => sum + byteTotal(item.parserScratchBytes), 0),
    maximumParserScratchBytesPerGroup: Math.max(...records.map((item) => byteTotal(item.parserScratchBytes))),
    canonicalScratchBytes: records.reduce((sum, item) => sum + byteTotal(item.canonicalScratchBytes), 0),
    maximumCanonicalScratchBytesPerGroup: Math.max(...records.map((item) => byteTotal(item.canonicalScratchBytes))),
    parserDigest: hash(records.map(({parserDigest}) => parserDigest).join('\n')),
    canonicalDigest: hash(records.map(({canonicalDigest}) => canonicalDigest).join('\n')),
    records,
}
await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`)
console.log(JSON.stringify({...receipt, records: undefined}))
