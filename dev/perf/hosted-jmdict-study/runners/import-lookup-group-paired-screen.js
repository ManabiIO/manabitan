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

import {readFile, writeFile, mkdir, rename, realpath} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {PerformanceObserver, performance} from 'node:perf_hooks'
import {fileURLToPath, pathToFileURL} from 'node:url'
import path from 'node:path'
import {parseArgs} from 'node:util'
import {parseJson} from '../../ext/js/core/json.js'
import {safePerformance} from '../../ext/js/core/safe-performance.js'
import {ZipReader, Uint8ArrayReader, Uint8ArrayWriter} from '@zip.js/zip.js'
import {getHostEnvironment} from './host-environment.js'

/** @typedef {import('dictionary-importer').ImportExperiments} Flags */
/** @typedef {Parameters<Parameters<typeof import('../../ext/js/dictionary/term-bank-wasm-parser.js').parseTermBankWithWasmColumnChunks>[2]>[0] & {preparedLookupIndexes?: Map<string, import('../../ext/js/dictionary/term-lookup-index-preparation.js').PreparedTermLookupIndex>}} Chunk */
/** @typedef {{cacheFile: string, sha256: string, termRows: number}} Lock */
/** @typedef {{userMs: number, systemMs: number, totalMs: number}} CpuTimes */
/** @typedef {ReturnType<typeof process.cpuUsage>} CpuUsage */
/** @typedef {(previousValue?: CpuUsage) => CpuUsage} CpuUsageReader */
/** @typedef {{fusedParseAttempts: number, fusedParseFallbacks: number, discardedFusedRows: number, discardedFusedParseMs: number}} FusedProfile */
/** @typedef {FusedProfile & {firstBankIndex: number, bankCount: number, rows: number, startTimeMs: number, endTimeMs: number, profile: Record<string, number>, gcEventIndexes: number[], gcOverlapMs: number, elapsedMs: number, processCpu: CpuTimes, threadCpu: CpuTimes|null, measuredSequence?: number, pair?: number, pass?: number, groupIndex?: number, arm?: string, order?: string, orderPosition?: number}} GroupMeasurement */
/** @typedef {FusedProfile & {elapsedMs: number, processCpu: CpuTimes, threadCpu: CpuTimes|null, groups: GroupMeasurement[], lookupMs: number, rows: number, scratchReusedBytes: number, scratchReuseMisses: number, nativeSegments: number, indexBytes: number, maxWasmHeapBytes: number, directArenaSegments: number, validationPasses: number, digest: string|null}} Measurement */
/** @typedef {Measurement & {flags: Flags, dictionary: string, filesPerGroup: number, node: string, sourceRoot: string, sourceHashes: Record<string, string>, wasmSha256: string, lockSha256: string, archiveSha256: string, runnerSha256: string, afterVerificationMemory: {rss: number, heapTotal: number, heapUsed: number, external: number, arrayBuffers: number}, lifetimeMaxRssKiB: number}} ScreenResult */
/** @typedef {{hostEnvironmentBefore: ReturnType<typeof getHostEnvironment>, hostEnvironmentAfter: ReturnType<typeof getHostEnvironment>}} ChildEnvironment */
/** @typedef {ChildEnvironment & {pair: number, arm: string, phase: string, complete: boolean, result: ScreenResult|null, verificationBefore: Measurement|null, verificationAfter: Measurement|null, explicitGc: {startTimeMs: number, endTimeMs: number}|null, passes: Measurement[]}} Observation */
/** @typedef {{medianPairedChangePercent: number, equalWorkTotalChangePercent: number, fasterPairs: number}} PairedSummary */
const root = fileURLToPath(new URL('../../', import.meta.url))
// Feature-detect the optional API without depending on newer Node typings.
const processWithThreadCpu = /** @type {typeof process & {threadCpuUsage?: CpuUsageReader}} */ (process)
const threadCpuUsage = typeof processWithThreadCpu.threadCpuUsage === 'function' ? processWithThreadCpu.threadCpuUsage.bind(process) : null
/** @type {Record<string, number>} */
const filesPerGroup = {jmdict: 7, jmnedict: 9, jitendex: 10}
const sourceFiles = ['ext/js/dictionary/term-bank-wasm-parser.js',
    'ext/js/dictionary/term-bank-experiments.js',
    'ext/js/dictionary/term-lookup-scratch.js',
    'ext/js/dictionary/term-lookup-index-preparation.js',
    'ext/js/dictionary/term-lookup-index.js',
    'ext/js/dictionary/term-record-preinterned-plan.js',
    'ext/js/dictionary/wasm/term-bank-parser.c',
    'ext/js/dictionary/dictionary-source-integrity-error.js',
    'ext/js/dictionary/term-key-hash.js',
    'ext/js/core/json.js',
    'ext/js/core/log.js',
    'ext/js/core/event-dispatcher.js',
    'ext/js/core/extension-error.js',
    'ext/js/core/retryable-promise-cache.js',
    'ext/js/core/safe-performance.js',
    'dev/data/dictionary-wasm/manifest.json',
    'package.json',
    'package-lock.json']
