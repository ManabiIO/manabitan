import {spawnSync} from 'node:child_process'
import {readFileSync, writeFileSync, mkdirSync, openSync, closeSync} from 'node:fs'
import {createHash} from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import {createBenchmarkEnvironment, extractImportResult, median} from '../../dev/perf/benchmark-support.js'

const root = process.cwd()
const out = path.resolve(process.env.WTY_ABBA_OUTPUT ?? 'builds/wty-abba')
mkdirSync(out, {recursive: true})
const dictionary = process.env.WTY_DICTIONARY ?? 'wty-en-en'
const lock = JSON.parse(readFileSync('test/perf/dictionaries.lock.json', 'utf8'))
const fixture = lock.dictionaries[dictionary]
if (!fixture) { throw new Error(`Missing locked fixture ${dictionary}`) }
const candidates = {
    control: {},
    range: {experimentalRangeZipReads: true},
    simd: {experimentalSimdContentHash: true},
    capacity: {experimentalLargerFusedCapacity: true},
    single: {experimentalFusedSingleBank: true},
    capacitySingle: {experimentalLargerFusedCapacity: true, experimentalFusedSingleBank: true},
    capacitySingleNative: {experimentalLargerFusedCapacity: true, experimentalFusedSingleBank: true, experimentalNativeEscapedKeys: true},
    combined: {experimentalLargerFusedCapacity: true, experimentalFusedSingleBank: true, experimentalNativeEscapedKeys: true, experimentalSimdContentHash: true},
    native: {experimentalNativeEscapedKeys: true},
    spans: {experimentalTermBankSpans: true},
    validatedGlossary: {experimentalValidatedGlossaryReuse: true},
    globalContent: {experimentalGlobalExactContentReuse: true},
    lookupScratch: {experimentalLookupScratchReuse: true},
    segmentedLookup: {experimentalNativeSegmentedLookup: true},
    fastGlossary: {experimentalFastGlossaryNormalization: true},
}
const selected = (process.argv[2] ?? 'control,range,simd,capacity,capacitySingle').split(',')
const blocks = Number(process.argv[3] ?? 2)
if (!Number.isSafeInteger(blocks) || blocks < 1 || blocks > 12 || selected.some(id => !Object.hasOwn(candidates, id))) {
    throw new Error('Invalid ABBA plan')
}
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const files = ['ext/js/dictionary/dictionary-importer.js', 'ext/js/dictionary/term-bank-wasm-parser.js', 'ext/js/dictionary/term-bank-source-pipeline.js', 'ext/js/dictionary/term-bank-experiments.js', 'ext/js/dictionary/wasm/term-bank-parser.c', 'ext/lib/term-bank-parser.wasm', 'builds/manabitan-chrome-dev.zip', 'test/chromium/extension-two-dictionary-import.e2e.js', 'test/perf/dictionaries.lock.json', 'package-lock.json']
const expectedInputs = Object.fromEntries(files.map(file => [file, hash(file)]))
const summary = {
    schemaVersion: 1, createdAt: new Date().toISOString(),
    baselineCommit: 'c0a1b7ee6fa1383a0a422361d2a8b7f826499fff',
    baselineCorrection: 'shared-WASM token decoding; identical in every arm',
    timingBoundary: 'browser file-input change to post-UI completion',
    node: process.version, platform: process.platform, cpus: os.cpus(), totalMemory: os.totalmem(),
    fixture, dictionary, inputs: expectedInputs, driverSha256: hash(process.argv[1]), selected, blocks,
    plan: [], runs: [], results: {},
    rules: 'Same build with flags off/on. Fresh browser profile and OPFS per invocation. No retries, dropped samples, traces, screenshots or process sampling. Warmups excluded. Every measured block is A,B,B,A. Fail closed on any validation error.',
}
let sequence = 0
function persist() {
    for (const id of selected) {
        const runs = summary.runs.filter(run => run.variant === id && !run.warmup)
        const pairs = []
        for (let block = 1; block <= blocks; ++block) {
            const r = runs.filter(run => run.block === block)
            if (r.length !== 4) { continue }
            const [a1, b1, b2, a2] = r.map(run => run.totalImportMs)
            pairs.push({block, a1, b1, b2, a2, percentAB: (b1 / a1 - 1) * 100, percentBA: (b2 / a2 - 1) * 100,
                blockPercent: ((b1 + b2) / (a1 + a2) - 1) * 100})
        }
        const a = runs.filter(run => run.arm === 'A').map(run => run.totalImportMs)
        const b = runs.filter(run => run.arm === 'B').map(run => run.totalImportMs)
        summary.results[id] = {flags: candidates[id], samples: runs.length, baselineMedianMs: a.length ? median(a) : null,
            candidateMedianMs: b.length ? median(b) : null, pairedMedianPercent: pairs.length ? median(pairs.flatMap(pair => [pair.percentAB, pair.percentBA])) : null, pairs}
    }
    writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
}
function run(variant, arm, block, warmup) {
    const flags = arm === 'A' ? {} : candidates[variant]
    const id = `${String(++sequence).padStart(3, '0')}-${warmup ? 'warmup' : `block${block}`}-${variant}-${arm}`
    const reportPath = path.join(out, `${id}.html`)
    const logPath = path.join(out, `${id}.log`)
    summary.plan.push({id, variant, arm, block, warmup, flags})
    persist()
    const env = createBenchmarkEnvironment(process.env, {
        MANABITAN_E2E_USE_PERF_DICTIONARY_LOCK: '1', MANABITAN_E2E_IMPORT_USE_PRODUCTION_DEFAULTS: '1',
        MANABITAN_E2E_IMPORT_FLAGS_JSON: JSON.stringify(flags), MANABITAN_E2E_SKIP_BUILD: '1',
        MANABITAN_E2E_IMPORT_BENCH_QUICK: '1', MANABITAN_E2E_IMPORT_BENCH_DICTIONARY: dictionary,
        MANABITAN_E2E_PHASE_PROFILING: '0', MANABITAN_E2E_PHASE_SCREENSHOTS: '0', MANABITAN_E2E_PROCESS_SAMPLING: '0',
        MANABITAN_CHROMIUM_E2E_REPORT: reportPath,
    })
    const log = openSync(logPath, 'w')
    let child
    try { child = spawnSync(process.execPath, ['test/chromium/extension-two-dictionary-import.e2e.js'], {cwd: root, env, stdio: ['ignore', log, log], timeout: 600000}) }
    finally { closeSync(log) }
    if (child.status !== 0 || child.error) { throw new Error(`${id} failed: ${child.error?.message ?? child.status}; see ${logPath}`) }
    const report = JSON.parse(readFileSync(reportPath.replace(/\.html$/, '.json'), 'utf8'))
    const result = extractImportResult(report, dictionary, fixture, false, flags)
    const phases = result.importDebug.importerPhaseTimings
    const parser = phases.filter(phase => phase.phase.startsWith('term-file-fast-path:')).map(phase => phase.details)
    const aggregate = phases.find(phase => phase.phase === 'import-data-banks')?.details
    if (flags.experimentalRangeZipReads && aggregate?.rangeZipPayloadReader !== true) { throw new Error('Range-read flag did not activate') }
    if (flags.experimentalSimdContentHash && !parser.some(details => details.parserSimdContentHashCount > 0)) { throw new Error('SIMD flag did not activate') }
    summary.runs.push({id, variant, arm, block, warmup, flags, browserVersion: report.browserVersion,
        totalImportMs: result.totalImportMs, automationObservedImportMs: result.automationObservedImportMs,
        workerImportMs: result.workerImportMs, validation: result.validation, parser,
        report: path.basename(reportPath.replace(/\.html$/, '.json'))})
    persist()
    console.log(`${id}: ${result.totalImportMs.toFixed(2)} ms`)
}
try {
    for (const id of selected) { run(id, 'B', 0, true) }
    for (let block = 1; block <= blocks; ++block) {
        for (const id of selected) {
            for (const arm of ['A', 'B', 'B', 'A']) { run(id, arm, block, false) }
        }
    }
    for (const file of files) { if (hash(file) !== expectedInputs[file]) { throw new Error(`Measured input changed: ${file}`) } }
    summary.status = 'success'
} catch (error) {
    summary.status = 'failed'
    summary.error = error.stack
    throw error
} finally { persist() }
