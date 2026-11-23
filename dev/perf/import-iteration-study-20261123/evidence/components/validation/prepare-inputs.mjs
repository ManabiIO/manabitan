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
const wasm = await readFile(path.join(sourceRoot, 'ext/lib/term-bank-parser.wasm'))
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

// Copy only live views, never their potentially much larger Wasm backing heap.
function copy(value, seen = new Map()) {
    if (value === null || typeof value !== 'object') return value
    if (seen.has(value)) return seen.get(value)
    if (ArrayBuffer.isView(value)) {
        const result = new value.constructor(value)
        seen.set(value, result)
        return result
    }
    const result = value instanceof Map ? new Map() : Array.isArray(value) ? [] : {}
    seen.set(value, result)
    if (value instanceof Map) {
        for (const [key, item] of value) result.set(key, copy(item, seen))
    } else {
        for (const [key, item] of Object.entries(value)) result[key] = copy(item, seen)
    }
    return result
}
await mkdir(output, {recursive: true})
const groups = []
let contentCursor = 128
try {
    for (const job of jobs) {
        const sources = []
        for (const {filename} of job.metadata) {
            sources.push(await byFilename.get(filename).getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true}))
        }
        await parser.parseTermBankWithWasmColumnChunks(sources, 3, async (chunk) => {
            const plan = chunk.contentDedupPlan
            const offsets = new Float64Array(plan.uniqueCount)
            const lengths = new Uint32Array(plan.uniqueCount)
            for (let i = 0; i < plan.uniqueCount; i++) {
                const rowIndex = plan.uniqueRowIndexes[i]
                offsets[i] = contentCursor + chunk.contentMetaList[rowIndex * 4]
                lengths[i] = chunk.contentMetaList[rowIndex * 4 + 1]
            }
            contentCursor += chunk.contentBytesLength
            const input = copy({
                dictionary: spec.expectedTitle,
                rowCount: chunk.rowCount,
                expressionBytesList: [], readingBytesList: [],
                readingEqualsExpressionList: chunk.readingEqualsExpressionList,
                scoreList: chunk.scoreList,
                sequenceList: chunk.sequenceList,
                termRecordPreinternedPlan: chunk.termRecordPreinternedPlan,
                preparedLookupIndexes: chunk.preparedLookupIndexes,
                resolvedContentReferences: {uniqueIndexList: chunk.contentUniqueIndexList, offsets, lengths},
            })
            const uniqueIndexList = input.resolvedContentReferences.uniqueIndexList
            assert.equal(uniqueIndexList.length, chunk.rowCount)
            assert(input.preparedLookupIndexes instanceof Map && input.preparedLookupIndexes.size > 0)
            let contentRuns = 0
            const runLimit = input.preparedLookupIndexes.has(`0:${chunk.rowCount}`) ? chunk.rowCount : 30_000
            for (let row = 0; row < chunk.rowCount; row++) {
                if (row % runLimit === 0 || uniqueIndexList[row] !== uniqueIndexList[row - 1]) contentRuns++
            }
            const bytes = serialize(input)
            const filename = `${String(job.id).padStart(3, '0')}.v8`
            await writeFile(path.join(output, filename), bytes)
            groups.push({id: job.id, filename, sha256: hash(bytes), rowCount: chunk.rowCount, uniqueCount: plan.uniqueCount,
                contentRuns, preparedLookupKeys: [...input.preparedLookupIndexes.keys()], banks: job.metadata.map(({filename}) => filename)})
        }, 2048, {...job.options, singleChunk: true, maxPendingChunks: 1})
        globalThis.gc?.()
        if (job.id % 20 === 0 || job.id === jobs.length) process.stderr.write(`${dictionary}: ${job.id}/${jobs.length} groups\n`)
    }
} finally {
    await reader.close()
}
assert.equal(groups.reduce((sum, group) => sum + group.rowCount, 0), spec.termRows)
const receipt = {
    description: 'All pinned term banks parsed with the production five-worker grouping planner, sequentially. Copies exact native row/lookup/score columns. Reference offsets are translated raw content-slab offsets, not compressed persistent storage offsets. Isolated record-validation and encoder qualification only; not full import timing.',
    dictionary, sourceRoot, archiveSha256: spec.sha256, archiveBytes: archive.byteLength, node: process.version,
    plannerHardwareConcurrency, plannerWorkerCount, fixtureLockSha256: hash(fixtureLockBytes),
    runnerSha256: hash(await readFile(fileURLToPath(import.meta.url))), parserSha256: hash(await readFile(parserPath)), wasmSha256: hash(wasm),
    sourceBanks: entries.length, rows: spec.termRows,
    contentRuns: groups.reduce((sum, group) => sum + group.contentRuns, 0),
    repeatedValidationsRemoved: groups.reduce((sum, group) => sum + group.rowCount - group.contentRuns, 0),
    groups,
}
await writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(receipt, null, 2)}\n`)
console.log(JSON.stringify({...receipt, groups: groups.length}))

