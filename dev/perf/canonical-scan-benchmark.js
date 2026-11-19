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
/* eslint-disable no-underscore-dangle -- This component screen deliberately exercises the production metadata owner without opening browser storage. */

import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile, readdir, mkdir, writeFile} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {spawnSync} from 'node:child_process'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {parseArgs} from 'node:util'
import {ZipReader, Uint8ArrayReader, Uint8ArrayWriter} from '@zip.js/zip.js'
import {parseJson} from '../../ext/js/core/json.js'
import {safePerformance} from '../../ext/js/core/safe-performance.js'
import {getHostEnvironment} from './host-environment.js'
import {loadDictionaryFixtures} from './dictionary-fixtures.js'
import {getSourceProvenance, median, parsePositiveInteger} from './benchmark-support.js'

/** @typedef {import('../../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} Database */
/** @typedef {import('../../ext/js/dictionary/term-bank-wasm-parser.js').TermBankColumnChunk} ParsedChunk */
/** @typedef {import('../../ext/js/dictionary/dictionary-database.js').ArtifactTermContentDedupPlan} Plan */
/** @typedef {Omit<ParsedChunk, 'contentDedupPlan'> & {contentBytesBuffer: Uint8Array, contentBytesBaseOffset: number, contentMetaList: Uint32Array, contentUniqueIndexList: Uint32Array, contentDedupPlan: Plan, contentDictNameList: null, uniformContentDictName: string, dictionaryTotalRows: number}} Chunk */
/** @typedef {Awaited<ReturnType<Database['_resolveArtifactTermContentDedup']>>} Resolution */
/** @typedef {Awaited<ReturnType<typeof execute>>} Measurement */
/** @typedef {Measurement & {dictionary: string, fixture: import('./dictionary-fixtures.js').DictionaryFixture, filesPerGroup: number, sourceRoot: string, sourceHashes: Record<string, string>, sourceFingerprint: string, provenance: Awaited<ReturnType<typeof getSourceProvenance>>, fixtureLockSha256: string, node: string, v8: string, warmups: number, existingContent: boolean, hostBefore: ReturnType<typeof getHostEnvironment>, hostAfter: ReturnType<typeof getHostEnvironment>, afterVerificationMemory: {rss: number, heapTotal: number, heapUsed: number, external: number, arrayBuffers: number}, lifetimeMaxRssKiB: number}} ScanResult */
/** @typedef {{arm: string, bracket: number, result: ScanResult}} Observation */

const root = fileURLToPath(new URL('../../', import.meta.url))
const runnerPath = fileURLToPath(import.meta.url)
/** @type {Record<string, number>} */
const groupSizes = {jmdict: 7, jmnedict: 9, jitendex: 10}
const boundary = 'Sum of DictionaryDatabase._resolveArtifactTermContentDedup calls over all pinned dictionary rows. Parser, in-memory content publication, and full-byte verification are outside timing. This is not a browser, OPFS, SQLite, compression, or end-to-end import benchmark.'
const metadataColumns = [
    'HashPairTable',
    'Hash1Table',
    'Hash2Table',
    'StateTable',
    'LengthTable',
    'SignaturePresentTable',
    'Signature1Table',
    'Signature2Table',
    'Signature3Table',
    'IdTable',
    'OffsetTable',
    'DictNameIdTable',
    'RecentSourceBatchIdTable',
    'RecentSourceOffsetTable',
]

/**
 * @param {import('node:crypto').BinaryLike} value
 * @returns {string}
 */
function sha256(value) { return createHash('sha256').update(value).digest('hex') }

/**
 * @param {import('node:crypto').Hash} digest
 * @param {ArrayBufferView} view
 */
