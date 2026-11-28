/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {createReadStream} from 'node:fs'
import {mkdir, readFile, stat, writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import {createRequire} from 'node:module'
import {basename, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {chromium} from 'playwright'

const [inputDirectoryArg, outputDirectoryArg, pairsArg = '8'] = process.argv.slice(2)
assert(inputDirectoryArg && outputDirectoryArg)
const inputDirectory = resolve(inputDirectoryArg)
const outputDirectory = resolve(outputDirectoryArg)
const root = fileURLToPath(new URL('../../../', import.meta.url))
const pairs = Number(pairsArg)
assert(Number.isInteger(pairs) && pairs >= 1 && pairs <= 16)
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const hashFile = async (path) => {
    const hash = createHash('sha256')
    for await (const bytes of createReadStream(path)) hash.update(bytes)
    return hash.digest('hex')
}
const median = (values) => {
    if (values.length === 0) return null
    const sorted = values.toSorted((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

const manifestBytes = await readFile(join(inputDirectory, 'manifest.json'))
const manifest = JSON.parse(manifestBytes)
const lockBytes = await readFile(join(root, 'test/perf/dictionaries.lock.json'))
assert.equal(sha256(lockBytes), manifest.lockSha256)
assert(manifest.scope.startsWith('All current-policy partitions'), 'Every captured policy partition is required')
const keys = [...new Set(manifest.dictionaries.map((entry) => entry.dictionary))]
assert.equal(keys.length, 1)
const dictionary = keys[0]
const fixture = JSON.parse(lockBytes).dictionaries[dictionary]
assert.equal(manifest.dictionaries.reduce((sum, entry) => sum + entry.rows, 0), fixture.termRows)
assert(manifest.dictionaries.every((entry) => entry.archiveSha256 === fixture.sha256))
const inputs = manifest.dictionaries.flatMap((entry) => entry.inputs)
assert.equal(new Set(inputs.map((entry) => entry.filename)).size, inputs.length)
const expectedBytes = inputs.reduce((sum, entry) => sum + entry.bytes, 0)
const expectedOutput = Buffer.alloc(inputs.length * 4)
inputs.forEach((entry, index) => expectedOutput.writeUInt32LE(entry.xxh32, index * 4))
const expectedOutputSha256 = sha256(expectedOutput)
const identities = {
    source: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(),
    tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {cwd: root, encoding: 'utf8'}).trim(),
    fixtureSha256: fixture.sha256, lockSha256: manifest.lockSha256,
    inputManifestSha256: sha256(manifestBytes), expectedOutputSha256,
}
const publicFiles = new Map()
const sources = [
    'ext/js/dictionary/term-key-hash.js',
    'dev/perf/native-sidecar-hash-three-stream/native-three.mjs',
    'dev/perf/native-sidecar-hash-three-stream/xxh32-three.wasm',
]
identities.sourceFiles = {}
for (const relative of sources) {
    const path = join(root, relative)
    identities.sourceFiles[relative] = await hashFile(path)
    publicFiles.set(`/repo/${relative}`, {path, type: relative.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'})
}
identities.wasmSha256 = identities.sourceFiles[sources[2]]
identities.workerSha256 = await hashFile(fileURLToPath(new URL('./worker.mjs', import.meta.url)))
identities.campaignSha256 = await hashFile(fileURLToPath(import.meta.url))
publicFiles.set('/worker.mjs', {path: fileURLToPath(new URL('./worker.mjs', import.meta.url)), type: 'text/javascript'})
for (const input of inputs) {
    assert.equal(input.filename, basename(input.filename), 'Input filenames must be simple basenames')
    assert.equal((await stat(join(inputDirectory, input.filename))).size, input.bytes)
    publicFiles.set(`/input/${input.filename}`, {path: join(inputDirectory, input.filename), type: 'application/octet-stream'})
}
const require = createRequire(import.meta.url)
const playwrightPackage = require(require.resolve('playwright-core/package.json'))
const browserManifest = JSON.parse(await readFile(join(require.resolve('playwright-core/package.json'), '..', 'browsers.json'), 'utf8'))
const pinnedBrowser = browserManifest.browsers.find((entry) => entry.name === 'chromium')
const executablePath = chromium.executablePath()
identities.playwrightVersion = playwrightPackage.version
identities.browserRevision = pinnedBrowser.revision
identities.expectedBrowserVersion = pinnedBrowser.browserVersion
identities.browserExecutableSha256 = await hashFile(executablePath)
identities.packageLockSha256 = await hashFile(join(root, 'package-lock.json'))
assert.equal(identities.playwrightVersion, '1.63.0')
assert.equal(identities.browserRevision, '1243')
assert.equal(identities.expectedBrowserVersion, '153.0.8010.12')
assert.equal(identities.browserExecutableSha256, '8c599d43aec53f2460a31ae2f4af6bd863f8258b34ff519564bc5d4726bfaa1e')

await mkdir(outputDirectory, {recursive: true})
const schedule = []
for (let pair = 0; pair < pairs; pair++) {
    const scenarios = pair % 2 === 0 ? ['triple', 'control'] : ['control', 'triple']
    for (const scenario of scenarios) {
        schedule.push({pair, scenario, order: pair % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']})
    }
}
await writeFile(join(outputDirectory, 'registration.json'), JSON.stringify({
    dictionary, pairs, samples: schedule.length * 2, schedule, identities, expectedBytes,
    expectedRows: fixture.termRows, expectedSectionHashCount: inputs.length,
    processIsolation: 'New full Chromium process with a new temporary profile, page and module worker for every arm',
    startupScope: 'Dynamic helper module load; native helper also fetches frozen WASM and compiles/instantiates it',
    totalScope: 'Startup plus first checksum call for each captured section; excludes browser/worker startup, fixture HTTP I/O, SHA-256 checks, input backing reconstruction and result validation',
    fixtureScope: manifest.scope,
    captureLimitation: 'Synchronous parser partitions with deterministic content references. The capture bypasses actual per-content-dictionary run segmentation. JMdict checksum span size matches observed import after framing; VNDB has additional real writer segmentation and this capture is not its exact call sequence.',
    comparisonPolicy: `${pairs} alternating pairs and ${pairs} independent JS/JS pairs; no prehash warmup, repetitions, trimmed values, retry, or selective exclusion`,
    inputBacking: 'Base and derived spans reconstructed as subviews after a 16-byte prefix of one owned ordinary Uint8Array; record fields retain a separate owned buffer; no input-copy cost inside native helper is removed',
}, null, 2) + '\n', {flag: 'wx'})

const server = createServer((request, response) => {
    const headers = {
        'Cache-Control': 'no-store',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin',
    }
    if (request.method !== 'GET') {
        response.writeHead(405, headers).end()
        return
    }
    let pathname
    try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname) } catch {
        response.writeHead(400, headers).end()
        return
    }
    if (pathname === '/') {
        response.writeHead(200, {...headers, 'Content-Type': 'text/html'}).end('<!doctype html><title>Checksum component research</title>')
        return
    }
    const entry = publicFiles.get(pathname)
    if (!entry) {
        response.writeHead(404, headers).end()
        return
    }
    response.writeHead(200, {...headers, 'Content-Type': entry.type})
    const stream = createReadStream(entry.path)
    stream.on('error', (error) => response.destroy(error))
    stream.pipe(response)
})
await new Promise((accept, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', accept)
})
const origin = `http://127.0.0.1:${server.address().port}`
const cases = []
const failures = []
try {
    for (const entry of schedule) {
        const record = {...entry, samples: {}}
        for (const label of entry.order) {
            const arm = label === 'baseline' || entry.scenario === 'control' ? 'js' : 'triple'
            const id = `${String(entry.pair + 1).padStart(2, '0')}-${entry.scenario}-${label}`
            const sampleStartedAt = performance.now()
            const logs = []
            let browser
            let result
            try {
                // Explicit executable selects full Chromium, not the separately
                // packaged headless shell. Every launch gets a fresh profile.
                browser = await chromium.launch({headless: true, executablePath})
                const browserLaunchMs = performance.now() - sampleStartedAt
                const browserVersion = browser.version()
                assert.equal(browserVersion, pinnedBrowser.browserVersion)
                const session = await browser.newBrowserCDPSession()
                const cdpVersion = await session.send('Browser.getVersion')
                const context = await browser.newContext()
                const page = await context.newPage()
                page.on('console', (message) => logs.push(`${message.type()}: ${message.text()}`))
                page.on('pageerror', (error) => logs.push(String(error.stack ?? error)))
                await page.goto(origin, {waitUntil: 'load', timeout: 30000})
                result = await page.evaluate(({arm: selectedArm, manifest: selectedManifest, identities: selectedIdentities}) => new Promise((accept, reject) => {
                    const worker = new Worker('/worker.mjs', {type: 'module'})
                    const timeout = setTimeout(() => {
                        worker.terminate()
                        reject(new Error('Checksum worker exceeded 120 seconds'))
                    }, 120000)
                    worker.onmessage = ({data}) => {
                        clearTimeout(timeout)
                        worker.terminate()
                        accept(data)
                    }
                    worker.onerror = (event) => {
                        clearTimeout(timeout)
                        worker.terminate()
                        reject(new Error(event.message))
                    }
                    worker.postMessage({arm: selectedArm, manifest: selectedManifest, identities: selectedIdentities})
                }), {arm, manifest, identities})
                assert(result.complete, result.error)
                assert.equal(result.arm, arm)
                assert.equal(result.rows, fixture.termRows)
                assert.equal(result.inputBytes, expectedBytes)
                assert.equal(result.sectionHashCount, inputs.length)
                assert.equal(result.outputHashesSha256, expectedOutputSha256)
                assert.equal(result.warmupCalls, 0)
                assert.equal(result.repetitions, 1)
                assert.equal(result.totalMs, result.initializationMs + result.hashMs)
                assert.equal(result.memoryBytes, arm === 'js' ? 0 : 65536)
                assert(result.crossOriginIsolated, 'A high-resolution isolated worker is required')
                result = {...result, dictionary, browserVersion, cdpVersion, browserLaunchMs, identities}
            } catch (error) {
                result = {...result, complete: false, arm, dictionary, error: String(error.stack ?? error)}
                failures.push({id, error: result.error})
            } finally {
                if (browser) {
                    try { await browser.close() } catch (error) {
                        result = {...result, complete: false, closeError: String(error.stack ?? error)}
                        failures.push({id, error: result.closeError})
                    }
                }
            }
            result.sampleWallMs = performance.now() - sampleStartedAt
            record.samples[label] = result
            await writeFile(join(outputDirectory, `${id}.json`), JSON.stringify(result, null, 2) + '\n', {flag: 'wx'})
            await writeFile(join(outputDirectory, `${id}.log`), logs.join('\n') + '\n', {flag: 'wx'})
        }
        const {baseline, candidate} = record.samples
        if (baseline.complete && candidate.complete) {
            record.hashRatio = candidate.hashMs / baseline.hashMs
            record.totalRatio = candidate.totalMs / baseline.totalMs
            record.hashDeltaMs = candidate.hashMs - baseline.hashMs
            record.totalDeltaMs = candidate.totalMs - baseline.totalMs
        }
        cases.push(record)
        console.log(JSON.stringify({pair: entry.pair, scenario: entry.scenario, order: entry.order,
            hashRatio: record.hashRatio, totalRatio: record.totalRatio, hashDeltaMs: record.hashDeltaMs, totalDeltaMs: record.totalDeltaMs}))
    }
} finally {
    await new Promise((accept, reject) => server.close((error) => error ? reject(error) : accept()))
}
const summaries = ['triple', 'control'].map((scenario) => {
    const entries = cases.filter((entry) => entry.scenario === scenario && typeof entry.totalRatio === 'number')
    return {scenario, completedPairs: entries.length,
        medianHashRatio: median(entries.map((entry) => entry.hashRatio)),
        medianTotalRatio: median(entries.map((entry) => entry.totalRatio)),
        medianHashDeltaMs: median(entries.map((entry) => entry.hashDeltaMs)),
        medianTotalDeltaMs: median(entries.map((entry) => entry.totalDeltaMs)),
        totalWins: entries.filter((entry) => entry.totalRatio < 1).length,
    }
})
const report = {complete: failures.length === 0, dictionary, pairs, samples: cases.length * 2,
    node: process.version, scope: 'Fresh Chromium worker first-pass checksum component, not a complete dictionary import',
    identities, failures, summaries, cases}
await writeFile(join(outputDirectory, 'campaign.json'), JSON.stringify(report, null, 2) + '\n', {flag: 'wx'})
console.log(JSON.stringify({complete: report.complete, dictionary, summaries, failures}))
if (failures.length > 0) process.exitCode = 1
