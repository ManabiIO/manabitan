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
// This component screen deliberately instruments the production private methods.
/* eslint no-underscore-dangle: ["error", {"allow": ["_nativeCanonicalScanner", "_findMatchingPersistedTermEntryContentMetaBatch", "_readTermEntryContentBytesDetailedBatch", "_resolveArtifactTermContentDedup", "_publishArtifactTermContentMetadata", "_recentTermContentSourceBatchBytes", "_termEntryContentMetaHashPairPendingCount", "_recentTermContentSourceCacheMaxBytes"]}] */

/**
 * Real-corpus canonical-content deduplication component screen.
 *
 * node dev/perf/import-dedup-screen.js jmdict --baseline-root /path/to/base --pairs 8
 * Add --device-memory-gib 8 to exercise the browser's existing high-memory policy.
 * Without that option, the runtime's real device-memory hint is left untouched.
 *
 * Fixture decoding, WASM compilation, parser execution, warmups, virtual storage
 * writes and complete output verification are outside the resolver timer. The
 * backing map serves exact bytes without compression, disk I/O or promises that
 * model disk latency. Results are NOT browser or whole-import measurements.
 */

import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {parseArgs} from 'node:util'
import {ZipReader, Uint8ArrayReader, Uint8ArrayWriter} from '@zip.js/zip.js'
import {parseJson} from '../../ext/js/core/json.js'
import {safePerformance} from '../../ext/js/core/safe-performance.js'
import {loadDictionaryWasm} from '../dictionary-wasm.js'
import {getHostEnvironment} from './host-environment.js'

/** @typedef {import('../../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} Database */
/** @typedef {import('../../ext/js/dictionary/dictionary-database.js').ArtifactTermContentChunk} ContentChunk */
/** @typedef {import('../../ext/js/dictionary/dictionary-database.js').ArtifactTermContentDedupPlan} ContentPlan */
/** @typedef {Awaited<ReturnType<Database['_resolveArtifactTermContentDedup']>>} Resolution */
/** @typedef {typeof import('../../ext/js/dictionary/term-bank-wasm-parser.js')} Parser */
/** @typedef {import('../../ext/js/dictionary/term-content-canonical-scan.js').NativeCanonicalScanner} CanonicalScanner */
/** @typedef {{rowCount: number, contentBytesBuffer: Uint8Array, contentMetaList: Uint32Array, contentUniqueIndexList: Uint32Array, uniqueRowIndexes: Uint32Array, uniqueSignatures: Uint32Array}} FixtureChunk */
/** @typedef {import('./dictionary-fixtures.js').DictionaryFixture} Fixture */
/** @typedef {{offset: number, length: number, hash1: number, hash2: number, bytes: Uint8Array}} VirtualContent */
/** @typedef {{wallMs: number, cpuMs: number}} Duration */
/** @typedef {{wall: number, cpu: ReturnType<typeof process.cpuUsage>}} TimingStart */
/** @typedef {{rows: number, pendingHits: number, persistedHits: number, uniqueContent: number, exactFallbacks: number, recentSourceHits: number, exactCalls: number, exactDescriptors: number, storageReadCalls: number, storageReadEntries: number, peakRecentSourceBytes: number}} Counters */
/**
 * @typedef {object} Measurement
 * @property {Duration} resolver
 * @property {Duration} exact
 * @property {Duration} publication
 * @property {number} ownerExactMs
 * @property {Counters} counters
 * @property {string} referenceDigest
 * @property {string} canonicalContentDigest
 * @property {string} resolvedContentDigest
 * @property {CanonicalScanner['stats']} nativeStats
 * @property {number} recentSourceCacheBudgetBytes
 * @property {string} scope
 * @property {boolean} authoritativeWholeImportTiming
 * @property {string} cpuBoundary
 * @property {string[]} exclusions
 * @property {string} dictionary
 * @property {string} sourceRoot
 * @property {ReturnType<typeof sourceGitIdentity>} sourceGit
 * @property {Record<string, unknown>} hostBefore
 * @property {Record<string, unknown>} hostAfter
 * @property {number} filesPerGroup
 * @property {Array<{rows: number, uniqueContent: number, sourceBytes: number}>} groups
 * @property {number|null} deviceMemoryGiB
 * @property {number} warmupCount
 * @property {string} node
 * @property {string} v8
 * @property {string} archiveSha256
 * @property {string} lockSha256
 * @property {Record<string, string>} sourceHashes
 * @property {Record<string, string>} runnerSourceHashes
 * @property {string} runnerSha256
 * @property {string} sourceContentDigest
 * @property {number} encodedSourceBytes
 * @property {ReturnType<typeof process.memoryUsage>} harnessMemoryAfterVerification
 * @property {number} harnessLifetimeMaxRssKiB
 */
/** @typedef {{pair: number, arm: string, status: string, result?: Awaited<ReturnType<typeof measure>>, error?: string, stdout?: string, stderr?: string, exitCode?: number|null, signal?: string|null}} Observation */