function hashView(digest, view) {
    digest.update(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
}

/**
 * Snapshot every JavaScript source module, the two executed WASM artifacts,
 * dependency lock and runner. Refuse a cohort whose code changes mid-run.
 * @param {string} sourceRoot
 * @returns {Promise<Record<string, string>>}
 */
async function sourceHashes(sourceRoot) {
    /** @type {string[]} */
    const files = []
    /** @param {string} directory */
    const visit = async (directory) => {
        for (const entry of await readdir(path.join(sourceRoot, directory), {withFileTypes: true})) {
            const filename = path.join(directory, entry.name)
            if (entry.isDirectory()) {
                await visit(filename)
            } else if (entry.name.endsWith('.js')) {
                files.push(filename)
            }
        }
    }
    await visit('ext/js')
    files.push('ext/lib/term-bank-parser.wasm', 'ext/lib/term-content-canonical-scan-v1.wasm', 'package-lock.json')
    /** @type {Record<string, string>} */
    const result = {}
    for (const file of files.sort()) { result[file] = sha256(await readFile(path.join(sourceRoot, file))) }
    result['benchmark-runner'] = sha256(await readFile(runnerPath))
    return result
}

/**
 * Full-byte oracle for every row, including aliases of deduplicated content.
 * No hash or sampled signature is accepted as evidence of byte equality.
 * @param {Chunk} chunk
 * @param {Map<number, Uint8Array>} storage
 * @param {import('node:crypto').Hash} inputDigest
 * @param {import('node:crypto').Hash} outputDigest
 * @param {import('node:crypto').Hash} referenceDigest
 * @returns {number}
 */
export function verifyCanonicalRows(chunk, storage, inputDigest, outputDigest, referenceDigest) {
    const plan = chunk.contentDedupPlan
    const offsets = new Float64Array(chunk.rowCount)
    const lengths = new Uint32Array(chunk.rowCount)
    let bytes = 0
    for (let row = 0; row < chunk.rowCount; ++row) {
        const unique = chunk.contentUniqueIndexList[row]
        assert.ok(unique < plan.resolvedFlags.length, `Invalid unique index at row ${row}`)
        assert.equal(plan.resolvedFlags[unique], 1, `Unpublished row ${row}`)
        const dictName = plan.resolvedDictNames === null ? plan.resolvedUniformDictName : plan.resolvedDictNames[unique]
        assert.equal(dictName, chunk.uniformContentDictName, `Wrong content representation at row ${row}`)
        const offset = plan.resolvedOffsets[unique]
        const length = plan.resolvedLengths[unique]
        const stored = storage.get(offset)
        assert.ok(stored, `Missing content at row ${row}, offset ${offset}`)
        assert.equal(stored.byteLength, length, `Wrong content length at row ${row}`)
        const meta = row * 4
        const start = chunk.contentBytesBaseOffset + chunk.contentMetaList[meta]
        const expectedLength = chunk.contentMetaList[meta + 1]
        assert.ok(Number.isSafeInteger(start) && start >= 0 && start + expectedLength <= chunk.contentBytesBuffer.byteLength)
        const expected = chunk.contentBytesBuffer.subarray(start, start + expectedLength)
        assert.equal(Buffer.compare(stored, expected), 0, `Canonical bytes differ at row ${row}`)
        inputDigest.update(expected)
        outputDigest.update(stored)
        offsets[row] = offset
        lengths[row] = length
        bytes += length
    }
    hashView(referenceDigest, offsets)
    hashView(referenceDigest, lengths)
    for (const view of [plan.resolvedFlags, plan.resolvedOffsets, plan.resolvedLengths, plan.pendingEpochs, plan.pendingIndexes]) {
        hashView(referenceDigest, view)
    }
    referenceDigest.update(JSON.stringify([plan.resolvedUniformDictName, plan.resolvedDictNames, plan.nextEpoch]))
    return bytes
}

/**
 * Model only the persistence boundary: own the exact canonical bytes and give
 * them deterministic offsets, then call production metadata publication. The
 * production exact matcher still compares the entire payload on every hit.
 * @param {Database} database
 * @param {Chunk} chunk
 * @param {Resolution} result
 * @param {Map<number, Uint8Array>} storage
 * @param {number} cursor
 * @returns {number}
 */
function publish(database, chunk, result, storage, cursor) {
    const {pendingContentCount: count, pendingContentSpans: spans, pendingPlanUniqueIndexes: uniqueIndexes} = result
    assert.ok(spans !== null, 'Canonical content spans are required')
    assert.equal(uniqueIndexes.length, count)
    const pendingOffsets = new Float64Array(count)
    const pendingLengths = new Uint32Array(count)
    const plan = chunk.contentDedupPlan
    for (let i = 0; i < count; ++i) {
        const sourceOffset = spans.offsets[i]
        const length = spans.lengths[i]
        assert.ok(sourceOffset + length <= spans.buffer.byteLength)
        // Typed-array slice owns data before the parser reuses its WASM heap.
        const bytes = new Uint8Array(length)
        bytes.set(spans.buffer.subarray(sourceOffset, sourceOffset + length))
        storage.set(cursor, bytes)
        pendingOffsets[i] = cursor
        pendingLengths[i] = length
        const unique = uniqueIndexes[i]
        plan.resolvedOffsets[unique] = cursor
        plan.resolvedLengths[unique] = length
        plan.resolvedFlags[unique] = 1
        cursor += Math.max(1, length)
    }
    // This screen uses only the parser's uniform raw-v6 representation.
    plan.resolvedUniformDictName = chunk.uniformContentDictName
    assert.equal(plan.resolvedDictNames, null)
    if (count > 0) {
        database._publishArtifactTermContentMetadata({
            ...result,
            count: chunk.rowCount,
            pendingOffsets,
            pendingLengths,
            pendingResolvedDictNames: chunk.uniformContentDictName,
            contentDedupPlan: plan,
            contentUniqueIndexList: chunk.contentUniqueIndexList,
            useResolvedContentReferences: true,
        })
    }
    assert.equal(database._termEntryContentMetaHashPairPendingCount, 0, 'Unpublished metadata remains')
    return cursor
}

/**
 * @param {{Database: typeof import('../../ext/js/dictionary/dictionary-database.js').DictionaryDatabase, Scanner: typeof import('../../ext/js/dictionary/term-content-canonical-scan.js').NativeCanonicalScanner, parser: typeof import('../../ext/js/dictionary/term-bank-wasm-parser.js'), module: WebAssembly.Module, contentDictName: string}} runtime
 * @param {Uint8Array[]} sources
 * @param {number} filesPerGroup
 * @param {number} expectedRows
 * @param {boolean} existingContent
 * @param {boolean} verify
 * @returns {Promise<{resolveMs: number, publicationMs: number, rows: number, groups: number, contentBytes: number, storedUniqueContents: number, storedBytes: number, pendingHits: number, persistedHits: number, exactFallbacks: number, recentSourceHits: number, metadataArenaBytes: number, scannerStats: Record<string, number|string>, sourceContentSha256: string|null, resolvedContentSha256: string|null, referencesSha256: string|null, metadataSha256: string|null, storageSha256: string|null}>}
 */
async function execute(runtime, sources, filesPerGroup, expectedRows, existingContent, verify) {
    const database = new runtime.Database()
    const scanner = new runtime.Scanner({loadModule: async () => runtime.module})
    database._nativeCanonicalScanner = scanner
    /** @type {Map<number, Uint8Array>} */
    const storage = new Map()
    database._readTermEntryContentBytesDetailed = async (offset, length, dictName) => {
        const bytes = storage.get(offset)
        assert.ok(bytes, `Missing stored exact-match candidate at ${offset}`)
        assert.equal(bytes.byteLength, length)
        assert.equal(dictName, runtime.contentDictName)
        return {status: 'ok', bytes}
    }
    let cursor = 1
    let resolveMs = 0
    let publicationMs = 0
    let rows = 0
    let groups = 0
    let contentBytes = 0
    let pendingHits = 0
    let persistedHits = 0
    let exactFallbacks = 0
    let recentSourceHits = 0
    let metadataArenaBytes = 0
    const sourceDigest = createHash('sha256')
    const resolvedDigest = createHash('sha256')
    const referencesDigest = createHash('sha256')
    /** @param {boolean} measured */
    const pass = async (measured) => {
        let passRows = 0
        for (let start = 0; start < sources.length; start += filesPerGroup) {
            await runtime.parser.parseTermBankWithWasmColumnChunks(sources.slice(start, start + filesPerGroup), 3, async (parsed) => {
                assert.ok(parsed.contentBytesBuffer && parsed.contentMetaList && parsed.contentUniqueIndexList && parsed.contentDedupPlan)
                assert.equal(typeof parsed.contentBytesBaseOffset, 'number')
                const chunk = /** @type {Chunk} */ ({...parsed,
                    contentDictNameList: null,
                    uniformContentDictName: runtime.contentDictName,
                    dictionaryTotalRows: expectedRows})
                const before = safePerformance.now()
                const result = await database._resolveArtifactTermContentDedup(chunk, true)
                const elapsed = safePerformance.now() - before
                const publicationStart = safePerformance.now()
                cursor = publish(database, chunk, result, storage, cursor)
                if (measured) {
                    resolveMs += elapsed
                    publicationMs += safePerformance.now() - publicationStart
                    rows += chunk.rowCount
                    ++groups
                    pendingHits += result.pendingHitCount
                    persistedHits += result.persistedHitCount
                    exactFallbacks += result.exactFallbackCount
                    recentSourceHits += result.recentSourceHitCount ?? 0
                    metadataArenaBytes = Math.max(metadataArenaBytes, database._termContentMetadataArena?.memory.buffer.byteLength ?? 0)
                    if (verify) { contentBytes += verifyCanonicalRows(chunk, storage, sourceDigest, resolvedDigest, referencesDigest) }
                }
                passRows += chunk.rowCount
            }, 2048, {
                singleChunk: true,
                emitTermByteLists: false,
                computeContentHashes: true,
                emitContentSlab: true,
                emitTokenBinaryContent: true,
                mediaHintFastScan: true,
                prepareLookupIndexes: false,
            })
        }
        assert.equal(passRows, expectedRows, 'Parsed dictionary row count differs from lock')
    }
    if (existingContent) { await pass(false) }
    /** @type {Record<string, number|string>} */
    const beforeStats = {...scanner.stats}
    await pass(true)
    assert.equal(rows, expectedRows)
    /** @type {Record<string, number|string>} */
    const scannerStats = {}
    for (const [key, value] of Object.entries(scanner.stats)) {
        const previous = beforeStats[key]
        scannerStats[key] = typeof value === 'number' && typeof previous === 'number' ? value - previous : value
    }
    assert.ok(Number(scannerStats.calls) > 0, 'Native scanner was not exercised')
    assert.equal(scannerStats.fallbacks, 0, 'Unexpected native scanner fallback')
    const metadataDigest = createHash('sha256')
    const storageDigest = createHash('sha256')
    if (verify) {
        const owner = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (database))
        for (const name of metadataColumns) {
            const column = owner[`_termEntryContentMeta${name}`]
            assert.ok(ArrayBuffer.isView(column), `Missing metadata column ${name}`)
            metadataDigest.update(name)
            hashView(metadataDigest, column)
        }
        metadataDigest.update(JSON.stringify({
            dense: database._termEntryContentMetaDenseCount,
            published: database._termEntryContentMetaHashPairCount,
            pending: database._termEntryContentMetaHashPairPendingCount,
            free: database._termEntryContentMetaFreeIndexes,
            collisions: [...database._termEntryContentMetaCollisionsByHashPair],
        }))
        const identity = new Float64Array(2)
        for (const [offset, bytes] of storage) {
            identity[0] = offset
            identity[1] = bytes.byteLength
            hashView(storageDigest, identity)
            storageDigest.update(bytes)
        }
    }
    const sourceContentSha256 = verify ? sourceDigest.digest('hex') : null
    const resolvedContentSha256 = verify ? resolvedDigest.digest('hex') : null
    assert.equal(resolvedContentSha256, sourceContentSha256, 'All-row canonical content digest differs')
    return {resolveMs,
        publicationMs,
        rows,
        groups,
        contentBytes,
        storedUniqueContents: storage.size,
        storedBytes: cursor - 1,
        pendingHits,
        persistedHits,
        exactFallbacks,
        recentSourceHits,
        metadataArenaBytes,
        scannerStats,
        sourceContentSha256,
        resolvedContentSha256,
        referencesSha256: verify ? referencesDigest.digest('hex') : null,
        metadataSha256: verify ? metadataDigest.digest('hex') : null,
        storageSha256: verify ? storageDigest.digest('hex') : null}
}

