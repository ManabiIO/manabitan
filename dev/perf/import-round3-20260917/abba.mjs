import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {readFileSync, writeFileSync, mkdirSync, openSync, closeSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {pathToFileURL} from 'node:url'
import path from 'node:path'
import os from 'node:os'

const root = process.cwd()
const out = path.resolve(process.env.ROUND3_OUTPUT ?? 'builds/round3')
const dictionary = process.env.ROUND3_DICTIONARY ?? 'wty-en-en'
const variants = {
    control: {},
    block2: {experimentalContentBlocks2MiB: true},
    block8: {experimentalContentBlocks8MiB: true},
    scratch: {experimentalLookupScratchReuse: true},
    segmented: {experimentalNativeSegmentedLookup: true},
    direct: {experimentalDirectLookupArena: true},
    single: {experimentalSinglePassLookupCompaction: true},
    lookupCombo: {
        experimentalLookupScratchReuse: true,
        experimentalNativeSegmentedLookup: true,
        experimentalDirectLookupArena: true,
        experimentalSinglePassLookupCompaction: true,
    },
}
const selected = (process.argv[2] ?? 'control,block2,block8,scratch,segmented,direct,single,lookupCombo').split(',')
const blocks = Number(process.argv[3] ?? 2)
assert.ok(Number.isSafeInteger(blocks) && blocks >= 1 && blocks <= 12)
assert.equal(new Set(selected).size, selected.length)
for (const id of selected) assert.ok(Object.hasOwn(variants, id), id)
const {createBenchmarkEnvironment, extractImportResult, median} = await import(pathToFileURL(path.join(root, 'dev/perf/benchmark-support.js')).href)
const {getExperimentalTermContentBlockTargetBytes, snapshotTermBankExperiments} = await import(pathToFileURL(path.join(root, 'ext/js/dictionary/term-bank-experiments.js')).href)
const fixture = JSON.parse(readFileSync('test/perf/dictionaries.lock.json', 'utf8')).dictionaries[dictionary]
assert.ok(fixture)
const hash = p => createHash('sha256').update(readFileSync(p)).digest('hex')
assert.equal(hash(path.join('builds/e2e-dictionary-cache', fixture.cacheFile)), fixture.sha256)
const files = ['builds/manabitan-chrome-dev.zip', 'ext/lib/term-bank-parser.wasm', 'ext/js/dictionary/dictionary-importer.js', 'ext/js/dictionary/dictionary-database.js', 'ext/js/dictionary/term-bank-experiments.js', 'ext/js/dictionary/term-bank-wasm-parser.js', 'ext/js/dictionary/term-content-block-store.js', 'types/ext/dictionary-importer.d.ts', 'test/term-content-block-experiments.test.js', 'test/chromium/extension-two-dictionary-import.e2e.js', 'dev/perf/benchmark-support.js', 'test/perf/dictionaries.lock.json', 'package-lock.json']
const identities = Object.fromEntries(files.map(p => [p, hash(p)]))
for (const id of selected) {
    const snapshot = snapshotTermBankExperiments(variants[id])
    for (const [key, value] of Object.entries(variants[id])) assert.equal(snapshot[key], value, `${id}: ${key} did not snapshot`)
}
const expectedTarget = flags => getExperimentalTermContentBlockTargetBytes(snapshotTermBankExperiments(flags)) ?? 4 * 1024 * 1024
const plan = []
for (const id of selected) for (const arm of ['A', 'B']) plan.push({variant: id, arm, block: 0, warmup: true, flags: arm === 'A' ? {} : variants[id]})
for (let block = 1; block <= blocks; block++) for (const id of selected) for (const arm of ['A', 'B', 'B', 'A']) plan.push({variant: id, arm, block, warmup: false, flags: arm === 'A' ? {} : variants[id]})
mkdirSync(out, {recursive: true})
const summary = {schemaVersion: 1, status: 'running', base: '2f407e86fae0d3e39f506e6b1ce30886697698ea', startedAt: new Date().toISOString(), dictionary, fixture, blocks, identities, driverHash: hash(process.argv[1]), node: process.version, cpus: os.cpus(), totalMemory: os.totalmem(), plan, observations: [], results: {}, rules: 'Same build candidate off/on. Fresh browser profile and OPFS. Fixed serial ABBA, full excluded warmups, interleaved A/A. No retries, outlier removal, profiling, tracing, screenshots or process sampling. Complete browser file-input-change through post-UI completion.'}
const persist = () => writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
let logicalSource = null
persist()
try {
    for (const [index, entry] of plan.entries()) {
        const id = `${String(index + 1).padStart(3, '0')}-${entry.warmup ? 'warmup' : `block${entry.block}`}-${entry.variant}-${entry.arm}`
        const reportPath = path.join(out, `${id}.html`)
        const env = createBenchmarkEnvironment(process.env, {
            MANABITAN_E2E_USE_PERF_DICTIONARY_LOCK: '1', MANABITAN_E2E_IMPORT_USE_PRODUCTION_DEFAULTS: '1',
            MANABITAN_E2E_IMPORT_FLAGS_JSON: JSON.stringify(entry.flags), MANABITAN_E2E_SKIP_BUILD: '1',
            MANABITAN_E2E_IMPORT_BENCH_QUICK: '1', MANABITAN_E2E_IMPORT_BENCH_DICTIONARY: dictionary,
            MANABITAN_E2E_PHASE_PROFILING: '0', MANABITAN_E2E_PHASE_SCREENSHOTS: '0', MANABITAN_E2E_PROCESS_SAMPLING: '0',
            MANABITAN_CHROMIUM_E2E_REPORT: reportPath,
        })
        const fd = openSync(path.join(out, `${id}.log`), 'wx')
        let child
        try { child = spawnSync(process.execPath, ['test/chromium/extension-two-dictionary-import.e2e.js'], {cwd: root, env, stdio: ['ignore', fd, fd], timeout: 600000}) }
        finally { closeSync(fd) }
        assert.equal(child.error, undefined, `${id}: ${child.error?.message}`)
        assert.equal(child.status, 0, `${id}: inspect retained log`)
        const reportFile = reportPath.replace(/\.html$/, '.json')
        const report = JSON.parse(readFileSync(reportFile, 'utf8'))
        const actual = extractImportResult(report, dictionary, fixture, false, entry.flags)
        assert.equal(actual.importDebug.openStorageDiagnostics.mode, 'opfs-sahpool')
        const phases = actual.importDebug.importerPhaseTimings
        const parser = phases.find(p => p.phase.startsWith('term-file-fast-path:'))?.details
        const finalization = phases.find(p => p.phase === 'bulk-finalization')?.details
        assert.ok(parser && finalization && finalization.ok === true)
        const source = {rows: parser.rows, banks: parser.batchedFileCount, compressed: parser.parserSourceCompressedBytes, uncompressed: parser.parserSourceUncompressedBytes}
        if (logicalSource === null) logicalSource = source
        assert.deepEqual(source, logicalSource)
        const blockTargetBytes = finalization.termContentStoreDiagnostics?.blockStore?.blockTargetBytes ?? finalization.termContentBlockTargetBytes ?? null
        if (blockTargetBytes !== null) assert.equal(blockTargetBytes, expectedTarget(entry.flags), `${id}: wrong block target`)
        summary.observations.push({...entry, id, totalImportMs: actual.totalImportMs, workerImportMs: actual.workerImportMs,
            automationObservedImportMs: actual.automationObservedImportMs, browser: report.browserVersion, validation: actual.validation,
            parser, finalization, blockTargetBytes, report: path.basename(reportFile), reportSha256: hash(reportFile)})
        persist()
        console.log(`${id}: ${actual.totalImportMs.toFixed(2)} ms`)
    }
    for (const p of files) assert.equal(hash(p), identities[p], `Measured input changed: ${p}`)
    for (const variant of selected) {
        const rows = summary.observations.filter(r => r.variant === variant && !r.warmup)
        assert.equal(rows.length, blocks * 4)
        const paired = [], blockPercentages = []
        for (let i = 0; i < rows.length; i += 4) {
            const block = rows.slice(i, i + 4)
            assert.deepEqual(block.map(r => r.arm), ['A', 'B', 'B', 'A'])
            const [a1, b1, b2, a2] = block.map(r => r.totalImportMs)
            paired.push(100 * (b1 / a1 - 1), 100 * (b2 / a2 - 1))
            blockPercentages.push(100 * ((b1 + b2) / (a1 + a2) - 1))
        }
        const a = rows.filter(r => r.arm === 'A').map(r => r.totalImportMs)
        const b = rows.filter(r => r.arm === 'B').map(r => r.totalImportMs)
        const sum = values => values.reduce((x, y) => x + y, 0)
        summary.results[variant] = {flags: variants[variant], pairedMedianPercent: median(paired), pairedPercentages: paired, blockPercentages,
            baselineMedianMs: median(a), candidateMedianMs: median(b), equalWorkPercent: 100 * (sum(b) / sum(a) - 1),
            pairsFaster: paired.filter(x => x < 0).length, medianAbsolutePairPercent: median(paired.map(Math.abs))}
    }
    summary.status = 'success'
} catch (error) { summary.status = 'failed'; summary.error = error.stack; throw error }
finally { persist() }
console.log(JSON.stringify(summary.results, null, 2))
