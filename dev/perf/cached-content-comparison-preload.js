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
import {closeSync, ftruncateSync, openSync, writeSync} from 'node:fs'
import {lstat, mkdir, readFile, readdir, realpath} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {parseJson} from '../../ext/js/core/json.js'
import {getSourceProvenance, parsePositiveInteger} from './benchmark-support.js'
import {getHostEnvironment} from './host-environment.js'

// Preload this module with --import when running one baseline-source invocation
// of jmdict-component-benchmark.js (harnessSemanticsVersion 3). Required env:
// MANABITAN_CACHED_CONTENT_CANDIDATE, MANABITAN_CACHED_CONTENT_OUTPUT.
// Optional suffixes: PAIRS (12), PASSES (20), WARMUPS (1), INITIAL_ORDER (AB),
// EXPECTED_DESCRIPTORS (no default). The latter asserts timed fixture coverage.
// The enclosing component report is diagnostic: repeated calls perturb it.

/** @typedef {import('../../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} Database */
/** @typedef {import('../../ext/js/dictionary/dictionary-database.js').ExactTermContentDescriptor} Descriptor */
/** @typedef {import('../../ext/js/dictionary/dictionary-database.js').ExactTermContentResult} ExactResult */
/** @typedef {(this: Database, descriptors: Descriptor[]) => Promise<ExactResult[]>} ExactMethod */
/** @typedef {{elapsedMs: number, userCpuMs: number, systemCpuMs: number, cpuMs: number, perPassMs: number, perPassCpuMs: number}} Sample */
/** @typedef {{pair: number, order: string, baseline: Sample, candidate: Sample}} Pair */
/** @typedef {{index: number, descriptors: number, descriptorBytes: number, recentSourceResults: number, otherResults: number, guardCalls: Record<string, number>, eligible: boolean, skipReasons: string[], inputSha256?: string, recentCacheBatches?: number, recentCacheBytes?: number, warmups?: Pair[], pairs?: Pair[]}} Wave */

const scriptPath = fileURLToPath(import.meta.url)
const methodName = '_findMatchingPersistedTermEntryContentMetaBatch'
const databasePath = 'ext/js/dictionary/dictionary-database.js'
const instrumentationKey = Symbol.for('manabitan.perf.instrumentation')
const envPrefix = 'MANABITAN_CACHED_CONTENT_'
const nonCachedMethods = [
    '_readTermEntryContentBytesDetailedBatch',
    '_readTermEntryContentBytesDetailed',
    '_findInFlightTermContentSource',
    '_setTermContentSignatures',
]

/**
 * @param {string} name
 * @returns {string|undefined}
 * @throws {Error} If an option occurs more than once or has no value.
 */
function commandOption(name) {
    const args = process.argv.slice(2)
    /** @type {string|undefined} */
    let value
    for (let i = 0; i < args.length; ++i) {
        if (args[i] === `--${name}` || args[i].startsWith(`--${name}=`)) {
            if (typeof value !== 'undefined') { throw new Error(`Duplicate --${name}`) }
            value = args[i].includes('=') ? args[i].slice(name.length + 3) : args[++i]
            if (!value || value.startsWith('--')) { throw new Error(`Missing --${name} value`) }
        }
    }
    return value
}

/**
 * @param {Uint8Array|string} value
 * @returns {string}
 */
function sha256(value) { return createHash('sha256').update(value).digest('hex') }

/**
 * @param {object} target
 * @param {string} name
 * @returns {unknown}
 */
function readMember(target, name) { return Reflect.get(target, name) }

/**
 * @param {string} url
 * @returns {Promise<unknown>}
 */
async function importLocalModule(url) {
    // eslint-disable-next-line no-unsanitized/method -- Explicit local source checkouts are verified before importing.
    return await import(url)
}

/**
 * Compare the entire production source/assets tree, not just selected helper
 * names. Only the target method may differ between the two checkouts.
 * @param {string} root
 * @returns {Promise<Record<string, string>>}
 */