/**
 * @param {string} dictionary
 * @param {string} cacheDir
 * @param {string} sourceRoot
 * @param {boolean} existingContent
 * @param {number} warmups
 * @returns {Promise<ScanResult>}
 */
async function measure(dictionary, cacheDir, sourceRoot, existingContent, warmups) {
    const beforeHashes = await sourceHashes(sourceRoot)
    const fixtures = await loadDictionaryFixtures()
    const fixture = fixtures[dictionary]
    const archive = await readFile(path.join(cacheDir, fixture.cacheFile))
    assert.equal(archive.byteLength, fixture.sizeBytes)
    assert.equal(sha256(archive), fixture.sha256, 'Fixture differs from performance lock')
    /** @type {Uint8Array[]} */
    const sources = []
    const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(archive)))
    try {
        const entries = (await reader.getEntries()).filter((entry) => /^term_bank_\d+\.json$/.test(entry.filename))
            .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)))
        for (const [index, entry] of entries.entries()) {
            assert.equal(entry.filename, `term_bank_${index + 1}.json`, 'Term bank sequence is incomplete')
            if (typeof entry.getData !== 'function') { throw new Error('Unreadable term bank') }
            sources.push(await entry.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true}))
        }
    } finally { await reader.close() }
    // These paths are explicitly selected source checkouts, never archive data.
    // eslint-disable-next-line no-unsanitized/method, @typescript-eslint/no-unsafe-assignment
    const parser = /** @type {typeof import('../../ext/js/dictionary/term-bank-wasm-parser.js')} */ (await import(pathToFileURL(path.join(sourceRoot, 'ext/js/dictionary/term-bank-wasm-parser.js')).href))
    // eslint-disable-next-line no-unsanitized/method, @typescript-eslint/no-unsafe-assignment
    const {DictionaryDatabase} = /** @type {typeof import('../../ext/js/dictionary/dictionary-database.js')} */ (await import(pathToFileURL(path.join(sourceRoot, 'ext/js/dictionary/dictionary-database.js')).href))
    // eslint-disable-next-line no-unsanitized/method, @typescript-eslint/no-unsafe-assignment
    const {NativeCanonicalScanner} = /** @type {typeof import('../../ext/js/dictionary/term-content-canonical-scan.js')} */ (await import(pathToFileURL(path.join(sourceRoot, 'ext/js/dictionary/term-content-canonical-scan.js')).href))
    parser.setTermBankWasmModule(await WebAssembly.compile(await readFile(path.join(sourceRoot, 'ext/lib/term-bank-parser.wasm'))))
    const module = await WebAssembly.compile(await readFile(path.join(sourceRoot, 'ext/lib/term-content-canonical-scan-v1.wasm')))
    const runtime = {Database: DictionaryDatabase, Scanner: NativeCanonicalScanner, parser, module, contentDictName: 'raw-v6'}
    for (let i = 0; i < warmups; ++i) { await execute(runtime, sources, groupSizes[dictionary], fixture.termRows, existingContent, false) }
    globalThis.gc?.()
    const hostBefore = getHostEnvironment()
    const result = await execute(runtime, sources, groupSizes[dictionary], fixture.termRows, existingContent, true)
    const hostAfter = getHostEnvironment()
    assert.deepEqual(await sourceHashes(sourceRoot), beforeHashes, 'Product source changed during observation')
    return {...result,
        dictionary,
        fixture,
        filesPerGroup: groupSizes[dictionary],
        sourceRoot,
        sourceHashes: beforeHashes,
        sourceFingerprint: sha256(JSON.stringify(beforeHashes)),
        provenance: await getSourceProvenance(sourceRoot),
        fixtureLockSha256: sha256(await readFile(path.join(root, 'test/perf/dictionaries.lock.json'))),
        node: process.version,
        v8: process.versions.v8,
        warmups,
        existingContent,
        hostBefore,
        hostAfter,
        afterVerificationMemory: process.memoryUsage(),
        lifetimeMaxRssKiB: process.resourceUsage().maxRSS}
}

