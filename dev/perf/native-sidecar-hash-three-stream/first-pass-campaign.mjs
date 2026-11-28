/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const [inputDirectory, outputDirectory, pairsArg = '8'] = process.argv.slice(2)
assert(inputDirectory && outputDirectory)
const pairs = Number(pairsArg)
assert(Number.isInteger(pairs) && pairs >= 1 && pairs <= 16)
const manifestBytes = await readFile(join(inputDirectory, 'manifest.json'))
const manifest = JSON.parse(manifestBytes)
const lockBytes = await readFile(new URL('../../../test/perf/dictionaries.lock.json', import.meta.url))
assert.equal(createHash('sha256').update(lockBytes).digest('hex'), manifest.lockSha256)
assert(manifest.scope.startsWith('All current-policy partitions'), 'The registered campaign requires every group')
const keys = [...new Set(manifest.dictionaries.map((entry) => entry.dictionary))]
assert.equal(keys.length, 1)
const fixture = JSON.parse(lockBytes).dictionaries[keys[0]]
assert.equal(manifest.dictionaries.reduce((sum, entry) => sum + entry.rows, 0), fixture.termRows)
assert(manifest.dictionaries.every((entry) => entry.archiveSha256 === fixture.sha256))
const destination = resolve(outputDirectory)
await mkdir(destination, {recursive: true})
const childPath = fileURLToPath(new URL('./first-pass.mjs', import.meta.url))
const cases = []
const failures = []
const scenarios = ['single', 'triple', 'control']
const median = (values) => {
    const sorted = values.toSorted((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
for (let pair = 0; pair < pairs; pair++) {
    const rotated = [...scenarios.slice(pair % 3), ...scenarios.slice(0, pair % 3)]
    for (const scenario of rotated) {
        const order = pair % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']
        const record = {pair, scenario, order, samples: {}}
        for (const label of order) {
            const arm = label === 'baseline' || scenario === 'control' ? 'js' : scenario
            const id = `${String(pair + 1).padStart(2, '0')}-${scenario}-${label}`
            const outputPath = join(destination, `${id}.json`)
            const child = spawnSync(process.execPath, ['--max-old-space-size=2048', childPath, resolve(inputDirectory), outputPath, arm], {
                encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 120000,
                env: {...process.env, NODE_DISABLE_COMPILE_CACHE: '1'},
            })
            await writeFile(join(destination, `${id}.log`), String(child.stdout ?? '') + String(child.stderr ?? ''), {flag: 'wx'})
            if (child.status !== 0 || child.error) {
                const failure = {pair, scenario, label, arm, status: child.status, signal: child.signal, error: String(child.error ?? '')}
                failures.push(failure)
                record.samples[label] = failure
            } else {
                const result = JSON.parse(await readFile(outputPath, 'utf8'))
                assert(result.complete && result.warmupCalls === 0 && result.repetitions === 1)
                record.samples[label] = result
            }
        }
        const {baseline, candidate} = record.samples
        if (baseline.complete && candidate.complete) {
            assert.equal(baseline.outputHashesSha256, candidate.outputHashesSha256)
            assert.equal(baseline.inputManifestSha256, candidate.inputManifestSha256)
            assert.equal(baseline.rows, candidate.rows)
            record.hashRatio = candidate.hashMs / baseline.hashMs
            record.totalRatio = candidate.totalMs / baseline.totalMs
            record.hashDeltaMs = candidate.hashMs - baseline.hashMs
            record.totalDeltaMs = candidate.totalMs - baseline.totalMs
        }
        cases.push(record)
        console.log(JSON.stringify({pair, scenario, order, hashRatio: record.hashRatio, totalRatio: record.totalRatio, hashDeltaMs: record.hashDeltaMs, totalDeltaMs: record.totalDeltaMs}))
    }
}
const summaries = scenarios.map((scenario) => {
    const entries = cases.filter((entry) => entry.scenario === scenario && typeof entry.totalRatio === 'number')
    return {scenario, completedPairs: entries.length,
        medianHashRatio: median(entries.map((entry) => entry.hashRatio)),
        medianTotalRatio: median(entries.map((entry) => entry.totalRatio)),
        medianHashDeltaMs: median(entries.map((entry) => entry.hashDeltaMs)),
        medianTotalDeltaMs: median(entries.map((entry) => entry.totalDeltaMs)),
    }
})
const report = {complete: failures.length === 0, scope: 'Registered complete-corpus first-pass component screen; separate fresh process for every arm; no warmup, no repetition, no trimming or retry',
    node: process.version, pairs, scenarios, samples: cases.length * 2, failures, summaries, cases,
    harnessSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex')}
await writeFile(join(destination, 'campaign.json'), JSON.stringify(report, null, 2) + '\n', {flag: 'wx'})
console.log(JSON.stringify({complete: report.complete, summaries, failures}))
if (failures.length > 0) process.exitCode = 1
