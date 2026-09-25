import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {mkdir, copyFile, readFile, writeFile} from 'node:fs/promises'
import {createBenchmarkEnvironment, extractImportResult, median, getSourceProvenance} from '../benchmark-support.js'
import {loadDictionaryFixtures} from '../dictionary-fixtures.js'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const out = path.join(root, 'builds/hash-round')
const run = promisify(execFile)
const dictionary = process.env.DICTIONARY
const pairs = Number(process.env.PAIRS || 6)
assert.ok(Number.isSafeInteger(pairs) && pairs >= 2 && pairs % 2 === 0)
const flags = JSON.parse(process.env.FLAGS || '{}')
const startReversed = process.env.REVERSE === '1'
const fixture = (await loadDictionaryFixtures())[dictionary]
assert.ok(fixture)
const hash = (x) => createHash('sha256').update(x).digest('hex')
const identities = {}
for (const arm of ['base', 'candidate']) {
    identities[arm] = {}
    for (const ext of ['c', 'wasm']) { identities[arm][ext] = hash(await readFile(path.join(out, `${arm}.${ext}`))) }
}
assert.notEqual(identities.base.wasm, identities.candidate.wasm)
const plan = [
    {kind: 'warmup', arms: ['base', 'candidate']},
    {kind: 'control', arms: ['base', 'base']},
    {kind: 'control', arms: ['base', 'base']},
]
for (let i = 0; i < pairs; ++i) {
    plan.push({kind: 'pair', arms: (i % 2 === 0) !== startReversed ? ['base', 'candidate'] : ['candidate', 'base']})
    if ((i + 1) % 4 === 0) { plan.push({kind: 'control', arms: ['base', 'base']}) }
}
plan.push({kind: 'control', arms: ['base', 'base']}, {kind: 'control', arms: ['base', 'base']})
await mkdir(out, {recursive: true})
const summary = {dictionary, fixture, pairs, flags, startReversed, node: process.version, identities, source: await getSourceProvenance(root), plan, observations: []}
await writeFile(path.join(out, 'plan.json'), JSON.stringify(summary, null, 2) + '\n')
let next = 0
for (const [block, item] of plan.entries()) {
    for (const [position, arm] of item.arms.entries()) {
        const id = `${String(next++).padStart(3, '0')}-${item.kind}-${arm}`
        const reportPath = path.join(out, `${id}.html`)
        await copyFile(path.join(out, `${arm}.c`), path.join(root, 'ext/js/dictionary/wasm/term-bank-parser.c'))
        await copyFile(path.join(out, `${arm}.wasm`), path.join(root, 'ext/lib/term-bank-parser.wasm'))
        assert.equal(hash(await readFile(path.join(root, 'ext/js/dictionary/wasm/term-bank-parser.c'))), identities[arm].c)
        assert.equal(hash(await readFile(path.join(root, 'ext/lib/term-bank-parser.wasm'))), identities[arm].wasm)
        const env = createBenchmarkEnvironment(process.env, {
            MANABITAN_E2E_IMPORT_BENCH_QUICK: '1',
            MANABITAN_E2E_IMPORT_BENCH_DICTIONARY: dictionary,
            MANABITAN_E2E_USE_PERF_DICTIONARY_LOCK: '1',
            MANABITAN_E2E_IMPORT_USE_PRODUCTION_DEFAULTS: '1',
            MANABITAN_E2E_PHASE_PROFILING: '0',
            MANABITAN_E2E_PHASE_SCREENSHOTS: '0',
            MANABITAN_E2E_PROCESS_SAMPLING: '0',
            MANABITAN_E2E_IMPORT_FLAGS_JSON: JSON.stringify(flags),
            MANABITAN_CHROMIUM_E2E_REPORT: reportPath,
            MANABITAN_E2E_SKIP_BUILD: '0',
        })
        console.log(`start ${dictionary} ${id}`)
        try {
            const {stdout, stderr} = await run(process.execPath, ['test/chromium/extension-two-dictionary-import.e2e.js'], {cwd: root, env, maxBuffer: 64 * 1024 * 1024, timeout: 600000})
            await writeFile(path.join(out, `${id}.log`), stdout + '\n' + stderr)
            const report = JSON.parse(await readFile(reportPath.replace(/\.html$/, '.json'), 'utf8'))
            const result = extractImportResult(report, dictionary, fixture, false, flags)
            assert.equal(report.runtimeDiagnostics.openStorageMode, 'opfs-sahpool')
            const source = await getSourceProvenance(root)
            summary.observations.push({id, block, position, arm, kind: item.kind, ms: result.totalImportMs, workerMs: result.workerImportMs, source})
            console.log(`done ${id} ${result.totalImportMs.toFixed(2)} ms`)
        } catch (error) {
            await writeFile(path.join(out, `${id}.failure.log`), String(error.stack || error) + '\n' + String(error.stdout || '') + '\n' + String(error.stderr || ''))
            summary.failure = {id, message: String(error)}
            throw error
        } finally {
            await writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
        }
    }
}
const deltas = []
const controlDeltas = []
const armTimes = {base: [], candidate: []}
for (const [block, item] of plan.entries()) {
    const rows = summary.observations.filter((x) => x.block === block)
    assert.equal(rows.length, 2)
    if (item.kind === 'pair') {
        const a = rows.find((x) => x.arm === 'base').ms
        const b = rows.find((x) => x.arm === 'candidate').ms
        armTimes.base.push(a)
        armTimes.candidate.push(b)
        deltas.push(100 * (b / a - 1))
    } else if (item.kind === 'control') { controlDeltas.push(100 * (rows[1].ms / rows[0].ms - 1)) }
}
summary.result = {baselineMedian: median(armTimes.base), candidateMedian: median(armTimes.candidate), pairedPercent: median(deltas), fasterPairs: deltas.filter((x) => x < 0).length, deltas, controlDeltas, controlMedian: median(controlDeltas)}
await writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify(summary.result, null, 2))
