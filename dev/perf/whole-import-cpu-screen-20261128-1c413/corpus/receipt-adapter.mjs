/* SPDX-License-Identifier: GPL-3.0-or-later */
// Read-only source/output adapter. Importing it launches no workload and reads no clock.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {createReadStream} from 'node:fs'
import {lstat, open, readFile, readdir, realpath} from 'node:fs/promises'
import {availableParallelism} from 'node:os'
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path'
import {clockValues, selectedGate} from '../screen-policy.mjs'
import {boundaryName} from './cpu-boundary.mjs'
import {verifyOwnerAccounting} from './owner-observer.mjs'

export const mandatoryCheckNames = ['source', 'fixture', 'harness', 'workflow', 'preparation',
    'output', 'work', 'ownerAccounting', 'activation', 'endpoint', 'cleanup', 'timing', 'affinity']

const parserKeys = ['fastPathParserFusedAttempts', 'fastPathParserFusedFallbacks',
    'fastPathParserSourceTransferredBytes', 'fastPathParserSourceCrcScannedBytes',
    'fastPathParserSourceCrcReusedBytes', 'fastPathParserSourceCrcReusedGlossaryCount',
    'fastPathParserSourceCompressedBytes', 'fastPathParserSourceUncompressedBytes',
    'fastPathParserCompactContentMetadataGroups', 'fastPathParserParallelWorkerCount',
    'fastPathParserParallelPipelineGroupsPerWorker', 'fastPathParserParallelGroupCount',
    'fastPathParserParallelSkipReason']
const hex = /^[0-9a-f]{64}$/
const sum = (values) => values.reduce((total, value) => total + value, 0)
export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
export const canonical = (value) => JSON.stringify(normalize(value))
function normalize(value) {
    if (Array.isArray(value)) return value.map(normalize)
    if (value === null || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]))
}
export const digestValue = (value) => sha(canonical(value))
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))

export function pathWithin(root, name) {
    assert.ok(typeof name === 'string' && name.length > 0 && !isAbsolute(name))
    const target = resolve(root, name)
    const child = relative(root, target)
    assert.ok(child !== '' && child !== '..' && !child.startsWith('..' + sep))
    return target
}
async function checkedFile(root, name) {
    const target = pathWithin(root, name)
    assert.equal(await realpath(target), target, 'Bound file path traverses a symlink')
    const details = await lstat(target)
    assert.ok(details.isFile() && !details.isSymbolicLink())
    return target
}
export async function fileDigest(path) {
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length }
    return {sha256: hash.digest('hex'), bytes}
}

