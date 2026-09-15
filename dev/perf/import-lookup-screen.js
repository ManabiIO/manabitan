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

import {readFile, writeFile, mkdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {fileURLToPath, pathToFileURL} from 'node:url'
import path from 'node:path'
import {parseArgs} from 'node:util'
import {parseJson} from '../../ext/js/core/json.js'
import {safePerformance} from '../../ext/js/core/safe-performance.js'
import {ZipReader, Uint8ArrayReader, Uint8ArrayWriter} from '@zip.js/zip.js'

/** @typedef {import('dictionary-importer').ImportExperiments} Flags */
/** @typedef {Parameters<Parameters<typeof import('../../ext/js/dictionary/term-bank-wasm-parser.js').parseTermBankWithWasmColumnChunks>[2]>[0] & {preparedLookupIndexes?: Map<string, import('../../ext/js/dictionary/term-lookup-index-preparation.js').PreparedTermLookupIndex>}} Chunk */
/** @typedef {{cacheFile: string, sha256: string, termRows: number}} Lock */
/** @typedef {{elapsedMs: number, lookupMs: number, rows: number, scratchReusedBytes: number, scratchReuseMisses: number, nativeSegments: number, indexBytes: number, maxWasmHeapBytes: number, directArenaSegments: number, validationPasses: number, digest: string|null}} Measurement */
/** @typedef {Measurement & {flags: Flags, dictionary: string, filesPerGroup: number, node: string, sourceRoot: string, sourceHashes: Record<string, string>, wasmSha256: string, lockSha256: string, archiveSha256: string, runnerSha256: string, afterVerificationMemory: {rss: number, heapTotal: number, heapUsed: number, external: number, arrayBuffers: number}, lifetimeMaxRssKiB: number}} ScreenResult */
/** @typedef {{pair: number, arm: string, result: ScreenResult}} Observation */
const root = fileURLToPath(new URL('../../', import.meta.url))
/** @type {Record<string, number>} */
const filesPerGroup = {jmdict: 7, jmnedict: 9, jitendex: 10}
const sourceFiles = ['ext/js/dictionary/term-bank-wasm-parser.js',
    'ext/js/dictionary/term-bank-experiments.js',
    'ext/js/dictionary/term-lookup-scratch.js',
    'ext/js/dictionary/term-lookup-index-preparation.js',
    'ext/js/dictionary/term-lookup-index.js',
    'ext/js/dictionary/term-record-preinterned-plan.js',
    'ext/js/dictionary/wasm/term-bank-parser.c']
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
 * Fixture I/O, compilation, warmups, GC and digest verification are outside time.
 * Grouping is fixed component-fixture grouping, not a production planner override.
 * @param {string} dictionary
 * @param {string} cache
 * @param {string} sourceRoot
 * @param {Flags} flags
 * @returns {Promise<ScreenResult>}
 * @throws {Error} If the fixture, output or source identity is invalid.
 */
async function measure(dictionary, cache, sourceRoot, flags) {
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
    if (!spec || !filesPerGroup[dictionary]) { throw new Error('Use jmdict, jmnedict or jitendex') }
    const archive = await readFile(path.join(cache, spec.cacheFile))
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
    const wasmBytes = await readFile(path.join(sourceRoot, 'ext/lib/term-bank-parser.wasm'))
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
        prepareLookupIndexes: true}
    /**
     * @param {boolean} verify
     * @returns {Promise<Measurement>}
     * @throws {Error} If parsing or equality verification fails.
     */
    const execute = async (verify) => {
        let elapsedMs = 0
        let lookupMs = 0
        let rows = 0
        let nativeSegments = 0
        let scratchReusedBytes = 0
        let scratchReuseMisses = 0
        let indexBytes = 0
        let maxWasmHeapBytes = 0
        let directArenaSegments = 0
        let validationPasses = 0
        const digest = createHash('sha256')
        for (let start = 0; start < sources.length; start += filesPerGroup[dictionary]) {
            /** @type {Chunk|null} */
            let resultChunk = null
            const group = sources.slice(start, start + filesPerGroup[dictionary])
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
            if (!verify) { continue }
            // Digest all rows and index bytes before the next parse reuses memory.
            for (const [key, entry] of indexes) {
                digest.update(key)
                digest.update(entry.bytes)
                indexBytes += entry.bytes.byteLength
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
        if (rows !== spec.termRows) { throw new Error('Dictionary row count differs from lock') }
        return {scratchReusedBytes,
            scratchReuseMisses,
            elapsedMs,
            lookupMs,
            rows,
            nativeSegments,
            indexBytes,
            maxWasmHeapBytes,
            directArenaSegments,
            validationPasses,
            digest: verify ? digest.digest('hex') : null}
    }
    for (let warmup = 0; warmup < 2; ++warmup) { await execute(false) }
    globalThis.gc?.()
    const result = await execute(true)
    for (const file of sourceFiles) {
        if (sourceHashes[file] !== await sourceHash(path.join(sourceRoot, file))) { throw new Error('Source changed during measurement') }
    }
    return {...result,
        flags,
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

const {values, positionals} = parseArgs({allowPositionals: true,
    options: {
        'child': {type: 'boolean', default: false},
        'pairs': {type: 'string', default: '8'},
        'flags': {type: 'string', default: '{"experimentalNativeSegmentedLookup":true}'},
        'cache-dir': {type: 'string', default: path.join(root, 'builds/e2e-dictionary-cache')},
        'out': {type: 'string', default: path.join(root, 'builds/perf/lookup-construction.json')},
        'source-root': {type: 'string', default: root},
        'baseline-root': {type: 'string'},
        'initial-order': {type: 'string', default: 'AB'},
    }})
const dictionary = positionals[0]
if (!dictionary || !filesPerGroup[dictionary]) { throw new Error('Provide jmdict, jmnedict or jitendex') }
/** @type {Flags} */
const flags = parseJson(values.flags)
const {snapshotTermBankExperiments} = await import('../../ext/js/dictionary/term-bank-experiments.js')
if (flags === null || typeof flags !== 'object' || Array.isArray(flags)) { throw new Error('Flags must be a JSON object') }
const effective = snapshotTermBankExperiments(flags)
for (const [key, value] of Object.entries(flags)) {
    if (!(key in effective) || typeof value !== 'boolean') { throw new Error(`Unknown or non-boolean flag: ${key}`) }
}
if (values.child) {
    console.log(JSON.stringify(await measure(dictionary, values['cache-dir'], values['source-root'], flags)))
} else {
    const pairs = Number(values.pairs)
    if (!Number.isInteger(pairs) || pairs < 2 || !['AB', 'BA'].includes(values['initial-order'])) { throw new Error('Invalid fixed run plan') }
    await mkdir(path.dirname(values.out), {recursive: true})
    /** @type {Observation[]} */
    const observations = []
    const plan = {dictionary, pairs, flags, initialOrder: values['initial-order'], baselineRoot: values['baseline-root'] ?? root}
    const save = async (/** @type {object} */ status) => writeFile(values.out, JSON.stringify({...plan, ...status, observations}, null, 2))
    try {
        for (let pair = 0; pair < pairs; ++pair) {
            const order = pair % 2 === 0 ? values['initial-order'] : [...values['initial-order']].reverse().join('')
            for (const arm of order) {
                const args = [fileURLToPath(import.meta.url),
                    dictionary,
                    '--child',
                    '--cache-dir',
                    values['cache-dir'],
                    '--source-root',
arm === 'A' ? values['baseline-root'] ?? root : root,
'--flags',
JSON.stringify(arm === 'A' ? {} : flags)]
                const child = spawnSync(process.execPath, ['--expose-gc', ...args], {encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024})
                if (child.status !== 0) { throw new Error(`Child failed (${child.status}): ${child.error ?? ''}\n${child.stderr}`) }
                const result = /** @type {Awaited<ReturnType<typeof measure>>} */ (parseJson(child.stdout))
                observations.push({pair, arm, result})
                await save({complete: false})
                console.log(`${dictionary} pair ${pair + 1}/${pairs} ${arm}: ${result.elapsedMs.toFixed(2)}ms`)
            }
        }
        const ratios = []
        for (let pair = 0; pair < pairs; ++pair) {
            const a = observations.find((x) => x.pair === pair && x.arm === 'A')?.result
            const b = observations.find((x) => x.pair === pair && x.arm === 'B')?.result
            if (!a || !b || a.digest !== b.digest || a.indexBytes !== b.indexBytes) { throw new Error('Full output byte oracle mismatch') }
            if (a.archiveSha256 !== b.archiveSha256 || a.lockSha256 !== b.lockSha256) { throw new Error('Fixture identity mismatch') }
            ratios.push(b.elapsedMs / a.elapsedMs)
        }
        for (const arm of ['A', 'B']) {
            const runs = observations.filter((x) => x.arm === arm)
            const identity = (/** @type {Observation} */ x) => JSON.stringify([x.result.sourceHashes, x.result.wasmSha256, x.result.runnerSha256])
            if (runs.some((x) => identity(x) !== identity(runs[0]))) { throw new Error('Source identity changed across cohort') }
        }
        ratios.sort((a, b) => a - b)
        const sum = (/** @type {string} */ arm) => observations.filter((x) => x.arm === arm).reduce((s, x) => s + x.result.elapsedMs, 0)
        const summary = {medianPairedChangePercent: 100 * ((ratios[Math.floor((pairs - 1) / 2)] + ratios[Math.floor(pairs / 2)]) / 2 - 1),
            equalWorkTotalChangePercent: 100 * (sum('B') / sum('A') - 1),
            fasterPairs: ratios.filter((x) => x < 1).length}
        await save({complete: true, summary})
        console.log(JSON.stringify(summary))
    } catch (error) {
        await save({complete: false, error: String(error)})
        throw error
    }
}
