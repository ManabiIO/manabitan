#!/usr/bin/env node
/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
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
    out: {type: 'string', default: path.join(ownRoot, 'builds/perf/dense-zip-catalog-20261125')},
}})
assert(values['baseline-root'], 'Provide --baseline-root')
const roots = {A: path.resolve(values['baseline-root']), B: path.resolve(values['candidate-root']), C: path.resolve(values['baseline-root'])}
const out = path.resolve(values.out)
await mkdir(out, {recursive: true})
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const lockBytes = await readFile(path.join(ownRoot, 'test/perf/dictionaries.lock.json'))
const fixture = JSON.parse(lockBytes).dictionaries.vndb
const archive = path.join(values['cache-dir'], fixture.cacheFile)
let archiveBytes = 0
const archiveHash = createHash('sha256')
for await (const chunk of createReadStream(archive)) {
    archiveBytes += chunk.length
    archiveHash.update(chunk)
}
assert.equal(archiveBytes, fixture.sizeBytes)
assert.equal(archiveHash.digest('hex'), fixture.sha256)
const sourceFiles = [
    'ext/js/dictionary/dense-zip-directory.js',
    'ext/js/dictionary/dense-zip-file-map.js',
    'ext/js/dictionary/dictionary-importer.js',
    'types/ext/dictionary-importer.d.ts',
    'package-lock.json',
]
const sources = async (root) => Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => {
    try { return [file, sha256(await readFile(path.join(root, file)))] } catch (error) {
        if (error.code === 'ENOENT') { return [file, null] }
        throw error
    }
})))
const report = {
    complete: false,
    boundary: 'Production importer dense ZIP directory setup and bank classification, with a fresh Node process per arm. Retained process heap/ArrayBuffer deltas after explicit GC are component memory, not browser peak memory. Complete-import latency, OPFS work and image payload validation are outside this screen. A/C are identical source controls.',
    node: process.version,
    v8: process.versions.v8,
    cpu: os.cpus()[0]?.model,
    fixture,
    fixtureLockSha256: sha256(lockBytes),
    workerSha256: sha256(await readFile(new URL('worker.mjs', import.meta.url))),
    runnerSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    sources: {},
    protocol: {warmups: 'ABC', measured: ['ABC', 'BCA', 'CAB', 'CBA', 'ACB', 'BAC']},
    observations: [],
}
for (const [arm, root] of Object.entries(roots)) { report.sources[arm] = await sources(root) }
assert.deepEqual(report.sources.A, report.sources.C)
const execute = promisify(execFile)
const save = () => writeFile(path.join(out, 'results.json'), JSON.stringify(report, null, 2) + '\n')
const host = () => ({at: new Date().toISOString(), load: os.loadavg(), freeMemory: os.freemem()})
let oracle
try {
    for (const [stage, blocks] of [['warmup', [report.protocol.warmups]], ['timed', report.protocol.measured]]) {
        for (const [block, order] of blocks.entries()) {
            for (const arm of order) {
                const hostBefore = host()
                const label = `${stage}-${block}-${arm}`
                let result
                try {
                    const {stdout, stderr} = await execute(process.execPath, ['--expose-gc', '--max-old-space-size=384', fileURLToPath(new URL('worker.mjs', import.meta.url)), roots[arm], archive], {timeout: 120_000, maxBuffer: 1024 * 1024})
                    await writeFile(path.join(out, `${label}.json`), stdout)
                    await writeFile(path.join(out, `${label}.log`), stderr)
                    result = JSON.parse(stdout)
                } catch (error) {
                    await writeFile(path.join(out, `${label}-failure.json`), JSON.stringify({message: String(error), code: error.code, signal: error.signal, stdout: error.stdout, stderr: error.stderr}, null, 2) + '\n')
                    throw error
                }
                const identity = {entryCount: result.entryCount, selectedCount: result.selectedCount, metadataSha256: result.metadataSha256, selectedNames: result.selectedNames}
                if (oracle) {
                    assert.deepEqual(identity, oracle)
                } else {
                    oracle = identity
                }
                const observation = {arm, stage, block, ...result, hostBefore, hostAfter: host()}
                for (const boundary of ['Selection', 'All']) {
                    const after = result[`after${boundary}`]
                    observation[`retained${boundary}Bytes`] = after.heapUsed + after.arrayBuffers - result.before.heapUsed - result.before.arrayBuffers
                }
                report.observations.push(observation)
                await save()
                console.log(JSON.stringify({arm, stage, block, catalogMs: result.catalogMs, retainedSelectionBytes: observation.retainedSelectionBytes, retainedAllBytes: observation.retainedAllBytes}))
            }
        }
    }
    const median = (numbers) => {
        const sorted = [...numbers].sort((a, b) => a - b)
        return (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2
    }
    report.comparisons = {}
    for (const metric of ['catalogAndClassificationMs', 'catalogAndClassificationCpuMs', 'retainedSelectionBytes', 'retainedAllBytes']) {
        report.comparisons[metric] = {}
        for (const [num, den] of [['B', 'A'], ['B', 'C'], ['C', 'A']]) {
            const pairs = report.protocol.measured.map((_, block) => {
                const get = (arm) => report.observations.find((row) => row.stage === 'timed' && row.block === block && row.arm === arm)[metric]
                return {denominator: get(den), numerator: get(num)}
            })
            report.comparisons[metric][`${num}/${den}`] = {
                medianPercent: (median(pairs.map(({denominator, numerator}) => numerator / denominator)) - 1) * 100,
                equalWorkPercent: (pairs.reduce((sum, row) => sum + row.numerator, 0) / pairs.reduce((sum, row) => sum + row.denominator, 0) - 1) * 100,
                medianDenominator: median(pairs.map((row) => row.denominator)),
                medianNumerator: median(pairs.map((row) => row.numerator)),
            }
        }
    }
    for (const [arm, root] of Object.entries(roots)) { assert.deepEqual(await sources(root), report.sources[arm]) }
    report.complete = true
    await save()
    console.log(JSON.stringify({complete: true, comparisons: report.comparisons}, null, 2))
} catch (error) {
    report.error = {message: String(error), stack: error.stack}
    await save()
    throw error
}
