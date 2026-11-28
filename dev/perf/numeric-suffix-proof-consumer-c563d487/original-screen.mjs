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

import {readFile} from 'node:fs/promises'
import {openAsBlob, createReadStream} from 'node:fs'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {fileURLToPath, pathToFileURL} from 'node:url'
import path from 'node:path'
import {parseArgs} from 'node:util'
const parseJson = JSON.parse
const safePerformance = performance
import {ZipReader, BlobReader} from '@zip.js/zip.js'

/** @typedef {import('dictionary-importer').ImportExperiments} Flags */
/** @typedef {Parameters<Parameters<typeof import('../../ext/js/dictionary/term-bank-wasm-parser.js').parseTermBankWithWasmColumnChunks>[2]>[0] & {preparedLookupIndexes?: Map<string, import('../../ext/js/dictionary/term-lookup-index-preparation.js').PreparedTermLookupIndex>}} Chunk */
/** @typedef {{cacheFile: string, sha256: string, termRows: number}} Lock */
/** @typedef {{elapsedMs: number, lookupMs: number, rows: number, scratchReusedBytes: number, scratchReuseMisses: number, nativeSegments: number, indexBytes: number, ownedCompactExpressionRows: number, maxWasmHeapBytes: number, directArenaSegments: number, validationPasses: number, digest: string|null}} Measurement */
/** @typedef {Measurement & {flags: Flags, validateGlossaryTypes: boolean, dictionary: string, filesPerGroup: number, node: string, sourceRoot: string, sourceHashes: Record<string, string>, wasmSha256: string, lockSha256: string, archiveSha256: string, runnerSha256: string, afterVerificationMemory: {rss: number, heapTotal: number, heapUsed: number, external: number, arrayBuffers: number}, lifetimeMaxRssKiB: number}} ScreenResult */
/** @typedef {{pair: number, arm: string, result: ScreenResult}} Observation */
const root = fileURLToPath(new URL('../../../', import.meta.url))
/** @type {Record<string, number>} */
const filesPerGroup = {jmdict: 7, jitendex: 10, vndb: 4}
const sourceFiles = ['ext/js/dictionary/term-bank-wasm-parser.js',
    'ext/js/dictionary/term-bank-experiments.js',
    'ext/js/dictionary/term-lookup-scratch.js',
    'ext/js/dictionary/term-lookup-index-preparation.js',
    'ext/js/dictionary/term-lookup-index.js',
    'ext/js/dictionary/term-record-preinterned-plan.js',
    'ext/js/dictionary/wasm/term-bank-parser.c', 'ext/js/dictionary/term-bank-source-pipeline.js', 'ext/js/dictionary/dense-zip-directory.js', 'dev/data/dictionary-wasm/manifest.json', 'package-lock.json']
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
 * Grouping is fixed component-fixture grouping, not a production planner override.
 * @param {string} dictionary
 * @param {string} cache
 * @param {string} sourceRoot
 * @param {Flags} flags
 * @returns {Promise<ScreenResult>}
 * @throws {Error} If the fixture, output or source identity is invalid.
 */