const root = fileURLToPath(new URL('../../', import.meta.url))
const filename = fileURLToPath(import.meta.url)
/** Same fixed component grouping as import-lookup-screen.js; not browser scheduling. @type {Record<string, number>} */
const filesPerGroup = {jmdict: 7, jmnedict: 9, jitendex: 10}
// Production direct-block eligibility is real; block writes/reads are virtual.
const virtualDictName = 'raw-block-v2:jmdict'
const runnerFiles = [
    'dev/perf/import-dedup-screen.js',
    'dev/perf/host-environment.js',
    'dev/dictionary-wasm.js',
    'dev/json.js',
    'ext/js/core/json.js',
    'ext/js/core/safe-performance.js',
    'test/perf/dictionaries.lock.json',
    'package-lock.json',
]
const sourceFiles = [
    'package.json',
    'package-lock.json',
    'ext/js/dictionary/dictionary-database.js',
    'ext/js/dictionary/term-bank-wasm-parser.js',
    'ext/js/dictionary/term-bank-experiments.js',
    'ext/js/dictionary/term-content-canonical-layout.js',
    'ext/js/dictionary/term-content-canonical-scan.js',
    'ext/js/dictionary/term-content-metadata-arena.js',
    'ext/js/dictionary/term-content-block-store.js',
    'ext/js/dictionary/term-entry-content-hash.js',
    'ext/js/dictionary/raw-term-content.js',
    'ext/js/dictionary/wasm/term-bank-parser.c',
    'ext/js/dictionary/wasm/term-content-canonical-scan-v1.c',
    'dev/data/dictionary-wasm/manifest.json',
    'ext/lib/term-bank-parser.wasm',
    'ext/lib/term-content-canonical-scan-v1.wasm',
]

/**
 * @param {import('node:crypto').BinaryLike} bytes
 * @returns {string}
 */
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }

/**
 * @param {string} sourceRoot
 * @param {string[]} [files]
 * @returns {Promise<Record<string, string>>}
 */
async function sourceIdentity(sourceRoot, files = sourceFiles) {
    /** @type {Record<string, string>} */
    const hashes = {}
    for (const file of files) { hashes[file] = sha256(await readFile(path.join(sourceRoot, file))) }
    return hashes
}

/**
 * @param {string} sourceRoot
 * @returns {{commit: string|null, dirty: boolean|null, status: string|null, trackedDiffSha256: string|null, error: string|null}}
 */
function sourceGitIdentity(sourceRoot) {
    const commit = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {cwd: sourceRoot, encoding: 'utf8'})
    const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=normal'], {cwd: sourceRoot, encoding: 'utf8'})
    const diff = spawnSync('git', ['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--'], {cwd: sourceRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024})
    const failure = [commit, status, diff].find((result) => result.error || result.status !== 0)
    return {
        commit: commit.status === 0 ? commit.stdout.trim() : null,
        dirty: status.status === 0 ? status.stdout.length > 0 : null,
        status: status.status === 0 ? status.stdout : null,
        trackedDiffSha256: diff.status === 0 ? sha256(diff.stdout) : null,
        error: typeof failure === 'undefined' ? null : String(failure.error ?? failure.stderr),
    }
}

/** @returns {TimingStart} */
function startTiming() { return {wall: safePerformance.now(), cpu: process.cpuUsage()} }

/**
 * @param {TimingStart} start
 * @returns {Duration}
 */
function endTiming(start) {
    const cpu = process.cpuUsage(start.cpu)
    return {wallMs: safePerformance.now() - start.wall, cpuMs: (cpu.user + cpu.system) / 1000}
}

/**
 * @param {Duration} total
 * @param {Duration} part
 */
function addDuration(total, part) {
    total.wallMs += part.wallMs
    total.cpuMs += part.cpuMs
}

/**
 * Preserve the production cache policy; this is an explicit device-hint scenario.
 * @param {number|null} deviceMemoryGiB
 */
function setDeviceMemoryScenario(deviceMemoryGiB) {
    if (deviceMemoryGiB === null) { return }
    if (typeof globalThis.navigator === 'undefined') {
        Object.defineProperty(globalThis, 'navigator', {value: {}, configurable: true})
    }
    Object.defineProperty(globalThis.navigator, 'deviceMemory', {value: deviceMemoryGiB, configurable: true})
}

/**
 * @param {Parser} parser
 * @param {string} dictionary
 * @param {string} cacheDir
 * @param {string} sourceRoot
 * @returns {Promise<{chunks: FixtureChunk[], fixture: Fixture, archiveSha256: string, lockSha256: string, sourceContentDigest: string, encodedSourceBytes: number}>}
 * @throws {Error} If fixture identity, parser ownership or canonical plans are invalid.
 */
