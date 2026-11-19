// SPDX-License-Identifier: GPL-3.0-or-later
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {spawn, execFileSync} from 'node:child_process'
import {mkdir, readFile, writeFile, readdir, lstat, open} from 'node:fs/promises'
import {parseArgs} from 'node:util'
import {fileURLToPath, pathToFileURL} from 'node:url'
import path from 'node:path'
import os from 'node:os'

const {values} = parseArgs({options: {
    baseline: {type: 'string'},
    candidate: {type: 'string'},
    dictionary: {type: 'string', default: 'jmdict'},
    rounds: {type: 'string', default: '12'},
    warmup: {type: 'string', default: '2'},
    'initial-order': {type: 'string', default: 'ABC'},
    output: {type: 'string'},
}})
assert(values.baseline && values.candidate && values.output, 'Provide --baseline, --candidate and --output')
const positive = (value) => {
    assert(/^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)), `Invalid count ${value}`)
    return Number(value)
}
const rounds = positive(values.rounds)
const warmups = positive(values.warmup)
const permutations = ['ABC', 'BCA', 'CAB', 'ACB', 'CBA', 'BAC']
assert(permutations.includes(values['initial-order']))
const startOrder = permutations.indexOf(values['initial-order'])
const rootA = path.resolve(values.baseline)
const rootB = path.resolve(values.candidate)
const output = path.resolve(values.output)
const runner = fileURLToPath(import.meta.url)
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const runnerSha256 = sha(await readFile(runner))
const load = (root, file) => {
    // Explicit caller-selected local checkouts; all imported file names below
    // are fixed by this runner, never supplied by dictionary content.
    // eslint-disable-next-line no-unsanitized/method
    return import(pathToFileURL(path.join(root, file)))
}
const {getSourceProvenance, extractImportResult} = await load(rootB, 'dev/perf/benchmark-support.js')
const {loadDictionaryFixtures} = await load(rootB, 'dev/perf/dictionary-fixtures.js')
const {loadDictionaryWasm} = await load(rootB, 'dev/dictionary-wasm.js')
const {ZipReader, Uint8ArrayReader, Uint8ArrayWriter} = await load(rootB, 'node_modules/@zip.js/zip.js/index.js')
const fixtures = await loadDictionaryFixtures()
const fixture = fixtures[values.dictionary]
assert(fixture, 'Unknown pinned dictionary')
try {
    await lstat(output)
    throw new Error('Output already exists; choose a new evidence directory')
} catch (error) {
    if (error.code !== 'ENOENT') { throw error }
}

