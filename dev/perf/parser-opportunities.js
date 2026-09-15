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
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {fileURLToPath, pathToFileURL} from 'node:url'
import path from 'node:path'
import os from 'node:os'
import {performance as safePerformance} from 'node:perf_hooks'
import {ZipReader, Uint8ArrayReader, Uint8ArrayWriter} from '@zip.js/zip.js'
import {parseJson} from '../../ext/js/core/json.js'
import {loadDictionaryFixtures} from './dictionary-fixtures.js'
import {snapshotTermBankExperiments} from '../../ext/js/dictionary/term-bank-experiments.js'

/** @typedef {import('../../ext/js/dictionary/term-bank-wasm-parser.js').TermBankColumnChunk} Chunk */
/** @typedef {{wallMs: number, rows: number, digest: string, encodedBytes: number, lookupBytes: number, maxWasmHeapBytes: number, maxSampledRssBytes: number, counters: Record<string, number>}} Measurement */
/** @typedef {{warmup: Measurement, measured: Measurement, source: Record<string, string>, fixture: {sha256: string, rows: number, banks: number}, node: string, v8: string, cpu: string}} Observation */
/** @typedef {{order: string[], A?: Observation, B?: Observation, error?: string}} Pair */
const here = fileURLToPath(import.meta.url)
const root = path.resolve(path.dirname(here), '../..')
const args = process.argv.slice(2)
/**
 * @param {Uint8Array|string} bytes
 * @returns {string}
 */
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/**
 * @param {string} json
 * @returns {import('dictionary-importer').ImportExperiments}
 * @throws {Error} If a flag is unknown or not boolean.
 */
function parseFlags(json) {
    const value = parseJson(json)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) { throw new Error('Flags must be an object') }
    const allowed = snapshotTermBankExperiments()
    for (const [name, enabled] of Object.entries(value)) {
        if (!Object.hasOwn(allowed, name) || typeof enabled !== 'boolean') { throw new Error(`Invalid experiment: ${name}`) }
    }
    return /** @type {import('dictionary-importer').ImportExperiments} */ (value)
}

/**
 * @param {string} sourceRoot
 * @returns {Promise<Record<string, string>>}
 */
async function fingerprint(sourceRoot) {
    const files = ['ext/js/dictionary/wasm/term-bank-parser.c',
        'ext/js/dictionary/term-bank-wasm-parser.js',
        'ext/js/dictionary/term-bank-experiments.js',
        'ext/lib/term-bank-parser.wasm',
        'test/perf/dictionaries.lock.json',
        'package-lock.json']
    return Object.fromEntries(await Promise.all(files.map(async (file) => [file, sha256(await readFile(path.join(sourceRoot, file)))])))
}

/**
 * @param {import('node:crypto').Hash} hash
 * @param {ArrayBufferView} value
 */
function hashView(hash, value) {
    hash.update(String(value.byteLength) + ':')
    hash.update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
}

/**
 * @param {import('node:crypto').Hash} hash
 * @param {Chunk} chunk
 * @returns {{encodedBytes: number, lookupBytes: number}}
 * @throws {Error} If canonical content or lookup preparation is incomplete.
 */
function verifyChunk(hash, chunk) {
    const plan = chunk.termRecordPreinternedPlan
    const meta = chunk.contentMetaList
    const content = chunk.contentBytesBuffer
    if (!(meta instanceof Uint32Array) || !(content instanceof Uint8Array) || !chunk.preparedLookupIndexes) {
        throw new Error('Incomplete content or lookup sidecars')
    }
    for (const view of [plan.stringsBuffer,
        plan.stringLengths,
        plan.expressionIndexes,
        plan.readingIndexes,
        chunk.readingEqualsExpressionList,
        chunk.scoreList,
        chunk.sequenceList,
        meta]) { hashView(hash, view) }
    let end = 0
    for (let row = 0; row < chunk.rowCount; ++row) { end = Math.max(end, meta[row * 4] + meta[row * 4 + 1]) }
    const base = chunk.contentBytesBaseOffset ?? 0
    if (base + end > content.byteLength) { throw new Error('Out-of-bounds canonical content') }
    hashView(hash, content.subarray(base, base + end))
    if (chunk.contentUniqueIndexList) { hashView(hash, chunk.contentUniqueIndexList) }
    let lookupBytes = 0
    for (const [key, prepared] of chunk.preparedLookupIndexes) {
        hash.update(key)
        hashView(hash, prepared.bytes)
        lookupBytes += prepared.bytes.byteLength
    }
    for (const media of chunk.mediaRows) {
        hash.update(`${media.index}:${media.row.expression}:${media.row.reading}:`)
        hashView(hash, media.row.glossaryJsonBytes ?? new Uint8Array())
    }
    return {encodedBytes: end, lookupBytes}
}