/**
 * @param {import('node:crypto').BinaryLike} bytes
 * @returns {string}
 */
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }
/**
 * @param {import('node:crypto').Hash} hash
 * @param {ArrayBufferView} view
 */
function updateView(hash, view) { hash.update(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)) }

/**
 * Node CPU counters are microseconds; all reported timings are milliseconds.
 * Process CPU includes background threads and can exceed elapsed wall time.
 * @param {CpuUsage} usage
 * @returns {CpuTimes}
 */
function cpuTimes(usage) { return {userMs: usage.user / 1000, systemMs: usage.system / 1000, totalMs: (usage.user + usage.system) / 1000} }

/**
 * @param {CpuTimes} total
 * @param {CpuTimes} group
 */
function addCpuTimes(total, group) {
    total.userMs += group.userMs
    total.systemMs += group.systemMs
    total.totalMs += group.totalMs
}

/**
 * @param {Observation[]} observations
 * @param {number} pairs
 * @param {(result: ScreenResult) => number|null} value
 * @returns {PairedSummary|null}
 * @throws {Error} If a pair is incomplete or a measured duration is invalid.
 */
function summarizePairs(observations, pairs, value) {
    const ratios = []
    let totalA = 0
    let totalB = 0
    for (let pair = 0; pair < pairs; ++pair) {
        const a = observations.find((x) => x.pair === pair && x.arm === 'A')?.result
        const b = observations.find((x) => x.pair === pair && x.arm === 'B')?.result
        if (!a || !b) { throw new Error('Incomplete measurement pair') }
        const timeA = value(a)
        const timeB = value(b)
        if (timeA === null || timeB === null) { return null }
        if (!Number.isFinite(timeA) || !Number.isFinite(timeB) || timeA <= 0 || timeB < 0) { throw new Error('Invalid measured duration') }
        ratios.push(timeB / timeA)
        totalA += timeA
        totalB += timeB
    }
    ratios.sort((a, b) => a - b)
    return {medianPairedChangePercent: 100 * ((ratios[Math.floor((pairs - 1) / 2)] + ratios[Math.floor(pairs / 2)]) / 2 - 1),
        equalWorkTotalChangePercent: 100 * (totalB / totalA - 1),
        fasterPairs: ratios.filter((x) => x < 1).length}
}


/**
 * New source files are explicitly absent in an older comparison worktree.
 * @param {string} filename
 * @returns {Promise<string>}
 * @throws {Error} If the file cannot be read for reasons other than absence.
 */
async function sourceHash(filename) {
    try { return sha256(await readFile(filename)) } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') { return 'absent' }
        throw error
    }
}


/** @typedef {{name: string, sourceRoot: string, flags: Flags, sourceHashes: Record<string, string>, wasmSha256: string, execute: (verify: boolean, groupStart?: number) => Promise<Measurement>}} Arm */
/** @typedef {{startTimeMs: number, durationMs: number, kind: number|null, flags: number|null}} GcEvent */
/**
 * @param {string} sourceRoot
 * @returns {Promise<Record<string, string>>}
 */
async function getSourceHashes(sourceRoot) {
    /** @type {Record<string, string>} */
    const hashes = {}
    for (const file of sourceFiles) { hashes[file] = await sourceHash(path.join(sourceRoot, file)) }
    return hashes
}
/**
 * @param {Arm} arm
 * @returns {Promise<void>}
 * @throws {Error} If source, dependencies or WASM changed.
 */
async function checkArmIdentity(arm) {
    if (JSON.stringify(await getSourceHashes(arm.sourceRoot)) !== JSON.stringify(arm.sourceHashes) ||
    await sourceHash(path.join(arm.sourceRoot, 'ext/lib/term-bank-parser.wasm')) !== arm.wasmSha256) {
        throw new Error(`Source identity changed for ${arm.name}`)
    }
}
/**
 * Each distinct worktree owns an ESM parser instance and separate WASM memory.
 * @param {string} name
 * @param {string} dictionary
 * @param {string} sourceRoot
 * @param {Flags} flags
 * @param {Uint8Array[]} sources
 * @param {Lock} spec
 * @returns {Promise<Arm>}
 * @throws {Error} If a parser API is missing.
 */
