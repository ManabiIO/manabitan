// SPDX-License-Identifier: GPL-3.0-or-later
// Untimed/diagnostic full native term-storage replay. Media and SQLite are out of scope.
import assert from 'node:assert/strict';
import {openAsBlob} from 'node:fs';
import {readFile, writeFile, mkdir, statfs} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createNodeOpfs, assertNodeOpfsQuiescent} from './archived/raw-alias-node-opfs.mjs';
import {createWorkerAdapter} from './product-worker-adapter.mjs';
import {sha, asBytes, saveJson, hashFile, verifyBindings, describeInput, reference, planOffsets, keyAt, utf8, PROBE_GROUPS, MIXED_GROUPS, fileInventory, writeCanonicalMetadata} from './product-common.mjs';

const config = JSON.parse(await readFile(process.argv[2]));
assert(['A', 'B'].includes(config.arm));
assert.equal(config.mode, 'full-native-term-storage-diagnostic');
const manifest = JSON.parse(await readFile(config.fixtureManifest));
assert(manifest.complete && manifest.dictionary === 'vndb' && manifest.groups.length === 170);
assert.equal(config.node, process.version);
const root = config.root, output = config.outputDirectory, opfsPath = path.join(output, 'opfs');
await mkdir(output, {recursive: false});
const reportPath = path.join(output, 'pipeline.json');
const report = {schemaVersion: 1, complete: false, configuration: config, phases: [], groups: [], failures: [], cleanupFailures: [],
    scope: 'Untimed diagnostic: all170 pinned VNDB native parser groups using the real compressed source planner,3 actual native workers, actual importer materialization/private callback binding, real DB canonical dedup/publication/content persistence and record storage over a lazy Node file adapter. Includes media-reference discovery, no media payload writes, no SQLite setup/commit, no browser/full-import or comparative timing claim. Bulk journal/lifecycle entry state is initialized explicitly and identically for this storage component.',
};
const phase = async (name) => { report.phases.push({name, unixMs: Date.now()}); await saveJson(reportPath, report); };
await phase('created');
const load = (file) => import(pathToFileURL(path.join(root, file)));
let filesystem = null, db = null, pipeline = null, parser = null, owner = null, zip = null, current = null, sourceChunk = null;
let active = false, finalized = false, inRecordAppend = false;
const transport = createWorkerAdapter(opfsPath);