async function loadChunks(parser, dictionary, cacheDir, sourceRoot) {
    const lockBytes = await readFile(path.join(root, 'test/perf/dictionaries.lock.json'))
    const lock = /** @type {{schemaVersion: number, dictionaries: Record<string, Fixture>}} */ (parseJson(lockBytes.toString()))
    const fixture = lock.dictionaries?.[dictionary]
    if (lock.schemaVersion !== 1 || !fixture) { throw new Error('Invalid dictionary fixture lock') }
    const archive = await readFile(path.join(cacheDir, fixture.cacheFile))
    const archiveSha256 = sha256(archive)
    if (archive.byteLength !== fixture.sizeBytes || archiveSha256 !== fixture.sha256) {
        throw new Error(`Pinned ${dictionary} archive size or SHA-256 does not match the lock`)
    }
    const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(archive)))
    /** @type {Uint8Array[]} */
    const sources = []
    try {
        const entries = await reader.getEntries()
        const index = entries.find((entry) => entry.filename === 'index.json')
        if (!index?.getData) { throw new Error('Missing dictionary index') }
        const indexBytes = await index.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true})
        const info = /** @type {{title: string, revision: string, format: number}} */ (parseJson(new TextDecoder().decode(indexBytes)))
        if (info.title !== fixture.expectedTitle || info.revision !== fixture.revision || info.format !== 3) {
            throw new Error('Dictionary index does not match the locked format, title and revision')
        }
        const banks = entries.filter((entry) => /^term_bank_\d+\.json$/.test(entry.filename))
            .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)))
        for (const entry of banks) {
            if (!entry.getData) { throw new Error(`Unreadable term bank: ${entry.filename}`) }
            sources.push(await entry.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true}))
        }
    } finally { await reader.close() }
    parser.setTermBankWasmModule(await WebAssembly.compile(await readFile(path.join(sourceRoot, 'ext/lib/term-bank-parser.wasm'))))
    /** @type {FixtureChunk[]} */
    const chunks = []
    for (let start = 0; start < sources.length; start += filesPerGroup[dictionary]) {
        await parser.parseTermBankWithWasmColumnChunks(sources.slice(start, start + filesPerGroup[dictionary]), 3, (chunk) => {
            // The next parse resets the WASM arena. Copy before returning the sink.
            const owned = parser.copyWasmBackedColumnChunk(chunk)
            /** @type {unknown} */
            const plan = owned.contentDedupPlan
            if (
                !(owned.contentBytesBuffer instanceof Uint8Array) ||
                !(owned.contentMetaList instanceof Uint32Array) ||
                !(owned.contentUniqueIndexList instanceof Uint32Array) ||
                typeof plan !== 'object' || plan === null ||
                !('uniqueRowIndexes' in plan) || !('uniqueSignatures' in plan) ||
                !(plan.uniqueRowIndexes instanceof Uint32Array) ||
                !(plan.uniqueSignatures instanceof Uint32Array) ||
                owned.contentBytesBaseOffset !== 0 || owned.contentRowStart !== 0 ||
                owned.contentMetaList.length !== owned.rowCount * 4 ||
                owned.contentUniqueIndexList.length !== owned.rowCount ||
                plan.uniqueSignatures.length !== plan.uniqueRowIndexes.length * 3
            ) {
                throw new Error('Parser did not produce an owned complete canonical content group')
            }
            chunks.push({
                rowCount: owned.rowCount,
                contentBytesBuffer: owned.contentBytesBuffer,
                contentMetaList: owned.contentMetaList,
                contentUniqueIndexList: owned.contentUniqueIndexList,
                uniqueRowIndexes: new Uint32Array(plan.uniqueRowIndexes),
                uniqueSignatures: new Uint32Array(plan.uniqueSignatures),
            })
        }, 2048, {
            singleChunk: true,
            emitTermByteLists: false,
            computeContentHashes: true,
            emitContentSlab: true,
            emitTokenBinaryContent: true,
            mediaHintFastScan: true,
            validateGlossaryTypes: true,
            prepareLookupIndexes: true,
        })
    }
    if (chunks.reduce((count, chunk) => count + chunk.rowCount, 0) !== fixture.termRows) {
        throw new Error('Complete parsed term count differs from the fixture lock')
    }
    const contentHash = createHash('sha256')
    let encodedSourceBytes = 0
    const header = Buffer.alloc(12)
    for (const chunk of chunks) {
        for (let row = 0; row < chunk.rowCount; ++row) {
            const at = row * 4
            const offset = chunk.contentMetaList[at]
            const length = chunk.contentMetaList[at + 1]
            if (offset > chunk.contentBytesBuffer.length || length > chunk.contentBytesBuffer.length - offset) {
                throw new Error('Parser content span is out of bounds')
            }
            header.writeUInt32LE(length, 0)
            header.writeUInt32LE(chunk.contentMetaList[at + 2], 4)
            header.writeUInt32LE(chunk.contentMetaList[at + 3], 8)
            contentHash.update(header)
            contentHash.update(chunk.contentBytesBuffer.subarray(offset, offset + length))
            encodedSourceBytes += length
        }
    }
    return {chunks, fixture, archiveSha256, lockSha256: sha256(lockBytes), sourceContentDigest: contentHash.digest('hex'), encodedSourceBytes}
}