async function dependencyHashes(root) {
    /** @type {Record<string, string>} */
    const result = {}
    /**
     * @param {string} directory
     * @returns {Promise<void>}
     */
    async function visit(directory) {
        const entries = await readdir(path.join(root, directory), {withFileTypes: true})
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            const relative = `${directory}/${entry.name}`
            if (entry.isDirectory()) {
                await visit(relative)
            } else if (relative !== databasePath) {
                result[relative] = sha256(await readFile(path.join(root, relative)))
            }
        }
    }
    for (const directory of ['ext/js', 'ext/lib', 'dev/data/dictionary-wasm']) { await visit(directory) }
    for (const relative of ['package-lock.json', 'test/perf/dictionaries.lock.json']) {
        result[relative] = sha256(await readFile(path.join(root, relative)))
    }
    return result
}

/**
 * @param {string} source
 * @param {ExactMethod} method
 * @returns {string}
 * @throws {Error} If the runtime function cannot be uniquely located in source.
 */
function withoutTargetMethod(source, method) {
    const body = Function.prototype.toString.call(method)
    const start = source.indexOf(body)
    if (start < 0 || source.includes(body, start + body.length)) {
        throw new Error('Target method is not unique in its source file')
    }
    return `${source.slice(0, start)}<EXACT_CACHED_COMPARISON_METHOD>${source.slice(start + body.length)}`
}

/**
 * @param {ExactResult[]} actual
 * @param {ExactResult[]} expected
 */
function assertResults(actual, expected) {
    assert.equal(actual.length, expected.length, 'Result count differs')
    for (let i = 0; i < expected.length; ++i) {
        assert.equal(actual[i].existingMeta, expected[i].existingMeta, `Metadata identity differs at descriptor ${i}`)
        assert.equal(actual[i].exactFallback, expected[i].exactFallback, `Exact fallback flag differs at descriptor ${i}`)
        assert.equal(actual[i].recentSourceHit, expected[i].recentSourceHit, `Recent source flag differs at descriptor ${i}`)
        assert.deepEqual(Object.keys(actual[i]).sort(), Object.keys(expected[i]).sort(), `Result fields differ at descriptor ${i}`)
    }
}

/**
 * Snapshot referenced bytes/metadata and cache membership outside the timer.
 * Cache buffers and typed columns keep their identity; only referenced spans
 * are hashed, so verification does not traverse unrelated content each wave.
 * @param {Database} database
 * @param {Descriptor[]} descriptors
 * @param {ExactResult[]} expected
 * @returns {{references: unknown[], sha256: string}}
 */
function cacheWitness(database, descriptors, expected) {
    const hash = createHash('sha256')
    const cache = /** @type {Map<number, Uint8Array>} */ (readMember(database, '_recentTermContentSourceBatches'))
    const batchIds = /** @type {Uint32Array} */ (readMember(database, '_termEntryContentMetaRecentSourceBatchIdTable'))
    const offsets = /** @type {Uint32Array} */ (readMember(database, '_termEntryContentMetaRecentSourceOffsetTable'))
    const findRecentSource = /** @type {Database['_findRecentTermContentSource']} */ (readMember(database, '_findRecentTermContentSource'))
    /** @type {unknown[]} */
    const references = [cache, batchIds, offsets]
    hash.update(JSON.stringify({
        cacheBytes: readMember(database, '_recentTermContentSourceBatchBytes'),
        cacheMaxBytes: readMember(database, '_recentTermContentSourceCacheMaxBytes'),
        nextBatchId: readMember(database, '_nextRecentTermContentSourceBatchId'),
        batchTableLength: batchIds.length,
        offsetTableLength: offsets.length,
    }))
    for (const [id, buffer] of cache) {
        references.push(id, buffer)
        hash.update(`${id}:${buffer.byteLength};`)
    }
    for (let i = 0; i < descriptors.length; ++i) {
        const descriptor = descriptors[i]
        references.push(descriptor, descriptor.contentBytes, descriptor.primary, expected[i].existingMeta)
        hash.update(JSON.stringify({hash1: descriptor.hash1, hash2: descriptor.hash2, length: descriptor.contentBytes.byteLength}))
        hash.update(descriptor.contentBytes)
        for (const meta of [descriptor.primary, expected[i].existingMeta]) {
            if (typeof meta === 'undefined') {
                hash.update('undefined;')
                continue
            }
            hash.update(JSON.stringify(Object.fromEntries(Object.entries(meta).sort(([a], [b]) => a.localeCompare(b)))))
            const index = meta.tableIndex
            if (typeof index === 'number') { hash.update(`${index}:${batchIds[index]}:${offsets[index]};`) }
            const source = findRecentSource.call(database, meta)
            if (typeof source === 'undefined') {
                hash.update('uncached;')
                continue
            }
            references.push(source.buffer)
            hash.update(`${source.offset}:${source.length}:`)
            hash.update(source.buffer.subarray(source.offset, source.offset + source.length))
        }
    }
    return {references, sha256: hash.digest('hex')}
}

