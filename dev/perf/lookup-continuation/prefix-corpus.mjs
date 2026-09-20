/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import {readFile, writeFile, mkdir, rm} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createServer} from 'node:http'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import path from 'node:path'
import os from 'node:os'

const root = process.cwd()
const dictionary = process.argv[2]
const helper = path.dirname(process.argv[1])
const output = path.resolve('builds/prefix-corpus')
await mkdir(output, {recursive: true})
const sourcePath = path.resolve('ext/js/dictionary/term-lookup-index.js')
const original = await readFile(sourcePath)
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
assert.equal(sha(original), '021c33b5487d41e8de7ca84e8f1fe6eb2c1cf8b927f91bc49259701dd4b25021')
execFileSync('python3', [path.join(helper, 'apply-prefix.py')])
const candidate = await readFile(sourcePath)
await writeFile(sourcePath, original)
const baselinePath = path.resolve('ext/js/dictionary/lookup-baseline-continuation.js')
const candidatePath = path.resolve('ext/js/dictionary/lookup-candidate-continuation.js')
await writeFile(baselinePath, original)
await writeFile(candidatePath, candidate)
const {loadDictionaryFixtures, ensureFixtureFile} = await import(pathToFileURL(path.resolve('dev/perf/dictionary-fixtures.js')))
const fixture = (await loadDictionaryFixtures())[dictionary]
assert(fixture)
const archive = path.join(output, 'input.zip')
await ensureFixtureFile(fixture, archive)
const columnsPath = path.join(output, 'columns.json')
execFileSync('python3', ['-c', `import json, zipfile, re, sys
rows = []
with zipfile.ZipFile(sys.argv[1]) as z:
    names = sorted((n for n in z.namelist() if re.fullmatch(r'term_bank_[0-9]+\\.json', n)), key=lambda n: int(re.search(r'[0-9]+', n).group()))
    for name in names:
        for row in json.loads(z.read(name)):
            rows.append([row[0], row[1], row[6]])
with open(sys.argv[2], 'w') as f:
    json.dump(rows, f, ensure_ascii=False, separators=(',', ':'))
`, archive, columnsPath])
const columns = JSON.parse(await readFile(columnsPath, 'utf8'))
assert.equal(columns.length, fixture.termRows)
const columnsHash = sha(await readFile(columnsPath))

async function runExperiment(modules, builder, columns) {
    const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])
    const median = (values) => {
        const s = [...values].sort((a, b) => a - b)
        return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
    }
    const encoder = new TextEncoder()
    const indexes = [[], []]
    let encodedBytes = 0, keyCount = 0
    for (let offset = 0; offset < columns.length; offset += 30000) {
        const rows = columns.slice(offset, offset + 30000)
        const b = builder(16384)
        const expressions = new Uint32Array(rows.length), readings = new Uint32Array(rows.length), aliases = new Uint8Array(rows.length), sequences = new Int32Array(rows.length)
        for (let i = 0; i < rows.length; i++) {
            const [expression, rawReading, sequence] = rows[i]
            const reading = rawReading || expression
            expressions[i] = b.internStringBytes(encoder.encode(expression))
            readings[i] = b.internStringBytes(encoder.encode(reading))
            aliases[i] = expression === reading ? 1 : 0
            sequences[i] = Number.isInteger(sequence) && sequence >= 0 ? sequence : -1
        }
        const plan = b.buildPlan(expressions, readings)
        const encoded = modules.map((m) => m.encodePersistedTermLookupIndexFromPreinternedPlan(plan, aliases, sequences, rows.length))
        if (!same(encoded[0], encoded[1])) { throw new Error('Persisted-byte mismatch') }
        encodedBytes += encoded[0].length
        for (let arm = 0; arm < 2; arm++) {
            indexes[arm].push(modules[arm].parsePersistedTermLookupIndex(encoded[arm]))
        }
        keyCount += indexes[0].at(-1).keyOffsets.length - 1
    }
    const clone = (idx) => ({...idx, keyOrder: null, keyReverseOrder: null, keyRadix: null, keyReverseRadix: null, forwardReady: false, reverseReady: false})
    const compare = (idx, a, b, reverse) => {
        const aStart = idx.keyOffsets[a], bStart = idx.keyOffsets[b]
        const aEnd = idx.keyOffsets[a + 1], bEnd = idx.keyOffsets[b + 1]
        const count = Math.min(aEnd - aStart, bEnd - bStart)
        for (let i = 0; i < count; i++) {
            const x = idx.keyBytes[reverse ? aEnd - i - 1 : aStart + i]
            const y = idx.keyBytes[reverse ? bEnd - i - 1 : bStart + i]
            if (x !== y) { return x - y }
        }
        return (aEnd - aStart) - (bEnd - bStart)
    }
    let ordersVerified = 0
    for (let chunk = 0; chunk < indexes[0].length; chunk++) {
        const idxs = indexes.map((list) => clone(list[chunk]))
        for (const reverse of [false, true]) {
            for (let arm = 0; arm < 2; arm++) {
                const idx = idxs[arm]
                if (reverse) { modules[arm].findPrefixRows(idx, new Uint8Array([255]), 'expression', true) }
                else { modules[arm].warmPersistedTermPrefixIndex(idx) }
                const order = reverse ? idx.keyReverseOrder : idx.keyOrder
                const seen = new Uint8Array(order.length)
                for (let i = 0; i < order.length; i++) {
                    const key = order[i]
                    if (key >= seen.length || seen[key] || (i > 0 && compare(idx, order[i - 1], key, reverse) >= 0)) { throw new Error('Invalid sort permutation') }
                    seen[key] = 1
                }
                ordersVerified++
            }
            if (!same(reverse ? idxs[0].keyReverseOrder : idxs[0].keyOrder, reverse ? idxs[1].keyReverseOrder : idxs[1].keyOrder)) { throw new Error('Sort-order mismatch') }
        }
    }
    const results = []
    let sink = 0
    for (const stage of ['prefix', 'suffix']) {
        const one = (arm) => {
            const indices = indexes[arm].map(clone)
            const mod = modules[arm]
            const start = performance.now()
            for (const idx of indices) {
                if (stage === 'prefix') { mod.warmPersistedTermPrefixIndex(idx) }
                else { mod.findPrefixRows(idx, new Uint8Array([255]), 'expression', true) }
            }
            const elapsed = performance.now() - start
            for (const idx of indices) { sink ^= (stage === 'prefix' ? idx.keyOrder : idx.keyReverseOrder)[0] }
            return elapsed
        }
        for (let i = 0; i < 3; i++) { one(0); one(1) }
        for (const control of [false, true]) {
            const samples = [], paired = []
            for (let block = 0; block < 8; block++) {
                const order = block % 2 ? 'BAAB' : 'ABBA'
                const group = []
                for (const label of order) {
                    const arm = control ? 0 : label === 'A' ? 0 : 1
                    const ms = one(arm)
                    const sample = {block, order, label, actualArm: arm, ms}
                    samples.push(sample)
                    group.push(sample)
                }
                const a = group.filter((s) => s.label === 'A').reduce((sum, s) => sum + s.ms, 0) / 2
                const b = group.filter((s) => s.label === 'B').reduce((sum, s) => sum + s.ms, 0) / 2
                paired.push((b / a - 1) * 100)
                await new Promise((resolve) => setTimeout(resolve, 0))
            }
            results.push({stage, control, samples, paired, pairedMedianChangePercent: median(paired), medianAbsolutePairedChangePercent: median(paired.map(Math.abs)), baselineMs: median(samples.filter((s) => s.label === 'A').map((s) => s.ms)), candidateMs: median(samples.filter((s) => s.label === 'B').map((s) => s.ms))})
        }
    }
    return {rows: columns.length, chunks: indexes[0].length, canonicalChunkRows: 30000, keyCount, encodedBytes, ordersVerified, sink, results}
}