// This guard runs before filesystem preparation or product import. All null
// bindings in the draft are deliberate hard blockers, including for warmups.
export function requireSealedDefinition(plan) {
    assert.equal(plan.status, 'sealed', 'Source/harness is still unsealed; no acquisition is authorized')
    assert.equal(plan.acquisitionAuthorized, true, 'Acquisition remains disabled')
    assert.equal(plan.schemaVersion, 1)
    assert.equal(plan.nodeVersion, 'v22.22.0')
    assert.equal(plan.boundary, boundaryName)
    assert.equal(plan.numericPolicyStatus, 'selected-prospectively-before-observations')
    assert.deepEqual(plan.nominationGate, selectedGate)
    assert.deepEqual(plan.mandatoryCheckNames, mandatoryCheckNames)
    assert.equal(plan.runtimePolicy.status, 'sealed')
    assert.equal(plan.runtimePolicy.compileCacheDisabled, true)
    assert.equal(plan.runtimePolicy.forcedGarbageCollection, false)
    assert.deepEqual(plan.runtimePolicy.childExecArgv, [])
    assert.deepEqual(plan.runtimePolicy.removeEnvironmentOptions, ['NODE_OPTIONS', 'NODE_COMPILE_CACHE', 'NODE_V8_COVERAGE'])
    assert.equal(plan.runtimePolicy.hardwareConcurrencyExposed, 4)
    assert.equal(plan.runtimePolicy.deviceMemoryExposed, 8)
    assert.equal(plan.runtimePolicy.minimumAllowedLogicalCpus, 4)
    assert.equal(plan.runtimePolicy.separatelyProvisionedReplications, true)
    assert.equal(plan.storagePolicy.status, 'sealed')
    assert.equal(plan.commonDriver.untimedMode, 'untimed')
    assert.equal(plan.commonDriver.measuredMode, 'cpu-screen')
    assert.ok(plan.commonDriver.relativeEntry && plan.commonDriver.relativeReceiptAdapter)
    assert.ok(Array.isArray(plan.commonDriver.files) && plan.commonDriver.files.length > 0)
    assert.ok(plan.expectedWork && hex.test(plan.expectedOutputDigest))
    assert.ok(plan.preparationReceipt?.relativePath && hex.test(plan.preparationReceipt.sha256))
    assert.ok(plan.workflowBinding?.path && hex.test(plan.workflowBinding.sha256))
    assert.ok(/^refs\/heads\/test\//.test(plan.workflowBinding.ref))
    assert.equal(plan.workflowBinding.repository, 'ManabiIO/manabitan')
    assert.ok(plan.workflowBinding.jobs?.R1 && plan.workflowBinding.jobs?.R2)
    assert.notEqual(plan.workflowBinding.jobs.R1, plan.workflowBinding.jobs.R2)
    for (const arm of ['A', 'B', 'C']) {
        assert.ok(/^[0-9a-f]{40}$/.test(plan.arms[arm].commit))
        assert.ok(/^[0-9a-f]{40}$/.test(plan.arms[arm].tree))
        assert.ok(hex.test(plan.arms[arm].preparedRuntimeDigest))
        assert.ok(Object.hasOwn(plan.expectedWork, arm))
    }
}

export async function verifyHarnessFiles(workspace, plan) {
    const seen = new Set()
    for (const entry of plan.commonDriver.files) {
        assert.ok(!seen.has(entry.path) && hex.test(entry.sha256))
        seen.add(entry.path)
        assert.deepEqual(await fileDigest(await checkedFile(workspace, entry.path)),
            {bytes: entry.bytes, sha256: entry.sha256})
    }
    assert.ok(seen.has(plan.commonDriver.relativeEntry) && seen.has(plan.commonDriver.relativeReceiptAdapter))
    const corpus = dirname(plan.commonDriver.relativeEntry)
    assert.equal(basename(plan.commonDriver.relativeEntry), 'run.mjs')
    assert.equal(plan.commonDriver.relativeReceiptAdapter, join(corpus, 'receipt-adapter.mjs'))
    for (const name of ['run.mjs', 'cpu-boundary.mjs', 'receipt-adapter.mjs', 'owner-observer.mjs',
        'node-runtime.mjs', 'node-opfs-disk.mjs', 'node-import-worker-bridge.mjs',
        'baseline-open-connection.txt', 'baseline-open-supported-connection.txt', 'baseline-storage-schema-version.txt']) {
        assert.ok(seen.has(join(corpus, name)), 'Common executable dependency is unbound: ' + name)
    }
    assert.ok(seen.has(join(dirname(corpus), 'screen.mjs')))
    assert.ok(seen.has(join(dirname(corpus), 'screen-policy.mjs')))
    assert.ok(seen.has(join(dirname(corpus), 'workflow-prepare.mjs')))
    for (const name of ['test-screen.mjs', 'test-boundary.mjs', 'test-plan.json']) {
        assert.ok(seen.has(join(dirname(corpus), name)), 'Hosted pure-test dependency is unbound: ' + name)
    }
}

export async function readPreparedSource(repository, expectedCommit) {
    const git = (...args) => execFileSync('git', args, {cwd: repository, encoding: 'utf8'}).trim()
    assert.equal(git('rev-parse', 'HEAD'), expectedCommit)
    const trackedChanges = git('diff', '--name-only', 'HEAD').split('\n').filter(Boolean)
    assert.ok(trackedChanges.every((path) => path === 'ext/legal-npm.html'), 'Unreviewed tracked source change')
    const committedLegal = execFileSync('git', ['show', 'HEAD:ext/legal-npm.html'], {cwd: repository})
    const runtimeFiles = {}
    async function walk(directory) {
        for (const name of (await readdir(directory)).sort()) {
            const path = join(directory, name)
            const details = await lstat(path)
            assert.equal(details.isSymbolicLink(), false, 'Runtime symlink is not permitted')
            if (details.isDirectory()) await walk(path)
            else {
                assert.ok(details.isFile())
                runtimeFiles[relative(join(repository, 'ext'), path).split(sep).join('/')] = await fileDigest(path)
            }
        }
    }
    await walk(join(repository, 'ext'))
    const manifest = await readJson(join(repository, 'dev/data/dictionary-wasm/manifest.json'))
    for (const target of manifest.targets) {
        assert.equal(basename(target.name), target.name)
        const artifact = await fileDigest(await checkedFile(repository, 'dev/data/dictionary-wasm/' + target.name))
        assert.equal(artifact.sha256, target.sha256)
        assert.deepEqual(runtimeFiles['lib/' + target.name], artifact)
    }
    return {commit: expectedCommit, tree: git('rev-parse', 'HEAD^{tree}'), runtimeFiles,
        preparedRuntimeDigest: digestValue(runtimeFiles),
        packageJson: await fileDigest(await checkedFile(repository, 'package.json')),
        packageLock: await fileDigest(await checkedFile(repository, 'package-lock.json')),
        fixtureLock: await fileDigest(await checkedFile(repository, 'test/perf/dictionaries.lock.json')),
        nativeManifest: await fileDigest(await checkedFile(repository, 'dev/data/dictionary-wasm/manifest.json')),
        setupGeneratedLicense: {path: 'ext/legal-npm.html',
            committed: {bytes: committedLegal.byteLength, sha256: sha(committedLegal)},
            generated: runtimeFiles['legal-npm.html'], listedTrackedDelta: trackedChanges.includes('ext/legal-npm.html')}}
}

export function verifyWorkflowIdentity(binding, observed) {
    assert.equal(observed.repository, binding.repository)
    assert.equal(observed.ref, binding.ref)
    assert.equal(observed.workflowRef, binding.repository + '/' + binding.path + '@' + binding.ref)
    assert.equal(observed.attempt, '1')
    assert.ok(/^[0-9a-f]{40}$/.test(observed.producerCommit))
    assert.ok(/^[0-9a-f]{40}$/.test(observed.producerTree))
    assert.equal(observed.producerCommit, observed.githubSha)
    assert.equal(observed.producerCommit, observed.githubWorkflowSha)
    assert.equal(observed.workflowFileSha256, binding.sha256)
    return true
}

export async function hostBinding(plan, replication) {
    assert.equal(process.version, plan.nodeVersion)
    assert.deepEqual(process.execArgv, [])
    assert.equal(process.env.NODE_DISABLE_COMPILE_CACHE, '1')
    for (const name of plan.runtimePolicy.removeEnvironmentOptions) assert.equal(process.env[name], undefined)
    assert.equal(process.env.GITHUB_ACTIONS, 'true')
    assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1', 'Original acquisition only; no retries')
    assert.equal(process.env.GITHUB_REPOSITORY, plan.workflowBinding.repository)
    assert.equal(process.env.GITHUB_REF, plan.workflowBinding.ref)
    assert.equal(process.env.GITHUB_WORKFLOW_REF, plan.workflowBinding.repository + '/' + plan.workflowBinding.path + '@' + plan.workflowBinding.ref)
    assert.ok(/^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA ?? ''))
    assert.equal(process.env.GITHUB_WORKFLOW_SHA, process.env.GITHUB_SHA)
    assert.equal(process.env.GITHUB_JOB, plan.workflowBinding.jobs[replication])
    assert.ok(/^[1-9][0-9]*$/.test(process.env.GITHUB_RUN_ID ?? ''))
    assert.ok(process.env.RUNNER_NAME && process.env.RUNNER_OS === 'Linux')
    assert.ok(availableParallelism() >= plan.runtimePolicy.minimumAllowedLogicalCpus)
    assert.ok(process.env.GITHUB_WORKSPACE)
    const producer = await realpath(process.env.GITHUB_WORKSPACE)
    const git = (...args) => execFileSync('git', args, {cwd: producer, encoding: 'utf8'}).trim()
    const producerCommit = git('rev-parse', 'HEAD')
    const producerTree = git('rev-parse', 'HEAD^{tree}')
    assert.equal(producerCommit, process.env.GITHUB_SHA)
    assert.equal(git('diff', '--name-only', 'HEAD'), '', 'Producer tracked files changed')
    const workflow = await fileDigest(await checkedFile(producer, plan.workflowBinding.path))
    assert.equal(workflow.sha256, plan.workflowBinding.sha256)
    verifyWorkflowIdentity(plan.workflowBinding, {repository: process.env.GITHUB_REPOSITORY,
        ref: process.env.GITHUB_REF, workflowRef: process.env.GITHUB_WORKFLOW_REF,
        attempt: process.env.GITHUB_RUN_ATTEMPT, producerCommit, producerTree,
        githubSha: process.env.GITHUB_SHA, githubWorkflowSha: process.env.GITHUB_WORKFLOW_SHA,
        workflowFileSha256: workflow.sha256})
    const affinity = (await readFile('/proc/self/status', 'utf8')).match(/^Cpus_allowed_list:\s*(.*)$/m)?.[1]
    assert.ok(affinity)
    return {affinity, node: process.version, v8: process.versions.v8,
        platform: process.platform, architecture: process.arch, runner: process.env.RUNNER_NAME,
        runId: process.env.GITHUB_RUN_ID, job: process.env.GITHUB_JOB, replication,
        workflowRef: process.env.GITHUB_WORKFLOW_REF, workflowPath: plan.workflowBinding.path,
        workflowFileSha256: workflow.sha256, producerCommit, producerTree,
        githubSha: process.env.GITHUB_SHA, githubWorkflowSha: process.env.GITHUB_WORKFLOW_SHA,
        githubRef: process.env.GITHUB_REF, attempt: 1}
}

