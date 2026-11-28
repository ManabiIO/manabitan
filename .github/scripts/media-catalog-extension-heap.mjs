import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {chromium} from 'playwright'
import {getChromiumLaunchOptions} from '../../test/e2e/chromium-launch-options.js'

const args = process.argv.slice(2)
const option = (name) => {
    const index = args.indexOf(name)
    assert(index >= 0 && index + 1 < args.length, `Missing ${name}`)
    return path.resolve(args[index + 1])
}
const baseline = option('--baseline')
const candidate = option('--candidate')
const archivePath = option('--archive')
const destination = option('--out')
const parityPath = option('--parity')
const packagePaths = {A: option('--baseline-package'), B: option('--candidate-package')}
const workerPath = 'js/dictionary/source-zip-media-preparation-worker.js'
const helperPage = 'media-catalog-heap.html'
const helperParent = 'media-catalog-heap-parent.js'
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const json = (value) => JSON.stringify(value, null, 2) + '\n'
const checkpoints = ['beforeCatalog', 'catalogReady', 'beforeFirstRead', 'afterRead1', 'afterRead72', 'afterRead144', 'afterPack']
const capabilityKeys = ['sharedArrayBufferConstructor', 'atomics', 'crossOriginIsolated', 'secureContext']
const capabilityBody = `({
    sharedArrayBufferConstructor: typeof SharedArrayBuffer === 'function',
    atomics: typeof Atomics === 'object',
    crossOriginIsolated: self.crossOriginIsolated,
    secureContext: self.isSecureContext,
    origin: self.location.origin,
    location: self.location.href,
    scope: self.constructor.name,
})`
const parentSource = `
const child = new Worker(new URL('./${workerPath}', import.meta.url), {type: 'module'})
self.addEventListener('message', ({data}) => child.postMessage(data))
child.onmessage = ({data}) => {
    const transfer = data?.plan?.index?.buffer instanceof ArrayBuffer ? [data.plan.index.buffer] : []
    self.postMessage(data, transfer)
}
child.onerror = (event) => self.postMessage({bridgeFailure: event.message})
self.postMessage({bridgeReady: ${capabilityBody}})
`
const injection = `
let observedNativeMemory = null
const originalInstantiate = WebAssembly.instantiate
WebAssembly.instantiate = async function (...args) {
    const result = await originalInstantiate.apply(WebAssembly, args)
    const instance = result instanceof WebAssembly.Instance ? result : result.instance
    if (instance.exports.memory instanceof WebAssembly.Memory) { observedNativeMemory = instance.exports.memory }
    return result
}
async function heapCheckpoint(label) {
    await new Promise((resolve) => {
        function resume(event) {
            if (event.data?.resumeHeapCheckpoint !== label) { return }
            self.removeEventListener('message', resume)
            resolve()
        }
        self.addEventListener('message', resume)
        self.postMessage({heapCheckpoint: label, capabilities: {
            ...${capabilityBody},
            nativeMemoryShared: observedNativeMemory === null ? null : Object.prototype.toString.call(observedNativeMemory.buffer) === '[object SharedArrayBuffer]',
            nativeMemoryBytes: observedNativeMemory === null ? null : observedNativeMemory.buffer.byteLength,
        }})
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
    filenames.push('ext/lib/term-bank-parser.wasm', 'dev/data/dictionary-wasm/manifest.json', 'test/perf/dictionaries.lock.json')
    return {head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
        files: Object.fromEntries(await Promise.all(filenames.map(async (name) => [name, sha256(await readFile(path.join(root, name)))])))}
}
function packageIdentity(archive, target) {
    return JSON.parse(execFileSync('python', ['-c', `