async function identity(root) {
    const hash = createHash('sha256')
    async function walk(directory) {
        const entries = await readdir(path.join(root, directory), {withFileTypes: true})
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            const file = path.join(directory, entry.name)
            if (entry.isDirectory()) {
                await walk(file)
            } else if (/\.(js|json|c|h|wasm)$/.test(file)) {
                hash.update(`${file}\0${sha(await readFile(path.join(root, file)))}\n`)
            }
        }
    }
    await walk('ext/js')
    await walk('dev/data/dictionary-wasm')
    const runtimeSha256 = hash.digest('hex')
    const helperHash = createHash('sha256')
    async function helpers(directory) {
        const entries = await readdir(path.join(root, directory), {withFileTypes: true})
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            const file = path.join(directory, entry.name)
            if (entry.isDirectory()) {
                await helpers(file)
            } else if (/\.(js|mjs|json)$/.test(file)) {
                helperHash.update(`${file}\0${sha(await readFile(path.join(root, file)))}\n`)
            }
        }
    }
    await helpers('test/e2e')
    await helpers('test/chromium')
    helperHash.update(await readFile(path.join(root, 'dev/perf/host-environment.js')))
    const helperSha256 = helperHash.digest('hex')
    const provenance = await getSourceProvenance(root)
    const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {cwd: root, encoding: 'utf8'}).trim()
    assert(/^[a-f0-9]{40}$/.test(provenance.gitSha ?? ''))
    assert.equal(provenance.dirty, false, 'Use immutable clean source checkouts')
    const packageBytes = await readFile(path.join(root, 'builds/manabitan-chrome.zip'))
    const packageSha256 = sha(packageBytes)
    const pinnedWasm = loadDictionaryWasm(root)
    const packagedWasmSha256 = {}
    const zip = new ZipReader(new Uint8ArrayReader(new Uint8Array(packageBytes)))
    try {
        const entries = await zip.getEntries()
        for (const [name, bytes] of pinnedWasm) {
            const matches = entries.filter(({filename}) => filename === `lib/${name}`)
            assert.equal(matches.length, 1, `Missing or duplicate packaged WASM ${name}`)
            const packaged = await matches[0].getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true})
            assert.equal(sha(packaged), sha(bytes), `Stale packaged WASM ${name}`)
            packagedWasmSha256[name] = sha(packaged)
        }
    } finally {
        await zip.close()
    }
    const harnesses = {}
    for (const file of ['package-lock.json',
        'test/perf/dictionaries.lock.json',
        'dev/perf/import-benchmark.js',
        'dev/perf/benchmark-support.js',
        'dev/perf/dictionary-fixtures.js',
        'test/e2e/import-timing.js',
        'test/chromium/extension-two-dictionary-import.e2e.js']) {
        harnesses[file] = sha(await readFile(path.join(root, file)))
    }
    return {root,
        runtimeSha256,
        helperSha256,
        gitSha: provenance.gitSha,
        tree,
        packageSha256,
        packagedWasmSha256,
        harnesses}
}
const identities = {A: await identity(rootA), B: await identity(rootB)}
assert.deepEqual(identities.A.harnesses, identities.B.harnesses, 'Both source arms must use the same harness, dependencies and fixture lock')
assert.equal(identities.A.helperSha256, identities.B.helperSha256, 'Browser harness helper trees differ')
assert.notEqual(identities.A.runtimeSha256, identities.B.runtimeSha256, 'Candidate runtime must differ from baseline')
assert.notEqual(identities.A.packagedWasmSha256['term-bank-parser.wasm'], identities.B.packagedWasmSha256['term-bank-parser.wasm'], 'Candidate package must contain changed parser WASM')
const roots = {A: rootA, B: rootB, C: rootA}
const expected = {A: identities.A, B: identities.B, C: identities.A}
const report = {schemaVersion: 1,
    complete: false,
    kind: 'full-import-source-cohort',
    plan: {dictionary: values.dictionary,
        rounds,
        warmups,
        permutations,
        startOrder,
        description: 'Each round contains one baseline A, candidate B and identical baseline C in a balanced rotating order. Fresh browser profile and OPFS store for every observation. All observations retained; no timing retries or optional stopping.'},
    fixture,
    identities,
    runnerSha256,
    startedAt: new Date().toISOString(),
    node: process.version,
    v8: process.versions.v8,
    host: {platform: process.platform,
        arch: process.arch,
        cpus: os.cpus().map(({model, speed}) => ({model, speed})),
        totalMemory: os.totalmem(),
        startLoad: os.loadavg()},
    timingBoundary: 'browser monotonic file-input change to current-operation post-UI import completion',
    warmups: [],
    rounds: [],
    observations: []}
await mkdir(path.dirname(output), {recursive: true})
await mkdir(output)
const save = () => writeFile(path.join(output, 'cohort.json'), JSON.stringify(report, null, 2) + '\n')
await save()
let observationIndex = 0
let browserVersion = null