export async function validatePreparedInputs({plan, workspace, arm, mode, replication}) {
    requireSealedDefinition(plan)
    assert.ok(['A', 'B', 'C'].includes(arm) && ['untimed', 'cpu-screen'].includes(mode))
    assert.ok(['R1', 'R2'].includes(replication))
    const host = await hostBinding(plan, replication)
    await verifyHarnessFiles(workspace, plan)
    const preparationPath = await checkedFile(workspace, plan.preparationReceipt.relativePath)
    assert.equal((await fileDigest(preparationPath)).sha256, plan.preparationReceipt.sha256)
    const preparation = await readJson(preparationPath)
    assert.equal(preparation.schema, 1)
    assert.equal(preparation.passed, true)
    assert.equal(preparation.nodeVersion, plan.nodeVersion)
    assert.deepEqual(preparation.workflowBinding, plan.workflowBinding)
    assert.deepEqual(preparation.runtimePolicy, plan.runtimePolicy)
    assert.equal(preparation.commonDriverFilesDigest, digestValue(plan.commonDriver.files))
    const repository = pathWithin(workspace, plan.arms[arm].relativeRoot)
    assert.equal(await realpath(repository), repository, 'Prepared checkout cannot traverse a symlink')
    const source = await readPreparedSource(repository, plan.arms[arm].commit)
    assert.equal(source.tree, plan.arms[arm].tree)
    assert.equal(source.preparedRuntimeDigest, plan.arms[arm].preparedRuntimeDigest)
    assert.deepEqual(source, preparation.arms[arm], 'Prepared source differs from the frozen pre-acquisition receipt')
    const fixture = await fileDigest(await checkedFile(workspace, plan.fixture.relativePath))
    assert.deepEqual(fixture, {sha256: plan.fixture.sha256, bytes: plan.fixture.bytes})
    assert.deepEqual(preparation.fixture, fixture)
    return {passed: true, sourceCommit: source.commit, sourceTree: source.tree,
        preparedRuntimeDigest: source.preparedRuntimeDigest, fixtureSha256: fixture.sha256,
        source, fixture, host, preparationSha256: plan.preparationReceipt.sha256}
}

