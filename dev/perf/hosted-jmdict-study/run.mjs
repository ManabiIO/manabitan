// Temporary, branch-scoped Linux diagnostic. No compilation of native sources.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createWriteStream} from 'node:fs'
import {cp, mkdir, readFile, symlink, writeFile} from 'node:fs/promises'
import {spawn} from 'node:child_process'
import {finished} from 'node:stream/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {ZipReader, Uint8ArrayReader, Uint8ArrayWriter} from '@zip.js/zip.js'
import {getHostEnvironment} from '../host-environment.js'
import {copyDictionaryWasm, loadDictionaryWasm} from '../../dictionary-wasm.js'

const study = fileURLToPath(new URL('./', import.meta.url))
const root = fileURLToPath(new URL('../../../', import.meta.url))
const catalog = JSON.parse(await readFile(path.join(study, 'catalog.json'), 'utf8'))
const phase = process.argv[2]
assert(['prepare', 'components', 'browser'].includes(phase), 'Specify prepare, components or browser')
assert.equal(process.platform, 'linux', 'This diagnostic only runs on Linux')
assert.equal(process.env.GITHUB_REF, `refs/heads/${catalog.branch}`, 'Unexpected diagnostic branch')
assert(process.env.STUDY_EVIDENCE_DIR && process.env.RUNNER_TEMP, 'Missing hosted workspace paths')
const evidence = path.resolve(process.env.STUDY_EVIDENCE_DIR)
const stateFile = path.join(evidence, 'preparation.json')
const started = Number(await readFile(path.join(evidence, 'started-epoch-seconds.txt'), 'utf8'))
assert(Number.isFinite(started) && started > 0, 'Missing study start time')
// Reserve three minutes of the 40-minute job for final artifact retention.
const deadline = started * 1000 + 37 * 60 * 1000
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const fileHash = async filename => sha256(await readFile(filename))
const save = async (filename, value) => {
    await mkdir(path.dirname(filename), {recursive: true})
    await writeFile(filename, JSON.stringify(value, null, 2) + '\n')
}
let commandIndex = 0
const commands = []

async function run(label, command, args, {cwd = root, env = {}, timeoutMs = 600000, directory, required = true, capture = false} = {}) {
    const directoryPath = directory ?? path.join(evidence, 'commands', `${phase}-${String(++commandIndex).padStart(3, '0')}-${label}`)
    await mkdir(directoryPath, {recursive: true})
    const commandFile = path.join(directoryPath, 'command.json')
    const record = {label, command, args, cwd, environmentOverrides: env,
        startedAt: new Date().toISOString(), complete: false, timeoutMs: Math.min(timeoutMs, deadline - Date.now())}
    commands.push(commandFile)
    await save(commandFile, record)
    await save(path.join(directoryPath, 'host-before.json'), getHostEnvironment())
    let stdout = ''
    if (record.timeoutMs < 1000) {
        record.error = 'Study deadline reached; command was not started'
        record.skipped = true
        record.exitCode = null
    } else {
        console.log(`[${phase}] ${label}`)
        const output = createWriteStream(path.join(directoryPath, 'run.log'))
        const child = spawn(command, args, {cwd, env: {...process.env, ...env}, detached: true, stdio: ['ignore', 'pipe', 'pipe']})
        child.stdout.on('data', chunk => { output.write(chunk); if (capture) stdout += chunk.toString() })
        child.stderr.on('data', chunk => output.write(chunk))
        const terminate = signal => {
            if (typeof child.pid === 'number') {
                try { process.kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') record.killError = String(error) }
            }
        }
        let killTimer
        const timer = setTimeout(() => {
            record.timedOut = true
            terminate('SIGTERM')
            killTimer = setTimeout(() => terminate('SIGKILL'), 5000)
        }, record.timeoutMs)
        await new Promise(resolve => {
            child.on('error', error => { record.error = String(error) })
            child.on('close', (code, signal) => {
                clearTimeout(timer)
                clearTimeout(killTimer)
                record.exitCode = code
                record.signal = signal
                // A failed browser command must not leave descendants running.
                if (code !== 0) terminate('SIGKILL')
                resolve()
            })
        })
        output.end()
        await finished(output)
    }
    record.completedAt = new Date().toISOString()
    record.complete = record.exitCode === 0 && !record.timedOut && !record.error
    await save(path.join(directoryPath, 'host-after.json'), getHostEnvironment())
    await save(commandFile, record)
    if (required && !record.complete) throw new Error(`${label} failed; see ${commandFile}`)
    return {...record, stdout}
}

async function checkFrozenInputs() {
    assert.equal(await fileHash(path.join(root, 'package.json')), catalog.packageSha256)
    assert.equal(await fileHash(path.join(root, 'package-lock.json')), catalog.packageLockSha256)
    assert.equal(await fileHash(path.join(root, 'test/perf/dictionaries.lock.json')), catalog.dictionaryLockSha256)
    for (const runner of Object.values(catalog.runners)) assert.equal(await fileHash(path.join(study, runner.file)), runner.sha256)
    for (const [name, hash] of Object.entries(catalog.analysisHashes)) assert.equal(await fileHash(path.join(study, 'runners', name)), hash)
    for (const [name, candidate] of Object.entries(catalog.candidates)) {
        for (const [file, hash] of Object.entries(candidate.nativeFiles)) {
            assert.equal(await fileHash(path.join(study, 'candidates', name, file)), hash)
        }
    }
}

async function packageEntries(filename) {
    const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(await readFile(filename))))
    const result = {}
    try {
        for (const entry of await reader.getEntries()) {
            if (!entry.directory) result[entry.filename] = sha256(await entry.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true}))
        }
    } finally { await reader.close() }
    return result
}

