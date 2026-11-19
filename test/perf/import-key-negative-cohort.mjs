// SPDX-License-Identifier: GPL-3.0-or-later
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {spawn, execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {lstat, mkdir, open, readFile, readdir, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {performance} from 'node:perf_hooks'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {parseArgs} from 'node:util'
import {crc32} from 'node:zlib'

// This is a native-only negative control, not a dictionary import benchmark.
// Example: node test/perf/import-key-negative-cohort.mjs --baseline /base
//          --candidate /candidate --output /fresh/evidence
const plan = {
    rounds: 12,
    warmupsPerChild: 3,
    measuredRepetitionsPerChild: 10,
    rowsPerFixture: 20000,
    groupsPerFixture: 1,
    arms: {A: 'combined baseline', B: 'combined baseline plus adjacent key reuse', C: 'identical baseline A'},
    permutations: ['ABC', 'BCA', 'CAB', 'ACB', 'CBA', 'BAC'],
}
const limitation = 'Only the synchronous native fused parse/content encoding/key interning export is timed. Excludes fixture generation, UTF-8 encoding, source inflation and CRC, WASM compilation, JS allocation/setup, copying, lookup preparation, worker concurrency/transport, compression, storage, and UI. CPU counters are process-wide and include concurrent runtime threads. Three complete fixture warmups and explicit GC precede ten measured repetitions in each fresh Node child. A complete untimed output fingerprint follows measurements. No whole-import claim, timing retries, outlier removal, or optional stopping.'
const fixtureFile = 'test/fixtures/key-reuse/inputs.mjs'
const runner = fileURLToPath(import.meta.url)
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const runnerSha256 = sha(await readFile(runner))
const supersedesRunnerSha256 = '3c3ade3d3b28f5366575ddc4fbda252eb4952a9e9afa82f83df72ee2fbb5b066'
const {values} = parseArgs({options: {
    baseline: {type: 'string'},
    candidate: {type: 'string'},
    output: {type: 'string'},
    'initial-order': {type: 'string', default: 'ABC'},
    child: {type: 'boolean', default: false},
    'verify-only': {type: 'boolean', default: false},
    'source-root': {type: 'string'},
    'fixture-root': {type: 'string'},
}})
assert(values.output, 'Provide --output')
assert(!values['verify-only'] || values.child, '--verify-only requires --child')
assert(plan.permutations.includes(values['initial-order']), 'Invalid initial order')
const output = path.resolve(values.output)
const load = (root, file) => {
    // Caller-selected local checkouts; imported suffixes are fixed by this file.
    // eslint-disable-next-line no-unsanitized/method
    return import(pathToFileURL(path.join(root, file)))
}
const median = (numbers) => {
    const sorted = [...numbers].sort((a, b) => a - b)
    return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2
}

async function requireNewOutput(file) {
    try {
        await lstat(file)
        throw new Error('Output already exists; choose a new evidence path')
    } catch (error) {
        if (error.code !== 'ENOENT') { throw error }
    }
}

async function identity(root, allowDirty = false) {
    const runtime = createHash('sha256')
    const shared = createHash('sha256')
    async function walk(directory) {
        const entries = await readdir(path.join(root, directory), {withFileTypes: true})
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            const file = path.join(directory, entry.name)
            if (entry.isDirectory()) {
                await walk(file)
            } else if (/\.(js|json|c|h|wasm)$/.test(file)) {
                const normalizedFile = file.split(path.sep).join('/')
                const record = `${normalizedFile}\0${sha(await readFile(path.join(root, file)))}\n`
                runtime.update(record)
                if (/\.(js|json)$/.test(file) && normalizedFile.startsWith('ext/js/')) { shared.update(record) }
            }
        }
    }
    await walk('ext/js')
    await walk('dev/data/dictionary-wasm')
    const files = {}
    for (const file of ['package-lock.json', 'dev/dictionary-wasm.js', 'ext/js/dictionary/wasm/term-bank-parser.c', 'dev/data/dictionary-wasm/manifest.json']) {
        files[file] = sha(await readFile(path.join(root, file)))
    }
    const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trim()
    const dirty = git('status', '--porcelain').length > 0
    if (!allowDirty) { assert.equal(dirty, false, 'Use immutable clean source checkouts') }
    const {loadDictionaryWasm} = await load(root, 'dev/dictionary-wasm.js')
    const wasm = Object.fromEntries([...loadDictionaryWasm(root)].map(([name, bytes]) => [name, sha(bytes)]))
    const manifest = JSON.parse(await readFile(path.join(root, 'dev/data/dictionary-wasm/manifest.json'), 'utf8'))
    return {root,
        gitSha: git('rev-parse', 'HEAD'),
        tree: git('rev-parse', 'HEAD^{tree}'),
        dirty,
        runtimeSha256: runtime.digest('hex'),
        sharedJsSha256: shared.digest('hex'),
        files,
        wasm,
        toolchain: manifest.toolchain}
}

async function fixture(root) {
    const generatorSha256 = sha(await readFile(path.join(root, fixtureFile)))
    const {createUniqueKeyBanks} = await load(root, fixtureFile)
    const rawBanks = createUniqueKeyBanks(plan.rowsPerFixture)
    assert.equal(rawBanks.length, 2)
    const expressions = new Set()
    const readings = new Set()
    for (const bank of rawBanks) {
        const rows = JSON.parse(bank)
        assert.equal(rows.length, 10000)
        for (const row of rows) {
            assert.equal(typeof row[0], 'string')
            assert.equal(typeof row[1], 'string')
            expressions.add(row[0])
            readings.add(row[1])
        }
    }
    assert.equal(expressions.size, plan.rowsPerFixture)
    assert.equal(readings.size, plan.rowsPerFixture)
    assert.equal(new Set([...expressions, ...readings]).size, plan.rowsPerFixture * 2)
    const encoder = new TextEncoder()
    const banks = rawBanks.map((bank) => encoder.encode(bank))
    const hash = createHash('sha256')
    for (const bank of banks) { hash.update(`${bank.length}\0`).update(bank) }
    return {banks,
        provenance: {name: 'All-unique common-prefix keys',
            generatorFile: fixtureFile,
            generatorSha256,
            sourceSha256: hash.digest('hex'),
            rows: plan.rowsPerFixture,
            uniqueExpressions: expressions.size,
            uniqueReadings: readings.size,
            bankBytes: banks.map((bank) => bank.length),
            groups: [banks.map((bank, index) => `term_bank_${index + 1}.json`)]}}
}

// Hash the owned output after untimed lookup preparation has completed.
// Physical heap addresses and timing fields are deliberately not output data.
function fingerprint(hash, chunk) {
    const add = (name, bytes) => {
        hash.update(`${name}:${bytes?.constructor.name}:${bytes?.byteLength}\0`)
        if (ArrayBuffer.isView(bytes)) { hash.update(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)) }
    }
    hash.update(`rows:${chunk.rowCount}:start:${chunk.contentRowStart}\0`)
    for (const key of ['readingEqualsExpressionList', 'scoreList', 'sequenceList', 'contentMetaList', 'contentUniqueIndexList', 'contentHash1List', 'contentHash2List']) { add(key, chunk[key]) }
    assert(chunk.contentBytesBuffer instanceof Uint8Array)
    assert(Number.isSafeInteger(chunk.contentBytesLength) && chunk.contentBytesLength >= 0)
    const start = chunk.contentBytesBaseOffset ?? 0
    assert(Number.isSafeInteger(start) && start >= 0 && start + chunk.contentBytesLength <= chunk.contentBytesBuffer.length)
    add('content', chunk.contentBytesBuffer.subarray(start, start + chunk.contentBytesLength))
    for (const key of ['expressionBytesList', 'readingBytesList', 'contentBytesList']) {
        hash.update(`${key}:${chunk[key].length}\0`)
        for (const bytes of chunk[key]) { add(key, bytes) }
    }
    const addPlan = (prefix, value) => {
        assert(value)
        for (const key of ['stringLengths', 'stringOffsets', 'stringHashes', 'stringsBuffer', 'expressionIndexes', 'readingIndexes']) { add(`${prefix}:${key}`, value[key]) }
    }
    addPlan('plan', chunk.termRecordPreinternedPlan)
    const dedup = chunk.contentDedupPlan
    assert(dedup)
    hash.update(`dedup:${dedup.uniqueCount}:${dedup.sourceRowCount}:${chunk.useResolvedContentReferences}\0`)
    for (const key of ['uniqueRowIndexes', 'uniqueSignatures', 'resolvedFlags', 'resolvedOffsets', 'resolvedLengths', 'pendingEpochs', 'pendingIndexes', 'pendingSpanOffsetsScratch', 'pendingSpanLengthsScratch']) { add(`dedup:${key}`, dedup[key]) }
    for (const key of ['resolvedDictNames', 'resolvedUniformDictName', 'nextEpoch', 'nextUnresolvedUniqueIndex', 'persistedLookupRequired']) { hash.update(`dedup:${key}:${JSON.stringify(dedup[key])}\0`) }
    assert.deepEqual(chunk.mediaRows, [])
    hash.update(`mediaRows:${JSON.stringify(chunk.mediaRows)}\0`)
    hash.update(`lookups:${chunk.preparedLookupIndexes.size}\0`)
    for (const [key, prepared] of chunk.preparedLookupIndexes) {
        add(`lookup:${key}`, prepared.bytes)
        addPlan(`lookup:${key}`, prepared.preinternedPlan)
    }
}

