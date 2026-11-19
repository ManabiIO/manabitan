/*
 * Copyright (C) 2026  Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
/* eslint @stylistic/semi: ["error", "never"] */
/* eslint-disable no-underscore-dangle -- This component harness deliberately exercises the production storage sink without SQLite. */

import assert from 'node:assert/strict'
import {spawn, execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {lstat, mkdir, readFile, readdir, realpath, writeFile} from 'node:fs/promises'
import {Session} from 'node:inspector/promises'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {parseArgs} from 'node:util'
import {inflateRawSync} from 'node:zlib'
import {ZipReader, Uint8ArrayReader, TextWriter} from '@zip.js/zip.js'
import {parseJson} from '../../ext/js/core/json.js'
import {safePerformance} from '../../ext/js/core/safe-performance.js'
import {loadDictionaryFixtures} from './dictionary-fixtures.js'

/** @typedef {import('@zip.js/zip.js').Entry} ZipFile */
/** @typedef {import('../../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} ComponentDatabase */
/** @typedef {import('../../ext/js/dictionary/term-bank-wasm-parser.js').TermBankColumnChunk} ColumnChunk */
/** @typedef {import('../../ext/js/dictionary/term-bank-wasm-parser.js').CompressedTermBankSource} CompressedSource */
/** @typedef {{name: string, bytes: number, sha256: string}} FileIdentity */
/** @typedef {{source: string, fixture: string, dictionary: string, groups: number, limitBanks: number, deviceMemory: number, hardwareConcurrency: number, verify: boolean, profile?: string}} RunOptions */
/** @typedef {{rows: number, sha256: string, elapsedMs: number}} RowVerification */
/** @typedef {{componentMs: number, finalizationMs: number, cpuUserMs: number, cpuSystemMs: number, profiled: boolean, instrumentedDiagnostic: boolean}} ComponentTiming */
/** @typedef {{rows: number, timing: ComponentTiming, verification: RowVerification|null, storedFilesSha256: string, storedFilesCanonicalSha256: string, parserTotals: Record<string, number>, sinkTotals: Record<string, number>} & Record<string, unknown>} ComponentReport */
/** @typedef {{root: FileSystemDirectoryHandle, rootPath: string, dispose: () => Promise<void>}} NodeOpfs */
/** @typedef {{format: string, generationId: string, mask: {offset: number, length: number}, pairedFile: string, headerBytes: number}} GenerationNormalization */
/** @typedef {FileIdentity & {canonicalSha256: string, normalization: GenerationNormalization|null}} StoredFileIdentity */

const scriptPath = fileURLToPath(import.meta.url)
const harnessRoot = path.resolve(path.dirname(scriptPath), '../..')
const boundary = {
    kind: 'node-sequential-import-components',
    includes: [
        'Production native ZIP inflate and CRC validation',
        'Production parser, content encoding and prepared lookup indexes',
        'Production worker-result ownership copy, with shared content bytes',
        'Production dictionary content deduplication, compression and record/index encoding',
        'Content and record storage finalization through the test filesystem adapter',
    ],
    excludes: [
        'Archive read, ZIP directory read, module loading and compilation',
        'Browser worker startup, scheduling, transfers and parallel compression',
        'Real browser OPFS costs: the adapter commits Node temporary files on close',
        'SQLite, journal, tags, metadata/media import, backend adoption and visible UI readiness',
        'Exhaustive reopened-row validation, performed after the timed component',
    ],
    warning: 'Component evidence only. This is not complete-import latency and cannot establish an end-to-end import speedup. Internal phase counters can overlap; do not add them.',
}

const {values} = parseArgs({options: {
    'source': {type: 'string'},
    'baseline': {type: 'string'},
    'candidate': {type: 'string'},
    'fixture': {type: 'string'},
    'dictionary': {type: 'string', default: 'jmdict'},
    'output': {type: 'string'},
    'pairs': {type: 'string', default: '1'},
    'groups': {type: 'string', default: '0'},
    'limit-banks': {type: 'string', default: '0'},
    'device-memory': {type: 'string', default: '8'},
    'hardware-concurrency': {type: 'string', default: '8'},
    'no-verify': {type: 'boolean', default: false},
    'profile': {type: 'string'},
    'profile-dir': {type: 'string'},
    'help': {type: 'boolean', default: false},
}})

/**
 * @param {string|undefined} value
 * @param {string} name
 * @param {number} minimum
 * @returns {number}
 * @throws {Error} If the option is not an integer in the allowed range.
 */
function integerOption(value, name, minimum) {
    const result = Number(value)
    if (!Number.isSafeInteger(result) || result < minimum) { throw new Error(`Invalid --${name}: ${value}`) }
    return result
}

/**
 * @param {Uint8Array|string} bytes
 * @returns {string}
 */
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex') }

/**
 * @param {string} filename
 * @returns {Promise<void>}
 */
async function ensureParent(filename) { await mkdir(path.dirname(filename), {recursive: true}) }

/**
 * @param {string} filename
 * @param {unknown} value
 * @returns {Promise<void>}
 */
async function writeJson(filename, value) {
    await ensureParent(filename)
    await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, {flag: 'wx'})
}

