#!/usr/bin/env node
/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {execFile, execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {parseArgs, promisify} from 'node:util'

const ownRoot = fileURLToPath(new URL('../../../', import.meta.url))
const {values} = parseArgs({options: {
    'baseline-root': {type: 'string'},
    'candidate-root': {type: 'string', default: ownRoot},
    'cache-dir': {type: 'string', default: path.join(ownRoot, 'builds/e2e-dictionary-cache')},
    'out': {type: 'string', default: path.join(ownRoot, 'builds/perf/direct-media-entries-20261123')},
    'oracle-only': {type: 'boolean', default: false},
}})
assert(values['baseline-root'], 'Provide --baseline-root')
const output = path.resolve(values.out)
await mkdir(output, {recursive: true})
const roots = {A: path.resolve(values['baseline-root']), B: path.resolve(values['candidate-root'])}
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const streamDigest = async (stream) => {
    const digest = createHash('sha256')
    let bytes = 0
    for await (const chunk of stream) {
        digest.update(chunk)
        bytes += chunk.length
    }
    return {sha256: digest.digest('hex'), bytes}
}
const files = [
    'ext/js/dictionary/source-zip-media-preparation-worker.js',
    'ext/js/dictionary/source-zip-media-pack.js',
    'ext/js/dictionary/dense-zip-directory.js',
    'ext/js/dictionary/dictionary-generation-media-store.js',
    'ext/js/dictionary/term-bank-source-pipeline.js',
    'ext/js/dictionary/term-bank-wasm-parser.js',
    'ext/js/media/media-util.js',
    'ext/lib/term-bank-parser.wasm',
]
const sources = async (root) => Object.fromEntries(await Promise.all(files.map(async (file) => [file, sha256(await readFile(path.join(root, file)))])))
const fixtureLock = await readFile(path.join(ownRoot, 'test/perf/dictionaries.lock.json'))
const fixture = JSON.parse(fixtureLock).dictionaries.vndb
const archive = path.join(values['cache-dir'], fixture.cacheFile)
const fixtureIdentity = await streamDigest(createReadStream(archive))
assert.equal(fixtureIdentity.bytes, fixture.sizeBytes)
assert.equal(fixtureIdentity.sha256, fixture.sha256)
const host = () => ({at: new Date().toISOString(), load: os.loadavg(), freeMemory: os.freemem()})
const report = {
    schema: 1,
    complete: false,
    boundary: 'Actual production media-preparation worker handler through posted packed Blob/index; includes dense ZIP reads, entry selection, planning, all payload reads and CRC checks, and index creation. Worker startup, module imports, WASM compilation, file opening and oracle hashing are outside timing. Each invocation uses a fresh Node process running the unchanged worker handler; no Blob crosses a Node worker lifetime. No browser import or peak-memory claim.',
    node: process.version,
    v8: process.versions.v8,
    cpuModel: os.cpus()[0]?.model,
    sourceIdentity: {},
    runnerSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    workerShimSha256: sha256(await readFile(new URL('worker.mjs', import.meta.url))),
    fixture: {...fixture, lockSha256: sha256(fixtureLock)},
    protocol: {warmups: 'AB', measured: 'ABBAABBA'},
    hostBefore: host(),
    oracle: [],
    observations: [],
}
const save = () => writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n')
const execute = promisify(execFile)
const run = async (arm, phase, label) => {
    const prefix = path.join(output, label)
    try {
        const {stdout, stderr} = await execute(process.execPath, [fileURLToPath(new URL('worker.mjs', import.meta.url)), roots[arm], archive, prefix, phase, arm], {maxBuffer: 1024 * 1024, timeout: 120000})
        await writeFile(`${prefix}-stderr.log`, stderr)
        await writeFile(`${prefix}-result.json`, stdout)
        return JSON.parse(stdout)
    } catch (error) {
        await writeFile(`${prefix}-failure.json`, JSON.stringify({message: String(error), signal: error.signal, code: error.code, stdout: error.stdout, stderr: error.stderr}, null, 2) + '\n')
        throw error
    }
}

try {
    for (const [arm, root] of Object.entries(roots)) {
        report.sourceIdentity[arm] = {root, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(), files: await sources(root)}
    }
    assert.equal(report.sourceIdentity.A.files['ext/lib/term-bank-parser.wasm'], report.sourceIdentity.B.files['ext/lib/term-bank-parser.wasm'])
    await save()
    let reference
    for (const arm of 'AB') {
        const {identity, metrics, measurement} = await run(arm, 'oracle', arm)
        assert.equal(identity.descriptor.count, fixture.mediaFiles)
        assert.equal(metrics.uncompressedBytes, fixture.mediaBytes)
        if (reference) {
            assert.deepEqual(identity, reference)
        } else {
            reference = identity
        }
        report.oracle.push({arm, ...identity, metrics, measurement})
        await save()
    }
    await writeFile(path.join(output, 'oracle-input.json'), JSON.stringify({fixture, ...reference}, null, 2) + '\n')
    if (!values['oracle-only']) {
        for (const [stage, sequence] of [['warmup', report.protocol.warmups], ['timed', report.protocol.measured]]) {
            for (const [index, arm] of [...sequence].entries()) {
                const hostBefore = host()
                const {identity, metrics, measurement} = await run(arm, stage, `${stage}-${index}-${arm}`)
                assert.deepEqual(identity.descriptor, reference.descriptor)
                assert.equal(identity.indexSha256, reference.indexSha256)
                assert.equal(identity.blobBytes, reference.blobIdentity.bytes)
                assert.equal(metrics.uncompressedBytes, fixture.mediaBytes)
                const observation = {stage, pair: Math.floor(index / 2), arm, ...measurement, cpuMs: measurement.cpuUserMs + measurement.cpuSystemMs, ...identity, metrics, hostBefore, hostAfter: host()}
                report.observations.push(observation)
                await save()
                console.log(JSON.stringify(observation))
            }
        }
        const median = (numbers) => {
            const sorted = [...numbers].sort((a, b) => a - b)
            return (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2
        }
        report.comparisons = {}
        for (const metric of ['elapsedMs', 'cpuMs']) {
            const pairs = Array.from({length: 4}, (_, pair) => {
                const get = (arm) => report.observations.find((x) => x.stage === 'timed' && x.pair === pair && x.arm === arm)[metric]
                const A = get('A')
                const B = get('B')
                return {pair, A, B, ratio: B / A}
            })
            report.comparisons[metric] = {pairs, medianPairedPercent: (median(pairs.map((x) => x.ratio)) - 1) * 100, equalWorkPercent: (pairs.reduce((sum, x) => sum + x.B, 0) / pairs.reduce((sum, x) => sum + x.A, 0) - 1) * 100}
        }
    }
    for (const [arm, root] of Object.entries(roots)) { assert.deepEqual(await sources(root), report.sourceIdentity[arm].files) }
    assert.equal(sha256(await readFile(fileURLToPath(import.meta.url))), report.runnerSha256)
    assert.equal(sha256(await readFile(new URL('worker.mjs', import.meta.url))), report.workerShimSha256)
    report.complete = true
    report.hostAfter = host()
    await save()
    console.log(JSON.stringify({complete: true, oracle: reference, comparisons: report.comparisons}, null, 2))
} catch (error) {
    report.error = {message: String(error), stack: error?.stack}
    report.hostAfter = host()
    await save()
    throw error
}
