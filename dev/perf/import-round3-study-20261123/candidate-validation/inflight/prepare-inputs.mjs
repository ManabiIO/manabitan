import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {serialize} from 'node:v8'
import {createHash} from 'node:crypto'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {createRequire} from 'node:module'
import path from 'node:path'
import assert from 'node:assert/strict'
// Usage: node --expose-gc prepare-inputs.mjs dictionary sourceRoot output fixtureRoot
const [dictionary, sourceRootArgument, outputArgument, fixtureRootArgument, ...extra] = process.argv.slice(2)
assert(['jmdict', 'jitendex', 'vndb'].includes(dictionary), 'Choose jmdict, jitendex, or vndb')
assert(sourceRootArgument && outputArgument && fixtureRootArgument && extra.length === 0,
    'Usage: prepare-inputs.mjs dictionary sourceRoot output fixtureRoot')
const sourceRoot = path.resolve(sourceRootArgument)
const output = path.resolve(outputArgument)
const fixtureRoot = path.resolve(fixtureRootArgument)
const fixtureLockBytes = await readFile(path.join(fixtureRoot, 'test/perf/dictionaries.lock.json'))
const locks = JSON.parse(fixtureLockBytes.toString('utf8')).dictionaries
const spec = locks[dictionary]
assert(spec, `Pinned fixture lock is missing ${dictionary}; use the tooling commit in README.md`)
const hash = (value) => createHash('sha256').update(value).digest('hex')
const archivePath = path.join(fixtureRoot, 'builds/e2e-dictionary-cache', spec.cacheFile)

// Resolve the same ESM zip.js entry from the fixture checkout, so this evidence
// package can live outside a repository and needs no adjacent node_modules.
const fixtureRequire = createRequire(path.join(fixtureRoot, 'package.json'))
const zipPackagePath = fixtureRequire.resolve('@zip.js/zip.js/package.json')
const zipPackage = JSON.parse(await readFile(zipPackagePath, 'utf8'))
const zipEntry = zipPackage.exports['.'].import.default
const {ZipReader, Uint8ArrayReader, Uint8ArrayWriter} = await import(pathToFileURL(path.resolve(path.dirname(zipPackagePath), zipEntry)).href)

// Reproduce the original planner profile independently of host CPU count.
// This changes only the measurement process, never production source or policy.
const plannerHardwareConcurrency = 9
if (typeof globalThis.navigator === 'undefined') {
    Object.defineProperty(globalThis, 'navigator', {value: {}, configurable: true})
}
Object.defineProperty(navigator, 'hardwareConcurrency', {value: plannerHardwareConcurrency, configurable: true})
Object.defineProperty(navigator, 'deviceMemory', {value: undefined, configurable: true})
const archive = await readFile(archivePath)
assert.equal(archive.byteLength, spec.sizeBytes)
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
const canonicalWasm = await readFile(path.join(sourceRoot, 'ext/lib/term-content-canonical-scan-v1.wasm'))
const canonicalModule = await WebAssembly.compile(canonicalWasm)
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


function copy(value) {
    if (ArrayBuffer.isView(value)) return new value.constructor(value)
    if (value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(copy)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]))
}
await mkdir(output, {recursive: true})
const records = []
try {
    for (const job of jobs) {
        const sources = []
        for (const {filename} of job.metadata) {
            sources.push(await byFilename.get(filename).getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true}))
        }
        await parser.parseTermBankWithWasmColumnChunks(sources, 3, async (chunk) => {
            const compactBytes = chunk.contentBytesBuffer.slice(chunk.contentBytesBaseOffset, chunk.contentBytesBaseOffset + chunk.contentBytesLength)
            const input = copy({
                rowCount: chunk.rowCount,
                contentBytesList: [], contentHash1List: chunk.contentHash1List, contentHash2List: chunk.contentHash2List,
                contentBytesBuffer: compactBytes, contentBytesBaseOffset: 0,
                contentMetaList: chunk.contentMetaList, contentUniqueIndexList: chunk.contentUniqueIndexList,
                contentDedupPlan: chunk.contentDedupPlan, useResolvedContentReferences: chunk.useResolvedContentReferences,
                contentDictNameList: null, uniformContentDictName: 'raw-v6',
            })
            const filename = `${String(job.id).padStart(3, '0')}.v8`
            const bytes = serialize(input)
            await writeFile(path.join(output, filename), bytes)
            records.push({group: job.id, filename, bytes: bytes.length, sha256: hash(bytes),
                rows: chunk.rowCount, uniqueCount: chunk.contentDedupPlan.uniqueCount,
                banks: job.metadata.map(({filename}) => filename)})
        }, 2048, {...job.options, singleChunk: true, maxPendingChunks: 1})
        globalThis.gc?.()
    }
} finally {
    await reader.close()
}
assert.equal(records.reduce((sum, item) => sum + item.rows, 0), spec.termRows)
const manifest = {
    description: 'Actual full pinned native parser content columns under the production group planner. The source slab is compactly copied and rebased to zero, without changing bytes or span values. No performance observation in this preparer.',
    dictionary, sourceRoot, node: process.version,
    archiveSha256: spec.sha256, archiveBytes: archive.length, sourceBanks: entries.length,
    plannerHardwareConcurrency, plannerWorkerCount, fixtureLockSha256: hash(fixtureLockBytes),
    runnerSha256: hash(await readFile(fileURLToPath(import.meta.url))),
    parserSha256: hash(await readFile(parserPath)), wasmSha256: hash(wasm), canonicalWasmSha256: hash(canonicalWasm),
    rows: spec.termRows, uniqueCount: records.reduce((sum, item) => sum + item.uniqueCount, 0), groups: records,
}
await writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(JSON.stringify({...manifest, groups: records.length}))