export function verifyActivation(arm, fieldMetrics, assets, plan) {
    const optional = assets.filter((asset) => asset.path.endsWith('/term-record-fields.wasm'))
    if (arm === 'A' || arm === 'C') {
        assert.equal(fieldMetrics, null)
        assert.equal(optional.length, 0)
        return true
    }
    const expected = plan.activationGate.B
    assert.equal(fieldMetrics.calls, expected.nativeCalls)
    assert.equal(fieldMetrics.javascriptCalls, 0)
    for (const name of ['wholeNativeCalls', 'wholeNativeRows', 'wholeNativeAttempts', 'nativeCalls', 'nativeRows', 'nativeAttempts']) {
        assert.equal(fieldMetrics.native[name], expected[name])
    }
    for (const name of ['declines', 'wholeAdmissionDeclines', 'wholeCopiedDeclines']) {
        assert.ok(Object.values(fieldMetrics.native[name]).every((value) => value === 0))
    }
    assert.equal(optional.length, expected.optionalFieldWasmFetches)
    return true
}

// No startup rebind: complete natural whole activation proves the sole optional
// initializer assigned its encoder before those calls. A failed/unactivated
// original interval remains in its failure receipt with endpointProven=false.
export function endpointProven({arm, fieldMetrics, assets, plan, imported, semanticProbesCompleted,
    storeSessionRetired, parserDisposed, databaseClosed, workersJoined, cleanupErrors}) {
    if (!imported || !semanticProbesCompleted || !storeSessionRetired || !parserDisposed ||
        !databaseClosed || !workersJoined || cleanupErrors.length !== 0) return false
    try { return verifyActivation(arm, fieldMetrics, assets, plan) }
    catch { return false }
}