/**
 * @param {FixtureChunk} fixture
 * @returns {ContentChunk & {contentDedupPlan: ContentPlan}}
 */
function freshChunk(fixture) {
    const uniqueCount = fixture.uniqueRowIndexes.length
    return {
        ...fixture,
        contentRowStart: 0,
        contentBytesBaseOffset: 0,
        contentBytesList: [],
        contentHash1List: new Uint32Array(0),
        contentHash2List: new Uint32Array(0),
        contentDictNameList: null,
        uniformContentDictName: virtualDictName,
        useResolvedContentReferences: true,
        contentDedupPlan: {
            uniqueCount,
            sourceRowCount: fixture.rowCount,
            uniqueRowIndexes: fixture.uniqueRowIndexes,
            uniqueSignatures: fixture.uniqueSignatures,
            resolvedFlags: new Uint8Array(uniqueCount),
            resolvedOffsets: new Float64Array(uniqueCount),
            resolvedLengths: new Uint32Array(uniqueCount),
            resolvedDictNames: null,
            pendingEpochs: new Uint32Array(uniqueCount),
            pendingIndexes: new Uint32Array(uniqueCount),
            pendingSpanOffsetsScratch: new Uint32Array(fixture.rowCount),
            pendingSpanLengthsScratch: new Uint32Array(fixture.rowCount),
            nextEpoch: 1,
            nextUnresolvedUniqueIndex: 0,
        },
    }
}

/**
 * Supply completed persistence results to the production publication method.
 * Only virtual-offset assignment and the storage boundary are simulated.
 * @param {ContentChunk & {contentDedupPlan: ContentPlan}} chunk
 * @param {Resolution} dedup
 * @param {Map<number, VirtualContent>} storage
 * @param {number} cursor
 * @returns {{pendingOffsets: Float64Array, pendingLengths: Uint32Array, cursor: number}}
 * @throws {Error} If resolved dictionary mappings or pending references are invalid.
 */
function storePending(chunk, dedup, storage, cursor) {
    const plan = chunk.contentDedupPlan
    // Check resolver-owned mappings before simulating publication of new bytes.
    // Assigning the uniform name unconditionally would conceal missing or wrong
    // mappings in mixed-hit groups and in groups with no pending content.
    assert.equal(plan.resolvedDictNames, null, 'Unexpected per-entry dictionary mapping')
    if (plan.resolvedFlags.includes(1)) {
        assert.equal(plan.resolvedUniformDictName, virtualDictName, 'Resolved hit has the wrong dictionary mapping')
    }
    const pendingOffsets = new Float64Array(dedup.pendingContentCount)
    const pendingLengths = new Uint32Array(dedup.pendingContentCount)
    for (let i = 0; i < dedup.pendingContentCount; ++i) {
        const spans = dedup.pendingContentSpans
        const bytes = spans === null ?
            dedup.pendingContentBytes[i] :
            spans.buffer.subarray(spans.offsets[i], spans.offsets[i] + spans.lengths[i])
        pendingOffsets[i] = cursor
        pendingLengths[i] = bytes.length
        storage.set(cursor, {offset: cursor, length: bytes.length, hash1: dedup.pendingContentHash1s[i], hash2: dedup.pendingContentHash2s[i], bytes})
        // Distinct empty payloads must not alias the next virtual address.
        cursor += Math.max(1, bytes.length)
        if (!Number.isSafeInteger(cursor)) { throw new RangeError('Virtual content offset overflow') }
        const uniqueIndex = dedup.pendingPlanUniqueStart === null ? dedup.pendingPlanUniqueIndexes[i] : dedup.pendingPlanUniqueStart + i
        assert.ok(Number.isSafeInteger(uniqueIndex) && uniqueIndex >= 0 && uniqueIndex < plan.resolvedFlags.length, 'Pending unique index is invalid')
        assert.equal(plan.resolvedFlags[uniqueIndex], 0, 'Pending content would overwrite a resolved hit')
        plan.resolvedOffsets[uniqueIndex] = pendingOffsets[i]
        plan.resolvedLengths[uniqueIndex] = pendingLengths[i]
        plan.resolvedUniformDictName = virtualDictName
        plan.resolvedFlags[uniqueIndex] = 1
    }
    return {pendingOffsets, pendingLengths, cursor}
}

/**
 * @param {string} dictionary
 * @param {string} cacheDir
 * @param {string} sourceRoot
 * @param {number|null} deviceMemoryGiB
 * @returns {Promise<Measurement>} Complete verified component measurement and provenance.
 * @throws {Error} If provenance, content or reference verification fails.
 */
