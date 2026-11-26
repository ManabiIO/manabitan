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

// Fixed-source orchestration only; every observation uses import-benchmark.js.
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {execFileSync, spawnSync} from 'node:child_process'
import {isDeepStrictEqual} from 'node:util'
import {chromium} from '@playwright/test'
import {parseJson} from '../../ext/js/core/json.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const evidence = path.resolve(requiredEnv('PERF_EVIDENCE_ROOT'))
const baseline = requiredEnv('PERF_BASELINE_SHA')
const candidate = requiredEnv('PERF_CANDIDATE_SHA')
const workflow = requiredEnv('GITHUB_SHA')
const dictionary = requiredEnv('PERF_DICTIONARY')
const changesValue = parseJson(requiredEnv('PERF_EXPECTED_PACKAGE_CHANGES'))
if (!Array.isArray(changesValue) || !changesValue.every((value) => typeof value === 'string')) { throw new Error('Expected package changes must be strings') }
const expectedChanges = /** @type {string[]} */ (changesValue)
const candidateRoot = path.join(requiredEnv('RUNNER_TEMP'), 'import-candidate')
/** @type {Record<string, {root: string, sha: string, packageSha256: string, tree: string}>} */
const arms = {A: {root, sha: baseline, packageSha256: '', tree: ''}, B: {root: candidateRoot, sha: candidate, packageSha256: '', tree: ''}}
/** @type {Observation[]} */
const observations = []
/** @type {Array<{observation?: string, check?: string, error: string}>} */
const failures = []

/**
 * @typedef {{id: string, pair: number|null, arm: string, mediaCheck: string, sourceSha: string, packageSha256: string, exitCode: number|null}} Observation
 * @typedef {{bytes: number, files: Array<{path: string, bytes: number}>}} Storage
 * @typedef {{outputDigestSha256: string, storage: Storage, lookup: {observations: Array<{pass: number, term: string, results: number, sha256: string}>}, media: unknown}} Validation
 * @typedef {{packageSha256: string, totalImportMs: number, validation: Validation}} Run
 * @typedef {{runs: Run[], authoritativeTiming: boolean, traceEnabled: boolean, gitSha: string, mediaCheck: string, browserVersion: unknown}} Summary
 */

/**
 * @param {string} name
 * @returns {string}
 * @throws {Error} If the required setting is absent.
 */
function requiredEnv(name) {
    const value = process.env[name]
    if (typeof value !== 'string' || value.length === 0) { throw new Error(`Missing ${name}`) }
    return value
}

/**
 * @param {string} filename
 * @param {unknown} value
 */
