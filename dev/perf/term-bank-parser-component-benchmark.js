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
import {createHash} from 'node:crypto'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {isDeepStrictEqual, parseArgs} from 'node:util'
import JSZip from 'jszip'
import {parseJson} from '../../ext/js/core/json.js'
import {loadDictionaryWasm} from '../dictionary-wasm.js'
import {getSourceProvenance, parsePositiveInteger} from './benchmark-support.js'
import {loadDictionaryFixtures} from './dictionary-fixtures.js'
import {getHostEnvironment} from './host-environment.js'

const scriptPath = fileURLToPath(import.meta.url)
const root = path.resolve(path.dirname(scriptPath), '../..')
// Fixed component groups match the earlier parser experiment lane. They are
// not a simulation of every browser's memory policy or worker scheduling.
const groupBanks = {jmdict: 7, jmnedict: 9, jitendex: 10}
const parserOptions = Object.freeze({
    computeContentHashes: true,
    emitContentSlab: true,
    emitTokenBinaryContent: true,
    emitTermByteLists: false,
    prepareLookupIndexes: true,
    validateGlossaryTypes: true,
    mediaHintFastScan: true,
    singleChunk: true,
    maxPendingChunks: 1,
})

/** @typedef {typeof import('../../ext/js/dictionary/term-bank-wasm-parser.js')} Parser */
/** @typedef {Parameters<Parameters<Parser['parseTermBankWithWasmColumnChunks']>[2]>[0]} Chunk */
/** @typedef {{parser: Parser, prepareLookup: typeof import('../../ext/js/dictionary/term-lookup-index-preparation.js').prepareTermLookupIndexesFromPreinternedPlan, provenance: Awaited<ReturnType<typeof getRuntimeProvenance>>}} Runtime */
/** @typedef {{filename: string, bytes: Uint8Array}} Bank */
/** @typedef {{userMs: number, systemMs: number, totalMs: number}} CpuSample */
/** @typedef {{totalMs: number, groupMs: number[], userCpuMs: number, systemCpuMs: number, totalCpuMs: number, groupCpu: CpuSample[], rows: number, fusedAttempts: number, fusedFallbacks: number, nativeLookupSegments: number, maxWasmHeapBytes: number}} Measurement */

/**
 * @param {Uint8Array|string} bytes
 * @returns {string}
 */
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }

/**
 * @param {string} url
 * @returns {Promise<unknown>}
 */
async function importLocalModule(url) {
    // eslint-disable-next-line no-unsanitized/method -- Only explicitly selected local source checkouts are imported.
    return await import(url)
}

/**
 * @param {string} sourceRoot
 * @returns {Promise<{source: Awaited<ReturnType<typeof getSourceProvenance>>, hashes: Record<string, string>}>}
 */
async function getRuntimeProvenance(sourceRoot) {
    loadDictionaryWasm(sourceRoot)
    /** @type {Record<string, string>} */
    const hashes = {}
    for (const file of [
        'ext/js/dictionary/term-bank-wasm-parser.js',
        'ext/js/dictionary/term-bank-experiments.js',
        'ext/js/dictionary/term-record-preinterned-plan.js',
        'ext/js/dictionary/term-lookup-index.js',
        'ext/js/dictionary/term-lookup-index-preparation.js',
        'ext/js/dictionary/term-lookup-scratch.js',
        'dev/data/dictionary-wasm/manifest.json',
        'dev/data/dictionary-wasm/term-bank-parser.wasm',
        'package-lock.json',
        'test/perf/dictionaries.lock.json',
    ]) {
        hashes[file] = sha256(await readFile(path.join(sourceRoot, file)))
    }
    return {source: await getSourceProvenance(sourceRoot), hashes}
}

/**
 * @param {string} sourceRoot
 * @param {string} arm
 * @returns {Promise<Runtime>}
 */
export async function loadParserRuntime(sourceRoot, arm) {
    const provenance = await getRuntimeProvenance(sourceRoot)
    // Separate module instances also make --candidate-root=<baseline-root>
    // a real same-code control, with independent parser memories.
    const parserUrl = pathToFileURL(path.join(sourceRoot, 'ext/js/dictionary/term-bank-wasm-parser.js'))
    parserUrl.searchParams.set('componentBenchmarkArm', arm)
    const parser = /** @type {Parser} */ (await importLocalModule(parserUrl.href))
    const lookup = /** @type {typeof import('../../ext/js/dictionary/term-lookup-index-preparation.js')} */ (
        await importLocalModule(pathToFileURL(path.join(sourceRoot, 'ext/js/dictionary/term-lookup-index-preparation.js')).href)
    )
    const module = await WebAssembly.compile(await readFile(path.join(sourceRoot, 'dev/data/dictionary-wasm/term-bank-parser.wasm')))
    parser.setTermBankWasmModule(module)
    await parser.initializeTermBankWasmParser()
    return {parser, prepareLookup: lookup.prepareTermLookupIndexesFromPreinternedPlan, provenance}
}

