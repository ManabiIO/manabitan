import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'

const scripts = path.dirname(fileURLToPath(import.meta.url))
const [baselineRoot, captureDir, outputDir, order] = process.argv.slice(2)
assert(baselineRoot && captureDir && outputDir && ['AB', 'BA'].includes(order), 'Expected baselineRoot captureDir outputDir AB|BA')
const repo = path.resolve(baselineRoot)
const captures = path.resolve(captureDir)
const out = path.resolve(outputDir)
const manifest = JSON.parse(fs.readFileSync(path.join(scripts, 'manifest.json'), 'utf8'))
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
fs.mkdirSync(out, {recursive: true})
const provenance = {
    scope: 'Isolated codec component experiment; neither a full dictionary import nor browser qualification.',
    node: process.version,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().map(({model}) => model),
    totalMemoryBytes: os.totalmem(),
    order,
    captureReportSha256: digest(fs.readFileSync(path.join(captures, 'report.json'))),
    scripts: Object.fromEntries(['build.py', 'patch-zstd.py', 'patch-cstream64.py', 'verify.mjs', 'screen.mjs', 'run.mjs', 'manifest.json'].map((name) => [name, digest(fs.readFileSync(path.join(scripts, name)))])),
}
fs.writeFileSync(path.join(out, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`)
function run(command, args) {
    console.log(JSON.stringify({command, args}))
    const result = spawnSync(command, args, {stdio: 'inherit', env: process.env})
    if (result.error) throw result.error
    assert.equal(result.status, 0, `${command} failed: status=${result.status}, signal=${result.signal}`)
}
run('python3', [path.join(scripts, 'build.py'), repo, out])
const candidates = order === 'BA' ? [...manifest.candidates].reverse() : manifest.candidates
const summaries = []
const median = (v) => { const a = [...v].sort((x, y) => x - y); return (a[(a.length - 1) >> 1] + a[a.length >> 1]) / 2 }
const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length
for (const candidate of candidates) {
    const rawParity = path.join(out, `${candidate}-raw-parity.json`)
    const wrapperParity = path.join(out, `${candidate}-wrapper-parity.json`)
    run(process.execPath, ['--expose-gc', path.join(scripts, 'verify.mjs'), repo, captures, out, candidate, rawParity])
    run(process.execPath, ['--expose-gc', path.join(scripts, 'screen.mjs'), repo, captures, out, wrapperParity, candidate, order, 'parity'])
    const warmFile = path.join(out, `${candidate}-warm-${order}.json`)
    run(process.execPath, ['--expose-gc', path.join(scripts, 'screen.mjs'), repo, captures, out, warmFile, candidate, order, 'warm', wrapperParity])
    const warm = JSON.parse(fs.readFileSync(warmFile, 'utf8'))
    const roundEffects = []
    for (let round = 0; round < 8; ++round) {
        const rows = warm.measurements.filter((row) => row.round === round)
        const baseline = mean(rows.filter((row) => row.kind === 'baseline').map((row) => row.wallMs))
        const changed = mean(rows.filter((row) => row.kind === candidate).map((row) => row.wallMs))
        roundEffects.push({round, baselineMs: baseline, candidateMs: changed, savedMs: baseline - changed, savedPercent: (1 - changed / baseline) * 100})
    }
    const coldPairs = []
    const coldPermutations = [['A', 'B', 'C'], ['A', 'C', 'B'], ['B', 'A', 'C'], ['B', 'C', 'A'], ['C', 'A', 'B'], ['C', 'B', 'A']]
    const coldSchedules = order === 'BA' ? [...coldPermutations].reverse() : coldPermutations
    for (let pair = 0; pair < coldSchedules.length; ++pair) {
        const labels = coldSchedules[pair]
        const rows = {}
        for (const label of labels) {
            const kind = label === 'B' ? candidate : 'baseline'
            const file = path.join(out, `${candidate}-cold-${order}-${pair}-${label}-${kind}.json`)
            run(process.execPath, ['--expose-gc', path.join(scripts, 'screen.mjs'), repo, captures, out, file, kind, order, 'cold', wrapperParity])
            const result = JSON.parse(fs.readFileSync(file, 'utf8'))
            rows[label] = {...result.measurements[0], arm: label, initializationMs: result.initialization[0].initializationMs}
        }
        const baselineWallMs = (rows.A.wallMs + rows.C.wallMs) / 2
        const baselineInitializationMs = (rows.A.initializationMs + rows.C.initializationMs) / 2
        coldPairs.push({
            pair,
            order: labels,
            arms: rows,
            baselineWallMs,
            candidateWallMs: rows.B.wallMs,
            baselineControlDifferenceMs: rows.A.wallMs - rows.C.wallMs,
            wrapperSavedMs: baselineWallMs - rows.B.wallMs,
            wrapperSavedPercent: (1 - rows.B.wallMs / baselineWallMs) * 100,
            initializationAndWrapperSavedMs: baselineInitializationMs + baselineWallMs - rows.B.initializationMs - rows.B.wallMs,
        })
    }
    const summary = {
        candidate,
        knownLimitations: manifest.limitations?.[candidate] ?? null,
        order,
        scope: provenance.scope,
        artifactBytes: manifest.expected[candidate].wasmBytes,
        artifactBytesAdded: manifest.expected[candidate].wasmBytes - manifest.expected.baseline.wasmBytes,
        warmArmMedians: warm.summary,
        warmRoundEffects: roundEffects,
        warmMedianSavedMs: median(roundEffects.map((r) => r.savedMs)),
        warmMedianSavedPercent: median(roundEffects.map((r) => r.savedPercent)),
        retainedBufferCapacities: warm.retainedBufferCapacities,
        coldPairs,
        coldMedianBaselineControlDifferenceMs: median(coldPairs.map((r) => r.baselineControlDifferenceMs)),
        coldMedianWrapperSavedMs: median(coldPairs.map((r) => r.wrapperSavedMs)),
        coldMedianWrapperSavedPercent: median(coldPairs.map((r) => r.wrapperSavedPercent)),
        coldMedianInitializationAndWrapperSavedMs: median(coldPairs.map((r) => r.initializationAndWrapperSavedMs)),
    }
    summaries.push(summary)
    fs.writeFileSync(path.join(out, `${candidate}-summary-${order}.json`), `${JSON.stringify(summary, null, 2)}\n`)
    console.log(JSON.stringify(summary))
}
fs.writeFileSync(path.join(out, `summary-${order}.json`), `${JSON.stringify({provenance, summaries}, null, 2)}\n`)