/**
 * Each bracket has two adjacent pairs and reverses on the following bracket.
 * @param {number} brackets
 * @param {string} initialOrder
 * @returns {{arm: string, bracket: number}[]}
 */
export function createSchedule(brackets, initialOrder) {
    assert.ok(Number.isSafeInteger(brackets) && brackets > 0)
    assert.ok(initialOrder === 'ABBA' || initialOrder === 'BAAB')
    return Array.from({length: brackets}, (_, bracket) => [...(bracket % 2 === 0 ? initialOrder : [...initialOrder].map((arm) => (arm === 'A' ? 'B' : 'A')).join(''))]
        .map((arm) => ({arm, bracket}))).flat()
}

/**
 * @param {Measurement} a
 * @param {Measurement} b
 */
export function verifyEquivalentResults(a, b) {
    for (const key of ['rows', 'groups', 'contentBytes', 'storedUniqueContents', 'storedBytes', 'pendingHits', 'persistedHits', 'exactFallbacks', 'recentSourceHits', 'sourceContentSha256', 'resolvedContentSha256', 'referencesSha256', 'metadataSha256', 'storageSha256']) {
        const name = /** @type {keyof Measurement} */ (key)
        assert.notEqual(a[name], null, `Missing ${key} oracle`)
        assert.notEqual(a[name], void 0, `Missing ${key} oracle`)
        assert.deepEqual(b[name], a[name], `Component output mismatch: ${key}`)
    }
}