async function verifyArm(arm) {
    for (const [file, hash] of Object.entries(arm.nativeFiles)) assert.equal(await fileHash(path.join(arm.root, file)), hash)
    assert.equal(await fileHash(path.join(arm.root, 'ext/lib/term-bank-parser.wasm')), arm.nativeFiles['dev/data/dictionary-wasm/term-bank-parser.wasm'])
    assert.equal(await fileHash(path.join(arm.root, 'package-lock.json')), catalog.packageLockSha256)
    assert.equal(await fileHash(path.join(arm.root, 'test/perf/dictionaries.lock.json')), catalog.dictionaryLockSha256)
    for (const runner of Object.values(catalog.runners)) assert.equal(await fileHash(path.join(arm.root, runner.destination)), runner.sha256)
    assert.equal(await fileHash(arm.packageFile), arm.packageSha256)
    loadDictionaryWasm(arm.root)
}

async function prepare() {
    await checkFrozenInputs()
    await cp(study, path.join(evidence, 'sources', 'study'), {recursive: true})
    const worktreeRoot = path.join(process.env.RUNNER_TEMP, `jmdict-hosted-study-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`)
    await mkdir(worktreeRoot, {recursive: true})
    const state = {catalogSha256: await fileHash(path.join(study, 'catalog.json')), baselineSha: catalog.baselineSha,
        diagnosticSha: process.env.GITHUB_SHA, host: getHostEnvironment(), prepared: false, arms: {}, fixtures: {}}
    await save(stateFile, state)
    await run('baseline-commit', 'git', ['cat-file', '-e', `${catalog.baselineSha}^{commit}`])
    await run('source-snapshot', 'git', ['archive', '--format=tar.gz', `--output=${path.join(evidence, 'sources', 'baseline.tar.gz')}`, catalog.baselineSha])
    await run('locked-fixtures', process.execPath, ['dev/perf/prepare-dictionaries.js'])
    const fixtures = JSON.parse(await readFile(path.join(root, 'test/perf/dictionaries.lock.json'), 'utf8')).dictionaries
    const cache = path.join(root, 'builds/e2e-dictionary-cache')
    for (const [id, fixture] of Object.entries(fixtures)) {
        const bytes = await readFile(path.join(cache, fixture.cacheFile))
        assert.equal(bytes.length, fixture.sizeBytes)
        assert.equal(sha256(bytes), fixture.sha256)
        state.fixtures[id] = fixture
    }
    state.cache = cache
    const nativePaths = Object.keys(Object.values(catalog.candidates)[0].nativeFiles)
    const baselineNative = Object.fromEntries(await Promise.all(nativePaths.map(async file => [file, await fileHash(path.join(root, file))])))
    for (const name of ['baseline-a', 'baseline-b', ...Object.keys(catalog.candidates)]) {
        const target = path.join(worktreeRoot, name)
        await run(`worktree-${name}`, 'git', ['worktree', 'add', '--detach', target, catalog.baselineSha])
        assert.equal(await fileHash(path.join(target, 'package-lock.json')), catalog.packageLockSha256)
        assert.equal(await fileHash(path.join(target, 'test/perf/dictionaries.lock.json')), catalog.dictionaryLockSha256)
        await symlink(path.join(root, 'node_modules'), path.join(target, 'node_modules'), 'dir')
        await mkdir(path.join(target, 'builds'), {recursive: true})
        await symlink(cache, path.join(target, 'builds/e2e-dictionary-cache'), 'dir')
        const candidate = catalog.candidates[name]
        if (candidate) {
            for (const file of nativePaths) await cp(path.join(study, 'candidates', name, file), path.join(target, file))
        }
        // The only product-source overlays above are the candidate's three native
        // files. Every arm receives the same explicit measurement harness copies.
        for (const runner of Object.values(catalog.runners)) await cp(path.join(study, runner.file), path.join(target, runner.destination))
        await cp(path.join(root, 'ext/lib'), path.join(target, 'ext/lib'), {recursive: true})
        await cp(path.join(root, 'ext/legal-npm.html'), path.join(target, 'ext/legal-npm.html'))
        // Validate all native source/manifest/artifact identities, then replace
        // the copied baseline native modules with this arm's exact pinned bytes.
        copyDictionaryWasm(path.join(target, 'ext/lib'), target)
        await run(`build-${name}`, process.execPath, ['dev/bin/build.js', '--target', 'chrome'], {cwd: target})
        const packageFile = path.join(target, 'builds/manabitan-chrome.zip')
        const entries = await packageEntries(packageFile)
        const sourceDirectory = path.join(evidence, 'sources', name)
        for (const file of nativePaths) {
            await mkdir(path.dirname(path.join(sourceDirectory, file)), {recursive: true})
            await cp(path.join(target, file), path.join(sourceDirectory, file))
        }
        await mkdir(path.join(evidence, 'packages'), {recursive: true})
        await cp(packageFile, path.join(evidence, 'packages', `${name}.zip`))
        await save(path.join(evidence, 'packages', `${name}-entries.json`), entries)
        const arm = {name, root: target, nativeFiles: candidate?.nativeFiles ?? baselineNative,
            packageFile, packageSha256: await fileHash(packageFile), packageEntries: entries}
        await verifyArm(arm)
        state.arms[name] = arm
        await run(`status-${name}`, 'git', ['status', '--porcelain'], {cwd: target})
        await run(`diff-${name}`, 'git', ['diff', '--binary'], {cwd: target})
        await save(stateFile, state)
    }
    const baselineEntries = state.arms['baseline-a'].packageEntries
    for (const [name, arm] of Object.entries(state.arms)) {
        const differences = [...new Set([...Object.keys(baselineEntries), ...Object.keys(arm.packageEntries)])]
            .filter(file => baselineEntries[file] !== arm.packageEntries[file]).sort()
        if (name.startsWith('baseline-')) assert.deepEqual(differences, [])
        else {
            assert(differences.includes('lib/term-bank-parser.wasm'), `${name}: native payload missing from package difference`)
            assert(differences.every(file => ['lib/term-bank-parser.wasm', 'js/dictionary/wasm/term-bank-parser.c'].includes(file)), `${name}: unexpected package differences ${differences}`)
        }
        arm.packageDifferencesFromBaseline = differences
    }
    state.prepared = true
    state.completedAt = new Date().toISOString()
    await save(stateFile, state)
}

