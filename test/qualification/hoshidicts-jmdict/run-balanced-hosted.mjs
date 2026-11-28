/* SPDX-License-Identifier: GPL-3.0-or-later */

import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const execFileAsync = promisify(execFile)
const root = path.dirname(fileURLToPath(import.meta.url))
const runDirectory = process.env.BENCH_RUN_DIR
const runnerSha256 = process.env.BENCH_RUNNER_SHA256
const hoshidictsDriver = process.env.BENCH_HOSHIDICTS_DRIVER
const extensionDir = process.env.BENCH_EXTENSION_DIR
const archiveRoot = process.env.BENCH_ARCHIVE_ROOT
const packageSha256 = process.env.BENCH_PACKAGE_SHA256
const commit = process.env.BENCH_COMMIT
if (![runDirectory, runnerSha256, hoshidictsDriver, extensionDir, archiveRoot, packageSha256, commit].every(Boolean)) {
    throw new Error('Hosted balanced run is missing a required BENCH_* variable')
}

const specs = {
    jmdict: {archive: 'JMdict_2026-11-22.zip', oracle: 'source-oracle.json'},
    jitendex: {archive: 'jitendex_2026-10-03.zip', oracle: 'jitendex-source-oracle.json'},
    vndb: {archive: 'vndb_characters_by_bee.zip', oracle: 'vndb-source-oracle.json'},
}
const records = []
await mkdir(runDirectory, {recursive: true})
for (const [dataset, spec] of Object.entries(specs)) {
    const archive = path.join(archiveRoot, spec.archive)
    const oracle = path.join(root, 'fixtures', spec.oracle)
    for (let pair = 1; pair <= 6; pair++) {
        const engines = pair % 2 === 1 ? ['hoshidicts', 'manabitan'] : ['manabitan', 'hoshidicts']
        for (const engine of engines) {
            const environment = {
                ...process.env,
                BENCH_ARM: engine === 'hoshidicts' ? 'hoshidicts' : 'candidate',
                BENCH_POSITION: String(pair),
                BENCH_ARCHIVE: archive,
                BENCH_COMMIT: commit,
                BENCH_EXTENSION_DIR: extensionDir,
                BENCH_HOSHIDICTS_DRIVER: hoshidictsDriver,
                BENCH_PACKAGE_SHA256: packageSha256,
                BENCH_RUNNER_SHA256: runnerSha256,
            }
            await execFileAsync(process.execPath,
                [path.join(root, 'run-glossary.mjs'), engine, dataset, String(pair), oracle],
                {env: environment, maxBuffer: 8 * 1024 * 1024})
            const receiptPath = path.join(runDirectory, 'runs', `${dataset}-${pair}-${engine}`, 'receipt.json')
            records.push(JSON.parse(await readFile(receiptPath, 'utf8')))
        }
    }
}