async function measure(dictionary, cacheDir, sourceRoot, deviceMemoryGiB) {
    setDeviceMemoryScenario(deviceMemoryGiB)
    const initialIdentity = await sourceIdentity(sourceRoot)
    const initialRunnerIdentity = await sourceIdentity(root, runnerFiles)
    const sourceGit = sourceGitIdentity(sourceRoot)
    const verifiedWasm = loadDictionaryWasm(sourceRoot)
    for (const [name, bytes] of verifiedWasm) {
        assert.deepEqual(await readFile(path.join(sourceRoot, 'ext/lib', name)), bytes, `Generated ${name} differs from its source-verified artifact`)
    }
    // Only the caller-selected local worktree supplies modules, never the archive.
    // eslint-disable-next-line no-unsanitized/method, @typescript-eslint/no-unsafe-assignment
    const parser = /** @type {Parser} */ (await import(pathToFileURL(path.join(sourceRoot, 'ext/js/dictionary/term-bank-wasm-parser.js')).href))
    // eslint-disable-next-line no-unsanitized/method, @typescript-eslint/no-unsafe-assignment
    const {DictionaryDatabase} = /** @type {typeof import('../../ext/js/dictionary/dictionary-database.js')} */ (await import(pathToFileURL(path.join(sourceRoot, 'ext/js/dictionary/dictionary-database.js')).href))
    // eslint-disable-next-line no-unsanitized/method, @typescript-eslint/no-unsafe-assignment
    const {NativeCanonicalScanner} = /** @type {typeof import('../../ext/js/dictionary/term-content-canonical-scan.js')} */ (await import(pathToFileURL(path.join(sourceRoot, 'ext/js/dictionary/term-content-canonical-scan.js')).href))
    const canonicalModule = await WebAssembly.compile(await readFile(path.join(sourceRoot, 'ext/lib/term-content-canonical-scan-v1.wasm')))
    const fixture = await loadChunks(parser, dictionary, cacheDir, sourceRoot)

    const execute = async () => {
        const database = new DictionaryDatabase()
        const scanner = new NativeCanonicalScanner({loadModule: async () => canonicalModule})
        database._nativeCanonicalScanner = scanner
        const chunks = fixture.chunks.map(freshChunk)
        /** @type {Map<number, VirtualContent>} */
        const storage = new Map()
        const resolver = {wallMs: 0, cpuMs: 0}
        const exact = {wallMs: 0, cpuMs: 0}
        const publication = {wallMs: 0, cpuMs: 0}
        const counters = {rows: 0, pendingHits: 0, persistedHits: 0, uniqueContent: 0, exactFallbacks: 0, recentSourceHits: 0, exactCalls: 0, exactDescriptors: 0, storageReadCalls: 0, storageReadEntries: 0, peakRecentSourceBytes: 0}
        let ownerExactMs = 0
        let cursor = 0
        const originalExact = database._findMatchingPersistedTermEntryContentMetaBatch.bind(database)
        database._findMatchingPersistedTermEntryContentMetaBatch = async (descriptors) => {
            ++counters.exactCalls
            counters.exactDescriptors += descriptors.length
            const start = startTiming()
            try {
                return await originalExact(descriptors)
            } finally {
                addDuration(exact, endTiming(start))
            }
        }
        database._readTermEntryContentBytesDetailedBatch = async (requests) => {
            ++counters.storageReadCalls
            counters.storageReadEntries += requests.length
            return requests.map(({contentOffset, contentLength, contentDictName}) => {
                const entry = storage.get(contentOffset)
                if (!entry || contentDictName !== virtualDictName || entry.length !== contentLength) {
                    throw new Error('Exact matcher requested an invalid virtual content reference')
                }
                return {status: 'ok', bytes: entry.bytes}
            })
        }
        globalThis.gc?.()
        for (const chunk of chunks) {
            const beforeResolve = startTiming()
            const dedup = await database._resolveArtifactTermContentDedup(chunk, true)
            addDuration(resolver, endTiming(beforeResolve))
            const persisted = storePending(chunk, dedup, storage, cursor)
            cursor = persisted.cursor
            let resolvedDictNames = dedup.resolvedContentDictNames
            if (dedup.pendingContentCount > 0) {
                const beforePublish = startTiming()
                resolvedDictNames = database._publishArtifactTermContentMetadata({
                    ...dedup,
                    count: chunk.rowCount,
                    contentUniqueIndexList: chunk.contentUniqueIndexList ?? void 0,
                    pendingOffsets: persisted.pendingOffsets,
                    pendingLengths: persisted.pendingLengths,
                    pendingResolvedDictNames: virtualDictName,
                    useResolvedContentReferences: true,
                })
                addDuration(publication, endTiming(beforePublish))
            }
            assert.equal(resolvedDictNames, virtualDictName, 'Published dictionary mapping differs from virtual storage')
            counters.rows += chunk.rowCount
            counters.pendingHits += dedup.pendingHitCount
            counters.persistedHits += dedup.persistedHitCount
            counters.uniqueContent += dedup.pendingContentCount
            counters.exactFallbacks += dedup.exactFallbackCount
            counters.recentSourceHits += dedup.recentSourceHitCount ?? 0
            counters.peakRecentSourceBytes = Math.max(counters.peakRecentSourceBytes, database._recentTermContentSourceBatchBytes)
            ownerExactMs += /** @type {Resolution & {dedupExactCompareMs?: number}} */ (dedup).dedupExactCompareMs ?? 0
        }
        if (scanner.stats.fallbacks !== 0) { throw new Error(`Unexpected native canonical fallback: ${scanner.stats.fallbackReason}`) }
        if (database._termEntryContentMetaHashPairPendingCount !== 0) { throw new Error('Unpublished content metadata remains') }
        if (counters.rows !== fixture.fixture.termRows || counters.rows !== counters.pendingHits + counters.persistedHits + counters.uniqueContent) {
            throw new Error('Dedupe row accounting does not cover the full dictionary')
        }

        // Complete equality checks and digests run after all measured phases.
        const resolved = createHash('sha256')
        const references = createHash('sha256').update(virtualDictName)
        const canonical = createHash('sha256').update(virtualDictName)
        const contentHeader = Buffer.alloc(12)
        const referenceHeader = Buffer.alloc(12)
        for (let index = 0; index < chunks.length; ++index) {
            const chunk = chunks[index]
            const source = fixture.chunks[index]
            const plan = chunk.contentDedupPlan
            if (plan.resolvedUniformDictName !== virtualDictName || plan.resolvedDictNames !== null) {
                throw new Error('Unexpected resolved content dictionary mapping')
            }
            for (let row = 0; row < chunk.rowCount; ++row) {
                const uniqueIndex = source.contentUniqueIndexList[row]
                if (plan.resolvedFlags[uniqueIndex] !== 1) { throw new Error('Unresolved source row') }
                const offset = plan.resolvedOffsets[uniqueIndex]
                const length = plan.resolvedLengths[uniqueIndex]
                const content = storage.get(offset)
                const at = row * 4
                const expectedOffset = source.contentMetaList[at]
                const expectedLength = source.contentMetaList[at + 1]
                if (!content || content.length !== length || length !== expectedLength || Buffer.compare(
                    content.bytes,
                    source.contentBytesBuffer.subarray(expectedOffset, expectedOffset + expectedLength),
                ) !== 0) {
                    throw new Error(`Resolved content differs from source at group ${index}, row ${row}`)
                }
                contentHeader.writeUInt32LE(length, 0)
                contentHeader.writeUInt32LE(source.contentMetaList[at + 2], 4)
                contentHeader.writeUInt32LE(source.contentMetaList[at + 3], 8)
                resolved.update(contentHeader).update(content.bytes)
                referenceHeader.writeDoubleLE(offset, 0)
                referenceHeader.writeUInt32LE(length, 8)
                references.update(referenceHeader)
            }
        }
        for (const content of storage.values()) {
            referenceHeader.writeDoubleLE(content.offset, 0)
            referenceHeader.writeUInt32LE(content.length, 8)
            contentHeader.writeUInt32LE(content.length, 0)
            contentHeader.writeUInt32LE(content.hash1, 4)
            contentHeader.writeUInt32LE(content.hash2, 8)
            canonical.update(referenceHeader).update(contentHeader).update(content.bytes)
        }
        const resolvedContentDigest = resolved.digest('hex')
        if (resolvedContentDigest !== fixture.sourceContentDigest) { throw new Error('Complete source/content digest mismatch') }
        return {
            resolver,
            exact,
            publication,
            ownerExactMs,
            counters,
            referenceDigest: references.digest('hex'),
            canonicalContentDigest: canonical.digest('hex'),
            resolvedContentDigest,
            nativeStats: {...scanner.stats},
            recentSourceCacheBudgetBytes: database._recentTermContentSourceCacheMaxBytes,
        }
    }
    const warmups = []
    for (let i = 0; i < 2; ++i) { warmups.push(await execute()) }
    globalThis.gc?.()
    const hostBefore = getHostEnvironment()
    const result = await execute()
    const hostAfter = getHostEnvironment()
    for (const warmup of warmups) {
        assert.deepEqual(correctnessIdentity(warmup), correctnessIdentity(result), 'Warmup and measured output differ')
    }
    assert.deepEqual(await sourceIdentity(sourceRoot), initialIdentity, 'Source changed during child execution')
    assert.deepEqual(sourceGitIdentity(sourceRoot), sourceGit, 'Tracked checkout state changed during child execution')
    assert.deepEqual(await sourceIdentity(root, runnerFiles), initialRunnerIdentity, 'Runner helpers or fixture lock changed during child execution')
    loadDictionaryWasm(sourceRoot)
    return {
        ...result,
        scope: 'canonical-dedup-component-with-virtual-exact-byte-storage',
        authoritativeWholeImportTiming: false,
        cpuBoundary: 'process.cpuUsage; nested exact time overlaps resolver time',
        exclusions: ['fixture I/O', 'ZIP inflation', 'parser', 'compression', 'OPFS', 'worker transport', 'UI', 'virtual writes', 'output verification'],
        dictionary,
        sourceRoot,
        sourceGit,
        hostBefore,
        hostAfter,
        filesPerGroup: filesPerGroup[dictionary],
        groups: fixture.chunks.map((chunk) => ({rows: chunk.rowCount, uniqueContent: chunk.uniqueRowIndexes.length, sourceBytes: chunk.contentBytesBuffer.length})),
        deviceMemoryGiB,
        warmupCount: warmups.length,
        node: process.version,
        v8: process.versions.v8,
        archiveSha256: fixture.archiveSha256,
        lockSha256: fixture.lockSha256,
        sourceHashes: initialIdentity,
        runnerSourceHashes: initialRunnerIdentity,
        runnerSha256: initialRunnerIdentity['dev/perf/import-dedup-screen.js'],
        sourceContentDigest: fixture.sourceContentDigest,
        encodedSourceBytes: fixture.encodedSourceBytes,
        harnessMemoryAfterVerification: process.memoryUsage(),
        harnessLifetimeMaxRssKiB: process.resourceUsage().maxRSS,
    }
}

