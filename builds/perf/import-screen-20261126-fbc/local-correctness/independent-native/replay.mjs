import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createReadStream, openAsBlob} from 'node:fs'
import {readFile, writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {Worker} from 'node:worker_threads'

const stage = (name) => console.error(`${new Date().toISOString()} ${name}`)
stage('start')
const work = fileURLToPath(new URL('./', import.meta.url)).replace(/\/$/, '')
const root = process.argv[2] ?? '/workspace/scratch/fbc366eaf75c/manabitan-jmdict'
const dictionaryId = process.env.DICTIONARY_ID ?? 'vndb'
assert(['vndb', 'jitendex'].includes(dictionaryId))
const archiveName = dictionaryId === 'vndb' ? 'vndb_characters_by_bee.zip' : 'jitendex-yomitan.zip'
const archivePath = process.argv[3] ?? `/workspace/scratch/4344255ab4f9/fixtures/${archiveName}`
const maximumGroups = Number(process.env.MAX_GROUPS ?? 0)
const baselineWasm = process.env.BASELINE_WASM ?? '/workspace/scratch/fbc366eaf75c/jmdict-screen/baseline.wasm'
const {readDenseZipDirectory} = await import(pathToFileURL(`${root}/ext/js/dictionary/dense-zip-directory.js`))
const {RawZipPayloadReader} = await import(pathToFileURL(`${root}/ext/js/dictionary/term-bank-source-pipeline.js`))
const fileHash = async (path) => {
    const hash = createHash('sha256')
    for await (const bytes of createReadStream(path, {highWaterMark: 16 * 1024 * 1024})) hash.update(bytes)
    return hash.digest('hex')
}
const lock = JSON.parse(await readFile(`${root}/test/perf/dictionaries.lock.json`))
const fixture = lock.dictionaries[dictionaryId]
stage('hashing fixture')
assert.equal(await fileHash(archivePath), fixture.sha256)
stage('fixture hash verified')
const archive = await openAsBlob(archivePath)
assert.equal(archive.size, fixture.sizeBytes)
stage('reading directory')
let catalog = await readDenseZipDirectory(archive)
if (catalog === null) {
    const require = createRequire(`${root}/package.json`)
    const {ZipReader, BlobReader} = await import(pathToFileURL(require.resolve('@zip.js/zip.js')))
    const zip = new ZipReader(new BlobReader(archive))
    catalog = await zip.getEntries()
    await zip.close()
}
stage('directory loaded')
const termFiles = catalog.filter(({filename}) => /^term_bank_\d+\.json$/.test(filename))
    .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)))
const sourceBytes = termFiles.reduce((total, entry) => total + entry.uncompressedSize, 0)
const groupCount = Math.min(termFiles.length, Math.max(3 * 3, Math.ceil(sourceBytes / (24 * 1024 * 1024))))
const groups = []
let start = 0
let consumed = 0
for (let index = 0; index < groupCount - 1; ++index) {
    const remaining = groupCount - index
    const target = (sourceBytes - consumed) / remaining
    const maximumEnd = termFiles.length - (remaining - 1)
    let end = start + 1
    let bytes = termFiles[start].uncompressedSize
    while (end < maximumEnd) {
        const next = bytes + termFiles[end].uncompressedSize
        if (Math.abs(next - target) > Math.abs(bytes - target)) break
        bytes = next
        ++end
    }
    groups.push(termFiles.slice(start, end))
    consumed += bytes
    start = end
}
groups.push(termFiles.slice(start))
assert.equal(groups.length, dictionaryId === 'vndb' ? 170 : 22)
assert.equal(termFiles.length, dictionaryId === 'vndb' ? 665 : 219)
const options = {
    emitContentSlab: true,
    emitTokenBinaryContent: true,
    emitTermByteLists: false,
    singleChunk: true,
    compactContentMetadata: true,
    prepareLookupIndexes: true,
    prepareLookupRoute: true,
    mediaHintFastScan: true,
    validateGlossaryTypes: true,
    ownContentBytes: dictionaryId === 'vndb',
    projectImagePaths: dictionaryId === 'vndb',
    experimentalNativeEscapedKeys: dictionaryId === 'vndb',
}