async function prepareArm(name, dictionary, sourceRoot, flags, sources, spec) {
    const sourceHashes = await getSourceHashes(sourceRoot)
    // Explicit caller-selected local worktree; no dictionary-controlled path.
    // eslint-disable-next-line no-unsanitized/method, @typescript-eslint/no-unsafe-assignment
    const parser = /** @type {typeof import('../../ext/js/dictionary/term-bank-wasm-parser.js')} */ (await import(pathToFileURL(path.join(sourceRoot, 'ext/js/dictionary/term-bank-wasm-parser.js')).href))
    // eslint-disable-next-line no-unsanitized/method, @typescript-eslint/no-unsafe-assignment
    const prep = /** @type {typeof import('../../ext/js/dictionary/term-lookup-index-preparation.js')} */ (await import(pathToFileURL(path.join(sourceRoot, 'ext/js/dictionary/term-lookup-index-preparation.js')).href))
    if (typeof parser.setTermBankWasmModule !== 'function' || typeof parser.parseTermBankWithWasmColumnChunks !== 'function' ||
    typeof parser.consumeLastTermBankWasmParseProfile !== 'function' || typeof prep.prepareTermLookupIndexesFromPreinternedPlan !== 'function' ||
    typeof prep.hasCompletePreparedTermLookupIndexes !== 'function') { throw new Error('Selected worktree lacks the required parser/lookup API') }
    const wasmBytes = await readFile(path.join(sourceRoot, 'ext/lib/term-bank-parser.wasm'))
    parser.setTermBankWasmModule(await WebAssembly.compile(wasmBytes))
    const options = {...flags,
        singleChunk: true,
        emitTermByteLists: false,
        computeContentHashes: true,
        emitContentSlab: true,
        emitTokenBinaryContent: true,
        mediaHintFastScan: true,
        prepareLookupIndexes: true}
    /**
     * @param {boolean} verify
     * @param {number} [groupStart]
     * @returns {Promise<Measurement>}
     * @throws {Error} If parsing or equality verification fails.
     */
    const execute = async (verify, groupStart) => {
        if (typeof groupStart === 'number' && (verify || !Number.isInteger(groupStart) || groupStart < 0 ||
        groupStart >= sources.length || groupStart % filesPerGroup[dictionary] !== 0)) { throw new Error('Invalid measured group start') }
        let elapsedMs = 0
        const processCpu = cpuTimes({user: 0, system: 0})
        const threadCpu = threadCpuUsage === null ? null : cpuTimes({user: 0, system: 0})
        /** @type {GroupMeasurement[]} */
        const groups = []
        let fusedParseAttempts = 0
        let fusedParseFallbacks = 0
        let discardedFusedRows = 0
        let discardedFusedParseMs = 0
        let lookupMs = 0
        let rows = 0
        let nativeSegments = 0
        let scratchReusedBytes = 0
        let scratchReuseMisses = 0
        let indexBytes = 0
        let maxWasmHeapBytes = 0
        let directArenaSegments = 0
        let validationPasses = 0
        const digest = verify ? createHash('sha256') : null
        const firstSource = groupStart ?? 0
        const sourceLimit = typeof groupStart === 'number' ? Math.min(groupStart + filesPerGroup[dictionary], sources.length) : sources.length
        for (let start = firstSource; start < sourceLimit; start += filesPerGroup[dictionary]) {
            /** @type {Chunk|null} */
            let resultChunk = null
            const group = sources.slice(start, start + filesPerGroup[dictionary])
            // CPU snapshots bracket the unchanged wall interval. Digest work,
            // fixture loading and warmups remain outside the reported samples.
            const processBefore = process.cpuUsage()
            const threadBefore = threadCpuUsage === null ? null : threadCpuUsage()
            const before = safePerformance.now()
            await parser.parseTermBankWithWasmColumnChunks(group, 3, (/** @type {Chunk} */ chunk) => {
                resultChunk = chunk
                if (!chunk.preparedLookupIndexes) {
                    const result = prep.prepareTermLookupIndexesFromPreinternedPlan(chunk, null, flags)
                    if (!result) { throw new Error('Missing lookup indexes') }
                    chunk.preparedLookupIndexes = result.indexes
                    lookupMs += result.totalMs
                    directArenaSegments += result.directArenaSegments ?? 0
                    validationPasses += result.compactionSourceValidationPasses ?? 0
                }
            }, 2048, options)
            const groupElapsedMs = safePerformance.now() - before
            const groupThreadCpu = threadCpuUsage !== null && threadBefore !== null ? cpuTimes(threadCpuUsage(threadBefore)) : null
            const groupProcessCpu = cpuTimes(process.cpuUsage(processBefore))
            elapsedMs += groupElapsedMs
            addCpuTimes(processCpu, groupProcessCpu)
            if (threadCpu !== null && groupThreadCpu !== null) { addCpuTimes(threadCpu, groupThreadCpu) }
            const profile = parser.consumeLastTermBankWasmParseProfile()
            if (resultChunk === null || !profile) { throw new Error('Missing parser results') }
            const chunk = /** @type {Chunk} */ (resultChunk)
            const indexes = chunk.preparedLookupIndexes
            if (!indexes || !prep.hasCompletePreparedTermLookupIndexes(indexes, chunk.rowCount)) { throw new Error('Incomplete indexes') }
            rows += chunk.rowCount
            nativeSegments += profile.nativeSegmentedLookupSegments ?? 0
            scratchReusedBytes += profile.nativeLookupScratchReusedBytes ?? 0
            scratchReuseMisses += profile.nativeLookupScratchReuseMisses ?? 0
            lookupMs += profile.lookupIndexPrepareMs ?? 0
            maxWasmHeapBytes = Math.max(maxWasmHeapBytes, profile.maxWasmHeapBytes ?? 0)
            const groupFusedProfile = {
                fusedParseAttempts: profile.fusedParseAttempts ?? 0,
                fusedParseFallbacks: profile.fusedParseFallbacks ?? 0,
                discardedFusedRows: profile.discardedFusedRows ?? 0,
                discardedFusedParseMs: profile.discardedFusedParseMs ?? 0,
            }
            fusedParseAttempts += groupFusedProfile.fusedParseAttempts
            fusedParseFallbacks += groupFusedProfile.fusedParseFallbacks
            discardedFusedRows += groupFusedProfile.discardedFusedRows
            discardedFusedParseMs += groupFusedProfile.discardedFusedParseMs
            /** @type {Record<string, number>} */
            const numericProfile = {}
            for (const [key, value] of Object.entries(profile)) {
                if (typeof value === 'number') { numericProfile[key] = value }
            }
            groups.push({...groupFusedProfile,
                startTimeMs: before,
                endTimeMs: before + groupElapsedMs,
                profile: numericProfile,
                gcEventIndexes: [],
                gcOverlapMs: 0,
                firstBankIndex: start,
                bankCount: group.length,
                rows: chunk.rowCount,
                elapsedMs: groupElapsedMs,
                processCpu: groupProcessCpu,
                threadCpu: groupThreadCpu})
            for (const entry of indexes.values()) { indexBytes += entry.bytes.byteLength }
            if (digest === null) { continue }
            // Digest all rows and index bytes before the next parse reuses memory.
            for (const [key, entry] of indexes) {
                digest.update(key)
                digest.update(entry.bytes)
                for (const view of [entry.preinternedPlan.stringLengths,
                    entry.preinternedPlan.stringOffsets,
                    entry.preinternedPlan.stringHashes,
                    entry.preinternedPlan.stringsBuffer,
                    entry.preinternedPlan.expressionIndexes,
                    entry.preinternedPlan.readingIndexes]) {
                    if (view) { updateView(digest, view) }
                }
            }
            updateView(digest, chunk.readingEqualsExpressionList)
            updateView(digest, chunk.scoreList)
            updateView(digest, chunk.sequenceList)
            const {contentMetaList, contentBytesBuffer, contentBytesBaseOffset} = chunk
            if (!contentBytesBuffer || !contentMetaList || typeof contentBytesBaseOffset !== 'number') { throw new Error('Missing content slab') }
            for (let row = 0; row < chunk.rowCount; ++row) {
                const offset = contentBytesBaseOffset + contentMetaList[row * 4]
                digest.update(contentBytesBuffer.subarray(offset, offset + contentMetaList[row * 4 + 1]))
                updateView(digest, contentMetaList.subarray(row * 4 + 1, row * 4 + 4))
            }
        }
        if (typeof groupStart !== 'number' && rows !== spec.termRows) { throw new Error('Dictionary row count differs from lock') }
        return {scratchReusedBytes,
            scratchReuseMisses,
            elapsedMs,
            processCpu,
            threadCpu,
            groups,
            fusedParseAttempts,
            fusedParseFallbacks,
            discardedFusedRows,
            discardedFusedParseMs,
            lookupMs,
            rows,
            nativeSegments,
            indexBytes,
            maxWasmHeapBytes,
            directArenaSegments,
            validationPasses,
            digest: digest === null ? null : digest.digest('hex')}
    }
    return {name, sourceRoot, flags, sourceHashes, wasmSha256: sha256(wasmBytes), execute}
}