/**
 * @param {{referenceDigest: string, canonicalContentDigest: string, resolvedContentDigest: string, counters: object}} result
 * @returns {object}
 */
function correctnessIdentity(result) {
    return {references: result.referenceDigest, canonical: result.canonicalContentDigest, resolved: result.resolvedContentDigest, counters: result.counters}
}

/**
 * @param {number[]} values
 * @returns {number}
 */
function median(values) {
    const sorted = [...values].sort((a, b) => a - b)
    return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2
}

/**
 * @param {Observation[]} observations
 * @param {number} pairs
 * @returns {Record<string, object>}
 * @throws {Error} If a measurement pair is incomplete or has different output.
 */
function summarize(observations, pairs) {
    /** @type {Record<string, object>} */
    const summary = {}
    for (const phase of /** @type {const} */ (['resolver', 'exact', 'publication'])) {
        for (const metric of /** @type {const} */ (['wallMs', 'cpuMs'])) {
            /** @type {number[]} */
            const before = []
            /** @type {number[]} */
            const after = []
            for (let pair = 0; pair < pairs; ++pair) {
                const a = observations.find((item) => item.pair === pair && item.arm === 'A')?.result
                const b = observations.find((item) => item.pair === pair && item.arm === 'B')?.result
                if (!a || !b) { throw new Error('Incomplete measurement pair') }
                assert.deepEqual(correctnessIdentity(a), correctnessIdentity(b), 'Baseline/candidate complete output or counter mismatch')
                assert.deepEqual(
                    [a.archiveSha256, a.lockSha256, a.sourceContentDigest, a.groups, a.recentSourceCacheBudgetBytes],
                    [b.archiveSha256, b.lockSha256, b.sourceContentDigest, b.groups, b.recentSourceCacheBudgetBytes],
                    'Fixture/group/cache-policy identity mismatch',
                )
                before.push(a[phase][metric])
                after.push(b[phase][metric])
            }
            const changes = after.map((value, i) => value - before[i])
            const ratios = before.every((value) => value > 0) ? after.map((value, i) => value / before[i]) : null
            const sumBefore = before.reduce((sum, value) => sum + value, 0)
            const sumAfter = after.reduce((sum, value) => sum + value, 0)
            summary[`${phase}.${metric}`] = {
                pairedChangesMs: changes,
                pairedRatios: ratios,
                baselineMedianMs: median(before),
                candidateMedianMs: median(after),
                medianPairedChangeMs: median(changes),
                medianPairedChangePercent: ratios === null ? null : 100 * (median(ratios) - 1),
                equalWorkTotalChangePercent: sumBefore > 0 ? 100 * (sumAfter / sumBefore - 1) : null,
                worstPairChangePercent: ratios === null ? null : 100 * (Math.max(...ratios) - 1),
                fasterPairs: changes.filter((value) => value < 0).length,
            }
        }
    }
    return summary
}