/**
 * @returns {Promise<void>}
 */
async function main() {
    const {values, positionals} = parseArgs({allowPositionals: true,
        options: {
            'child': {type: 'boolean', default: false},
            'control': {type: 'boolean', default: false},
            'brackets': {type: 'string', default: '3'},
            'order': {type: 'string', default: 'ABBA'},
            'mode': {type: 'string', default: 'fresh'},
            'warmups': {type: 'string', default: '1'},
            'source-root': {type: 'string', default: root},
            'baseline-root': {type: 'string', default: root},
            'candidate-root': {type: 'string', default: root},
            'cache-dir': {type: 'string', default: path.join(root, 'builds/e2e-dictionary-cache')},
            'out': {type: 'string', default: path.join(root, 'builds/perf/canonical-scan.json')},
        }})
    const dictionary = positionals[0] ?? 'jmdict'
    assert.ok(positionals.length <= 1 && Object.hasOwn(groupSizes, dictionary), 'Use jmdict, jmnedict or jitendex')
    assert.ok(values.mode === 'fresh' || values.mode === 'existing', 'Mode must be fresh or existing')
    const warmups = values.warmups === '0' ? 0 : parsePositiveInteger(values.warmups, '--warmups')
    if (values.child) {
        console.log(JSON.stringify(await measure(dictionary, values['cache-dir'], path.resolve(values['source-root']), values.mode === 'existing', warmups)))
        return
    }
    const schedule = createSchedule(parsePositiveInteger(values.brackets, '--brackets'), values.order)
    const baselineRoot = path.resolve(values['baseline-root'])
    const candidateRoot = values.control ? baselineRoot : path.resolve(values['candidate-root'])
    await mkdir(path.dirname(path.resolve(values.out)), {recursive: true})
    /** @type {Observation[]} */
    const observations = []
    const plan = {schemaVersion: 1,
        componentOnly: true,
        authoritativeImportTiming: false,
        boundary,
        dictionary,
        mode: values.mode,
        scenario: values.mode === 'existing' ? 'Duplicate continuation within one import session: seed and replay the complete dictionary while retaining metadata and recent sources. Production startBulkImport clears those caches, so this does not model a second dictionary or an update.' : 'First pass through the dictionary with empty content metadata.',
        sameCodeControl: values.control,
        baselineRoot,
        candidateRoot,
        schedule,
        warmups}
    /**
     * @param {object} status
     * @returns {Promise<void>}
     */
    const save = async (status) => writeFile(values.out, `${JSON.stringify({...plan, ...status, observations}, null, 2)}\n`)
    try {
        for (const observation of schedule) {
            /** @type {string[]} */
            const args = [...process.execArgv.filter((arg) => arg.startsWith('--max-old-space-size=')),
                '--expose-gc',
                runnerPath,
                dictionary,
                '--child',
                '--mode',
                values.mode,
                '--warmups',
                String(warmups),
                '--cache-dir',
                path.resolve(values['cache-dir']),
                '--source-root',
observation.arm === 'A' ? baselineRoot : candidateRoot]
            const child = spawnSync(process.execPath, args, {encoding: 'utf8', timeout: 240000, maxBuffer: 16 * 1024 * 1024})
            assert.equal(child.status, 0, `Child failed: ${child.error ?? ''}\n${child.stderr}`)
            const result = /** @type {Awaited<ReturnType<typeof measure>>} */ (parseJson(child.stdout))
            if (observations.length > 0) {
                const previous = observations[0].result
                verifyEquivalentResults(previous, result)
                assert.equal(result.fixture.sha256, previous.fixture.sha256)
                assert.equal(result.fixtureLockSha256, previous.fixtureLockSha256)
            }
            const previousArm = observations.find((row) => row.arm === observation.arm)
            if (previousArm) { assert.equal(result.sourceFingerprint, previousArm.result.sourceFingerprint, 'Source changed across cohort') }
            if (values.control && observations.length > 0) { assert.equal(result.sourceFingerprint, observations[0].result.sourceFingerprint, 'A/A product bytes differ') }
            observations.push({...observation, result})
            await save({complete: false})
            console.log(`${dictionary} ${values.mode} ${observation.arm}${observation.bracket + 1}: ${result.resolveMs.toFixed(3)} ms; native calls=${String(result.scannerStats.calls)} snapshots=${String(result.scannerStats.snapshotBytes)} bytes`)
        }
        const pairedChanges = []
        for (let i = 0; i < observations.length; i += 2) {
            const pair = observations.slice(i, i + 2)
            const a = pair.find((entry) => entry.arm === 'A')
            const b = pair.find((entry) => entry.arm === 'B')
            assert.ok(a && b && a.result.resolveMs > 0 && b.result.resolveMs > 0)
            pairedChanges.push(100 * (b.result.resolveMs / a.result.resolveMs - 1))
        }
        const armTotals = (/** @type {string} */ arm) => observations.filter((entry) => entry.arm === arm).map((entry) => entry.result.resolveMs)
        const a = armTotals('A')
        const b = armTotals('B')
        const sum = (/** @type {number[]} */ entries) => entries.reduce((total, value) => total + value, 0)
        const summary = {baselineMedianMs: median(a),
            candidateMedianMs: median(b),
            medianPairedChangePercent: median(pairedChanges),
            equalWorkChangePercent: 100 * (sum(b) / sum(a) - 1),
            fasterPairs: pairedChanges.filter((value) => value < 0).length,
            pairs: pairedChanges.length,
            pairedChanges}
        await save({complete: true, summary})
        console.log(JSON.stringify(summary))
    } catch (error) {
        await save({complete: false, error: String(error)})
        throw error
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === runnerPath) { await main() }

/* eslint-enable no-underscore-dangle */