function writeJson(filename, value) {
    fs.mkdirSync(path.dirname(filename), {recursive: true})
    fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * @param {string} filename
 * @returns {string}
 */
function hash(filename) {
    return createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
}

/**
 * @param {string} binary
 * @param {string[]} args
 * @param {string} [cwd]
 * @returns {string}
 */
function capture(binary, args, cwd = root) {
    return execFileSync(binary, args, {cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024}).trim()
}

/**
 * @param {string} binary
 * @param {string[]} args
 * @param {string} cwd
 * @param {string} log
 * @returns {number}
 */
function execute(binary, args, cwd, log) {
    const fd = fs.openSync(log, 'a')
    try {
        const result = spawnSync(binary, args, {cwd, env: process.env, stdio: ['ignore', fd, fd]})
        if (result.error) { fs.writeSync(fd, `${String(result.error)}\n`) }
        return result.status ?? 1
    } finally { fs.closeSync(fd) }
}

/**
 * @param {string} binary
 * @param {string[]} args
 * @param {string} cwd
 * @param {string} log
 * @throws {Error} If the command fails.
 */
function checked(binary, args, cwd, log) {
    const code = execute(binary, args, cwd, log)
    if (code !== 0) { throw new Error(`${binary} ${args.join(' ')} failed (${code}); see ${log}`) }
}

/**
 * @param {string} archive
 * @param {string} target
 * @returns {Record<string, string>}
 */
function packageMembers(archive, target) {
    const code = `import hashlib,json,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    result={i.filename:hashlib.sha256(z.read(i)).hexdigest() for i in z.infolist() if not i.is_dir()}
with open(sys.argv[2],'w') as f:json.dump(result,f,sort_keys=True,indent=2)
`
    capture('python3', ['-c', code, archive, target])
    return /** @type {Record<string, string>} */ (parseJson(fs.readFileSync(target, 'utf8')))
}

/** @param {string} relative */
function overlay(relative) {
    const bytes = execFileSync('git', ['show', `${workflow}:${relative}`], {cwd: root, maxBuffer: 32 * 1024 * 1024})
    for (const arm of Object.values(arms)) { fs.writeFileSync(path.join(arm.root, relative), bytes) }
}

/**
 * @param {string} armName
 * @param {string} id
 * @param {number|null} pair
 * @param {string} mode
 */
function observe(armName, id, pair, mode) {
    const arm = arms[armName]
    const output = path.join(evidence, id)
    fs.mkdirSync(output, {recursive: true})
    /** @type {Observation} */
    const observation = {id, pair, arm: armName, mediaCheck: mode, sourceSha: arm.sha, packageSha256: arm.packageSha256, exitCode: null}
    observations.push(observation)
    writeJson(path.join(evidence, 'observations.json'), observations)
    execute(process.execPath, ['dev/perf/host-environment.js'], arm.root, path.join(output, 'host-before.json'))
    observation.exitCode = execute(process.execPath, [
        'dev/perf/import-benchmark.js',
        dictionary,
        '--runs',
        '1',
        '--no-build',
        '--build-target',
        'chrome',
        '--media-check',
        mode,
        '--output',
        output,
    ], arm.root, path.join(output, 'run.log'))
    fs.writeFileSync(path.join(output, 'exit-code.txt'), `${observation.exitCode}\n`)
    execute(process.execPath, ['dev/perf/host-environment.js'], arm.root, path.join(output, 'host-after.json'))
    writeJson(path.join(evidence, 'observations.json'), observations)
    console.log(`${id}: exit ${observation.exitCode}`)
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
 * @param {Storage} storage
 * @returns {Storage}
 * @throws {Error} If the report omits file sizes.
 */
function storageSignature(storage) {
    if (!Array.isArray(storage.files) || storage.files.length === 0) { throw new Error('Missing per-file OPFS sizes') }
    // SAH-pool basenames and media-generation UUIDs are random. Retain raw
    // paths and compare exact paths elsewhere, plus each namespace's sizes.
    return {
        bytes: storage.bytes,
        files: storage.files.map(({path: filename, bytes}) => ({
            path: filename
                .replace(/^manabitan\/sqlite-sahpool-v1\/\.opaque\/[^/]+$/, 'manabitan/sqlite-sahpool-v1/.opaque/*')
                .replace(/^manabitan-dictionary-media-v1\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.bin$/, 'manabitan-dictionary-media-v1/<generation>.bin'),
            bytes,
        })).sort((a, b) => a.path.localeCompare(b.path) || a.bytes - b.bytes),
    }
}

/**
 * @throws {Error} If a validated report omits a required comparison field.
 */
function analyze() {
    /** @type {Array<Observation & {run: Run, browserVersion: unknown}>} */
    const valid = []
    for (const observation of observations) {
        try {
            if (observation.exitCode !== 0) { throw new Error(`harness exited ${observation.exitCode}`) }
            const summary = /** @type {Summary} */ (parseJson(fs.readFileSync(path.join(evidence, observation.id, 'summary.json'), 'utf8')))
            const run = summary.runs[0]
            if (summary.runs.length !== 1 || summary.authoritativeTiming !== true || summary.traceEnabled !== false ||
            summary.gitSha !== observation.sourceSha || summary.mediaCheck !== observation.mediaCheck ||
            run.packageSha256 !== observation.packageSha256) { throw new Error('Run source/package/configuration identity differs') }
            if (!/^[a-f0-9]{64}$/.test(run.validation.outputDigestSha256)) { throw new Error('Missing output digest') }
            valid.push({...observation, run, browserVersion: summary.browserVersion})
        } catch (error) { failures.push({observation: observation.id, error: String(error)}) }
    }
    const first = valid[0]
    for (const observation of valid) {
        /** @type {Record<string, [unknown, unknown]>} */
        const checks = {
            browserVersion: [first.browserVersion, observation.browserVersion],
            outputDigest: [first.run.validation.outputDigestSha256, observation.run.validation.outputDigestSha256],
            storage: [storageSignature(first.run.validation.storage), storageSignature(observation.run.validation.storage)],
            lookup: /** @type {[unknown, unknown]} */ ([first, observation].map(({run}) => run.validation.lookup.observations.map(({pass, term, results, sha256}) => ({pass, term, results, sha256})))),
        }
        const sameMode = valid.find((entry) => entry.mediaCheck === observation.mediaCheck)
        if (typeof sameMode === 'undefined') { throw new Error('Missing media comparison arm') }
        checks.media = [sameMode.run.validation.media, observation.run.validation.media]
        for (const [check, [left, right]] of Object.entries(checks)) {
            if (!isDeepStrictEqual(left, right)) { failures.push({observation: observation.id, check, error: 'Cross-run equality failed'}) }
        }
    }
    const pairs = []
    for (let pair = 1; pair <= 6; ++pair) {
        const a = valid.find((entry) => entry.pair === pair && entry.arm === 'A')
        const b = valid.find((entry) => entry.pair === pair && entry.arm === 'B')
        if (a && b) {
            const baselineMs = a.run.totalImportMs
            const candidateMs = b.run.totalImportMs
            pairs.push({pair, order: pair % 2 ? 'AB' : 'BA', baselineMs, candidateMs, deltaMs: candidateMs - baselineMs, deltaPercent: 100 * (candidateMs / baselineMs - 1)})
        }
    }
    const complete = pairs.length === 6 && valid.length === observations.length
    const expectedCount = dictionary === 'jmdict' ? 12 : 14
    if (observations.length !== expectedCount) { failures.push({error: `Expected ${expectedCount} observations, got ${observations.length}`}) }
    const a = pairs.map((pair) => pair.baselineMs)
    const b = pairs.map((pair) => pair.candidateMs)
    const result = {
        dictionary,
        candidate: process.env.PERF_CANDIDATE_ID,
        baseline,
        candidateSha: candidate,
        validated: complete && failures.length === 0,
        timingEligible: complete && failures.length === 0,
        timingBoundary: 'Browser file-input change through visible import completion; fresh profile for each observation.',
        direction: 'Negative candidate-minus-baseline changes are faster. Six pairs are descriptive evidence, not a significance claim.',
        observations,
        pairs,
        timing: complete ? {baselineMedianMs: median(a), candidateMedianMs: median(b), medianDeltaPercent: 100 * (median(b) / median(a) - 1), medianPairedDeltaPercent: median(pairs.map((pair) => pair.deltaPercent))} : null,
        correctness: 'Strict receipts, restart, fixture counts, output digest, every lookup result digest, per-file OPFS sizes, sampled media on every ordinary run, separate exhaustive media on both arms for media dictionaries.',
        storageComparison: 'Exact logical paths and byte sizes, except SQLite SAH-pool opaque names and media-generation UUID basenames compared as separate per-directory size multisets. File counts and raw names are retained.',
        memory: 'No peak-memory measurement; allocation counts do not establish peak-memory savings.',
        failures,
    }
    writeJson(path.join(evidence, 'comparison.json'), result)
    if (!result.validated) { process.exitCode = 1 }
}

/**
 * @throws {Error} If source, package, or measurement identities differ.
 */
function qualify() {
    fs.mkdirSync(evidence, {recursive: true})
    if (![baseline, candidate, workflow].every((sha) => /^[a-f0-9]{40}$/.test(sha)) || !['jmdict', 'jitendex', 'vndb'].includes(dictionary)) { throw new Error('Immutable refs and a locked dictionary are required') }
    if (capture('git', ['rev-parse', 'HEAD']) !== baseline) { throw new Error('Baseline checkout differs') }
    capture('git', ['diff', '--exit-code', baseline, candidate, '--', 'package.json', 'package-lock.json', 'dev/perf', 'test/chromium', 'test/perf/dictionaries.lock.json'])
    fs.writeFileSync(path.join(evidence, 'executed-workflow.yml'), execFileSync('git', ['show', `${workflow}:.github/workflows/import-qualification-20261126.yml`], {cwd: root}))
    fs.copyFileSync(fileURLToPath(import.meta.url), path.join(evidence, 'qualify-imports-20261126.js'))
    checked(process.execPath, ['dev/perf/prepare-dictionaries.js', dictionary], root, path.join(evidence, 'prepare.log'))
    capture('git', ['worktree', 'add', '--detach', candidateRoot, candidate])
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(candidateRoot, 'node_modules'), 'dir')
    fs.mkdirSync(path.join(candidateRoot, 'builds'), {recursive: true})
    fs.symlinkSync(path.join(root, 'builds/e2e-dictionary-cache'), path.join(candidateRoot, 'builds/e2e-dictionary-cache'), 'dir')
    /** @type {Record<string, Record<string, string>>} */
    const members = {}
    for (const [name, arm] of Object.entries(arms)) {
        const log = path.join(evidence, `build-${name}.log`)
        if (name === 'B') {
            checked('npm', ['run', 'build:libs'], arm.root, log)
            checked('npm', ['run', 'license-report:html'], arm.root, log)
        }
        checked('npm', ['run', 'build', '--', '--target', 'chrome'], arm.root, log)
        const archive = path.join(arm.root, 'builds/manabitan-chrome.zip')
        arm.packageSha256 = hash(archive)
        arm.tree = capture('git', ['rev-parse', 'HEAD^{tree}'], arm.root)
        fs.copyFileSync(archive, path.join(evidence, `package-${name}.zip`))
        members[name] = packageMembers(archive, path.join(evidence, `package-members-${name}.json`))
        fs.writeFileSync(path.join(evidence, `build-status-${name}.txt`), capture('git', ['status', '--porcelain'], arm.root))
    }
    const changes = [...new Set([...Object.keys(members.A), ...Object.keys(members.B)])].filter((name) => members.A[name] !== members.B[name]).sort()
    writeJson(path.join(evidence, 'package-changes.json'), changes)
    if (!isDeepStrictEqual(changes, [...expectedChanges].sort())) { throw new Error(`Unexpected package member changes: ${changes.join(', ')}`) }
    for (const relative of ['dev/perf/benchmark-support.js', 'test/perf-experiment-receipts.test.js']) {
        overlay(relative)
        fs.copyFileSync(path.join(root, relative), path.join(evidence, path.basename(relative)))
    }
    checked(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'test/perf-experiment-receipts.test.js', 'test/perf-import-experiment-evidence.test.js'], root, path.join(evidence, 'receipt-tests.log'))
    const measuredFiles = ['package-lock.json', 'test/perf/dictionaries.lock.json', 'dev/perf/import-benchmark.js', 'dev/perf/benchmark-support.js', 'dev/perf/import-media-validation.js', 'test/chromium/extension-two-dictionary-import.e2e.js']
    const hashes = Object.fromEntries(measuredFiles.map((relative) => [relative, hash(path.join(root, relative))]))
    for (const relative of measuredFiles) {
        if (hash(path.join(candidateRoot, relative)) !== hashes[relative]) { throw new Error(`Measurement source differs: ${relative}`) }
    }
    const executable = chromium.executablePath()
    writeJson(path.join(evidence, 'provenance.json'), {
        workflowHead: workflow,
        workflowRun: process.env.GITHUB_RUN_ID,
        workflowAttempt: process.env.GITHUB_RUN_ATTEMPT,
        dictionary,
        candidateId: process.env.PERF_CANDIDATE_ID,
        arms,
        node: process.version,
        v8: process.versions.v8,
        playwright: /** @type {{version: string}} */ (parseJson(fs.readFileSync(path.join(root, 'node_modules/@playwright/test/package.json'), 'utf8'))).version,
        browserExecutable: executable,
        browserVersion: capture(executable, ['--version']),
        browserSha256: hash(executable),
        measurementHashes: hashes,
        measurementOverlay: {workflow, file: 'dev/perf/benchmark-support.js', productPackagesBuiltBeforeOverlay: true},
        schedule: 'AB BA AB BA AB BA, then separate exhaustive verification A B for Jitendex/VNDB.',
        rejectedPriorRun: '45860442522 remains diagnostic-only because its stale receipt checker rejected Jitendex; none of those timings enter this comparison.',
    })
    fs.copyFileSync(path.join(root, 'test/perf/dictionaries.lock.json'), path.join(evidence, 'dictionaries.lock.json'))
    for (let pair = 1; pair <= 6; ++pair) {
        for (const arm of pair % 2 ? ['A', 'B'] : ['B', 'A']) { observe(arm, `pair-${pair}-${arm}`, pair, 'sample') }
    }
    if (dictionary !== 'jmdict') {
        for (const arm of ['A', 'B']) { observe(arm, `exhaustive-${arm}`, null, 'all') }
    }
    analyze()
}

try { qualify() } catch (error) {
    writeJson(path.join(evidence, 'failure.json'), {error: String(error), stack: error instanceof Error ? error.stack : null, observations})
    console.error(error)
    process.exitCode = 1
}