const {values, positionals} = parseArgs({
    allowPositionals: true,
    options: {
        'child': {type: 'boolean', default: false},
        'pairs': {type: 'string', default: '8'},
        'cache-dir': {type: 'string', default: path.join(root, 'builds/e2e-dictionary-cache')},
        'source-root': {type: 'string', default: root},
        'baseline-root': {type: 'string'},
        'initial-order': {type: 'string', default: 'AB'},
        'device-memory-gib': {type: 'string'},
        'out': {type: 'string', default: path.join(root, 'builds/perf/import-dedup-screen.json')},
    },
})
const dictionary = positionals[0]
const pairs = Number(values.pairs)
const deviceMemoryGiB = typeof values['device-memory-gib'] === 'undefined' ? null : Number(values['device-memory-gib'])
if (positionals.length !== 1 || !Object.hasOwn(filesPerGroup, dictionary)) { throw new Error('Provide exactly one of jmdict, jmnedict or jitendex') }
if (!Number.isSafeInteger(pairs) || pairs < 2 || !['AB', 'BA'].includes(values['initial-order'])) { throw new Error('Invalid fixed pair count or run order') }
if (deviceMemoryGiB !== null && (!Number.isFinite(deviceMemoryGiB) || deviceMemoryGiB <= 0)) { throw new Error('Device memory must be a positive finite GiB value') }

