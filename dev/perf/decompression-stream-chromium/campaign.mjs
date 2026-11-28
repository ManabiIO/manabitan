/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {appendFileSync, createReadStream} from 'node:fs'
import {mkdir, readFile, stat, writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import {createRequire} from 'node:module'
import {basename, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {chromium} from 'playwright'

const [inputArg, outputArg, pairsArg = '6'] = process.argv.slice(2)
assert(inputArg && outputArg)
const inputDirectory = resolve(inputArg)
const outputDirectory = resolve(outputArg)
const pairs = Number(pairsArg)
assert(Number.isInteger(pairs) && pairs >= 2 && pairs <= 12 && pairs % 2 === 0)
const root = fileURLToPath(new URL('../../../', import.meta.url))
const helperDirectory = 'dev/perf/decompression-stream-chromium'
const baseline = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const gitBlob = (bytes) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
const hashFile = async (path) => {
    const hash = createHash('sha256')
    for await (const bytes of createReadStream(path)) { hash.update(bytes) }
    return hash.digest('hex')
}
const median = (values) => {
    if (values.length === 0) { return null }
    const sorted = values.toSorted((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

const manifestBytes = await readFile(join(inputDirectory, 'manifest.json'))
const manifest = JSON.parse(manifestBytes)
const conformanceBytes = await readFile(join(inputDirectory, 'conformance.json'))
const conformance = JSON.parse(conformanceBytes)
const lockBytes = await readFile(join(root, 'test/perf/dictionaries.lock.json'))
const fixture = JSON.parse(lockBytes).dictionaries.jmdict
assert.equal(manifest.dictionary, 'jmdict')
assert.equal(manifest.baseline, baseline)
assert.equal(manifest.lockSha256, sha256(lockBytes))
assert.equal(manifest.archiveSha256, fixture.sha256)
assert.equal(manifest.totalRows, fixture.termRows)
assert.equal(manifest.groups.length, 12)
assert(manifest.groups.every((group) => group.banks.length > 1 && !group.crcReuseEligible))
assert.deepEqual(manifest.grouping, {parserWorkers: 3, groupsPerWorker: 4, targetBytes: 25165824, executionConcurrency: 1})
assert.equal(manifest.wasmSha256, conformance.nativeWasmSha256)

const publicFiles = new Map()
const identities = {
    source: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(),
    tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {cwd: root, encoding: 'utf8'}).trim(),
    baseline, archiveSha256: fixture.sha256, lockSha256: sha256(lockBytes),
    inputManifestSha256: sha256(manifestBytes), conformanceManifestSha256: sha256(conformanceBytes), sourceFiles: {},
}
const changed = execFileSync('git', ['diff', '--name-only', baseline, 'HEAD'], {cwd: root, encoding: 'utf8'}).trim().split('\n').filter(Boolean)
assert(changed.every((file) => file.startsWith(`${helperDirectory}/`) || file === '.github/workflows/decompression-stream-chromium-beb5.yml'), 'Research branch contains an unexpected product change')
const tracked = execFileSync('git', ['ls-tree', '-r', baseline, '--', 'ext/js', 'dev/data/dictionary-wasm', 'package.json', 'package-lock.json', 'test/perf/dictionaries.lock.json'], {cwd: root, encoding: 'utf8'})
for (const line of tracked.trim().split('\n')) {
    const [metadata, relative] = line.split('\t')
    if (!(relative.endsWith('.js') || relative.endsWith('.json') || relative.endsWith('.wasm'))) { continue }
    const path = join(root, relative)
    const bytes = await readFile(path)
    assert.equal(gitBlob(bytes), metadata.split(' ')[2], `Baseline product bytes changed: ${relative}`)
    identities.sourceFiles[relative] = sha256(bytes)
    if (relative.startsWith('ext/js/') && relative.endsWith('.js')) {
        publicFiles.set(`/repo/${relative}`, {path, type: 'text/javascript'})
    }
}
const modulePath = join(root, 'dev/data/dictionary-wasm/term-bank-parser.wasm')
identities.wasmSha256 = await hashFile(modulePath)
assert.equal(identities.wasmSha256, manifest.wasmSha256)
publicFiles.set('/native.wasm', {path: modulePath, type: 'application/wasm'})
for (const file of ['gzip-inflater.mjs', 'worker.mjs', 'capture.mjs', 'fixtures.mjs', 'campaign.mjs']) {
    const relative = `${helperDirectory}/${file}`
    identities.sourceFiles[relative] = await hashFile(join(root, relative))
}
assert.equal(identities.sourceFiles[`${helperDirectory}/capture.mjs`], manifest.captureSha256)
publicFiles.set(`/repo/${helperDirectory}/gzip-inflater.mjs`, {path: join(root, helperDirectory, 'gzip-inflater.mjs'), type: 'text/javascript'})
publicFiles.set('/worker.mjs', {path: join(root, helperDirectory, 'worker.mjs'), type: 'text/javascript'})
const inputFiles = [
    ...manifest.groups.flatMap((group) => group.banks.map((bank) => ({filename: bank.filename, byteLength: bank.compressedSize, sha256: bank.compressedSha256}))),
    ...conformance.cases.flatMap((entry) => entry.sources),
    ...conformance.formats.flatMap((entry) => entry.parts),
]
for (const input of inputFiles) {
    assert.equal(input.filename, basename(input.filename))
    const path = join(inputDirectory, input.filename)
    assert.equal((await stat(path)).size, input.byteLength)
    assert.equal(await hashFile(path), input.sha256)
    publicFiles.set(`/input/${input.filename}`, {path, type: 'application/octet-stream'})
}

const require = createRequire(import.meta.url)
const playwrightPackage = require(require.resolve('playwright-core/package.json'))
const browserManifest = JSON.parse(await readFile(join(require.resolve('playwright-core/package.json'), '..', 'browsers.json'), 'utf8'))
const pinnedBrowser = browserManifest.browsers.find((entry) => entry.name === 'chromium')
const executablePath = chromium.executablePath()
Object.assign(identities, {playwrightVersion: playwrightPackage.version, browserRevision: pinnedBrowser.revision,
    expectedBrowserVersion: pinnedBrowser.browserVersion, browserExecutableSha256: await hashFile(executablePath),
    packageLockSha256: await hashFile(join(root, 'package-lock.json'))})
assert.equal(identities.playwrightVersion, '1.63.0')
assert.equal(identities.browserRevision, '1243')
assert.equal(identities.expectedBrowserVersion, '153.0.8010.12')
assert.equal(identities.browserExecutableSha256, '8c599d43aec53f2460a31ae2f4af6bd863f8258b34ff519564bc5d4726bfaa1e')

const schedule = []
for (let pair = 0; pair < pairs; ++pair) {
    const scenarios = ['gzip64', 'gzip1k', 'control']
    const offset = pair % scenarios.length
    const rotated = [...scenarios.slice(offset), ...scenarios.slice(0, offset)]
    if (pair % 2 !== 0) { rotated.reverse() }
    for (const scenario of rotated) {
        schedule.push({pair, scenario, order: pair % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']})
    }
}
await mkdir(outputDirectory, {recursive: true})
await writeFile(join(outputDirectory, 'registration.json'), JSON.stringify({dictionary: 'jmdict', pairs,
    samples: schedule.length * 2, schedule, identities,
    processIsolation: 'New full Chromium process/profile per arm; three fresh module workers initialized together, reused for four unchanged groups each, one measured group active at a time',
    workerAssignment: 'Fixed round-robin 0/1/2 differs from concurrent next-available production scheduling; report summed component work only',
    startupScope: 'Parent module fetch, SHA-256, compilation, worker construction, helper loads and all three private instantiations; browser/page startup is separate',
    timingScope: 'Every group allocation, native compressed-input copy or DS stream/framing/input slicing/output copy, full per-bank inflation/CRC/length/trailing validation, and wrapper/span construction; source HTTP reads, source SHA checks, post-timer complete decoded output copy/digests, parsing and all downstream import work are excluded',
    controls: 'Six balanced AB/BA pairs for each frozen 64KiB and 1KiB variant, plus six independent exact-code native/native pairs; scenario order rotates before results. One pass per worker, no warmup, trim, selective retry or optional second attempt.',
    totalMetric: 'Parallel three-worker initialization wall time plus summed serial group work; not summed initialization CPU or parallel import wall time',
    resourceLimitation: 'Fixed 64KiB and 1KiB input slices are prospective component variants. Both enforce JS decoded-size checks after browser-internal output allocation. Neither proves the current libdeflate hard declared-output capacity bound and neither can be promoted without a stricter resource proof.',
    crcPolicy: 'All 12 production JMdict groups are independently asserted ineligible for deferred CRC; the native routine is called with the real reuseGlossaryCrc=true option and returned CRC pointers are checked',
}, null, 2) + '\n', {flag: 'wx'})

const server = createServer((request, response) => {
    const headers = {'Cache-Control': 'no-store', 'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin'}
    if (request.method !== 'GET') { response.writeHead(405, headers).end(); return }
    let pathname
    try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname) } catch {
        response.writeHead(400, headers).end(); return
    }
    if (pathname === '/') {
        response.writeHead(200, {...headers, 'Content-Type': 'text/html'}).end('<!doctype html><title>Inflation component research</title>')
        return
    }
    const entry = publicFiles.get(pathname)
    if (!entry) { response.writeHead(404, headers).end(); return }
    response.writeHead(200, {...headers, 'Content-Type': entry.type})
    const stream = createReadStream(entry.path)
    stream.on('error', (error) => response.destroy(error))
    stream.pipe(response)
})
await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept) })
const origin = `http://127.0.0.1:${server.address().port}`

async function runBrowser(id, selectedArm, verifyOnly = false) {
    const started = performance.now()
    const logs = []
    let browser
    let result = {complete: false, arm: selectedArm}
    try {
        browser = await chromium.launch({headless: true, executablePath})
        const browserLaunchMs = performance.now() - started
        assert.equal(browser.version(), pinnedBrowser.browserVersion)
        const session = await browser.newBrowserCDPSession()
        const cdpVersion = await session.send('Browser.getVersion')
        const context = await browser.newContext()
        const page = await context.newPage()
        page.on('console', (message) => logs.push(`${message.type()}: ${message.text()}`))
        page.on('pageerror', (error) => logs.push(String(error.stack ?? error)))
        await page.exposeFunction('retainProgress', (record) => {
            appendFileSync(join(outputDirectory, `${id}.observations.jsonl`), JSON.stringify(record) + '\n')
        })
        await page.goto(origin, {waitUntil: 'load', timeout: 30000})
        result = await page.evaluate(async ({arm, manifest: inputs, conformance: checks, moduleSha256, verifyOnly: verify}) => {
            const workers = []
            const metrics = []
            const verified = []
            let initializationMs = null
            let compileMs = null
            let moduleReadMs = null
            let inits = []
            try {
                const startedAt = performance.now()
                const readStarted = performance.now()
                const response = await fetch('/native.wasm', {cache: 'no-store'})
                if (!response.ok) { throw new Error('Native module read failed') }
                const bytes = await response.arrayBuffer()
                moduleReadMs = performance.now() - readStarted
                const actualHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
                if (actualHash !== moduleSha256) { throw new Error('Native module identity mismatch') }
                const compileStarted = performance.now()
                const module = await WebAssembly.compile(bytes)
                compileMs = performance.now() - compileStarted
                for (let index = 0; index < (verify ? 1 : 3); ++index) {
                    const worker = new Worker('/worker.mjs', {type: 'module'})
                    let nextId = 0
                    const pending = new Map()
                    worker.onmessage = ({data}) => {
                        const entry = pending.get(data.id)
                        if (!entry) { return }
                        pending.delete(data.id)
                        clearTimeout(entry.timeout)
                        if (data.complete) { entry.accept(data.result) } else {
                            const error = new Error(data.error)
                            error.workerFailure = data
                            entry.reject(error)
                        }
                    }
                    worker.onerror = (event) => {
                        for (const entry of pending.values()) { clearTimeout(entry.timeout); entry.reject(new Error(event.message)) }
                        pending.clear()
                    }
                    workers.push({worker, request: (data) => new Promise((accept, reject) => {
                        const id = ++nextId
                        const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Worker command timed out: ${data.type}`)) }, 60000)
                        pending.set(id, {accept, reject, timeout})
                        worker.postMessage({...data, id})
                    })})
                }
                inits = await Promise.all(workers.map((entry) => entry.request({type: 'initialize', arm: verify ? 'conformance' : arm, module})))
                initializationMs = performance.now() - startedAt
                if (!inits.every((entry) => entry.crossOriginIsolated)) { throw new Error('Isolated worker required') }
                await window.retainProgress({type: 'initialization', inits, initializationMs, compileMs, moduleReadMs})
                if (verify) {
                    for (const entry of checks.formats) {
                        const result = await workers[0].request({type: 'format', entry})
                        verified.push({type: 'format', ...result})
                        await window.retainProgress(verified.at(-1))
                    }
                    for (const entry of checks.cases) {
                        const result = await workers[0].request({type: 'conformance', entry})
                        verified.push({type: 'source', ...result})
                        await window.retainProgress(verified.at(-1))
                    }
                    return {complete: true, arm: 'conformance', verified, initializationMs, compileMs, moduleReadMs, inits}
                }
                for (const group of inputs.groups) {
                    const workerIndex = group.groupIndex % workers.length
                    const result = await workers[workerIndex].request({type: 'group', group})
                    metrics.push({...result, workerIndex})
                    await window.retainProgress({type: 'group', ...metrics.at(-1)})
                }
                const workMs = metrics.reduce((sum, group) => sum + group.inflateAndCrcMs, 0)
                const coldWorkMs = metrics.filter((group) => group.firstInvocation).reduce((sum, group) => sum + group.inflateAndCrcMs, 0)
                return {complete: true, arm, metrics, inits, initializationMs, compileMs, moduleReadMs,
                    workMs, coldWorkMs, laterWorkMs: workMs - coldWorkMs, totalMs: initializationMs + workMs,
                    noWarmupCalls: true, passesPerWorker: 1, groupsPerWorker: 4}
            } catch (error) {
                return {complete: false, arm, metrics, verified, initializationMs, compileMs, moduleReadMs, inits,
                    error: String(error?.stack ?? error), failedCommand: error?.workerFailure ?? null}
            } finally { for (const {worker} of workers) { worker.terminate() } }
        }, {arm: selectedArm, manifest, conformance, moduleSha256: identities.wasmSha256, verifyOnly})
        if (!verifyOnly && result.complete) {
            assert.equal(result.metrics.length, 12)
            assert.equal(result.metrics.reduce((sum, group) => sum + group.expectedRows, 0), fixture.termRows)
            assert.equal(result.metrics.filter((group) => group.firstInvocation).length, 3)
            assert(result.metrics.every((group) => group.nativeFallbackCalls === 0))
        }
        result = {...result, browserVersion: browser.version(), cdpVersion, browserLaunchMs}
    } catch (error) { result = {...result, complete: false, error: String(error.stack ?? error)} }
    finally {
        if (browser) {
            try { await browser.close() } catch (error) { result = {...result, complete: false, closeError: String(error.stack ?? error)} }
        }
    }
    result.sampleWallMs = performance.now() - started
    await writeFile(join(outputDirectory, `${id}.json`), JSON.stringify(result, null, 2) + '\n', {flag: 'wx'})
    await writeFile(join(outputDirectory, `${id}.log`), logs.join('\n') + '\n', {flag: 'wx'})
    return result
}

const cases = []
const failures = []
let prerequisite
try {
    prerequisite = await runBrowser('conformance', 'conformance', true)
    if (!prerequisite.complete) { failures.push({id: 'conformance', error: prerequisite.error ?? prerequisite.closeError}) }
    else {
        for (const entry of schedule) {
            const record = {...entry, samples: {}}
            for (const label of entry.order) {
                const arm = label === 'baseline' || entry.scenario === 'control' ? 'native' : entry.scenario
                const id = `${String(entry.pair + 1).padStart(2, '0')}-${entry.scenario}-${label}`
                record.samples[label] = await runBrowser(id, arm)
                if (!record.samples[label].complete) { failures.push({id, error: record.samples[label].error ?? record.samples[label].closeError}) }
            }
            const {baseline: a, candidate: b} = record.samples
            if (a.complete && b.complete) {
                record.workRatio = b.workMs / a.workMs
                record.totalRatio = b.totalMs / a.totalMs
                record.workDeltaMs = b.workMs - a.workMs
                record.totalDeltaMs = b.totalMs - a.totalMs
                record.coldRatio = b.coldWorkMs / a.coldWorkMs
                record.laterRatio = b.laterWorkMs / a.laterWorkMs
            }
            cases.push(record)
            console.log(JSON.stringify({pair: entry.pair, scenario: entry.scenario, order: entry.order,
                workRatio: record.workRatio, totalRatio: record.totalRatio, workDeltaMs: record.workDeltaMs, totalDeltaMs: record.totalDeltaMs}))
        }
    }
} finally { await new Promise((accept, reject) => server.close((error) => error ? reject(error) : accept())) }
const summaries = ['gzip64', 'gzip1k', 'control'].map((scenario) => {
    const rows = cases.filter((entry) => entry.scenario === scenario && typeof entry.workRatio === 'number')
    return {scenario, completedPairs: rows.length, medianWorkRatio: median(rows.map((row) => row.workRatio)),
        medianTotalRatio: median(rows.map((row) => row.totalRatio)), medianWorkDeltaMs: median(rows.map((row) => row.workDeltaMs)),
        medianTotalDeltaMs: median(rows.map((row) => row.totalDeltaMs)), medianColdRatio: median(rows.map((row) => row.coldRatio)),
        medianLaterRatio: median(rows.map((row) => row.laterRatio)), workWins: rows.filter((row) => row.workRatio < 1).length}
})
const report = {complete: failures.length === 0 && cases.length === schedule.length, dictionary: 'jmdict', pairs,
    scope: 'Sequential summed inflation/CRC/copy component with unchanged source groups and three fresh worker instances; not parallel import wall time',
    identities, prerequisite, failures, summaries, cases}
await writeFile(join(outputDirectory, 'campaign.json'), JSON.stringify(report, null, 2) + '\n', {flag: 'wx'})
console.log(JSON.stringify({complete: report.complete, summaries, failures}))
if (!report.complete) { process.exitCode = 1 }
