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

import {readFile, writeFile, appendFile, mkdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {fileURLToPath, pathToFileURL} from 'node:url'
import path from 'node:path'
import {parseArgs} from 'node:util'
import {performance as safePerformance} from 'node:perf_hooks'

const parseJson = JSON.parse

/** @typedef {import('dictionary-importer').ImportExperiments} Flags */
/** @typedef {Parameters<Parameters<typeof import('../../ext/js/dictionary/term-bank-wasm-parser.js').parseTermBankWithWasmColumnChunks>[2]>[0] & {preparedLookupIndexes?: Map<string, import('../../ext/js/dictionary/term-lookup-index-preparation.js').PreparedTermLookupIndex>}} Chunk */
/** @typedef {{cacheFile: string, sha256: string, termRows: number}} Lock */
/** @typedef {{elapsedMs: number, lookupMs: number, rows: number, scratchReusedBytes: number, scratchReuseMisses: number, nativeSegments: number, indexBytes: number, ownedCompactExpressionRows: number, maxWasmHeapBytes: number, directArenaSegments: number, validationPasses: number, digest: string|null}} Measurement */
/** @typedef {Measurement & {flags: Flags, validateGlossaryTypes: boolean, dictionary: string, filesPerGroup: number, node: string, sourceRoot: string, sourceHashes: Record<string, string>, wasmSha256: string, lockSha256: string, archiveSha256: string, runnerSha256: string, afterVerificationMemory: {rss: number, heapTotal: number, heapUsed: number, external: number, arrayBuffers: number}, lifetimeMaxRssKiB: number}} ScreenResult */
/** @typedef {{pair: number, arm: string, result: ScreenResult}} Observation */
const root = path.resolve(process.env.MANABITAN_SCREEN_RUNTIME_ROOT ?? process.cwd())
const {ZipReader, Uint8ArrayReader, Uint8ArrayWriter} = await import(pathToFileURL(path.join(root, 'node_modules/@zip.js/zip.js/index.js')))
const {getHostEnvironment} = await import(pathToFileURL(path.join(root, 'dev/perf/host-environment.js')))
const sourceFiles = ['ext/js/dictionary/term-bank-wasm-parser.js',
    'ext/js/dictionary/term-bank-experiments.js',
    'ext/js/dictionary/term-lookup-scratch.js',
    'ext/js/dictionary/term-lookup-index-preparation.js',
    'ext/js/dictionary/term-lookup-index.js',
    'ext/js/dictionary/term-record-preinterned-plan.js',
    'ext/js/dictionary/wasm/term-bank-parser.c',
    'dev/perf/host-environment.js']
const phaseNames = ['bufferSetupMs', 'allocationMs', 'copyJsonMs', 'parseBankMs', 'encodeContentMs',
    'nativeStringPlanAllocationMs', 'nativeStringPlanMs', 'rowDecodeMs', 'chunkDispatchMs',
    'lookupIndexPrepareMs', 'lookupIndexCompactMs', 'lookupIndexEncodeMs']
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

/**
 * Sequential parser + completed lookup construction, not end-to-end import.
 * Fixture I/O, compilation, warmups, explicit GC and digest verification are outside time.
 * Grouping is the unchanged12-group plain-source byte planner for three production workers.
 * @param {string} dictionary
 * @param {string} cache
 * @param {string} sourceRoot
 * @param {Flags} flags
 * @returns {Promise<ScreenResult>}
 * @throws {Error} If the fixture, output or source identity is invalid.
 */
async function measure(dictionary, cache, sourceRoot, flags, wasmFilename, checkpointFilename) {
    const hostBefore = getHostEnvironment()
    const checkpoint = async (entry) => appendFile(checkpointFilename, JSON.stringify(entry) + '\n')
    // Explicit caller-selected local worktree; no dictionary-controlled path.
    // eslint-disable-next-line no-unsanitized/method, @typescript-eslint/no-unsafe-assignment
    const parser = /** @type {typeof import('../../ext/js/dictionary/term-bank-wasm-parser.js')} */ (await import(pathToFileURL(path.join(sourceRoot, 'ext/js/dictionary/term-bank-wasm-parser.js')).href))
    // eslint-disable-next-line no-unsanitized/method, @typescript-eslint/no-unsafe-assignment
    const prep = /** @type {typeof import('../../ext/js/dictionary/term-lookup-index-preparation.js')} */ (await import(pathToFileURL(path.join(sourceRoot, 'ext/js/dictionary/term-lookup-index-preparation.js')).href))
    if (typeof parser.setTermBankWasmModule !== 'function' || typeof parser.parseTermBankWithWasmColumnChunks !== 'function' ||
    typeof parser.consumeLastTermBankWasmParseProfile !== 'function' || typeof prep.prepareTermLookupIndexesFromPreinternedPlan !== 'function' ||
    typeof prep.hasCompletePreparedTermLookupIndexes !== 'function') { throw new Error('Selected worktree lacks the required parser/lookup API') }
    const lockBytes = await readFile(path.join(root, 'test/perf/dictionaries.lock.json'))
    /** @type {Record<string, Lock>} */
    const locks = /** @type {{dictionaries: Record<string, Lock>}} */ (parseJson(lockBytes.toString())).dictionaries
    const spec = locks[dictionary]
    /** @type {Uint8Array[]} */
    const sources = []
    if (dictionary !== 'jmdict' || !spec) { throw new Error('This fixed screen accepts only the locked JMdict fixture') }
    const archive = await readFile(path.join(cache, spec.cacheFile))
    if (sha256(archive) !== spec.sha256) { throw new Error('Dictionary SHA-256 differs from lock') }
    const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(archive)))
    try {
        const entries = (await reader.getEntries()).filter((entry) => /^term_bank_\d+\.json$/.test(entry.filename))
            .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)))
        for (const entry of entries) {
            if (!entry.getData) { throw new Error('Unreadable term bank') }
            sources.push(await entry.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true}))
        }
    } finally { await reader.close() }
    const totalSourceBytes = sources.reduce((sum, bytes) => sum + bytes.byteLength, 0)
    const groupCount = Math.min(sources.length, Math.max(3 * 4, Math.ceil(totalSourceBytes / (24 * 1024 * 1024))))
    if (groupCount !== 12) { throw new Error('Production JMdict grouping changed') }
    const groups = []
    let sourceStart = 0
    let consumedBytes = 0
    for (let i = 0; i < groupCount - 1; ++i) {
        const target = (totalSourceBytes - consumedBytes) / (groupCount - i)
        let end = sourceStart + 1
        let size = sources[sourceStart].byteLength
        const maxEnd = sources.length - (groupCount - i - 1)
        while (end < maxEnd) {
            const next = size + sources[end].byteLength
            if (Math.abs(next - target) > Math.abs(size - target)) { break }
            size = next
            ++end
        }
        groups.push(sources.slice(sourceStart, end))
        sourceStart = end
        consumedBytes += size
    }
    groups.push(sources.slice(sourceStart))
    const wasmBytes = await readFile(wasmFilename)
    parser.setTermBankWasmModule(await WebAssembly.compile(wasmBytes))
    /** @type {Record<string, string>} */
    const sourceHashes = {}
    for (const file of sourceFiles) { sourceHashes[file] = await sourceHash(path.join(sourceRoot, file)) }
    await checkpoint({stage: 'prepared', hostBefore, sourceRoot, sourceHashes,
        runnerSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
        wasmFilename, wasmSha256: sha256(wasmBytes), dictionary,
        archiveSha256: spec.sha256, lockSha256: sha256(lockBytes),
        sourceGroupBankCounts: groups.map((group) => group.length),
        sourceGroupByteLengths: groups.map((group) => group.reduce((sum, bytes) => sum + bytes.byteLength, 0))})
    const options = {...flags,
        initialContentBytesPerRow: 48,
        singleChunk: true,
        emitTermByteLists: false,
        computeContentHashes: true,
        emitContentSlab: true,
        emitTokenBinaryContent: true,
        mediaHintFastScan: false,
        compactContentMetadata: true,
        maxPendingChunks: 1,
        // Match the production importer: supported glossary types and their
        // required fields are part of the native parser workload.
        validateGlossaryTypes: true,
        prepareLookupIndexes: true}
    /**
     * @param {boolean} verify
     * @returns {Promise<Measurement>}
     * @throws {Error} If parsing or equality verification fails.
     */
    const execute = async (verify) => {
        const hostBeforePass = getHostEnvironment()
        let elapsedMs = 0
        let cpuUserMs = 0
        let cpuSystemMs = 0
        let lookupMs = 0
        let rows = 0
        let nativeSegments = 0
        let scratchReusedBytes = 0
        let scratchReuseMisses = 0
        let indexBytes = 0
        let ownedCompactExpressionRows = 0
        let maxWasmHeapBytes = 0
        let directArenaSegments = 0
        let validationPasses = 0
        const phaseMs = Object.fromEntries(phaseNames.map((name) => [name, 0]))
        const digest = createHash('sha256')
        for (const group of groups) {
            /** @type {Chunk|null} */
            let resultChunk = null
            const cpuBefore = process.threadCpuUsage()
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
            elapsedMs += safePerformance.now() - before
            const cpuElapsed = process.threadCpuUsage(cpuBefore)
            cpuUserMs += cpuElapsed.user / 1000
            cpuSystemMs += cpuElapsed.system / 1000
            const profile = parser.consumeLastTermBankWasmParseProfile()
            if (resultChunk === null || !profile) { throw new Error('Missing parser results') }
            if (profile.fusedParseAttempts !== 1 || profile.fusedParseFallbacks !== 0 || profile.nativeLookupScratchReuseGroups !== 1 || profile.nativeSegmentedLookupSegments !== 0 || profile.compactContentMetadataGroups !== 0) {
                throw new Error('Production JMdict parser/lookup route changed')
            }
            for (const name of phaseNames) { phaseMs[name] += profile[name] ?? 0 }
            const chunk = /** @type {Chunk} */ (resultChunk)
            const indexes = chunk.preparedLookupIndexes
            if (!indexes || !prep.hasCompletePreparedTermLookupIndexes(indexes, chunk.rowCount)) { throw new Error('Incomplete indexes') }
            rows += chunk.rowCount
            nativeSegments += profile.nativeSegmentedLookupSegments ?? 0
            scratchReusedBytes += profile.nativeLookupScratchReusedBytes ?? 0
            scratchReuseMisses += profile.nativeLookupScratchReuseMisses ?? 0
            lookupMs += profile.lookupIndexPrepareMs ?? 0
            maxWasmHeapBytes = Math.max(maxWasmHeapBytes, profile.maxWasmHeapBytes ?? 0)
            if (!verify) { continue }
            // Digest all rows and index bytes before the next parse reuses memory.
            for (const [key, entry] of indexes) {
                digest.update(key)
                digest.update(entry.bytes)
                indexBytes += entry.bytes.byteLength
                const expressions = entry.preinternedPlan.expressionIndexes
                if (expressions instanceof Uint16Array && expressions.buffer === entry.bytes.buffer) {
                    ownedCompactExpressionRows += expressions.length
                }
                for (const view of [entry.preinternedPlan.stringLengths,
                    entry.preinternedPlan.stringOffsets,
                    entry.preinternedPlan.stringHashes,
                    entry.preinternedPlan.stringsBuffer,
                    // Normalize only this in-memory representation outside the
                    // timed region; persisted index and key bytes stay exact.
                    Uint32Array.from(expressions),
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
        if (rows !== spec.termRows) { throw new Error('Dictionary row count differs from lock') }
        return {scratchReusedBytes,
            scratchReuseMisses,
            elapsedMs,
            cpuUserMs,
            cpuSystemMs,
            cpuMs: cpuUserMs + cpuSystemMs,
            phaseMs,
            hostBefore: hostBeforePass,
            hostAfter: getHostEnvironment(),
            lookupMs,
            rows,
            nativeSegments,
            indexBytes,
            ownedCompactExpressionRows,
            maxWasmHeapBytes,
            directArenaSegments,
            validationPasses,
            digest: verify ? digest.digest('hex') : null}
    }
    const cold = await execute(true)
    await checkpoint({stage: 'cold', result: cold})
    globalThis.gc?.()
    const warmups = []
    for (let warmup = 0; warmup < 8; ++warmup) {
        const observation = await execute(false)
        warmups.push(observation)
        await checkpoint({stage: 'warmup', index: warmup, result: observation})
        globalThis.gc?.()
    }
    globalThis.gc?.()
    const result = await execute(true)
    await checkpoint({stage: 'warm', result})
    if (result.digest !== cold.digest || result.indexBytes !== cold.indexBytes) { throw new Error('Cold/warm output mismatch') }
    for (const file of sourceFiles) {
        if (sourceHashes[file] !== await sourceHash(path.join(sourceRoot, file))) { throw new Error('Source changed during measurement') }
    }
    if (sha256(await readFile(wasmFilename)) !== sha256(wasmBytes)) { throw new Error('WASM changed during measurement') }
    return {...result,
        cold,
        warmups,
        hostBefore,
        hostAfter: getHostEnvironment(),
        flags,
        validateGlossaryTypes: options.validateGlossaryTypes,
        dictionary,
        sourceGroupBankCounts: groups.map((group) => group.length),
        sourceGroupByteLengths: groups.map((group) => group.reduce((sum, bytes) => sum + bytes.byteLength, 0)),
        groupCount: groups.length,
        wasmFilename,
        node: process.version,
        sourceRoot,
        sourceHashes,
        wasmSha256: sha256(wasmBytes),
        lockSha256: sha256(lockBytes),
        archiveSha256: spec.sha256,
        runnerSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
        afterVerificationMemory: process.memoryUsage(),
        lifetimeMaxRssKiB: process.resourceUsage().maxRSS}
}

const {values, positionals} = parseArgs({allowPositionals: true,
    options: {
        'child': {type: 'boolean', default: false},
        'flags': {type: 'string', default: '{}'},
        'cache-dir': {type: 'string', default: path.join(root, 'builds/e2e-dictionary-cache')},
        'out': {type: 'string', default: path.join(root, 'builds/perf/lookup-construction.json')},
        'source-root': {type: 'string', default: root},
        'baseline-root': {type: 'string'},
        'wasm': {type: 'string'},
        'baseline-wasm': {type: 'string'},
        'candidate-wasm': {type: 'string'},
        'candidate-c': {type: 'string'},
        'checkpoint': {type: 'string'},
    }})
const dictionary = positionals[0]
if (dictionary !== 'jmdict') { throw new Error('Provide jmdict; this fixed screen has12 production groups') }
/** @type {Flags} */
const flags = parseJson(values.flags)
const {snapshotTermBankExperiments} = await import(pathToFileURL(path.join(root, 'ext/js/dictionary/term-bank-experiments.js')))
if (flags === null || typeof flags !== 'object' || Array.isArray(flags)) { throw new Error('Flags must be a JSON object') }
const effective = snapshotTermBankExperiments(flags)
for (const [key, value] of Object.entries(flags)) {
    if (!(key in effective) || typeof value !== 'boolean') { throw new Error(`Unknown or non-boolean flag: ${key}`) }
}
if (values.child) {
    if (!values.wasm || !values.checkpoint) { throw new Error('Child requires explicit module and checkpoint paths') }
    console.log(JSON.stringify(await measure(dictionary, values['cache-dir'], values['source-root'], flags, path.resolve(values.wasm), path.resolve(values.checkpoint))))
} else {
    if (!values['baseline-wasm'] || !values['candidate-wasm']) { throw new Error('Provide explicit baseline and candidate modules') }
    const orders = ['ACB', 'CBA', 'BAC', 'ABC', 'BCA', 'CAB']
    await mkdir(path.dirname(values.out), {recursive: true})
    await writeFile(values.out, '', {flag: 'wx'})
    const observations = []
    const childOutcomes = []
    const childrenDirectory = path.resolve(values.out.replace(/\.json$/, '') + '-children')
    await mkdir(childrenDirectory, {recursive: true})
    const plan = {
        dictionary,
        orders,
        coldPassesPerFreshProcess: 1,
        warmupsPerFreshProcess: 8,
        gcAfterEachWarmup: true,
        measuredPassesPerProcess: 1,
        flags,
        boundary: 'Sequential native parser plus completed lookup; group thread CPU and wall exclude archive inflation, WASM compilation, warmups, explicit GC, result validation and full output digest.',
        phaseBoundary: 'Named parser phase wall totals are diagnostic Date.now counters. Several phases nest or overlap; they must not be summed as independent costs.',
        validateGlossaryTypes: true,
        baselineRoot: path.resolve(values['baseline-root'] ?? root),
        sourceRoot: path.resolve(values['source-root']),
        baselineWasm: path.resolve(values['baseline-wasm']),
        candidateWasm: path.resolve(values['candidate-wasm']),
        candidateC: values['candidate-c'] ? path.resolve(values['candidate-c']) : null,
        candidateCSha256: values['candidate-c'] ? await sourceHash(path.resolve(values['candidate-c'])) : null,
        grouping: 'Unchanged three-worker plain-source policy,12 byte-balanced JMdict groups',
        runnerSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
        hostBefore: getHostEnvironment(),
        childrenDirectory,
    }
    if (plan.sourceRoot !== plan.baselineRoot) { throw new Error('All arms must use identical baseline JS') }
    const modulePaths = {A: plan.baselineWasm, B: plan.candidateWasm, C: plan.baselineWasm}
    const expectedWasmHashes = new Map(await Promise.all(Object.entries(modulePaths).map(async ([arm, filename]) => (
        [arm, sha256(await readFile(filename))]
    ))))
    if (expectedWasmHashes.get('A') !== '8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee') {
        throw new Error('Baseline module differs from the pinned production rebuild')
    }
    plan.moduleSha256 = Object.fromEntries(expectedWasmHashes)
    const save = async (status) => writeFile(values.out, JSON.stringify({...plan, ...status, observations, childOutcomes}, null, 2))
    try {
        await save({complete: false})
        for (const [pair, order] of orders.entries()) {
            for (const arm of order) {
                const expectedSourceRoot = arm === 'B' ? plan.sourceRoot : plan.baselineRoot
                const prefix = path.join(childrenDirectory, `${pair + 1}-${arm}`)
                const checkpointFile = prefix + '.jsonl'
                await writeFile(checkpointFile, '', {flag: 'wx'})
                const args = [fileURLToPath(import.meta.url), dictionary, '--child', '--cache-dir', values['cache-dir'],
                    '--source-root', expectedSourceRoot, '--wasm', modulePaths[arm], '--flags', JSON.stringify(flags),
                    '--checkpoint', checkpointFile]
                const hostBeforeChild = getHostEnvironment()
                const child = spawnSync(process.execPath, ['--expose-gc', ...args], {encoding: 'utf8', timeout: 300000, maxBuffer: 4 * 1024 * 1024})
                const childOutcome = {pair, arm, status: child.status, signal: child.signal, error: String(child.error ?? ''),
                    checkpointFile, stdoutFile: prefix + '.stdout', stderrFile: prefix + '.stderr',
                    hostBefore: hostBeforeChild, hostAfter: getHostEnvironment()}
                await writeFile(childOutcome.stdoutFile, child.stdout ?? '')
                await writeFile(childOutcome.stderrFile, child.stderr ?? '')
                childOutcomes.push(childOutcome)
                await save({complete: false})
                if (child.status !== 0) { throw new Error(`Child failed (${child.status}, signal ${child.signal}): ${child.error ?? ''}\n${child.stderr}`) }
                const result = parseJson(child.stdout)
                if (path.resolve(result.sourceRoot) !== expectedSourceRoot || result.wasmSha256 !== expectedWasmHashes.get(arm)) {
                    throw new Error(`Child ${arm} did not measure the requested source root and WASM`)
                }
                if (result.dictionary !== dictionary || result.validateGlossaryTypes !== true) { throw new Error('Unexpected workload') }
                if (result.runnerSha256 !== plan.runnerSha256) { throw new Error('Runner changed during cohort') }
                observations.push({pair, arm, result})
                await save({complete: false})
                console.log(`${dictionary} block ${pair + 1}/${orders.length} ${arm}: wall ${result.elapsedMs.toFixed(2)}ms CPU ${result.cpuMs.toFixed(2)}ms`)
            }
        }
        if (plan.candidateC && await sourceHash(plan.candidateC) !== plan.candidateCSha256) { throw new Error('Candidate C source changed during cohort') }
        for (const run of observations) {
            if (JSON.stringify(run.result.sourceHashes) !== JSON.stringify(observations[0].result.sourceHashes)) { throw new Error('JS runtime differs across arms') }
        }
        for (const pair of orders.keys()) {
            const runs = observations.filter((x) => x.pair === pair).map((x) => x.result)
            if (runs.some((x) => x.digest !== runs[0].digest || x.indexBytes !== runs[0].indexBytes || x.archiveSha256 !== runs[0].archiveSha256 || x.lockSha256 !== runs[0].lockSha256)) {
                throw new Error('Full output byte or fixture identity mismatch')
            }
            if (runs.some((x) => x.cold.digest !== runs[0].cold.digest || x.cold.indexBytes !== runs[0].cold.indexBytes)) { throw new Error('Cold output byte mismatch') }
        }
        for (const arm of ['A', 'B', 'C']) {
            const runs = observations.filter((x) => x.arm === arm)
            const identity = (x) => JSON.stringify([x.result.sourceHashes, x.result.wasmSha256, x.result.runnerSha256])
            if (runs.some((x) => identity(x) !== identity(runs[0]))) { throw new Error('Source identity changed across cohort') }
        }
        function comparison(arm, metric, reference = 'A', cold = false) {
            const value = (x) => (cold ? x.result.cold : x.result)[metric]
            const ratios = orders.map((_, pair) => value(observations.find((x) => x.pair === pair && x.arm === arm)) /
                value(observations.find((x) => x.pair === pair && x.arm === reference)))
            const sorted = [...ratios].sort((a, b) => a - b)
            const sum = (a) => observations.filter((x) => x.arm === a).reduce((s, x) => s + value(x), 0)
            return {medianPairedChangePercent: 100 * ((sorted[2] + sorted[3]) / 2 - 1),
                equalWorkTotalChangePercent: 100 * (sum(arm) / sum(reference) - 1),
                fasterPairs: ratios.filter((x) => x < 1).length, ratios}
        }
        const summary = {candidate: {cpu: comparison('B', 'cpuMs'), wall: comparison('B', 'elapsedMs')},
            duplicateBaseline: {cpu: comparison('C', 'cpuMs'), wall: comparison('C', 'elapsedMs')},
            candidateVsDuplicateBaseline: {cpu: comparison('B', 'cpuMs', 'C'), wall: comparison('B', 'elapsedMs', 'C')},
            cold: {candidate: {cpu: comparison('B', 'cpuMs', 'A', true), wall: comparison('B', 'elapsedMs', 'A', true)},
                duplicateBaseline: {cpu: comparison('C', 'cpuMs', 'A', true), wall: comparison('C', 'elapsedMs', 'A', true)},
                candidateVsDuplicateBaseline: {cpu: comparison('B', 'cpuMs', 'C', true), wall: comparison('B', 'elapsedMs', 'C', true)}}}
        if (sha256(await readFile(fileURLToPath(import.meta.url))) !== plan.runnerSha256) { throw new Error('Runner changed during cohort') }
        await save({complete: true, hostAfter: getHostEnvironment(), summary})
        console.log(JSON.stringify(summary))
    } catch (error) {
        await save({complete: false, hostAfter: getHostEnvironment(), error: String(error)})
        throw error
    }
}