if (values.child) {
    console.log(JSON.stringify(await measure(dictionary, values['cache-dir'], values['source-root'], deviceMemoryGiB)))
} else {
    const sourceRoot = path.resolve(values['source-root'])
    const baselineRoot = path.resolve(values['baseline-root'] ?? sourceRoot)
    /** @type {Record<string, Record<string, string>>} */
    const initialIdentities = {A: await sourceIdentity(baselineRoot), B: await sourceIdentity(sourceRoot)}
    const runnerSourceHashes = await sourceIdentity(root, runnerFiles)
    const runnerSha256 = runnerSourceHashes['dev/perf/import-dedup-screen.js']
    const plan = {
        dictionary,
        pairs,
        initialOrder: values['initial-order'],
        sourceRoot,
        baselineRoot,
        deviceMemoryGiB,
        warmupCount: 2,
        scope: 'component-only; no whole-import claim',
        hostBefore: getHostEnvironment(),
        sourceGit: {A: sourceGitIdentity(baselineRoot), B: sourceGitIdentity(sourceRoot)},
    }
    /** @type {Observation[]} */
    const observations = []
    await mkdir(path.dirname(values.out), {recursive: true})
    const save = async (/** @type {object} */ status) => {
        const temporary = `${values.out}.${process.pid}.tmp`
        await writeFile(temporary, JSON.stringify({...plan, initialIdentities, runnerSourceHashes, runnerSha256, ...status, observations}, null, 2))
        await rename(temporary, values.out)
    }
    await save({complete: false})
    try {
        for (let pair = 0; pair < pairs; ++pair) {
            const order = pair % 2 === 0 ? values['initial-order'] : [...values['initial-order']].reverse().join('')
            for (const arm of order) {
                const args = ['--expose-gc', filename, dictionary, '--child', '--cache-dir', values['cache-dir'], '--source-root', arm === 'A' ? baselineRoot : sourceRoot]
                if (deviceMemoryGiB !== null) { args.push('--device-memory-gib', String(deviceMemoryGiB)) }
                const child = spawnSync(process.execPath, args, {encoding: 'utf8', timeout: 300000, maxBuffer: 8 * 1024 * 1024})
                const observation = /** @type {Observation} */ ({pair, arm, status: 'failed', stdout: child.stdout, stderr: child.stderr, exitCode: child.status, signal: child.signal})
                observations.push(observation)
                if (child.status !== 0 || child.error) {
                    observation.error = String(child.error ?? `Child exit ${child.status}; signal ${child.signal}`)
                    throw new Error(observation.error)
                }
                try {
                    const result = /** @type {Awaited<ReturnType<typeof measure>>} */ (parseJson(child.stdout))
                    assert.deepEqual(result.sourceHashes, initialIdentities[arm], 'Source changed during fixed cohort')
                    assert.deepEqual(result.sourceGit, arm === 'A' ? plan.sourceGit.A : plan.sourceGit.B, 'Tracked checkout state changed during fixed cohort')
                    assert.deepEqual(result.runnerSourceHashes, runnerSourceHashes, 'Runner helpers or fixture lock changed during fixed cohort')
                    assert.equal(result.runnerSha256, runnerSha256, 'Runner changed during fixed cohort')
                    if (result.dictionary !== dictionary || result.sourceRoot !== (arm === 'A' ? baselineRoot : sourceRoot) || result.deviceMemoryGiB !== deviceMemoryGiB) {
                        throw new Error('Child did not run the requested scenario')
                    }
                    observation.result = result
                    observation.status = 'passed'
                    delete observation.stdout
                } catch (error) {
                    observation.error = String(error)
                    throw error
                }
                await save({complete: false})
                console.log(`${dictionary} pair ${pair + 1}/${pairs} ${arm}: resolver ${observation.result.resolver.wallMs.toFixed(3)} ms; exact ${observation.result.exact.wallMs.toFixed(3)} ms`)
            }
        }
        assert.deepEqual(await sourceIdentity(baselineRoot), initialIdentities.A, 'Baseline source changed during cohort')
        assert.deepEqual(await sourceIdentity(sourceRoot), initialIdentities.B, 'Candidate source changed during cohort')
        assert.deepEqual(sourceGitIdentity(baselineRoot), plan.sourceGit.A, 'Baseline checkout state changed during cohort')
        assert.deepEqual(sourceGitIdentity(sourceRoot), plan.sourceGit.B, 'Candidate checkout state changed during cohort')
        assert.deepEqual(await sourceIdentity(root, runnerFiles), runnerSourceHashes, 'Runner helpers or fixture lock changed during cohort')
        const summary = summarize(observations, pairs)
        await save({complete: true, summary, hostAfter: getHostEnvironment()})
        console.log(JSON.stringify(summary))
    } catch (error) {
        await save({complete: false, error: String(error), hostAfter: getHostEnvironment()})
        throw error
    }
}
