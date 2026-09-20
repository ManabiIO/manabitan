import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {readFileSync, writeFileSync, copyFileSync, mkdirSync, openSync, closeSync} from 'node:fs'
import os from 'node:os'

const dictionary = process.argv[2]
assert.ok(['jmdict', 'jitendex', 'jmnedict'].includes(dictionary))
const output = `/tmp/session-review/benchmark-${dictionary}`
mkdirSync(output, {recursive: true})
const sourcePath = 'ext/js/dictionary/term-key-hash.js'
const buildPath = 'builds/manabitan-chrome-dev.zip'
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const run = (command, args, log, timeout = 600000) => {
  const fd = openSync(log, 'w')
  try {
    execFileSync(command, args, {stdio: ['ignore', fd, fd], timeout, env: process.env})
  } finally { closeSync(fd) }
}
const baseline = readFileSync(sourcePath)
run('node', ['dev/bin/build.js', '--target', 'chrome-dev'], `${output}/build-a.log`)
copyFileSync(buildPath, `${output}/a.zip`)
run('git', ['apply', '--check', '/tmp/session-review/checksum.patch'], `${output}/candidate-check.log`)
run('git', ['apply', '/tmp/session-review/checksum.patch'], `${output}/candidate-apply.log`)
const candidate = readFileSync(sourcePath)
assert.notEqual(sha(baseline), sha(candidate))
run('node', ['dev/bin/build.js', '--target', 'chrome-dev'], `${output}/build-b.log`)
copyFileSync(buildPath, `${output}/b.zip`)

const samples = []
const plan = [
  {phase: 'warmup', arm: 'a'}, {phase: 'warmup', arm: 'b'},
  {phase: 'aa-start', arm: 'a'}, {phase: 'aa-start', arm: 'a'},
  ...Array.from({length: 4}, (_, block) => ['a', 'b', 'b', 'a'].map((arm) => ({phase: 'abba', block, arm}))).flat(),
  {phase: 'aa-end', arm: 'a'}, {phase: 'aa-end', arm: 'a'}
]
const receipt = {
  dictionary,
  method: 'Four ABBA blocks; two A/A pairs; two excluded, predeclared warmup imports; fresh browser profile for every sample',
  timing: 'Page file-input change to post-UI import-complete event, as enforced by the existing production benchmark',
  correctness: 'Pinned archive SHA-256, title/revision/row count, native backend, no fallback/errors, and twelve persisted-content probes checked by existing harness',
  limits: 'Not native fault injection, peak-memory measurement, exhaustive content validation, or a WTY import',
  baselineSha256: sha(baseline), candidateSha256: sha(candidate),
  sourceBase: '6cf7c3df7b3038b4a7c91ee7d9d469d1cc171108',
  runtime: {node: process.version, platform: process.platform, cpus: os.cpus(), totalMemory: os.totalmem()},
  samples
}
try {
  for (let index = 0; index < plan.length; ++index) {
    const entry = plan[index]
    const tag = `${String(index).padStart(2, '0')}-${entry.phase}-${entry.arm}`
    const sampleDir = `${output}/${tag}`
    writeFileSync(sourcePath, entry.arm === 'a' ? baseline : candidate)
    copyFileSync(`${output}/${entry.arm}.zip`, buildPath)
    const startedAt = new Date().toISOString()
    const load = os.loadavg()
    run('node', ['dev/perf/import-benchmark.js', dictionary, '--runs', '1', '--no-build', '--output', sampleDir], `${output}/${tag}.log`)
    const summary = JSON.parse(readFileSync(`${sampleDir}/summary.json`, 'utf8'))
    assert.equal(summary.runs.length, 1)
    assert.equal(summary.authoritativeTiming, true)
    assert.ok(summary.runs[0].totalImportMs > 0)
    samples.push({...entry, index, startedAt, load, sourceSha256: sha(readFileSync(sourcePath)), result: summary})
    writeFileSync(`${output}/receipt.json`, JSON.stringify(receipt, null, 2))
  }
  receipt.completed = true
} catch (error) {
  receipt.completed = false
  receipt.error = String(error.stack || error)
  throw error
} finally {
  writeFileSync(sourcePath, baseline)
  writeFileSync(`${output}/receipt.json`, JSON.stringify(receipt, null, 2))
}