/**
 * @param {Measurement} a
 * @param {Measurement} b
 * @throws {Error} If the complete v1 output oracle differs.
 */
function checkOracle(a, b) {
    if (a.digest === null || a.digest !== b.digest || a.indexBytes !== b.indexBytes || a.rows !== b.rows) {
        throw new Error('Full output byte oracle mismatch')
    }
}
/**
 * @param {Measurement[]} measurements
 * @param {GcEvent[]} entries
 */
function annotateGc(measurements, entries) {
    for (const measurement of measurements) {
        for (const group of measurement.groups) {
            group.gcEventIndexes = []
            group.gcOverlapMs = 0
            for (let i = 0; i < entries.length; ++i) {
                const entry = entries[i]
                const overlap = Math.min(group.endTimeMs, entry.startTimeMs + entry.durationMs) - Math.max(group.startTimeMs, entry.startTimeMs)
                if (overlap <= 0) { continue }
                group.gcEventIndexes.push(i)
                group.gcOverlapMs += overlap
            }
        }
    }
}

/**
 * Append one measured group without hashing, reading source files or forcing GC.
 * @param {Measurement} target
 * @param {Measurement} group
 */
function appendMeasuredGroup(target, group) {
    /** @type {Array<'elapsedMs'|'lookupMs'|'rows'|'indexBytes'|'scratchReusedBytes'|'scratchReuseMisses'|'nativeSegments'|'directArenaSegments'|'validationPasses'|'fusedParseAttempts'|'fusedParseFallbacks'|'discardedFusedRows'|'discardedFusedParseMs'>} */
    const summedFields = ['elapsedMs', 'lookupMs', 'rows', 'indexBytes', 'scratchReusedBytes', 'scratchReuseMisses', 'nativeSegments', 'directArenaSegments', 'validationPasses', 'fusedParseAttempts', 'fusedParseFallbacks', 'discardedFusedRows', 'discardedFusedParseMs']
    for (const key of summedFields) { target[key] += group[key] }
    addCpuTimes(target.processCpu, group.processCpu)
    if (target.threadCpu !== null && group.threadCpu !== null) { addCpuTimes(target.threadCpu, group.threadCpu) }
    target.maxWasmHeapBytes = Math.max(target.maxWasmHeapBytes, group.maxWasmHeapBytes)
    target.groups.push(...group.groups)
}
/**
 * CPU/wall totals cover all passes. Digest/indexBytes describe one verification
 * corpus; rows and counters cover all measured work. Raw passes are retained.
 * @param {Measurement[]} passes
 * @param {Measurement} verification
 * @returns {Measurement}
 * @throws {Error} If timed output dimensions change.
 */
