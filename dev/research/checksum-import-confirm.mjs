import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {readFileSync, writeFileSync, copyFileSync, mkdirSync, openSync, closeSync} from 'node:fs'
import os from 'node:os'

const dictionary = process.argv[2]
assert.ok(['jmdict', 'jitendex', 'jmnedict'].includes(dictionary))
const output = `/tmp/session-review/confirmation-${dictionary}`
mkdirSync(output, {recursive: true})
const sourcePath = 'ext/js/dictionary/term-key-hash.js'
const buildPath = 'builds/manabitan-chrome-dev.zip'
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
function run(command, args, log) {
  const fd = openSync(log, 'w')
  try { execFileSync(command, args, {stdio: ['ignore', fd, fd], timeout: 600000, env: process.env}) }
  finally { closeSync(fd) }
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

// Four predeclared warmups, eight experimental blocks with alternating ABBA/BAAB,
// and five interleaved four-sample A/A blocks using identical baseline bytes.
// A/A slot labels deliberately mirror the experimental analysis, not merely
// consecutive-pair timing. No sample is dropped after observing its time.
const plan = ['a', 'b', 'b', 'a'].map((arm) => ({phase: 'warmup', arm, implementation: arm}))
for (let block = 0; block <= 8; ++block) {
  if (block % 2 === 0) {
    for (const arm of ['a', 'b', 'b', 'a']) {
      plan.push({phase: 'aa', block: block / 2, arm, implementation: 'a'})
    }
  }
  if (block === 8) { break }
  for (const arm of block % 2 === 0 ? ['a', 'b', 'b', 'a'] : ['b', 'a', 'a', 'b']) {
    plan.push({phase: 'ab', block, arm, implementation: arm})
  }
}
assert.equal(plan.length, 56)
const receipt = {
  dictionary,
  method: 'Independent confirmation: eight alternating ABBA/BAAB blocks, five interleaved A/A blocks, four predeclared excluded warmups, fresh profile per import',
  timing: 'Page file-input change to post-UI import-complete event using the existing strict benchmark harness',
  correctness: 'Pinned archive hashes and default flags; expected title/revision/term count, no errors or storage fallback, twelve persisted-content probes each import',
  limits: 'Not peak-memory measurement, exhaustive stored-content verification, native failure injection, or a WTY measurement',
  sourceBase: '6cf7c3df7b3038b4a7c91ee7d9d469d1cc171108',
  baselineSha256: sha(baseline), candidateSha256: sha(candidate),
  runtime: {node: process.version, cpus: os.cpus(), totalMemory: os.totalmem()},
  samples: []
}
try {
  for (let index = 0; index < plan.length; ++index) {
    const entry = plan[index]
    const tag = `${String(index).padStart(2, '0')}-${entry.phase}-${entry.arm}`
    const sampleDir = `${output}/${tag}`
    writeFileSync(sourcePath, entry.implementation === 'a' ? baseline : candidate)
    copyFileSync(`${output}/${entry.implementation}.zip`, buildPath)
    const startedAt = new Date().toISOString()
    const load = os.loadavg()
    run('node', ['dev/perf/import-benchmark.js', dictionary, '--runs', '1', '--no-build', '--output', sampleDir], `${output}/${tag}.log`)
    const result = JSON.parse(readFileSync(`${sampleDir}/summary.json`, 'utf8'))
    assert.equal(result.runs.length, 1)
    assert.equal(result.authoritativeTiming, true)
    assert.ok(result.runs[0].totalImportMs > 0)
    receipt.samples.push({...entry, index, startedAt, load, sourceSha256: sha(readFileSync(sourcePath)), result})
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
