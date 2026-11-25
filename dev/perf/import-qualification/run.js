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
import {execFileSync, spawn} from 'node:child_process'
import {closeSync, createReadStream, openSync} from 'node:fs'
import {copyFile, mkdir, mkdtemp, readFile, rename, symlink, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {chromium} from '@playwright/test'
import {parseJson} from '../../../ext/js/core/json.js'
import {createBenchmarkEnvironment, extractImportResult} from '../benchmark-support.js'
import {loadDictionaryFixtures} from '../dictionary-fixtures.js'
import {getHostEnvironment} from '../host-environment.js'
import {analyze, baselineSha, baselineTree, candidates, createSchedule, dictionaries, validationFingerprint} from './analysis.js'

/** @typedef {{code: number|null, signal: string|null, timedOut: boolean}} CommandResult */
/** @typedef {{gitSha: string, treeSha: string, trackedStatus: string, harness: Record<string, string>, packageSha256: string, license: {committedSha256: string, overlaySha256: string}}} Identity */
/** @typedef {import('./analysis.js').Observation & {index: number, directory?: string, startedAt?: string, endedAt?: string, hostLoadBefore?: number[], hostLoadAfter?: number[], exit?: CommandResult, validationFingerprint?: string, restartProbeDigestSha256?: unknown, packageSha256?: string, browserVersion?: unknown}} RecordedObservation */

const root = fileURLToPath(new URL('../../../', import.meta.url))
const harnessFiles = [
    'package.json',
    'package-lock.json',
    'dev/data/legal-npm.css',
    'test/perf/dictionaries.lock.json',
    'dev/perf/import-benchmark.js',
    'dev/perf/benchmark-support.js',
    'dev/perf/dictionary-fixtures.js',
    'dev/perf/import-media-validation.js',
    'dev/perf/host-environment.js',
    'test/firefox/data/wagahai-neko.html',
    ...execFileSync('git', ['ls-files', '-z', '--', 'test/chromium', 'test/e2e'], {cwd: root, encoding: 'utf8'}).split('\0').filter(Boolean),
]

/**
 * @param {string} file
 * @returns {Promise<string>}
 */
async function hashFile(file) {
    const hash = createHash('sha256')
    for await (const bytes of createReadStream(file)) {
        assert(bytes instanceof Uint8Array, 'Expected binary file chunks')
        hash.update(bytes)
    }
    return hash.digest('hex')
}

/**
 * @param {string} directory
 * @param {string[]} args
 * @returns {string}
 */
function git(directory, args) { return execFileSync('git', args, {cwd: directory, encoding: 'utf8'}).trim() }

/**
 * @param {string} directory
 * @returns {Promise<Identity>}
 */
async function identity(directory) {
    const trackedStatus = git(directory, ['status', '--porcelain', '--untracked-files=no'])
    const changed = git(directory, ['diff', '--name-only', 'HEAD']).split('\n').filter(Boolean)
    assert(changed.every((file) => file === 'ext/legal-npm.html'), 'Product source changed outside the shared generated license overlay')
    /** @type {Record<string, string>} */
    const harness = {}
    for (const file of harnessFiles) { harness[file] = await hashFile(path.join(directory, file)) }
    return {
        gitSha: git(directory, ['rev-parse', 'HEAD']),
        treeSha: git(directory, ['rev-parse', 'HEAD^{tree}']),
        trackedStatus,
        harness,
        packageSha256: await hashFile(path.join(directory, 'builds/manabitan-chrome.zip')),
        license: {
            committedSha256: createHash('sha256').update(execFileSync('git', ['show', 'HEAD:ext/legal-npm.html'], {cwd: directory})).digest('hex'),
            overlaySha256: await hashFile(path.join(directory, 'ext/legal-npm.html')),
        },
    }
}

/**
 * A deadline terminates the wrapper process group. Playwright detaches Chromium;
 * the ephemeral CI job also owns its teardown. A timeout stops the campaign,
 * so a lingering browser cannot contaminate later accepted observations.
 * Logs go straight to disk and survive failures without a buffered output cap.
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @param {string} log
 * @param {number} timeoutMs
 * @returns {Promise<CommandResult>}
 */
async function runLogged(command, args, cwd, log, timeoutMs) {
    assert(timeoutMs > 0, 'Qualification deadline reached')
    const fd = openSync(log, 'wx')
    try {
        return await new Promise((resolve, reject) => {
            const child = spawn(command, args, {cwd, env: createBenchmarkEnvironment(process.env, {}), stdio: ['ignore', fd, fd], detached: true})
            let timedOut = false
            /** @type {ReturnType<typeof setTimeout>|undefined} */
            let killTimer
            const terminate = (/** @type {'SIGTERM'|'SIGKILL'} */ signal) => {
                if (typeof child.pid === 'number') {
                    try { process.kill(-child.pid, signal) } catch { /* The process group already exited. */ }
                }
            }
            const timer = setTimeout(() => {
                timedOut = true
                terminate('SIGTERM')
                killTimer = setTimeout(() => terminate('SIGKILL'), 2000)
            }, timeoutMs)
            child.once('error', reject)
            child.once('close', (code, signal) => {
                clearTimeout(timer)
                clearTimeout(killTimer)
                if (timedOut) { terminate('SIGKILL') }
                resolve({code, signal, timedOut})
            })
        })
    } finally { closeSync(fd) }
}

/** @returns {Promise<void>} */
async function main() {
    const [action, candidateId, dictionary] = process.argv.slice(2)
    assert(action === 'plan' || action === 'run', 'Expected plan or run')
    assert(Object.hasOwn(candidates, candidateId), 'Unknown fixed candidate')
    assert(dictionaries.includes(dictionary), 'Unknown fixed dictionary')
    const candidate = candidates[/** @type {keyof typeof candidates} */ (candidateId)]
    const schedule = createSchedule()
    const plan = {baselineSha, baselineTree, candidateId, candidate, dictionary, target: candidate.target === dictionary, schedule}
    if (action === 'plan') {
        console.log(JSON.stringify(plan, null, 2))
        return
    }
    assert.equal(process.version, 'v22.22.0', 'Use the pinned Node runtime')
    assert.equal(process.platform, 'linux', 'Hosted qualification requires Linux process groups')
    const protocol = {gitSha: git(root, ['rev-parse', 'HEAD']), treeSha: git(root, ['rev-parse', 'HEAD^{tree}'])}
    assert.equal(protocol.gitSha, process.env.QUALIFICATION_PROTOCOL_SHA, 'Unexpected qualification protocol source')

    const output = path.join(root, 'builds/perf/import-qualification', `${candidateId}-${dictionary}`)
    await mkdir(output, {recursive: true})
    const receipt = path.join(output, 'screen.json')
    const deadline = Date.now() + 24 * 60 * 1000
    const fixtures = await loadDictionaryFixtures()
    const fixture = fixtures[dictionary]
    const browserPath = chromium.executablePath()
    const browserRegistry = /** @type {{browsers: Array<{name: string, browserVersion?: string}>}} */ (parseJson(await readFile(path.join(root, 'node_modules/playwright-core/browsers.json'), 'utf8')))
    const browserVersion = browserRegistry.browsers.find((entry) => entry.name === 'chromium')?.browserVersion
    assert(typeof browserVersion === 'string', 'Missing lockfile-installed browser version')
    const browser = {path: browserPath, sha256: await hashFile(browserPath), expectedVersion: browserVersion}
    /** @type {{status: string, plan: object, protocol: {gitSha: string, treeSha: string}, browser: {path: string, sha256: string, expectedVersion: string}, node: string, host: ReturnType<typeof getHostEnvironment>, startedAt: string, endedAt?: string, fixture: import('../dictionary-fixtures.js').DictionaryFixture, fixtureHashes: Record<string, string>, identities: Record<string, Identity>, preparation: Array<{label: string, result: CommandResult}>, observations: RecordedObservation[], analysis?: object, error?: string, cleanupLimit: string}} */
    const state = {
        status: 'preparing',
        plan,
        protocol,
        browser,
        node: process.version,
        host: getHostEnvironment(),
        startedAt: new Date().toISOString(),
        cleanupLimit: 'Timeout terminates the wrapper group and stops all later observations. Detached Chromium teardown may require the ephemeral CI job cleanup.',
        fixture,
        fixtureHashes: {},
        identities: {},
        preparation: [],
        observations: schedule.map((entry, index) => ({...entry, index, status: 'unacquired'})),
    }
    // A campaign never overwrites an earlier result or resumes a partial sample.
    await writeFile(receipt, JSON.stringify(state, null, 2) + '\n', {flag: 'wx'})
    const save = async () => {
        await writeFile(receipt + '.tmp', JSON.stringify(state, null, 2) + '\n')
        await rename(receipt + '.tmp', receipt)
    }
    try {
        const workspace = await mkdtemp(path.join(os.tmpdir(), 'manabitan-import-qualification-'))
        const sources = {A: path.join(workspace, 'baseline'), B: path.join(workspace, 'candidate')}
        const cache = path.join(root, 'builds/e2e-dictionary-cache')
        for (const id of new Set(['jmdict', 'jmnedict', 'jitendex', dictionary])) {
            const actual = await hashFile(path.join(cache, fixtures[id].cacheFile))
            assert.equal(actual, fixtures[id].sha256, `Pinned fixture changed: ${id}`)
            state.fixtureHashes[id] = actual
        }
        for (const [arm, sha, tree] of [['A', baselineSha, baselineTree], ['B', candidate.sha, candidate.tree]]) {
            const directory = sources[/** @type {'A'|'B'} */ (arm)]
            git(root, ['worktree', 'add', '--detach', directory, sha])
            assert.equal(git(directory, ['rev-parse', 'HEAD']), sha, 'Unexpected checkout source')
            assert.equal(git(directory, ['rev-parse', 'HEAD^{tree}']), tree, 'Unexpected checkout tree')
            for (const file of harnessFiles) {
                assert.equal(await hashFile(path.join(directory, file)), await hashFile(path.join(root, file)), `Harness/dependency/fixture mismatch: ${file}`)
            }
            await symlink(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'dir')
            await mkdir(path.join(directory, 'builds'), {recursive: true})
            await symlink(cache, path.join(directory, 'builds/e2e-dictionary-cache'), 'dir')
            await copyFile(path.join(root, 'ext/legal-npm.html'), path.join(directory, 'ext/legal-npm.html'))
            /** @type {Array<[string, string, string[]]>} */
            const buildSteps = [
                ['libs', 'dev/bin/build-libs.js', []],
                ['chrome', 'dev/bin/build.js', ['--target', 'chrome']],
            ]
            for (const [label, script, args] of buildSteps) {
                const result = await runLogged(process.execPath, [script, ...args], directory, path.join(output, `${arm}-${String(label)}.log`), Math.min(5 * 60 * 1000, deadline - Date.now()))
                state.preparation.push({label: `${arm}-${String(label)}`, result})
                await save()
                assert.deepEqual(result, {code: 0, signal: null, timedOut: false}, `Build failed: ${arm}-${String(label)}`)
            }
            state.identities[arm] = await identity(directory)
            const packaged = path.join(output, `${arm}-manabitan-chrome.zip`)
            await copyFile(path.join(directory, 'builds/manabitan-chrome.zip'), packaged)
            assert.equal(await hashFile(packaged), state.identities[arm].packageSha256, 'Preserved package hash mismatch')
        }
        state.identities.C = state.identities.A
        assert.deepEqual(state.identities.A.harness, state.identities.B.harness, 'Shared harness changed')
        assert.equal(state.identities.A.license.overlaySha256, state.identities.B.license.overlaySha256, 'Shared generated license differs')
        state.status = 'running'
        await save()
        /** @type {Map<'sample'|'all', string>} */
        const fingerprints = new Map()
        for (const [index, entry] of schedule.entries()) {
            const directory = path.join(output, `${String(index).padStart(2, '0')}-${entry.phase}-${entry.arm}`)
            const source = entry.arm === 'B' ? sources.B : sources.A
            assert.deepEqual(await identity(source), state.identities[entry.arm], 'Source/package changed during campaign')
            await mkdir(directory)
            /** @type {RecordedObservation} */
            const observation = {index, ...entry, directory, status: 'running', startedAt: new Date().toISOString(), hostLoadBefore: os.loadavg()}
            state.observations[index] = observation
            await save()
            console.log(`Starting ${candidateId}/${dictionary}: ${index + 1}/${schedule.length} ${entry.phase} ${entry.arm}`)
            observation.exit = await runLogged(process.execPath, [
                'dev/perf/import-benchmark.js',
                dictionary,
                '--runs',
                '1',
                '--no-build',
                '--build-target',
                'chrome',
                '--media-check',
                entry.mediaCheck,
                '--output',
                directory,
            ], source, path.join(directory, 'command.log'), Math.min(5 * 60 * 1000, deadline - Date.now()))
            observation.endedAt = new Date().toISOString()
            observation.hostLoadAfter = os.loadavg()
            assert.deepEqual(observation.exit, {code: 0, signal: null, timedOut: false}, `Observation failed: ${index}`)
            const report = /** @type {Record<string, unknown>} */ (parseJson(await readFile(path.join(directory, 'run-1.json'), 'utf8')))
            assert.equal(report.buildTarget, 'chrome', 'Unexpected package target')
            assert.equal(report.packageSha256, state.identities[entry.arm].packageSha256, 'Unexpected observed package')
            assert.equal(report.browserVersion, browser.expectedVersion, 'Unexpected observed browser')
            const result = extractImportResult(report, dictionary, fixture, false, null, entry.mediaCheck)
            observation.totalImportMs = result.totalImportMs
            observation.workerImportMs = result.workerImportMs
            observation.storageBytes = /** @type {{bytes: number}} */ (result.validation.storage).bytes
            observation.packageSha256 = /** @type {string} */ (report.packageSha256)
            observation.browserVersion = report.browserVersion
            observation.validationFingerprint = validationFingerprint(result.validation)
            observation.restartProbeDigestSha256 = result.validation.outputDigestSha256
            const previous = fingerprints.get(entry.mediaCheck)
            if (typeof previous === 'string') { assert.equal(observation.validationFingerprint, previous, 'Persisted media/content/lookup probe mismatch') }
            fingerprints.set(entry.mediaCheck, observation.validationFingerprint)
            observation.status = 'success'
            await save()
        }
        state.analysis = analyze(state.observations)
        state.status = 'complete'
    } catch (error) {
        state.status = 'failed'
        state.error = error instanceof Error ? error.stack : String(error)
        const current = state.observations.find((row) => row.status === 'running')
        if (current?.status === 'running') { current.status = 'failed' }
        process.exitCode = 1
    } finally {
        state.endedAt = new Date().toISOString()
        await save()
        console.log(JSON.stringify({status: state.status, analysis: state.analysis, error: state.error}))
        if (process.env.GITHUB_STEP_SUMMARY) {
            await writeFile(process.env.GITHUB_STEP_SUMMARY, `### ${candidateId} / ${dictionary} (${plan.target ? 'target' : 'non-target'})\n\nStatus: ${state.status}. All observations and raw browser reports are in the artifact.\n\n\`\`\`json\n${JSON.stringify(state.analysis ?? {error: state.error, completed: state.observations.filter((row) => row.status === 'success').length}, null, 2)}\n\`\`\`\n`, {flag: 'a'})
        }
    }
}

await main()