export function assetEvidence(assets, before, after) {
    return assets.map((asset) => {
        assert.ok(asset.path.startsWith('ext/'))
        const key = asset.path.slice(4)
        assert.deepEqual(before.runtimeFiles[key], after.runtimeFiles[key])
        assert.equal(asset.bytes, before.runtimeFiles[key]?.bytes)
        return {...asset, sha256: before.runtimeFiles[key].sha256,
            digestBasis: 'frozen-source-file-reverified-after-retirement'}
    })
}

export function workSnapshot({report, owners, fields, workers, phases}) {
    const matches = phases.filter((phase) => phase.phase === 'import-data-banks')
    assert.equal(matches.length, 1)
    const parser = Object.fromEntries(parserKeys.map((key) => {
        assert.ok(Object.hasOwn(matches[0].details, key), 'Missing parser work counter: ' + key)
        return [key, matches[0].details[key]]
    }))
    assert.equal(parser.fastPathParserFusedFallbacks, 0)
    const groups = []
    const totals = {}
    for (const worker of workers) {
        assert.deepEqual(worker.failures, [])
        assert.ok(worker.terminated && Number.isInteger(worker.exitCode))
        const row = totals[worker.entry] ??= {workers: 0, ready: 0, sent: 0, received: 0,
            sourceConsumed: 0, compressionRequests: 0, compressionResults: 0, indexActions: {}, assets: []}
        ++row.workers
        for (const key of ['ready', 'sent', 'received', 'sourceConsumed', 'compressionRequests', 'compressionResults']) row[key] += worker[key]
        for (const [key, value] of Object.entries(worker.indexActions)) row.indexActions[key] = (row.indexActions[key] ?? 0) + value
        row.assets.push(...worker.assets.map(({path, bytes}) => ({path, bytes})))
        if (worker.entry === 'term-bank-wasm-parser-worker.js') {
            assert.equal(worker.ready, 1)
            assert.equal(worker.parseRequests.length, worker.parseResults.length)
            for (const request of worker.parseRequests) {
                assert.ok(request.banks.length > 0)
                const result = worker.parseResults.filter((item) => item.id === request.id)
                assert.equal(result.length, 1)
                groups.push({banks: request.banks, sourceByteLengths: request.sourceByteLengths, rowCount: result[0].rowCount})
            }
        }
    }
    for (const row of Object.values(totals)) row.assets.sort((a, b) => canonical(a).localeCompare(canonical(b)))
    groups.sort((a, b) => canonical(a).localeCompare(canonical(b)))
    assert.equal(groups.length, report.parserGroups)
    assert.equal(sum(groups.map((group) => group.rowCount)), report.fieldRows)
    return {fieldRows: report.fieldRows, fieldCalls: fields.length, ownerCalls: owners.length,
        parser, groups, workers: totals, fieldMetrics: report.fieldMetrics,
        ownerAccounting: report.ownerAccounting,
        owners: owners.map(({ordinal, rowCount, uniqueCount, firstId, contentDictName, fieldStart, fieldEnd, before, after}) =>
            ({ordinal, rowCount, uniqueCount, firstId, contentDictName, fieldStart, fieldEnd, before, after})),
        fieldWork: fields.map(({ordinal, ownerOrdinal, rowCount, uniqueCount, before, after, wholeAttempt}) =>
            ({ordinal, ownerOrdinal, rowCount, uniqueCount, before, after, wholeAttempt: wholeAttempt === null ? null : {
                copied: wholeAttempt.copied, succeeded: wholeAttempt.succeeded,
                contentOffsetBaseBits: wholeAttempt.contentOffsetBaseBits,
            }}))}
}

