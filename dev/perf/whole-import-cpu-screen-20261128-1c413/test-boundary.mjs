// Synthetic control-flow/receipt cases only. No product imports, actual clocks,
// child processes, native compilation, dictionaries or acquired observations.
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createCpuBoundary, runImportBoundary} from './corpus/cpu-boundary.mjs'
import {finalizeOwnerEvidence, observeRecordOwners, verifyOwnerAccounting} from './corpus/owner-observer.mjs'
import {assetEvidence, digestValue, endpointProven, outputSnapshot, requireSealedDefinition,
    validatePreparedInputs, verifyActivation, verifyReportBindings, verifyWorkflowIdentity, workSnapshot} from './corpus/receipt-adapter.mjs'
import {storageBudget} from './workflow-prepare.mjs'

const checks = []
async function test(name, run) {
    try { await run(); checks.push({name, passed: true}) }
    catch (cause) { checks.push({name, passed: false, error: String(cause), stack: cause.stack}) }
}
const plan = JSON.parse(await readFile(new URL('./plan.json', import.meta.url), 'utf8'))
const disabledPlan = JSON.parse(await readFile(new URL('./test-plan.json', import.meta.url), 'utf8'))
function fakeClocks(events = []) {
    let cpu = 0
    let wall = 0
    return {events, get counts() { return {cpu, wall} },
        cpu() { events.push('cpu-' + ++cpu); return {user: cpu * 13000, system: cpu * 7000} },
        wall() { events.push('wall-' + ++wall); return BigInt(wall) * 1000000n }}
}
const activated = () => ({calls: 12, javascriptCalls: 0, native: {
    wholeNativeCalls: 12, wholeNativeRows: 528299, wholeNativeAttempts: 12,
    nativeCalls: 12, nativeRows: 528299, nativeAttempts: 12,
    declines: {}, wholeAdmissionDeclines: {}, wholeCopiedDeclines: {},
}})
const optional = [{path: 'ext/lib/term-record-fields.wasm', bytes: 1860}]
const lifecycle = () => ({imported: true, semanticProbesCompleted: true, storeSessionRetired: true,
    parserDisposed: true, databaseClosed: true, workersJoined: true, cleanupErrors: []})

await test('one pair surrounds first product callback, fixed probes and all joined retirement callbacks', async () => {
    const events = []
    const clocks = fakeClocks(events)
    const boundary = createCpuBoundary('cpu-screen', clocks)
    const result = await runImportBoundary(boundary, async () => {
        events.push('first-product-evaluation', 'prepare', 'producer-registry', 'receiver-registry', 'owner-native', 'append')
        await Promise.resolve()
        events.push('fixed-semantic-probes')
    }, async () => {
        events.push('parser-dispose', 'database-close')
        await Promise.resolve()
        events.push('worker-join')
        return lifecycle()
    })
    assert.deepEqual(events, ['cpu-1', 'wall-1', 'first-product-evaluation', 'prepare', 'producer-registry',
        'receiver-registry', 'owner-native', 'append', 'fixed-semantic-probes', 'parser-dispose',
        'database-close', 'worker-join', 'wall-2', 'cpu-2'])
    assert.deepEqual(clocks.counts, {cpu: 2, wall: 2})
    assert.equal(result.timing.cpuMs, 20)
    assert.equal(result.timing.wallMs, 1)
    assert.equal(result.error, null)
})

await test('end cannot precede an unresolved worker retirement', async () => {
    const clocks = fakeClocks()
    const boundary = createCpuBoundary('cpu-screen', clocks)
    let join
    const waiting = new Promise((resolve) => { join = resolve })
    const run = runImportBoundary(boundary, async () => {}, async () => { await waiting; return lifecycle() })
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(boundary.phase, 'running')
    assert.deepEqual(clocks.counts, {cpu: 1, wall: 1})
    join()
    await run
    assert.equal(boundary.phase, 'retired')
    assert.deepEqual(clocks.counts, {cpu: 2, wall: 2})
})

await test('untimed mode performs the same callbacks with zero clock reads', async () => {
    const events = []
    const forbidden = () => { throw new Error('Clock must not be read') }
    const boundary = createCpuBoundary('untimed', {cpu: forbidden, wall: forbidden})
    const result = await runImportBoundary(boundary, async () => events.push('perform'), async () => events.push('retire'))
    assert.deepEqual(events, ['perform', 'retire'])
    assert.equal(result.timing, null)
})