/**
 * Loads only immutable, hash-checked archives. Inflation and any smoke row
 * counting are outside all timing intervals.
 * @param {string} dictionary
 * @param {string} cacheDir
 * @param {boolean} [smoke]
 * @returns {Promise<{fixture: import('./dictionary-fixtures.js').DictionaryFixture, banks: Bank[], expectedRows: number, archiveSha256: string}>}
 * @throws {Error} If the selected archive or index differs from the lock.
 */
export async function loadPinnedBanks(dictionary, cacheDir, smoke = false) {
    const fixture = (await loadDictionaryFixtures())[dictionary]
    if (typeof fixture === 'undefined') { throw new Error(`Unknown dictionary: ${dictionary}`) }
    const bytes = await readFile(path.join(cacheDir, fixture.cacheFile))
    const archiveSha256 = sha256(bytes)
    if (bytes.byteLength !== fixture.sizeBytes || archiveSha256 !== fixture.sha256) {
        throw new Error(`Pinned archive size or SHA-256 mismatch: ${fixture.cacheFile}`)
    }
    const zip = await JSZip.loadAsync(bytes)
    const indexFile = zip.file('index.json')
    if (indexFile === null) { throw new Error('Dictionary index.json is missing') }
    const index = /** @type {{title?: unknown, revision?: unknown, format?: unknown}} */ (parseJson(await indexFile.async('string')))
    assert.equal(index.title, fixture.expectedTitle)
    assert.equal(index.revision, fixture.revision)
    assert.equal(index.format, 3)
    const files = Object.values(zip.files)
        .filter((file) => !file.dir && /^term_bank_[1-9]\d*\.json$/.test(file.name))
        .sort((a, b) => Number(a.name.slice(10, -5)) - Number(b.name.slice(10, -5)))
    if (files.length === 0) { throw new Error('Dictionary has no term banks') }
    /** @type {Bank[]} */
    const banks = []
    for (const file of smoke ? files.slice(0, 2) : files) {
        banks.push({filename: file.name, bytes: await file.async('uint8array')})
    }
    let expectedRows = fixture.termRows
    if (smoke) {
        expectedRows = 0
        for (const bank of banks) {
            const rows = parseJson(new TextDecoder().decode(bank.bytes))
            if (!Array.isArray(rows)) { throw new Error('Term bank is not an array') }
            expectedRows += rows.length
        }
    }
    return {fixture, banks, expectedRows, archiveSha256}
}

/**
 * The result borrows parser memory until the next call on this runtime.
 * Native lookup misses finish through the same fallback used by the worker.
 * @param {Runtime} runtime
 * @param {Uint8Array[]} banks
 * @returns {Promise<{chunk: Chunk, profile: NonNullable<ReturnType<Parser['consumeLastTermBankWasmParseProfile']>>}>}
 * @throws {Error} If the parser does not produce one complete nonempty group.
 */
export async function parseComponentGroup(runtime, banks) {
    /** @type {Chunk|null} */
    let output = null
    await runtime.parser.parseTermBankWithWasmColumnChunks(banks, 3, (chunk) => {
        if (output !== null) { throw new Error('Expected one parser chunk per source group') }
        output = chunk
    }, 12000, parserOptions)
    const chunk = /** @type {Chunk|null} */ (output)
    const profile = runtime.parser.consumeLastTermBankWasmParseProfile()
    if (chunk === null || profile === null || profile.rowCount !== chunk.rowCount) {
        throw new Error('Parser group output is incomplete')
    }
    if (!(chunk.preparedLookupIndexes instanceof Map)) {
        const prepared = runtime.prepareLookup(chunk, null, profile.experiments)
        if (prepared === null) { throw new Error('Parser group lookup construction failed') }
        chunk.preparedLookupIndexes = prepared.indexes
    }
    return {chunk, profile}
}

/**
 * Excludes addresses and timings while retaining every row column, canonical
 * content byte, interner field and persisted lookup segment.
 * @param {Chunk} chunk
 * @returns {object}
 * @throws {Error} If the complete content slab is unavailable.
 */