/**
 * @param {string} sourceRoot
 * @param {string} dictionary
 * @param {string} flagsJson
 * @returns {Promise<Observation>}
 */
async function child(sourceRoot, dictionary, flagsJson) {
    const experiments = parseFlags(flagsJson)
    const fixtures = await loadDictionaryFixtures()
    const fixture = fixtures[dictionary]
    if (!fixture) { throw new Error(`Unknown dictionary: ${dictionary}`) }
    const archive = new Uint8Array(await readFile(path.join(root, 'builds/e2e-dictionary-cache', fixture.cacheFile)))
    if (sha256(archive) !== fixture.sha256) { throw new Error('Dictionary ZIP does not match the pinned lock') }
    const reader = new ZipReader(new Uint8ArrayReader(archive), {useWebWorkers: false})
    /** @type {Uint8Array[]} */
    const sources = []
    try {
        const entries = (await reader.getEntries()).filter((entry) => /^term_bank_\d+\.json$/u.test(entry.filename))
        entries.sort((a, b) => Number(a.filename.split('_')[2].split('.')[0]) - Number(b.filename.split('_')[2].split('.')[0]))
        for (const entry of entries) {
            if (entry.directory || typeof entry.getData !== 'function') { throw new Error('Invalid term bank') }
            sources.push(await entry.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true}))
        }
    } finally { await reader.close() }
    if (sources.length === 0) { throw new Error('No term banks') }
    // These are fixed repository filenames under the operator-selected local worktree.
    // eslint-disable-next-line no-unsanitized/method -- fixed local module, not remote input
    const parserModule = /** @type {unknown} */ (await import(pathToFileURL(path.join(sourceRoot, 'ext/js/dictionary/term-bank-wasm-parser.js')).href))
    const parser = /** @type {typeof import('../../ext/js/dictionary/term-bank-wasm-parser.js')} */ (parserModule)
    // eslint-disable-next-line no-unsanitized/method -- fixed local module, not remote input
    const lookupModule = /** @type {unknown} */ (await import(pathToFileURL(path.join(sourceRoot, 'ext/js/dictionary/term-lookup-index-preparation.js')).href))
    const lookup = /** @type {typeof import('../../ext/js/dictionary/term-lookup-index-preparation.js')} */ (lookupModule)
    parser.setTermBankWasmModule(await WebAssembly.compile(await readFile(path.join(sourceRoot, 'ext/lib/term-bank-parser.wasm'))))
    /** @returns {Promise<Measurement>} */
    async function run() {
        let wallMs = 0
        let rows = 0
        let encodedBytes = 0
        let lookupBytes = 0
        let maxWasmHeapBytes = 0
        let maxSampledRssBytes = 0
        /** @type {Record<string, number>} */
        const counters = {}
        const hash = createHash('sha256')
        // Fixed four-bank component regime, NOT adaptive browser scheduling.
        for (let first = 0; first < sources.length; first += 4) {
            /** @type {Chunk[]} */
            const chunks = []
            const started = safePerformance.now()
            await parser.parseTermBankWithWasmColumnChunks(sources.slice(first, first + 4), 3, (/** @type {Chunk} */ chunk) => {
                if (!chunk.preparedLookupIndexes) {
                    const prepared = lookup.prepareTermLookupIndexesFromPreinternedPlan(chunk)
                    if (!prepared) { throw new Error('Lookup preparation failed') }
                    chunk.preparedLookupIndexes = prepared.indexes
                }
                chunks.push(chunk)
            }, 2048, {computeContentHashes: true,
                emitContentSlab: true,
                emitTokenBinaryContent: true,
                mediaHintFastScan: true,
                emitTermByteLists: false,
                singleChunk: true,
                prepareLookupIndexes: true,
                ...experiments})
            wallMs += safePerformance.now() - started
            // Integrity hashing, memory observations and diagnostics are untimed.
            // The resulting total is a sum of group timings, not whole-import time.
            maxSampledRssBytes = Math.max(maxSampledRssBytes, process.memoryUsage().rss)
            const profile = parser.consumeLastTermBankWasmParseProfile()
            if (!profile) { throw new Error('No parser profile') }
            maxWasmHeapBytes = Math.max(maxWasmHeapBytes, profile.maxWasmHeapBytes ?? 0)
            for (const [key, value] of Object.entries(profile)) {
                if (typeof value === 'number' && (key.endsWith('Count') || key.startsWith('fusedParse') || key === 'bankSpanCount')) {
                    counters[key] = (counters[key] ?? 0) + value
                }
            }
            if (chunks.length !== 1) { throw new Error('Unexpected component chunk boundary') }
            for (const chunk of chunks) {
                rows += chunk.rowCount
                const bytes = verifyChunk(hash, chunk)
                encodedBytes += bytes.encodedBytes
                lookupBytes += bytes.lookupBytes
            }
        }
        if (rows !== fixture.termRows) { throw new Error(`Wrong row count: ${rows}/${fixture.termRows}`) }
        return {wallMs, rows, encodedBytes, lookupBytes, digest: hash.digest('hex'), maxWasmHeapBytes, maxSampledRssBytes, counters}
    }
    const warmup = await run()
    const measured = await run()
    if (warmup.digest !== measured.digest) { throw new Error('Warmup and measured output differ') }
    return {warmup,
        measured,
        source: await fingerprint(sourceRoot),
        fixture: {sha256: fixture.sha256, rows: fixture.termRows, banks: sources.length},
        node: process.version,
        v8: process.versions.v8,
        cpu: os.cpus()[0]?.model ?? 'unknown'}
}