await test('failed original work still retires and preserves its one raw interval', async () => {
    const failure = new Error('synthetic original failure')
    const clocks = fakeClocks()
    const boundary = createCpuBoundary('cpu-screen', clocks)
    let retired = false
    const result = await runImportBoundary(boundary, async () => { throw failure }, async (error) => {
        assert.equal(error, failure)
        retired = true
        return {...lifecycle(), imported: false}
    })
    assert.equal(result.error, failure)
    assert.equal(retired, true)
    assert.ok(result.timing)
    assert.deepEqual(clocks.counts, {cpu: 2, wall: 2})
    assert.equal(endpointProven({arm: 'B', fieldMetrics: activated(), assets: optional, plan, ...result.retirement}), false)
})

await test('retirement failure is retained instead of turning into a successful interval', async () => {
    const failure = new Error('synthetic join failure')
    const boundary = createCpuBoundary('cpu-screen', fakeClocks())
    const result = await runImportBoundary(boundary, async () => {}, async () => { throw failure })
    assert.equal(result.error, failure)
    assert.equal(result.retirement, null)
    assert.ok(result.timing)
})

await test('evidence guard rejects work inside the interval and rejects repeated endpoints', () => {
    const boundary = createCpuBoundary('cpu-screen', fakeClocks())
    assert.throws(() => boundary.report())
    boundary.start()
    assert.throws(() => boundary.assertOutside(), /escaped/)
    assert.throws(() => boundary.start())
    boundary.stop()
    boundary.assertOutside()
    assert.throws(() => boundary.stop())
})

await test('qualifying B requires all whole calls, rows and attempts, not fields-only native totals', () => {
    assert.equal(endpointProven({arm: 'B', fieldMetrics: activated(), assets: optional, plan, ...lifecycle()}), true)
    for (const name of ['wholeNativeCalls', 'wholeNativeRows', 'wholeNativeAttempts', 'nativeCalls', 'nativeRows', 'nativeAttempts']) {
        const metrics = activated()
        --metrics.native[name]
        assert.equal(endpointProven({arm: 'B', fieldMetrics: metrics, assets: optional, plan, ...lifecycle()}), false, name)
    }
    const fieldsOnly = activated()
    fieldsOnly.native.wholeNativeCalls = 0
    fieldsOnly.native.wholeNativeRows = 0
    assert.throws(() => verifyActivation('B', fieldsOnly, optional, plan))
})

await test('readiness fallback, ordinary/whole decline, absent/repeated fetch, or unretired work fails the endpoint', () => {
    const readiness = activated()
    readiness.javascriptCalls = 1
    assert.equal(endpointProven({arm: 'B', fieldMetrics: readiness, assets: optional, plan, ...lifecycle()}), false)
    for (const name of ['declines', 'wholeAdmissionDeclines', 'wholeCopiedDeclines']) {
        const metrics = activated()
        metrics.native[name].eligibility = 1
        assert.equal(endpointProven({arm: 'B', fieldMetrics: metrics, assets: optional, plan, ...lifecycle()}), false)
    }
    for (const assets of [[], [...optional, ...optional]]) {
        assert.equal(endpointProven({arm: 'B', fieldMetrics: activated(), assets, plan, ...lifecycle()}), false)
    }
    for (const key of Object.keys(lifecycle()).filter((key) => key !== 'cleanupErrors')) {
        assert.equal(endpointProven({arm: 'B', fieldMetrics: activated(), assets: optional, plan, ...lifecycle(), [key]: false}), false, key)
    }
    assert.equal(endpointProven({arm: 'B', fieldMetrics: activated(), assets: optional, plan,
        ...lifecycle(), cleanupErrors: ['synthetic failure']}), false)
})

await test('A and dormant C share the stock no-session/no-optional-fetch endpoint', () => {
    for (const arm of ['A', 'C']) {
        assert.equal(endpointProven({arm, fieldMetrics: null, assets: [], plan, ...lifecycle()}), true)
        assert.equal(endpointProven({arm, fieldMetrics: activated(), assets: [], plan, ...lifecycle()}), false)
        assert.equal(endpointProven({arm, fieldMetrics: null, assets: optional, plan, ...lifecycle()}), false)
    }
})