async function components(state) {
    const results = []
    const v3Reports = []
    for (const protocol of ['v1', 'v3']) {
        for (const name of ['control', ...Object.keys(catalog.candidates)]) {
            const baseline = state.arms['baseline-a']
            const candidate = state.arms[name === 'control' ? 'baseline-b' : name]
            const directory = path.join(evidence, 'components', protocol, name)
            const reportFile = path.join(directory, 'report.json')
            const pairs = name === 'control' ? catalog.plan[protocol].controlPairs : catalog.plan[protocol].pairs
            const args = ['--expose-gc', path.join(candidate.root, catalog.runners[protocol].destination), 'jmdict',
                '--baseline-root', baseline.root, '--cache-dir', state.cache, '--pairs', String(pairs), '--flags', '{}', '--out', reportFile]
            if (protocol === 'v3') args.push('--candidate-root', candidate.root, '--warmup-pairs', '6', '--passes', '5')
            const result = {protocol, candidate: name, pairs, reportFile, complete: false}
            results.push(result)
            try {
                await verifyArm(baseline)
                await verifyArm(candidate)
                const command = await run(`${protocol}-${name}`, process.execPath, args, {cwd: candidate.root, directory, required: false})
                result.commandComplete = command.complete
                const report = JSON.parse(await readFile(reportFile, 'utf8'))
                assert.equal(report.complete, true, 'Component report incomplete')
                assert(command.complete, 'Component command failed')
                await verifyArm(baseline)
                await verifyArm(candidate)
                result.summary = report.summary
                result.complete = true
            } catch (error) { result.error = String(error) }
            if (protocol === 'v3') v3Reports.push(reportFile)
            await save(path.join(evidence, 'components', 'index.json'), {complete: false, results})
        }
    }
    const validation = await run('v3-oracle-validation', 'python3', [path.join(study, 'runners/validate-import-lookup-v3.py'), ...v3Reports,
        '--out', path.join(evidence, 'components/v3-validation.json')], {required: false})
    const complete = results.every(result => result.complete) && validation.complete
    await save(path.join(evidence, 'components', 'index.json'), {complete, results, validationComplete: validation.complete})
    return complete
}

