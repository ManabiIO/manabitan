import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {chromium} from 'playwright'
import {getChromiumLaunchOptions} from '../../test/e2e/chromium-launch-options.js'

const args = process.argv.slice(2)
const option = (name) => args[args.indexOf(name) + 1]
const baseline = path.resolve(option('--baseline'))
const candidate = path.resolve(option('--candidate'))
const archivePath = path.resolve(option('--archive'))
const destination = path.resolve(option('--out'))
const parityPath = path.resolve(option('--parity'))
const sourcePath = 'ext/js/dictionary/source-zip-media-preparation-worker.js'
const origin = 'http://127.0.0.1:8765'
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const json = (value) => JSON.stringify(value, null, 2) + '\n'
const checkpoints = ['beforeCatalog', 'catalogReady', 'beforeFirstRead', 'afterRead1', 'afterRead72', 'afterRead144', 'afterPack']
const injection = `
async function heapCheckpoint(label) {
    await new Promise((resolve) => {
        function resume(event) {
            if (event.data?.resumeHeapCheckpoint !== label) { return }
            self.removeEventListener('message', resume)
            resolve()
        }
        self.addEventListener('message', resume)
        self.postMessage({heapCheckpoint: label})
    })
}
const originalReadBatch = RawZipPayloadReader.prototype.readBatch
let observedBatches = 0
RawZipPayloadReader.prototype.readBatch = async function (...args) {
    ++observedBatches
    if (observedBatches === 1) { await heapCheckpoint('beforeFirstRead') }
    const result = await originalReadBatch.apply(this, args)
    if ([1, 72, 144].includes(observedBatches)) { await heapCheckpoint('afterRead' + observedBatches) }
    return result
}
`