import hashlib, json, pathlib, sys, zipfile
archive, destination = sys.argv[1:]
root = pathlib.Path(destination).resolve()
entries = {}
with zipfile.ZipFile(archive) as source:
    for entry in source.infolist():
        name = pathlib.PurePosixPath(entry.filename)
        assert not name.is_absolute() and '..' not in name.parts
        if entry.is_dir():
            continue
        assert entry.filename not in entries
        data = source.read(entry)
        entries[entry.filename] = hashlib.sha256(data).hexdigest()
        target = root / entry.filename
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
print(json.dumps(entries))
`, archive, target], {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024}))
}

async function observe(extension, arm, block, executable) {
    const observation = {complete: false, arm, block, samples: [], parentCapabilities: null,
        lastCheckpoint: null, currentCapabilities: null, startedAt: new Date().toISOString()}
    const partialPath = path.join(destination, `${block}-${arm}.partial.json`)
    const persist = async () => { await writeFile(partialPath, json(observation)) }
    await persist()
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'media-catalog-extension-heap-'))
    let context
    const pending = new Map()
    try {
        context = await chromium.launchPersistentContext(userDataDir, getChromiumLaunchOptions({
            headless: true, executablePath: executable.path,
            args: ['--disable-features=MacAppCodeSignClone', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
        }))
        const browser = context.browser()
        assert(browser)
        observation.browserVersion = browser.version()
        await persist()
        assert.equal(observation.browserVersion, executable.version)
        let serviceWorker = context.serviceWorkers().find((worker) => worker.url().startsWith('chrome-extension://'))
        serviceWorker ??= await context.waitForEvent('serviceworker', {predicate: (worker) => worker.url().startsWith('chrome-extension://'), timeout: 30_000})
        // WHATWG origin serialization for non-special schemes can be "null".
        const extensionBase = serviceWorker.url().match(/^chrome-extension:\/\/[^/]+/)[0]
        observation.extensionBase = extensionBase
        observation.serviceWorkerCapabilities = await serviceWorker.evaluate(() => ({
            sharedArrayBufferConstructor: typeof SharedArrayBuffer === 'function', atomics: typeof Atomics === 'object',
            crossOriginIsolated: self.crossOriginIsolated, secureContext: self.isSecureContext,
            origin: self.location.origin, location: self.location.href, scope: self.constructor.name,
        }))
        await persist()
        const browserCdp = await browser.newBrowserCDPSession()
        let targetSession
        let nextCommand = 0
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
        const page = await context.newPage()
        await page.exposeFunction('captureParentCapabilities', async (capabilities) => {
            observation.parentCapabilities = capabilities
            await persist()
            assert.equal(capabilities.scope, 'DedicatedWorkerGlobalScope')
            assert.equal(capabilities.sharedArrayBufferConstructor, true)
            assert.equal(capabilities.atomics, true)
            assert.equal(capabilities.secureContext, true)
            assert.equal(capabilities.location, `${extensionBase}/${helperParent}`)
            for (const key of capabilityKeys) { assert.equal(capabilities[key], observation.serviceWorkerCapabilities[key], `Parent/service worker capability: ${key}`) }
        })
        await page.exposeFunction('captureWorkerHeap', async (label, capabilities) => {
            observation.lastCheckpoint = label
            observation.currentCapabilities = capabilities
            await persist()
            assert.equal(label, checkpoints[observation.samples.length])
            assert.equal(capabilities.scope, 'DedicatedWorkerGlobalScope')
            assert.equal(capabilities.location, `${extensionBase}/${workerPath}`)
            assert.equal(capabilities.origin, observation.parentCapabilities.origin)
            for (const key of capabilityKeys) { assert.equal(capabilities[key], observation.parentCapabilities[key], `Child/parent worker capability: ${key}`) }
            if (typeof targetSession === 'undefined') {
                const {targetInfos} = await browserCdp.send('Target.getTargets')
                const targets = targetInfos.filter((entry) => entry.type === 'worker' && entry.url === `${extensionBase}/${workerPath}`)
                assert.equal(targets.length, 1, 'Expected exactly one real source media preparation worker target')
                observation.targetInfo = targets[0]
                const attached = await browserCdp.send('Target.attachToTarget', {targetId: targets[0].targetId, flatten: false})
                targetSession = attached.sessionId
            }
            await command('HeapProfiler.collectGarbage')
            await command('HeapProfiler.collectGarbage')
            const heap = await command('Runtime.getHeapUsage')
            // Keep the raw result even if a required metric or capability fails.
            observation.samples.push({label, ...heap, capabilities})
            await persist()
            assert.ok(Number.isFinite(heap.usedSize) && heap.usedSize > 0)
            assert.ok(Number.isFinite(heap.backingStorageSize) && heap.backingStorageSize >= 0)
            if (label === 'afterPack') {
                assert.equal(capabilities.nativeMemoryShared, true)
                assert.ok(Number.isSafeInteger(capabilities.nativeMemoryBytes) && capabilities.nativeMemoryBytes > 0)
            }
        })
        await page.goto(`${extensionBase}/${helperPage}`)
        await page.locator('#archive').setInputFiles(archivePath)
        observation.output = await page.evaluate(async ({parentPath}) => await new Promise((resolve, reject) => {
            const parent = new Worker(parentPath, {type: 'module'})
            const fail = (error) => { clearTimeout(timeout); parent.terminate(); reject(error) }
            const timeout = setTimeout(() => fail(new Error('Media worker timeout')), 90_000)
            const hex = (bytes) => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
            parent.onerror = (event) => fail(new Error(event.message))
            parent.onmessage = async ({data}) => {
                try {
                    if (data?.bridgeReady) {
                        await window.captureParentCapabilities(data.bridgeReady)
                        parent.postMessage(document.querySelector('#archive').files[0])
                        return
                    }
                    if (data?.bridgeFailure) { throw new Error(data.bridgeFailure) }
                    if (data?.heapCheckpoint) {
                        await window.captureWorkerHeap(data.heapCheckpoint, data.capabilities)
                        parent.postMessage({resumeHeapCheckpoint: data.heapCheckpoint})
                        return
                    }
                    if (data === null) { throw new Error('Source media preparation declined') }
                    const {blob, plan, metrics} = data
                    const indexSha256 = hex(await crypto.subtle.digest('SHA-256', plan.index))
                    const sourceSpanSha256 = hex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))
                    clearTimeout(timeout)
                    parent.terminate()
                    resolve({descriptor: plan.descriptor, indexSha256, sourceSpanSha256, metrics})
                } catch (error) { fail(error) }
            }
        }), {parentPath: `/${helperParent}`})
        assert.deepEqual(observation.samples.map(({label}) => label), checkpoints)
        observation.complete = true
        observation.finishedAt = new Date().toISOString()
        await persist()
        return observation
    } catch (error) {
        observation.error = error.stack ?? String(error)
        observation.failedAt = new Date().toISOString()
        await persist()
        await writeFile(path.join(destination, `${block}-${arm}.failure.json`), json(observation))
        throw error
    } finally {
        for (const {timer} of pending.values()) { clearTimeout(timer) }
        await context?.close()
        await rm(userDataDir, {recursive: true, force: true})
    }
}

await mkdir(destination, {recursive: true})
const temporary = await mkdtemp(path.join(os.tmpdir(), 'media-catalog-extension-packages-'))
let protocol
const observations = []
try {
    const executablePath = chromium.executablePath()
    const versionOutput = execFileSync(executablePath, ['--version'], {encoding: 'utf8'}).trim()
    const executable = {path: executablePath, sha256: await hashFile(executablePath), versionOutput, version: versionOutput.match(/\d+\.\d+\.\d+\.\d+/)[0]}
    const identities = {A: await sourceIdentity(baseline), B: await sourceIdentity(candidate)}
    const fixture = JSON.parse(await readFile(path.join(candidate, 'test/perf/dictionaries.lock.json'), 'utf8')).dictionaries.vndb
    const archiveSha256 = await hashFile(archivePath)
    assert.equal(archiveSha256, fixture.sha256)
    const parity = JSON.parse(await readFile(parityPath, 'utf8'))
    assert.equal(parity.complete, true)
    assert.equal(parity.protocol.archiveSha256, archiveSha256)
    const expectedOutput = parity.results[0].output
    const packages = {}
    for (const arm of ['A', 'B']) {
        const extension = path.join(temporary, arm)
        const entries = packageIdentity(packagePaths[arm], extension)
        assert(!(helperPage in entries) && !(helperParent in entries))
        const original = await readFile(path.join(extension, workerPath), 'utf8')
        const instrumented = instrument(original)
        const pageSource = '<!doctype html><input type="file" id="archive">'
        await writeFile(path.join(extension, workerPath), instrumented)
        await writeFile(path.join(extension, helperParent), parentSource)
        await writeFile(path.join(extension, helperPage), pageSource)
        const instrumentedEntries = {...entries, [workerPath]: sha256(instrumented), [helperParent]: sha256(parentSource), [helperPage]: sha256(pageSource)}
        packages[arm] = {extension, path: packagePaths[arm], sha256: await hashFile(packagePaths[arm]), entries,
            instrumentedEntries, instrumentedIdentity: sha256(json(instrumentedEntries)),
            manifest: JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'))}
        await writeFile(path.join(destination, `${arm}-worker-original.js`), original)
        await writeFile(path.join(destination, `${arm}-worker-instrumented.js`), instrumented)
    }
    assert.deepEqual(Object.keys(packages.A.entries).sort(), Object.keys(packages.B.entries).sort())
    const changedEntries = Object.keys(packages.A.entries).filter((name) => packages.A.entries[name] !== packages.B.entries[name]).sort()
    assert.deepEqual(changedEntries, ['js/dictionary/dense-zip-directory.js', 'js/dictionary/dense-zip-file-map.js', 'js/dictionary/source-zip-media-pack.js', workerPath].sort())
    assert.deepEqual(packages.B.manifest, packages.A.manifest)
    assert.equal(packages.A.manifest.manifest_version, 3)
    protocol = {registeredAt: new Date().toISOString(), node: process.version, executable, sourceIdentities: identities,
        harnessSha256: sha256(await readFile(fileURLToPath(import.meta.url))), packages, changedEntries, archiveSha256, fixture,
        paritySha256: sha256(await readFile(parityPath)), expectedOutput, schedule: ['ABC', 'BCA', 'CAB'], checkpoints,
        primaryCheckpoint: 'catalogReady', primaryMetric: 'Runtime.getHeapUsage.usedSize + backingStorageSize',
        scope: 'Real source-media worker in the same packaged Chrome extension manifest/origin and full Chromium executable as complete imports, launched as a nested dedicated worker through a bounded diagnostic bridge. Forced-GC retained JS heap and reported backing storage at named checkpoints; not peak process RSS or whole-import latency. Parent/service/child capabilities must agree, and native shared-memory creation plus complete output parity must pass. The previous HTTP/headless-shell cohort is prospectively sensitivity-only and remains preserved.'}
    await writeFile(path.join(destination, 'protocol.json'), json(protocol))
    await writeFile(path.join(destination, 'parent-bridge.js'), parentSource)
    for (const [block, order] of protocol.schedule.entries()) {
        for (const arm of order) {
            const variant = arm === 'B' ? 'B' : 'A'
            const observation = await observe(packages[variant].extension, arm, block, executable)
            const {readMs, validationMs, ...metrics} = observation.output.metrics
            const stableOutput = {...observation.output, metrics}
            observations.push({...observation, stableOutput, qualified: false})
            // Persist completed attempts before the output qualification checks.
            await writeFile(path.join(destination, `${block}-${arm}.json`), json(observation))
            await writeFile(path.join(destination, 'results.partial.json'), json({complete: false, protocol, observations}))
            assert.deepEqual({descriptor: stableOutput.descriptor, indexSha256: stableOutput.indexSha256, sourceSpanSha256: stableOutput.sourceSpanSha256, ...metrics}, expectedOutput)
            if (observations.length > 1) { assert.deepEqual(stableOutput, observations[0].stableOutput) }
            observations[observations.length - 1].qualified = true
            await writeFile(path.join(destination, 'results.partial.json'), json({complete: false, protocol, observations}))
        }
    }
    assert.deepEqual(await sourceIdentity(baseline), identities.A)
    assert.deepEqual(await sourceIdentity(candidate), identities.B)
    assert.equal(await hashFile(archivePath), archiveSha256)
    assert.equal(await hashFile(executablePath), executable.sha256)
    for (const arm of ['A', 'B']) {
        assert.equal(await hashFile(packagePaths[arm]), packages[arm].sha256)
        for (const [name, digest] of Object.entries(packages[arm].instrumentedEntries)) {
            assert.equal(await hashFile(path.join(packages[arm].extension, name)), digest)
        }
    }
    await writeFile(path.join(destination, 'results.json'), json({complete: true, protocol, observations}))
} catch (error) {
    await writeFile(path.join(destination, 'failure.json'), json({complete: false, error: error.stack ?? String(error), protocol, observations}))
    throw error
} finally {
    await rm(temporary, {recursive: true, force: true})
}
