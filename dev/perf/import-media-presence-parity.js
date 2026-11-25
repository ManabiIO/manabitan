#!/usr/bin/env node
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

import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createReadStream, openAsBlob} from 'node:fs'
import {readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {parseArgs} from 'node:util'
import {Worker} from 'node:worker_threads'
import {parseJson} from '../../ext/js/core/json.js'

/** @typedef {typeof import('../../ext/js/dictionary/term-bank-wasm-parser.js')} Parser */
/** @typedef {ReturnType<Parser['copyWasmBackedColumnChunk']>} Chunk */
/** @typedef {NonNullable<ReturnType<Parser['consumeLastTermBankWasmParseProfile']>>} Profile */
/** @typedef {{type: 'result', id: number, rowCount: number, borrowsWorkerMemory: boolean, ownsContentBytes: boolean, chunk: Chunk|null, profile: Profile|null}} ParserResult */
/** @typedef {Pick<import('../../ext/js/dictionary/term-bank-wasm-parser.js').CompressedTermBankSource, 'compressionMethod'|'compressedSize'|'uncompressedSize'|'signature'|'filename'>} SourceMetadata */
/** @typedef {import('../../ext/js/dictionary/dense-zip-directory.js').DenseZipEntry|import('@zip.js/zip.js').Entry} Entry */
/** @typedef {{group: number, firstBank: string, lastBank: string, sourceBytes: number, rows: number, borrowsWorkerMemory: boolean, ownsContentBytes: boolean, mediaRows: number, projectedMediaRows: number, projectedImageReferences: number, contentBytes: number, uniqueContent: number, lookupIndexes: number, outputHash: string}} GroupOutput */
/** @typedef {GroupOutput & {baselineSkippedRows: number, baselineFusedFallbacks: number, baselineHeap: number, candidateSkippedRows?: number, candidateFusedFallbacks?: number, candidateHeap?: number}} GroupRecord */
/** @typedef {{gitHead: string, trackedStatus: string, files: Record<string, string>}} SourceIdentity */

const {values} = parseArgs({options: {
    'help': {type: 'boolean', default: false},
    'dictionary': {type: 'string'},
    'baseline-root': {type: 'string'},
    'candidate-root': {type: 'string'},
    'fixture-cache': {type: 'string'},
    'fixture': {type: 'string'},
    'fixture-lock': {type: 'string'},
    'workers': {type: 'string', default: '5'},
    'output': {type: 'string'},
}})
if (values.help) {
    console.log(`Usage: node --expose-gc dev/perf/import-media-presence-parity.js
  --dictionary jmdict|jmnedict|jitendex|vndb
  --baseline-root CHECKOUT --candidate-root CHECKOUT
  (--fixture-cache DIRECTORY | --fixture ZIP)
  --output JSON [--workers 2|3|5] [--fixture-lock JSON]

Compares completed production parser-worker payloads, including canonical content,
media rows, lookup indexes and routes. The worker count selects the existing media
grouping policy; only one actual worker runs at a time. This is a correctness check,
not an end-to-end import benchmark. Baseline ext/lib/zip.js must be built. Native
WASM is loaded from each checkout's pinned dev/data/dictionary-wasm artifact.
The fixture lock defaults to the baseline checkout's test/perf/dictionaries.lock.json.`)
    process.exit(0)
}
assert(typeof values.dictionary === 'string', 'Missing --dictionary')
assert(typeof values['baseline-root'] === 'string', 'Missing --baseline-root')
assert(typeof values['candidate-root'] === 'string', 'Missing --candidate-root')
assert(typeof values.output === 'string', 'Missing --output')
assert((typeof values.fixture === 'string') !== (typeof values['fixture-cache'] === 'string'), 'Provide exactly one of --fixture or --fixture-cache')
const baselineRoot = path.resolve(values['baseline-root'])
const candidateRoot = path.resolve(values['candidate-root'])
const lockPath = path.resolve(values['fixture-lock'] ?? path.join(baselineRoot, 'test/perf/dictionaries.lock.json'))
const lockBytes = await readFile(lockPath)
const lock = /** @type {{schemaVersion: number, dictionaries: Record<string, import('./dictionary-fixtures.js').DictionaryFixture>}} */ (parseJson(lockBytes.toString()))
assert.equal(lock.schemaVersion, 1, 'Unsupported fixture lock schema')
const fixture = lock.dictionaries[values.dictionary]
assert(fixture, `Unknown dictionary ${values.dictionary}`)
const archivePath = typeof values.fixture === 'string' ? path.resolve(values.fixture) : path.resolve(/** @type {string} */ (values['fixture-cache']), fixture.cacheFile)
const groupingWorkerCount = Number(values.workers)
assert([2, 3, 5].includes(groupingWorkerCount), '--workers must use an existing 2, 3 or 5 worker policy')

// Explicit caller-selected checkout; imports never use a dictionary pathname.
// eslint-disable-next-line no-unsanitized/method, @typescript-eslint/no-unsafe-assignment
const {ZipReader, BlobReader} = /** @type {typeof import('@zip.js/zip.js')} */ (await import(pathToFileURL(path.join(baselineRoot, 'ext/lib/zip.js')).href))
// eslint-disable-next-line no-unsanitized/method, @typescript-eslint/no-unsafe-assignment
const {RawZipPayloadReader} = /** @type {typeof import('../../ext/js/dictionary/term-bank-source-pipeline.js')} */ (await import(pathToFileURL(path.join(baselineRoot, 'ext/js/dictionary/term-bank-source-pipeline.js')).href))
// eslint-disable-next-line no-unsanitized/method, @typescript-eslint/no-unsafe-assignment
const {readDenseZipDirectory} = /** @type {typeof import('../../ext/js/dictionary/dense-zip-directory.js')} */ (await import(pathToFileURL(path.join(baselineRoot, 'ext/js/dictionary/dense-zip-directory.js')).href))

const archive = await openAsBlob(archivePath)
assert.equal(archive.size, fixture.sizeBytes, 'Archive size differs from lock')
const fixtureHasher = createHash('sha256')
for await (const bytes of createReadStream(archivePath)) {
    assert(bytes instanceof Uint8Array, 'Fixture stream returned nonbinary data')
    fixtureHasher.update(bytes)
}
const archiveHash = fixtureHasher.digest('hex')
assert.equal(archiveHash, fixture.sha256, 'Archive SHA-256 differs from lock')
const zipReader = new ZipReader(new BlobReader(archive))
const rawReader = new RawZipPayloadReader(archive)
const banks = (await readDenseZipDirectory(archive) ?? await zipReader.getEntries())
    .filter((entry) => /^term_bank_\d+\.json$/.test(entry.filename))
    .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)))
