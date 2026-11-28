/* SPDX-License-Identifier: GPL-3.0-or-later */

import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const execFileAsync = promisify(execFile)
const root = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(root, '../../..')
const evidence = process.env.BENCH_RUN_DIR
const scratch = process.env.BENCH_SCRATCH_DIR
const observer = path.join(root, 'observer/run_resource_observer.py')
const runGlossary = path.join(repo, 'test/qualification/hoshidicts-jmdict/run-glossary.mjs')
const runnerSha256 = process.env.BENCH_RUNNER_SHA256
const datasets = {
    jmdict: {archive: 'JMdict_2026-11-22.zip', oracle: 'source-oracle.json'},
    jitendex: {archive: 'jitendex_2026-10-03.zip', oracle: 'jitendex-source-oracle.json'},
    vndb: {archive: 'vndb_characters_by_bee.zip', oracle: 'vndb-source-oracle.json'},
}
if (![evidence, scratch, runnerSha256, process.env.BENCH_ARCHIVE_ROOT, process.env.BENCH_EXTENSION_DIR,
    process.env.BENCH_HOSHIDICTS_DRIVER, process.env.BENCH_PACKAGE_SHA256, process.env.BENCH_COMMIT].every(Boolean)) {
    throw new Error('Hosted resource run is missing a required BENCH_* variable')
}
await mkdir(evidence, {recursive: true})
const observations = []
for (const [dataset, spec] of Object.entries(datasets)) {
    const oracle = path.join(repo, 'test/qualification/hoshidicts-jmdict/fixtures', spec.oracle)
    for (const engine of ['hoshidicts', 'manabitan']) {
        const arm = engine === 'hoshidicts' ? 'hoshidicts' : 'candidate'
        const output = path.join(evidence, 'resource', dataset, engine)
        const environment = {
            ...process.env,
            BENCH_ARM: arm,
            BENCH_POSITION: '1',
            BENCH_ARCHIVE: path.join(process.env.BENCH_ARCHIVE_ROOT, spec.archive),
            BENCH_COMMIT: process.env.BENCH_COMMIT,
            BENCH_EXTENSION_DIR: process.env.BENCH_EXTENSION_DIR,
            BENCH_HOSHIDICTS_DRIVER: process.env.BENCH_HOSHIDICTS_DRIVER,
            BENCH_PACKAGE_SHA256: process.env.BENCH_PACKAGE_SHA256,
            BENCH_RUNNER_SHA256: runnerSha256,
        }
        const command = [process.execPath, runGlossary, engine, dataset, '1', oracle]
        const observerArgs = ['--', process.execPath, ...command.slice(1)]
        if (engine === 'hoshidicts') {
            const nextOutput = path.join(scratch, `cap-default-${dataset}-1-hoshi-resource-output`)
            environment.BENCH_RESOURCE_HOSHI_OUTPUT = nextOutput
            observerArgs.splice(0, 0, '--storage-path', nextOutput)
        }
        const {stdout} = await execFileAsync('python3', [observer, '--cwd', repo, '--output', output, ...observerArgs],
            {env: environment, maxBuffer: 8 * 1024 * 1024})
        const memory = JSON.parse(stdout.trim())
        const receiptPath = path.join(evidence, 'runs', `${dataset}-1-${arm}`, 'receipt.json')
        const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
        observations.push({dataset, engine, arm, status: receipt.status, receiptPath, memoryPath: path.join(output, 'memory.json'),
            memory, receipt})
        if (receipt.status !== 'passed' || !memory.qualifiedForWholeTreePss) {
            throw new Error(`Resource observation failed qualification: ${dataset}/${engine}`)
        }
    }
}
const summary = {
    schemaVersion: 1,
    manabitanHarnessCommit: process.env.GITHUB_SHA,
    manabitanProductCommit: process.env.BENCH_COMMIT,
    hoshidictsCommit: 'c77b36201de0e86c8950dd1d3d88cbee36472fb1',
    runnerSha256,
    packageSha256: process.env.BENCH_PACKAGE_SHA256,
    sourceArchives: {
        jmdict: {file: 'JMdict_2026-11-22.zip', sha256: '3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f'},
        jitendex: {file: 'jitendex_2026-10-03.zip', sha256: 'e914c76596220dffc6ee0c069cd05992f03adb2988c12c3cebe817a3ac271356'},
        vndb: {file: 'vndb_characters_by_bee.zip', sha256: 'da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792'},
    },
    observationCount: observations.length,
    order: 'Hoshidicts then Manabitan within each dataset; one fresh observation per engine and dataset',
    authoritativeTiming: false,
    observations: observations.map(({dataset, engine, arm, status, receiptPath, memoryPath, memory, receipt}) => ({
        dataset, engine, arm, status, receiptPath, memoryPath,
        qualifiedForWholeTreePss: memory.qualifiedForWholeTreePss,
        sampledPeakPssKiB: memory.maxSampledPssKiB,
        sampledPeakRssKiB: memory.maxSampledRssKiB,
        sampledPeakPrivateKiB: memory.maxSampledPrivateKiB,
        sampleCount: memory.sampleCount,
        stableFullyReadImportSampleCount: memory.stableFullyReadImportSampleCount,
        maxCoveredSampleGapMs: memory.maximumCoveredSampleGapMs,
        markerWindowDurationMs: memory.windowDurationMs,
        manabitanStorageAtFirstLookup: receipt.storageAtFirstLookup ?? null,
        manabitanStorageAfterRestart: receipt.storage ?? null,
        hoshidictsOutputStorage: memory.storage ?? null,
        status: receipt.status,
    })),
}
await writeFile(path.join(evidence, 'resource-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, {flag: 'wx'})
console.log(JSON.stringify(summary.observations.map(({dataset, engine, sampledPeakPssKiB, manabitanStorageAtFirstLookup,
    hoshidictsOutputStorage}) => ({dataset, engine, sampledPeakPssKiB,
    storageBytes: manabitanStorageAtFirstLookup?.totalBytes ?? hoshidictsOutputStorage?.logicalBytes ?? null}))))