async function browser(state) {
    const environment = {MANABITAN_E2E_STRICT_RUNTIME: '1', MANABITAN_E2E_USE_PERF_DICTIONARY_LOCK: '1',
        MANABITAN_E2E_IMPORT_USE_PRODUCTION_DEFAULTS: '1', MANABITAN_E2E_PHASE_PROFILING: '0',
        MANABITAN_E2E_PHASE_SCREENSHOTS: '0', MANABITAN_E2E_PROCESS_SAMPLING: '0',
        MANABITAN_CHROMIUM_HEADLESS: '1', MANABITAN_CHROMIUM_BUILD_TARGET: 'chrome', MANABITAN_E2E_SKIP_BUILD: '1'}
    const results = []
    for (const name of Object.keys(catalog.candidates)) {
        const observations = []
        const result = {candidate: name, order: catalog.plan.browserOrder, observations, complete: false}
        results.push(result)
        for (const label of catalog.plan.browserOrder) {
            const arm = state.arms[label[0] === 'A' ? 'baseline-a' : name]
            const directory = path.join(evidence, 'browser', name, label)
            const observation = {label, arm: label[0], pair: Number(label.slice(1)), source: arm.name, complete: false}
            observations.push(observation)
            try {
                await verifyArm(arm)
                const command = await run(`browser-${name}-${label}`, process.execPath, ['dev/perf/import-benchmark.js', 'jmdict',
                    '--runs', '1', '--no-build', '--build-target', 'chrome', '--output', directory],
                {cwd: arm.root, env: environment, directory, timeoutMs: 300000, required: false})
                observation.commandComplete = command.complete
                assert(command.complete, 'Browser command failed')
                const summary = JSON.parse(await readFile(path.join(directory, 'summary.json'), 'utf8'))
                assert.equal(summary.authoritativeTiming, true)
                assert.equal(summary.traceEnabled, false)
                assert.equal(summary.importFlags, null)
                assert.equal(summary.fixture.sha256, state.fixtures.jmdict.sha256)
                assert.equal(summary.runs.length, 1)
                assert.equal(summary.runs[0].packageSha256, arm.packageSha256)
                await verifyArm(arm)
                Object.assign(observation, {complete: true, packageSha256: arm.packageSha256,
                    browserVersion: summary.browserVersion, totalImportMs: summary.runs[0].totalImportMs,
                    workerImportMs: summary.runs[0].workerImportMs, summaryFile: path.join(directory, 'summary.json')})
            } catch (error) { observation.error = String(error) }
            await save(path.join(evidence, 'browser', 'index.json'), {complete: false, results})
        }
        result.complete = observations.every(observation => observation.complete)
    }
    const complete = results.every(result => result.complete)
    await save(path.join(evidence, 'browser', 'index.json'), {complete, results})
    return complete
}

const statusFile = path.join(evidence, `${phase}-status.json`)
let complete = false
try {
    await save(statusFile, {phase, complete: false, startedAt: new Date().toISOString(), host: getHostEnvironment()})
    await checkFrozenInputs()
    if (phase === 'prepare') { await prepare(); complete = true }
    else {
        const state = JSON.parse(await readFile(stateFile, 'utf8'))
        assert.equal(state.prepared, true, 'Preparation did not complete')
        assert.equal(state.catalogSha256, await fileHash(path.join(study, 'catalog.json')))
        complete = phase === 'components' ? await components(state) : await browser(state)
    }
    await save(statusFile, {phase, complete, commands, finishedAt: new Date().toISOString(), host: getHostEnvironment()})
} catch (error) {
    await save(statusFile, {phase, complete: false, error: String(error), commands, finishedAt: new Date().toISOString(), host: getHostEnvironment()})
    console.error(error)
}
if (!complete) process.exitCode = 1