function aggregatePasses(passes, verification) {
    const result = {...passes[0], groups: [], processCpu: cpuTimes({user: 0, system: 0}), threadCpu: threadCpuUsage === null ? null : cpuTimes({user: 0, system: 0})}
    /** @type {Array<'elapsedMs'|'lookupMs'|'rows'|'scratchReusedBytes'|'scratchReuseMisses'|'nativeSegments'|'directArenaSegments'|'validationPasses'|'fusedParseAttempts'|'fusedParseFallbacks'|'discardedFusedRows'|'discardedFusedParseMs'>} */
    const summedFields = ['elapsedMs', 'lookupMs', 'rows', 'scratchReusedBytes', 'scratchReuseMisses', 'nativeSegments', 'directArenaSegments', 'validationPasses', 'fusedParseAttempts', 'fusedParseFallbacks', 'discardedFusedRows', 'discardedFusedParseMs']
    for (const key of summedFields) { result[key] = 0 }
    for (const pass of passes) {
        if (pass.rows !== verification.rows || pass.indexBytes !== verification.indexBytes) { throw new Error('Timed pass output dimensions changed') }
        if (pass.fusedParseAttempts !== verification.fusedParseAttempts || pass.fusedParseFallbacks !== verification.fusedParseFallbacks ||
        pass.discardedFusedRows !== verification.discardedFusedRows) { throw new Error('Timed parser activation differs from pre-verification') }
        for (const key of summedFields) { result[key] += pass[key] }
        addCpuTimes(result.processCpu, pass.processCpu)
        if (result.threadCpu !== null && pass.threadCpu !== null) { addCpuTimes(result.threadCpu, pass.threadCpu) }
        result.maxWasmHeapBytes = Math.max(result.maxWasmHeapBytes, pass.maxWasmHeapBytes)
    }
    result.digest = verification.digest
    result.indexBytes = verification.indexBytes
    return result
}

const {values, positionals} = parseArgs({allowPositionals: true,
    options: {
        'pairs': {type: 'string', default: '8'},
        'warmup-pairs': {type: 'string', default: '6'},
        'passes': {type: 'string', default: '5'},
        'flags': {type: 'string', default: '{}'},
        'cache-dir': {type: 'string', default: path.join(root, 'builds/e2e-dictionary-cache')},
        'out': {type: 'string', default: path.join(root, 'builds/perf/group-paired-screen.json')},
        'baseline-root': {type: 'string'},
        'candidate-root': {type: 'string', default: root},
        'initial-order': {type: 'string', default: 'AB'},
    }})