function instrument(source) {
    const patterns = [
        [/^self\.addEventListener\('message'/gm, (match) => injection + '\n' + match],
        [/^(\s*)(const entries = await [^\n]+)$/gm, (_, indent, statement) => `${indent}await heapCheckpoint('beforeCatalog')\n${indent}${statement}`],
        [/^(\s*)(const packed = await preparePackedSourceZipMediaIndex[^\n]+)$/gm, (_, indent, statement) => `${indent}await heapCheckpoint('catalogReady')\n${indent}${statement}\n${indent}await heapCheckpoint('afterPack')`],
    ]
    for (const [pattern, replacement] of patterns) {
        assert.equal([...source.matchAll(pattern)].length, 1, String(pattern))
        source = source.replace(pattern, replacement)
    }
    return source
}
async function hashFile(filename) {
    const hash = createHash('sha256')
    for await (const bytes of createReadStream(filename)) { hash.update(bytes) }
    return hash.digest('hex')
}
async function sourceIdentity(root) {
    const filenames = execFileSync('git', ['-C', root, 'ls-files', 'ext/js'], {encoding: 'utf8'}).trim().split('\n').filter((name) => name.endsWith('.js'))
    filenames.push('ext/lib/term-bank-parser.wasm', 'test/perf/dictionaries.lock.json')
    return {
        head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
        files: Object.fromEntries(await Promise.all(filenames.map(async (name) => [name, sha256(await readFile(path.join(root, name)))]))),
    }
}

async function observe(root, arm, block, instrumented) {
    const browser = await chromium.launch(getChromiumLaunchOptions({headless: true}))
    const samples = []
    const pending = new Map()
    let nextCommand = 0
    let targetSession
    const browserCdp = await browser.newBrowserCDPSession()
    browserCdp.on('Target.receivedMessageFromTarget', ({sessionId, message}) => {
        if (sessionId !== targetSession) { return }
        const result = JSON.parse(message)
        const entry = pending.get(result.id)
        if (typeof entry === 'undefined') { return }
        pending.delete(result.id)
        clearTimeout(entry.timer)
        if (result.error) { entry.reject(new Error(json(result.error))) }
        else { entry.resolve(result.result) }
    })
    const command = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++nextCommand
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Worker CDP timeout: ${method}`)) }, 20_000)
        pending.set(id, {resolve, reject, timer})
        void browserCdp.send('Target.sendMessageToTarget', {sessionId: targetSession, message: JSON.stringify({id, method, params})}).catch((error) => {
            pending.delete(id)
            clearTimeout(timer)
            reject(error)
        })
    })
    try {
        const context = await browser.newContext()
        await context.route(`${origin}/**`, async (route) => {
            const pathname = new URL(route.request().url()).pathname
            if (pathname === '/') {
                await route.fulfill({contentType: 'text/html', body: '<!doctype html><input type="file" id="archive">'})
                return
            }
            const relative = pathname.slice(1)
            assert.ok(relative.startsWith('ext/'))
            const filename = path.resolve(root, relative)
            assert.ok(filename.startsWith(path.resolve(root, 'ext') + path.sep))
            const body = relative === sourcePath ? instrumented : await readFile(filename)
            await route.fulfill({body, contentType: filename.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'})
        })
        const page = await context.newPage()
        await page.exposeFunction('captureWorkerHeap', async (label) => {
            assert.equal(label, checkpoints[samples.length])
            if (typeof targetSession === 'undefined') {
                const {targetInfos} = await browserCdp.send('Target.getTargets')
                const target = targetInfos.find((entry) => entry.type === 'worker' && entry.url === `${origin}/${sourcePath}`)
                assert.ok(target, 'Expected the real source media preparation worker target')
                const attached = await browserCdp.send('Target.attachToTarget', {targetId: target.targetId, flatten: false})
                targetSession = attached.sessionId
            }
            await command('HeapProfiler.collectGarbage')
            await command('HeapProfiler.collectGarbage')
            const heap = await command('Runtime.getHeapUsage')
            assert.ok(Number.isFinite(heap.usedSize) && heap.usedSize > 0)
            samples.push({label, ...heap})
        })
        await page.goto(origin)
        await page.locator('#archive').setInputFiles(archivePath)
        const output = await page.evaluate(async (workerPath) => await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Media worker timeout')), 90_000)
            const worker = new Worker(workerPath, {type: 'module'})
            const hex = (bytes) => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
            worker.onerror = (event) => { clearTimeout(timeout); reject(new Error(event.message)) }
            worker.onmessage = async ({data}) => {
                try {
                    if (data?.heapCheckpoint) {
                        await window.captureWorkerHeap(data.heapCheckpoint)
                        worker.postMessage({resumeHeapCheckpoint: data.heapCheckpoint})
                        return
                    }
                    if (data === null) { throw new Error('Source media preparation declined') }
                    const {blob, plan, metrics} = data
                    // Hash after all heap checkpoints; this buffer is outside
                    // the observed worker and never contributes to its result.
                    const indexSha256 = hex(await crypto.subtle.digest('SHA-256', plan.index))
                    const sourceSpanSha256 = hex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))
                    clearTimeout(timeout)
                    worker.terminate()
                    resolve({descriptor: plan.descriptor, indexSha256, sourceSpanSha256, metrics})
                } catch (error) { clearTimeout(timeout); worker.terminate(); reject(error) }
            }
            worker.postMessage(document.querySelector('#archive').files[0])
        }), `/${sourcePath}`)
        assert.deepEqual(samples.map(({label}) => label), checkpoints)
        return {complete: true, arm, block, browserVersion: browser.version(), samples, output}
    } finally {
        for (const {timer} of pending.values()) { clearTimeout(timer) }
        await browser.close()
    }
}

await mkdir(destination, {recursive: true})
const originals = {A: await readFile(path.join(baseline, sourcePath), 'utf8'), B: await readFile(path.join(candidate, sourcePath), 'utf8')}
const instrumented = {A: instrument(originals.A), B: instrument(originals.B)}
for (const arm of ['A', 'B']) {
    await writeFile(path.join(destination, `${arm}-worker-original.js`), originals[arm])
    await writeFile(path.join(destination, `${arm}-worker-instrumented.js`), instrumented[arm])
}
const identities = {A: await sourceIdentity(baseline), B: await sourceIdentity(candidate)}
const fixture = JSON.parse(await readFile(path.join(candidate, 'test/perf/dictionaries.lock.json'), 'utf8')).dictionaries.vndb
const archiveSha256 = await hashFile(archivePath)
assert.equal(archiveSha256, fixture.sha256)
const parity = JSON.parse(await readFile(parityPath, 'utf8'))
assert.equal(parity.complete, true)
assert.equal(parity.protocol.archiveSha256, archiveSha256)
const expectedOutput = parity.results[0].output
const protocol = {
    registeredAt: new Date().toISOString(), node: process.version,
    harnessSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    sourceIdentities: identities, archiveSha256, fixture,
    paritySha256: sha256(await readFile(parityPath)), expectedOutput,
    schedule: ['ABC', 'BCA', 'CAB'], checkpoints,
    workerOverlayHashes: {A: sha256(instrumented.A), B: sha256(instrumented.B)},
    scope: 'Actual production source-media worker in fresh Chromium processes. Instrumentation only pauses at named checkpoints for full GC and CDP Runtime.getHeapUsage. This measures retained worker heap/backing storage at those checkpoints, not peak process RSS, and has no latency claim. Complete-import timing is acquired separately with unmodified sources and harness.',
}
await writeFile(path.join(destination, 'protocol.json'), json(protocol))
const observations = []
try {
    for (const [block, order] of protocol.schedule.entries()) {
        for (const arm of order) {
            const variant = arm === 'B' ? 'B' : 'A'
            const observation = await observe(variant === 'B' ? candidate : baseline, arm, block, instrumented[variant])
            const {readMs, validationMs, ...metrics} = observation.output.metrics
            const stableOutput = {...observation.output, metrics}
            assert.deepEqual({descriptor: stableOutput.descriptor, indexSha256: stableOutput.indexSha256, sourceSpanSha256: stableOutput.sourceSpanSha256, ...metrics}, expectedOutput)
            if (observations.length > 0) { assert.deepEqual(stableOutput, observations[0].stableOutput) }
            observations.push({...observation, stableOutput})
            await writeFile(path.join(destination, `${block}-${arm}.json`), json(observation))
            await writeFile(path.join(destination, 'results.partial.json'), json({complete: false, protocol, observations}))
        }
    }
    assert.deepEqual(await sourceIdentity(baseline), identities.A)
    assert.deepEqual(await sourceIdentity(candidate), identities.B)
    assert.equal(await hashFile(archivePath), archiveSha256)
    await writeFile(path.join(destination, 'results.json'), json({complete: true, protocol, observations}))
} catch (error) {
    await writeFile(path.join(destination, 'failure.json'), json({complete: false, error: error.stack, protocol, observations}))
    throw error
}