/**
 * @param {ReturnType<typeof cacheWitness>} actual
 * @param {ReturnType<typeof cacheWitness>} expected
 */
function assertWitness(actual, expected) {
    assert.equal(actual.sha256, expected.sha256, 'Cached comparison mutated descriptor, metadata, or referenced cache bytes')
    assert.equal(actual.references.length, expected.references.length, 'Cache membership changed')
    for (let i = 0; i < expected.references.length; ++i) {
        assert.equal(actual.references[i], expected.references[i], `Cache/input identity changed at reference ${i}`)
    }
}

/**
 * Guards are never invoked by a qualified recent-source-only path. During the
 * first ordinary baseline call they count fallback work and allow it normally.
 * Subsequent benchmark calls fail before any non-cache read or signature write.
 * @param {Database} database
 * @returns {{calls: Record<string, number>, requireCached: () => void, restore: () => void}}
 */
function installCacheGuards(database) {
    /** @type {Record<string, number>} */
    const calls = {}
    let cachedOnly = false
    const originals = nonCachedMethods.map((name) => {
        const own = Object.getOwnPropertyDescriptor(database, name)
        const method = /** @type {(...args: unknown[]) => unknown} */ (readMember(database, name))
        assert.equal(typeof method, 'function', `Missing guarded method: ${name}`)
        calls[name] = 0
        /**
         * @this {Database}
         * @param {...unknown} args
         * @returns {unknown}
         * @throws {Error} If a measured call leaves the cached-only path.
         */
        function guardedNonCachedOperation(...args) {
            ++calls[name]
            if (cachedOnly) { throw new Error(`Cached-only wave attempted ${name}`) }
            return Reflect.apply(method, this, args)
        }
        Object.defineProperty(database, name, {configurable: true, writable: true, value: guardedNonCachedOperation})
        return {name, own}
    })
    return {
        calls,
        requireCached() { cachedOnly = true },
        restore() {
            for (const {name, own} of originals) {
                if (typeof own === 'undefined') {
                    Reflect.deleteProperty(database, name)
                } else {
                    Object.defineProperty(database, name, own)
                }
            }
        },
    }
}

/**
 * Retain every result until the timer stops, then verify every descriptor.
 * The loop/await/output retention is common to both arms and is explicitly
 * included; no hashing, assertions, source reads, or report writes are timed.
 * @param {ExactMethod} method
 * @param {Database} database
 * @param {Descriptor[]} descriptors
 * @param {ExactResult[]} expected
 * @param {number} passes
 * @returns {Promise<Sample>}
 */