function comparableOutput(chunk) {
    const {contentBytesBuffer, contentBytesLength, contentBytesBaseOffset = 0} = chunk
    if (typeof contentBytesBuffer === 'undefined' || typeof contentBytesLength !== 'number') {
        throw new Error('Expected the complete content slab for exact comparison')
    }
    return {
        rowCount: chunk.rowCount,
        contentRowStart: chunk.contentRowStart,
        expressionBytesList: chunk.expressionBytesList,
        readingBytesList: chunk.readingBytesList,
        readingEqualsExpressionList: chunk.readingEqualsExpressionList,
        scoreList: chunk.scoreList,
        sequenceList: chunk.sequenceList,
        contentBytesList: chunk.contentBytesList,
        contentMetaList: chunk.contentMetaList,
        contentHash1List: chunk.contentHash1List,
        contentHash2List: chunk.contentHash2List,
        contentUniqueIndexList: chunk.contentUniqueIndexList,
        contentDedupPlan: /** @type {unknown} */ (chunk.contentDedupPlan),
        useResolvedContentReferences: chunk.useResolvedContentReferences,
        content: contentBytesBuffer.subarray(contentBytesBaseOffset, contentBytesBaseOffset + contentBytesLength),
        termRecordPreinternedPlan: chunk.termRecordPreinternedPlan,
        lookups: Array.from(chunk.preparedLookupIndexes ?? [], ([range, lookup]) => ({range, bytes: lookup.bytes, plan: lookup.preinternedPlan})),
        mediaRows: chunk.mediaRows,
    }
}

/**
 * Typed arrays are hashed as bytes, never expanded to numeric JSON objects.
 * @param {import('node:crypto').Hash} hash
 * @param {unknown} value
 */