assert(banks.length > 0, 'Archive has no term banks')
const totalBytes = banks.reduce((sum, entry) => sum + entry.uncompressedSize, 0)
// Match partitionSourceBanks and the media-aware lazy source planner. The
// policy worker count changes group boundaries, never actual test concurrency.
const groupCount = Math.min(banks.length, Math.max(groupingWorkerCount * 3, Math.ceil(totalBytes / (24 * 1024 * 1024))))
/** @type {Entry[][]} */
const groups = []
let start = 0
let consumedBytes = 0
for (let group = 0; group < groupCount - 1; ++group) {
    const target = (totalBytes - consumedBytes) / (groupCount - group)
    let end = start + 1
    let bytes = banks[start].uncompressedSize
    const maxEnd = banks.length - (groupCount - group - 1)
    while (end < maxEnd) {
        const nextBytes = bytes + banks[end].uncompressedSize
        if (Math.abs(nextBytes - target) > Math.abs(bytes - target)) { break }
        bytes = nextBytes
        ++end
    }
    groups.push(banks.slice(start, end))
    start = end
    consumedBytes += bytes
}
groups.push(banks.slice(start))

/**
 * @param {import('node:crypto').BinaryLike} bytes
 * @returns {string}
 */
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }

/**
 * Capture the selected source tree and the files on the observed worker path.
 * This identity belongs to a new reproduction, not an earlier scratch receipt.
 * @param {string} sourceRoot
 * @returns {Promise<SourceIdentity>}
 */
