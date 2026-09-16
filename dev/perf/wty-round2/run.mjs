import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {readFileSync, writeFileSync, mkdirSync, openSync, closeSync} from 'node:fs'
import {createHash} from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import {createBenchmarkEnvironment, extractImportResult, median} from '../benchmark-support.js'

const flags = JSON.parse(process.env.WTY_FLAGS ?? '{}')
const blocks = Number(process.env.WTY_BLOCKS ?? 2)
assert(Number.isSafeInteger(blocks) && blocks >= 1 && blocks <= 12)
assert(flags && typeof flags === 'object' && !Array.isArray(flags))
const dictionary = process.env.WTY_DICTIONARY ?? 'wty-en-en'
const out = path.resolve(process.env.WTY_OUTPUT ?? 'builds/wty-round2')
mkdirSync(out, {recursive: true})
const fixture = JSON.parse(readFileSync('test/perf/dictionaries.lock.json')).dictionaries[dictionary]
assert(fixture)
const hash = p => createHash('sha256').update(readFileSync(p)).digest('hex')
const inputs = ['ext/js/dictionary/wasm/term-bank-parser.c', 'ext/js/dictionary/term-bank-wasm-parser.js', 'ext/js/dictionary/term-bank-experiments.js', 'ext/js/dictionary/dictionary-importer.js', 'ext/lib/term-bank-parser.wasm', 'builds/manabitan-chrome-dev.zip', 'test/chromium/extension-two-dictionary-import.e2e.js', 'test/perf/dictionaries.lock.json', 'package-lock.json', process.argv[1]]
const hashes = Object.fromEntries(inputs.map(p => [p, hash(p)]))
const plan = []
let sequence = 0
const add = (kind, block, arm, runFlags) => plan.push({id: String(++sequence).padStart(3, '0'), kind, block, arm, flags: runFlags})
add('warmup', 0, 'A', {})
add('warmup', 0, 'B', flags)
for (let block = 1; block <= blocks; ++block) {
    if (block % 2) { for (const arm of ['A', 'B']) { add('control', block, arm, {}) } }
    const order = process.env.WTY_REVERSE === '1' ? ['B', 'A', 'A', 'B'] : ['A', 'B', 'B', 'A']
    for (const arm of order) { add('measured', block, arm, arm === 'A' ? {} : flags) }
    if (!(block % 2)) { for (const arm of ['B', 'A']) { add('control', block, arm, {}) } }
}
const summary = {status: 'running', baseline: 'c0a1b7ee6fa1383a0a422361d2a8b7f826499fff plus the PR #50 shared token decoder fix', flags, dictionary, fixture, blocks, platform: process.platform, node: process.version, cpus: os.cpus(), totalMemory: os.totalmem(), inputs: hashes, plan, observations: [], results: null}
const save = () => writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
save()
try {
    for (const item of plan) {
        const prefix = path.join(out, `${item.id}-${item.kind}-${item.block}-${item.arm}`)
        const env = createBenchmarkEnvironment(process.env, {
            MANABITAN_E2E_USE_PERF_DICTIONARY_LOCK: '1', MANABITAN_E2E_IMPORT_USE_PRODUCTION_DEFAULTS: '1',
            MANABITAN_E2E_IMPORT_FLAGS_JSON: JSON.stringify(item.flags), MANABITAN_E2E_SKIP_BUILD: '1',
            MANABITAN_E2E_IMPORT_BENCH_QUICK: '1', MANABITAN_E2E_IMPORT_BENCH_DICTIONARY: dictionary,
            MANABITAN_E2E_PHASE_PROFILING: '0', MANABITAN_E2E_PHASE_SCREENSHOTS: '0', MANABITAN_E2E_PROCESS_SAMPLING: '0',
            MANABITAN_CHROMIUM_E2E_REPORT: prefix + '.html',
        })
        const log = openSync(prefix + '.log', 'w')
        let child
        try { child = spawnSync(process.execPath, ['test/chromium/extension-two-dictionary-import.e2e.js'], {env, stdio: ['ignore', log, log], timeout: 300000}) }
        finally { closeSync(log) }
        assert.equal(child.status, 0, `${prefix}: ${child.error?.message ?? 'child failed'}`)
        const report = JSON.parse(readFileSync(prefix + '.json'))
        const result = extractImportResult(report, dictionary, fixture, false, item.flags)
        const phases = result.importDebug.importerPhaseTimings
        const parser = phases.filter(p => p.phase.startsWith('term-file-fast-path:')).map(p => p.details)
        assert(parser.length > 0, 'Missing effective parser receipts')
        summary.observations.push({...item, totalImportMs: result.totalImportMs, workerImportMs: result.workerImportMs, automationObservedImportMs: result.automationObservedImportMs, validation: result.validation, parser, aggregate: phases.find(p => p.phase === 'import-data-banks')?.details, report: path.basename(prefix + '.json')})
        save()
        console.log(`${item.id} ${item.kind} ${item.arm} ${result.totalImportMs.toFixed(2)} ms`)
    }
    const effects = []
    const controls = []
    for (let block = 1; block <= blocks; ++block) {
        const runs = summary.observations.filter(r => r.kind === 'measured' && r.block === block)
        for (let i = 0; i < runs.length; i += 2) {
            const pair = runs.slice(i, i + 2)
            const a = pair.find(r => r.arm === 'A').totalImportMs
            const b = pair.find(r => r.arm === 'B').totalImportMs
            effects.push((b / a - 1) * 100)
        }
        const pair = summary.observations.filter(r => r.kind === 'control' && r.block === block)
        controls.push((pair.find(r => r.arm === 'B').totalImportMs / pair.find(r => r.arm === 'A').totalImportMs - 1) * 100)
    }
    const arm = a => summary.observations.filter(r => r.kind === 'measured' && r.arm === a).map(r => r.totalImportMs)
    const a = arm('A'), b = arm('B')
    summary.results = {pairedPercent: effects, pairedMedianPercent: median(effects), fasterPairs: effects.filter(p => p < 0).length, baselineMedianMs: median(a), candidateMedianMs: median(b), equalWorkPercent: (b.reduce((s, v) => s + v, 0) / a.reduce((s, v) => s + v, 0) - 1) * 100, controlPercent: controls, controlSignedMedian: median(controls), controlAbsoluteMedian: median(controls.map(Math.abs))}
    for (const p of inputs) { assert.equal(hash(p), hashes[p], `Input changed: ${p}`) }
    summary.status = 'success'
    console.log(JSON.stringify(summary.results, null, 2))
} catch (error) {
    summary.status = 'failed'
    summary.error = error.stack
    throw error
} finally { save() }
