/* SPDX-License-Identifier: GPL-3.0-or-later */
// Disabled until the exact source, preparation, workflow, work and output plan is sealed.
// Product startup is unchanged. There is no optional-helper readiness wait or preload.
import assert from 'node:assert/strict'
import {openAsBlob} from 'node:fs'
import {mkdir, readFile, readdir, realpath, statfs, writeFile} from 'node:fs/promises'
import {join, resolve} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {createDiskOpfs, installDiskOpfs} from './node-opfs-disk.mjs'
import {installFileRuntime, installWorkers} from './node-runtime.mjs'
import {observeRecordOwners, finalizeOwnerEvidence, verifyOwnerAccounting} from './owner-observer.mjs'
import {createCpuBoundary, runImportBoundary} from './cpu-boundary.mjs'
import {assetEvidence, digestValue, endpointProven, fileDigest, inventoryFiles,
    outputSnapshot, pathWithin, readPreparedSource, requireSealedDefinition, sha,
    validatePreparedInputs, verifyActivation, workSnapshot} from './receipt-adapter.mjs'

function withoutClocks(value) {
    if (Array.isArray(value)) return value.map(withoutClocks)
    if (value === null || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value).filter(([key]) => !/(?:Ms|Timestamp|Duration)$/.test(key))
        .map(([key, item]) => [key, withoutClocks(item)]))
}

