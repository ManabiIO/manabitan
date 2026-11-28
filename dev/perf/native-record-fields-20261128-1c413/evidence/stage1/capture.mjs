// One untimed current-source import capturing every actual stock field call.
// Derived from the retained compression parity harness; no product file edits.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile, writeFile, mkdir, readdir, stat} from 'node:fs/promises'
import {openSync, readSync, writeSync, ftruncateSync, fsyncSync, closeSync, fstatSync, createReadStream} from 'node:fs'
import {resolve, basename, relative} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {Worker as NodeWorker} from 'node:worker_threads'
import {execFileSync} from 'node:child_process'
import os from 'node:os'
import {installCompressionObserver} from './compression-observer.mjs'
import {installRecordFieldCapture} from './capture-observer.mjs'
import {installRecordFieldExport} from './export-hook.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const sourceRoot = resolve(here, '../../manabitan')
const outputDir = resolve(here, 'run')
const sourceBinding = JSON.parse(await readFile(new URL('./capture-binding.json', import.meta.url), 'utf8'))
const runtime = JSON.parse(await readFile(new URL('./runtime-identity.json', import.meta.url), 'utf8'))
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const moduleUrl = (name) => pathToFileURL(resolve(sourceRoot, name)).href
assert.equal(process.argv.length, 2, 'No variants, reruns, sampling or optional flags')
assert.equal(process.version, 'v24.22.3')
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], {cwd: sourceRoot, encoding: 'utf8'}).trim(), sourceBinding.baseline)
assert.equal(sha256(execFileSync('git', ['diff', '--binary', 'HEAD'], {cwd: sourceRoot})), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
for (const [name, digest] of Object.entries(runtime.files)) assert.equal(sha256(await readFile(resolve(sourceRoot, name))), digest, name)
for (const [name, digest] of Object.entries(sourceBinding.files)) assert.equal(sha256(await readFile(resolve(here, name))), digest, name)
assert.equal(sha256(await readFile(resolve(sourceRoot, 'ext/lib/term-content-canonical-scan-v1.wasm'))), sourceBinding.stockWasmSha256)
assert.equal(sha256(await readFile(resolve(sourceRoot, sourceBinding.stockSource))), sourceBinding.stockSourceSha256)
assert.equal(sha256(await readFile(resolve(sourceRoot, 'ext/lib/term-bank-parser.wasm'))), '8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee')
const oracleBytes = await readFile(new URL('./retained-baseline-oracle.json', import.meta.url))
assert.equal(sha256(oracleBytes), sourceBinding.retainedBaselineOracleSha256)
const oracle = JSON.parse(oracleBytes)
assert.equal(oracle.sourceCommit, sourceBinding.baseline)
await mkdir(outputDir, {recursive: false})
await mkdir(resolve(outputDir, 'temporary'))
assert.equal(os.tmpdir(), resolve(outputDir, 'temporary'), 'Use only this experiment temporary directory')

const originalFetch = globalThis.fetch
globalThis.fetch = async (resource, options) => {
    const url = resource instanceof URL ? resource : new URL(typeof resource === 'string' ? resource : resource.url)
    return url.protocol === 'file:' ? new Response(await readFile(fileURLToPath(url)), {headers: {'Content-Type': 'application/wasm'}}) : originalFetch(resource, options)
}
const {createNodeOpfs} = await import(moduleUrl('test/fixtures/fused-score/node-opfs-adapter.mjs'))
const opfs = await createNodeOpfs()
const sampleFile = await opfs.root.getFileHandle('sync-handle-prototype', {create: true})
globalThis.FileSystemFileHandle = sampleFile.constructor
globalThis.FileSystemDirectoryHandle = opfs.root.constructor
Object.getPrototypeOf(sampleFile).createSyncAccessHandle = async function ({mode} = {}) {
    const fd = openSync(this.location, mode === 'read-only' ? 'r' : 'r+')
    return {
        read(buffer, {at = 0} = {}) { return readSync(fd, buffer, 0, buffer.byteLength, at) },
        write(buffer, {at = 0} = {}) { return writeSync(fd, buffer, 0, buffer.byteLength, at) },
        getSize() { return fstatSync(fd).size },
        truncate(size) { ftruncateSync(fd, size) },
        flush() { fsyncSync(fd) },
        close() { closeSync(fd) },
    }
}
await opfs.root.removeEntry('sync-handle-prototype')
const hardwareConcurrency = 4
const deviceMemory = 8
Object.defineProperty(globalThis, 'navigator', {value: {hardwareConcurrency, deviceMemory, storage: {getDirectory: async () => opfs.root}}, configurable: true})
globalThis.self = globalThis
const workers = []
const terminations = []
const workerEvents = []
const bridge = new URL('./node-import-worker-bridge.mjs', import.meta.url)
globalThis.Worker = class BrowserWorker extends EventTarget {
    constructor(url) {
        super()
        assert.equal(new URL(url).protocol, 'file:')
        this.role = basename(fileURLToPath(url))
        this.id = workers.length
        this.ready = false
        this.closed = false
        this.received = {}
        this.sent = {}
        this.thread = new NodeWorker(bridge, {workerData: {url: new URL(url).href, hardwareConcurrency, deviceMemory}})
        this.thread.on('message', (data) => {
            const type = data?.type ?? data?.action ?? (data?.id === undefined ? 'other' : 'result')
            this.received[type] = (this.received[type] ?? 0) + 1
            if (type === 'ready') this.ready = true
            workerEvents.push({worker: this.id, role: this.role, direction: 'received', type, jobId: data?.id})
            const event = new Event('message')
            event.data = data
            this.dispatchEvent(event)
            this.onmessage?.(event)
        })
        this.thread.on('error', (error) => {
            workerEvents.push({worker: this.id, role: this.role, error: String(error)})
            const event = new Event('error')
            event.error = error
            event.message = error.message
            this.dispatchEvent(event)
            this.onerror?.(event)
        })
        this.thread.on('messageerror', (error) => {
            const event = new Event('messageerror')
            event.error = error
            this.dispatchEvent(event)
            this.onmessageerror?.(event)
        })
        workers.push(this)
    }
    postMessage(data, transfer) {
        const type = data?.type ?? data?.action ?? 'job'
        this.sent[type] = (this.sent[type] ?? 0) + 1
        workerEvents.push({worker: this.id, role: this.role, direction: 'sent', type, jobId: data?.id})
        this.thread.postMessage(data, transfer)
    }
    terminate() {
        if (this.closed) return
        this.closed = true
        const result = this.thread.terminate()
        terminations.push(result)
        return result
    }
}

const lockBytes = await readFile(resolve(sourceRoot, 'test/perf/dictionaries.lock.json'))
assert.equal(sha256(lockBytes), oracle.fixture.lockSha256)
const fixture = JSON.parse(lockBytes).dictionaries.jmdict
const archiveBytes = await readFile(resolve(here, '../../fixtures/JMdict.zip'))
assert.equal(archiveBytes.byteLength, fixture.sizeBytes)
assert.equal(sha256(archiveBytes), fixture.sha256)
const exportHook = installRecordFieldExport(sourceRoot, sourceBinding.recordEncoderSha256)
const recordModule = await import(moduleUrl('ext/js/dictionary/term-record-opfs-store.js'))
exportHook.finish()
const {DictionaryDatabase} = await import(moduleUrl('ext/js/dictionary/dictionary-database.js'))
const {DictionaryImporter} = await import(moduleUrl('ext/js/dictionary/dictionary-importer.js'))
const {getSqlite3} = await import(moduleUrl('ext/js/dictionary/sqlite-wasm.js'))
const db = new DictionaryDatabase()
db._openConnection = async function () {
    this._sqlite3 = await getSqlite3()
    this._db = new this._sqlite3.oo1.DB(':memory:', 'c')
    this._usesFallbackStorage = false
    this._openStorageDiagnostics = {mode: 'diagnostic-node-memory-sqlite'}
    this._getSupportedInstalledSchemaVersion()
    await this._recoverInterruptedImportSession()
    await this._termContentStore.prepare()
    await this._termRecordStore.prepare()
    this._termContentBlockStore.clearCache()
    this._clearTermsVtabCursorState()
    this._termsVtabModuleRegistered = false
    this._applyRuntimePragmas()
    await this._initializeSchema()
    await this._runSchemaMigrations()
    this._restoreTermRecordDictionaryHealth()
}

// Product metrics internally include durations. Retain only operation counts.
const withoutTiming = (value) => {
    if (Array.isArray(value)) return value.map(withoutTiming)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/Ms$|Micros$|observedAt|(?:^|_)time(?:stamp)?$/i.test(key)).map(([key, item]) => [key, withoutTiming(item)]))
    return value
}
const chunks = []
const bulkAdd = db.bulkAddArtifactTermsChunk.bind(db)
db.bulkAddArtifactTermsChunk = async (chunk) => {
    const result = await bulkAdd(chunk)
    chunks.push({index: chunks.length, rowCount: chunk.rowCount, metrics: withoutTiming({...db.getLastBulkAddTermsMetrics()})})
    return result
}
const compressionObserver = await installCompressionObserver(db, moduleUrl, () => chunks.length)
const capture = installRecordFieldCapture({store: db._termRecordStore, module: recordModule, outputDirectory: outputDir, getGroupIndex: () => chunks.length})
const progress = []
const importer = new DictionaryImporter({async getImageDetails() { throw new Error('JMdict must not request image metadata') }}, (value) => progress.push(withoutTiming(value)))
let error
try {
    await db.prepare()
    await new Promise((resolveReady, reject) => {
        const check = setInterval(() => {
            if (workers.filter((worker) => worker.role === 'zstd-term-content-compression-worker.js' && worker.ready).length === 4) {
                clearInterval(check)
                clearTimeout(deadline)
                resolveReady()
            }
        }, 10)
        const deadline = setTimeout(() => {
            clearInterval(check)
            reject(new Error('Real compression workers did not initialize'))
        }, 30000)
    })
    const result = await importer.importDictionary(db, new Blob([archiveBytes]), {skipImageMetadata: true, zipUseWebWorkers: false})
    assert.equal(result.outcome.status, 'published')
    assert.equal(result.errors.length, 0, result.errors.map(String).join('\n'))
    assert.equal(result.result.title, fixture.expectedTitle)
    assert.equal(result.result.revision, fixture.revision)
    assert.equal(result.result.counts.media.total, 0)
    assert.equal(chunks.reduce((sum, chunk) => sum + chunk.rowCount, 0), 528299)
    assert.deepEqual(chunks.map((chunk) => chunk.rowCount), oracle.chunks.map((chunk) => chunk.rowCount))
    assert.equal(chunks.length, 12)
    const compressionCensus = await compressionObserver.finish()
    assert.deepEqual(compressionCensus, oracle.compressionCensus, 'All compression frames, descriptors, and row references match retained stock output')
    const metricTotals = {}
    for (const chunk of chunks) for (const [key, value] of Object.entries(chunk.metrics)) if (typeof value === 'number') metricTotals[key] = (metricTotals[key] ?? 0) + value
    const captureTotals = capture.finish()
    assert.equal(metricTotals.dedupNativeFallbackCount, 0)
    const fileReceipts = []
    async function inspectFiles(directory) {
        for (const name of (await readdir(directory)).sort()) {
            const location = resolve(directory, name)
            const fileStat = await stat(location)
            if (fileStat.isDirectory()) await inspectFiles(location)
            else {
                const header = Buffer.alloc(Math.min(40, fileStat.size))
                const fd = openSync(location, 'r')
                try { readSync(fd, header, 0, header.byteLength, 0) } finally { closeSync(fd) }
                const magic = header.subarray(0, 8).toString('ascii')
                const generationOffset = magic === 'MBTRD16X' ? 8 : magic === 'MBTIDX11' ? 24 : null
                const fullHash = createHash('sha256')
                const normalizedHash = generationOffset === null ? null : createHash('sha256')
                let first = true
                for await (const bytes of createReadStream(location)) {
                    fullHash.update(bytes)
                    if (normalizedHash !== null) {
                        if (first) normalizedHash.update(bytes.subarray(0, generationOffset)).update(new Uint8Array(16)).update(bytes.subarray(generationOffset + 16))
                        else normalizedHash.update(bytes)
                    }
                    first = false
                }
                const receipt = {path: relative(opfs.rootPath, location), sizeBytes: fileStat.size, sha256: fullHash.digest('hex')}
                if (generationOffset !== null) {
                    receipt.generationId = header.subarray(generationOffset, generationOffset + 16).toString('hex')
                    receipt.generationNormalizedSha256 = normalizedHash.digest('hex')
                }
                fileReceipts.push(receipt)
            }
        }
    }
    await inspectFiles(opfs.rootPath)
    const canonicalFiles = (files) => files.map(({path, sizeBytes, sha256, generationNormalizedSha256}) => ({path, sizeBytes, sha256: generationNormalizedSha256 ?? sha256}))
    assert.deepEqual(canonicalFiles(fileReceipts), canonicalFiles(oracle.fileReceipts), 'Complete finalized content, row, and lookup payloads match retained current-source stock output')
    const parserProfile = importer._lastFastTermBankReadProfile.parserProfile
    assert.equal(parserProfile.parallelWorkerCount, 3)
    assert.equal(parserProfile.parallelPipelineGroupsPerWorker, 4)
    assert.equal(parserProfile.parallelGroupCount, 12)
    assert.equal(parserProfile.mediaHintFastScan, false)
    assert.equal(parserProfile.bankSpanCount, 53)
    assert.equal(parserProfile.fusedParseAttempts, 12)
    assert.equal(parserProfile.fusedParseFallbacks, 0)
    for (const [name, digest] of Object.entries(runtime.files)) assert.equal(sha256(await readFile(resolve(sourceRoot, name))), digest, name)
    const report = {
        complete: true,
        timingAcquisition: false,
        sourceBinding,
        fixture: {...fixture, lockSha256: sha256(lockBytes)},
        node: process.version,
        scope: 'One stock JMdict import capturing every actual field encoder call, exact compressed frames and references, and complete finalized payload hashes. Node workers, in-memory SQLite, test file OPFS adapter; no browser qualification.',
        substitutions: oracle.substitutions,
        sameStockProductionOutput: true,
        lookupReadSkipped: true,
        retainedBaselineHashParity: true,
        chunkCount: chunks.length,
        rows: chunks.reduce((sum, chunk) => sum + chunk.rowCount, 0),
        chunks,
        metricTotals,
        parserProfile: withoutTiming(parserProfile),
        compressionCensus,
        fileReceipts,
        captureTotals,
        diagnosticExport: exportHook.receipt,
        workers: workers.map(({id, role, ready, received, sent}) => ({id, role, ready, received, sent})),
        workerEvents,
        progress,
    }
    await writeFile(resolve(outputDir, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify({complete: true, rows: report.rows, groups: report.chunkCount, captureTotals, finalizedOutputParity: true}))
} catch (caught) {
    error = caught
    await writeFile(resolve(outputDir, 'failure.json'), JSON.stringify({complete: false, error: String(caught), stack: caught?.stack, workers: workers.map(({id, role, ready, received, sent}) => ({id, role, ready, received, sent})), workerEvents, chunks, progress}, null, 2) + '\n')
} finally {
    capture.restore()
    await db.close().catch((caught) => { error ??= caught })
    for (const worker of workers) worker.terminate()
    await Promise.allSettled(terminations)
    await opfs.dispose()
}
if (error) throw error