async function sourceIdentity(sourceRoot) {
    const filenames = [
        'ext/js/dictionary/term-bank-wasm-parser-worker.js',
        'ext/js/dictionary/term-bank-wasm-parser.js',
        'ext/js/dictionary/term-bank-experiments.js',
        'ext/js/dictionary/term-content-ownership.js',
        'ext/js/dictionary/term-lookup-index-preparation.js',
        'ext/js/dictionary/term-lookup-index.js',
        'ext/js/dictionary/term-lookup-route.js',
        'ext/js/dictionary/term-lookup-scratch.js',
        'ext/js/dictionary/term-record-preinterned-plan.js',
        'ext/js/dictionary/wasm/term-bank-parser.c',
        'ext/js/dictionary/dense-zip-directory.js',
        'ext/js/dictionary/term-bank-source-pipeline.js',
        'dev/data/dictionary-wasm/term-bank-parser.wasm',
    ]
    /** @type {Record<string, string>} */
    const files = {}
    for (const filename of filenames) { files[filename] = sha256(await readFile(path.join(sourceRoot, filename))) }
    return {
        gitHead: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: sourceRoot, encoding: 'utf8'}).trim(),
        trackedStatus: execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {cwd: sourceRoot, encoding: 'utf8'}).trim(),
        files,
    }
}

/**
 * @param {string} sourceRoot
 * @returns {Promise<{worker: Worker, wasmHash: string, parse: (id: number, buffers: ArrayBuffer[], metadata: SourceMetadata[]) => Promise<ParserResult>}>}
 */
async function createParser(sourceRoot) {
    const wasmBytes = await readFile(path.join(sourceRoot, 'dev/data/dictionary-wasm/term-bank-parser.wasm'))
    const module = await WebAssembly.compile(wasmBytes)
    const worker = new Worker(new URL('import-media-presence-worker.js', import.meta.url), {workerData: {sourceRoot}})
    /**
     * @param {string} expected
     * @param {() => void} [send]
     * @returns {Promise<Record<string, unknown>>}
     */
    const receive = (expected, send = () => {}) => new Promise((resolve, reject) => {
        /** @param {unknown} error */
        const onError = (error) => {
            cleanup()
            reject(error)
        }
        /** @param {number} code */
        const onExit = (code) => { onError(new Error(`Parser exited while waiting for ${expected}: ${code}`)) }
        /** @param {unknown} value */
        const onMessage = (value) => {
            if (typeof value !== 'object' || value === null || !('type' in value) || typeof value.type !== 'string') {
                onError(new Error('Parser returned an invalid message'))
                return
            }
            if (value.type.endsWith('-error')) {
                onError(new Error(JSON.stringify(value)))
            } else if (value.type === expected) {
                cleanup()
                resolve(/** @type {Record<string, unknown>} */ (value))
            } else {
                onError(new Error(`Unexpected parser message ${value.type}; wanted ${expected}`))
            }
        }
        const cleanup = () => {
            clearTimeout(timeout)
            worker.off('message', onMessage)
            worker.off('error', onError)
            worker.off('exit', onExit)
        }
        const timeout = setTimeout(() => { onError(new Error(`Parser timed out waiting for ${expected}`)) }, 300_000)
        worker.on('message', onMessage)
        worker.once('error', onError)
        worker.once('exit', onExit)
        try {
            send()
        } catch (error) {
            onError(error)
        }
    })
    try {
        await receive('bridge-ready')
        await receive('ready', () => { worker.postMessage({type: 'initialize', module}) })
    } catch (error) {
        await worker.terminate()
        throw error
    }
    return {
        worker,
        wasmHash: sha256(wasmBytes),
        /**
         * @param {number} id
         * @param {ArrayBuffer[]} buffers
         * @param {SourceMetadata[]} metadata
         * @returns {Promise<ParserResult>}
         */
        async parse(id, buffers, metadata) {
            const message = await receive('result', () => {
                worker.postMessage({
                    type: 'parse',
                    id,
                    version: 3,
                    sourceBuffers: buffers,
                    sourceMetadata: metadata,
                    options: {
                        emitTermByteLists: false,
                        computeContentHashes: true,
                        emitContentSlab: true,
                        emitTokenBinaryContent: true,
                        mediaHintFastScan: true,
                        validateGlossaryTypes: true,
                        prepareLookupIndexes: true,
                        prepareLookupRoute: true,
                        projectImagePaths: true,
                        ownContentBytes: totalBytes >= 512 * 1024 * 1024,
                    },
                }, buffers)
            })
            assert.equal(message.id, id, 'Parser response ID differs from request')
            return /** @type {ParserResult} */ (/** @type {unknown} */ (message))
        },
    }
}