async function measure(method, database, descriptors, expected, passes) {
    /** @type {ExactResult[][]} */
    const outputs = new Array(passes)
    const cpuBefore = process.cpuUsage()
    const started = process.hrtime.bigint()
    for (let pass = 0; pass < passes; ++pass) { outputs[pass] = await method.call(database, descriptors) }
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
    const cpu = process.cpuUsage(cpuBefore)
    for (const output of outputs) { assertResults(output, expected) }
    return {elapsedMs, userCpuMs: cpu.user / 1000, systemCpuMs: cpu.system / 1000, cpuMs: (cpu.user + cpu.system) / 1000, perPassMs: elapsedMs / passes, perPassCpuMs: (cpu.user + cpu.system) / (1000 * passes)}
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

/**
 * @param {Wave[]} waves
 * @param {number} pairs
 * @param {number} passes
 * @returns {object|null}
 */
function summarize(waves, pairs, passes) {
    const eligible = waves.filter((wave) => wave.eligible)
    if (eligible.length === 0) { return null }
    const observations = Array.from({length: pairs}, (_, pair) => {
        const baseline = {elapsedMs: 0, userCpuMs: 0, systemCpuMs: 0, cpuMs: 0}
        const candidate = {elapsedMs: 0, userCpuMs: 0, systemCpuMs: 0, cpuMs: 0}
        for (const wave of eligible) {
            const result = /** @type {Pair[]} */ (wave.pairs)[pair]
            for (const key of /** @type {const} */ (['elapsedMs', 'userCpuMs', 'systemCpuMs', 'cpuMs'])) {
                baseline[key] += result.baseline[key] / passes
                candidate[key] += result.candidate[key] / passes
            }
        }
        return {pair: pair + 1, baseline, candidate, percentChange: (candidate.elapsedMs / baseline.elapsedMs - 1) * 100, percentCpuChange: (candidate.cpuMs / baseline.cpuMs - 1) * 100}
    })
    return {
        boundary: 'Sum across eligible real descriptor waves, normalized to one method invocation per wave. Repeated hot-cache diagnostic, not whole-import time.',
        observations,
        baselineMedianMs: median(observations.map((item) => item.baseline.elapsedMs)),
        candidateMedianMs: median(observations.map((item) => item.candidate.elapsedMs)),
        medianPairedPercentChange: median(observations.map((item) => item.percentChange)),
        candidateFasterPairs: observations.filter((item) => item.percentChange < 0).length,
        baselineMedianCpuMs: median(observations.map((item) => item.baseline.cpuMs)),
        candidateMedianCpuMs: median(observations.map((item) => item.candidate.cpuMs)),
        medianPairedPercentCpuChange: median(observations.map((item) => item.percentCpuChange)),
        candidateLowerCpuPairs: observations.filter((item) => item.percentCpuChange < 0).length,
    }
}

if (process.versions.node.split('.')[0] !== '22') { throw new Error('Use Node.js 22 for cached-content comparison') }
const sourceOption = commandOption('source')
const componentOutputOption = commandOption('output')
const candidateOption = process.env[`${envPrefix}CANDIDATE`]
const outputOption = process.env[`${envPrefix}OUTPUT`]
if (!sourceOption || !componentOutputOption || !candidateOption || !outputOption || commandOption('baseline') || commandOption('candidate') || commandOption('profile')) {
    throw new Error('Preload requires a single unprofiled --source/--output component run and CACHED_CONTENT_CANDIDATE/OUTPUT environment values')
}
const baselineRoot = await realpath(sourceOption)
const candidateRoot = await realpath(candidateOption)
const componentPath = await realpath(process.argv[1])
const componentOutput = path.resolve(componentOutputOption)
const output = path.resolve(outputOption)
assert.notEqual(output, componentOutput, 'Diagnostic and component output paths must differ')
const pairs = parsePositiveInteger(process.env[`${envPrefix}PAIRS`] ?? '12', `${envPrefix}PAIRS`)
const passes = parsePositiveInteger(process.env[`${envPrefix}PASSES`] ?? '20', `${envPrefix}PASSES`)
const warmups = parsePositiveInteger(process.env[`${envPrefix}WARMUPS`] ?? '1', `${envPrefix}WARMUPS`)
const initialOrder = process.env[`${envPrefix}INITIAL_ORDER`] ?? 'AB'
assert.ok(initialOrder === 'AB' || initialOrder === 'BA', 'INITIAL_ORDER must be AB or BA')
const expectedOption = process.env[`${envPrefix}EXPECTED_DESCRIPTORS`]
const expectedDescriptors = typeof expectedOption === 'undefined' ? null : parsePositiveInteger(expectedOption, `${envPrefix}EXPECTED_DESCRIPTORS`)
try {
    await lstat(output)
    throw new Error(`Refusing to replace an existing diagnostic: ${output}`)
} catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) { throw error }
}
const roots = [baselineRoot, candidateRoot]
const dependencies = [await dependencyHashes(baselineRoot), await dependencyHashes(candidateRoot)]
assert.deepEqual(dependencies[0], dependencies[1], 'Production dependencies differ outside the target database method')
const sources = await Promise.all(roots.map(async (root) => ({
    root,
    provenance: await getSourceProvenance(root),
    databaseSha256: sha256(await readFile(path.join(root, databasePath))),
})))
const databaseSources = await Promise.all(roots.map((root) => readFile(path.join(root, databasePath), 'utf8')))
const classes = await Promise.all(roots.map(async (root) => {
    const module = /** @type {typeof import('../../ext/js/dictionary/dictionary-database.js')} */ (await importLocalModule(pathToFileURL(path.join(root, databasePath)).href))
    return module.DictionaryDatabase
}))
const baselineMethod = /** @type {ExactMethod} */ (readMember(classes[0].prototype, methodName))
const candidateMethod = /** @type {ExactMethod} */ (readMember(classes[1].prototype, methodName))
assert.equal(withoutTargetMethod(databaseSources[0], baselineMethod), withoutTargetMethod(databaseSources[1], candidateMethod), 'Database changes extend beyond the target method')
const harnessSha256 = sha256(await readFile(scriptPath))
const componentHarnessSha256 = sha256(await readFile(componentPath))
assert.equal(Reflect.get(globalThis, instrumentationKey), void 0, 'A component instrumentation hook is already installed')
await mkdir(path.dirname(output), {recursive: true})
const reportFd = openSync(output, 'wx')
/** @type {Wave[]} */
const waves = []
const report = {
    schemaVersion: 1,
    kind: 'cached-content-method-comparison',
    status: 'running',
    startedAt: new Date().toISOString(),
    diagnosticOnly: true,
    wholeImportTiming: false,
    method: methodName,
    boundary: 'Only repeated live-database method invocations plus common loop/await/output retention overhead. Every returned descriptor is checked outside the timer. No storage fallback is permitted in measured waves.',
    state: 'Actual baseline import grouping, descriptors, metadata and cache. Both methods use the same baseline database receiver. First ordinary baseline result is the oracle; no synthetic descriptor or cache construction.',
    exclusions: ['baseline oracle', 'candidate parity warmup', 'source/input/state hashes', 'result assertions', 'report writing', 'all enclosing import components'],
    configuration: {pairs, passes, warmups, initialOrder, expectedDescriptors, baselineRoot, candidateRoot, componentPath, componentOutput, output, execArgv: process.execArgv, argv: process.argv},
    sources,
    dependencyHashes: dependencies[0],
    methodHashes: {baseline: sha256(Function.prototype.toString.call(baselineMethod)), candidate: sha256(Function.prototype.toString.call(candidateMethod))},
    sameCodeControl: Function.prototype.toString.call(baselineMethod) === Function.prototype.toString.call(candidateMethod),
    harnessSha256,
    componentHarnessSha256,
    hostBefore: getHostEnvironment(),
    waves,
    /** @type {object|null} */
    coverage: null,
    /** @type {object|null} */
    summary: null,
    /** @type {object|null} */
    component: null,
    /** @type {object|null} */
    hostAfter: null,
    /** @type {string|null} */
    failure: null,
}