export async function main(argumentsList, environment = process.env) {
    const [repositoryArgument, dictionary, archiveArgument, outputArgument, arm, expectedCommit, mode = 'untimed'] = argumentsList
    assert.ok(argumentsList.length === 6 || argumentsList.length === 7)
    assert.ok([repositoryArgument, dictionary, archiveArgument, outputArgument, arm, expectedCommit].every(Boolean))
    assert.ok(['A', 'B', 'C'].includes(arm) && ['untimed', 'cpu-screen'].includes(mode))
    // Default untimed mode also acquires nothing without a sealed screen plan.
    assert.ok(environment.MANABITAN_RECORD_CPU_SCREEN_PLAN, 'No authorized frozen screen plan')
    const planBytes = await readFile(resolve(environment.MANABITAN_RECORD_CPU_SCREEN_PLAN))
    const plan = JSON.parse(planBytes)
    requireSealedDefinition(plan)
    assert.ok(environment.MANABITAN_RECORD_CPU_SCREEN_WORKSPACE && environment.MANABITAN_RECORD_CPU_SCREEN_REPLICATION)
    const workspace = await realpath(resolve(environment.MANABITAN_RECORD_CPU_SCREEN_WORKSPACE))
    const replication = environment.MANABITAN_RECORD_CPU_SCREEN_REPLICATION
    const repository = await realpath(resolve(repositoryArgument))
    const archive = await realpath(resolve(archiveArgument))
    assert.equal(repository, await realpath(pathWithin(workspace, plan.arms[arm].relativeRoot)))
    assert.equal(archive, await realpath(pathWithin(workspace, plan.fixture.relativePath)))
    assert.equal(await realpath(fileURLToPath(import.meta.url)), await realpath(pathWithin(workspace, plan.commonDriver.relativeEntry)))
    assert.equal(dictionary, plan.fixture.dictionary)
    assert.equal(expectedCommit, plan.arms[arm].commit)
    const prepared = await validatePreparedInputs({plan, workspace, arm, mode, replication})
    const kit = fileURLToPath(new URL('.', import.meta.url))
    const output = resolve(outputArgument)
    await mkdir(output, {recursive: false})
    const boundary = createCpuBoundary(mode)
    const hash = (bytes) => { boundary.assertOutside(); return sha(bytes) }
    const json = (value) => {
        boundary.assertOutside()
        return JSON.stringify(value, (_, item) => typeof item === 'bigint' ? String(item) : item, 2) + '\n'
    }
    const save = async (name, value) => { boundary.assertOutside(); await writeFile(join(output, name), json(value), {flag: 'wx'}) }
    const rawAssets = []
    let adapter = null
    let workers = null
    let database = null
    let store = null
    let observed = null
    let imported = null
    let finalizedMetrics = null
    let fieldMetrics = null
    let forwardedMetrics = null
    let rawSemantic = null
    let initialContentState = null
    let finalContentState = null
    let semanticProbesCompleted = false
    let originalConnection = null
    let originalSupported = null
    let execution = null
    let fieldEvidence = []
    let ownerAccounting = null
    let failure = null
    let completed = false
    const cleanup = {completed: false, imported: false, semanticProbesCompleted: false,
        storeSessionRetired: false, parserDisposed: false, databaseClosed: false,
        workersJoined: false, endpointProven: false, cleanupErrors: []}
    const adapterDiagnostics = {mode: 'complete-import-screen-memory-sqlite', persistentSqlite: false,
        usesFallbackStorageOverride: false,
        reason: 'Select the real disk-backed generation-media route while SQLite itself is nonpersistent'}
    const flags = {prefixWildcardsSupported: true, yomitanVersion: '0.0.0.0',
        skipImageMetadata: true, skipMediaImport: false, zipUseWebWorkers: false}
    let rawFieldsSaved = false
    const retainRawFields = async () => {
        boundary.assertOutside()
        if (rawFieldsSaved || observed === null) return
        try { await mkdir(join(output, 'field-bytes')) }
        catch (cause) { if (cause?.code !== 'EEXIST') throw cause }
        for (const call of observed.fields) {
            assert.equal(call.owningBytes.byteLength, call.bytes)
            const path = join(output, 'field-bytes', String(call.ordinal).padStart(5, '0') + '.bin')
            try { await writeFile(path, call.owningBytes, {flag: 'wx'}) }
            catch (cause) {
                if (cause?.code !== 'EEXIST') throw cause
                assert.deepEqual(await fileDigest(path), {bytes: call.bytes, sha256: hash(call.owningBytes)})
            }
        }
        rawFieldsSaved = true
    }
    try {
        const fixtureLock = JSON.parse(await readFile(join(repository, 'test/perf/dictionaries.lock.json'), 'utf8'))
        const fixture = fixtureLock.dictionaries[dictionary]
        assert.equal(prepared.fixture.sha256, fixture.sha256)
        assert.equal(prepared.fixture.bytes, fixture.sizeBytes)
        assert.equal(fixture.termRows, plan.fixture.rows)
        const space = await statfs(output, {bigint: true})
        const freeBytes = space.bavail * space.bsize
        assert.ok(freeBytes >= 4n * 1024n * 1024n * 1024n, 'At least 4 GiB disk-backed free space is required')
        assert.notEqual(space.type, 0x01021994n, 'The complete corpus sink cannot be tmpfs')
        const expectedConnection = (await readFile(join(kit, 'baseline-open-connection.txt'), 'utf8')).trim()
        const expectedSupported = (await readFile(join(kit, 'baseline-open-supported-connection.txt'), 'utf8')).trim()
        const expectedSchemaConstant = (await readFile(join(kit, 'baseline-storage-schema-version.txt'), 'utf8')).trim()
        const databaseSource = await readFile(join(repository, 'ext/js/dictionary/dictionary-database.js'), 'utf8')
        const schemaLines = databaseSource.split('\n').filter((line) => /^const ONLINE_CONTENT_DICTIONARY_SCHEMA_VERSION = /.test(line))
        assert.deepEqual(schemaLines, [expectedSchemaConstant])
        const schemaMatch = /^const ONLINE_CONTENT_DICTIONARY_SCHEMA_VERSION = (12);$/.exec(expectedSchemaConstant)
        assert.ok(schemaMatch)
        adapter = await createDiskOpfs(join(output, 'disk'))
        await installFileRuntime(repository, (asset) => rawAssets.push(asset))
        installDiskOpfs(adapter, {hardwareConcurrency: 4, deviceMemory: 8})
        workers = installWorkers(repository, adapter.state)
        const moduleUrl = (path) => pathToFileURL(join(repository, path)).href

        execution = await runImportBoundary(boundary, async () => {
            // FIRST product evaluation: both CPU/wall starts already occurred.
            const [{DictionaryDatabase}, {DictionaryImporter}, sqliteModule] = await Promise.all([
                import(moduleUrl('ext/js/dictionary/dictionary-database.js')),
                import(moduleUrl('ext/js/dictionary/dictionary-importer.js')),
                import(moduleUrl('ext/js/dictionary/sqlite-wasm.js')),
            ])
            originalConnection = DictionaryDatabase.prototype._openConnection.toString().trim()
            originalSupported = DictionaryDatabase.prototype._openSupportedDictionaryConnection.toString().trim()
            assert.equal(originalConnection, expectedConnection, 'Production outer SQLite lifecycle body changed')
            assert.equal(originalSupported, expectedSupported, 'Production SQLite admission body changed')
            // Same narrow current-source host adapter as the fresh correctness
            // driver. The outer _openConnection and all optional startup methods
            // stay installed unchanged. No helper/module is preloaded here.
            const rebound = new Function('openOpfsDatabase', 'getLastOpenStorageDiagnostics',
                'didLastOpenUseFallbackStorage', 'ONLINE_CONTENT_DICTIONARY_SCHEMA_VERSION',
                'return (' + originalSupported.replace(/^async _openSupportedDictionaryConnection\(/,
                    'async function _openSupportedDictionaryConnection(') + ')'
            )(
                async () => new (await sqliteModule.getSqlite3()).oo1.DB(':memory:', 'c'),
                () => ({...adapterDiagnostics}), () => false, Number(schemaMatch[1])
            )
            DictionaryDatabase.prototype._openSupportedDictionaryConnection = rebound
            assert.equal(DictionaryDatabase.prototype._openConnection.toString().trim(), expectedConnection)
            database = new DictionaryDatabase()
            store = database._termRecordStore
            observed = observeRecordOwners(store)
            await database.prepare()
            assert.equal(database._usesFallbackStorage, false)
            assert.equal(store._importRecordFieldSession ?? null, null)
            initialContentState = database.getOnlineContentStorageState()
            assert.equal(initialContentState.epoch, 0)
            assert.equal(initialContentState.logicalHighWater, 0)
            const importer = new DictionaryImporter({
                async getImageDetails() { throw new Error('Image metadata decoding is outside this Node lane') },
            })
            imported = await importer.importDictionary(database, await openAsBlob(archive), flags)
            assert.deepEqual(imported.errors.map(String), [])
            assert.ok(imported.result)
            assert.equal(imported.outcome?.status, 'published')
            assert.equal(imported.result.title, fixture.expectedTitle)
            assert.equal(imported.result.revision, fixture.revision)
            assert.equal(imported.result.counts.terms.total, fixture.termRows)
            finalizedMetrics = store.getLastEndImportSessionMetrics()
            fieldMetrics = finalizedMetrics?.recordFields ?? null
            forwardedMetrics = imported.debug?.phaseTimings.find((phase) => phase.phase === 'bulk-finalization')?.details?.termRecordFields ?? null
            // Fixed functional probes remain inside the same uninterrupted
            // interval. Their output digests and all observer ledger checks wait.
            const sample = await database.debugSampleTermContentIntegrity(fixture.expectedTitle, 12)
            assert.equal(sample.outOfBoundsRecordCount, 0)
            assert.ok(sample.sampledRecordCount > 0)
            const queries = [...new Set(sample.sampledRecords.map((row) => row.expression))]
            const lookup = await database.findTermsBulk(queries, new Set([fixture.expectedTitle]), 'exact')
            assert.ok(lookup.length > 0)
            const counts = await database.getDictionaryCounts([fixture.expectedTitle], true)
            finalContentState = database.getOnlineContentStorageState()
            assert.equal(finalContentState.epoch, 0)
            rawSemantic = {title: imported.result.title, revision: imported.result.revision, counts,
                contentState: {epoch: finalContentState.epoch, logicalHighWater: finalContentState.logicalHighWater, manifest: finalContentState.manifest},
                summaryCounts: imported.result.counts,
                sample: {sampledRecordCount: sample.sampledRecordCount, outOfBoundsRecordCount: sample.outOfBoundsRecordCount,
                    sampledRecords: sample.sampledRecords}, queries, lookupRows: lookup.length, lookup}
            semanticProbesCompleted = true
        }, async () => {
            // Retirement runs for every original attempt. There is no startup
            // rebind, optional readiness await, polling delay or replacement work.
            try {
                const parser = await import(moduleUrl('ext/js/dictionary/term-bank-wasm-parser.js'))
                await parser.disposeParallelTermBankParser()
                cleanup.parserDisposed = true
            } catch (cause) { cleanup.cleanupErrors.push(String(cause)) }
            try {
                if (database !== null) await database.close()
                cleanup.databaseClosed = true
            } catch (cause) { cleanup.cleanupErrors.push(String(cause)) }
            try {
                await workers.close()
                const joined = workers.snapshot()
                cleanup.workersJoined = joined.liveWorkers === 0 && joined.allExited
            } catch (cause) { cleanup.cleanupErrors.push(String(cause)) }
            // Only retain primitive lifecycle witnesses while the interval runs.
            cleanup.storeSessionRetired = store !== null && (store._importRecordFieldSession ?? null) === null
            cleanup.imported = imported?.outcome?.status === 'published' && imported.errors.length === 0
            cleanup.semanticProbesCompleted = semanticProbesCompleted
            return cleanup
        })

        // All calls below are after both end snapshots and complete normal
        // retirement. The raw owning field buffers have remained alive in all arms.
        boundary.assertOutside()
        await retainRawFields()
        if (execution.error !== null) throw execution.error
        const allRawAssets = [...rawAssets, ...workers.receipts.flatMap((worker) => worker.assets)]
        cleanup.endpointProven = endpointProven({arm, fieldMetrics, assets: allRawAssets, plan, ...cleanup})
        assert.equal(cleanup.endpointProven, true, 'Unproven endpoint fails this original screen attempt')
        assert.deepEqual(forwardedMetrics, fieldMetrics)
        const evidence = finalizeOwnerEvidence(observed, hash, () => boundary.assertOutside())
        fieldEvidence = evidence.fields
        ownerAccounting = verifyOwnerAccounting(evidence, fieldMetrics, arm, fixture.termRows)
        verifyActivation(arm, fieldMetrics, allRawAssets, plan)
        const parserWorkers = workers.receipts.filter((worker) => worker.entry === 'term-bank-wasm-parser-worker.js')
        assert.equal(parserWorkers.length, plan.fixture.parserWorkers)
        assert.ok(parserWorkers.every((worker) => worker.ready === 1))
        assert.ok(workers.receipts.every((worker) => worker.failures.length === 0))
        const groups = parserWorkers.flatMap((worker) => worker.parseRequests)
        const results = parserWorkers.flatMap((worker) => worker.parseResults)
        assert.equal(groups.length, plan.fixture.parserGroups)
        assert.equal(results.length, groups.length)
        assert.equal(results.reduce((total, result) => total + result.rowCount, 0), fixture.termRows)
        const files = await inventoryFiles(adapter.context.root)
        assert.deepEqual(await readdir(adapter.context.staging), [])
        const fixtureAfter = await fileDigest(archive)
        assert.deepEqual(fixtureAfter, prepared.fixture)
        const sourceAfter = await readPreparedSource(repository, expectedCommit)
        assert.deepEqual(sourceAfter, prepared.source)
        const assets = assetEvidence(rawAssets, prepared.source, sourceAfter)
        for (const worker of workers.receipts) worker.assets = assetEvidence(worker.assets, prepared.source, sourceAfter)
        const {lookup, ...semanticValues} = rawSemantic
        const semantic = {...semanticValues, lookupSha256: hash(json(lookup))}
        const phases = imported.debug?.phaseTimings.map((phase) => ({phase: phase.phase, details: withoutClocks(phase.details)})) ?? []
        const report = {schema: 1, passed: true, arm, mode, dictionary,
            boundary: plan.boundary, performanceMeasurements: mode === 'cpu-screen',
            sourceCommit: expectedCommit, sourceTree: prepared.source.tree, fixture: prepared.fixture,
            planSha256: hash(planBytes), timing: execution.timing,
            sqlite: adapterDiagnostics, flags, semantic,
            fieldCalls: fieldEvidence.length, fieldRows: fieldEvidence.reduce((total, call) => total + call.rowCount, 0),
            ownerCalls: evidence.owners.length, fieldMetrics, ownerAccounting,
            parserGroups: groups.length, parserWorkers: parserWorkers.length,
            optionalAssets: assets.filter((asset) => asset.path.endsWith('/term-record-fields.wasm')),
            limitations: ['Real memory SQLite plus disk OPFS-shaped sidecars; no browser or persistent SQLite qualification',
                'Fresh epoch-zero content only; only documented 16-byte file generation identities normalized',
                'One enclosing process-wide CPU interval includes fixed semantic probes and normal retirement',
                'Optional startup remains fire-and-forget; unactivated/failed endpoints fail the entire screen',
                'Asset path/length observed during execution; frozen source-file digests verified after retirement']}
        const work = workSnapshot({report, owners: evidence.owners, fields: fieldEvidence, workers: workers.receipts, phases})
        const outputEvidence = outputSnapshot(report, fieldEvidence, files)
        assert.deepEqual(work, plan.expectedWork[arm])
        assert.equal(digestValue(outputEvidence), plan.expectedOutputDigest)
        await save('source-before.json', prepared.source)
        await save('source-after.json', sourceAfter)
        await save('fixture-after.json', fixtureAfter)
        await save('host.json', prepared.host)
        await save('fixture-and-host.json', {fixture, fixtureBefore: prepared.fixture, freeBytes: String(freeBytes), filesystemType: String(space.type)})
        await save('sqlite-adapter.json', {...adapterDiagnostics,
            originalOpenConnectionSha256: hash(originalConnection), originalSupportedConnectionSha256: hash(originalSupported),
            schemaConstantSha256: hash(expectedSchemaConstant), schemaConstant: Number(schemaMatch[1]),
            originalBodiesByteIdentical: true, outerMethodUnmodified: true})
        await save('initial-content-state.json', initialContentState)
        await save('final-content-state.json', finalContentState)
        await save('field-calls.json', fieldEvidence)
        await save('owner-calls.json', {schema: 1, owners: evidence.owners, observerErrors: evidence.observerErrors, accounting: ownerAccounting})
        await save('files.json', files)
        await save('workers.json', workers.receipts)
        await save('assets.json', assets)
        await save('product-work-counts.json', phases)
        await save('final-store-counts.json', withoutClocks(finalizedMetrics))
        await save('semantic.json', semantic)
        await save('work.json', work)
        await save('output.json', outputEvidence)
        await save('timing.json', execution.timing)
        await save('report.json', report)
        completed = true
    } catch (cause) {
        failure = cause
        // A failed original attempt is evidence, never a removable observation.
        cleanup.endpointProven = false
        if (boundary.phase === 'running') throw new Error('Boundary did not retire; original process must fail', {cause})
        let retained = null
        try {
            await retainRawFields()
            if (observed !== null) {
                retained = finalizeOwnerEvidence(observed, hash, () => boundary.assertOutside())
                fieldEvidence = retained.fields
            }
        } catch (retentionError) { cleanup.cleanupErrors.push('Retained evidence: ' + String(retentionError)) }
        await save('failure.json', {schema: 1, passed: false, arm, mode, dictionary,
            error: String(cause), stack: cause?.stack, endpointProven: false,
            timing: execution?.timing ?? null, sourceBefore: prepared.source, fixtureBefore: prepared.fixture,
            fieldCalls: fieldEvidence, owners: retained?.owners ?? [], ownerAccounting,
            assets: rawAssets, workers: workers?.receipts ?? [], finalizedMetrics: withoutClocks(finalizedMetrics)})
    } finally {
        // No second cleanup/worker wait occurs after the measured endpoint.
        cleanup.completed = completed
        await save('cleanup.json', cleanup)
    }
    if (failure !== null) throw failure
    console.log(json({passed: true, arm, dictionary, mode, performanceMeasurements: mode === 'cpu-screen'}).trim())
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    await main(process.argv.slice(2))
}