async function runChild() {
    assert(values['source-root'] && values['fixture-root'], 'Child requires source and fixture roots')
    const root = path.resolve(values['source-root'])
    const fixtureRoot = path.resolve(values['fixture-root'])
    const verifyOnly = values['verify-only']
    await requireNewOutput(output)
    await mkdir(path.dirname(output), {recursive: true})
    const report = {schemaVersion: 2,
        complete: false,
        kind: verifyOnly ? 'native-key-negative-verification' : 'native-key-negative-sample',
        mode: verifyOnly ? 'verify-only' : 'timed',
        plan: verifyOnly ? {...plan, warmupsPerChild: 0, measuredRepetitionsPerChild: 0} : plan,
        limitation: verifyOnly ? 'Untimed complete-fixture smoke check only. No native CPU or wall timers, warmups, measured repetitions, or performance claims. Dirty local snapshots are identified by exact runtime/WASM hashes; timed cohorts still require clean checkouts.' : limitation,
        runnerSha256,
        supersedesRunnerSha256,
        node: process.version,
        v8: process.versions.v8,
        startedAt: new Date().toISOString(),
        startLoad: os.loadavg(),
        warmups: [],
        measurements: []}
    const save = () => writeFile(output, JSON.stringify(report, null, 2) + '\n')
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'})
    try {
        report.source = await identity(root, verifyOnly)
        const {banks, provenance} = await fixture(fixtureRoot)
        report.fixture = provenance
        const {loadDictionaryWasm} = await load(root, 'dev/dictionary-wasm.js')
        const wasmBytes = loadDictionaryWasm(root).get('term-bank-parser.wasm')
        assert(wasmBytes)
        const parser = await load(root, 'ext/js/dictionary/term-bank-wasm-parser.js')
        const preparation = await load(root, 'ext/js/dictionary/term-lookup-index-preparation.js')
        const {snapshotTermBankExperiments} = await load(root, 'ext/js/dictionary/term-bank-experiments.js')
        const flags = snapshotTermBankExperiments({})
        report.flags = flags
        parser.setTermBankWasmModule(await WebAssembly.compile(wasmBytes))
        const bytes = banks[0]
        const initialized = await parser.inflateCompressedTermBankSourcesWasm([{bytes,
            compressionMethod: 0,
            compressedSize: bytes.length,
            uncompressedSize: bytes.length,
            signature: crc32(bytes)}], flags)
        const wasm = initialized.wasm
        assert(wasm && typeof wasm.parse_and_encode_term_bank_token_binary_dedup === 'function')
        const nativeExport = wasm.parse_and_encode_term_bank_token_binary_dedup
        let calls = []
        let timed = false
        wasm.parse_and_encode_term_bank_token_binary_dedup = (...args) => {
            const cpuStart = timed ? process.cpuUsage() : null
            const wallStart = timed ? performance.now() : 0
            const returned = nativeExport(...args)
            const wallMs = timed ? performance.now() - wallStart : null
            const cpu = timed ? process.cpuUsage(cpuStart) : null
            calls.push({returned,
                inputBytes: args[1],
                rows: new Uint32Array(wasm.memory.buffer, args[12], 1)[0],
                wallMs,
                cpuMs: cpu === null ? null : (cpu.user + cpu.system) / 1000,
                userCpuMs: cpu === null ? null : cpu.user / 1000,
                systemCpuMs: cpu === null ? null : cpu.system / 1000})
            return returned
        }
        async function runFixture(hash = null) {
            calls = []
            report.lastAttemptNativeCalls = calls
            timed = hash === null
            assert(!verifyOnly || !timed, 'Verification-only mode must never enable native timing')
            let callbackCount = 0
            let rows = 0
            let stable = null
            await parser.parseTermBankWithWasmColumnChunks(banks, 3, (chunk) => {
                ++callbackCount
                rows += chunk.rowCount
                if (hash !== null) {
                    stable = parser.copyWasmBackedColumnChunk(chunk, true)
                }
            }, 2048, {singleChunk: true,
                maxPendingChunks: 1,
                emitTermByteLists: false,
                computeContentHashes: true,
                emitContentSlab: true,
                emitTokenBinaryContent: true,
                mediaHintFastScan: true,
                validateGlossaryTypes: true,
                prepareLookupIndexes: true,
                ...flags})
            assert.equal(callbackCount, 1)
            assert.equal(calls.length, 1, 'Expected one native fused call for both banks')
            const [native] = calls
            assert(native.returned >= 0, 'Native fused call fell back or failed')
            assert.equal(native.rows, plan.rowsPerFixture)
            assert.equal(rows, plan.rowsPerFixture)
            const profile = parser.consumeLastTermBankWasmParseProfile()
            assert(profile)
            assert.deepEqual(profile.experiments, flags)
            assert.equal(profile.fusedParseAttempts, 1)
            assert.equal(profile.fusedParseFallbacks, 0)
            let lookupPreparation = null
            let preparedLookupIndexCount = null
            if (hash !== null) {
                assert(stable)
                // Native fused success does not imply native lookup eligibility.
                // Complete missing indexes outside every native timing window.
                lookupPreparation = 'native'
                if (!(stable.preparedLookupIndexes instanceof Map)) {
                    const prepared = preparation.prepareTermLookupIndexesFromPreinternedPlan(stable, null, flags)
                    assert(prepared, 'Lookup preparation did not produce indexes')
                    stable.preparedLookupIndexes = prepared.indexes
                    lookupPreparation = 'js-after-timing'
                }
                assert(preparation.hasCompletePreparedTermLookupIndexes(stable.preparedLookupIndexes, rows))
                preparedLookupIndexCount = stable.preparedLookupIndexes.size
                fingerprint(hash, stable)
            }
            return {...native,
                fusedParseAttempts: profile.fusedParseAttempts,
                fusedParseFallbacks: profile.fusedParseFallbacks,
                maxWasmHeapBytes: profile.maxWasmHeapBytes,
                lookupPreparation,
                preparedLookupIndexCount}
        }
        if (!verifyOnly) {
            for (let repetition = 1; repetition <= plan.warmupsPerChild; ++repetition) {
                report.warmups.push({repetition, ...await runFixture()})
                await save()
            }
            assert.equal(typeof globalThis.gc, 'function', 'Child must run with --expose-gc')
            globalThis.gc()
            for (let repetition = 1; repetition <= plan.measuredRepetitionsPerChild; ++repetition) {
                report.measurements.push({repetition, ...await runFixture()})
                await save()
            }
        }
        const hash = createHash('sha256')
        const verified = await runFixture(hash)
        report.verification = {...verified, digest: hash.digest('hex')}
        report.measured = verifyOnly ?
    null :
    {fixtureRepetitions: plan.measuredRepetitionsPerChild,
        rows: report.measurements.reduce((sum, sample) => sum + sample.rows, 0),
        cpuMs: report.measurements.reduce((sum, sample) => sum + sample.cpuMs, 0),
        wallMs: report.measurements.reduce((sum, sample) => sum + sample.wallMs, 0),
        medianFixtureCpuMs: median(report.measurements.map((sample) => sample.cpuMs)),
        medianFixtureWallMs: median(report.measurements.map((sample) => sample.wallMs))}
        assert.deepEqual(await identity(root, verifyOnly), report.source, 'Source or WASM changed during observation')
        assert.equal(sha(await readFile(path.join(fixtureRoot, fixtureFile))), provenance.generatorSha256, 'Fixture generator changed')
        assert.equal(sha(await readFile(runner)), runnerSha256, 'Runner changed during observation')
        report.complete = true
        report.completedAt = new Date().toISOString()
        report.endLoad = os.loadavg()
        await save()
    } catch (error) {
        report.error = String(error?.stack ?? error)
        await save()
        throw error
    }
}

