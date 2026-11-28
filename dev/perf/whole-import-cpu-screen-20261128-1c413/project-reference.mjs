/* SPDX-License-Identifier: GPL-3.0-or-later */
// Offline derivation from already audited original receipts and Git objects.
// No product import, worker, dictionary operation, compilation or clock read.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {assetEvidence, digestValue, mandatoryCheckNames, outputSnapshot, sha,
    verifyActivation, workSnapshot} from './corpus/receipt-adapter.mjs'
import {verifyOwnerAccounting} from './corpus/owner-observer.mjs'

const observedProducer = 'a9debd150d65c8d11884dadcdf162e7898dea309'
const unusedRuntime = ['js/dictionary/term-record-fields.js', 'js/dictionary/term-record-prepared-fields.js',
    'js/dictionary/wasm/term-record-fields.c', 'lib/term-record-fields.wasm']
const callerPaths = ['ext/js/dictionary/dictionary-database.js', 'ext/js/dictionary/dictionary-importer.js',
    'ext/js/dictionary/term-bank-wasm-parser.js', 'ext/js/dictionary/term-bank-wasm-parser-worker.js',
    'ext/js/dictionary/term-record-opfs-store.js']
const sourceFiles = ['PROTOCOL.md', 'screen.mjs', 'screen-policy.mjs', 'workflow-prepare.mjs',
    'project-reference.mjs', 'copy-provenance.json', 'test-screen.mjs', 'test-boundary.mjs', 'test-plan.json',
    'corpus/run.mjs', 'corpus/cpu-boundary.mjs', 'corpus/receipt-adapter.mjs', 'corpus/owner-observer.mjs',
    'corpus/node-runtime.mjs', 'corpus/node-opfs-disk.mjs', 'corpus/node-import-worker-bridge.mjs',
    'corpus/baseline-open-connection.txt', 'corpus/baseline-open-supported-connection.txt',
    'corpus/baseline-storage-schema-version.txt', 'corpus/run.correctness-source.txt',
    'workflow/native-whole-import-cpu-screen-1c413.yml']
const blob = (bytes) => createHash('sha1').update('blob ' + bytes.byteLength + '\0').update(bytes).digest('hex')
const identity = (bytes) => ({bytes: bytes.byteLength, sha256: sha(bytes)})
const canonicalJson = (value) => JSON.stringify(value, null, 2) + '\n'

