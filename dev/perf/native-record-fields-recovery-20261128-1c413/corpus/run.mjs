/* SPDX-License-Identifier: GPL-3.0-or-later */
// NEW actual-import correctness driver. No benchmark clock or optional-helper readiness wait.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {createReadStream, openAsBlob} from 'node:fs'
import {lstat, mkdir, open, readFile, readdir, realpath, statfs, writeFile} from 'node:fs/promises'
import {basename, join, relative, resolve, sep} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {createDiskOpfs, installDiskOpfs} from './node-opfs-disk.mjs'
import {installFileRuntime, installWorkers} from './node-runtime.mjs'

const [repositoryArgument, dictionary, archiveArgument, outputArgument, arm, expectedCommit] = process.argv.slice(2)
if (![repositoryArgument, dictionary, archiveArgument, outputArgument, arm, expectedCommit].every(Boolean) ||
    !['jmdict', 'jitendex', 'vndb'].includes(dictionary) || !['A', 'B'].includes(arm) ||
    !/^[0-9a-f]{40}$/.test(expectedCommit)) {
    throw new Error('Usage: node run.mjs REPOSITORY DICTIONARY ARCHIVE FRESH_OUTPUT A|B EXPECTED_COMMIT')
}
if (process.version !== 'v22.22.0') throw new Error('The prospective driver requires Node v22.22.0')
const repository = await realpath(resolve(repositoryArgument))
const archive = await realpath(resolve(archiveArgument))
const output = resolve(outputArgument)
const kit = fileURLToPath(new URL('.', import.meta.url))
await mkdir(output, {recursive: false})
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const json = (value) => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? String(item) : item, 2) + '\n'
const save = async (name, value) => { await writeFile(join(output, name), json(value)) }
const git = (...args) => execFileSync('git', args, {cwd: repository, encoding: 'utf8'}).trim()
const sourcePaths = [
    'ext/js/dictionary/dictionary-database.js', 'ext/js/dictionary/dictionary-importer.js',
    'ext/js/dictionary/sqlite-wasm.js', 'ext/js/dictionary/term-record-opfs-store.js',
    'ext/js/dictionary/term-content-opfs-store.js', 'ext/js/dictionary/term-bank-wasm-parser.js',
    'ext/js/dictionary/term-bank-wasm-parser-worker.js', 'ext/js/dictionary/zstd-term-content.js',
    'ext/js/dictionary/zstd-term-content-compression-worker.js',
    'ext/js/dictionary/term-record-import-index-worker.js',
    'ext/js/dictionary/dictionary-generation-media-store.js',
    'test/perf/dictionaries.lock.json', 'dev/data/dictionary-wasm/manifest.json',
    'ext/lib/term-bank-parser.wasm', 'ext/lib/term-content-canonical-scan-v1.wasm'
]
const optionalPaths = ['ext/js/dictionary/term-record-fields.js', 'ext/lib/term-record-fields.wasm',
    'ext/js/dictionary/wasm/term-record-fields.c', 'dev/data/dictionary-wasm/term-record-fields.wasm']