function median(values) {
    const sorted = [...values].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
function distribution(values) {
    return {best: Math.min(...values), median: median(values), worst: Math.max(...values)}
}
const datasets = {}
for (const dataset of Object.keys(specs)) {
    const native = records.filter((record) => record.dataset === dataset && record.engine === 'hoshidicts')
    const browser = records.filter((record) => record.dataset === dataset && record.engine === 'manabitan')
    const byPair = (items) => new Map(items.map((item) => [item.pair, item]))
    const nativePairs = byPair(native)
    const browserPairs = byPair(browser)
    const pairs = [...nativePairs.keys()].sort((a, b) => a - b).map((pair) => {
        const h = nativePairs.get(pair)
        const m = browserPairs.get(pair)
        return {pair, order: pair % 2 ? 'hoshidicts-first' : 'manabitan-first',
            importDeltaManabitanMinusHoshidictsMs: m.completionMs - h.importMs,
            lookupDeltaManabitanMinusHoshidictsMs: m.lookupStageMs - h.lookupStageMs,
            totalDeltaManabitanMinusHoshidictsMs: m.totalMs - h.totalMs,
            status: h.status === 'passed' && m.status === 'passed' ? 'passed' : 'failed'}
    })
    const totals = pairs.map(({totalDeltaManabitanMinusHoshidictsMs}) => totalDeltaManabitanMinusHoshidictsMs)
    const imports = pairs.map(({importDeltaManabitanMinusHoshidictsMs}) => importDeltaManabitanMinusHoshidictsMs)
    const lookups = pairs.map(({lookupDeltaManabitanMinusHoshidictsMs}) => lookupDeltaManabitanMinusHoshidictsMs)
    const engineStats = Object.fromEntries([['hoshidicts', native], ['manabitan', browser]].map(([engine, items]) => {
        const importValues = items.map((item) => engine === 'hoshidicts' ? item.importMs : item.completionMs)
        return [engine, {importMs: distribution(importValues), firstLookupMs: distribution(items.map((item) => item.lookupStageMs)),
            totalMs: distribution(items.map((item) => item.totalMs))}]
    }))
    const orderEffects = Object.fromEntries(['hoshidicts-first', 'manabitan-first'].map((order) => {
        const ordered = pairs.filter((pair) => pair.order === order)
        return [order, {medianImportDeltaManabitanMinusHoshidictsMs: median(ordered.map(({importDeltaManabitanMinusHoshidictsMs}) => importDeltaManabitanMinusHoshidictsMs)),
            medianLookupDeltaManabitanMinusHoshidictsMs: median(ordered.map(({lookupDeltaManabitanMinusHoshidictsMs}) => lookupDeltaManabitanMinusHoshidictsMs)),
            medianTotalDeltaManabitanMinusHoshidictsMs: median(ordered.map(({totalDeltaManabitanMinusHoshidictsMs}) => totalDeltaManabitanMinusHoshidictsMs))}]
    }))
    const semanticPairs = [...nativePairs.keys()].map((pair) => {
        const h = nativePairs.get(pair)
        const m = browserPairs.get(pair)
        const hPairs = JSON.stringify(h.orderedHeadwordPairs)
        const mPairs = JSON.stringify(m.orderedHeadwordPairs)
        return {pair, sameOrderedHeadwordPairs: hPairs === mPairs,
            hoshidictsResultCount: h.resultCount, manabitanResultCount: m.resultCount,
            hoshidictsHeadwordPairs: h.orderedHeadwordPairs, manabitanHeadwordPairs: m.orderedHeadwordPairs,
            hoshidictsGlossariesMatchSource: h.glossaryValidation.equal,
            manabitanGlossariesMatchSource: m.glossaryValidation.equal,
            manabitanWarmMatches: m.warm?.equal ?? null,
            manabitanRestartMatches: m.afterRestart?.equal ?? null,
            manabitanRestartMediaMatchesSource: m.persistedMedia?.matchesSourceArchive ?? null}
    })
    const medianAbsoluteDeviation = (values) => {
        const center = median(values)
        return median(values.map((value) => Math.abs(value - center)))
    }
    datasets[dataset] = {
        pairs,
        engineStats,
        orderEffects,
        semanticPairs,
        medianImportDeltaManabitanMinusHoshidictsMs: median(imports),
        medianLookupDeltaManabitanMinusHoshidictsMs: median(lookups),
        medianTotalDeltaManabitanMinusHoshidictsMs: median(totals),
        totalWinsManabitan: totals.filter((value) => value < 0).length,
        totalWinsHoshidicts: totals.filter((value) => value > 0).length,
        pairedNoise: {
            importDeltaRangeMs: Math.max(...imports) - Math.min(...imports),
            importDeltaMedianAbsoluteDeviationMs: medianAbsoluteDeviation(imports),
            lookupDeltaRangeMs: Math.max(...lookups) - Math.min(...lookups),
            lookupDeltaMedianAbsoluteDeviationMs: medianAbsoluteDeviation(lookups),
            totalDeltaRangeMs: Math.max(...totals) - Math.min(...totals),
            totalDeltaMedianAbsoluteDeviationMs: medianAbsoluteDeviation(totals),
        },
        allPairsPassed: pairs.length === 6 && pairs.every(({status}) => status === 'passed'),
    }
}
const summary = {manabitanHarnessCommit: process.env.GITHUB_SHA,
    manabitanProductCommit: commit, hoshidictsCommit: 'c77b36201de0e86c8950dd1d3d88cbee36472fb1',
    runnerSha256, packageSha256,
    sourceArchives: {
        jmdict: {url: 'https://github.com/yomidevs/jmdict-yomitan/releases/download/2026-11-22/JMdict_english.zip', sha256: '3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f'},
        jitendex: {url: 'https://github.com/stephenmk/stephenmk.github.io/releases/download/2026.10.03.0/jitendex-yomitan.zip', sha256: 'e914c76596220dffc6ee0c069cd05992f03adb2988c12c3cebe817a3ac271356'},
        vndb: {url: 'https://github.com/bee-san/VNDB-Character-Names-by-Bee/releases/download/1.0.0/vndb_characters_by_bee.zip', sha256: 'da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792'},
    }, datasets, receipts}
await writeFile(path.join(runDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
console.log(JSON.stringify(Object.fromEntries(Object.entries(datasets).map(([dataset, result]) => [dataset,
    {medianImportDeltaManabitanMinusHoshidictsMs: result.medianImportDeltaManabitanMinusHoshidictsMs,
        medianLookupDeltaManabitanMinusHoshidictsMs: result.medianLookupDeltaManabitanMinusHoshidictsMs,
        medianTotalDeltaManabitanMinusHoshidictsMs: result.medianTotalDeltaManabitanMinusHoshidictsMs,
        totalWinsManabitan: result.totalWinsManabitan, allPairsPassed: result.allPairsPassed}]))))
if (Object.values(datasets).some((result) => !result.allPairsPassed)) {
    throw new Error('A hosted cross-engine cohort pair failed; inspect retained receipts.')
}