/**
 * @param {number[]} values
 * @returns {number}
 */
function median(values) {
    const sorted = [...values].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

if (args[0] === '--child') {
    console.log(JSON.stringify(await child(args[1], args[2], args[3])))
} else {
    const [dictionary, pairText, output, flagText = '{}', baselinePath = root] = args
    const pairs = Number(pairText)
    if (!dictionary || !output || !Number.isSafeInteger(pairs) || pairs < 1 || pairs > 100) {
        throw new Error('Usage: node dev/perf/parser-opportunities.js DICTIONARY PAIRS OUTPUT_JSON [FLAGS_JSON] [BASELINE_ROOT]')
    }
    parseFlags(flagText)
    const baseline = path.resolve(baselinePath)
    const expected = {A: await fingerprint(baseline), B: await fingerprint(root)}
    /** @type {Pair[]} */
    const observations = []
    const report = {boundary: 'Sum of resident four-bank parse+lookup-preparation timings; excludes ZIP read/inflate, verification, IPC, compression, storage and UI',
        memoryBoundary: 'Post-group RSS samples include prepared corpus, warmup and verification allocations; not whole-import peak memory',
        runnerSha256: sha256(await readFile(here)),
        dictionary,
        pairs,
        flags: parseFlags(flagText),
        expected,
        observations,
        summary: /** @type {{medianPercent: number, equalWorkPercent: number, fasterPairs: number, ratios: number[]}|null} */ (null)}
    await mkdir(path.dirname(path.resolve(output)), {recursive: true})
    for (let i = 0; i < pairs; ++i) {
        const pair = /** @type {Pair} */ ({order: i % 2 ? ['B', 'A'] : ['A', 'B']})
        observations.push(pair)
        try {
            for (const arm of pair.order) {
                const result = spawnSync(
                    process.execPath,
                    [here, '--child', arm === 'A' ? baseline : root, dictionary, arm === 'A' ? '{}' : flagText],
                    {encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024},
                )
                if (result.error || result.status !== 0) { throw new Error(result.error?.message ?? result.stderr) }
                const observation = /** @type {Observation} */ (parseJson(result.stdout))
                if (JSON.stringify(observation.source) !== JSON.stringify(arm === 'A' ? expected.A : expected.B)) {
                    throw new Error('Source changed during the benchmark')
                }
                if (arm === 'A') {
                    pair.A = observation
                } else {
                    pair.B = observation
                }
            }
            if (pair.A?.measured.digest !== pair.B?.measured.digest) { throw new Error('Full canonical/column/lookup digest differs') }
        } catch (error) {
            pair.error = String(error)
            await writeFile(output, JSON.stringify(report, null, 2) + '\n')
            throw error
        }
        await writeFile(output, JSON.stringify(report, null, 2) + '\n')
    }
    const ratios = observations.map((pair) => 100 * (/** @type {Observation} */ (pair.B).measured.wallMs / /** @type {Observation} */ (pair.A).measured.wallMs - 1))
    const a = observations.reduce((total, pair) => total + /** @type {Observation} */ (pair.A).measured.wallMs, 0)
    const b = observations.reduce((total, pair) => total + /** @type {Observation} */ (pair.B).measured.wallMs, 0)
    report.summary = {medianPercent: median(ratios), equalWorkPercent: 100 * (b / a - 1), fasterPairs: ratios.filter((ratio) => ratio < 0).length, ratios}
    await writeFile(output, JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report.summary))
}