async function observe(arm, phase, round) {
    ++observationIndex
    const name = `${String(observationIndex).padStart(3, '0')}-${phase}-${round}-${arm}`
    const directory = path.join(output, name)
    await mkdir(directory)
    const log = await open(path.join(directory, 'run.log'), 'wx')
    try {
        await new Promise((resolve, reject) => {
            const child = spawn(
                process.execPath,
                [path.join(roots[arm], 'dev/perf/import-benchmark.js'),
                    values.dictionary,
                    '--runs',
                    '1',
                    '--flags',
                    '{}',
                    '--no-build',
                    '--build-target',
                    'chrome',
                    '--output',
                    directory],
                {cwd: roots[arm], env: {...process.env}, stdio: ['ignore', log.fd, log.fd], timeout: 10 * 60 * 1000},
            )
            child.on('error', reject)
            child.on('close', (code, signal) => (code === 0 ? resolve() : reject(new Error(`Observation ${name} failed: ${code} ${signal}`))))
        })
    } finally {
        await log.close()
    }
    const summaryBytes = await readFile(path.join(directory, 'summary.json'))
    const summary = JSON.parse(summaryBytes)
    const rawBytes = await readFile(path.join(directory, 'run-1.json'))
    const raw = JSON.parse(rawBytes)
    assert.equal(summary.schemaVersion, 3)
    assert.equal(summary.dictionary, values.dictionary)
    assert.equal(summary.buildTarget, 'chrome')
    assert.equal(summary.authoritativeTiming, true)
    assert.equal(summary.traceEnabled, false)
    assert.equal(summary.source.gitSha, expected[arm].gitSha)
    assert.equal(summary.source.dirty, false)
    assert.equal(summary.runs.length, 1)
    assert.equal(raw.packageSha256, expected[arm].packageSha256)
    assert.equal(summary.runs[0].packageSha256, expected[arm].packageSha256)
    assert.equal(summary.source.sha256['builds/manabitan-chrome.zip'], expected[arm].packageSha256)
    assert.deepEqual(summary.importFlags, {})
    assert.deepEqual(summary.fixture, fixture)
    for (const [file, digest] of Object.entries(expected[arm].harnesses)) { assert.equal(summary.source.sha256[file], digest) }
    const result = extractImportResult(raw, values.dictionary, fixture, false, {})
    assert.equal(summary.runs[0].totalImportMs, result.totalImportMs)
    assert.equal(typeof summary.browserVersion, 'string')
    assert(summary.browserVersion.length > 0, 'Missing browser version')
    assert.equal(raw.browserVersion, summary.browserVersion, 'Raw browser version differs from summary')
    if (browserVersion === null) { browserVersion = summary.browserVersion }
    assert.equal(summary.browserVersion, browserVersion, 'Browser version changed within cohort')
    const observation = {index: observationIndex,
        phase,
        round,
        arm,
        directory: name,
        totalImportMs: result.totalImportMs,
        workerImportMs: result.workerImportMs,
        automationObservedImportMs: result.automationObservedImportMs,
        validation: result.validation,
        packageSha256: raw.packageSha256,
        summarySha256: sha(summaryBytes),
        rawReportSha256: sha(rawBytes),
        browserVersion,
        host: summary.hostEnvironment}
    report.observations.push(observation)
    await save()
    console.log(`${name}: ${result.totalImportMs.toFixed(2)}ms`)
    return observation
}

const median = (numbers) => {
    const sorted = [...numbers].sort((a, b) => a - b)
    return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2
}
function compareArrays(a, b) {
    const deltas = a.map((value, index) => (b[index] / value - 1) * 100)
    return {baselineMedianMs: median(a),
        comparisonMedianMs: median(b),
        medianPairedDeltaPercent: median(deltas),
        equalWorkDeltaPercent: (b.reduce((sum, value) => sum + value, 0) / a.reduce((sum, value) => sum + value, 0) - 1) * 100,
        fasterRounds: deltas.filter((delta) => delta < 0).length,
        worstPairDeltaPercent: Math.max(...deltas),
        pairedDeltaPercent: deltas}
}
try {
    for (let round = 0; round < warmups + rounds; ++round) {
        const phase = round < warmups ? 'warmup' : 'measured'
        const phaseRound = phase === 'warmup' ? round + 1 : round - warmups + 1
        const order = permutations[(startOrder + phaseRound - 1) % permutations.length]
        const row = {round: phaseRound, order}
        for (const arm of order) { row[arm] = await observe(arm, phase, phaseRound) }
        report[phase === 'warmup' ? 'warmups' : 'rounds'].push(row)
        await save()
    }
    assert.deepEqual(await identity(rootA), identities.A, 'Baseline changed within cohort')
    assert.deepEqual(await identity(rootB), identities.B, 'Candidate changed within cohort')
    assert.equal(sha(await readFile(runner)), runnerSha256, 'Cohort runner changed')
    const times = Object.fromEntries(['A', 'B', 'C'].map((arm) => [arm, report.rounds.map((round) => round[arm].totalImportMs)]))
    report.summary = {candidate: compareArrays(times.A, times.B),
        identicalCodeControl: compareArrays(times.A, times.C),
        candidateVersusSecondControl: compareArrays(times.C, times.B),
        candidateVersusGeometricControls: compareArrays(times.A.map((value, index) => Math.sqrt(value * times.C[index])), times.B)}
    report.complete = true
    report.completedAt = new Date().toISOString()
    report.host.endLoad = os.loadavg()
    await save()
    console.log(JSON.stringify(report.summary))
} catch (error) {
    report.error = String(error?.stack ?? error)
    report.failedObservation = observationIndex
    await save()
    throw error
}
