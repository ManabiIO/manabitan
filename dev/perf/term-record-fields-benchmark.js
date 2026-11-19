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

import {createHash} from 'node:crypto'
import {lstat, mkdir, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import JSZip from 'jszip'
import {parseJson} from '../../ext/js/core/json.js'
import {getSourceProvenance, median, parsePositiveInteger} from './benchmark-support.js'
import {ensureFixtureFile, loadDictionaryFixtures} from './dictionary-fixtures.js'
import {getHostEnvironment} from './host-environment.js'

/** @typedef {import('../../ext/js/dictionary/term-record-opfs-store.js').TermRecordOpfsStore} Store */
/** @typedef {Parameters<Store['_encodeArtifactRecordFields']>[0]} RecordChunk */
/** @typedef {{chunk: RecordChunk, base: number}} Input */
/** @typedef {typeof import('../../ext/js/dictionary/term-bank-wasm-parser.js')} Parser */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const recordPath = 'ext/js/dictionary/term-record-opfs-store.js'
const parserPath = 'ext/js/dictionary/term-bank-wasm-parser.js'
const experimentsPath = 'ext/js/dictionary/term-bank-experiments.js'
const wasmPath = 'dev/data/dictionary-wasm/term-bank-parser.wasm'
const emptyOffsets = new Float64Array(0)
const emptyLengths = new Uint32Array(0)

/**
 * @returns {{baseline: string, candidate: string, cache: string, dictionary: string, pairs: number, iterations: number, warmup: number, initialOrder: string, output: string, smoke: boolean, gcBeforeArm: boolean}}
 * @throws {Error} If an argument is missing or unsupported.
 */
function parseArgs() {
    const options = {baseline: '', candidate: root, cache: path.join(root, 'builds/e2e-dictionary-cache'), dictionary: 'jmdict', pairs: 8, iterations: 5, warmup: 2, initialOrder: 'AB', output: path.join(root, 'builds/perf/term-record-fields.json'), smoke: false, gcBeforeArm: false}
    const args = process.argv.slice(2)
    for (let i = 0; i < args.length; ++i) {
        const arg = args[i]
        if (arg === '--smoke') {
            options.smoke = true
            continue
        }
        if (arg === '--gc-before-arm') {
            options.gcBeforeArm = true
            continue
        }
        const value = args[++i]
        if (typeof value !== 'string' || value.startsWith('--')) { throw new Error(`Missing value for ${arg}`) }
        switch (arg) {
            case '--baseline': options.baseline = path.resolve(value); break
            case '--candidate': options.candidate = path.resolve(value); break
            case '--cache': options.cache = path.resolve(value); break
            case '--dictionary': options.dictionary = value; break
            case '--pairs': options.pairs = parsePositiveInteger(value, arg); break
            case '--iterations': options.iterations = parsePositiveInteger(value, arg); break
            case '--warmup': options.warmup = parsePositiveInteger(value, arg); break
            case '--initial-order': options.initialOrder = value; break
            case '--output': options.output = path.resolve(value); break
            default: throw new Error(`Unknown argument: ${arg}`)
        }
    }
    if (!options.baseline) { throw new Error('--baseline must name a source checkout') }
    if (options.initialOrder !== 'AB' && options.initialOrder !== 'BA') { throw new Error('--initial-order must be AB or BA') }
    if (options.gcBeforeArm && typeof globalThis.gc !== 'function') { throw new Error('--gc-before-arm requires node --expose-gc') }
    return options
}

/**
 * @param {Uint8Array} bytes
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
 * @param {string} checkout
 * @returns {Promise<{gitSha: string|null, dirty: boolean|null, sha256: Record<string, string|null>, checkout: string, recordSourceSha256: string}>}
 */
async function sourceIdentity(checkout) {
    return {...await getSourceProvenance(checkout), checkout, recordSourceSha256: sha256(await readFile(path.join(checkout, recordPath)))}
}

/**
 * Own only the record encoder's inputs before the parser reuses its WASM heap.
 * Offsets model compact block-reference slots, not actual OPFS allocation.
 * @param {Parameters<Parameters<Parser['parseTermBankWithWasmColumnChunks']>[2]>[0]} parsed
 * @param {number} base
 * @param {number} maxRows
 * @returns {{inputs: Input[], nextBase: number}}
 * @throws {Error} If the parser did not produce consistent content references.
 */
function collectInputs(parsed, base, maxRows) {
    const identities = parsed.contentUniqueIndexList
    const metas = parsed.contentMetaList
    if (!(identities instanceof Uint32Array) || !(metas instanceof Uint32Array)) { throw new Error('Parser did not emit unique content references') }
    let uniqueCount = 0
    for (const index of identities) { uniqueCount = Math.max(uniqueCount, index + 1) }
    if (uniqueCount > parsed.rowCount) { throw new Error('Parser unique indexes exceed row count') }
    const offsets = Float64Array.from({length: uniqueCount}, (_, index) => base + index * 20)
    const lengths = new Uint32Array(uniqueCount)
    const seen = new Uint8Array(uniqueCount)
    for (let row = 0; row < parsed.rowCount; ++row) {
        const index = identities[row]
        const length = metas[row * 4 + 1]
        if (seen[index] && lengths[index] !== length) { throw new Error('Duplicate content reference has inconsistent length') }
        seen[index] = 1
        lengths[index] = length
    }
    if (seen.includes(0)) { throw new Error('Parser unique indexes are not contiguous') }
    const limit = parsed.preparedLookupIndexes?.has(`0:${parsed.rowCount}`) === true ? parsed.rowCount : maxRows
    /** @type {Input[]} */
    const inputs = []
    for (let start = 0; start < parsed.rowCount; start += limit) {
        const end = Math.min(parsed.rowCount, start + limit)
        const uniqueIndexList = identities.slice(start, end)
        let offsetBase = Infinity
        for (const index of uniqueIndexList) { offsetBase = Math.min(offsetBase, offsets[index]) }
        inputs.push({base: offsetBase, chunk: {rowCount: end - start, scoreList: parsed.scoreList.slice(start, end), resolvedContentReferences: {uniqueIndexList, offsets, lengths}}})
    }
    return {inputs, nextBase: base + uniqueCount * 20}
}

/**
 * @param {Parser} parser
 * @param {import('./dictionary-fixtures.js').DictionaryFixture} fixture
 * @param {string} cache
 * @param {boolean} smoke
 * @param {number} maxRows
 * @returns {Promise<{inputs: Input[], rows: number, bankCount: number, groupCount: number}>}
 * @throws {Error} If fixture identity or parsed row coverage is invalid.
 */
async function prepareInputs(parser, fixture, cache, smoke, maxRows) {
    const archivePath = path.join(cache, fixture.cacheFile)
    await ensureFixtureFile(fixture, archivePath)
    const archive = await readFile(archivePath)
    if (archive.byteLength !== fixture.sizeBytes || sha256(archive) !== fixture.sha256) { throw new Error('Fixture changed after verification') }
    const zip = await JSZip.loadAsync(archive, {checkCRC32: true})
    const indexFile = zip.file('index.json')
    if (indexFile === null) { throw new Error('Missing index.json') }
    const index = /** @type {{title?: unknown, revision?: unknown, format?: unknown}} */ (parseJson(await indexFile.async('string')))
    if (index.title !== fixture.expectedTitle || index.revision !== fixture.revision || index.format !== 3) { throw new Error('Fixture identity mismatch') }
    let names = Object.keys(zip.files).filter((name) => /^term_bank_\d+\.json$/.test(name)).sort((a, b) => Number(a.slice(10, -5)) - Number(b.slice(10, -5)))
    if (names.length === 0) { throw new Error('Fixture has no term banks') }
    if (smoke) { names = names.slice(0, 2) }
    /** @type {Input[]} */
    const inputs = []
    let base = 0
    // Deterministic two-bank groups exercise the production fused parser. This
    // input preparation intentionally does not model browser worker scheduling.
    for (let start = 0; start < names.length; start += 2) {
        const banks = await Promise.all(names.slice(start, start + 2).map(async (name) => {
            const file = zip.file(name)
            if (file === null) { throw new Error(`Missing bank: ${name}`) }
            return await file.async('uint8array')
        }))
        await parser.parseTermBankWithWasmColumnChunks(banks, 3, (parsed) => {
            const prepared = collectInputs(parsed, base, maxRows)
            inputs.push(...prepared.inputs)
            base = prepared.nextBase
        }, 12000, parserOptions)
    }
    const rows = inputs.reduce((total, {chunk}) => total + chunk.rowCount, 0)
    if (!smoke && rows !== fixture.termRows) { throw new Error(`Expected ${fixture.termRows} rows; parsed ${rows}`) }
    return {inputs, rows, bankCount: names.length, groupCount: Math.ceil(names.length / 2)}
}

/**
 * @param {Store} store
 * @param {Input[]} inputs
 * @returns {Uint8Array[]}
 */
function encodeAll(store, inputs) {
    // eslint-disable-next-line no-underscore-dangle -- Measure the production encoder directly, preserving the qualified call path.
    return inputs.map(({chunk, base}) => store._encodeArtifactRecordFields(chunk, emptyOffsets, emptyLengths, base))
}

/**
 * @param {Uint8Array[]} output
 * @returns {string}
 */
function hashOutput(output) {
    const hash = createHash('sha256')
    const boundary = new Uint32Array(1)
    for (const bytes of output) {
        boundary[0] = bytes.byteLength
        hash.update(new Uint8Array(boundary.buffer)).update(bytes)
    }
    return hash.digest('hex')
}

/**
 * @param {Store} store
 * @param {Input[]} inputs
 * @param {number} iterations
 * @param {string} expectedHash
 * @param {boolean} [gcBeforeArm]
 * @returns {{elapsedMs: number, perPassMs: number, userCpuMs: number, systemCpuMs: number, perPassUserCpuMs: number, perPassSystemCpuMs: number, perPassCpuMs: number, minorPageFaults: number, majorPageFaults: number}}
 * @throws {Error} If a requested collector is unavailable or timed output differs from the equality-checked output.
 */
function measure(store, inputs, iterations, expectedHash, gcBeforeArm = false) {
    if (gcBeforeArm) {
        if (typeof globalThis.gc !== 'function') { throw new Error('--gc-before-arm requires node --expose-gc') }
        // Explicit collection isolates the method from preceding arms' garbage.
        // It is outside every measured counter and is not an import regime.
        globalThis.gc({type: 'major', execution: 'sync'})
    }
    const resourcesBefore = process.resourceUsage()
    const cpuBefore = process.cpuUsage()
    const started = process.hrtime.bigint()
    const output = Array.from({length: iterations}, () => encodeAll(store, inputs))
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
    const cpu = process.cpuUsage(cpuBefore)
    const resourcesAfter = process.resourceUsage()
    for (const iteration of output) {
        if (hashOutput(iteration) !== expectedHash) { throw new Error('Timed output differs from parity-checked output') }
    }
    return {
        elapsedMs,
        perPassMs: elapsedMs / iterations,
        userCpuMs: cpu.user / 1000,
        systemCpuMs: cpu.system / 1000,
        perPassUserCpuMs: cpu.user / (1000 * iterations),
        perPassSystemCpuMs: cpu.system / (1000 * iterations),
        perPassCpuMs: (cpu.user + cpu.system) / (1000 * iterations),
        minorPageFaults: resourcesAfter.minorPageFault - resourcesBefore.minorPageFault,
        majorPageFaults: resourcesAfter.majorPageFault - resourcesBefore.majorPageFault,
    }
}

const options = parseArgs()
// Refuse to replace an earlier report, including a dangling symlink. The final
// exclusive create also protects against a path appearing during measurement.
try {
    await lstat(options.output)
    throw new Error(`Output already exists: ${options.output}`)
} catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) { throw error }
}
const initialOrder = /** @type {Array<'baseline'|'candidate'>} */ (options.initialOrder === 'AB' ? ['baseline', 'candidate'] : ['candidate', 'baseline'])
const fixtures = await loadDictionaryFixtures()
const dictionaryIds = options.dictionary === 'all' ? ['jmdict', 'jmnedict', 'jitendex'] : [options.dictionary]
for (const id of dictionaryIds) {
    if (!Object.hasOwn(fixtures, id)) { throw new Error(`Unknown dictionary: ${id}`) }
}
await mkdir(options.cache, {recursive: true})
const identities = {baseline: await sourceIdentity(options.baseline), candidate: await sourceIdentity(options.candidate)}
const {snapshotTermBankExperiments} = /** @type {typeof import('../../ext/js/dictionary/term-bank-experiments.js')} */ (await importLocalModule(pathToFileURL(path.join(options.baseline, experimentsPath)).href))
const parserOptions = Object.freeze({
    ...snapshotTermBankExperiments(),
    initialContentBytesPerRow: 48,
    mediaHintFastScan: true,
    validateGlossaryTypes: true,
    computeContentHashes: true,
    emitContentSlab: true,
    emitTokenBinaryContent: true,
    emitTermByteLists: false,
    prepareLookupIndexes: true,
    maxPendingChunks: 1,
    singleChunk: true,
})
const parser = /** @type {Parser} */ (await importLocalModule(pathToFileURL(path.join(options.baseline, parserPath)).href))
const wasmBytes = await readFile(path.join(options.baseline, wasmPath))
parser.setTermBankWasmModule(await WebAssembly.compile(wasmBytes))
const {MAX_PREPARED_TERM_LOOKUP_INDEX_ROWS} = /** @type {typeof import('../../ext/js/dictionary/term-lookup-index-preparation.js')} */ (await importLocalModule(pathToFileURL(path.join(options.baseline, 'ext/js/dictionary/term-lookup-index-preparation.js')).href))
const stores = {
    baseline: new (/** @type {typeof import('../../ext/js/dictionary/term-record-opfs-store.js')} */ (await importLocalModule(pathToFileURL(path.join(options.baseline, recordPath)).href))).TermRecordOpfsStore(),
    candidate: new (/** @type {typeof import('../../ext/js/dictionary/term-record-opfs-store.js')} */ (await importLocalModule(pathToFileURL(path.join(options.candidate, recordPath)).href))).TermRecordOpfsStore(),
}
const report = {
    schemaVersion: 3,
    status: 'success',
    scope: 'Node record-field encoding component; no browser, OPFS, compression or whole-import timing',
    measurementRegime: options.gcBeforeArm ? 'forced-GC isolated-method diagnostic' : 'natural-GC retained-output component',
    boundary: 'Synchronous encoding of every prepared chunk; output retained through timer, SHA-256 checks outside wall/CPU timers; CPU includes all process threads',
    temperature: {coldStartMeasured: false, parityPassesPerArm: 1, additionalWarmupPassesPerArm: options.smoke ? 0 : options.warmup, parityAndWarmupOrder: initialOrder, processReused: true, garbageCollection: options.gcBeforeArm ? 'synchronous major collection before each measured arm, after parity and natural-GC warmup, outside wall/CPU/page-fault counters; not an import regime' : 'natural; no forced collections'},
    inputModel: 'Pinned baseline parser; adjacent two-bank groups; monotonic 20-byte unique-content reference slots; no dictionary-wide deduplication',
    completeFixtures: !options.smoke,
    smoke: options.smoke,
    options,
    sources: identities,
    parser: {sourceSha256: sha256(await readFile(path.join(options.baseline, parserPath))), experimentsSourceSha256: sha256(await readFile(path.join(options.baseline, experimentsPath))), wasmSha256: sha256(wasmBytes), options: parserOptions},
    harnessSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    hostEnvironment: getHostEnvironment(),
    dictionaries: /** @type {Record<string, unknown>[]} */ ([]),
}
for (const id of dictionaryIds) {
    const fixture = fixtures[id]
    const {inputs, rows, bankCount, groupCount} = await prepareInputs(parser, fixture, options.cache, options.smoke, MAX_PREPARED_TERM_LOOKUP_INDEX_ROWS)
    const firstParity = encodeAll(stores[initialOrder[0]], inputs)
    const secondParity = encodeAll(stores[initialOrder[1]], inputs)
    const expected = initialOrder[0] === 'baseline' ? firstParity : secondParity
    const actual = initialOrder[0] === 'candidate' ? firstParity : secondParity
    if (expected.length !== actual.length || expected.some((bytes, i) => Buffer.compare(bytes, actual[i]) !== 0)) { throw new Error(`${id}: encoded record bytes differ`) }
    const outputSha256 = hashOutput(expected)
    const outputBytes = expected.reduce((total, bytes) => total + bytes.byteLength, 0)
    const pairs = []
    if (!options.smoke) {
        for (let round = 0; round < options.warmup; ++round) {
            for (const arm of initialOrder) { measure(stores[arm], inputs, 1, outputSha256) }
        }
        for (let pair = 0; pair < options.pairs; ++pair) {
            const order = pair % 2 === 0 ? initialOrder : [initialOrder[1], initialOrder[0]]
            const before = getHostEnvironment()
            const first = measure(stores[order[0]], inputs, options.iterations, outputSha256, options.gcBeforeArm)
            const second = measure(stores[order[1]], inputs, options.iterations, outputSha256, options.gcBeforeArm)
            const baseline = order[0] === 'baseline' ? first : second
            const candidate = order[0] === 'candidate' ? first : second
            pairs.push({order, baseline, candidate, improvementPercent: (baseline.perPassMs - candidate.perPassMs) / baseline.perPassMs * 100, before, after: getHostEnvironment()})
        }
    }
    report.dictionaries.push({
        id,
        fixture,
        rows,
        bankCount,
        groupCount,
        chunks: inputs.length,
        outputBytes,
        outputSha256,
        exactByteParity: true,
        pairs,
        medianBaselineMs: median(pairs.map((pair) => pair.baseline.perPassMs)),
        medianCandidateMs: median(pairs.map((pair) => pair.candidate.perPassMs)),
        medianBaselineCpuMs: median(pairs.map((pair) => pair.baseline.perPassCpuMs)),
        medianCandidateCpuMs: median(pairs.map((pair) => pair.candidate.perPassCpuMs)),
        medianImprovementPercent: median(pairs.map((pair) => pair.improvementPercent)),
    })
    console.log(`[record-fields] ${id} rows=${rows} exactParity=true pairs=${pairs.length}`)
}
for (const arm of /** @type {const} */ (['baseline', 'candidate'])) {
    if ((await sourceIdentity(options[arm])).recordSourceSha256 !== identities[arm].recordSourceSha256) { throw new Error(`${arm} source changed during benchmark`) }
}
await mkdir(path.dirname(options.output), {recursive: true})
await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, {flag: 'wx'})
console.log(`[record-fields] report=${options.output}`)