/** @returns {void} */
function writeReport() {
    ftruncateSync(reportFd, 0)
    writeSync(reportFd, `${JSON.stringify(report, null, 2)}\n`, 0, 'utf8')
}
writeReport()
Reflect.set(globalThis, instrumentationKey, {kind: report.kind, diagnosticOnly: true, report: output, method: methodName})

/**
 * @this {Database}
 * @param {Descriptor[]} descriptors
 * @returns {Promise<ExactResult[]>}
 * @throws {Error} If a qualified cached comparison changes state or output.
 */
async function compareLiveWave(descriptors) {
    const guards = installCacheGuards(this)
    /** @type {Wave} */
    const wave = {index: waves.length + 1, descriptors: descriptors.length, descriptorBytes: descriptors.reduce((sum, item) => sum + item.contentBytes.byteLength, 0), recentSourceResults: 0, otherResults: 0, guardCalls: guards.calls, eligible: false, skipReasons: []}
    waves.push(wave)
    try {
        const expected = await baselineMethod.call(this, descriptors)
        assert.equal(expected.length, descriptors.length, 'Ordinary baseline result count differs')
        wave.recentSourceResults = expected.filter((item) => item.recentSourceHit === true && item.exactFallback === true && typeof item.existingMeta !== 'undefined').length
        wave.otherResults = descriptors.length - wave.recentSourceResults
        if (descriptors.length === 0) { wave.skipReasons.push('empty wave') }
        if (wave.otherResults > 0) { wave.skipReasons.push('one or more descriptors did not resolve from recent source') }
        if (Object.values(guards.calls).some((count) => count > 0)) { wave.skipReasons.push('ordinary baseline attempted non-cache work') }
        if (wave.skipReasons.length > 0) { return expected }
        guards.requireCached()
        const witness = cacheWitness(this, descriptors, expected)
        wave.inputSha256 = witness.sha256
        wave.recentCacheBatches = this._recentTermContentSourceBatches.size
        wave.recentCacheBytes = this._recentTermContentSourceBatchBytes
        assertResults(await candidateMethod.call(this, descriptors), expected)
        assertWitness(cacheWitness(this, descriptors, expected), witness)
        wave.warmups = []
        wave.pairs = []
        for (let pair = -warmups; pair < pairs; ++pair) {
            const orderIndex = (pair < 0 ? pair + warmups : pair) + wave.index - 1
            const order = (orderIndex % 2 === 0) === (initialOrder === 'AB') ? ['baseline', 'candidate'] : ['candidate', 'baseline']
            /** @type {Map<string, Sample>} */
            const samples = new Map()
            for (const arm of order) {
                samples.set(arm, await measure(arm === 'baseline' ? baselineMethod : candidateMethod, this, descriptors, expected, passes))
            }
            const observation = {pair: pair < 0 ? pair + warmups + 1 : pair + 1, order: order[0] === 'baseline' ? 'AB' : 'BA', baseline: /** @type {Sample} */ (samples.get('baseline')), candidate: /** @type {Sample} */ (samples.get('candidate'))}
            if (pair < 0) {
                wave.warmups.push(observation)
            } else {
                wave.pairs.push(observation)
            }
        }
        assertWitness(cacheWitness(this, descriptors, expected), witness)
        wave.eligible = true
        return expected
    } catch (error) {
        wave.skipReasons.push('comparison failed')
        report.failure = String(error)
        throw error
    } finally {
        guards.restore()
    }
}
classes[0].prototype[methodName] = compareLiveWave
let finalized = false

