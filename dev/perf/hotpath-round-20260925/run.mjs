import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {createBenchmarkEnvironment, extractImportResult, median, getSourceProvenance} from '../benchmark-support.js'
import {ensurePinnedDictionaryCache} from '../dictionary-fixtures.js'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const out = path.join(root, 'builds/hotpath-round')
await mkdir(out, {recursive: true})
const execute = promisify(execFile)
const dictionary = process.env.DICTIONARY
const pairs = Number(process.env.PAIRS || 6)
assert.ok(Number.isSafeInteger(pairs) && pairs >= 2 && pairs % 2 === 0)
const flag = process.env.FLAG || 'experimentalNativeEscapedKeys'
const commonFlags = JSON.parse(process.env.COMMON_FLAGS || '{}')
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
if (dictionary === 'wty-en-en') {
    const lockPath = path.join(root, 'test/perf/dictionaries.lock.json')
    const lock = JSON.parse(await readFile(lockPath, 'utf8'))
    lock.dictionaries['wty-en-en'] = {
        label: 'wty-en-en', cacheFile: 'wty-en-en.zip',
        release: '21b1b22cd655d7936d62b127e6404fbb8a88c7c3',
        url: 'https://huggingface.co/datasets/daxida/wty-release/resolve/21b1b22cd655d7936d62b127e6404fbb8a88c7c3/latest/dict/en/en/wty-en-en.zip',
        sha256: 'b9603db16dee82afd811386302ccd78bab591a6513b0d3194d937dc9110dd4a5',
        sizeBytes: 106918350, expectedTitle: 'wty-en-en', revision: '2026.08.29', termRows: 1643040,
    }
    await writeFile(lockPath, JSON.stringify(lock, null, 4) + '\n')
    const harnessPath = path.join(root, 'test/chromium/extension-two-dictionary-import.e2e.js')
    let harness = await readFile(harnessPath, 'utf8')
    for (const [old, next] of [
        ["new Set(['jmdict', 'jmnedict', 'jitendex'])", "new Set(['jmdict', 'jmnedict', 'jitendex', 'wty-en-en'])"],
        ["jitendex: {label: 'Jitendex', filePath: cachedDictionaries.jitendexPath},", "jitendex: {label: 'Jitendex', filePath: cachedDictionaries.jitendexPath},\n            'wty-en-en': {label: 'wty-en-en', filePath: path.join(dictionaryCacheDir, 'wty-en-en.zip')},"],
    ]) {
        assert.equal(harness.split(old).length, 2)
        harness = harness.replace(old, next)
    }
    assert.equal(harness.split('maxBuffer: 32 * 1024 * 1024').length, 3)
    await writeFile(harnessPath, harness.replaceAll('maxBuffer: 32 * 1024 * 1024', 'maxBuffer: 256 * 1024 * 1024'))
}
const {fixtures} = await ensurePinnedDictionaryCache(path.join(root, 'builds/e2e-dictionary-cache'))
const fixture = fixtures[dictionary]
assert.ok(fixture)
const files = ['ext/js/dictionary/term-bank-wasm-parser.js', 'ext/js/dictionary/term-bank-experiments.js', 'ext/lib/term-bank-parser.wasm', 'ext/lib/zstd.wasm', 'package-lock.json', 'test/perf/dictionaries.lock.json', 'test/chromium/extension-two-dictionary-import.e2e.js']
const identities = {}
for (const file of files) {
    try { identities[file] = hash(await readFile(path.join(root, file))) } catch (error) {
        if (file !== 'ext/lib/zstd.wasm') { throw error }
    }
}
const flags = {base: {...commonFlags, [flag]: false}, candidate: {...commonFlags, [flag]: true}}
const firstCandidate = process.env.INITIAL_ORDER !== 'AB'
const plan = [{kind: 'warmup', arms: ['base', 'candidate']}, {kind: 'control', arms: ['base', 'base']}, {kind: 'control', arms: ['base', 'base']}]
for (let i = 0; i < pairs; ++i) {
    plan.push({kind: 'pair', arms: (i % 2 === 0) === firstCandidate ? ['candidate', 'base'] : ['base', 'candidate']})
}
plan.push({kind: 'control', arms: ['base', 'base']}, {kind: 'control', arms: ['base', 'base']})
const summary = {dictionary, fixture, flag, flags, pairs, node: process.version, identities, source: await getSourceProvenance(root), plan, observations: []}
await writeFile(path.join(out, 'plan.json'), JSON.stringify(summary, null, 2) + '\n')
let next = 0
for (const [block, item] of plan.entries()) {
    for (const [position, arm] of item.arms.entries()) {
        const id = `${String(next++).padStart(3, '0')}-${item.kind}-${arm}`
        const reportPath = path.join(out, `${id}.html`)
        const env = createBenchmarkEnvironment(process.env, {
            MANABITAN_E2E_IMPORT_BENCH_QUICK: '1',
            MANABITAN_E2E_IMPORT_BENCH_DICTIONARY: dictionary,
            MANABITAN_E2E_USE_PERF_DICTIONARY_LOCK: '1',
            MANABITAN_E2E_IMPORT_USE_PRODUCTION_DEFAULTS: '1',
            MANABITAN_E2E_PHASE_PROFILING: '0',
            MANABITAN_E2E_PHASE_SCREENSHOTS: '0',
            MANABITAN_E2E_PROCESS_SAMPLING: '0',
            MANABITAN_E2E_IMPORT_FLAGS_JSON: JSON.stringify(flags[arm]),
            MANABITAN_CHROMIUM_E2E_REPORT: reportPath,
            MANABITAN_E2E_SKIP_BUILD: '1',
        })
        console.log(`start ${dictionary} ${id}`)
        try {
            const {stdout, stderr} = await execute(process.execPath, ['test/chromium/extension-two-dictionary-import.e2e.js'], {cwd: root, env, maxBuffer: 64 * 1024 * 1024, timeout: 600000})
            await writeFile(path.join(out, `${id}.log`), stdout + '\n' + stderr)
            const report = JSON.parse(await readFile(reportPath.replace(/\.html$/, '.json'), 'utf8'))
            const result = extractImportResult(report, dictionary, fixture, false, flags[arm])
            assert.equal(report.runtimeDiagnostics.openStorageMode, 'opfs-sahpool')
            summary.observations.push({id, block, position, arm, kind: item.kind, ms: result.totalImportMs, workerMs: result.workerImportMs, step4Breakdown: result.step4Breakdown})
            console.log(`done ${id} ${result.totalImportMs.toFixed(2)} ms`)
        } catch (error) {
            await writeFile(path.join(out, `${id}.failure.log`), String(error.stack || error) + '\n' + String(error.stdout || '') + '\n' + String(error.stderr || ''))
            summary.failure = {id, message: String(error)}
            throw error
        } finally { await writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n') }
    }
}
for (const [file, expected] of Object.entries(identities)) { assert.equal(hash(await readFile(path.join(root, file))), expected) }
const deltas = []
const controls = []
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
    } else if (item.kind === 'control') { controls.push(100 * (rows[1].ms / rows[0].ms - 1)) }
}
summary.result = {baselineMedian: median(armTimes.base), candidateMedian: median(armTimes.candidate), pairedPercent: median(deltas), fasterPairs: deltas.filter((x) => x < 0).length, deltas, controls, controlMedian: median(controls), controlAbsoluteMedian: median(controls.map(Math.abs))}
await writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify(summary.result, null, 2))