function compare(a, b) {
    const deltas = a.map((value, index) => (b[index] / value - 1) * 100)
    return {baselineMedianMs: median(a),
        comparisonMedianMs: median(b),
        medianPairedDeltaPercent: median(deltas),
        equalWorkDeltaPercent: (b.reduce((sum, value) => sum + value, 0) / a.reduce((sum, value) => sum + value, 0) - 1) * 100,
        fasterRounds: deltas.filter((delta) => delta < 0).length,
        worstPairDeltaPercent: Math.max(...deltas),
        pairedDeltaPercent: deltas}
}

async function runCohort() {
    assert(values.baseline && values.candidate, 'Provide --baseline and --candidate')
    const rootA = path.resolve(values.baseline)
    const rootB = path.resolve(values.candidate)
    const roots = {A: rootA, B: rootB, C: rootA}
    await requireNewOutput(output)
    await mkdir(path.dirname(output), {recursive: true})
    await mkdir(output)
    const startOrder = plan.permutations.indexOf(values['initial-order'])
    const report = {schemaVersion: 2,
        complete: false,
        kind: 'native-key-negative-cohort',
        plan,
        limitation,
        runnerSha256,
        supersedesRunnerSha256,
        node: process.version,
        v8: process.versions.v8,
        startOrder,
        startedAt: new Date().toISOString(),
        host: {platform: process.platform,
            arch: process.arch,
            cpus: os.cpus().map(({model, speed}) => ({model, speed})),
            totalMemory: os.totalmem(),
            startLoad: os.loadavg()},
        observations: [],
        rounds: []}
    const save = () => writeFile(path.join(output, 'cohort.json'), JSON.stringify(report, null, 2) + '\n')
    await save()
    try {
        const identities = {A: await identity(rootA), B: await identity(rootB)}
        assert.equal(identities.A.sharedJsSha256, identities.B.sharedJsSha256, 'JS runtime wrappers differ')
        for (const file of ['package-lock.json', 'dev/dictionary-wasm.js']) { assert.equal(identities.A.files[file], identities.B.files[file], `Shared input differs: ${file}`) }
        assert.notEqual(identities.A.wasm['term-bank-parser.wasm'], identities.B.wasm['term-bank-parser.wasm'], 'Candidate parser WASM must differ')
        assert.equal(identities.A.wasm['term-content-canonical-scan-v1.wasm'], identities.B.wasm['term-content-canonical-scan-v1.wasm'], 'Unrelated canonical scanner differs')
        report.identities = identities
        report.fixture = (await fixture(rootB)).provenance
        await save()
        let expectedDigest = null
        let expectedFlags = null
        for (let round = 1; round <= plan.rounds; ++round) {
            const order = plan.permutations[(startOrder + round - 1) % plan.permutations.length]
            const row = {round, order}
            for (const arm of order) {
                const index = report.observations.length + 1
                const stem = `${String(index).padStart(3, '0')}-round-${round}-${arm}`
                const file = path.join(output, stem + '.json')
                const observation = {index, round, arm, status: 'running', report: stem + '.json', log: stem + '.log'}
                report.observations.push(observation)
                await save()
                const log = await open(path.join(output, observation.log), 'wx')
                try {
                    await new Promise((resolve, reject) => {
                        const child = spawn(
                            process.execPath,
                            ['--expose-gc',
                                runner,
                                '--child',
                                '--source-root',
                                roots[arm],
                                '--fixture-root',
                                rootB,
                                '--output',
                                file],
                            {cwd: roots[arm], env: {...process.env, NODE_OPTIONS: ''}, stdio: ['ignore', log.fd, log.fd], timeout: 180000},
                        )
                        child.on('error', reject)
                        child.on('close', (code, signal) => (code === 0 ? resolve() : reject(new Error(`Observation ${stem} failed: ${code} ${signal}`))))
                    })
                } finally {
                    await log.close()
                }
                const bytes = await readFile(file)
                const sample = JSON.parse(bytes)
                assert.equal(sample.schemaVersion, 2)
                assert.equal(sample.complete, true)
                assert.equal(sample.kind, 'native-key-negative-sample')
                assert.equal(sample.mode, 'timed')
                assert.equal(sample.runnerSha256, runnerSha256)
                assert.equal(sample.node, process.version)
                assert.equal(sample.v8, process.versions.v8)
                assert.deepEqual(sample.plan, plan)
                assert.deepEqual(sample.fixture, report.fixture)
                assert.deepEqual(sample.source, arm === 'B' ? identities.B : identities.A)
                assert.equal(sample.warmups.length, plan.warmupsPerChild)
                assert.equal(sample.measurements.length, plan.measuredRepetitionsPerChild)
                for (const measurement of [...sample.warmups, ...sample.measurements, sample.verification]) {
                    assert.equal(measurement.rows, plan.rowsPerFixture)
                    assert.equal(measurement.fusedParseAttempts, 1)
                    assert.equal(measurement.fusedParseFallbacks, 0)
                    assert(measurement.returned >= 0)
                }
                for (const measurement of sample.measurements) {
                    assert(Number.isFinite(measurement.cpuMs) && measurement.cpuMs > 0)
                    assert(Number.isFinite(measurement.wallMs) && measurement.wallMs > 0)
                }
                assert.equal(sample.measured.rows, plan.rowsPerFixture * plan.measuredRepetitionsPerChild)
                assert.equal(sample.measured.cpuMs, sample.measurements.reduce((sum, measurement) => sum + measurement.cpuMs, 0))
                assert.equal(sample.measured.wallMs, sample.measurements.reduce((sum, measurement) => sum + measurement.wallMs, 0))
                assert(/^[a-f0-9]{64}$/.test(sample.verification.digest), 'Missing complete-output digest')
                if (expectedDigest === null) { expectedDigest = sample.verification.digest }
                if (expectedFlags === null) { expectedFlags = sample.flags }
                assert.equal(sample.verification.digest, expectedDigest, 'Complete output bytes differ')
                assert.deepEqual(sample.flags, expectedFlags, 'Parser defaults differ')
                Object.assign(observation, {status: 'complete', reportSha256: sha(bytes), measured: sample.measured, digest: sample.verification.digest})
                row[arm] = observation
                await save()
                console.log(`${stem}: native CPU ${sample.measured.cpuMs.toFixed(3)}ms, wall ${sample.measured.wallMs.toFixed(3)}ms across ten fixtures`)
            }
            report.rounds.push(row)
            await save()
        }
        assert.deepEqual(await identity(rootA), report.identities.A, 'Baseline changed during cohort')
        assert.deepEqual(await identity(rootB), report.identities.B, 'Candidate changed during cohort')
        assert.equal(sha(await readFile(path.join(rootB, fixtureFile))), report.fixture.generatorSha256, 'Fixture generator changed')
        assert.equal(sha(await readFile(runner)), runnerSha256, 'Runner changed during cohort')
        report.summary = {}
        for (const metric of ['cpuMs', 'wallMs']) {
            const times = Object.fromEntries(['A', 'B', 'C'].map((arm) => [arm, report.rounds.map((round) => round[arm].measured[metric])]))
            report.summary[metric] = {candidate: compare(times.A, times.B),
                identicalCodeControl: compare(times.A, times.C),
                candidateVersusSecondControl: compare(times.C, times.B),
                candidateVersusGeometricControls: compare(times.A.map((value, index) => Math.sqrt(value * times.C[index])), times.B)}
        }
        report.verificationDigest = expectedDigest
        report.complete = true
        report.completedAt = new Date().toISOString()
        report.host.endLoad = os.loadavg()
        await save()
        console.log(JSON.stringify(report.summary))
    } catch (error) {
        const observation = report.observations.at(-1)
        if (observation?.status === 'running') { observation.status = 'failed' }
        report.error = String(error?.stack ?? error)
        await save()
        throw error
    }
}

await (values.child ? runChild() : runCohort())