function nextMessage(worker) {
    return new Promise((resolve, reject) => {
        const onMessage = (value) => { cleanup(); resolve(value) }
        const onError = (error) => { cleanup(); reject(error) }
        const onExit = (code) => { cleanup(); reject(new Error(`Worker exited before reply: ${code}`)) }
        const cleanup = () => {
            worker.off('message', onMessage)
            worker.off('error', onError)
            worker.off('exit', onExit)
        }
        worker.on('message', onMessage)
        worker.on('error', onError)
        worker.on('exit', onExit)
    })
}
async function initialize(wasmPath) {
    const wasm = await readFile(wasmPath)
    const worker = new Worker(new URL('./worker-adapter.mjs', import.meta.url), {workerData: {root}})
    assert.equal((await nextMessage(worker)).type, 'adapter-ready')
    const pending = nextMessage(worker)
    worker.postMessage({type: 'initialize', module: await WebAssembly.compile(wasm)})
    const reply = await pending
    assert.equal(reply.type, 'ready', JSON.stringify(reply))
    return {worker, wasmHash: createHash('sha256').update(wasm).digest('hex')}
}

// Hash every nested output field, including byte columns, maps and media rows.
// One elapsed-time field is diagnostic and not part of semantic chunk output.
function hashValue(hash, value, owned = null) {
    if (value === null || typeof value !== 'object') {
        hash.update(`${typeof value}:${JSON.stringify(value)};`)
    } else if (ArrayBuffer.isView(value)) {
        const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        hash.update(`view:${value.constructor.name}:${bytes.length}:`)
        hash.update(bytes)
        if (value.buffer instanceof ArrayBuffer) owned?.add(value.buffer)
    } else if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
        hash.update(`buffer:${value.byteLength}:`)
        hash.update(new Uint8Array(value))
        if (value instanceof ArrayBuffer) owned?.add(value)
    } else if (value instanceof Map) {
        hash.update(`map:${value.size}:`)
        for (const [key, item] of value) { hashValue(hash, key, owned); hashValue(hash, item, owned) }
    } else if (Array.isArray(value)) {
        hash.update(`array:${value.length}:`)
        for (const item of value) hashValue(hash, item, owned)
    } else {
        const keys = Object.keys(value).filter((key) => key !== 'preparedLookupIndexEncodeMs').sort()
        hash.update(`object:${keys.length}:`)
        for (const key of keys) { hashValue(hash, key, owned); hashValue(hash, value[key], owned) }
    }
}
function snapshot(chunk) {
    const hash = createHash('sha256')
    const owned = new Set()
    hashValue(hash, chunk, owned)
    const buffers = [...owned]
    return {sha256: hash.digest('hex'), buffers, ownedHash: hashOwned(buffers)}
}
function hashOwned(buffers) {
    const hash = createHash('sha256')
    for (const buffer of buffers) { hash.update(`${buffer.byteLength}:`); hash.update(new Uint8Array(buffer)) }
    return hash.digest('hex')
}
async function parse(arm, sources, id) {
    const pending = nextMessage(arm.worker)
    arm.worker.postMessage({type: 'parse', id, version: 3, chunkSize: 2048, options,
        sourceBuffers: sources.map(({bytes}) => bytes.buffer),
        sourceMetadata: sources.map(({compressionMethod, compressedSize, uncompressedSize, signature, filename}) => ({compressionMethod, compressedSize, uncompressedSize, signature, filename})),
    })
    const result = await pending
    if (result.type !== 'result') throw new Error(JSON.stringify(result))
    assert.equal(result.id, id)
    return result
}