export function outputSnapshot(report, fields, files) {
    assert.deepEqual(fields.map((call) => call.ordinal), fields.map((_, index) => index))
    const termFiles = files.filter((file) => file.termPayload)
    assert.equal(termFiles.length, files.length, 'The JMdict-only screen has no non-term/media output reference')
    assert.ok(termFiles.some((file) => file.path.endsWith('.mbtr')))
    assert.ok(termFiles.some((file) => file.path.endsWith('.mbti')))
    assert.ok(termFiles.some((file) => file.path === 'manabitan-term-content.bin'))
    assert.equal(new Set(termFiles.map((file) => file.path)).size, termFiles.length)
    return {semantic: report.semantic, flags: report.flags,
        fields: fields.map(({ordinal, rowCount, contentOffsetBase, contentOffsetBaseBits, bytes, sha256}) =>
            ({ordinal, rowCount, contentOffsetBase, contentOffsetBaseBits, bytes, sha256})),
        termFiles: termFiles.map(({path, bytes, normalizedSha256, normalization}) =>
            ({path, bytes, normalizedSha256, normalization})).sort((a, b) => a.path.localeCompare(b.path))}
}

export async function inventoryFiles(root) {
    const files = []
    async function visit(directory) {
        for (const child of (await readdir(directory)).sort()) {
            const path = join(directory, child)
            const details = await lstat(path)
            assert.ok(!details.isSymbolicLink())
            if (details.isDirectory()) { await visit(path); continue }
            assert.ok(details.isFile())
            const logicalPath = relative(root, path).split(sep).join('/')
            const file = await open(path, 'r')
            const prefix = Buffer.alloc(Math.min(40, details.size))
            try {
                let done = 0
                while (done < prefix.length) {
                    const result = await file.read(prefix, done, prefix.length - done, done)
                    assert.ok(result.bytesRead > 0)
                    done += result.bytesRead
                }
            } finally { await file.close() }
            const magic = prefix.subarray(0, 8).toString('ascii')
            const termPayload = /^manabitan-term-content(?:\^[1-9]\d*)?\.bin$/.test(logicalPath) ||
                (logicalPath.startsWith('manabitan-term-records/') && /\.(?:mbtr|mbti)$/.test(logicalPath))
            if (logicalPath.startsWith('manabitan-term-content') || logicalPath.startsWith('manabitan-online-content')) {
                assert.ok(termPayload && !logicalPath.includes('/'), 'Unsupported content layout cannot escape the complete-byte oracle')
            }
            if (termPayload && logicalPath.endsWith('.mbtr')) assert.equal(magic, 'MBTRD16X')
            if (termPayload && logicalPath.endsWith('.mbti')) assert.equal(magic, 'MBTIDX11')
            const normalization = termPayload && logicalPath.endsWith('.mbtr') ? {offset: 8, bytes: 16, format: magic} :
                termPayload && logicalPath.endsWith('.mbti') ? {offset: 24, bytes: 16, format: magic} : null
            if (normalization) assert.ok(details.size >= normalization.offset + normalization.bytes)
            const raw = createHash('sha256')
            const normalized = createHash('sha256')
            let offset = 0
            for await (const chunk of createReadStream(path, {highWaterMark: 1024 * 1024})) {
                raw.update(chunk)
                if (normalization && offset < normalization.offset + normalization.bytes && offset + chunk.length > normalization.offset) {
                    const copy = Buffer.from(chunk)
                    copy.fill(0, Math.max(0, normalization.offset - offset), Math.min(copy.length, normalization.offset + normalization.bytes - offset))
                    normalized.update(copy)
                } else normalized.update(chunk)
                offset += chunk.length
            }
            assert.equal(offset, details.size)
            files.push({path: logicalPath, bytes: offset, sha256: raw.digest('hex'),
                normalizedSha256: normalized.digest('hex'), normalization, termPayload})
        }
    }
    await visit(root)
    return files
}