/**
 * Hash complete serialized output values before the next parse reuses memory.
 * Exclude only the timing field embedded in the otherwise semantic payload.
 * The encoding is unchanged from the original corpus parity receipts.
 * @param {import('node:crypto').Hash} hash
 * @param {unknown} value
 */
function updateHash(hash, value) {
    if (ArrayBuffer.isView(value)) {
        hash.update(`${value.constructor.name}:${value.byteLength}:`)
        hash.update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
    } else if (value instanceof Map) {
        hash.update(`Map:${value.size}:`)
        for (const [key, entry] of value) {
            updateHash(hash, key)
            updateHash(hash, entry)
        }
    } else if (Array.isArray(value)) {
        hash.update(`Array:${value.length}:`)
        for (const entry of value) { updateHash(hash, entry) }
    } else if (value !== null && typeof value === 'object') {
        const keys = Object.keys(value).filter((key) => key !== 'preparedLookupIndexEncodeMs').sort()
        hash.update(`Object:${keys.length}:`)
        for (const key of keys) {
            updateHash(hash, key)
            updateHash(hash, Reflect.get(value, key))
        }
    } else {
        hash.update(`${typeof value}:${JSON.stringify(value)};`)
    }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function digest(value) {
    const hash = createHash('sha256')
    updateHash(hash, value)
    return hash.digest('hex')
}

/** @type {Record<string, string>} */
const hashes = {}
/** @type {Record<string, SourceIdentity>} */
const identities = {}
/** @type {GroupRecord[]} */
const records = []
const outputHash = createHash('sha256')
/** @type {Set<string>} */
const imagePaths = new Set()
try {
    for (const [arm, sourceRoot] of [['baseline', baselineRoot], ['candidate', candidateRoot]]) {
        identities[arm] = await sourceIdentity(sourceRoot)
        const parser = await createParser(sourceRoot)
        hashes[arm] = parser.wasmHash
        try {
            for (const [groupIndex, entries] of groups.entries()) {
                /** @type {ArrayBuffer[]} */
                const buffers = []
                /** @type {SourceMetadata[]} */
                const metadata = []
                for (const entry of entries) {
                    const bytes = await rawReader.read(entry, new AbortController().signal)
                    assert(bytes.buffer instanceof ArrayBuffer, 'Raw source must own a transferable buffer')
                    assert.equal(bytes.byteOffset, 0)
                    assert.equal(bytes.byteLength, bytes.buffer.byteLength)
                    buffers.push(bytes.buffer)
                    const {compressionMethod, compressedSize, uncompressedSize, signature, filename} = entry
                    assert(compressionMethod === 0 || compressionMethod === 8, 'Unsupported compression method')
                    metadata.push({compressionMethod, compressedSize, uncompressedSize, signature, filename})
                }
                const result = await parser.parse(groupIndex, buffers, metadata)
                const mediaRows = result.chunk?.mediaRows ?? []
                /** @type {GroupOutput} */
                const record = {
                    group: groupIndex + 1,
                    firstBank: entries[0].filename,
                    lastBank: entries[entries.length - 1].filename,
                    sourceBytes: entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0),
                    rows: result.rowCount,
                    borrowsWorkerMemory: result.borrowsWorkerMemory,
                    ownsContentBytes: result.ownsContentBytes,
                    mediaRows: mediaRows.length,
                    projectedMediaRows: mediaRows.filter((row) => Array.isArray(row.imagePaths)).length,
                    projectedImageReferences: mediaRows.reduce((sum, row) => sum + (row.imagePaths?.length ?? 0), 0),
                    contentBytes: result.chunk?.contentBytesLength ?? 0,
                    uniqueContent: Number(result.chunk?.contentDedupPlan?.uniqueCount ?? 0),
                    lookupIndexes: result.chunk?.preparedLookupIndexes?.size ?? 0,
                    outputHash: digest(result.chunk),
                }
                if (arm === 'baseline') {
                    records.push({
                        ...record,
                        baselineSkippedRows: result.profile?.mediaHintRowsSkipped ?? 0,
                        baselineFusedFallbacks: result.profile?.fusedParseFallbacks ?? 0,
                        baselineHeap: result.profile?.maxWasmHeapBytes ?? 0,
                    })
                } else {
                    const baselineRecord = records[groupIndex]
                    for (const key of Object.keys(record)) {
                        assert.deepEqual(Reflect.get(record, key), Reflect.get(baselineRecord, key), `Group ${groupIndex + 1} ${key} differs`)
                    }
                    Object.assign(baselineRecord, {
                        candidateSkippedRows: result.profile?.mediaHintRowsSkipped ?? 0,
                        candidateFusedFallbacks: result.profile?.fusedParseFallbacks ?? 0,
                        candidateHeap: result.profile?.maxWasmHeapBytes ?? 0,
                    })
                    outputHash.update(record.outputHash)
                    for (const row of mediaRows) {
                        for (const imagePath of row.imagePaths ?? []) { imagePaths.add(imagePath) }
                    }
                }
                console.log(JSON.stringify({arm, ...records[groupIndex]}))
                globalThis.gc?.()
            }
        } finally {
            await parser.worker.terminate()
        }
    }
} finally {
    await zipReader.close()
}
/**
 * @param {keyof GroupRecord} key
 * @returns {number}
 */
