/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {spawnSync, execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import os from 'node:os'

const [baselineInput, captureInput, outputInput, order = 'AB'] = process.argv.slice(2)
assert(baselineInput && captureInput && outputInput, 'Usage: run.mjs <baselineRoot> <captureDir> <outputDir> <AB|BA>')
assert(order === 'AB' || order === 'BA')
const folder = dirname(fileURLToPath(import.meta.url))
const toolingRoot = resolve(folder, '../../..')
const baselineRoot = resolve(baselineInput)
const captureRoot = resolve(captureInput)
const outputRoot = resolve(outputInput)
const candidateRoot = join(outputRoot, 'source-candidate')
const manifestBytes = readFileSync(join(folder, 'manifest.json'))
const manifest = JSON.parse(manifestBytes)
const schedules = manifest[`schedules${order}`]
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const git = (root, args) => execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trim()
const write = (name, value) => writeFileSync(join(outputRoot, name), `${JSON.stringify(value, null, 2)}\n`)
mkdirSync(outputRoot, {recursive: true})

const command = (name, argv, cwd = candidateRoot) => {
    const startedAt = new Date().toISOString()
    const result = spawnSync(process.execPath, argv, {
        cwd,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        env: {...process.env, NODE_OPTIONS: ''},
    })
    writeFileSync(join(outputRoot, `${name}.stdout.log`), result.stdout ?? '')
    writeFileSync(join(outputRoot, `${name}.stderr.log`), result.stderr ?? '')
    const processReceipt = {startedAt, finishedAt: new Date().toISOString(), argv, cwd,
        status: result.status, signal: result.signal, error: result.error?.message ?? null}
    write(`${name}.process.json`, processReceipt)
    if (result.status !== 0) { throw new Error(`${name} failed; retained process and output logs`) }
}

const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

try {
    assert.equal(process.version, manifest.nodeVersion)
    assert.equal(git(baselineRoot, ['rev-parse', 'HEAD']), manifest.baselineCommit)
    assert.equal(sha(readFileSync(join(baselineRoot, manifest.sourceFile))), manifest.baselineSourceSha256)
    const captureBytes = readFileSync(join(captureRoot, 'report.json'))
    const capture = JSON.parse(captureBytes)
    assert.equal(capture.complete, true)
    assert.equal(capture.fixture.sha256, manifest.fixtureSha256)
    assert.equal(capture.encodedByteSha256, manifest.encodedByteSha256)
    assert.equal(capture.summary.rows, manifest.termRows)
    assert.equal(capture.summary.cacheRows, manifest.pendingRows)
    assert.equal(capture.summary.groups, manifest.groups)
    assert.equal(capture.databaseSourceSha256, manifest.baselineSourceSha256)
    const patchPath = join(folder, 'inflight.patch')
    assert.equal(sha(readFileSync(patchPath)), manifest.patchSha256)
    const protocol = {manifest, manifestSha256: sha(manifestBytes), order, schedules,
        scope: 'JMdict synchronous registration component only; virtual persisted offsets; no end-to-end import, browser, compression or OPFS claim',
        firstCorpus: 'Six balanced A/B/C permutations, each arm in a fresh Node process; A and C are identical baseline source',
        warm: 'Six balanced permutations after three warmups, sixteen corpus passes per observation; retain0 production topology, retain2 synthetic stress',
        measurementCommit: git(toolingRoot, ['rev-parse', 'HEAD']), captureReportSha256: sha(captureBytes),
        scripts: Object.fromEntries(['run.mjs', 'register-screen.mjs', 'capture.mjs'].map((name) => [name, sha(readFileSync(join(folder, name)))])),
        host: {node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch,
            cpuModel: os.cpus()[0]?.model, cpus: os.availableParallelism(), totalMemory: os.totalmem()},
        startedAt: new Date().toISOString()}
    writeFileSync(join(outputRoot, 'protocol.json'), `${JSON.stringify(protocol, null, 2)}\n`, {flag: 'wx'})

    git(baselineRoot, ['worktree', 'add', '--detach', candidateRoot, manifest.baselineCommit])
    git(candidateRoot, ['apply', '--check', patchPath])
    git(candidateRoot, ['apply', patchPath])
    assert.equal(sha(readFileSync(join(candidateRoot, manifest.sourceFile))), manifest.candidateSourceSha256)
    assert.deepEqual(git(candidateRoot, ['diff', '--name-only', 'HEAD']).split('\n'), [manifest.sourceFile])
    symlinkSync(join(baselineRoot, 'node_modules'), join(candidateRoot, 'node_modules'), 'dir')
    symlinkSync(join(baselineRoot, 'ext/lib'), join(candidateRoot, 'ext/lib'), 'dir')
    copyFileSync(join(toolingRoot, 'test/dictionary-content-inflight-range.test.js'), join(candidateRoot, 'test/dictionary-content-inflight-range.test.js'))
    command('focused-tests', [join(baselineRoot, 'node_modules/vitest/vitest.mjs'), 'run',
        'test/dictionary-content-inflight-range.test.js', 'test/dictionary-database-content-dedup.test.js',
        '--maxWorkers=1', '--no-file-parallelism'])
    command('focused-lint', [join(baselineRoot, 'node_modules/eslint/bin/eslint.js'), manifest.sourceFile,
        'test/dictionary-content-inflight-range.test.js'])

    const screen = join(folder, 'register-screen.mjs')
    const screenCommand = (name, mode) => command(name, ['--expose-gc', '--max-old-space-size=2048', screen,
        baselineRoot, candidateRoot, captureRoot, join(outputRoot, `${name}.json`), mode, order], toolingRoot)
    screenCommand('warm', 'warm')
    const warm = JSON.parse(readFileSync(join(outputRoot, 'warm.json')))
    assert.equal(warm.captureReportSha256, protocol.captureReportSha256)
    assert.equal(warm.baselineSourceSha256, manifest.baselineSourceSha256)
    assert.equal(warm.candidateSourceSha256, manifest.candidateSourceSha256)
    assert.equal(warm.repetitions, manifest.warmPassesPerObservation)
    assert.deepEqual(warm.schedules, schedules)
    const observations = []
    const failures = []
    for (let block = 0; block < schedules.length; ++block) {
        for (const arm of schedules[block]) {
            const name = `cold-${String(block).padStart(2, '0')}-${arm}`
            try {
                screenCommand(name, `cold-${arm}`)
                const result = JSON.parse(readFileSync(join(outputRoot, `${name}.json`)))
                assert.equal(result.captureReportSha256, protocol.captureReportSha256)
                assert.equal(result.baselineSourceSha256, manifest.baselineSourceSha256)
                assert.equal(result.candidateSourceSha256, manifest.candidateSourceSha256)
                assert.equal(result.outputDigestCheckedAfterTiming, warm.outputA)
                observations.push({block, arm, durationMs: result.durationMs, report: `${name}.json`})
                process.stdout.write(`${name}: ${result.durationMs.toFixed(3)}ms\n`)
            } catch (error) {
                failures.push({block, arm, error: String(error)})
            }
        }
    }
    const pairedPercent = []
    const controlPercent = []
    const differences = []
    for (let block = 0; block < schedules.length; ++block) {
        const cell = Object.fromEntries(observations.filter((entry) => entry.block === block).map((entry) => [entry.arm, entry.durationMs]))
        if (!['A', 'B', 'C'].every((arm) => typeof cell[arm] === 'number')) { continue }
        pairedPercent.push(100 * (cell.B / cell.A - 1))
        controlPercent.push(100 * (cell.C / cell.A - 1))
        differences.push(cell.B - cell.A)
    }
    const cold = pairedPercent.length === schedules.length ? {
        pairs: pairedPercent.length, pairedMedianPercent: median(pairedPercent),
        sameCodeControlPercent: median(controlPercent), pairedMedianMs: median(differences),
        fasterPairs: differences.filter((value) => value < 0).length, pairedPercent, controlPercent,
    } : null
    const summary = {complete: failures.length === 0, scope: protocol.scope, order,
        manifestSha256: protocol.manifestSha256, captureReportSha256: protocol.captureReportSha256,
        warm: warm.summary, cold, observations, failures, finishedAt: new Date().toISOString()}
    write('summary.json', summary)
    process.stdout.write(`${JSON.stringify({warm: warm.summary, cold, failures}, null, 2)}\n`)
    assert.equal(failures.length, 0, 'Cold cohort retained failures; inspect summary and process logs')
} catch (error) {
    write('failure.json', {error: String(error), stack: error?.stack, timestamp: new Date().toISOString()})
    throw error
}