export function verifyReportBindings({report, plan, planSha256, arm, mode, source, fields, ownerReceipt, ownerAccounting}) {
    assert.ok(hex.test(planSha256))
    assert.equal(report.passed, true, 'Failed original import is retained and fails the entire screen')
    assert.equal(report.arm, arm)
    assert.equal(report.mode, mode)
    assert.equal(report.dictionary, plan.fixture.dictionary)
    assert.equal(report.performanceMeasurements, mode === 'cpu-screen')
    assert.equal(report.sourceCommit, source.commit)
    assert.equal(report.sourceTree, source.tree)
    assert.equal(report.boundary, plan.boundary)
    assert.equal(report.planSha256, planSha256)
    assert.equal(report.fieldCalls, fields.length)
    assert.equal(report.ownerCalls, ownerReceipt.owners.length)
    assert.deepEqual(report.ownerAccounting, ownerAccounting)
    assert.deepEqual(ownerReceipt.accounting, ownerAccounting)
}

export async function validateObservation({plan, planSha256, workspace, directory, arm, mode, replication}) {
    requireSealedDefinition(plan)
    const prepared = await validatePreparedInputs({plan, workspace, arm, mode, replication})
    const names = ['report', 'source-before', 'source-after', 'fixture-after', 'field-calls',
        'owner-calls', 'workers', 'files', 'product-work-counts', 'cleanup', 'host', 'assets', 'work', 'output', 'timing']
    const entries = await Promise.all(names.map(async (name) => [name, await readJson(await checkedFile(directory, name + '.json'))]))
    const receipts = Object.fromEntries(entries)
    const report = receipts.report
    assert.deepEqual(receipts['source-before'], prepared.source)
    assert.deepEqual(receipts['source-after'], prepared.source)
    assert.deepEqual(receipts['fixture-after'], prepared.fixture)
    assert.deepEqual(report.fixture, prepared.fixture)
    assert.deepEqual(receipts.host, prepared.host)
    assert.equal(report.fieldRows, plan.fixture.rows)
    assert.equal(report.parserGroups, plan.fixture.parserGroups)
    assert.equal(report.parserWorkers, plan.fixture.parserWorkers)
    assert.equal(report.sqlite.persistentSqlite, false)
    assert.equal(report.sqlite.usesFallbackStorageOverride, false)
    assert.equal(receipts.cleanup.completed, true)
    assert.deepEqual(receipts.cleanup.cleanupErrors, [])
    assert.equal(receipts.cleanup.endpointProven, true, 'Unproven endpoint fails the original screen; it is never filtered')
    const fields = receipts['field-calls']
    const ownerReceipt = receipts['owner-calls']
    const ownerAccounting = verifyOwnerAccounting({owners: ownerReceipt.owners, fields,
        observerErrors: ownerReceipt.observerErrors, active: null}, report.fieldMetrics, arm, plan.fixture.rows)
    verifyReportBindings({report, plan, planSha256, arm, mode, source: prepared.source, fields, ownerReceipt, ownerAccounting})
    const allAssets = [...receipts.assets, ...receipts.workers.flatMap((worker) => worker.assets)]
    verifyActivation(arm, report.fieldMetrics, allAssets, plan)
    assert.equal(endpointProven({arm, fieldMetrics: report.fieldMetrics, assets: allAssets, plan,
        ...receipts.cleanup}), true)
    assert.deepEqual(assetEvidence(allAssets, prepared.source, prepared.source), allAssets)
    const fieldDirectory = await realpath(join(directory, 'field-bytes'))
    assert.equal(fieldDirectory, join(directory, 'field-bytes'))
    const fieldNames = fields.map((call) => String(call.ordinal).padStart(5, '0') + '.bin')
    assert.deepEqual((await readdir(fieldDirectory)).sort(), fieldNames)
    for (const call of fields) assert.deepEqual(await fileDigest(await checkedFile(fieldDirectory, fieldNames[call.ordinal])),
        {bytes: call.bytes, sha256: call.sha256})
    const files = await inventoryFiles(join(directory, 'disk', 'root'))
    assert.deepEqual(files, receipts.files, 'A complete final sidecar changed after the driver receipt')
    assert.deepEqual(await readdir(join(directory, 'disk', 'staging')), [])
    const output = outputSnapshot(report, fields, files)
    assert.deepEqual(output, receipts.output)
    const outputDigest = digestValue(output)
    assert.equal(outputDigest, plan.expectedOutputDigest)
    const work = workSnapshot({report, owners: ownerReceipt.owners, fields,
        workers: receipts.workers, phases: receipts['product-work-counts']})
    assert.deepEqual(work, receipts.work)
    assert.deepEqual(work, plan.expectedWork[arm])
    const timing = receipts.timing
    if (mode === 'untimed') assert.equal(timing, null)
    else {
        assert.equal(timing.boundary, boundaryName)
        clockValues(timing)
    }
    assert.deepEqual(report.timing, timing)
    return {complete: true, arm, mode, sourceCommit: prepared.sourceCommit, sourceTree: prepared.sourceTree,
        preparedRuntimeDigest: prepared.preparedRuntimeDigest, affinity: prepared.host.affinity,
        outputDigest, work, timing, checks: Object.fromEntries(mandatoryCheckNames.map((key) => [key, true]))}
}