/**
 * Fail before a costly run when a requested artifact already exists. The final
 * exclusive write also protects against another process creating it later.
 * @param {string} filename
 * @returns {Promise<void>}
 * @throws {Error} If the output exists or its status cannot be inspected.
 */
async function requireNewOutput(filename) {
    try {
        await lstat(filename)
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') { return }
        throw error
    }
    throw new Error(`Refusing to replace an existing output: ${filename}`)
}

/**
 * @param {string} root
 * @param {string} name
 * @returns {Promise<unknown>}
 */
async function sourceModule(root, name) {
    // eslint-disable-next-line no-unsanitized/method -- Only an explicitly selected local source checkout is imported.
    return await import(pathToFileURL(path.join(root, name)).href)
}

/**
 * Match the production lazy-source grouping algorithm and the high-capability
 * plain-term policy (five workers, four groups per worker, at most 24 MiB target).
 * Execution remains sequential in this harness. Explicit --groups overrides
 * only this partition count; every report records the exact bank membership.
 * @param {CompressedSource[]} sources
 * @param {number} requestedCount
 * @returns {CompressedSource[][]}
 */
function partitionSources(sources, requestedCount) {
    const totalBytes = sources.reduce((total, source) => total + source.uncompressedSize, 0)
    const groupCount = Math.min(requestedCount, sources.length)
    const groups = []
    let start = 0
    let consumed = 0
    for (let groupIndex = 0; groupIndex < groupCount - 1; ++groupIndex) {
        const remaining = groupCount - groupIndex
        const target = (totalBytes - consumed) / remaining
        let end = start + 1
        let bytes = sources[start].uncompressedSize
        const maxEnd = sources.length - (remaining - 1)
        while (end < maxEnd) {
            const next = bytes + sources[end].uncompressedSize
            if (Math.abs(next - target) > Math.abs(bytes - target)) { break }
            bytes = next
            ++end
        }
        groups.push(sources.slice(start, end))
        start = end
        consumed += bytes
    }
    groups.push(sources.slice(start))
    return groups
}

/**
 * @param {Record<string, number>} totals
 * @param {Record<string, unknown>|null} valuesToAdd
 */
function addNumericMetrics(totals, valuesToAdd) {
    for (const [key, value] of Object.entries(valuesToAdd ?? {})) {
        if (typeof value !== 'number' || !Number.isFinite(value)) { continue }
        totals[key] = (totals[key] ?? 0) + value
    }
}

/**
 * @param {string} root
 * @param {string[]} names
 * @returns {Promise<FileIdentity[]>}
 */
async function identifyFiles(root, names) {
    const identities = []
    for (const name of names) {
        const bytes = await readFile(path.join(root, name))
        identities.push({name, bytes: bytes.length, sha256: hash(bytes)})
    }
    return identities
}

/**
 * @param {string} root
 * @param {string} [relative]
 * @returns {Promise<FileIdentity[]>}
 */