await test('observer retains original owning bytes, -0 primitive and exact original Promise; all digest/scalar work is deferred', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    let finish
    const originalPromise = new Promise((resolve) => { finish = resolve })
    const chunk = {rowCount: 1}
    const store = {_encodeArtifactRecordFields() { return bytes },
        _encodeAndAppendArtifactChunkForState() { this._encodeArtifactRecordFields(chunk, null, null, -0); return originalPromise }}
    const state = observeRecordOwners(store)
    const boundary = createCpuBoundary('untimed')
    boundary.start()
    const returned = store._encodeAndAppendArtifactChunkForState(null, chunk, 1)
    assert.equal(returned, originalPromise)
    assert.equal(state.fields[0].owningBytes, bytes)
    assert.ok(Object.is(state.fields[0].contentOffsetBase, -0))
    assert.equal(Object.hasOwn(state.fields[0], 'sha256'), false)
    assert.equal(Object.hasOwn(state.fields[0], 'contentOffsetBaseBits'), false)
    let digests = 0
    const digest = (value) => { assert.equal(value, bytes); ++digests; return 'synthetic-digest' }
    assert.throws(() => finalizeOwnerEvidence(state, digest, () => boundary.assertOutside()), /escaped/)
    assert.equal(digests, 0)
    finish()
    await returned
    boundary.stop()
    const evidence = finalizeOwnerEvidence(state, digest, () => boundary.assertOutside())
    assert.equal(digests, 1)
    assert.equal(evidence.fields[0].contentOffsetBaseBits, '0000000000000080')
    assert.equal(state.fields[0].owningBytes, bytes)
    assert.equal(JSON.parse(JSON.stringify(evidence.fields))[0].contentOffsetBaseBits, '0000000000000080')
    for (const arm of ['A', 'C']) assert.equal(verifyOwnerAccounting(evidence, null, arm, 1).passed, true)
})

await test('deferred evidence rejects a resized/detached retained field instead of hashing an empty replacement', () => {
    const bytes = new Uint8Array([1, 2])
    const state = {fields: [{owningBytes: bytes, bytes: 3, wholeAttempt: null, contentOffsetBase: 0}]}
    assert.throws(() => finalizeOwnerEvidence(state, () => 'unused', () => {}), /detached or resized/)
})

await test('asset binding has no synthetic fetched-byte digest and rejects source/length changes', () => {
    const source = {runtimeFiles: {'lib/example.wasm': {sha256: 'a'.repeat(64), bytes: 10}}}
    const evidence = assetEvidence([{path: 'ext/lib/example.wasm', bytes: 10}], source, source)
    assert.equal(evidence[0].sha256, 'a'.repeat(64))
    assert.equal(evidence[0].digestBasis, 'frozen-source-file-reverified-after-retirement')
    assert.throws(() => assetEvidence([{path: 'ext/lib/example.wasm', bytes: 9}], source, source))
    assert.throws(() => assetEvidence([{path: 'ext/lib/example.wasm', bytes: 10}], source,
        {runtimeFiles: {'lib/example.wasm': {sha256: 'b'.repeat(64), bytes: 10}}}))
})

function workFixture() {
    const keys = ['fastPathParserFusedAttempts', 'fastPathParserFusedFallbacks', 'fastPathParserSourceTransferredBytes',
        'fastPathParserSourceCrcScannedBytes', 'fastPathParserSourceCrcReusedBytes', 'fastPathParserSourceCrcReusedGlossaryCount',
        'fastPathParserSourceCompressedBytes', 'fastPathParserSourceUncompressedBytes', 'fastPathParserCompactContentMetadataGroups',
        'fastPathParserParallelWorkerCount', 'fastPathParserParallelPipelineGroupsPerWorker', 'fastPathParserParallelGroupCount', 'fastPathParserParallelSkipReason']
    const details = Object.fromEntries(keys.map((key) => [key, 0]))
    const worker = {entry: 'term-bank-wasm-parser-worker.js', ready: 1, sent: 1, received: 2,
        sourceConsumed: 1, compressionRequests: 0, compressionResults: 0, indexActions: {}, assets: [],
        failures: [], terminated: true, exitCode: 1,
        parseRequests: [{id: 7, banks: [{filename: 'synthetic-bank.json', compressedSize: 5}], sourceByteLengths: [5]}],
        parseResults: [{id: 7, rowCount: 1}]}
    return {report: {fieldRows: 1, parserGroups: 1, fieldMetrics: null, ownerAccounting: {passed: true}},
        owners: [], fields: [], workers: [worker], phases: [{phase: 'import-data-banks', details}]}
}