try {
    await verifyBindings(config);
    const space = await statfs(output); report.freeBytesBefore = Number(space.bavail) * Number(space.bsize);
    assert(report.freeBytesBefore > 550 * 1024 * 1024, 'Insufficient room for preserved full-arm output');
    assert.deepEqual(await hashFile(config.fixturePath), {bytes: manifest.fixture.sizeBytes, sha256: manifest.fixture.sha256});
    filesystem = await createNodeOpfs({rootPath: opfsPath});
    Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {hardwareConcurrency: 4, deviceMemory: 8, storage: {getDirectory: async () => filesystem.root}}});
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, options) => {
        const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
        if (url.protocol !== 'file:') { return originalFetch(input, options); }
        return new Response(await readFile(url), {headers: {'Content-Type': url.pathname.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream'}});
    };
    globalThis.Worker = transport.WorkerAdapter;
    const {DictionaryDatabase} = await load('ext/js/dictionary/dictionary-database.js');
    const {DictionaryImporter, isNativeImageProjectionSourceSizeEligible} = await load('ext/js/dictionary/dictionary-importer.js');
    const {DictionaryImporterMediaLoader} = await load('ext/js/dictionary/dictionary-importer-media-loader.js');
    const {RawZipPayloadReader, TermBankSourcePipeline} = await load('ext/js/dictionary/term-bank-source-pipeline.js');
    const {Uint8ArrayWriter} = await load('ext/lib/zip.js');
    const {MIN_EXACT_LOOKUP_SOURCE_BYTES} = await load('ext/js/dictionary/term-lookup-route.js');
    const raw = await load('ext/js/dictionary/raw-term-content.js');
    parser = await load('ext/js/dictionary/term-bank-wasm-parser.js');
    const codec = await load('ext/js/dictionary/zstd-term-content.js');
    await codec.initializeTermContentZstd();
    assert.equal(transport.workers.filter(({kind}) => kind === 'compression').length, 4);
    await Promise.all(transport.workers.filter(({kind}) => kind === 'compression').map(({ready}) => ready));
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
    importer._skipImageMetadata = true;
    importer._prepareExactLookupRoute = manifest.totalSourceBytes >= MIN_EXACT_LOOKUP_SOURCE_BYTES;
    const archive = await openAsBlob(config.fixturePath), rawReader = new RawZipPayloadReader(archive);
    const catalog = await importer._getFilesFromArchive(archive); zip = catalog.zipReader;
    assert.equal(catalog.catalog, 'dense-zip');
    const termFiles = [...catalog.fileMap.keys()].filter((name) => /^term_bank_\d+\.json$/.test(name))
        .sort((a, b) => Number(a.slice(10, -5)) - Number(b.slice(10, -5))).map((name) => catalog.fileMap.get(name));
    assert.equal(termFiles.reduce((sum, file) => sum + file.uncompressedSize, 0), manifest.totalSourceBytes);
    pipeline = new TermBankSourcePipeline({termFiles, enabled: true,
        read: (file, signal) => importer._getData(file, new Uint8ArrayWriter(), signal),
        readCompressed: (file, signal) => rawReader.read(file, signal, true),
    });
    const compressedPlan = pipeline.createCompressedImportRunPlan(0); assert(compressedPlan);
    assert.equal(compressedPlan.files.length, termFiles.length);
    const sourcePlan = {loaders: compressedPlan.loaders, estimatedByteLengths: compressedPlan.estimatedByteLengths, compressed: true};
    db = new DictionaryDatabase();
    db.setImportOptimizationFlags({termContentStorageMode: 'raw-bytes', queueTermContentWrites: true, rawTermBankSourceBytes: manifest.totalSourceBytes, termContentBlockTargetBytes: null});
    db.setTermEntryContentDedupEnabled(true);
    await db._termContentStore.prepare(); await db._termRecordStore.prepare();
    await db._termContentStore.beginImportSession(); await db._termRecordStore.beginImportSession();
    db._bulkImportState = 'active'; db._bulkImportTransactionOpen = true; db._deferTermsVirtualTableSync = true;
    db._bulkImportJournalRecord = {sessionId: 'native-alias-storage-diagnostic'};
    db._termContentZstdInitialized = true;
    db._termContentBlockImportSession = db._termContentBlockStore.beginImportSession();
    active = true;
    if (config.arm === 'B') {
        const {NativeTermRecordImportOwner} = await load('ext/js/dictionary/native-term-record-ownership.js');
        owner = new NativeTermRecordImportOwner(() => { assert(active, 'Storage diagnostic private callback no longer active'); });
    }
    report.policy = {workerCount: parser.getParallelTermBankParserWorkerCount(), sourceGroupsPerWorker: 3,
        blockTargetBytes: db._termContentBlockStore._blockTargetBytes, minimumBytes: db._termContentBlockStore._minInputBytes,
        minSavingsRatio: db._termContentBlockStore._minSavingsRatio, referencePackTargetBytes: db._termContentBlockStore._referencePackTargetBytes,
        nativeImageProjection: isNativeImageProjectionSourceSizeEligible(manifest.totalSourceBytes), prepareExactLookupRoute: importer._prepareExactLookupRoute,
        sourceBytes: manifest.totalSourceBytes, fixtureTermBanks: termFiles.length, sourceBatchMaxBytes: pipeline.batchMaxBytes,
        useMediaPipeline: true, contentStorageMode: 'raw-bytes', contentDedupEnabled: true,
        skipImageMetadata: importer._skipImageMetadata, wasmPassThroughTermContent: importer._wasmPassThroughTermContent,
        usePrecomputedContentForMediaRows: importer._usePrecomputedContentForMediaRows,
        canonicalRowsFastPath: importer._wasmCanonicalRowsFastPath,
        mediaReferenceDiscoveryIncluded: true, mediaRequirementResolutionIncluded: false, mediaPayloadWritesIncluded: false,
        sqliteIncluded: false, browserTermFileEqualityEstablished: false,
    };
    assert.equal(report.policy.workerCount, 3); assert.equal(report.policy.blockTargetBytes, 1048576);
    assert.equal(report.policy.minimumBytes, 524288); assert.equal(report.policy.minSavingsRatio, 0.1);
    const contentStore = db._termContentStore, store = db._termRecordStore;
    const persist = db._persistArtifactTermContent;
    db._persistArtifactTermContent = async function (...args) {
        const expected = manifest.groups[current.index], spans = args[4]; assert(spans);
        assert.equal(sha(spans.buffer), expected.sourceSha256);
        assert.equal(sha(asBytes(spans.offsets)), expected.offsetsSha256);
        assert.equal(sha(asBytes(spans.lengths)), expected.lengthsSha256);
        const start = contentStore._length;
        const result = await persist.apply(this, args);
        current.normalContentSpan = {start, end: contentStore._length, pendingEntries: spans.lengths.length,
            inputBytes: spans.lengths.reduce((sum, value) => sum + value, 0), sourceSha256: expected.sourceSha256,
            offsetsSha256: expected.offsetsSha256, lengthsSha256: expected.lengthsSha256};
        return result;
    };
    const recordAppend = db._appendResolvedArtifactTermRecords;
    db._appendResolvedArtifactTermRecords = async function (...args) {
        assert(!inRecordAppend); inRecordAppend = true;
        try { return await recordAppend.apply(this, args); } finally { inRecordAppend = false; }
    };
    const read = db._readTermEntryContentBytes;
    db._readTermEntryContentBytes = async function (...args) {
        const alias = inRecordAppend; const start = performance.now();
        const before = filesystem.operations.length;
        try { return await read.apply(this, args); }
        finally {
            if (alias) { current.canonicalAliasReads.push({offset: args[0], length: args[1], name: args[2],
                elapsedDiagnosticMs: performance.now() - start, mainThreadFileOperations: filesystem.operations.length - before}); }
        }
    };
    const overlay = contentStore._readSliceFromImportOverlay;
    contentStore._readSliceFromImportOverlay = function (...args) {
        const result = overlay.apply(this, args);
        if (inRecordAppend) { if (result !== null) { ++current.aliasOverlayHits; } else { ++current.aliasOverlayMisses; } }
        return result;
    };
    const ensure = contentStore.ensureLoadedForRead;
    contentStore.ensureLoadedForRead = async function (...args) {
        if (inRecordAppend) { ++current.aliasEnsureLoadedCalls; }
        return await ensure.apply(this, args);
    };
    const blockAppend = db._termContentBlockImportSession.append;
    db._termContentBlockImportSession.append = async function (...args) {
        const start = contentStore._length;
        const result = await blockAppend.apply(this, args);
        if (inRecordAppend) { current.aliasContentSpans.push({start, end: contentStore._length, entries: args[1].length,
            inputBytes: args[1].reduce((sum, bytes) => sum + bytes.length, 0), result: result === null ? null : {
                offsets: Array.from(result.contentOffsets), lengths: Array.from(result.contentLengths), name: result.contentDictName,
                compressedBytes: result.compressedBytes, uncompressedBytes: result.uncompressedBytes,
            }}); }
        return result;
    };
    const append = store.appendBatchFromArtifactChunkResolvedContent;
    store.appendBatchFromArtifactChunkResolvedContent = async function (chunk, offsets, lengths, names) {
        const plan = sourceChunk.contentDedupPlan, canonical = plan.resolvedOffsets;
        const counts = {}, aliasRows = [], aliases = new Map();
        for (let row = 0; row < chunk.rowCount; ++row) {
            const actual = reference(chunk, offsets, lengths, names, row), unique = sourceChunk.contentUniqueIndexList[row];
            const original = {offset: canonical[unique], length: plan.resolvedLengths[unique],
                name: plan.resolvedDictNames === null ? plan.resolvedUniformDictName : plan.resolvedDictNames[unique]};
            assert.equal(typeof original.name, 'string');
            counts[actual.name] = (counts[actual.name] ?? 0) + 1;
            if (actual.offset !== original.offset || actual.name !== original.name) {
                assert.equal(original.name, raw.RAW_TERM_CONTENT_TOKEN_DICT_NAME); assert.equal(actual.length, original.length);
                aliasRows.push(current.firstId + row); aliases.set(original.offset + ':' + original.length, {original, actual});
            }
        }
        current.recordEntry = {counts, uniformName: typeof names === 'string' ? names : null,
            preparedMapSameAsParser: chunk.preparedLookupIndexes === sourceChunk.preparedLookupIndexes,
            aliases: [...aliases.values()], aliasRows};
        return await append.call(this, chunk, offsets, lengths, names);
    };
    const encodeAppend = store._appendEncodedChunk;
    store._appendEncodedChunk = async function (state, firstId, count, name, base, payload, fields, format, ...rest) {
        current.recordRuns.push({file: state.fileName, firstId, rows: count, name, base, payloadBytes: payload.length,
            payloadSha256: sha(payload), fieldsBytes: fields?.length ?? null, fieldsFormat: format});
        return await encodeAppend.call(this, state, firstId, count, name, base, payload, fields, format, ...rest);
    };
    let rows = 0, requirements = 0, claimed = 0;
    const inputDigest = createHash('sha256');
    await phase('ready-for-full-native-pipeline');
    const cpuStart = process.cpuUsage(), started = process.hrtime.bigint();
    const result = await importer._readTermBankFileFast(
        termFiles[0], 3, manifest.fixture.expectedTitle, false, true, true, 'raw-bytes',
        async (chunk, mediaRequirements, progress) => {
            const index = report.groups.length, expected = manifest.groups[index]; assert(expected);
            assert(!Array.isArray(chunk)); assert.equal(chunk.rowCount, expected.rows);
            const received = transport.receivedByPreparedMap.get(chunk.preparedLookupIndexes); assert(received, 'Chunk did not traverse the actual native worker receiver');
            assert.equal(received.files[0], expected.firstBank); assert.equal(received.files.at(-1), expected.lastBank);
            assert.equal(received.ownsContentBytes, true); assert.equal(received.borrowsWorkerMemory, false);
            const input = describeInput(chunk, rows + 1, raw);
            current = {index, rows: chunk.rowCount, firstId: rows + 1, received, input,
                requirements: mediaRequirements?.length ?? 0, progress, canonicalAliasReads: [], aliasOverlayHits: 0, aliasOverlayMisses: 0,
                aliasEnsureLoadedCalls: 0, aliasContentSpans: [], recordRuns: [], probes: []};
            if (PROBE_GROUPS.has(index)) {
                const keyOffsets = planOffsets(chunk.termRecordPreinternedPlan);
                const selected = new Set([0, chunk.rowCount - 1]);
                const distinct = chunk.readingEqualsExpressionList.findIndex((value) => value !== 1 && value !== true); if (distinct >= 0) { selected.add(distinct); }
                for (const row of selected) {
                    const plan = chunk.termRecordPreinternedPlan;
                    current.probes.push({id: rows + row + 1, expression: utf8.decode(keyAt(plan, keyOffsets, plan.expressionIndexes[row])),
                        reading: chunk.readingEqualsExpressionList[row] ? null : utf8.decode(keyAt(plan, keyOffsets, plan.readingIndexes[row]))});
                }
            }
            report.groups.push(current); sourceChunk = chunk;
            const lease = owner?.claim(chunk) ?? null;
            if (config.arm === 'B') { assert(lease !== null, 'Genuine private receiver lease did not activate'); ++claimed; }
            if (lease === null) { await db.bulkAddArtifactTermsChunk(chunk); }
            else { await db.bulkAddArtifactTermsChunk(chunk, lease); }
            current.metrics = db._lastBulkAddTermsMetrics;
            for (const key of ['dedupNativeCallCount', 'dedupNativeScannedRows', 'dedupNativeFallbackCount', 'dedupUniqueCount', 'dedupPersistedHitCount']) {
                assert.equal(current.metrics[key], expected.dedupMetrics[key], 'Canonical route changed for ' + key);
            }
            assert.equal(current.recordRuns.reduce((sum, run) => sum + run.rows, 0), chunk.rowCount);
            rows += chunk.rowCount; requirements += current.requirements;
            inputDigest.update(current.input.logicalSha256 + '\n');
            current.memory = process.memoryUsage();
            await saveJson(reportPath, report);
            console.log(JSON.stringify({group: index, rows, aliasCount: current.metrics.contentAliasCount ?? 0,
                runs: current.recordRuns.length, privateLease: lease !== null, rss: current.memory.rss}));
            sourceChunk = null; current = null;
        }, sourcePlan, 262144, report.policy.nativeImageProjection, owner,
    );
    report.nativeProfile = importer._lastFastTermBankReadProfile;
    assert.equal(report.groups.length, 170); assert.equal(rows, manifest.fixture.termRows);
    assert.equal(store._nextId, rows + 1); assert.equal(result.termList.length, 0);
    assert.equal(transport.workers.filter(({kind}) => kind === 'parser').length, 3);
    active = false; owner?.close();
    await parser.disposeParallelTermBankParser(); await pipeline.dispose();
    const endings = await Promise.allSettled([contentStore.endImportSession(), store.endImportSession()]);
    const errors = endings.filter(({status}) => status === 'rejected').map(({reason}) => reason);
    if (errors.length) { throw new AggregateError(errors, 'Term stores failed finalization'); }
    finalized = true; db._termContentBlockImportSession.close();
    report.elapsedDiagnosticMs = Number(process.hrtime.bigint() - started) / 1e6;
    report.cpuDiagnosticMicroseconds = process.cpuUsage(cpuStart);
    report.endpointNote = 'Instrumented untimed diagnostic includes per-group source semantic hashing and synchronous receipt checkpoints; not a performance observation.';
    report.rows = rows; report.mediaRequirementsDiscovered = requirements; report.privateLeaseClaims = claimed;
    report.inputLogicalSha256 = inputDigest.digest('hex');
    report.contentFinalization = contentStore.getLastEndImportSessionMetrics();
    report.recordFinalization = store.getLastEndImportSessionMetrics();
    report.canonicalMetadata = await writeCanonicalMetadata(db, path.join(output, 'canonical-metadata.bin'));
    report.recentCache = {bytes: db._recentTermContentSourceBatchBytes, batches: db._recentTermContentSourceBatches.size};
    await transport.terminateAll(); transport.assertHealthy();
    report.workerTransports = transport.receipts();
    report.quiescence = await assertNodeOpfsQuiescent(filesystem);
    report.mainThreadFileOperations = filesystem.operations;
    report.mainThreadIoScope = 'Parent only. The real worker index-writer I/O is not counted in this diagnostic operation array.';
    report.fileInventory = await fileInventory(opfsPath);
    const promoted = report.groups.filter(({recordEntry}) => recordEntry.aliases.length > 0);
    assert.deepEqual(promoted.map(({index}) => index), config.arm === 'B' ? MIXED_GROUPS : []);
    assert.equal(promoted.reduce((sum, group) => sum + group.recordEntry.aliasRows.length, 0), config.arm === 'B' ? 175 : 0);
    assert.equal(promoted.reduce((sum, group) => sum + group.metrics.contentAliasInputBytes, 0), config.arm === 'B' ? 2983 : 0);
    report.maximumRssKiB = process.resourceUsage().maxRSS;
    await verifyBindings(config);
    report.complete = true;
    await phase('pipeline-complete-separate-verification-required');
} catch (error) {
    report.complete = false; report.failures.push({name: error?.name ?? null, message: String(error), stack: error?.stack ?? null});
    await saveJson(reportPath, report); throw error;
} finally {
    active = false; owner?.close();
    const cleanups = await Promise.allSettled([parser?.disposeParallelTermBankParser(), pipeline?.dispose(), zip?.close()]);
    if (!finalized && db) { cleanups.push(...await Promise.allSettled([db._termContentStore.endImportSession(), db._termRecordStore.endImportSession()])); }
    db?._termContentBlockImportSession?.close();
    try { await transport.terminateAll(); transport.assertHealthy(); } catch (error) { report.cleanupFailures.push(String(error)); }
    for (const item of cleanups) { if (item.status === 'rejected') { report.cleanupFailures.push(String(item.reason)); } }
    if (filesystem) { try { await filesystem.dispose({remove: false}); } catch (error) { report.cleanupFailures.push(String(error)); } }
    report.workerTransports = transport.receipts();
    if (report.cleanupFailures.length || transport.workers.some(({failures}) => failures.length)) { report.complete = false; }
    await saveJson(reportPath, report);
}
assert(report.complete);
console.log(JSON.stringify({complete: true, arm: config.arm, rows: report.rows, groups: report.groups.length,
    claimed: report.privateLeaseClaims, inputLogicalSha256: report.inputLogicalSha256, files: report.fileInventory,
    canonicalMetadata: report.canonicalMetadata, maximumRssKiB: report.maximumRssKiB}));
