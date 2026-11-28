/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {mkdir, readFile, writeFile, symlink, stat} from 'node:fs/promises'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import os from 'node:os'

const [baselineArgument, captureArgument, outputArgument, initialOrder = 'AB', existingCandidateArgument] = process.argv.slice(2)
assert(baselineArgument && captureArgument && outputArgument, 'Usage: run.mjs <baselineRoot> <captureDir> <outputDir> <AB|BA> [existingCandidateRoot]')
assert(initialOrder === 'AB' || initialOrder === 'BA')
const baselineRoot = resolve(baselineArgument)
const captureRoot = resolve(captureArgument)
const outputRoot = resolve(outputArgument)
const directory = dirname(fileURLToPath(import.meta.url))
const childPath = join(directory, 'child.mjs')
const patchPath = join(directory, 'candidate.patch')
const candidateRoot = existingCandidateArgument ? resolve(existingCandidateArgument) : join(outputRoot, 'candidate-source')
const identity = JSON.parse(await readFile(join(directory, 'candidate.json'), 'utf8'))
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const patch = await readFile(patchPath)
assert.equal(hash(patch), identity.patchSha256)
const databaseRelativePath = 'ext/js/dictionary/dictionary-database.js'
assert.equal(hash(await readFile(join(baselineRoot, databaseRelativePath))), identity.baselineSourceSha256)
assert.equal(hash(await readFile(join(baselineRoot, identity.testPath))), identity.baselineTestSha256)
const capture = JSON.parse(await readFile(join(captureRoot, 'report.json'), 'utf8'))
assert.equal(capture.complete, true)
assert.equal(capture.databaseSourceSha256, identity.baselineSourceSha256)
await mkdir(outputRoot, {recursive: true})

function command(program, args, options = {}) {
    const result = spawnSync(program, args, {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options})
    if (result.status !== 0) {
        throw new Error(`${program} ${args.join(' ')} failed (${result.status ?? result.signal}): ${result.stdout ?? ''}\n${result.stderr ?? ''}`)
    }
    return result.stdout.trim()
}

