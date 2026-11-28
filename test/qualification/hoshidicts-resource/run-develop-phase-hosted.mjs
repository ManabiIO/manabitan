/* SPDX-License-Identifier: GPL-3.0-or-later */

import {createHash} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {lstat, mkdir, readFile, realpath, writeFile} from 'node:fs/promises'
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
// Start with one stock control to validate in-worker instrumentation before spending a full cohort.
const workerCountScreenMode = 'smoke'
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
    const workerCountScreen = {
        schemaVersion: 1,
        mode: 'hosted benchmark-only overlay; four stock versus two Zstd compression workers; parser pool and all other source bytes held constant',
        runMode: workerCountScreenMode,
        productCommit: harnessCommit,
        archive: 'JMdict_2026-11-22.zip',
        archiveSha256: '3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f',
        query: '日本語',
        resultCap: 16,
        hardwareConcurrency: null,
        controlWorkerCount: 4,
        candidateWorkerCount: 2,
        parserWorkerCounts: [],
        sourceFile: 'ext/js/dictionary/zstd-term-content.js',
        overlayOnly: null,
        controlPackageSha256: null,
        candidatePackageSha256: null,
        pairs: [],
    }
    const overlayRelativePath = workerCountScreen.sourceFile
    const overlayPath = path.resolve(product, overlayRelativePath)
    const overlayStat = await lstat(overlayPath)
    if (overlayStat.isSymbolicLink() || await realpath(overlayPath) !== overlayPath) {
        throw new Error('Zstd compression worker source is not a regular file in the detached source worktree')
    }
    const controlSource = await readFile(overlayPath)
    const controlSourceText = controlSource.toString('utf8')
    if ((controlSourceText.match(/const COMPRESSION_WORKER_COUNT = 4;/gu) ?? []).length !== 1) {
        throw new Error('Frozen source does not contain one stock four-worker compression constant')
    }
    const workerInitializationAnchor = '                readyPromises.push(waitForCompressionWorkerReady(worker, abortController.signal));\n            }\n            await Promise.all(readyPromises);'
    if ((controlSourceText.split(workerInitializationAnchor).length - 1) !== 1) {
        throw new Error('Frozen compression worker initialization anchor is absent or ambiguous')
    }
    const instrumentedControlSourceText = controlSourceText.replace(
        workerInitializationAnchor,
        `${workerInitializationAnchor.slice(0, workerInitializationAnchor.indexOf('\n            await Promise.all(readyPromises);'))}\n            globalThis.__manabitanQualificationZstdWorkersCreated = workers.length;\n            await Promise.all(readyPromises);\n            globalThis.__manabitanQualificationZstdWorkersReady = workers.length;`,
    )
    const offscreenWorkerRelativePath = 'ext/js/background/offscreen-dictionary-worker.js'
    const offscreenWorkerPath = path.resolve(product, offscreenWorkerRelativePath)
    const offscreenWorkerStat = await lstat(offscreenWorkerPath)
    if (offscreenWorkerStat.isSymbolicLink() || await realpath(offscreenWorkerPath) !== offscreenWorkerPath) {
        throw new Error('Offscreen dictionary worker source is not a regular file in the detached source worktree')
    }
    const offscreenWorkerSource = await readFile(offscreenWorkerPath)
    const offscreenWorkerSourceText = offscreenWorkerSource.toString('utf8')
    const offscreenDebugAnchor = '                        termRecordShardFileNames: (\n                            typeof getShardFileNames === \'function\' ?\n                                getShardFileNames.call(termRecordStore) :\n                                []\n                        ),'
    if ((offscreenWorkerSourceText.split(offscreenDebugAnchor).length - 1) !== 1) {
        throw new Error('Frozen offscreen storage-debug response anchor is absent or ambiguous')
    }
    const instrumentedOffscreenWorkerSourceText = offscreenWorkerSourceText.replace(
        offscreenDebugAnchor,
        `${offscreenDebugAnchor}\n                        qualificationZstdWorkersCreated: Reflect.get(globalThis, '__manabitanQualificationZstdWorkersCreated') ?? null,\n                        qualificationZstdWorkersReady: Reflect.get(globalThis, '__manabitanQualificationZstdWorkersReady') ?? null,`,
    )
    const backendRelativePath = 'ext/js/background/backend.js'
    const backendPath = path.resolve(product, backendRelativePath)
    const backendStat = await lstat(backendPath)
    if (backendStat.isSymbolicLink() || await realpath(backendPath) !== backendPath) {
        throw new Error('Background backend source is not a regular file in the detached source worktree')
    }
    const backendSource = await readFile(backendPath)
    const backendSourceText = backendSource.toString('utf8')
    const backendDebugAnchor = '            offscreenTermRecordShardFileNames: ('
    if ((backendSourceText.split(backendDebugAnchor).length - 1) !== 1) {
        throw new Error('Frozen background storage-debug response anchor is absent or ambiguous')
    }
    const instrumentedBackendSourceText = backendSourceText.replace(
        backendDebugAnchor,
        `            offscreenQualificationZstdWorkersCreated: offscreenDictionaryRowsResult?.qualificationZstdWorkersCreated ?? null,\n            offscreenQualificationZstdWorkersReady: offscreenDictionaryRowsResult?.qualificationZstdWorkersReady ?? null,\n${backendDebugAnchor}`,
    )
    const candidateSourceText = instrumentedControlSourceText.replace('const COMPRESSION_WORKER_COUNT = 4;', 'const COMPRESSION_WORKER_COUNT = 2;')
    if ((instrumentedControlSourceText.match(/const COMPRESSION_WORKER_COUNT = 4;/gu) ?? []).length !== 1 ||
        candidateSourceText.replace('const COMPRESSION_WORKER_COUNT = 2;', 'const COMPRESSION_WORKER_COUNT = 4;') !== instrumentedControlSourceText) {
        throw new Error('Worker-count candidate is not a single-constant overlay of the shared diagnostic package')
    }
    try {
        await writeFile(overlayPath, instrumentedControlSourceText)
        await writeFile(offscreenWorkerPath, instrumentedOffscreenWorkerSourceText)
        await writeFile(backendPath, instrumentedBackendSourceText)
        await run(process.execPath, ['./dev/bin/build.js', '--target', 'chrome-dev'], {cwd: product})
        const controlPackagePath = path.join(product, 'builds/manabitan-chrome-dev.zip')
        workerCountScreen.controlPackageSha256 = await sha256File(controlPackagePath)
        const controlExtensionDir = path.join(process.env.RUNNER_TEMP, 'cross-engine/manabitan-zstd-workers-4')
        await mkdir(controlExtensionDir, {recursive: true})
        await run('unzip', ['-q', controlPackagePath, '-d', controlExtensionDir])
        workerCountScreen.sharedDiagnosticInstrumentation = {
            changes: [
                {path: overlayRelativePath, sourceSha256: createHash('sha256').update(controlSource).digest('hex'), instrumentedSourceSha256: createHash('sha256').update(instrumentedControlSourceText).digest('hex'), anchorSha256: createHash('sha256').update(workerInitializationAnchor).digest('hex')},
                {path: offscreenWorkerRelativePath, sourceSha256: createHash('sha256').update(offscreenWorkerSource).digest('hex'), instrumentedSourceSha256: createHash('sha256').update(instrumentedOffscreenWorkerSourceText).digest('hex'), anchorSha256: createHash('sha256').update(offscreenDebugAnchor).digest('hex')},
                {path: backendRelativePath, sourceSha256: createHash('sha256').update(backendSource).digest('hex'), instrumentedSourceSha256: createHash('sha256').update(instrumentedBackendSourceText).digest('hex'), anchorSha256: createHash('sha256').update(backendDebugAnchor).digest('hex')},
            ],
            purpose: 'Read constructed and ready Zstd worker counts through debugDictionaryStorageState from the offscreen dictionary worker in both packages',
        }
        await writeFile(overlayPath, candidateSourceText)
        const {stdout: changedFiles} = await run('git', ['diff', '--name-only'], {cwd: product})
        const expectedChangedPaths = [offscreenWorkerRelativePath, backendRelativePath, overlayRelativePath].sort().join('\n')
        if (changedFiles.trim() !== expectedChangedPaths) throw new Error(`Unexpected worker-count overlay paths: ${changedFiles.trim()}`)
        workerCountScreen.overlayOnly = {
            changedPaths: [overlayRelativePath],
            controlSourceSha256: createHash('sha256').update(instrumentedControlSourceText).digest('hex'),
            candidateSourceSha256: await sha256File(overlayPath),
            patchSha256: createHash('sha256').update('COMPRESSION_WORKER_COUNT: 4 -> 2').digest('hex'),
            expectedDiff: 'const COMPRESSION_WORKER_COUNT = 4; -> const COMPRESSION_WORKER_COUNT = 2;',
        }
        await run(process.execPath, ['./dev/bin/build.js', '--target', 'chrome-dev'], {cwd: product})
        const candidatePackagePath = path.join(product, 'builds/manabitan-chrome-dev.zip')
        workerCountScreen.candidatePackageSha256 = await sha256File(candidatePackagePath)
        const candidateExtensionDir = path.join(process.env.RUNNER_TEMP, 'cross-engine/manabitan-zstd-workers-2')
        await mkdir(candidateExtensionDir, {recursive: true})
        await run('unzip', ['-q', candidatePackagePath, '-d', candidateExtensionDir])

        const cohortSchedule = [
            {pair: 1, first: {arm: 'control', workers: 4}, second: {arm: 'candidate', workers: 2}, kind: 'treatment'},
            {pair: 2, first: {arm: 'candidate', workers: 2}, second: {arm: 'control', workers: 4}, kind: 'treatment'},
            {pair: 3, first: {arm: 'control', workers: 4}, second: {arm: 'candidate', workers: 2}, kind: 'treatment'},
            {pair: 4, first: {arm: 'candidate', workers: 2}, second: {arm: 'control', workers: 4}, kind: 'treatment'},
            {pair: 5, first: {arm: 'control', workers: 4}, second: {arm: 'candidate', workers: 4}, kind: 'same-code-control'},
            {pair: 6, first: {arm: 'candidate', workers: 4}, second: {arm: 'control', workers: 4}, kind: 'same-code-control'},
        ]
        const schedule = workerCountScreenMode === 'smoke' ? [
            {pair: 1, first: {arm: 'control', workers: 4}, kind: 'stock-control-smoke'},
        ] : cohortSchedule
        for (const item of schedule) {
            const pairReceipts = []
            for (const arm of [item.first, ...(item.second ? [item.second] : [])]) {
                const isCandidatePackage = item.kind === 'treatment' && arm.workers === 2
                const packageDir = isCandidatePackage ? candidateExtensionDir : controlExtensionDir
                const expectedPackageSha256 = isCandidatePackage ? workerCountScreen.candidatePackageSha256 : workerCountScreen.controlPackageSha256
                const oracle = path.join(harness, 'test/qualification/hoshidicts-jmdict/fixtures/source-oracle.json')
                const environment = {
                    ...process.env,
                    BENCH_ARM: arm.arm,
                    BENCH_POSITION: String(item.pair),
                    BENCH_ARCHIVE: path.join(archiveRoot, 'JMdict_2026-11-22.zip'),
                    BENCH_COMMIT: harnessCommit,
                    BENCH_EXTENSION_DIR: packageDir,
                    BENCH_PACKAGE_SHA256: expectedPackageSha256,
                    BENCH_RUNNER_SHA256: runnerSha256,
                    BENCH_HOSHIDICTS_DRIVER: process.env.BENCH_HOSHIDICTS_DRIVER,
                    BENCH_CAPTURE_IMPORT_PHASES: '1',
                    BENCH_EXPECTED_ZSTD_WORKERS: String(arm.workers),
                }
                await run(process.execPath, [runner, 'manabitan', 'jmdict', String(item.pair), oracle], {env: environment, cwd: harness})
                const receiptPath = path.join(evidence, 'runs', `jmdict-${item.pair}-${arm.arm}`, 'receipt.json')
                const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
                if (receipt.status !== 'passed' || receipt.commit !== harnessCommit || receipt.archiveSha256 !== workerCountScreen.archiveSha256 ||
                    receipt.packageSha256 !== expectedPackageSha256 || receipt.resultCount >= workerCountScreen.resultCap) {
                    throw new Error(`JMdict worker-count run failed identity, parity, or lookup validation: pair ${item.pair} ${arm.arm}`)
                }
                pairReceipts.push({arm: arm.arm, workerCount: arm.workers, packageSha256: expectedPackageSha256, receiptPath: `runs/jmdict-${item.pair}-${arm.arm}/receipt.json`, receipt})
                if (workerCountScreen.hardwareConcurrency === null) workerCountScreen.hardwareConcurrency = receipt.hardwareConcurrency
                else if (workerCountScreen.hardwareConcurrency !== receipt.hardwareConcurrency) throw new Error('Hosted hardwareConcurrency changed within the cohort')
                for (const parserWorkerCount of receipt.parserWorkerCounts) {
                    if (!workerCountScreen.parserWorkerCounts.includes(parserWorkerCount)) workerCountScreen.parserWorkerCounts.push(parserWorkerCount)
                }
            }
            const [first, second] = pairReceipts
            if (second === undefined) {
                workerCountScreen.pairs.push({pair: item.pair, kind: item.kind, order: [{arm: first.arm, workerCount: first.workerCount}],
                    completionMs: [{arm: first.arm, workerCount: first.workerCount, value: first.receipt.completionMs}],
                    lookupStageMs: [{arm: first.arm, workerCount: first.workerCount, value: first.receipt.lookupStageMs}],
                    totalMs: [{arm: first.arm, workerCount: first.workerCount, value: first.receipt.totalMs}],
                    resultSha256: first.receipt.resultSha256, resultCount: first.receipt.resultCount,
                    parserWorkerCounts: first.receipt.parserWorkerCounts, hardwareConcurrency: first.receipt.hardwareConcurrency,
                    warmRestartPasses: first.receipt.warm?.equal === true && first.receipt.afterRestart?.equal === true,
                    samePackageSha256: true})
                continue
            }
            const equalPairSemantics = first.receipt.resultSha256 === second.receipt.resultSha256 &&
                first.receipt.resultCount === second.receipt.resultCount &&
                JSON.stringify(first.receipt.orderedHeadwordPairs) === JSON.stringify(second.receipt.orderedHeadwordPairs) &&
                JSON.stringify(first.receipt.parserWorkerCounts) === JSON.stringify(second.receipt.parserWorkerCounts) &&
                first.receipt.hardwareConcurrency === second.receipt.hardwareConcurrency
            if (!equalPairSemantics) throw new Error(`Pair ${item.pair} results or parser worker configuration differ`)
            workerCountScreen.pairs.push({pair: item.pair, kind: item.kind, order: pairReceipts.map(({arm, workerCount}) => ({arm, workerCount})),
                completionMs: pairReceipts.map(({arm, workerCount, receipt}) => ({arm, workerCount, value: receipt.completionMs})),
                lookupStageMs: pairReceipts.map(({arm, workerCount, receipt}) => ({arm, workerCount, value: receipt.lookupStageMs})),
                totalMs: pairReceipts.map(({arm, workerCount, receipt}) => ({arm, workerCount, value: receipt.totalMs})),
                resultSha256: first.receipt.resultSha256, resultCount: first.receipt.resultCount,
                parserWorkerCounts: first.receipt.parserWorkerCounts, hardwareConcurrency: first.receipt.hardwareConcurrency,
                warmRestartPasses: pairReceipts.every(({receipt}) => receipt.warm?.equal === true && receipt.afterRestart?.equal === true),
                samePackageSha256: first.packageSha256 === second.packageSha256})
        }
    } finally {
        await writeFile(overlayPath, controlSource)
        await writeFile(offscreenWorkerPath, offscreenWorkerSource)
        await writeFile(backendPath, backendSource)
        const {stdout: changedFiles} = await run('git', ['diff', '--name-only'], {cwd: product})
        if (changedFiles.trim() !== '') throw new Error(`Temporary worker-count overlay was not restored: ${changedFiles.trim()}`)
    }
    const median = (values) => {
        const sorted = [...values].sort((a, b) => a - b)
        const middle = Math.floor(sorted.length / 2)
        return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
    }
    const armTime = (pair, workers) => pair.totalMs.find(({workerCount}) => workerCount === workers)?.value
    if (workerCountScreenMode === 'smoke') {
        workerCountScreen.analysis = {
            endpoint: 'stock four-worker import plus first ordinary hydrated termsFind response',
            smokeOnly: true,
            workerAttestationPassed: workerCountScreen.pairs.length === 1 && workerCountScreen.pairs[0].totalMs[0].workerCount === 4,
        }
    } else {
        const treatmentPairs = workerCountScreen.pairs.filter(({kind}) => kind === 'treatment')
        const sameCodePairs = workerCountScreen.pairs.filter(({kind}) => kind === 'same-code-control')
        const pairedDeltas = treatmentPairs.map((pair) => armTime(pair, 2) - armTime(pair, 4))
        const sameCodeDeltas = sameCodePairs.map((pair) => pair.totalMs[1].value - pair.totalMs[0].value)
        workerCountScreen.analysis = {
            endpoint: 'import plus first ordinary hydrated termsFind response',
            treatmentPairCount: treatmentPairs.length,
            pairedTotalMsDeltasTwoMinusFour: pairedDeltas,
            medianPairedTotalMsDeltaTwoMinusFour: median(pairedDeltas),
            treatmentWinsForTwoWorkers: pairedDeltas.filter((delta) => delta < 0).length,
            treatmentTies: pairedDeltas.filter((delta) => delta === 0).length,
            sameCodePairCount: sameCodePairs.length,
            sameCodeTotalMsDeltasCandidateMinusControl: sameCodeDeltas,
            medianAbsoluteSameCodeDeltaMs: median(sameCodeDeltas.map(Math.abs)),
            allTreatmentSemanticParityPassed: treatmentPairs.every(({resultSha256}) => resultSha256 !== null),
            allSameCodePackageDigestsMatched: sameCodePairs.every(({samePackageSha256}) => samePackageSha256),
        }
    }
    await writeFile(path.join(evidence, 'jmdict-worker-count-summary.json'), `${JSON.stringify(workerCountScreen, null, 2)}\n`, {flag: 'wx'})
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