const outputPath = values.out
if (typeof outputPath !== 'string') { throw new Error('Missing output path') }
const dictionary = positionals[0]
const pairs = Number(values.pairs)
const warmupPairs = Number(values['warmup-pairs'])
const passCount = Number(values.passes)
if (!dictionary || !filesPerGroup[dictionary]) { throw new Error('Provide jmdict, jmnedict or jitendex') }
if (!Number.isInteger(pairs) || pairs < 2 || !Number.isInteger(warmupPairs) || warmupPairs < 1 ||
!Number.isInteger(passCount) || passCount < 1 || !['AB', 'BA'].includes(values['initial-order'])) { throw new Error('Invalid fixed run plan') }
const collectGarbage = globalThis.gc
if (typeof collectGarbage !== 'function') { throw new Error('Run with node --expose-gc') }
if (typeof values['baseline-root'] !== 'string') { throw new Error('Provide an explicit --baseline-root') }
/** @type {Flags} */
const flags = parseJson(values.flags)
if (flags === null || typeof flags !== 'object' || Array.isArray(flags)) { throw new Error('Flags must be a JSON object') }
const {snapshotTermBankExperiments} = await import('../../ext/js/dictionary/term-bank-experiments.js')
const effective = snapshotTermBankExperiments(flags)
for (const [key, value] of Object.entries(flags)) {
    if (!(key in effective) || typeof value !== 'boolean') { throw new Error(`Unknown or non-boolean flag: ${key}`) }
}
const baselineRoot = await realpath(values['baseline-root'])
const candidateRoot = await realpath(values['candidate-root'])
if (baselineRoot === candidateRoot) { throw new Error('Use distinct worktrees to isolate parser state, including for A/A') }
const runnerPath = fileURLToPath(import.meta.url)
const runnerSha256 = await sourceHash(runnerPath)
const dependencyFiles = ['dev/perf/host-environment.js', 'ext/js/core/json.js', 'ext/js/core/safe-performance.js', 'node_modules/@zip.js/zip.js/package.json', 'package-lock.json']
/** @type {Record<string, string>} */
const runnerDependencyHashes = {}
for (const file of dependencyFiles) { runnerDependencyHashes[file] = await sourceHash(path.join(root, file)) }
const lockBytes = await readFile(path.join(root, 'test/perf/dictionaries.lock.json'))
/** @type {Record<string, Lock>} */
const locks = /** @type {{dictionaries: Record<string, Lock>}} */ (parseJson(lockBytes.toString())).dictionaries
const spec = locks[dictionary]
if (!spec || !filesPerGroup[dictionary]) { throw new Error('Use jmdict, jmnedict or jitendex') }
const archive = await readFile(path.join(values['cache-dir'], spec.cacheFile))
if (sha256(archive) !== spec.sha256) { throw new Error('Dictionary SHA-256 differs from lock') }
const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(archive)))
/** @type {Uint8Array[]} */
const sources = []
try {
    const entries = (await reader.getEntries()).filter((entry) => /^term_bank_\d+\.json$/.test(entry.filename))
        .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)))
    for (const entry of entries) {
        if (!entry.getData) { throw new Error('Unreadable term bank') }
        sources.push(await entry.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true}))
    }
} finally { await reader.close() }

