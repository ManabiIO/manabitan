/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import {readFile, writeFile, mkdir} from 'node:fs/promises'
import {openSync, closeSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

const dictionary = process.argv[2]
assert(['jmdict', 'jitendex', 'jmnedict'].includes(dictionary))
const sourcePath = 'ext/js/dictionary/term-lookup-index.js'
const original = await readFile(sourcePath)
const blob = createHash('sha1').update(`blob ${original.length}\0`).update(original).digest('hex')
assert.equal(blob, '0e38ab187bca1139deab08566c3be49174c6ff37')
const oldGuard = 'if (bytes.byteLength === 0 || bytes.byteLength >= U16_NULL)'
const oldSlots = 'while (value < rowCount) { value *= 2; }'
assert.equal(original.toString().split(oldGuard).length, 2)
assert.equal(original.toString().split(oldSlots).length, 2)
const baseline = original.toString().replace(oldGuard, 'if (bytes.byteLength === 0 || bytes.byteLength > U16_NULL)')
const candidate = baseline.replace(oldSlots, 'while (value < rowCount * 2) { value *= 2; }')
const sha = (text) => createHash('sha256').update(text).digest('hex')
const output = path.resolve('builds/sequence-import-screen')
await mkdir(output, {recursive: true})
const arms = ['A', 'A', 'A', 'B', 'B', 'A', 'B', 'A', 'A', 'B']
const rows = []
const receipt = {
    dictionary,
    baseCommit: '6cf7c3df7b3038b4a7c91ee7d9d469d1cc171108',
    baselineSourceSha256: sha(baseline),
    candidateSourceSha256: sha(candidate),
    driverSha256: sha(await readFile(process.argv[1])),
    order: 'A/A control, ABBA, BAAB',
    host: {cpu: os.cpus()[0]?.model, memory: os.totalmem(), platform: os.platform(), node: process.version},
    started: new Date().toISOString(),
    rows,
    status: 'in-progress',
}
await writeFile(path.join(output, 'driver.mjs'), await readFile(process.argv[1]))
await writeFile(path.join(output, 'baseline-lookup-index.js'), baseline)
await writeFile(path.join(output, 'candidate-lookup-index.js'), candidate)
try {
    for (let i = 0; i < arms.length; i++) {
        const arm = arms[i]
        const text = arm === 'A' ? baseline : candidate
        await writeFile(sourcePath, text)
        const directory = path.join(output, `${String(i + 1).padStart(2, '0')}-${arm}`)
        const log = openSync(path.join(output, `${String(i + 1).padStart(2, '0')}-${arm}.log`), 'w')
        const row = {index: i + 1, arm, group: i < 2 ? 'control' : i < 6 ? 'ABBA' : 'BAAB', sourceSha256: sha(text), status: 'started', started: new Date().toISOString()}
        rows.push(row)
        await writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2))
        try {
            execFileSync(process.execPath, ['dev/perf/import-benchmark.js', dictionary, '--runs', '1', '--output', directory], {stdio: ['ignore', log, log], timeout: 12 * 60 * 1000})
            const summary = JSON.parse(await readFile(path.join(directory, 'summary.json'), 'utf8'))
            assert.equal(summary.runs.length, 1)
            assert.equal(summary.authoritativeTiming, true)
            assert.equal(summary.importFlags, null)
            assert.equal(summary.dictionary, dictionary)
            row.totalImportMs = summary.runs[0].totalImportMs
            row.workerImportMs = summary.runs[0].workerImportMs
            row.browserVersion = summary.browserVersion
            row.fixture = summary.fixture
            row.status = 'success'
            console.log(dictionary, i + 1, arm, row.totalImportMs)
        } catch (error) {
            row.status = 'failure'
            row.error = error.stack ?? String(error)
            throw error
        } finally {
            closeSync(log)
            row.finished = new Date().toISOString()
            await writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2))
        }
    }
    receipt.controlChangePercent = (rows[1].totalImportMs / rows[0].totalImportMs - 1) * 100
    receipt.pairedChanges = []
    for (const start of [2, 6]) {
        const block = rows.slice(start, start + 4)
        const a = block.filter((r) => r.arm === 'A').reduce((s, r) => s + r.totalImportMs, 0) / 2
        const b = block.filter((r) => r.arm === 'B').reduce((s, r) => s + r.totalImportMs, 0) / 2
        receipt.pairedChanges.push({group: block[0].group, baselineMs: a, candidateMs: b, changePercent: (b / a - 1) * 100})
    }
    receipt.status = 'success'
} catch (error) {
    receipt.status = 'failure'
    receipt.error = error.stack ?? String(error)
    process.exitCode = 1
} finally {
    await writeFile(sourcePath, original)
    receipt.finished = new Date().toISOString()
    await writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2))
    console.log(JSON.stringify(receipt, null, 2))
}