async function identifyTree(root, relative = '') {
    const identities = []
    for (const entry of (await readdir(path.join(root, relative), {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
        const name = path.join(relative, entry.name)
        if (entry.isDirectory()) {
            identities.push(...await identifyTree(root, name))
        } else if (entry.isFile()) {
            identities.push(...await identifyFiles(root, [name]))
        }
    }
    return identities
}

/**
 * Only the audited random generation fields may differ. Check current formats,
 * descriptor metadata length, sidecar framing, and generation agreement before
 * masking exactly 16 bytes in each file. No persisted file is modified.
 * @param {string} root
 * @param {FileIdentity[]} files
 * @param {ComponentDatabase} database
 * @returns {Promise<StoredFileIdentity[]>}
 */
async function canonicalizeStoredFiles(root, files, database) {
    /** @type {Map<string, StoredFileIdentity>} */
    const byName = new Map(files.map((file) => [file.name, {...file, canonicalSha256: file.sha256, normalization: null}]))
    const decoder = new TextDecoder('utf-8', {fatal: true})
    for (const file of files) {
        if (!file.name.endsWith('.mbtr')) { continue }
        const sidecarName = `${file.name}.mbti`
        const recordIdentity = byName.get(file.name)
        const sidecarIdentity = byName.get(sidecarName)
        assert.ok(recordIdentity && sidecarIdentity, `Missing record/index pair: ${file.name}`)
        const record = new Uint8Array(await readFile(path.join(root, file.name)))
        const sidecar = new Uint8Array(await readFile(path.join(root, sidecarName)))
        assert.ok(record.length >= 26 && sidecar.length >= 40, `Truncated shard header: ${file.name}`)
        assert.equal(decoder.decode(record.subarray(0, 8)), 'MBTRD16X', `Unaudited record format: ${file.name}`)
        assert.equal(decoder.decode(sidecar.subarray(0, 8)), 'MBTIDX11', `Unaudited index format: ${sidecarName}`)
        const recordView = new DataView(record.buffer, record.byteOffset, record.byteLength)
        let metadata = recordView.getUint16(24, true)
        let headerBytes = 26
        if (metadata === 0xffff) {
            assert.ok(record.length >= 30, `Truncated extended shard metadata: ${file.name}`)
            metadata = recordView.getUint32(26, true)
            headerBytes = 30
        }
        const code = metadata & 0xff
        if (code === 0xff) {
            const nameBytes = metadata >>> 8
            assert.ok(nameBytes > 0 && headerBytes + nameBytes <= record.length, `Invalid shard content name: ${file.name}`)
            assert.ok(decoder.decode(record.subarray(headerBytes, headerBytes + nameBytes)).length > 0)
            headerBytes += nameBytes
        } else {
            assert.ok(code <= 5 && metadata === code, `Unaudited shard metadata code: ${file.name}`)
        }
        assert.deepEqual(record.subarray(8, 24), sidecar.subarray(24, 40), `Shard generation mismatch: ${file.name}`)
        const sidecarView = new DataView(sidecar.buffer, sidecar.byteOffset, sidecar.byteLength)
        assert.equal(sidecarView.getBigUint64(8, true), BigInt(record.length), `Sidecar descriptor length mismatch: ${file.name}`)
        assert.ok(sidecarView.getUint32(16, true) > 0 && sidecarView.getUint32(20, true) > 0, `Empty sidecar metadata: ${file.name}`)
        assert.ok(database._termRecordStore._scanPersistentIndexMaxRecordId(sidecar) !== null, `Invalid or unknown sidecar framing: ${file.name}`)
        const generationId = Buffer.from(record.subarray(8, 24)).toString('hex')
        recordIdentity.normalization = {format: 'MBTRD16X', generationId, mask: {offset: 8, length: 16}, pairedFile: sidecarName, headerBytes}
        sidecarIdentity.normalization = {format: 'MBTIDX11', generationId, mask: {offset: 24, length: 16}, pairedFile: file.name, headerBytes: 40}
        record.fill(0, 8, 24)
        sidecar.fill(0, 24, 40)
        recordIdentity.canonicalSha256 = hash(record)
        sidecarIdentity.canonicalSha256 = hash(sidecar)
    }
    for (const file of byName.values()) {
        if (file.name.endsWith('.mbti')) { assert.ok(file.normalization !== null, `Unpaired or unaudited sidecar: ${file.name}`) }
    }
    return [...byName.values()]
}

/**
 * @param {string} source
 * @returns {Promise<Record<string, unknown>>}
 */
async function identifySource(source) {
    return {
        path: source,
        commit: execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
        dirtyFiles: execFileSync('git', ['-C', source, 'status', '--short'], {encoding: 'utf8'})
            .trim().split('\n')
            .filter(Boolean),
        trackedDiffSha256: hash(execFileSync('git', ['-C', source, 'diff', 'HEAD', '--binary'], {maxBuffer: 32 * 1024 * 1024})),
        files: await identifyFiles(source, [
            'ext/js/dictionary/dictionary-database.js',
            'ext/js/dictionary/dictionary-importer.js',
            'ext/js/dictionary/term-bank-wasm-parser.js',
            'ext/js/dictionary/term-bank-experiments.js',
            'ext/js/dictionary/term-lookup-index-preparation.js',
            'ext/js/dictionary/term-content-canonical-scan.js',
            'ext/js/dictionary/term-content-block-store.js',
            'ext/js/dictionary/term-record-opfs-store.js',
            'ext/js/dictionary/zstd-term-content.js',
            'dev/data/dictionary-wasm/term-bank-parser.wasm',
            'ext/lib/term-content-canonical-scan-v1.wasm',
            'ext/lib/zstd-wasm.js',
            'ext/lib/zstd.wasm',
            'ext/lib/zstd-dicts/jmdict.zdict',
        ]),
    }
}

/**
 * Every stored row is read from reopened stores and compared with the source
 * JSON, including the glossary structure. Only one source bank and at most
 * 1,024 records are materialized at a time. Missing sequences become null;
 * empty readings become the expression, matching importer normalization.
 * @param {ComponentDatabase} database
 * @param {CompressedSource[]} sources
 * @param {string} dictionary
 * @returns {Promise<{rows: number, sha256: string, elapsedMs: number}>}
 */
async function verifyEveryRow(database, sources, dictionary) {
    const started = safePerformance.now()
    const digest = createHash('sha256')
    let id = 1
    const decoder = new TextDecoder()
    for (const source of sources) {
        const sourceBytes = source.compressionMethod === 0 ? source.bytes : inflateRawSync(source.bytes)
        const rows = /** @type {unknown[][]} */ (parseJson(decoder.decode(sourceBytes)))
        for (let start = 0; start < rows.length; start += 1024) {
            const count = Math.min(1024, rows.length - start)
            const records = await database._termRecordStore.getByIdsAsync(Array.from({length: count}, (_, index) => id + index))
            assert.equal(records.size, count, `Missing persisted rows in ${source.filename} at ${start}`)
            for (let index = 0; index < count; ++index, ++id) {
                const row = rows[start + index]
                const stored = await database._deserializeTermRow({...records.get(id), id})
                const actual = [stored.expression, stored.reading, stored.definitionTags, stored.rules, stored.score, stored.glossary, stored.sequence ?? null, stored.termTags]
                const expected = [row[0], row[1] || row[0], row[2] ?? '', row[3], row[4], row[5], typeof row[6] === 'number' && row[6] >= 0 ? row[6] : null, row[7] ?? '']
                assert.equal(stored.dictionary, dictionary)
                assert.deepEqual(actual, expected, `${source.filename}, row ${start + index}, stored ID ${id}`)
                digest.update(JSON.stringify(actual)).update('\n')
            }
        }
    }
    assert.equal((await database._termRecordStore.getByIdsAsync([id])).size, 0, 'Unexpected trailing persisted row')
    return {rows: id - 1, sha256: digest.digest('hex'), elapsedMs: safePerformance.now() - started}
}

/**
 * @param {RunOptions} options
 * @returns {Promise<ComponentReport>}
 * @throws {Error} If the fixture or selected local assets are invalid.
 */
async function runComponent(options) {
    const harnessSha256 = hash(await readFile(scriptPath))
    const adapterPath = path.join(harnessRoot, 'test/fixtures/opfs-continuation/node-opfs-adapter.mjs')
    const adapterSha256 = hash(await readFile(adapterPath))
    const rawInstrumentation = /** @type {unknown} */ (Reflect.get(globalThis, Symbol.for('manabitan.perf.instrumentation')))
    const instrumentation = typeof rawInstrumentation === 'undefined' ? null : /** @type {Record<string, unknown>} */ (rawInstrumentation)
    assert.ok(instrumentation === null || (typeof instrumentation === 'object' && !Array.isArray(instrumentation) && instrumentation.diagnosticOnly === true), 'Instrumentation must declare diagnosticOnly:true')
    const rawFinalize = /** @type {unknown} */ (Reflect.get(globalThis, Symbol.for('manabitan.perf.finalize')))
    assert.ok(typeof rawFinalize === 'undefined' || (typeof rawFinalize === 'function' && instrumentation !== null), 'A diagnostic finalizer requires the instrumentation marker')
    const source = await realpath(options.source)
    const fixtures = await loadDictionaryFixtures()
    const fixture = fixtures[options.dictionary]
    if (!fixture) { throw new Error(`Unknown pinned dictionary: ${options.dictionary}`) }
    const archive = await readFile(options.fixture)
    assert.equal(archive.byteLength, fixture.sizeBytes, 'Pinned archive byte count mismatch')
    assert.equal(hash(archive), fixture.sha256, 'Pinned archive SHA-256 mismatch')
    const sourceIdentity = await identifySource(source)
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (resource, init) => {
        const url = resource instanceof Request ? new URL(resource.url) : new URL(String(resource))
        if (url.protocol !== 'file:') { throw new Error(`Component runs do not fetch network resources: ${url}`) }
        const filename = await realpath(fileURLToPath(url))
        if (!filename.startsWith(`${source}${path.sep}`)) { throw new Error(`Asset is outside the selected checkout: ${filename}`) }
        init?.signal?.throwIfAborted()
        return new Response(await readFile(filename), {headers: {'Content-Type': filename.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream'}})
    }
    const parser = /** @type {typeof import('../../ext/js/dictionary/term-bank-wasm-parser.js')} */ (await sourceModule(source, 'ext/js/dictionary/term-bank-wasm-parser.js'))
    const {DictionaryDatabase} = /** @type {typeof import('../../ext/js/dictionary/dictionary-database.js')} */ (await sourceModule(source, 'ext/js/dictionary/dictionary-database.js'))
    const {initializeTermContentZstd} = /** @type {typeof import('../../ext/js/dictionary/zstd-term-content.js')} */ (await sourceModule(source, 'ext/js/dictionary/zstd-term-content.js'))
    const {compileCanonicalScanModule} = /** @type {typeof import('../../ext/js/dictionary/term-content-canonical-scan.js')} */ (await sourceModule(source, 'ext/js/dictionary/term-content-canonical-scan.js'))
    const {RawZipPayloadReader} = /** @type {typeof import('../../ext/js/dictionary/term-bank-source-pipeline.js')} */ (await sourceModule(source, 'ext/js/dictionary/term-bank-source-pipeline.js'))
    const {snapshotTermBankExperiments} = /** @type {typeof import('../../ext/js/dictionary/term-bank-experiments.js')} */ (await sourceModule(source, 'ext/js/dictionary/term-bank-experiments.js'))
    const {prepareTermLookupIndexesFromPreinternedPlan} = /** @type {typeof import('../../ext/js/dictionary/term-lookup-index-preparation.js')} */ (await sourceModule(source, 'ext/js/dictionary/term-lookup-index-preparation.js'))
    const {createNodeOpfs} = /** @type {{createNodeOpfs: () => Promise<NodeOpfs>}} */ (await sourceModule(harnessRoot, 'test/fixtures/opfs-continuation/node-opfs-adapter.mjs'))
    const env = await createNodeOpfs()
    const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    Object.defineProperty(globalThis, 'navigator', {configurable: true,
        value: {
            hardwareConcurrency: options.hardwareConcurrency,
            deviceMemory: options.deviceMemory,
            storage: {getDirectory: async () => env.root},
        }})
    /** @type {Session|null} */
    let profiler = null
    /** @type {ComponentDatabase|null} */
    let database = null
    let storageFinalized = false
    /** @type {unknown} */
    let originalFailure = null
    let failed = false
    /** @type {ComponentReport|null} */
    let report = null
    /** @type {unknown[]} */
    const cleanupErrors = []
    const zip = new ZipReader(new Uint8ArrayReader(Uint8Array.from(archive)), {useWebWorkers: false})
    try {
        const files = await zip.getEntries()
        const indexFile = files.find((file) => file.filename === 'index.json')
        assert.ok(indexFile && typeof indexFile.getData === 'function')
        const index = /** @type {{title: string, revision: string, format?: number, version?: number}} */ (parseJson(await indexFile.getData(new TextWriter(), {useWebWorkers: false})))
        assert.equal(index.title, fixture.expectedTitle)
        assert.equal(index.revision, fixture.revision)
        assert.equal(index.format ?? index.version, 3)
        let termFiles = /** @type {ZipFile[]} */ (files.filter((file) => /^term_bank_\d+\.json$/.test(file.filename)))
        termFiles.sort((a, b) => Number(a.filename.match(/\d+/)?.[0]) - Number(b.filename.match(/\d+/)?.[0]))
        const archiveTermBankCount = termFiles.length
        if (options.limitBanks > 0) { termFiles = termFiles.slice(0, options.limitBanks) }
        assert.ok(termFiles.length > 0, 'No term banks found')
        const rawReader = new RawZipPayloadReader(Uint8Array.from(archive).buffer)
        /** @type {CompressedSource[]} */
        const sources = []
        for (const file of termFiles) {
            assert.ok(file.compressionMethod === 0 || file.compressionMethod === 8)
            sources.push({
                filename: file.filename,
                bytes: await rawReader.read(file, new AbortController().signal),
                compressedSize: file.compressedSize,
                uncompressedSize: file.uncompressedSize,
                compressionMethod: file.compressionMethod,
                signature: file.signature,
            })
        }
        const experiments = snapshotTermBankExperiments()
        const totalBytes = sources.reduce((total, value) => total + value.uncompressedSize, 0)
        const requestedGroupCount = options.groups || Math.max(parser.getParallelTermBankParserWorkerCount(experiments) * 4, Math.ceil(totalBytes / (24 * 1024 * 1024)))
        const groups = partitionSources(sources, requestedGroupCount)
        const sourceRun = {startIndex: 0, fileCount: sources.length, totalFileCount: archiveTermBankCount}
        const sourceRunExhaustsTermFiles = sourceRun.startIndex + sourceRun.fileCount === sourceRun.totalFileCount
        parser.setTermBankWasmModule(await WebAssembly.compile(await readFile(path.join(source, 'dev/data/dictionary-wasm/term-bank-parser.wasm'))))
        await parser.initializeTermBankWasmParser()
        await initializeTermContentZstd()
        await compileCanonicalScanModule()
        database = new DictionaryDatabase()
        database.setImportOptimizationFlags({termContentStorageMode: 'raw-bytes', queueTermContentWrites: true, ...experiments})
        database._bulkImportTransactionOpen = true
        database._deferTermsVirtualTableSync = true
        database._termContentZstdInitialized = true
        await database._termContentStore.prepare()
        await database._termRecordStore.prepare()
        await database._termContentStore.beginImportSession()
        await database._termRecordStore.beginImportSession()
        database._termContentBlockImportSession = database._termContentBlockStore.beginImportSession()
        const parserOptions = {
            ...experiments,
            computeContentHashes: true,
            emitContentSlab: true,
            emitTokenBinaryContent: true,
            emitTermByteLists: false,
            prepareLookupIndexes: true,
            useNativeStringPlan: true,
            validateGlossaryTypes: true,
            mediaHintFastScan: false,
            maxPendingChunks: 1,
            singleChunk: true,
        }
        if (options.profile) {
            profiler = new Session()
            profiler.connect()
            await profiler.post('Profiler.enable')
            await profiler.post('Profiler.start')
        }
        const cpuStart = process.cpuUsage()
        const start = safePerformance.now()
        const groupResults = []
        let rows = 0
        let estimatedTotalRows = 0
        let workerLookupFallbackGroups = 0
        /** @type {Record<string, number>} */
        const parserTotals = {}
        /** @type {Record<string, number>} */
        const sinkTotals = {}
        for (const group of groups) {
            const groupStart = safePerformance.now()
            const preloadedSource = await parser.inflateCompressedTermBankSourcesWasm(group, experiments)
            const inflateMs = safePerformance.now() - groupStart
            /** @type {ColumnChunk|null} */
            let chunk = null
            let copyMs = 0
            let borrowsWorkerMemory = false
            const parseStart = safePerformance.now()
            await parser.parseTermBankWithWasmColumnChunks(new Uint8Array(0), 3, (value) => {
                assert.equal(chunk, null, 'Expected one chunk per native group')
                const copyStart = safePerformance.now()
                chunk = parser.copyWasmBackedColumnChunk(value, true)
                borrowsWorkerMemory = value.contentBytesBuffer?.buffer instanceof SharedArrayBuffer &&
                chunk.contentBytesBuffer?.buffer === value.contentBytesBuffer.buffer
                copyMs += safePerformance.now() - copyStart
            }, 2048, {...parserOptions, preloadedSource})
            const parseMs = safePerformance.now() - parseStart
            const profile = parser.consumeLastTermBankWasmParseProfile()
            const resultChunk = /** @type {ColumnChunk|null} */ (chunk)
            assert.ok(resultChunk !== null || profile?.rowCount === 0, 'Parser emitted no chunk for a nonempty group')
            if (profile !== null) {
                Object.assign(profile, {
                    resultCopyMs: copyMs,
                    sourceInflateMs: preloadedSource.inflateMs,
                    sourceCompressedBytes: preloadedSource.compressedBytes,
                    sourceUncompressedBytes: preloadedSource.uncompressedBytes,
                    borrowedContentResultCount: borrowsWorkerMemory ? 1 : 0,
                })
            }
            const fallbackStart = safePerformance.now()
            let workerLookupFallback = false
            if (resultChunk !== null && !(resultChunk.preparedLookupIndexes instanceof Map)) {
                const prepared = prepareTermLookupIndexesFromPreinternedPlan(resultChunk, null, experiments)
                if (prepared !== null) {
                    workerLookupFallback = true
                    ++workerLookupFallbackGroups
                    resultChunk.preparedLookupIndexes = prepared.indexes
                    resultChunk.preparedLookupIndexEncodeMs = prepared.totalMs
                    if (profile !== null) {
                        profile.lookupIndexPrepareMs = (profile.lookupIndexPrepareMs ?? 0) + prepared.totalMs
                        profile.lookupIndexCompactMs = prepared.compactMs
                        profile.lookupIndexEncodeMs = (profile.lookupIndexEncodeMs ?? 0) + prepared.indexEncodeMs
                        profile.directLookupArenaSegments = prepared.directArenaSegments
                        profile.directLookupArenaCopiedBytesAvoided = prepared.directArenaCopiedBytesAvoided
                        profile.lookupCompactionSourceValidationPasses = prepared.compactionSourceValidationPasses
                    }
                }
            }
            const workerLookupFallbackMs = safePerformance.now() - fallbackStart
            addNumericMetrics(parserTotals, profile)
            const groupRows = resultChunk?.rowCount ?? 0
            const groupSourceBytes = group.reduce((total, bank) => total + bank.uncompressedSize, 0)
            // ParallelTermBankPipelineRun._runPipeline uses only the first
            // result to estimate future rows. Preserve that hint because it
            // controls sink preallocation and persisted-only record storage.
            if (groupResults.length === 0) {
                estimatedTotalRows = groupSourceBytes > 0 ?
                    Math.max(groupRows, Math.round(groupRows * totalBytes / groupSourceBytes)) :
                    groupRows
            }
            rows += groupRows
            /** @type {number} */
            const dictionaryTotalRows = groupResults.length + 1 === groups.length ?
                rows :
                Math.max(rows, estimatedTotalRows)
            // The worker emits one chunk per group, but its local 1/1 progress
            // is not dictionary finality. Mirror the ordered pipeline callback
            // and the importer's independent proof that its source run is last.
            /** @type {{processedRows: number, totalRows: number, chunkIndex: number, chunkCount: number}} */
            const pipelineProgress = {processedRows: rows, totalRows: dictionaryTotalRows, chunkIndex: groupResults.length + 1, chunkCount: groups.length}
            const isFinalTermChunk = (
                resultChunk !== null &&
                sourceRunExhaustsTermFiles &&
                Number.isSafeInteger(pipelineProgress.chunkIndex) && pipelineProgress.chunkIndex > 0 &&
                Number.isSafeInteger(pipelineProgress.chunkCount) && pipelineProgress.chunkCount > 0 &&
                pipelineProgress.chunkIndex === pipelineProgress.chunkCount
            )
            const sinkStart = safePerformance.now()
            if (resultChunk !== null) {
                const payload = {
                    ...resultChunk,
                    dictionary: index.title,
                    dictionaryTotalRows,
                    isFinalTermChunk,
                    contentDictNameList: null,
                    uniformContentDictName: 'raw-v6',
                }
                await database._bulkAddArtifactTermsChunkWithContentDedup(payload)
            }
            const sinkMs = safePerformance.now() - sinkStart
            const sinkProfile = resultChunk === null ? {} : {...database._lastBulkAddTermsMetrics}
            addNumericMetrics(sinkTotals, sinkProfile)
            groupResults.push({banks: group.map((bank) => bank.filename), rows: groupRows, sourceBytes: groupSourceBytes, processedRows: rows, estimatedTotalRows, dictionaryTotalRows, pipelineProgress, isFinalTermChunk, inflateMs, parseMs, copyMs, workerLookupFallback, workerLookupFallbackMs, sinkMs, elapsedMs: safePerformance.now() - groupStart, parser: profile, sink: sinkProfile})
            process.stderr.write(`Group ${groupResults.length}/${groups.length}: ${groupRows} rows\n`)
        }
        const finalizeStart = safePerformance.now()
        database._termContentBlockImportSession.close()
        database._termContentBlockImportSession = null
        const finalizers = await Promise.allSettled([database._termContentStore.endImportSession(), database._termRecordStore.endImportSession()])
        const finalizationErrors = finalizers.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
        if (finalizationErrors.length > 0) { throw new AggregateError(finalizationErrors, 'Component storage finalization failed') }
        storageFinalized = true
        const finalizationMs = safePerformance.now() - finalizeStart
        const componentMs = safePerformance.now() - start
        const cpu = process.cpuUsage(cpuStart)
        if (profiler !== null && options.profile) {
            const {profile} = await profiler.post('Profiler.stop')
            profiler.disconnect()
            profiler = null
            await writeJson(options.profile, profile)
        }
        if (options.limitBanks === 0) { assert.equal(rows, fixture.termRows, 'Pinned fixture row count mismatch') }
        const rawStoredFiles = await identifyTree(env.rootPath)
        const storedFiles = await canonicalizeStoredFiles(env.rootPath, rawStoredFiles, database)
        let verification = null
        if (options.verify) {
            // New production stores ensure validation cannot use import-era row,
            // content, recent-source or decoded-block caches.
            const reopened = new DictionaryDatabase()
            reopened._termContentZstdInitialized = true
            await reopened._termContentStore.prepare()
            await reopened._termRecordStore.prepare()
            await reopened._termRecordStore.ensureDictionariesLoaded([index.title])
            assert.equal(reopened._termRecordStore.getDictionaryHealth(index.title).status, 'available')
            verification = await verifyEveryRow(reopened, sources, index.title)
            assert.equal(verification.rows, rows)
        }
        report = {
            schemaVersion: 1,
            harnessSemanticsVersion: 4,
            boundary: instrumentation === null ? boundary : {...boundary, warning: `${boundary.warning} Instrumented diagnostic run; do not use its timings as performance evidence.`},
            instrumentation,
            generatedAt: new Date().toISOString(),
            source: sourceIdentity,
            harnessSha256,
            adapterSha256,
            fixture: {...fixture, path: path.resolve(options.fixture)},
            runtime: {node: process.version, platform: process.platform, arch: process.arch, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, memory: process.memoryUsage(), maxRssKiB: process.resourceUsage().maxRSS},
            policy: {...options, groupCount: groups.length, requestedGroupCount, sourceUncompressedBytes: totalBytes, sourceRun, sourceRunExhaustsTermFiles, finalTermChunkPolicy: 'Explicit source-run exhaustion plus positive safe pipeline chunk index/count equality; truncated source prefixes and empty final groups remain unmarked', estimatedTotalRows, dictionaryTotalRowsPolicy: 'Production first-group byte-weighted estimate; running row count on final group; no advance fixture row count', experiments, parserOptions, storageAdapter: 'Node temporary files, commit on close', parallelWorkers: 0, compressionWorkers: 0},
            rows,
            workerLookupFallbackGroups,
            timing: {componentMs, finalizationMs, cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000, profiled: Boolean(options.profile), instrumentedDiagnostic: instrumentation !== null},
            parserTotals,
            sinkTotals,
            groupResults,
            storedFiles,
            storedFilesSha256: hash(JSON.stringify(rawStoredFiles)),
            storedFilesCanonicalSha256: hash(JSON.stringify(storedFiles.map(({name, bytes, canonicalSha256}) => ({name, bytes, sha256: canonicalSha256})))),
            normalizationPolicy: 'Mask only matching 16-byte random generation IDs in validated MBTRD16X [8,24) and MBTIDX11 [24,40) headers. All other file bytes must match.',
            verification,
        }
        if (typeof rawFinalize === 'function') {
            const finalize = /** @type {(report: ComponentReport, context: {source: string, dictionaryTitle: string, rows: number, storageRootPath: string}) => Promise<unknown>} */ (rawFinalize)
            report.diagnosticResult = await finalize(report, {source, dictionaryTitle: index.title, rows, storageRootPath: env.rootPath})
        }
        const sourceFiles = /** @type {FileIdentity[]} */ (sourceIdentity.files)
        assert.deepEqual(await identifyFiles(source, sourceFiles.map(({name}) => name)), sourceFiles, 'Selected source or runtime asset changed during the run')
        assert.equal(hash(await readFile(adapterPath)), adapterSha256, 'Filesystem adapter changed during the run')
    } catch (error) {
        originalFailure = error
        failed = true
    } finally {
        try {
            profiler?.disconnect()
        } catch (error) {
            cleanupErrors.push(error)
        }
        if (database !== null) {
            try {
                database._termContentBlockImportSession?.close()
                database._termContentBlockImportSession = null
            } catch (error) {
                cleanupErrors.push(error)
            }
            if (!storageFinalized) {
                const finalizers = await Promise.allSettled([database._termContentStore.endImportSession(), database._termRecordStore.endImportSession()])
                for (const result of finalizers) {
                    if (result.status === 'rejected') { cleanupErrors.push(result.reason) }
                }
            }
        }
        try {
            await zip.close()
        } catch (error) {
            cleanupErrors.push(error)
        }
        if (previousNavigator) {
            Object.defineProperty(globalThis, 'navigator', previousNavigator)
        } else {
            Reflect.deleteProperty(globalThis, 'navigator')
        }
        globalThis.fetch = originalFetch
        try {
            await env.dispose()
        } catch (error) {
            cleanupErrors.push(error)
        }
    }
    if (cleanupErrors.length > 0) {
        if (failed) { cleanupErrors.unshift(originalFailure) }
        throw new AggregateError(cleanupErrors, 'Component run or cleanup failed')
    }
    if (failed) { throw originalFailure }
    assert.ok(report, 'Component run did not produce a report')
    return report
}

/**
 * @param {string[]} args
 * @returns {Promise<void>}
 */
async function isolatedRun(args) {
    await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--max-old-space-size=1400', scriptPath, ...args], {stdio: 'inherit'})
        child.on('error', reject)
        child.on('close', (code, signal) => {
            if (code === 0) {
                resolve(void 0)
            } else {
                reject(new Error(`Component child failed: ${code ?? signal}`))
            }
        })
    })
}

/**
 * @returns {Promise<void>}
 * @throws {Error} If the command-line invocation is invalid.
 */
async function main() {
    if (values.help) {
        console.log(`Pinned JMdict import component benchmark (not complete-import latency).

Single fresh process:
  node dev/perf/jmdict-component-benchmark.js --source /checkout --fixture /cache/JMdict.zip --output /results/run.json
Alternating isolated A/B processes:
  node dev/perf/jmdict-component-benchmark.js --baseline /baseline --candidate /candidate --fixture /cache/JMdict.zip --pairs 3 --output /results/comparison.json

Options:
  --dictionary jmdict|jmnedict|jitendex  Select the pinned fixture (default jmdict).
  --groups N                          Override production-style group count.
  --limit-banks N                     Smoke test only; report marks the subset.
  --no-verify                         Skip exhaustive reopened-row/source comparison.
  --device-memory N                   Navigator memory hint in GiB (default 8).
  --hardware-concurrency N            Navigator CPU hint (default 8).
  --profile FILE                     CPU profile of a single component run.
  --profile-dir DIRECTORY             Per-arm profiles for paired runs.

Compilation and storage preparation occur before timing. Native group execution
and compression are sequential; store finalization occurs inside the timer.
All reported file paths must be new. Profiled runs are diagnostic, not timing evidence.`)
        return
    }
    if (!values.fixture || !values.output) { throw new Error('--fixture and --output are required; see --help') }
    const output = path.resolve(values.output)
    await requireNewOutput(output)
    if (values.profile) {
        assert.notEqual(path.resolve(values.profile), output, 'Profile and report paths must differ')
        await requireNewOutput(path.resolve(values.profile))
    }
    const options = {
        source: values.source ?? harnessRoot,
        fixture: path.resolve(values.fixture),
        dictionary: values.dictionary,
        groups: integerOption(values.groups, 'groups', 0),
        limitBanks: integerOption(values['limit-banks'], 'limit-banks', 0),
        deviceMemory: integerOption(values['device-memory'], 'device-memory', 1),
        hardwareConcurrency: integerOption(values['hardware-concurrency'], 'hardware-concurrency', 1),
        verify: !values['no-verify'],
        profile: values.profile ? path.resolve(values.profile) : void 0,
    }
    if (!values.baseline && !values.candidate) {
        const report = await runComponent(options)
        await writeJson(output, report)
        console.log(JSON.stringify({output, rows: report.rows, timing: report.timing, verification: report.verification}, null, 2))
        return
    }
    if (!values.baseline || !values.candidate || values.source || values.profile) { throw new Error('Paired mode requires --baseline and --candidate, without --source or --profile') }
    const pairs = integerOption(values.pairs, 'pairs', 1)
    /** @type {Array<{pair: number, arm: string, output: string, report: ComponentReport}>} */
    const reports = []
    for (let pair = 0; pair < pairs; ++pair) {
        const arms = pair % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']
        for (const arm of arms) {
            const source = arm === 'baseline' ? values.baseline : values.candidate
            const runOutput = path.join(path.dirname(output), `${path.basename(output, '.json')}-${pair + 1}-${arm}.json`)
            const args = ['--source', source, '--fixture', options.fixture, '--dictionary', options.dictionary, '--output', runOutput, '--groups', String(options.groups), '--limit-banks', String(options.limitBanks), '--device-memory', String(options.deviceMemory), '--hardware-concurrency', String(options.hardwareConcurrency)]
            if (!options.verify) { args.push('--no-verify') }
            if (values['profile-dir']) { args.push('--profile', path.resolve(values['profile-dir'], `${pair + 1}-${arm}.cpuprofile`)) }
            await isolatedRun(args)
            const report = /** @type {ComponentReport} */ (parseJson(await readFile(runOutput, 'utf8')))
            reports.push({pair: pair + 1, arm, output: runOutput, report})
        }
    }
    const first = reports[0].report
    for (const {report} of reports) {
        assert.equal(report.rows, first.rows)
        if (options.verify) {
            assert.ok(report.verification && first.verification, 'Missing exhaustive reopened-row verification')
            assert.deepEqual({rows: report.verification.rows, sha256: report.verification.sha256}, {rows: first.verification.rows, sha256: first.verification.sha256}, 'Reopened row parity differs across arms')
        }
        assert.equal(report.storedFilesCanonicalSha256, first.storedFilesCanonicalSha256, 'Persisted artifact bytes differ outside audited shard generation fields')
    }
    await writeJson(output, {schemaVersion: 1, harnessSemanticsVersion: 4, boundary, pairs, parity: {rows: first.rows, semanticSha256: first.verification?.sha256 ?? null, storedFilesCanonicalSha256: first.storedFilesCanonicalSha256}, runs: reports.map(({pair, arm, output: filename, report}) => ({pair, arm, output: filename, timing: report.timing, storedFilesSha256: report.storedFilesSha256, storedFilesCanonicalSha256: report.storedFilesCanonicalSha256, parserTotals: report.parserTotals, sinkTotals: report.sinkTotals}))})
    console.log(`Component comparison and exhaustive parity: ${output}`)
}

await main()

/* eslint-enable no-underscore-dangle */