async function fileDigest(path) {
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length }
    return {sha256: hash.digest('hex'), bytes}
}
async function sourceBinding() {
    assert.equal(git('rev-parse', 'HEAD'), expectedCommit)
    const trackedChanges = git('diff', '--name-only', 'HEAD').split('\n').filter(Boolean)
    assert.ok(trackedChanges.every((path) => path === 'ext/legal-npm.html'),
        'Only the explicitly recorded setup-generated license page may differ from the commit')
    const committedLegal = execFileSync('git', ['show', 'HEAD:ext/legal-npm.html'], {cwd: repository})
    const setupGeneratedLicense = {
        path: 'ext/legal-npm.html',
        committed: {bytes: committedLegal.byteLength, sha256: sha(committedLegal)},
        generated: await fileDigest(join(repository, 'ext/legal-npm.html')),
        listedTrackedDelta: trackedChanges.includes('ext/legal-npm.html')
    }
    const sources = {}
    for (const path of [...sourcePaths, ...optionalPaths]) {
        try { sources[path] = await fileDigest(join(repository, path)) }
        catch (cause) {
            if (!optionalPaths.includes(path) || cause?.code !== 'ENOENT') throw cause
            sources[path] = null
        }
    }
    const runtimeFiles = {}
    async function walkRuntime(directory) {
        for (const entry of (await readdir(directory)).sort()) {
            const path = join(directory, entry)
            const details = await lstat(path)
            if (details.isSymbolicLink()) throw new Error('Runtime tree cannot contain symlinks')
            if (details.isDirectory()) await walkRuntime(path)
            else if (details.isFile()) runtimeFiles[relative(join(repository, 'ext'), path).split(sep).join('/')] = await fileDigest(path)
            else throw new Error('Unsupported runtime tree member')
        }
    }
    await walkRuntime(join(repository, 'ext'))
    const nativeManifest = JSON.parse(await readFile(join(repository, 'dev/data/dictionary-wasm/manifest.json'), 'utf8'))
    for (const target of nativeManifest.targets) {
        assert.equal(basename(target.name), target.name)
        const artifact = await fileDigest(join(repository, 'dev/data/dictionary-wasm', target.name))
        assert.equal(artifact.sha256, target.sha256)
        assert.deepEqual(runtimeFiles['lib/' + target.name], artifact, 'Generated native asset does not match the pinned artifact')
    }
    const kitFiles = {}
    for (const path of (await readdir(kit)).sort()) {
        const details = await lstat(join(kit, path))
        if (details.isSymbolicLink()) throw new Error('Kit cannot contain symlinks')
        if (details.isFile()) kitFiles[path] = await fileDigest(join(kit, path))
    }
    return {commit: expectedCommit, tree: git('rev-parse', 'HEAD^{tree}'), sources, runtimeFiles, setupGeneratedLicense, kit: kitFiles}
}
function withoutClocks(value) {
    if (Array.isArray(value)) return value.map(withoutClocks)
    if (value === null || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !/(?:Ms|Timestamp|Duration)$/.test(key))
        .map(([key, item]) => [key, withoutClocks(item)]))
}
async function inventoryFiles(root) {
    const files = []
    async function visit(directory) {
        for (const child of (await readdir(directory)).sort()) {
            const path = join(directory, child)
            const details = await lstat(path)
            if (details.isSymbolicLink()) throw new Error('Unexpected OPFS symlink')
            if (details.isDirectory()) { await visit(path); continue }
            if (!details.isFile()) throw new Error('Unexpected OPFS entry kind')
            const logicalPath = relative(root, path).split(sep).join('/')
            const file = await open(path, 'r')
            const prefix = Buffer.alloc(Math.min(40, details.size))
            try {
                let done = 0
                while (done < prefix.length) {
                    const result = await file.read(prefix, done, prefix.length - done, done)
                    if (result.bytesRead === 0) throw new Error('File header changed during inventory')
                    done += result.bytesRead
                }
            } finally { await file.close() }
            const magic = prefix.subarray(0, 8).toString('ascii')
            const termPayload = /^manabitan-term-content\.bin(?:\^.*)?$/.test(logicalPath) ||
                (logicalPath.startsWith('manabitan-term-records/') && /\.(?:mbtr|mbti)$/.test(logicalPath))
            const normalization = termPayload && logicalPath.endsWith('.mbtr') && magic === 'MBTRD16X' ?
                {offset: 8, bytes: 16, format: magic} :
                termPayload && logicalPath.endsWith('.mbti') && magic === 'MBTIDX11' ?
                    {offset: 24, bytes: 16, format: magic} : null
            if (normalization && details.size < normalization.offset + normalization.bytes) {
                throw new Error('Truncated generation header')
            }
            const raw = createHash('sha256')
            const normalized = createHash('sha256')
            let offset = 0
            for await (const chunk of createReadStream(path, {highWaterMark: 1024 * 1024})) {
                raw.update(chunk)
                if (normalization && offset < normalization.offset + normalization.bytes &&
                    offset + chunk.length > normalization.offset) {
                    const copy = Buffer.from(chunk)
                    copy.fill(0, Math.max(0, normalization.offset - offset),
                        Math.min(copy.length, normalization.offset + normalization.bytes - offset))
                    normalized.update(copy)
                } else normalized.update(chunk)
                offset += chunk.length
            }
            assert.equal(offset, details.size)
            if (termPayload && logicalPath.endsWith('.mbtr')) assert.equal(magic, 'MBTRD16X')
            if (termPayload && logicalPath.endsWith('.mbti')) assert.equal(magic, 'MBTIDX11')
            files.push({path: logicalPath, bytes: offset, sha256: raw.digest('hex'),
                normalizedSha256: normalized.digest('hex'), normalization, termPayload})
        }
    }
    await visit(root)
    return files
}
const assets = []
const fieldCalls = []
let database = null
let workers = null
let adapter = null
let parser = null
let bindingBefore = null
let fixtureBefore = null
let imported = null
let finalizedMetrics = null
let completed = false
let failure = null
try {
    bindingBefore = await sourceBinding()
    await save('source-before.json', bindingBefore)
    const fixtureLock = JSON.parse(await readFile(join(repository, 'test/perf/dictionaries.lock.json'), 'utf8'))
    const fixture = fixtureLock.dictionaries[dictionary]
    fixtureBefore = await fileDigest(archive)
    assert.equal(fixtureBefore.sha256, fixture.sha256)
    assert.equal(fixtureBefore.bytes, fixture.sizeBytes)
    const space = await statfs(output, {bigint: true})
    const freeBytes = space.bavail * space.bsize
    // Prospective fixed correctness budget, not a measured optimization threshold.
    assert.ok(freeBytes >= 4n * 1024n * 1024n * 1024n, 'At least 4 GiB of disk-backed free space is required')
    const tmpfs = 0x01021994n
    assert.notEqual(space.type, tmpfs, 'The full corpus sink must not be tmpfs')
    await save('fixture-and-host.json', {
        dictionary, arm, fixture, fixtureBefore, node: process.version,
        v8: process.versions.v8, platform: process.platform, architecture: process.arch,
        hardwareConcurrencyExposed: 4, deviceMemoryExposed: 8,
        freeBytes: String(freeBytes), filesystemType: String(space.type),
        performanceMeasurements: false, coldProcess: true
    })
    adapter = await createDiskOpfs(join(output, 'disk'))
    await installFileRuntime(repository, (asset) => assets.push(asset))
    installDiskOpfs(adapter, {hardwareConcurrency: 4, deviceMemory: 8})
    workers = installWorkers(repository, adapter.state)
    const moduleUrl = (path) => pathToFileURL(join(repository, path)).href
    const [{DictionaryDatabase}, {DictionaryImporter}, sqliteModule, diagnostics, errors] = await Promise.all([
        import(moduleUrl('ext/js/dictionary/dictionary-database.js')),
        import(moduleUrl('ext/js/dictionary/dictionary-importer.js')),
        import(moduleUrl('ext/js/dictionary/sqlite-wasm.js')),
        import(moduleUrl('ext/js/core/diagnostics-reporter.js')),
        import(moduleUrl('ext/js/core/to-error.js'))
    ])
    const originalConnection = DictionaryDatabase.prototype._openConnection.toString().trim()
    const expectedConnection = (await readFile(join(kit, 'baseline-open-connection.txt'), 'utf8')).trim()
    assert.equal(originalConnection, expectedConnection, 'Production SQLite lifecycle body changed')
    const adapterDiagnostics = {
        mode: 'correctness-only-memory-sqlite',
        persistentSqlite: false,
        usesFallbackStorageOverride: false,
        reason: 'Select the real disk-backed generation-media route while SQLite itself is nonpersistent'
    }
    const rebound = new Function('getSqlite3', 'openOpfsDatabase', 'didLastOpenUseFallbackStorage',
        'getLastOpenStorageDiagnostics', 'reportDiagnostics', 'toError',
        'return (' + originalConnection.replace(/^async _openConnection\(/, 'async function _openConnection(') + ')'
    )(
        sqliteModule.getSqlite3,
        async () => new (await sqliteModule.getSqlite3()).oo1.DB(':memory:', 'c'),
        () => false, () => ({...adapterDiagnostics}), diagnostics.reportDiagnostics, errors.toError
    )
    assert.equal(typeof rebound, 'function')
    DictionaryDatabase.prototype._openConnection = rebound
    await save('sqlite-adapter.json', {...adapterDiagnostics,
        originalOpenConnectionSha256: sha(originalConnection), originalBodyByteIdentical: true})
    database = new DictionaryDatabase()
    const store = database._termRecordStore
    const originalEncode = store._encodeArtifactRecordFields
    store._encodeArtifactRecordFields = function (...args) {
        const before = this._getImportRecordFieldMetrics?.() ?? null
        const bytes = Reflect.apply(originalEncode, this, args)
        assert.ok(bytes instanceof Uint8Array)
        const after = this._getImportRecordFieldMetrics?.() ?? null
        fieldCalls.push({
            ordinal: fieldCalls.length, rowCount: args[0].rowCount,
            contentOffsetBase: args[3], bytes: bytes.byteLength, sha256: sha(bytes), before, after
        })
        return bytes
    }
    // prepare() runs its unchanged compression initialization. This driver does not
    // await any optional field encoder, prewarm its module, or force its readiness.
    await database.prepare()
    assert.equal(database._usesFallbackStorage, false)
    assert.equal(store._importRecordFieldSession ?? null, null)
    const importer = new DictionaryImporter({
        async getImageDetails() { throw new Error('Image metadata decoding is outside this Node correctness lane') }
    })
    const flags = {
        prefixWildcardsSupported: true,
        yomitanVersion: '0.0.0.0',
        skipImageMetadata: true,
        skipMediaImport: false,
        zipUseWebWorkers: false
    }
    await save('import-flags.json', flags)
    imported = await importer.importDictionary(database, await openAsBlob(archive), flags)
    assert.deepEqual(imported.errors.map(String), [])
    assert.ok(imported.result)
    assert.equal(imported.outcome?.status, 'published')
    assert.equal(imported.result.title, fixture.expectedTitle)
    assert.equal(imported.result.revision, fixture.revision)
    assert.equal(imported.result.counts.terms.total, fixture.termRows)
    finalizedMetrics = store.getLastEndImportSessionMetrics()
    const fieldMetrics = finalizedMetrics?.recordFields ?? null
    const forwardedMetrics = imported.debug?.phaseTimings.find((phase) => phase.phase === 'bulk-finalization')?.details?.termRecordFields ?? null
    assert.deepEqual(forwardedMetrics, fieldMetrics, 'Database terminal field metrics differ from the owning store')
    if (arm === 'B') {
        assert.ok(fieldMetrics, 'Candidate must publish actual session counters')
        assert.equal(fieldMetrics.calls, fieldCalls.length)
        assert.equal(fieldMetrics.calls, fieldMetrics.javascriptCalls + (fieldMetrics.native?.nativeCalls ?? 0))
        assert.equal(store._importRecordFieldSession, null, 'Candidate owner must retire after final flush')
        for (const call of fieldCalls) {
            assert.ok(call.before && call.after)
            assert.equal(call.after.calls, call.before.calls + 1)
            assert.equal(call.after.calls, call.after.javascriptCalls + (call.after.native?.nativeCalls ?? 0))
            const nativeDelta = (call.after.native?.nativeCalls ?? 0) - (call.before.native?.nativeCalls ?? 0)
            assert.ok(nativeDelta === 0 || nativeDelta === 1)
            assert.equal(call.after.javascriptCalls - call.before.javascriptCalls, 1 - nativeDelta)
            assert.equal((call.after.native?.nativeRows ?? 0) - (call.before.native?.nativeRows ?? 0),
                nativeDelta * call.rowCount)
            assert.equal((call.after.native?.outputCopiedBytes ?? 0) - (call.before.native?.outputCopiedBytes ?? 0),
                nativeDelta * call.bytes)
            for (const [key, value] of Object.entries(call.after.native ?? {})) {
                if (typeof value === 'number') {
                    assert.ok(Number.isSafeInteger(value) && value >= 0)
                    assert.ok(value >= (call.before.native?.[key] ?? 0))
                }
            }
        }
        assert.deepEqual(fieldMetrics, fieldCalls.at(-1)?.after)
        const declines = fieldMetrics.native?.declines ?? {}
        const allowedDeclines = new Set(['eligibility', 'memory-bound', 'unsupported-compact'])
        const attemptDeclines = ['unsupported-compact', 'native-trap', 'native-return', 'native-header', 'output-copy']
        for (const [reason, count] of Object.entries(declines)) {
            assert.ok(Number.isSafeInteger(count) && count >= 0)
            assert.ok(count === 0 || allowedDeclines.has(reason),
                'Unexpected native failure/disable decline: ' + reason)
        }
        assert.equal(fieldMetrics.native?.nativeAttempts ?? 0,
            (fieldMetrics.native?.nativeCalls ?? 0) +
            attemptDeclines.reduce((sum, reason) => sum + (declines[reason] ?? 0), 0))
        const beforeReadinessCalls = fieldCalls.filter((call) => call.before.native === null).length
        assert.equal(fieldMetrics.javascriptCalls,
            beforeReadinessCalls + Object.values(declines).reduce((sum, count) => sum + count, 0))
        assert.ok((fieldMetrics.native?.nativeCalls ?? 0) > 0,
            'No native field call activated naturally; retain this attempt without replacement')
    } else {
        assert.equal(fieldMetrics, null)
        assert.ok(fieldCalls.every((call) => call.before === null && call.after === null))
    }
    assert.equal(fieldCalls.reduce((sum, call) => sum + call.rowCount, 0), fixture.termRows)
    const sample = await database.debugSampleTermContentIntegrity(fixture.expectedTitle, 12)
    assert.equal(sample.outOfBoundsRecordCount, 0)
    assert.ok(sample.sampledRecordCount > 0)
    const queries = [...new Set(sample.sampledRecords.map((row) => row.expression))]
    const lookup = await database.findTermsBulk(queries, new Set([fixture.expectedTitle]), 'exact')
    assert.ok(lookup.length > 0)
    const counts = await database.getDictionaryCounts([fixture.expectedTitle], true)
    const semantic = {
        title: imported.result.title, revision: imported.result.revision, counts,
        summaryCounts: imported.result.counts,
        sample: {sampledRecordCount: sample.sampledRecordCount,
            outOfBoundsRecordCount: sample.outOfBoundsRecordCount, sampledRecords: sample.sampledRecords},
        queries, lookupRows: lookup.length, lookupSha256: sha(json(lookup))
    }
    await save('semantic.json', semantic)
    await save('field-calls.json', fieldCalls)
    await save('product-work-counts.json', imported.debug?.phaseTimings.map((phase) => ({
        phase: phase.phase, details: withoutClocks(phase.details)
    })) ?? [])
    await save('final-store-counts.json', withoutClocks(finalizedMetrics))
    parser = await import(moduleUrl('ext/js/dictionary/term-bank-wasm-parser.js'))
    await parser.disposeParallelTermBankParser()
    await database.close()
    database = null
    await workers.close()
    assert.ok(workers.receipts.every((worker) => worker.failures.length === 0))
    const parserWorkers = workers.receipts.filter((worker) => worker.entry === 'term-bank-wasm-parser-worker.js')
    assert.equal(parserWorkers.length, 3)
    assert.ok(parserWorkers.every((worker) => worker.ready === 1))
    const groups = parserWorkers.flatMap((worker) => worker.parseRequests)
    const results = parserWorkers.flatMap((worker) => worker.parseResults)
    assert.equal(groups.length, {jmdict: 12, jitendex: 22, vndb: 170}[dictionary])
    assert.equal(results.length, groups.length)
    assert.equal(results.reduce((sum, result) => sum + result.rowCount, 0), fixture.termRows)
    const files = await inventoryFiles(adapter.context.root)
    assert.ok(files.some((file) => file.path.endsWith('.mbtr') && file.termPayload))
    assert.ok(files.some((file) => file.path.endsWith('.mbti') && file.termPayload))
    assert.ok(files.some((file) => file.path.startsWith('manabitan-term-content.bin') && file.termPayload))
    assert.deepEqual(await readdir(adapter.context.staging), [])
    const fixtureAfter = await fileDigest(archive)
    assert.deepEqual(fixtureAfter, fixtureBefore)
    const bindingAfter = await sourceBinding()
    assert.deepEqual(bindingAfter, bindingBefore)
    const optionalAssets = assets.filter((asset) => asset.path.endsWith('/term-record-fields.wasm'))
    assert.equal(optionalAssets.length, arm === 'B' ? 1 : 0)
    await save('files.json', files)
    await save('workers.json', workers.receipts)
    await save('assets.json', assets)
    await save('source-after.json', bindingAfter)
    await save('report.json', {
        schema: 1, passed: true, newReconstructedDriver: true, performanceMeasurements: false,
        arm, dictionary, source: bindingBefore, fixture: fixtureBefore,
        sqlite: adapterDiagnostics, flags, semantic,
        fieldCalls: fieldCalls.length, fieldRows: fieldCalls.reduce((sum, call) => sum + call.rowCount, 0),
        fieldMetrics, nativeCoverage: arm === 'B' ? {
            nativeCalls: fieldMetrics.native.nativeCalls, totalCalls: fieldMetrics.calls,
            nativeRows: fieldMetrics.native.nativeRows, totalRows: fixture.termRows
        } : null,
        parserGroups: groups.length, parserWorkers: parserWorkers.length,
        termFiles: files.filter((file) => file.termPayload),
        otherFiles: files.filter((file) => !file.termPayload),
        optionalAssets,
        limitations: [
            'Fresh Node processes with nonpersistent real SQLite and disk OPFS-shaped sidecars',
            'usesFallbackStorage=false explicitly selects generation-media support despite memory SQLite',
            'No browser storage, restart, image decoding, full-media or performance qualification',
            'Only documented 16-byte record/index generation identities are normalized',
            'Optional helper initialization occurs solely through the actual import lifecycle; no readiness wait',
            'The earlier killed local attempt and original component launcher failure are separate evidence'
        ]
    })
    completed = true
    console.log(JSON.stringify({passed: true, dictionary, arm, fieldCalls: fieldCalls.length,
        fieldRows: fixture.termRows, nativeCalls: fieldMetrics?.native?.nativeCalls ?? 0,
        parserGroups: groups.length, termFiles: files.filter((file) => file.termPayload).length,
        performanceMeasurements: false}))
} catch (cause) {
    failure = cause
    const partial = {passed: false, dictionary, arm, error: String(cause), stack: cause?.stack,
        fieldCalls, assets, workers: workers?.receipts ?? [], sourceBefore: bindingBefore,
        fixtureBefore, imported: imported ? {result: imported.result, errors: imported.errors.map(String),
            outcome: imported.outcome} : null, finalizedMetrics: withoutClocks(finalizedMetrics)}
    try { partial.files = adapter ? await inventoryFiles(adapter.context.root) : [] }
    catch (fileError) { partial.fileInventoryFailure = String(fileError) }
    try { partial.sourceAfter = await sourceBinding() }
    catch (sourceError) { partial.sourceCheckFailure = String(sourceError) }
    await save('failure.json', partial)
} finally {
    const cleanupErrors = []
    if (database !== null) {
        try { await database.close() } catch (cause) { cleanupErrors.push(String(cause)) }
    }
    if (workers !== null) {
        try { await workers.close() } catch (cause) { cleanupErrors.push(String(cause)) }
    }
    await save('cleanup.json', {completed, cleanupErrors})
    if (cleanupErrors.length > 0 && failure === null) failure = new Error('Post-receipt cleanup failed: ' + cleanupErrors.join('; '))
}
if (failure !== null) throw failure
