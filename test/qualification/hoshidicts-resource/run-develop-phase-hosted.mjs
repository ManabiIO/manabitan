/* SPDX-License-Identifier: GPL-3.0-or-later */

import {createHash} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const execFileAsync = promisify(execFile)
const root = path.dirname(fileURLToPath(import.meta.url))
const harness = path.resolve(root, '../../..')
const evidence = process.env.BENCH_RUN_DIR
const scratch = process.env.BENCH_SCRATCH_DIR
const archiveRoot = process.env.BENCH_ARCHIVE_ROOT
const harnessCommit = 'a300da36d00df8e353c5679b1528b50a1299b75f'
const product = path.join(process.env.RUNNER_TEMP, 'manabitan-develop-a300da36')
const extensionDir = path.join(process.env.RUNNER_TEMP, 'cross-engine/manabitan-develop-extension')
const runner = path.join(harness, 'test/qualification/hoshidicts-jmdict/run-glossary.mjs')
// JMdict was already imported once in run 46143842404. Its complete snapshot
// is retained despite a harness title-identity assertion bug, so do not repeat it.
const datasets = {
    jitendex: {archive: 'jitendex_2026-10-03.zip', oracle: 'jitendex-source-oracle.json'},
    vndb: {archive: 'vndb_characters_by_bee.zip', oracle: 'vndb-source-oracle.json'},
}
if (!evidence || !scratch || !archiveRoot || !process.env.RUNNER_TEMP) {
    throw new Error('Hosted develop phase run is missing required runner paths')
}

async function run(command, args, options = {}) {
    return execFileAsync(command, args, {maxBuffer: 64 * 1024 * 1024, ...options})
}
async function sha256File(file) {
    return createHash('sha256').update(await readFile(file)).digest('hex')
}
await mkdir(evidence, {recursive: true})
await mkdir(scratch, {recursive: true})
const {stdout: sourceHead} = await run('git', ['rev-parse', harnessCommit], {cwd: harness})
if (sourceHead.trim() !== harnessCommit) throw new Error(`Expected exact product commit ${harnessCommit}, got ${sourceHead.trim()}`)
await run('git', ['worktree', 'add', '--detach', product, harnessCommit], {cwd: harness})
const observations = []
try {
    await run('npm', ['ci', '--no-audit', '--no-fund'], {cwd: product})
    await run(process.execPath, ['./dev/bin/build.js', '--target', 'chrome-dev'], {cwd: product})
    const packagePath = path.join(product, 'builds/manabitan-chrome-dev.zip')
    const packageSha256 = await sha256File(packagePath)
    await mkdir(extensionDir, {recursive: true})
    await run('unzip', ['-q', packagePath, '-d', extensionDir])
    const runnerSha256 = await sha256File(runner)
    const diagnosticRunnerSha256 = await sha256File(fileURLToPath(import.meta.url))
    const jitendexMediaOracleSha256 = await sha256File(path.join(
        harness, 'test/qualification/hoshidicts-jmdict/fixtures/jitendex-media-oracle.json'))
    for (const [dataset, spec] of Object.entries(datasets)) {
        const arm = 'candidate'
        const oracle = path.join(harness, 'test/qualification/hoshidicts-jmdict/fixtures', spec.oracle)
        const environment = {
            ...process.env,
            BENCH_ARM: arm,
            BENCH_POSITION: '1',
            BENCH_ARCHIVE: path.join(archiveRoot, spec.archive),
            BENCH_COMMIT: harnessCommit,
            BENCH_EXTENSION_DIR: extensionDir,
            BENCH_HOSHIDICTS_DRIVER: process.env.BENCH_HOSHIDICTS_DRIVER,
            BENCH_PACKAGE_SHA256: packageSha256,
            BENCH_RUNNER_SHA256: runnerSha256,
            BENCH_CAPTURE_IMPORT_PHASES: '1',
        }
        await run(process.execPath, [runner, 'manabitan', dataset, '1', oracle], {env: environment, cwd: harness})
        const receipt = JSON.parse(await readFile(path.join(evidence, 'runs', `${dataset}-1-${arm}`, 'receipt.json'), 'utf8'))
        const snapshot = receipt.importDebugSnapshot
        if (receipt.status !== 'passed' || !snapshot || snapshot.resultTitle !== receipt.title ||
            !Array.isArray(snapshot.importerPhaseTimings) || snapshot.importerPhaseTimings.length === 0 ||
            !Array.isArray(snapshot.localPhaseTimings) || snapshot.localPhaseTimings.length === 0) {
            throw new Error(`Missing passed lookup or complete phase snapshot for ${dataset}`)
        }
        observations.push({dataset, receiptPath: `runs/${dataset}-1-${arm}/receipt.json`, receipt})
    }
    const summary = {
        schemaVersion: 1,
        mode: 'diagnostic-only; no timing or memory observer enabled',
        harnessCommit: process.env.GITHUB_SHA,
        productCommit: harnessCommit,
        archiveShas: {
            jmdict: '3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f',
            jitendex: 'e914c76596220dffc6ee0c069cd05992f03adb2988c12c3cebe817a3ac271356',
            vndb: 'da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792',
        },
        jitendexMediaOracle: {
            path: 'jitendex/graphics/bb516c272145714035ab4a8ce53787cd.avif',
            bytes: 52406,
            sha256: '33097e7bd9cff4aece9a9b7e4dbd54b871a15cb167ad36eb55a79ce8473b0434',
        },
        packageSha256,
        runnerSha256,
        diagnosticRunnerSha256,
        jitendexMediaOracleSha256,
        observations: observations.map(({dataset, receiptPath, receipt}) => ({
            dataset,
            receiptPath,
            archiveSha256: receipt.archiveSha256,
            query: receipt.query,
            title: receipt.title,
            exactHeadword: receipt.exactHeadword,
            allResultsHydrated: receipt.allResultsHydrated,
            resultCount: receipt.resultCount,
            resultSha256: receipt.resultSha256,
            warmMatchesFirst: receipt.warm?.equal ?? null,
            restartMatchesFirst: receipt.afterRestart?.equal ?? null,
            persistedMedia: receipt.persistedMedia ?? null,
            importerPhaseTimings: receipt.importDebugSnapshot.importerPhaseTimings,
            localPhaseTimings: receipt.importDebugSnapshot.localPhaseTimings,
            status: receipt.status,
        })),
    }
    await writeFile(path.join(evidence, 'develop-phase-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, {flag: 'wx'})
    console.log(JSON.stringify(summary.observations.map(({dataset, importerPhaseTimings, localPhaseTimings}) => ({
        dataset,
        importerPhaseTimings,
        localPhaseTimings,
    }))))
} finally {
    await run('git', ['worktree', 'remove', '--force', product], {cwd: harness}).catch(() => {})
}