assert.equal(command('git', ['-C', baselineRoot, 'rev-parse', 'HEAD']), identity.baselineCommit)
if (existingCandidateArgument) {
    assert.equal(command('git', ['-C', candidateRoot, 'rev-parse', 'HEAD']), identity.baselineCommit)
} else {
    command('git', ['-C', baselineRoot, 'worktree', 'add', '--detach', candidateRoot, identity.baselineCommit])
    command('git', ['-C', candidateRoot, 'apply', '--check', patchPath])
    command('git', ['-C', candidateRoot, 'apply', patchPath])
}
assert.deepEqual(command('git', ['-C', candidateRoot, 'diff', '--name-only']).split('\n').sort(), [...identity.changedPaths].sort())
assert.equal(hash(await readFile(join(candidateRoot, databaseRelativePath))), identity.candidateSourceSha256)
assert.equal(hash(await readFile(join(candidateRoot, identity.testPath))), identity.candidateTestSha256)
for (const name of existingCandidateArgument ? [] : ['node_modules', 'ext/lib']) {
    const destination = join(candidateRoot, name)
    // Refuse to replace an existing file or generated tree.
    assert.equal(await stat(destination).then(() => true, (error) => { if (error.code !== 'ENOENT') { throw error }; return false }), false)
    await symlink(join(baselineRoot, name), destination, 'dir')
}
const baseSchedule = ['ABC', 'ACB', 'BAC', 'BCA', 'CAB', 'CBA']
const schedule = initialOrder === 'AB' ? baseSchedule : baseSchedule.map((order) => [...order].map((arm) => arm === 'A' ? 'B' : arm === 'B' ? 'A' : arm).join(''))
const protocol = {
    baselineCommit: identity.baselineCommit,
    identity,
    initialOrder,
    schedule,
    node: process.version,
    v8: process.versions.v8,
    sourceRoots: {baseline: baselineRoot, candidate: candidateRoot},
    fixtureSha256: capture.fixture.sha256,
    fixtureLockSha256: capture.lockSha256,
    captureReportSha256: hash(await readFile(join(captureRoot, 'report.json'))),
    runnerSha256: hash(await readFile(fileURLToPath(import.meta.url))),
    childSha256: hash(await readFile(childPath)),
    fixedProtocol: 'Cold: six A/B/C permutation blocks, one fresh child process per arm, zero warmups and one 12-group corpus pass. Warm: separate six permutation blocks, fresh child per arm, four excluded corpus passes then ten measured corpus passes. A/C byte-identical baseline; B sole cache-loop-extraction patch. All observations retained; no control subtraction or reruns. First-import component screen, not browser performance qualification.',
    hostBefore: {load: os.loadavg(), cpus: os.availableParallelism(), cpuModel: os.cpus()[0]?.model, totalMemory: os.totalmem(), freeMemory: os.freemem()},
}
await writeFile(join(outputRoot, 'protocol.json'), JSON.stringify(protocol, null, 2) + '\n', {flag: 'wx'})
const observations = []
let expectedDigest = null
let complete = false
let failure = null
const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b)
    return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2
}
try {
    for (const mode of ['cold', 'warm']) {
        for (let block = 0; block < schedule.length; ++block) {
            const order = schedule[block]
            for (const arm of order) {
                const name = `${mode}-${String(block + 1).padStart(2, '0')}-${arm}`
                const resultPath = join(outputRoot, `${name}.json`)
                const root = arm === 'B' ? candidateRoot : baselineRoot
                const result = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=512', childPath, root, captureRoot, resultPath, mode], {
                    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60_000,
                    env: {...process.env},
                })
                const commandReceipt = {program: process.execPath, arguments: ['--expose-gc', '--max-old-space-size=512', childPath, root, captureRoot, resultPath, mode], status: result.status, signal: result.signal, error: result.error?.message ?? null}
                await writeFile(join(outputRoot, `${name}.command.json`), JSON.stringify(commandReceipt, null, 2) + '\n', {flag: 'wx'})
                await writeFile(join(outputRoot, `${name}.log`), (result.stdout ?? '') + (result.stderr ?? ''), {flag: 'wx'})
                if (result.status !== 0) { throw new Error(`${name} failed (${result.status ?? result.signal})`) }
                const observation = JSON.parse(await readFile(resultPath, 'utf8'))
                assert.equal(observation.complete, true)
                assert.equal(observation.sourceSha256, arm === 'B' ? identity.candidateSourceSha256 : identity.baselineSourceSha256)
                assert.equal(observation.callsPerCorpus, 12)
                assert.equal(observation.warmups.length, mode === 'cold' ? 0 : 4)
                assert.equal(observation.observations.length, mode === 'cold' ? 1 : 10)
                if (expectedDigest === null) { expectedDigest = observation.outputDigest }
                assert.equal(observation.outputDigest, expectedDigest)
                observations.push({mode, block, order, arm, resultFile: `${name}.json`, meanMs: observation.meanMs, meanPublicationMs: observation.meanPublicationMs, meanCacheMs: observation.meanCacheMs, outputDigest: observation.outputDigest})
                await writeFile(join(outputRoot, 'observations.json'), JSON.stringify(observations, null, 2) + '\n')
                console.log(JSON.stringify(observations.at(-1)))
            }
        }
    }
    assert.equal(hash(await readFile(join(baselineRoot, databaseRelativePath))), identity.baselineSourceSha256)
    assert.equal(hash(await readFile(join(candidateRoot, databaseRelativePath))), identity.candidateSourceSha256)
    assert.equal(hash(await readFile(join(candidateRoot, identity.testPath))), identity.candidateTestSha256)
    assert.equal(hash(await readFile(childPath)), protocol.childSha256)
    assert.equal(hash(await readFile(fileURLToPath(import.meta.url))), protocol.runnerSha256)
    complete = true
} catch (error) {
    failure = error.stack ?? String(error)
    throw error
} finally {
    const comparisons = {}
    for (const mode of ['cold', 'warm']) {
        comparisons[mode] = {}
        for (const [left, right] of [['B', 'A'], ['B', 'C'], ['C', 'A']]) {
            const pairs = []
            for (let block = 0; block < schedule.length; ++block) {
                const a = observations.find((value) => value.mode === mode && value.block === block && value.arm === left)
                const b = observations.find((value) => value.mode === mode && value.block === block && value.arm === right)
                if (!a || !b) { continue }
                pairs.push({block, percent: (a.meanMs / b.meanMs - 1) * 100, ms: a.meanMs - b.meanMs, cachePercent: (a.meanCacheMs / b.meanCacheMs - 1) * 100, cacheMs: a.meanCacheMs - b.meanCacheMs})
            }
            comparisons[mode][`${left}/${right}`] = {
                pairs,
                medianPercent: pairs.length ? median(pairs.map((pair) => pair.percent)) : null,
                medianMs: pairs.length ? median(pairs.map((pair) => pair.ms)) : null,
                medianCachePercent: pairs.length ? median(pairs.map((pair) => pair.cachePercent)) : null,
                medianCacheMs: pairs.length ? median(pairs.map((pair) => pair.cacheMs)) : null,
                faster: pairs.filter((pair) => pair.percent < 0).length,
            }
        }
    }
    const result = {complete, failure, protocol, expectedDigest, observations, comparisons, hostAfter: {load: os.loadavg(), freeMemory: os.freemem()}}
    await writeFile(join(outputRoot, 'result.json'), JSON.stringify(result, null, 2) + '\n', {flag: 'wx'})
    console.log(JSON.stringify({complete, failure, comparisons}))
}