const report = {
    kind: `complete-compressed-${dictionaryId}-worker-parity`,
    timingClaim: false,
    browserMemoryClaim: false,
    runtime: process.version,
    sourceRoot: root,
    baselineWasm,
    fixture,
    sourceBytes,
    partition: {workers: 3, groupsPerWorker: 3, targetBytes: 24 * 1024 * 1024, groupCount, execution: 'two arms, sequential groups'},
    options,
    sources: {},
    groups: [],
    complete: false,
}
for (const path of ['ext/js/dictionary/wasm/term-bank-parser.c', 'ext/js/dictionary/term-bank-wasm-parser.js', 'ext/js/dictionary/term-bank-wasm-parser-worker.js', 'ext/js/dictionary/term-bank-experiments.js', 'ext/js/dictionary/term-content-ownership.js']) {
    report.sources[path] = await fileHash(`${root}/${path}`)
}
stage('initializing workers')
const arms = [await initialize(baselineWasm), await initialize(`${root}/dev/data/dictionary-wasm/term-bank-parser.wasm`)]
stage('workers initialized')
report.modules = arms.map(({wasmHash}) => wasmHash)
const reader = new RawZipPayloadReader(archive)
const signal = new AbortController().signal
const previousOwned = [null, null]
const allMedia = [new Set(), new Set()]
try {
    for (let i = 0; i < groups.length && (maximumGroups === 0 || i < maximumGroups); ++i) {
        const sources = []
        for (const file of groups[i]) {
            const raw = await reader.read(file, signal)
            const bytes = Uint8Array.from(raw)
            sources.push({...file, bytes})
        }
        if (i === 0) stage('compressed group loaded')
        const summaries = []
        for (let armIndex = 0; armIndex < arms.length; ++armIndex) {
            if (i === 0) stage(`parsing arm ${armIndex}`)
            const result = await parse(arms[armIndex], sources, i)
            if (i === 0) stage(`parsed arm ${armIndex}`)
            const previous = previousOwned[armIndex]
            if (previous !== null) assert.equal(hashOwned(previous.buffers), previous.ownedHash, 'Owned output changed after native heap reuse')
            const captured = snapshot(result.chunk)
            if (i === 0) stage(`hashed arm ${armIndex}`)
            previousOwned[armIndex] = captured
            for (const entry of result.chunk.mediaRows) {
                for (const mediaPath of entry.imagePaths ?? []) allMedia[armIndex].add(mediaPath)
            }
            summaries.push({
                rows: result.rowCount,
                outputHash: captured.sha256,
                projectedMediaRows: result.chunk.mediaRows.length,
                borrowsWorkerMemory: result.borrowsWorkerMemory,
                ownsContentBytes: result.ownsContentBytes,
                maxWasmHeapBytes: result.profile.maxWasmHeapBytes,
                fusedAttempts: result.profile.fusedParseAttempts,
                fusedFallbacks: result.profile.fusedParseFallbacks,
                escapedKeyDecodeCount: result.profile.escapedKeyDecodeCount,
                sourceCompressedBytes: result.profile.sourceCompressedBytes,
                sourceUncompressedBytes: result.profile.sourceUncompressedBytes,
                sourceCrcScannedBytes: result.profile.sourceCrcScannedBytes,
                sourceCrcReusedBytes: result.profile.sourceCrcReusedBytes,
            })
        }
        assert.deepStrictEqual(summaries[0], summaries[1])
        report.groups.push({index: i, filenames: groups[i].map(({filename}) => filename), ...summaries[0]})
        if ((i + 1) % 10 === 0 || i + 1 === groups.length) {
            await writeFile(`${work}/${dictionaryId}-parity-checkpoint.json`, JSON.stringify(report, null, 2) + '\n')
            console.log(JSON.stringify({groups: i + 1, rows: report.groups.reduce((total, value) => total + value.rows, 0)}))
        }
    }
    report.rows = report.groups.reduce((total, value) => total + value.rows, 0)
    report.projectedMediaRows = report.groups.reduce((total, value) => total + value.projectedMediaRows, 0)
    report.uniqueMediaPaths = allMedia.map((paths) => paths.size)
    report.complete = report.groups.length === groupCount
    if (report.complete) {
        assert.equal(report.rows, fixture.termRows)
        assert.equal(await fileHash(archivePath), fixture.sha256)
    }
    report.completedAt = new Date().toISOString()
    await writeFile(`${work}/${dictionaryId}-parity.json`, JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify({complete: report.complete, rows: report.rows, groups: report.groups.length, projectedMediaRows: report.projectedMediaRows, uniqueMediaPaths: report.uniqueMediaPaths}))
} finally {
    await Promise.all(arms.map(({worker}) => worker.terminate()))
}