await test('work receipts retain bank grouping, transferred lengths, rows and direct counters while excluding worker request IDs', () => {
    const first = workFixture()
    const second = structuredClone(first)
    second.workers[0].parseRequests[0].id = 99
    second.workers[0].parseResults[0].id = 99
    assert.deepEqual(workSnapshot(first), workSnapshot(second))
    second.workers[0].parseRequests[0].sourceByteLengths[0] = 6
    assert.notDeepEqual(workSnapshot(first), workSnapshot(second))
})

await test('missing parser counters, missing result, row mismatch or worker failure fail exact work receipts', () => {
    const missing = workFixture()
    delete missing.phases[0].details.fastPathParserSourceCrcScannedBytes
    assert.throws(() => workSnapshot(missing), /Missing parser work counter/)
    const result = workFixture()
    result.workers[0].parseResults = []
    assert.throws(() => workSnapshot(result))
    const rows = workFixture()
    rows.workers[0].parseResults[0].rowCount = 2
    assert.throws(() => workSnapshot(rows))
    const failure = workFixture()
    failure.workers[0].failures.push({error: 'synthetic original failure'})
    assert.throws(() => workSnapshot(failure))
})

await test('output identity includes exact base bits and complete record/index/content digests', () => {
    const fields = [{ordinal: 0, rowCount: 1, contentOffsetBase: 0, contentOffsetBaseBits: '0000000000000080', bytes: 4, sha256: 'a'.repeat(64)}]
    const files = ['manabitan-term-content.bin', 'manabitan-term-records/s.mbtr', 'manabitan-term-records/s.mbti']
        .map((path) => ({path, bytes: 100, normalizedSha256: 'b'.repeat(64), normalization: null, termPayload: true}))
    const report = {semantic: {synthetic: true}, flags: {synthetic: true}}
    const original = digestValue(outputSnapshot(report, fields, files))
    const base = structuredClone(fields)
    base[0].contentOffsetBaseBits = '0000000000000000'
    assert.notEqual(digestValue(outputSnapshot(report, base, files)), original)
    const header = structuredClone(files)
    header[2].normalizedSha256 = 'c'.repeat(64)
    assert.notEqual(digestValue(outputSnapshot(report, fields, header)), original)
    assert.throws(() => outputSnapshot(report, fields, files.slice(0, 2)))
})

await test('disabled plan blocks the concrete preflight before workspace, host, source or child work', async () => {
    assert.throws(() => requireSealedDefinition(disabledPlan), /unsealed/)
    await assert.rejects(() => validatePreparedInputs({plan: disabledPlan, workspace: '/does-not-exist', arm: 'B', mode: 'cpu-screen', replication: 'R1'}), /unsealed/)
})

await test('acyclic workflow identity binds actual producer HEAD/tree, both environment commits, workflow bytes, ref and original attempt', () => {
    const binding = {repository: 'ManabiIO/manabitan', path: '.github/workflows/synthetic.yml',
        ref: 'refs/heads/test/synthetic-source-only', sha256: 'c'.repeat(64)}
    const observed = {repository: binding.repository, ref: binding.ref,
        workflowRef: binding.repository + '/' + binding.path + '@' + binding.ref,
        attempt: '1', producerCommit: 'a'.repeat(40), producerTree: 'b'.repeat(40),
        githubSha: 'a'.repeat(40), githubWorkflowSha: 'a'.repeat(40), workflowFileSha256: binding.sha256}
    assert.equal(verifyWorkflowIdentity(binding, observed), true)
    for (const [key, value] of Object.entries({repository: 'synthetic/other', ref: 'refs/heads/other',
        workflowRef: 'different-workflow', attempt: '2', producerCommit: 'd'.repeat(40), producerTree: 'not-a-tree',
        githubSha: 'd'.repeat(40), githubWorkflowSha: 'd'.repeat(40), workflowFileSha256: 'd'.repeat(64)})) {
        assert.throws(() => verifyWorkflowIdentity(binding, {...observed, [key]: value}), undefined, key)
    }
})

