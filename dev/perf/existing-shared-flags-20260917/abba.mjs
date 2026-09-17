import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {readFileSync, writeFileSync, mkdirSync, openSync, closeSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {pathToFileURL} from 'node:url'
import path from 'node:path'
import os from 'node:os'

const root = process.cwd()
const out = path.resolve(process.env.EXISTING_FLAGS_OUTPUT ?? 'builds/existing-flags')
const dictionary = process.env.EXISTING_FLAGS_DICTIONARY ?? 'wty-en-en'
const variants = {
    control: {},
    libdeflate: {experimentalLibdeflate: true},
    spans: {experimentalTermBankSpans: true},
    nativeEscaped: {experimentalNativeEscapedKeys: true},
    glossaryReuse: {experimentalValidatedGlossaryReuse: true},
    fusedSingle: {experimentalFusedSingleBank: true},
    globalContent: {experimentalGlobalExactContentReuse: true},
    fastGlossary: {experimentalFastGlossaryNormalization: true},
    parserCombo: {
        experimentalTermBankSpans: true,
        experimentalNativeEscapedKeys: true,
        experimentalValidatedGlossaryReuse: true,
        experimentalGlobalExactContentReuse: true,
        experimentalFastGlossaryNormalization: true,
    },
    libParserCombo: {
        experimentalLibdeflate: true,
        experimentalTermBankSpans: true,
        experimentalNativeEscapedKeys: true,
        experimentalValidatedGlossaryReuse: true,
        experimentalGlobalExactContentReuse: true,
        experimentalFastGlossaryNormalization: true,
    },
}
const selected = (process.argv[2] ?? Object.keys(variants).join(',')).split(',')
const blocks = Number(process.argv[3] ?? 2)
assert.ok(Number.isSafeInteger(blocks) && blocks >= 1 && blocks <= 8)
assert.equal(new Set(selected).size, selected.length)
for (const id of selected) assert.ok(Object.hasOwn(variants, id), id)
const {createBenchmarkEnvironment, extractImportResult, median} = await import(pathToFileURL(path.join(root, 'dev/perf/benchmark-support.js')).href)
const {snapshotTermBankExperiments} = await import(pathToFileURL(path.join(root, 'ext/js/dictionary/term-bank-experiments.js')).href)
const fixture = JSON.parse(readFileSync('test/perf/dictionaries.lock.json', 'utf8')).dictionaries[dictionary]
assert.ok(fixture)
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
assert.equal(hash(path.join('builds/e2e-dictionary-cache', fixture.cacheFile)), fixture.sha256)
const files = ['builds/manabitan-chrome-dev.zip', 'ext/lib/term-bank-parser.wasm', 'ext/js/dictionary/dictionary-importer.js', 'ext/js/dictionary/term-bank-experiments.js', 'ext/js/dictionary/term-bank-wasm-parser.js', 'ext/js/dictionary/term-bank-source-pipeline.js', 'test/chromium/extension-two-dictionary-import.e2e.js', 'test/perf/dictionaries.lock.json', 'package-lock.json']
const identities = Object.fromEntries(files.map(file => [file, hash(file)]))
for (const id of selected) {
    const snapshot = snapshotTermBankExperiments(variants[id])
    for (const [key, value] of Object.entries(variants[id])) assert.equal(snapshot[key], value, `${id}: ${key}`)
}
const plan = []
for (const id of selected) for (const arm of ['A', 'B']) plan.push({variant: id, arm, block: 0, warmup: true, flags: arm === 'A' ? {} : variants[id]})
for (let block = 1; block <= blocks; ++block) for (const id of selected) for (const arm of ['A', 'B', 'B', 'A']) plan.push({variant: id, arm, block, warmup: false, flags: arm === 'A' ? {} : variants[id]})
mkdirSync(out, {recursive: true})
const summary = {schemaVersion: 1, status: 'running', base: '2f407e86fae0d3e39f506e6b1ce30886697698ea', startedAt: new Date().toISOString(), dictionary, fixture, blocks, identities, driverSha256: hash(process.argv[1]), node: process.version, cpus: os.cpus(), totalMemory: os.totalmem(), plan, observations: [], results: {}, rules: 'Same built package, existing flags absent/on. Common decoder semantic repair is in both arms. Fresh browser/OPFS, fixed ABBA, excluded full warmups, interleaved A/A, no retries/trimming/profiling/tracing/screenshots/process sampling.'}
const persist = () => writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
let logical = null
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
        const parser = phases.find(phase => phase.phase.startsWith('term-file-fast-path:'))?.details
        const finalization = phases.find(phase => phase.phase === 'bulk-finalization')?.details
        assert.ok(parser && finalization && finalization.ok === true)
        const signature = {rows: parser.rows, banks: parser.batchedFileCount, compressed: parser.parserSourceCompressedBytes, uncompressed: parser.parserSourceUncompressedBytes}
        if (logical === null) logical = signature
        assert.deepEqual(signature, logical)
        summary.observations.push({...entry, id, totalImportMs: actual.totalImportMs, workerImportMs: actual.workerImportMs, automationObservedImportMs: actual.automationObservedImportMs, validation: actual.validation, parser, finalization, report: path.basename(reportFile), reportSha256: hash(reportFile)})
        persist()
        console.log(`${id}: ${actual.totalImportMs.toFixed(2)} ms`)
    }
    for (const file of files) assert.equal(hash(file), identities[file], `Measured input changed: ${file}`)
    for (const variant of selected) {
        const rows = summary.observations.filter(row => row.variant === variant && !row.warmup)
        const paired = [], blockPercentages = []
        for (let i = 0; i < rows.length; i += 4) {
            const block = rows.slice(i, i + 4)
            assert.deepEqual(block.map(row => row.arm), ['A', 'B', 'B', 'A'])
            const [a1, b1, b2, a2] = block.map(row => row.totalImportMs)
            paired.push(100 * (b1 / a1 - 1), 100 * (b2 / a2 - 1))
            blockPercentages.push(100 * ((b1 + b2) / (a1 + a2) - 1))
        }
        const a = rows.filter(row => row.arm === 'A').map(row => row.totalImportMs)
        const b = rows.filter(row => row.arm === 'B').map(row => row.totalImportMs)
        const sum = values => values.reduce((x, y) => x + y, 0)
        summary.results[variant] = {flags: variants[variant], pairedMedianPercent: median(paired), pairedPercentages: paired, blockPercentages, baselineMedianMs: median(a), candidateMedianMs: median(b), equalWorkPercent: 100 * (sum(b) / sum(a) - 1), pairsFaster: paired.filter(value => value < 0).length, medianAbsolutePairPercent: median(paired.map(Math.abs))}
    }
    summary.status = 'success'
} catch (error) { summary.status = 'failed'; summary.error = error.stack; throw error }
finally { persist() }
console.log(JSON.stringify(summary.results, null, 2))