const inputHashes = sources.map((source) => sha256(source))
/** @type {Record<string, Arm>} */
const arms = {A: await prepareArm('A', dictionary, baselineRoot, {}, sources, spec), B: await prepareArm('B', dictionary, candidateRoot, flags, sources, spec)}
/** @type {GcEvent[]} */
const gcEvents = []
const observerType = /** @type {typeof PerformanceObserver & {supportedEntryTypes?: string[]}} */ (PerformanceObserver)
const gcSupported = observerType.supportedEntryTypes?.includes('gc') ?? false
const gcObserver = gcSupported ?
new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
        const details = /** @type {import('node:perf_hooks').PerformanceEntry & {detail?: {kind?: number, flags?: number}}} */ (entry).detail
        gcEvents.push({startTimeMs: entry.startTime,
            durationMs: entry.duration,
            kind: details?.kind ?? null,
            flags: details?.flags ?? null})
    }
}) :
null
gcObserver?.observe({entryTypes: ['gc']})
const plan = {schemaVersion: 2,
    protocolVersion: 3,
    mode: 'persistent-modules-group-paired-batches',
    dictionary,
    dictionaryRows: spec.termRows,
    filesPerGroup: filesPerGroup[dictionary],
    pairs,
    warmupPairs,
    passesPerObservation: passCount,
    initialOrder: values['initial-order'],
    flags,
    timingScope: 'Sum of parser plus completed lookup group intervals across all measured passes; corresponding A/B groups are adjacent; separate full verification of both arms before and after every pair',
    groupOrderPolicy: 'Reverse initial order when (pair + pass + groupIndex) is odd',
    gcPolicy: 'One explicit GC per pair after both pre-verifications; no forced GC, digest work or source reads between measured groups or passes; GC overlaps are annotations and never subtracted',
    explicitGcScope: 'pair',
    runnerSha256,
    runnerDependencyHashes,
    lockSha256: sha256(lockBytes),
    archiveSha256: spec.sha256,
    inputHashes,
    runtime: {node: process.version,
        versions: process.versions,
        execPath: process.execPath,
        execArgv: process.execArgv,
        platform: process.platform,
        arch: process.arch,
        // eslint-disable-next-line no-restricted-syntax -- GC records use this Node time origin.
        performanceTimeOrigin: performance.timeOrigin,
        threadCpuAvailable: threadCpuUsage !== null,
        gcObserverAvailable: gcSupported},
    arms: Object.fromEntries(Object.entries(arms).map(([name, arm]) => [name, {
        sourceRoot: arm.sourceRoot,
        sourceHashes: arm.sourceHashes,
        wasmSha256: arm.wasmSha256,
        flags: arm.flags,
    }])),
    hostEnvironmentBefore: getHostEnvironment()}