const manifest = {dictionary, fixture, columnsSha256: columnsHash, baselineSha256: sha(original), candidateSha256: sha(candidate), driverSha256: sha(await readFile(process.argv[1])), host: {node: process.version, cpu: os.cpus()[0]?.model, memory: os.totalmem()}, results: {}, limitations: 'Component-only cold transient-index construction over every real corpus row, canonical 30,000-row chunks. Not full-extension lookup latency, native storage, import completion, or exact native parser chunking.'}
await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2))
await writeFile(path.join(output, 'driver.mjs'), await readFile(process.argv[1]))
await writeFile(path.join(output, 'baseline.js'), original)
await writeFile(path.join(output, 'candidate.js'), candidate)
try {
    const modules = await Promise.all([baselinePath, candidatePath].map((p) => import(pathToFileURL(p))))
    const {createTermRecordPreinternedPlanBuilder: builder} = await import(pathToFileURL(path.resolve('ext/js/dictionary/term-record-preinterned-plan.js')))
    manifest.results.node = await runExperiment(modules, builder, columns)
    await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2))
    const server = createServer(async (req, res) => {
        try {
            if (req.url === '/empty') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Local benchmark</title>'); return }
            const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname)
            const file = path.resolve(root, `.${pathname}`)
            if (!file.startsWith(root + path.sep)) { res.writeHead(404); res.end(); return }
            res.setHeader('Content-Type', 'text/javascript')
            res.end(await readFile(file))
        } catch (_) { res.writeHead(404); res.end() }
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const require = createRequire(path.join(root, 'package.json'))
    const {chromium} = require('playwright')
    const browser = await chromium.launch({headless: true})
    try {
        manifest.browserVersion = browser.version()
        const page = await browser.newPage()
        await page.goto(`http://127.0.0.1:${server.address().port}/empty`)
        await page.evaluate(async (columns) => {
            globalThis.columns = columns
            globalThis.modules = await Promise.all(['/ext/js/dictionary/lookup-baseline-continuation.js', '/ext/js/dictionary/lookup-candidate-continuation.js'].map((u) => import(u)))
            globalThis.builder = (await import('/ext/js/dictionary/term-record-preinterned-plan.js')).createTermRecordPreinternedPlanBuilder
        }, columns)
        manifest.results.chromium = await page.evaluate(`(${runExperiment.toString()})(globalThis.modules, globalThis.builder, globalThis.columns)`)
    } finally {
        await browser.close()
        await new Promise((resolve) => server.close(resolve))
    }
    manifest.status = 'success'
} catch (error) {
    manifest.status = 'failure'
    manifest.error = error.stack ?? String(error)
    process.exitCode = 1
} finally {
    await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2))
    await Promise.all([archive, columnsPath, baselinePath, candidatePath].map((p) => rm(p, {force: true})))
    console.log(JSON.stringify({status: manifest.status, dictionary, error: manifest.error}))
}