const sum = (key) => records.reduce((total, row) => total + (typeof row[key] === 'number' ? /** @type {number} */ (row[key]) : 0), 0)
assert.equal(sum('rows'), fixture.termRows, 'Parsed row count differs from lock')
const result = {
    scope: 'Correctness-only full pinned dictionary corpus: production 24 MiB lazy groups with media pipeline minimum, real compressed sources, production parser worker, native CRC/shape validation, full columns, canonical content, dedup plans, projected media rows, prepared lookup bytes and routes. Worker parse timing is deliberately not recorded.',
    dictionary: values.dictionary,
    groupingWorkerCount,
    actualWorkerCount: 1,
    node: process.version,
    archiveHash,
    fixtureLockHash: sha256(lockBytes),
    runnerHash: sha256(await readFile(fileURLToPath(import.meta.url))),
    workerBridgeHash: sha256(await readFile(new URL('import-media-presence-worker.js', import.meta.url))),
    sourceIdentities: identities,
    baselineWasmHash: hashes.baseline,
    candidateWasmHash: hashes.candidate,
    banks: banks.length,
    groups: groups.length,
    rows: sum('rows'),
    mediaRows: sum('mediaRows'),
    projectedMediaRows: sum('projectedMediaRows'),
    projectedImageReferences: sum('projectedImageReferences'),
    uniqueImagePaths: imagePaths.size,
    contentBytes: sum('contentBytes'),
    baselineSkippedRows: sum('baselineSkippedRows'),
    candidateSkippedRows: sum('candidateSkippedRows'),
    mediaFreeGroupsSkipped: records.filter((record) => Number(record.candidateSkippedRows) > 0).length,
    baselineFusedFallbacks: sum('baselineFusedFallbacks'),
    candidateFusedFallbacks: sum('candidateFusedFallbacks'),
    digest: outputHash.digest('hex'),
    records,
}
await writeFile(path.resolve(values.output), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({...result, records: void 0}, null, 2))