/** @type {Array<{round: number, arm: string, result: Measurement}>} */
const warmups = []
/** @type {Observation[]} */
const observations = []
/** @type {{phase: string, arm: string|null, pair: number|null}} */
let currentAction = {phase: 'warmup', arm: null, pair: null}
await mkdir(path.dirname(outputPath), {recursive: true})
const save = async (/** @type {object} */ status) => {
    const temporaryPath = `${outputPath}.tmp`
    await writeFile(temporaryPath, JSON.stringify({...plan, ...status, warmups, observations, gcEvents}, null, 2))
    await rename(temporaryPath, outputPath)
}
/** @type {Measurement|null} */
let referenceVerification = null
let measuredSequence = 0
try {
    await save({complete: false})
    for (let round = 0; round < warmupPairs; ++round) {
        const order = round % 2 === 0 ? values['initial-order'] : [...values['initial-order']].reverse().join('')
        for (const name of order) {
            currentAction = {phase: 'warmup', arm: name, pair: null}
            warmups.push({round, arm: name, result: await arms[name].execute(false)})
        }
        await new Promise((resolve) => { setImmediate(resolve) })
        annotateGc(warmups.map((entry) => entry.result), gcEvents)
        await save({complete: false})
    }

    for (let pair = 0; pair < pairs; ++pair) {
        const pairOrder = pair % 2 === 0 ? values['initial-order'] : [...values['initial-order']].reverse().join('')
        const pairHostBefore = getHostEnvironment()
        /** @type {Record<string, Observation>} */
        const pairObservations = {}
        for (const name of pairOrder) {
            const arm = arms[name]
            currentAction = {phase: 'verification-before', arm: name, pair}
            /** @type {Observation} */
            const observation = {pair,
                arm: name,
                phase: currentAction.phase,
                complete: false,
                hostEnvironmentBefore: pairHostBefore,
                hostEnvironmentAfter: pairHostBefore,
                result: null,
                verificationBefore: null,
                verificationAfter: null,
                explicitGc: null,
                passes: []}
            pairObservations[name] = observation
            observations.push(observation)
            observation.verificationBefore = await arm.execute(true)
            if (referenceVerification === null) { referenceVerification = observation.verificationBefore }
            checkOracle(referenceVerification, observation.verificationBefore)
            await checkArmIdentity(arm)
        }
        await new Promise((resolve) => { setImmediate(resolve) })
        const gcStart = safePerformance.now()
        collectGarbage()
        const explicitGc = {startTimeMs: gcStart, endTimeMs: safePerformance.now()}
        for (const observation of Object.values(pairObservations)) {
            observation.explicitGc = explicitGc
            observation.phase = 'measurement'
        }
        await new Promise((resolve) => { setImmediate(resolve) })
        for (let pass = 0; pass < passCount; ++pass) {
            /** @type {Record<string, Measurement|null>} */
            const activePasses = {A: null, B: null}
            for (let start = 0, groupIndex = 0; start < sources.length; start += filesPerGroup[dictionary], ++groupIndex) {
                const order = (pair + pass + groupIndex) % 2 === 0 ? values['initial-order'] : [...values['initial-order']].reverse().join('')
                for (const name of order) {
                    currentAction = {phase: `measurement-pass-${pass}-group-${groupIndex}`, arm: name, pair}
                    const measured = await arms[name].execute(false, start)
                    const before = pairObservations[name].verificationBefore
                    if (before === null) { throw new Error('Missing pre-verification') }
                    const expectedGroup = before.groups[groupIndex]
                    if (measured.groups.length !== 1 || measured.groups[0].firstBankIndex !== start || measured.rows !== expectedGroup.rows ||
                    measured.fusedParseAttempts !== expectedGroup.fusedParseAttempts || measured.fusedParseFallbacks !== expectedGroup.fusedParseFallbacks ||
                    measured.discardedFusedRows !== expectedGroup.discardedFusedRows) { throw new Error('Measured group differs from pre-verification') }
                    Object.assign(measured.groups[0], {measuredSequence: measuredSequence++,
                        pair,
                        pass,
                        groupIndex,
                        arm: name,
                        order,
                        orderPosition: order.indexOf(name)})
                    const activePass = activePasses[name]
                    if (activePass === null) {
                        activePasses[name] = measured
                        pairObservations[name].passes.push(measured)
                    } else { appendMeasuredGroup(activePass, measured) }
                }
            }
        }
        for (const name of pairOrder) {
            const arm = arms[name]
            const observation = pairObservations[name]
            observation.phase = 'verification-after'
            currentAction = {phase: observation.phase, arm: name, pair}
            observation.verificationAfter = await arm.execute(true)
            const before = observation.verificationBefore
            if (before === null) { throw new Error('Missing pre-verification') }
            checkOracle(before, observation.verificationAfter)
            await checkArmIdentity(arm)
            observation.result = {...aggregatePasses(observation.passes, before),
                flags: arm.flags,
                dictionary,
                filesPerGroup: filesPerGroup[dictionary],
                node: process.version,
                sourceRoot: arm.sourceRoot,
                sourceHashes: arm.sourceHashes,
                wasmSha256: arm.wasmSha256,
                lockSha256: plan.lockSha256,
                archiveSha256: spec.sha256,
                runnerSha256,
                afterVerificationMemory: process.memoryUsage(),
                lifetimeMaxRssKiB: process.resourceUsage().maxRSS}
            observation.complete = true
            observation.phase = 'complete'
        }
        await new Promise((resolve) => { setImmediate(resolve) })
        const pairHostAfter = getHostEnvironment()
        for (const observation of Object.values(pairObservations)) {
            const {verificationBefore, verificationAfter, result} = observation
            if (verificationBefore === null || verificationAfter === null || result === null) { throw new Error('Incomplete pair') }
            annotateGc([verificationBefore, ...observation.passes, verificationAfter], gcEvents)
            observation.hostEnvironmentAfter = pairHostAfter
            const cpu = result.threadCpu ?? result.processCpu
            console.log(`${dictionary} pair ${pair + 1}/${pairs} ${observation.arm}: ${(result.elapsedMs / passCount).toFixed(2)}ms/pass wall, ${(cpu.totalMs / passCount).toFixed(2)}ms/pass CPU`)
        }
        await save({complete: false})
    }
    currentAction = {phase: 'final-identity-check', arm: null, pair: null}
    for (let i = 0; i < sources.length; ++i) {
        if (sha256(sources[i]) !== inputHashes[i]) { throw new Error('Resident fixture bytes changed') }
    }
    if (await sourceHash(runnerPath) !== runnerSha256 ||
    await sourceHash(path.join(root, 'test/perf/dictionaries.lock.json')) !== plan.lockSha256) { throw new Error('Runner or fixture lock changed') }
    for (const file of dependencyFiles) {
        if (await sourceHash(path.join(root, file)) !== runnerDependencyHashes[file]) { throw new Error(`Runner dependency changed: ${file}`) }
    }
    for (const arm of Object.values(arms)) { await checkArmIdentity(arm) }
    const summary = {...summarizePairs(observations, pairs, (result) => result.elapsedMs),
        processCpu: summarizePairs(observations, pairs, (result) => result.processCpu.totalMs),
        threadCpu: summarizePairs(observations, pairs, (result) => result.threadCpu?.totalMs ?? null)}
    await save({complete: true, summary, hostEnvironmentAfter: getHostEnvironment()})
    console.log(JSON.stringify(summary))
} catch (error) {
    await new Promise((resolve) => { setImmediate(resolve) })
    await save({complete: false, error: String(error), failedAction: currentAction, hostEnvironmentAfter: getHostEnvironment()})
    throw error
} finally { gcObserver?.disconnect() }