async function measure(dictionary, cache, sourceRoot, flags, diagnosticWasm = null) {
    let diagnosticExports = null
    if (diagnosticWasm !== null) {
        const originalInstantiate = WebAssembly.instantiate.bind(WebAssembly)
        WebAssembly.instantiate = async (...args) => {
            const result = await originalInstantiate(...args)
            const instance = result instanceof WebAssembly.Instance ? result : result.instance
            if (typeof instance.exports.row_suffix_diag_get === 'function') { diagnosticExports = instance.exports }
            return result
        }
    }
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
    if (!spec || !filesPerGroup[dictionary]) { throw new Error('Use jmdict, jitendex or vndb') }
    const archivePath = path.join(cache, spec.cacheFile)
    const archive = await openAsBlob(archivePath)
    const archiveHash = createHash('sha256')
    for await (const bytes of createReadStream(archivePath)) { archiveHash.update(bytes) }
    if (archiveHash.digest('hex') !== spec.sha256) { throw new Error('Dictionary SHA-256 differs from lock') }
    const {readDenseZipDirectory} = await import(pathToFileURL(path.join(sourceRoot, 'ext/js/dictionary/dense-zip-directory.js')))
    let entries = await readDenseZipDirectory(archive)
    if (!entries) {
        const zipReader = new ZipReader(new BlobReader(archive))
        try { entries = await zipReader.getEntries() } finally { await zipReader.close() }
    }
    const sources = entries.filter((entry) => /^term_bank_\d+\.json$/.test(entry.filename))
        .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)))
    entries = null
    const {RawZipPayloadReader} = await import(pathToFileURL(path.join(sourceRoot, 'ext/js/dictionary/term-bank-source-pipeline.js')))
    const sourceReader = new RawZipPayloadReader(archive)
    const wasmBytes = await readFile(diagnosticWasm ?? path.join(sourceRoot, 'ext/lib/term-bank-parser.wasm'))
    parser.setTermBankWasmModule(await WebAssembly.compile(wasmBytes))
    /** @type {Record<string, string>} */
    const sourceHashes = {}
    for (const file of sourceFiles) { sourceHashes[file] = await sourceHash(path.join(sourceRoot, file)) }
    const options = {...flags,
        singleChunk: true,
        emitTermByteLists: false,
        computeContentHashes: true,
        emitContentSlab: true,
        emitTokenBinaryContent: true,
        mediaHintFastScan: true,
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
        let elapsedMs = 0
        let cpuMs = 0
        let inflateCpuMs = 0
        let nativeParseMs = 0
        let fusedAttempts = 0
        let fusedFallbacks = 0
        let glossaryReuseCount = 0
        let lookupMs = 0
        let inflateMs = 0
        let parseMs = 0
        let rows = 0
        let nativeSegments = 0
        let scratchReusedBytes = 0
        let scratchReuseMisses = 0
        let indexBytes = 0
        let ownedCompactExpressionRows = 0
        let maxWasmHeapBytes = 0
        let directArenaSegments = 0
        let validationPasses = 0
        const digest = createHash('sha256')
        for (let start = 0; start < sources.length; start += filesPerGroup[dictionary]) {
            /** @type {Chunk|null} */
            let resultChunk = null
            const group = await Promise.all(sources.slice(start, start + filesPerGroup[dictionary]).map(async (entry) => ({...entry, bytes: await sourceReader.read(entry, new AbortController().signal, true)})))
            const beforeCpu = process.cpuUsage()
            const before = safePerformance.now()
            const preloadedSource = await parser.inflateCompressedTermBankSourcesWasm(group, options, true)
            inflateMs += safePerformance.now() - before
            const inflatedCpu = process.cpuUsage(beforeCpu)
            inflateCpuMs += (inflatedCpu.user + inflatedCpu.system) / 1000
            const parseStart = safePerformance.now()
            await parser.parseTermBankWithWasmColumnChunks(new Uint8Array(0), 3, (/** @type {Chunk} */ chunk) => {
                resultChunk = chunk
                if (!chunk.preparedLookupIndexes) {
                    const result = prep.prepareTermLookupIndexesFromPreinternedPlan(chunk, null, flags)
                    if (!result) { throw new Error('Missing lookup indexes') }
                    chunk.preparedLookupIndexes = result.indexes
                    lookupMs += result.totalMs
                    directArenaSegments += result.directArenaSegments ?? 0
                    validationPasses += result.compactionSourceValidationPasses ?? 0
                }
            }, 2048, {...options, preloadedSource})
            parseMs += safePerformance.now() - parseStart
            elapsedMs += safePerformance.now() - before
            const groupCpu = process.cpuUsage(beforeCpu)
            cpuMs += (groupCpu.user + groupCpu.system) / 1000
            const profile = parser.consumeLastTermBankWasmParseProfile()
            if (resultChunk === null || !profile) { throw new Error('Missing parser results') }
            nativeParseMs += (profile.parseBankMs ?? 0) + (profile.encodeContentMs ?? 0)
            fusedAttempts += profile.fusedParseAttempts ?? 0
            fusedFallbacks += profile.fusedParseFallbacks ?? 0
            glossaryReuseCount += profile.validatedGlossaryReuseCount ?? 0
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
            for (const view of [chunk.contentUniqueIndexList, chunk.contentDedupPlan?.uniqueRowIndexes,
                chunk.contentDedupPlan?.uniqueSignatures]) {
                digest.update(view ? 'present' : 'absent')
                if (view) { updateView(digest, view) }
            }
            digest.update(JSON.stringify({uniqueCount: chunk.contentDedupPlan?.uniqueCount ?? null,
                contentMetaByUniqueIndex: chunk.contentMetaByUniqueIndex ?? false,
                useResolvedContentReferences: chunk.useResolvedContentReferences ?? false}))
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
            digest.update(JSON.stringify(chunk.mediaRows.map(({index, row, imagePaths}) => ({
                index, imagePaths: imagePaths ?? null,
                row: Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
                    value instanceof Uint8Array ? {length: value.length, sha256: sha256(value)} :
                        Object.is(value, -0) ? {negativeZero: true} : value ?? null,
                ])),
            }))))
        }
        if (rows !== spec.termRows) { throw new Error('Dictionary row count differs from lock') }
        return {scratchReusedBytes,
            scratchReuseMisses,
            elapsedMs,
            cpuMs,
            inflateCpuMs,
            nativeParseMs,
            fusedAttempts,
            fusedFallbacks,
            glossaryReuseCount,
            inflateMs,
            parseMs,
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
    for (let warmup = 0; warmup < (diagnosticWasm === null ? 2 : 0); ++warmup) { await execute(false) }
    globalThis.gc?.()
    const result = await execute(true)
    for (const file of sourceFiles) {
        if (sourceHashes[file] !== await sourceHash(path.join(sourceRoot, file))) { throw new Error('Source changed during measurement') }
    }
    return {...result,
        diagnostic: diagnosticExports === null ? null : Object.fromEntries(['attempts', 'boundedRanges', 'tailRejected', 'fullRejected', 'hits', 'hitBytes', 'potentialRangeBytes', 'eligibleStreakRows', 'numericRejected'].map((key, index) => [key, Number(diagnosticExports.row_suffix_diag_get(index))])),
        diagnosticWasm,
        gitHead: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: sourceRoot, encoding: 'utf8'}).trim(),
        gitTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {cwd: sourceRoot, encoding: 'utf8'}).trim(),
        trackedChanges: execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {cwd: sourceRoot, encoding: 'utf8'}).trim(),
        warmupPasses: diagnosticWasm === null ? 2 : 0,
        sourceRoute: 'native compressed-source inflation with per-bank CRC and strict grammar validation',
        routeOptions: dictionary === 'vndb' ? 'Production-default component options plus an explicitly enabled escaped-key native route' : 'Production-default component options',
        scope: 'Sequential component only: native inflation+CRC+parse+lookup; fixture I/O, compilation, warmups, full-output digest, workers, storage, compression and UI excluded. Fixed groups are a component workload, not claimed production partitions.',
        flags,
        validateGlossaryTypes: options.validateGlossaryTypes,
        dictionary,
        filesPerGroup: filesPerGroup[dictionary],
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


const {values, positionals} = parseArgs({allowPositionals: true, options: {
    'source-root': {type: 'string'},
    'cache-dir': {type: 'string'},
    'diagnostic-wasm': {type: 'string'},
}})
const dictionary = positionals[0]
if (!filesPerGroup[dictionary] || !values['source-root'] || !values['cache-dir']) { throw new Error('Expected dictionary, --source-root, --cache-dir') }
// The large projected source route explicitly enables escaped native keys.
const flags = dictionary === 'vndb' ? {experimentalNativeEscapedKeys: true} : {}
console.log(JSON.stringify(await measure(dictionary, values['cache-dir'], path.resolve(values['source-root']), flags, values['diagnostic-wasm'] ?? null)))