/**
 * @param {number} exitCode
 * @returns {Promise<void>}
 */
async function finish(exitCode) {
    if (finalized) { return }
    finalized = true
    classes[0].prototype[methodName] = baselineMethod
    Reflect.deleteProperty(globalThis, instrumentationKey)
    try {
        assert.equal(exitCode, 0, 'Enclosing component process failed')
        assert.equal(report.failure, null, 'A comparison wave failed')
        const componentBytes = await readFile(componentOutput)
        const component = /** @type {Record<string, unknown>} */ (parseJson(componentBytes.toString('utf8')))
        assert.ok(component.harnessSemanticsVersion === 3 || component.harnessSemanticsVersion === 4, 'Corrected component semanticsVersion 3 or 4 is required')
        const instrumentation = /** @type {Record<string, unknown>|undefined} */ (component.instrumentation)
        assert.ok(instrumentation, 'Component report has no instrumentation receipt')
        assert.equal(instrumentation.diagnosticOnly, true, 'Component report was not marked instrumented diagnostic')
        assert.equal(instrumentation.report, output, 'Component instrumentation report path differs')
        assert.equal(/** @type {Record<string, unknown>} */ (component.timing).instrumentedDiagnostic, true, 'Component timing lacks its diagnostic marker')
        assert.equal(component.harnessSha256, componentHarnessSha256, 'Component harness identity differs')
        report.component = {path: componentOutput, sha256: sha256(componentBytes), harnessSemanticsVersion: component.harnessSemanticsVersion, fixture: component.fixture, policy: component.policy, rows: component.rows, parserTotals: component.parserTotals, sinkTotals: component.sinkTotals, verification: component.verification, instrumentation}
        for (let i = 0; i < roots.length; ++i) {
            assert.equal(sha256(await readFile(path.join(roots[i], databasePath))), sources[i].databaseSha256, 'Database source changed during the diagnostic')
            assert.deepEqual(await dependencyHashes(roots[i]), dependencies[i], 'Production dependencies changed during the diagnostic')
            assert.equal((await getSourceProvenance(roots[i])).gitSha, sources[i].provenance.gitSha, 'Source HEAD changed during the diagnostic')
        }
        assert.equal(sha256(await readFile(scriptPath)), harnessSha256, 'Preload harness changed during the diagnostic')
        assert.equal(sha256(await readFile(componentPath)), componentHarnessSha256, 'Component harness changed during the diagnostic')
        const timedDescriptors = waves.reduce((sum, wave) => sum + (wave.eligible ? wave.descriptors : 0), 0)
        if (expectedDescriptors !== null) { assert.equal(timedDescriptors, expectedDescriptors, 'Timed descriptor coverage differs from the required fixture coverage') }
        assert.ok(timedDescriptors > 0, 'No complete recent-source-only descriptor wave was observed')
        report.status = 'passed'
    } catch (error) {
        report.status = 'failed'
        report.failure ??= String(error)
        process.exitCode = 1
    } finally {
        report.coverage = {
            observedWaves: waves.length,
            observedDescriptors: waves.reduce((sum, wave) => sum + wave.descriptors, 0),
            recentSourceResults: waves.reduce((sum, wave) => sum + wave.recentSourceResults, 0),
            timedWaves: waves.filter((wave) => wave.eligible).length,
            timedDescriptors: waves.reduce((sum, wave) => sum + (wave.eligible ? wave.descriptors : 0), 0),
            skippedWaves: waves.filter((wave) => !wave.eligible).length,
            skippedDescriptors: waves.reduce((sum, wave) => sum + (wave.eligible ? 0 : wave.descriptors), 0),
        }
        report.summary = summarize(waves, pairs, passes)
        report.hostAfter = getHostEnvironment()
        writeReport()
        closeSync(reportFd)
        process.stdout.write(`[cached-content] ${report.status}: ${output}\n`)
    }
}

process.once('uncaughtExceptionMonitor', (error) => { report.failure = String(error) })
process.once('beforeExit', (code) => { void finish(code) })
process.once('exit', (code) => {
    if (finalized) { return }
    report.status = 'failed'
    report.failure ??= `Process exited before diagnostic finalization (code ${code})`
    writeReport()
    closeSync(reportFd)
})