export async function project([auditArgument, repositoryArgument]) {
    const root = dirname(fileURLToPath(import.meta.url))
    const audit = resolve(auditArgument)
    const repository = resolve(repositoryArgument)
    const plan = JSON.parse(await readFile(join(root, 'plan.json'), 'utf8'))
    assert.equal(plan.acquisitionAuthorized, false, 'Projection does not authorize or execute acquisition')
    assert.equal(plan.status, 'source-only-unsealed')
    const ledgerBytes = await readFile(join(audit, 'git-blob-ledger.json'))
    assert.equal(blob(ledgerBytes), 'fb018d784e7e5722606f3cb42c3230de2792d550')
    const ledger = JSON.parse(ledgerBytes)
    assert.equal(String(ledger.runId), '46149981540')
    assert.equal(Number(ledger.attempt), 1)
    assert.equal(ledger.producer, observedProducer)
    const usedMembers = {}
    async function original(path) {
        const entry = ledger.entries[path]
        assert.ok(entry && entry.kind === 'original-artifact-member')
        const bytes = await readFile(join(audit, path))
        assert.deepEqual(identity(bytes), {bytes: entry.bytes, sha256: entry.sha256})
        assert.equal(blob(bytes), entry.gitBlob)
        usedMembers[path] = entry
        return JSON.parse(bytes)
    }
    const git = (...args) => execFileSync('git', args, {cwd: repository})
    const textGit = (...args) => git(...args).toString().trim()
    const gitBytes = (commit, path) => git('show', commit + ':' + path)
    const gitIdentity = (commit, path) => identity(gitBytes(commit, path))
    const base = 'corpus-full/builds/perf/native-record-fields-fusion-correctness-corpus/acquisition/'
    const actual = {}
    for (const arm of ['A', 'B']) {
        const prefix = base + 'jmdict/' + arm + '/'
        actual[arm] = {}
        for (const name of ['report', 'field-calls', 'owner-calls', 'workers', 'assets', 'files',
            'product-work-counts', 'source-before', 'source-after', 'cleanup']) {
            actual[arm][name] = await original(prefix + name + '.json')
        }
        actual[arm].prepared = await original(base + 'prepared-source-' + arm + '.json')
        assert.equal(actual[arm].report.passed, true)
        assert.equal(actual[arm].report.performanceMeasurements, false)
        assert.deepEqual(actual[arm]['source-before'], actual[arm]['source-after'])
        assert.deepEqual(actual[arm].cleanup, {completed: true, cleanupErrors: []})
        assert.deepEqual(actual[arm].prepared.runtimeFiles, actual[arm]['source-before'].runtimeFiles)
        assert.deepEqual(actual[arm].prepared.runtimeFiles, actual[arm].report.source.runtimeFiles)
        assert.equal(actual[arm].report.fieldRows, plan.fixture.rows)
        assert.equal(actual[arm].report.parserGroups, plan.fixture.parserGroups)
        assert.equal(actual[arm].report.parserWorkers, plan.fixture.parserWorkers)
        assert.equal(actual[arm].report.source.commit, arm === 'A' ? plan.arms.A.commit : observedProducer)
    }
    const comparison = await original(base + 'jmdict/comparison.json')
    assert.equal(comparison.passed, true)
    assert.equal(textGit('rev-parse', observedProducer + ':ext'), textGit('rev-parse', plan.arms.B.commit + ':ext'))
    for (const path of ['package.json', 'package-lock.json', 'test/perf/dictionaries.lock.json', 'dev/data/dictionary-wasm/manifest.json']) {
        assert.deepEqual(gitIdentity(observedProducer, path), gitIdentity(plan.arms.B.commit, path))
    }
    assert.deepEqual(textGit('rev-list', '--parents', '-n', '1', plan.arms.C.commit).split(' '), [plan.arms.C.commit, plan.arms.A.commit])
    const cDiff = textGit('diff', '--name-status', plan.arms.A.commit, plan.arms.C.commit, '--', 'ext').split('\n')
    assert.deepEqual(cDiff.sort(), unusedRuntime.filter((path) => !path.startsWith('lib/')).map((path) => 'A\text/' + path).sort())
    for (const path of callerPaths) assert.equal(textGit('rev-parse', plan.arms.A.commit + ':' + path), textGit('rev-parse', plan.arms.C.commit + ':' + path))
    const cChanged = textGit('diff', '--name-only', plan.arms.A.commit, plan.arms.C.commit).split('\n')
    assert.equal(cChanged.length, 10)
    for (const path of cChanged) assert.deepEqual(gitIdentity(plan.arms.C.commit, path), gitIdentity(plan.arms.B.commit, path))
    const runtime = {A: actual.A.prepared.runtimeFiles, B: actual.B.prepared.runtimeFiles,
        C: structuredClone(actual.A.prepared.runtimeFiles)}
    for (const path of unusedRuntime) {
        assert.equal(Object.hasOwn(runtime.A, path), false)
        assert.ok(runtime.B[path])
        const sourcePath = path.startsWith('lib/') ? 'dev/data/dictionary-wasm/term-record-fields.wasm' : 'ext/' + path
        assert.deepEqual(gitIdentity(plan.arms.C.commit, sourcePath), runtime.B[path])
        runtime.C[path] = runtime.B[path]
    }
    const expectedRuntimeDigests = {A: '6119c7310002869af86be34026cd334550917b435674e18abb35a326604ed743',
        B: '3c3f78d0c2d6bd3fad7fe84c34f52dcbffa272ed48cf81e10fb168199d3f61d2',
        C: '4f5574893fcbf077d8f16c2b75c6fb4f5dc7c22b4e97c8a2f5ea0174bdcdd803'}
    const prepared = {}
    for (const arm of ['A', 'B', 'C']) {
        const commit = plan.arms[arm].commit
        assert.equal(textGit('rev-parse', commit + '^{tree}'), plan.arms[arm].tree)
        const observed = actual[arm === 'C' ? 'A' : arm]
        for (const [path, name] of [['package.json', 'packageJson'], ['package-lock.json', 'packageLock']]) {
            assert.deepEqual(gitIdentity(commit, path), observed.prepared[name])
        }
        const fixtureLock = gitIdentity(commit, 'test/perf/dictionaries.lock.json')
        assert.deepEqual(fixtureLock, observed['source-before'].sources['test/perf/dictionaries.lock.json'])
        const nativeManifest = gitIdentity(commit, 'dev/data/dictionary-wasm/manifest.json')
        if (arm !== 'C') assert.deepEqual(nativeManifest, observed['source-before'].sources['dev/data/dictionary-wasm/manifest.json'])
        else assert.deepEqual(nativeManifest, gitIdentity(plan.arms.B.commit, 'dev/data/dictionary-wasm/manifest.json'))
        assert.deepEqual(gitIdentity(commit, 'ext/legal-npm.html'), observed.prepared.setupGeneratedLicense.committed)
        const preparedRuntimeDigest = digestValue(runtime[arm])
        assert.equal(preparedRuntimeDigest, expectedRuntimeDigests[arm])
        plan.arms[arm].preparedRuntimeDigest = preparedRuntimeDigest
        prepared[arm] = {commit, tree: plan.arms[arm].tree, runtimeFiles: runtime[arm], preparedRuntimeDigest,
            packageJson: observed.prepared.packageJson, packageLock: observed.prepared.packageLock,
            fixtureLock, nativeManifest, setupGeneratedLicense: observed.prepared.setupGeneratedLicense}
    }
    const work = {}
    const outputs = {}
    for (const arm of ['A', 'B']) {
        const data = actual[arm]
        const state = {owners: data['owner-calls'].owners, fields: data['field-calls'],
            observerErrors: data['owner-calls'].observerErrors, active: null}
        const accounting = verifyOwnerAccounting(state, data.report.fieldMetrics, arm, plan.fixture.rows)
        assert.deepEqual(accounting, data.report.ownerAccounting)
        assert.deepEqual(accounting, data['owner-calls'].accounting)
        verifyActivation(arm, data.report.fieldMetrics, [...data.assets, ...data.workers.flatMap((worker) => worker.assets)], plan)
        for (const asset of [...data.assets, ...data.workers.flatMap((worker) => worker.assets)]) {
            assert.equal(asset.sha256, data['source-before'].runtimeFiles[asset.path.slice(4)].sha256)
        }
        assetEvidence([...data.assets, ...data.workers.flatMap((worker) => worker.assets)], data['source-before'], data['source-after'])
        work[arm] = workSnapshot({report: data.report, owners: state.owners, fields: state.fields,
            workers: data.workers, phases: data['product-work-counts']})
        outputs[arm] = outputSnapshot(data.report, state.fields, data.files)
    }
    assert.deepEqual(outputs.A, outputs.B)
    work.C = structuredClone(work.A)
    const retainedBytes = actual.A.files.reduce((total, file) => total + file.bytes, 0)
    const fieldBytes = actual.A['field-calls'].reduce((total, call) => total + call.bytes, 0)
    assert.equal(retainedBytes, plan.storagePolicy.finalSinkBytesPerObservation)
    assert.equal(fieldBytes, plan.storagePolicy.fieldBufferBytesPerObservation)
    plan.expectedWork = work
    plan.expectedOutputDigest = digestValue(outputs.A)
    plan.mandatoryCheckNames = mandatoryCheckNames
    const workflowName = 'native-whole-import-cpu-screen-1c413.yml'
    plan.workflowBinding = {repository: 'ManabiIO/manabitan', ref: 'refs/heads/test/native-whole-import-cpu-screen-20261128-1c413',
        path: '.github/workflows/' + workflowName, sha256: sha(await readFile(join(root, 'workflow', workflowName))),
        jobs: {R1: 'screen_r1', R2: 'screen_r2'}}
    const sourceList = []
    for (const path of sourceFiles) sourceList.push({path: 'screen-kit/' + path, ...identity(await readFile(join(root, path)))})
    plan.commonDriver.files = sourceList
    const reference = {schema: 1, scope: 'Offline immutable reference projection; no new imports, clocks or observations',
        originalRun: '46149981540', attempt: 1, observedProducer,
        originalActionsArtifact: {id: '15265171488', sha256: 'c3923ee6d8a1ddfc06a136ee33f2da18ef64420b9f95498212e3148964218559'},
        publishedArchive: {gitBlob: '777b53f1d1cad5eaeeb22965af7e327124d59524',
            sha256: '52cc6c09c352696ba526eddaa2898b372a985a54b18970a2fe4e832a16ffc96c', bytes: 4760073},
        publishedLedgerGitBlob: 'fb018d784e7e5722606f3cb42c3230de2792d550',
        publishedMemberReadbackGitBlob: '1ec752fae8d1d90391b68dd97d362599f0162384',
        B: {observedRuntimeProducer: observedProducer, productCommit: plan.arms.B.commit,
            proof: 'Exact ext tree, packages, fixture lock and native manifest equality; prepared bytes remain the original observed B inventory'},
        C: {productCommit: plan.arms.C.commit, observed: false, expectedWorkFrom: 'A',
            runtimeBasis: 'Original observed stock A prepared runtime plus exactly four reviewed unused B assets/modules',
            unusedRuntime, stockCallerPaths: callerPaths, completeChangedPaths: cChanged,
            proof: 'Sole parent A; every existing ext file unchanged; all ten changed C paths match B; first actual C warmup must validate this expectation'},
        usedOriginalMembers: usedMembers, runtimeDigests: expectedRuntimeDigests,
        outputDigest: plan.expectedOutputDigest, workDigests: Object.fromEntries(Object.entries(work).map(([arm, value]) => [arm, digestValue(value)])),
        rawInputsRetained: 'Original immutable archive contains every used member; individual Git IDs identify contents, not separate remote fetch endpoints'}
    const preparation = {schema: 1, passed: true, referenceScope: 'Frozen prospective preparation expectation; C has not been imported',
        nodeVersion: plan.nodeVersion, workflowBinding: plan.workflowBinding, runtimePolicy: plan.runtimePolicy,
        commonDriverFilesDigest: digestValue(sourceList), fixture: {sha256: plan.fixture.sha256, bytes: plan.fixture.bytes},
        arms: prepared, reference}
    await mkdir(join(root, 'references'), {recursive: true})
    await writeFile(join(root, 'references', 'work.json'), canonicalJson(work))
    await writeFile(join(root, 'references', 'output.json'), canonicalJson(outputs.A))
    await writeFile(join(root, 'references', 'projection.json'), canonicalJson(reference))
    const preparationBytes = Buffer.from(canonicalJson(preparation))
    await writeFile(join(root, 'references', 'preparation.json'), preparationBytes)
    plan.preparationReceipt = {relativePath: 'screen-kit/references/preparation.json', sha256: sha(preparationBytes)}
    await writeFile(join(root, 'plan.json'), canonicalJson(plan))
    return {passed: true, scope: reference.scope, runtimeDigests: expectedRuntimeDigests,
        outputDigest: plan.expectedOutputDigest, workDigests: reference.workDigests,
        preparationSha256: plan.preparationReceipt.sha256, planSha256: sha(await readFile(join(root, 'plan.json'))),
        dictionaryImports: 0, timingObservations: 0, productModulesImported: 0}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    console.log(canonicalJson(await project(process.argv.slice(2))).trim())
}