await test('all 42 retained sinks and duplicate fields fit the sealed capacity floor; one byte below or tmpfs fails', () => {
    const policy = {...plan.storagePolicy, status: 'sealed'}
    const minimum = BigInt(policy.minimumFreeBytesBeforeReplication)
    const result = storageBudget(policy, minimum, 61267n)
    assert.equal(result.retainedRawBytes, '1997336754')
    assert.equal(result.deletionActions, 0)
    assert.throws(() => storageBudget(policy, minimum - 1n, 61267n), /capacity/)
    assert.throws(() => storageBudget(policy, minimum, 0x01021994n), /tmpfs/)
    assert.throws(() => storageBudget({...policy, totalRetainedRawBytes: 0}, minimum, 61267n))
})

await test('original report identities, exact frozen-plan bytes and both owner accounting receipts must match independent evidence', () => {
    const source = {commit: plan.arms.B.commit, tree: plan.arms.B.tree}
    const accounting = {passed: true, synthetic: true}
    const report = {passed: true, arm: 'B', mode: 'cpu-screen', dictionary: plan.fixture.dictionary,
        performanceMeasurements: true, sourceCommit: source.commit, sourceTree: source.tree,
        boundary: plan.boundary, planSha256: 'a'.repeat(64), fieldCalls: 1, ownerCalls: 1, ownerAccounting: accounting}
    const input = {report, plan, planSha256: 'a'.repeat(64), arm: 'B', mode: 'cpu-screen', source,
        fields: [{}], ownerReceipt: {owners: [{}], accounting}, ownerAccounting: accounting}
    verifyReportBindings(input)
    for (const [name, value] of Object.entries({sourceCommit: 'b'.repeat(40), sourceTree: 'c'.repeat(40),
        boundary: 'different-boundary', planSha256: 'd'.repeat(64), fieldCalls: 2, ownerCalls: 2,
        passed: false, arm: 'C', mode: 'untimed', dictionary: 'synthetic-other', performanceMeasurements: false})) {
        assert.throws(() => verifyReportBindings({...input, report: {...report, [name]: value}}), undefined, name)
    }
    assert.throws(() => verifyReportBindings({...input, report: {...report, ownerAccounting: {passed: false}}}))
    assert.throws(() => verifyReportBindings({...input, ownerReceipt: {...input.ownerReceipt, accounting: {passed: false}}}))
})

await test('actual driver is import-inert and its default untimed/direct measured invocations reject the unsealed plan before paths or clocks', async () => {
    const oldCpu = process.cpuUsage
    const oldWall = process.hrtime.bigint
    let reads = 0
    process.cpuUsage = () => { ++reads; throw new Error('Actual CPU observation forbidden') }
    process.hrtime.bigint = () => { ++reads; throw new Error('Actual wall observation forbidden') }
    try {
        const {main} = await import('./corpus/run.mjs')
        const environment = {MANABITAN_RECORD_CPU_SCREEN_PLAN: new URL('./test-plan.json', import.meta.url).pathname}
        const args = ['/missing-repo', 'jmdict', '/missing-archive', '/missing-output', 'B', plan.arms.B.commit]
        await assert.rejects(() => main(args, environment), /unsealed/)
        await assert.rejects(() => main([...args, 'cpu-screen'], environment), /unsealed/)
        assert.equal(reads, 0)
    } finally { process.cpuUsage = oldCpu; process.hrtime.bigint = oldWall }
})

console.log(JSON.stringify({schema: 1, scope: 'synthetic boundary and receipt checks only',
    productModulesImported: 0, dictionaryImports: 0, childProcesses: 0,
    actualCpuOrWallClockReads: 0, observationsAcquired: 0,
    checks, passed: checks.every((check) => check.passed), cases: checks.length}, null, 2))
if (checks.some((check) => !check.passed)) process.exitCode = 1