function updateOutputHash(hash, value) {
    if (ArrayBuffer.isView(value)) {
        hash.update(`${value.constructor.name}:${value.byteLength}:`)
        hash.update(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
    } else if (Array.isArray(value)) {
        hash.update(`array:${value.length}:`)
        for (const item of value) { updateOutputHash(hash, item) }
    } else if (typeof value === 'object' && value !== null) {
        const record = /** @type {Record<string, unknown>} */ (value)
        for (const key of Object.keys(record).sort()) {
            hash.update(`${key}:`)
            updateOutputHash(hash, record[key])
        }
    } else {
        hash.update(JSON.stringify(value) ?? 'undefined')
    }
    hash.update('\0')
}

/**
 * @param {Runtime[]} runtimes
 * @param {Bank[][]} groups
 * @param {number} expectedRows
 * @returns {Promise<{rows: number, groups: number, outputSha256: string}>}
 * @throws {Error} If any output field differs.
 */
async function verifyParity(runtimes, groups, expectedRows) {
    const hash = createHash('sha256')
    let rows = 0
    for (const [index, group] of groups.entries()) {
        const sources = group.map((bank) => bank.bytes)
        const left = await parseComponentGroup(runtimes[0], sources)
        const right = await parseComponentGroup(runtimes[1], sources)
        const baseline = comparableOutput(left.chunk)
        if (!isDeepStrictEqual(baseline, comparableOutput(right.chunk))) {
            throw new Error(`Exact parser output differs in group ${index + 1} (${group[0].filename})`)
        }
        updateOutputHash(hash, baseline)
        rows += left.chunk.rowCount
    }
    assert.equal(rows, expectedRows, 'Parsed row count differs from the pinned fixture')
    return {rows, groups: groups.length, outputSha256: hash.digest('hex')}
}

/**
 * @param {Runtime} runtime
 * @param {Bank[][]} groups
 * @param {number} expectedRows
 * @returns {Promise<Measurement>}
 */
async function measure(runtime, groups, expectedRows) {
    const groupMs = []
    /** @type {CpuSample[]} */
    const groupCpu = []
    let userCpuMs = 0
    let systemCpuMs = 0
    let rows = 0
    let fusedAttempts = 0
    let fusedFallbacks = 0
    let nativeLookupSegments = 0
    let maxWasmHeapBytes = 0
    for (const group of groups) {
        const sources = group.map((bank) => bank.bytes)
        const cpuBefore = process.cpuUsage()
        const started = process.hrtime.bigint()
        const result = await parseComponentGroup(runtime, sources)
        const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
        const cpu = process.cpuUsage(cpuBefore)
        groupMs.push(elapsedMs)
        groupCpu.push({userMs: cpu.user / 1000, systemMs: cpu.system / 1000, totalMs: (cpu.user + cpu.system) / 1000})
        userCpuMs += cpu.user / 1000
        systemCpuMs += cpu.system / 1000
        rows += result.chunk.rowCount
        fusedAttempts += result.profile.fusedParseAttempts ?? 0
        fusedFallbacks += result.profile.fusedParseFallbacks ?? 0
        nativeLookupSegments += result.profile.nativeSegmentedLookupSegments ?? 0
        maxWasmHeapBytes = Math.max(maxWasmHeapBytes, result.profile.maxWasmHeapBytes ?? 0)
    }
    assert.equal(rows, expectedRows)
    return {totalMs: groupMs.reduce((sum, value) => sum + value, 0), groupMs, userCpuMs, systemCpuMs, totalCpuMs: userCpuMs + systemCpuMs, groupCpu, rows, fusedAttempts, fusedFallbacks, nativeLookupSegments, maxWasmHeapBytes}
}

/**
 * @param {number[]} values
 * @returns {number}
 */
function median(values) {
    const sorted = [...values].sort((a, b) => a - b)
    const midpoint = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 1 ? sorted[midpoint] : (sorted[midpoint - 1] + sorted[midpoint]) / 2
}

/**
 * @param {string[]} [args]
 * @returns {Promise<void>}
 * @throws {Error} If configuration, provenance, or any measured observation is invalid.
 */
export async function main(args = process.argv.slice(2)) {
    const {values} = parseArgs({
        args,
        options: {
            'baseline-root': {type: 'string'},
            'candidate-root': {type: 'string', default: root},
            'cache-dir': {type: 'string'},
            'dictionary': {type: 'string', multiple: true},
            'pairs': {type: 'string', default: '12'},
            'warmups': {type: 'string', default: '1'},
            'initial-order': {type: 'string', default: 'AB'},
            'output': {type: 'string'},
            'smoke': {type: 'boolean', default: false},
        },
    })
    if (!values['baseline-root']) { throw new Error('--baseline-root is required') }
    if (process.versions.node.split('.')[0] !== '22') { throw new Error('Run component qualification with Node.js 22') }
    const pairs = parsePositiveInteger(values.pairs, '--pairs')
    const warmups = parsePositiveInteger(values.warmups, '--warmups')
    const initialOrder = values['initial-order']
    if (initialOrder !== 'AB' && initialOrder !== 'BA') { throw new Error('--initial-order must be AB or BA') }
    const dictionaries = values.dictionary ?? Object.keys(groupBanks)
    if (dictionaries.length === 0 || new Set(dictionaries).size !== dictionaries.length || dictionaries.some((id) => !Object.hasOwn(groupBanks, id))) {
        throw new Error('Select each dictionary at most once: jmdict, jmnedict, jitendex')
    }
    const roots = [path.resolve(values['baseline-root']), path.resolve(values['candidate-root'])]
    const cacheDir = path.resolve(values['cache-dir'] ?? path.join(roots[0], 'builds/e2e-dictionary-cache'))
    const output = path.resolve(values.output ?? path.join(root, 'builds/perf', `parser-component-${Date.now()}.json`))
    await mkdir(path.dirname(output), {recursive: true})
    const harnessSha256 = sha256(await readFile(scriptPath))
    const runtimes = [await loadParserRuntime(roots[0], 'baseline'), await loadParserRuntime(roots[1], 'candidate')]
    assert.equal(runtimes[0].provenance.hashes['test/perf/dictionaries.lock.json'], runtimes[1].provenance.hashes['test/perf/dictionaries.lock.json'])
    assert.equal(runtimes[0].provenance.hashes['package-lock.json'], runtimes[1].provenance.hashes['package-lock.json'])
    const report = {
        schemaVersion: 1,
        status: 'running',
        startedAt: new Date().toISOString(),
        wholeImportTiming: false,
        smoke: values.smoke,
        boundary: 'Resident source banks through column parsing, content encoding/deduplication, key interning and complete lookup construction; summed sequential group intervals.',
        excluded: ['archive reading/inflation', 'WASM compilation/initialization', 'worker metadata copy/IPC', 'global content deduplication', 'compression', 'OPFS/SQLite', 'UI', 'parity checks'],
        state: 'Two independent persistent parser instances; exact parity traversals bracket each cohort and excluded warmups precede paired measurements. No worker concurrency.',
        cpuBoundary: 'process.cpuUsage user/system deltas around each timed group, summed per fixture; includes any process background work during those intervals.',
        configuration: {pairs, warmups, initialOrder, parserOptions, groupBanks},
        harnessSha256,
        sources: runtimes.map((runtime, i) => ({root: roots[i], ...runtime.provenance})),
        hostBefore: getHostEnvironment(),
        /** @type {object[]} */
        dictionaries: [],
        /** @type {Record<string, unknown>|null} */
        hostAfter: null,
        /** @type {string|null} */
        failure: null,
    }
    try {
        for (const dictionary of dictionaries) {
            const loaded = await loadPinnedBanks(dictionary, cacheDir, values.smoke)
            const size = groupBanks[/** @type {keyof typeof groupBanks} */ (dictionary)]
            /** @type {Bank[][]} */
            const groups = []
            for (let i = 0; i < loaded.banks.length; i += size) { groups.push(loaded.banks.slice(i, i + size)) }
            const parityBefore = await verifyParity(runtimes, groups, loaded.expectedRows)
            /** @type {Array<{index: number, order: string, baseline: Measurement, candidate: Measurement, percentChange: number, percentCpuChange: number}>} */
            const observations = []
            /** @type {Array<{baseline: Awaited<ReturnType<typeof measure>>, candidate: Awaited<ReturnType<typeof measure>>}>} */
            const excludedWarmups = []
            for (let pair = -warmups; pair < pairs; ++pair) {
                const orderIndex = pair < 0 ? pair + warmups : pair
                const order = (orderIndex % 2 === 0) === (initialOrder === 'AB') ? [0, 1] : [1, 0]
                /** @type {Map<number, Awaited<ReturnType<typeof measure>>>} */
                const results = new Map()
                for (const arm of order) { results.set(arm, await measure(runtimes[arm], groups, loaded.expectedRows)) }
                const baseline = /** @type {Awaited<ReturnType<typeof measure>>} */ (results.get(0))
                const candidate = /** @type {Awaited<ReturnType<typeof measure>>} */ (results.get(1))
                if (pair < 0) {
                    excludedWarmups.push({baseline, candidate})
                } else {
                    observations.push({index: pair + 1, order: order[0] === 0 ? 'AB' : 'BA', baseline, candidate, percentChange: (candidate.totalMs / baseline.totalMs - 1) * 100, percentCpuChange: (candidate.totalCpuMs / baseline.totalCpuMs - 1) * 100})
                }
            }
            const parityAfter = await verifyParity(runtimes, groups, loaded.expectedRows)
            assert.deepEqual(parityAfter, parityBefore, 'Parser output changed during the timing cohort')
            report.dictionaries.push({
                id: dictionary,
                fixture: loaded.fixture,
                archiveSha256: loaded.archiveSha256,
                groups: groups.map((group) => ({files: group.map((bank) => bank.filename), bytes: group.reduce((sum, bank) => sum + bank.bytes.byteLength, 0)})),
                parityBefore,
                parityAfter,
                excludedWarmups,
                observations,
                summary: {
                    baselineMedianMs: median(observations.map((item) => item.baseline.totalMs)),
                    candidateMedianMs: median(observations.map((item) => item.candidate.totalMs)),
                    medianPairedPercentChange: median(observations.map((item) => item.percentChange)),
                    candidateFasterPairs: observations.filter((item) => item.percentChange < 0).length,
                    baselineMedianCpuMs: median(observations.map((item) => item.baseline.totalCpuMs)),
                    candidateMedianCpuMs: median(observations.map((item) => item.candidate.totalCpuMs)),
                    medianPairedPercentCpuChange: median(observations.map((item) => item.percentCpuChange)),
                    candidateLowerCpuPairs: observations.filter((item) => item.percentCpuChange < 0).length,
                },
            })
            await writeFile(output, JSON.stringify(report, null, 2) + '\n')
            process.stdout.write(`${dictionary}: exact parity for ${loaded.expectedRows} rows; ${pairs} pairs recorded\n`)
        }
        for (let arm = 0; arm < roots.length; ++arm) {
            const current = await getRuntimeProvenance(roots[arm])
            assert.deepEqual(current.hashes, runtimes[arm].provenance.hashes, 'Runtime sources changed during the timing cohort')
            assert.equal(current.source.gitSha, runtimes[arm].provenance.source.gitSha, 'Source HEAD changed during the timing cohort')
        }
        assert.equal(sha256(await readFile(scriptPath)), harnessSha256, 'Measurement harness changed during the timing cohort')
        report.status = 'passed'
    } catch (error) {
        report.status = 'failed'
        report.failure = String(error)
        throw error
    } finally {
        report.hostAfter = getHostEnvironment()
        await writeFile(output, JSON.stringify(report, null, 2) + '\n')
    }
    process.stdout.write(`${output}\n`)
}

if (process.argv[1] === scriptPath) { await main() }
