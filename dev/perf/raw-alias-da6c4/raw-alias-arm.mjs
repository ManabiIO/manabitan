// SPDX-License-Identifier: GPL-3.0-or-later
// One fresh A/B/C process. No result is a browser or whole-import measurement.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile, mkdir, copyFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Worker as NodeWorker} from 'node:worker_threads';
import {loadRawAliasCapture, verifyCaptureFiles, SEED, MIXED_GROUPS} from './raw-alias-capture.mjs';
import {promoteRawReferencesForComponent, ALIAS_LIMITS} from './raw-alias-promotion.mjs';
import {inputWitness, verifyAliasObservation} from './raw-alias-verify.mjs';
import {createNodeOpfs, describeFileHandle, assertNodeOpfsQuiescent} from './raw-alias-node-opfs.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const config = JSON.parse(await readFile(process.argv[2]));
const {arm, block, ordinal, outputDirectory, root, captureDirectory} = config;
assert(['A', 'B', 'C'].includes(arm));
assert.equal(process.version, 'v22.22.0');
assert.equal(config.baselineCommit, '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2');
assert.deepEqual(config.aliasLimits, ALIAS_LIMITS);
await mkdir(outputDirectory, {recursive: false});
const reportPath = path.join(outputDirectory, 'observation.json');
const report = {
    schemaVersion: 1, complete: false, arm, block, ordinal, node: process.version,
    scope: 'Immutable10-group record/content storage component at the completed baseline content tail, with a Node file adapter. Not original import-time alias offsets, a browser timing, or production ownership qualification.',
    baselineCommit: config.baselineCommit, protocolSha256: config.protocolSha256,
    researchBinding: config.researchBinding, protocolBlob: config.protocolBlob,
    sourceHashes: config.sourceHashes, harnessHashes: config.harnessHashes,
    aliasLimits: ALIAS_LIMITS, phases: [], groupDiagnostics: [], failures: [], cleanupFailures: [],
};
const save = async () => { await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n'); };
const phase = async (name) => { report.phases.push({name, unixMs: Date.now()}); await save(); };
async function verifyIdentities() {
    for (const [file, digest] of Object.entries(config.sourceHashes)) {
        if (digest === null) { continue; }
        assert.equal(sha(await readFile(path.join(root, file))), digest, 'Runtime source identity changed: ' + file);
    }
    for (const [filename, digest] of Object.entries(config.harnessHashes)) {
        assert.equal(sha(await readFile(new URL('./' + filename, import.meta.url))), digest, 'Harness identity changed: ' + filename);
    }
    assert.equal(sha(await readFile(config.protocolPath)), config.protocolSha256);
}
await phase('created');
const workers = [];
let filesystem = null, contentStore = null, store = null, blockSession = null;
let finalized = false;
class WorkerAdapter {
    constructor(entry) {
        this.entry = String(entry);
        assert(/\/(?:zstd-term-content-compression-worker|term-record-import-index-worker)\.js$/.test(new URL(entry).pathname));
        this.kind = new URL(entry).pathname.endsWith('/term-record-import-index-worker.js') ? 'index' : 'compression';
        this.listeners = new Map();
        this.messages = 0; this.transferBytes = 0; this.readySeen = false; this.termination = null;
        this.terminationRequested = false; this.failures = [];
        this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
        void this.ready.catch(() => {});
        this.worker = new NodeWorker(new URL('./raw-alias-worker-bridge.mjs', import.meta.url), {
            workerData: {entry: this.entry, rootPath: path.join(outputDirectory, 'opfs')}, execArgv: [],
        });
        workers.push(this);
        this.worker.on('message', (data) => {
            if (data?.type === 'ready') { this.readySeen = true; this.resolveReady(); }
            if (data?.type === 'initialization-error') { this.rejectReady(new Error(String(data.error))); }
            for (const listener of this.listeners.get('message') ?? []) { listener({data}); }
        });
        this.worker.on('error', (error) => {
            this.failures.push({event: 'error', message: String(error)});
            this.rejectReady(error);
            for (const listener of this.listeners.get('error') ?? []) { listener({error, message: error.message}); }
        });
        this.worker.on('messageerror', (error) => {
            this.failures.push({event: 'messageerror', message: String(error)});
            for (const listener of this.listeners.get('messageerror') ?? []) { listener({error}); }
        });
        this.worker.on('exit', (code) => {
            if (!this.terminationRequested) {
                const error = new Error('Worker exited unexpectedly: ' + code);
                this.failures.push({event: 'exit', code, message: String(error)});
                this.rejectReady(error);
                for (const listener of this.listeners.get('error') ?? []) { listener({error, message: error.message}); }
            } else if (!this.readySeen) { this.rejectReady(new Error('Worker terminated before readiness: ' + code)); }
        });
    }
    addEventListener(type, listener) {
        if (!this.listeners.has(type)) { this.listeners.set(type, new Set()); }
        this.listeners.get(type).add(listener);
    }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    postMessage(message, transfer = []) {
        let data = message;
        if (this.kind === 'index' && data.action === 'open') {
            data = {...data, fileHandle: describeFileHandle(data.fileHandle)};
        }
        ++this.messages;
        for (const item of transfer) { if (item instanceof ArrayBuffer) { this.transferBytes += item.byteLength; } }
        this.worker.postMessage(data, transfer);
    }
    terminate() { this.terminationRequested = true; this.termination ??= this.worker.terminate(); return this.termination; }
}

try {
    await verifyIdentities();
    const opfsDirectory = path.join(outputDirectory, 'opfs');
    filesystem = await createNodeOpfs({rootPath: opfsDirectory});
    await copyFile(path.join(captureDirectory, SEED.file), path.join(opfsDirectory, SEED.file));
    assert.equal(sha(await readFile(path.join(opfsDirectory, SEED.file))), SEED.sha256);
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true, value: {hardwareConcurrency: 4, deviceMemory: 8, storage: {getDirectory: async () => filesystem.root}},
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, options) => {
        const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
        if (url.protocol !== 'file:') { return originalFetch(input, options); }
        return new Response(await readFile(url), {
            headers: {'Content-Type': url.pathname.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream'},
        });
    };
    globalThis.Worker = WorkerAdapter;
    const load = (file) => import(pathToFileURL(path.join(root, file)));
    const {manifest, manifestSha256, groups} = await loadRawAliasCapture({directory: captureDirectory, root});
    assert.equal(manifestSha256, config.captureManifestSha256);
    await verifyCaptureFiles(captureDirectory, manifest);
    const beforeWitness = inputWitness(groups);
    report.inputWitnessBefore = beforeWitness;
    report.captureManifestSha256 = manifestSha256;
    const {DictionaryDatabase} = await load('ext/js/dictionary/dictionary-database.js');
    const {createArtifactTermRecordChunkWithResolvedContent} = await load('ext/js/dictionary/term-record-opfs-store.js');
    const {hasCompletePreparedTermLookupIndexes} = await load('ext/js/dictionary/term-lookup-index-preparation.js');
    const raw = await load('ext/js/dictionary/raw-term-content.js');
    const codec = await load('ext/js/dictionary/zstd-term-content.js');
    await codec.initializeTermContentZstd();
    const compressors = workers.filter(({kind}) => kind === 'compression');
    assert.equal(compressors.length, 4);
    await Promise.all(compressors.map(({ready}) => ready));
    const db = new DictionaryDatabase();
    db.setImportOptimizationFlags({
        termContentStorageMode: 'raw-bytes', queueTermContentWrites: true,
        rawTermBankSourceBytes: manifest.rawTermBankSourceBytes, termContentBlockTargetBytes: null,
    });
    contentStore = db._termContentStore;
    store = db._termRecordStore;
    const blockStore = db._termContentBlockStore;
    assert.equal(blockStore._blockTargetBytes, 1048576);
    assert.equal(blockStore._minInputBytes, 524288);
    assert.equal(blockStore._minSavingsRatio, 0.1);
    assert.equal(blockStore._referencePackTargetBytes, 4194304);
    await contentStore.prepare(); await store.prepare();
    await contentStore.beginImportSession(); await store.beginImportSession();
    blockSession = blockStore.beginImportSession();
    // The exact completed seed and original route show this dictionary selected
    // block storage in group1. Restore that component entry-state latch only.
    assert(groups.find(({index}) => index === 1).expectedRoute.persistence.blockSelectedAfter);
    for (const group of groups.filter(({index}) => MIXED_GROUPS.includes(index))) {
        assert(group.expectedRoute.persistence.blockSelectedAfter);
    }
    blockSession._blockEnabledDictionaries.add(groups[0].chunk.dictionary);
    assert.equal(contentStore._readPageCache.size, 0);
    const canonicalState = {
        hashPairs: db._termEntryContentMetaHashPairCount,
        recentSources: db._recentTermContentSourceBatches.size,
        recentSourceBytes: db._recentTermContentSourceBatchBytes,
        recentSourceIdTableLength: db._termEntryContentMetaRecentSourceBatchIdTable.length,
        recentSourceOffsetTableLength: db._termEntryContentMetaRecentSourceOffsetTable.length,
    };
    report.entryState = {
        seedBytes: SEED.bytes, contentTail: contentStore._length,
        blockTargetBytes: blockStore._blockTargetBytes,
        referencePackTargetBytes: blockStore._referencePackTargetBytes,
        minimumBytes: blockStore._minInputBytes, minSavingsRatio: blockStore._minSavingsRatio,
        rawTermBankSourceBytes: manifest.rawTermBankSourceBytes,
        expectedTermContentImportBytes: contentStore._expectedImportBytes ?? null,
        expectedTermRecordImportBytes: store._expectedImportBytes ?? null,
        compressionWorkersReady: compressors.length,
        parserAndCanonicalReplayIncluded: false,
        recordIds: groups.map(({index, firstId, chunk}) => ({group: index, firstId, rows: chunk.rowCount})),
        canonicalState,
        canonicalDatabaseStateSeeded: false,
        canonicalScope: 'Canonical resolved columns are immutable captured inputs; constructor-only DB metadata/cache remain empty and unchanged. Full import metadata publication/rollback is outside this component.',
    };
    assert.equal(contentStore._length, SEED.bytes);
    const context = {
        blockStore, blockSession, hasCompletePreparedTermLookupIndexes,
        getRawTermContentBlockCompressionDictName: raw.getRawTermContentBlockCompressionDictName,
        createRawTermContentCompactBlockDictName: raw.createRawTermContentCompactBlockDictName,
        createArtifactTermRecordChunkWithResolvedContent, rawTokenName: raw.RAW_TERM_CONTENT_TOKEN_DICT_NAME,
    };
    globalThis.gc?.();
    await phase('ready-to-time');
    const operationsStart = filesystem.operations.length;
    report.memoryBeforeTiming = process.memoryUsage();
    const outputs = new Map();
    const groupDiagnostics = [];
    const cpuBefore = process.cpuUsage();
    const started = process.hrtime.bigint();
    for (const group of groups) {
        const groupStarted = process.hrtime.bigint();
        // Restore source IDs/gaps equally. No fake records or padding are added.
        store._nextId = group.firstId;
        const output = arm === 'B' ?
            await promoteRawReferencesForComponent(group, context) :
            {chunk: group.chunk, contentOffsets: group.contentOffsets, contentLengths: group.contentLengths, contentDictNames: group.contentDictNames, promoted: false, rawRows: 0, aliases: []};
        const metrics = await store.appendBatchFromArtifactChunkResolvedContent(
            output.chunk, output.contentOffsets, output.contentLengths, output.contentDictNames,
        );
        outputs.set(group.index, output);
        groupDiagnostics.push({
            group: group.index, elapsedNs: String(process.hrtime.bigint() - groupStarted),
            promoted: output.promoted, rawRows: output.rawRows, aliases: output.aliases,
            blockProfile: output.blockProfile ?? null, recordMetrics: metrics,
        });
    }
    const finalizationStarted = process.hrtime.bigint();
    const endings = await Promise.allSettled([contentStore.endImportSession(), store.endImportSession()]);
    const ended = process.hrtime.bigint();
    const cpuDelta = process.cpuUsage(cpuBefore);
    const failures = endings.filter(({status}) => status === 'rejected').map(({reason}) => reason);
    if (failures.length) { throw new AggregateError(failures, 'Component stores failed to finalize'); }
    finalized = true;
    report.elapsedNs = String(ended - started);
    report.elapsedMs = Number(ended - started) / 1e6;
    report.processCpuDeltaMicroseconds = cpuDelta;
    report.cpuScope = 'Process user/system CPU across owner and Node worker threads around the endpoint; diagnostic only, not an additive decomposition or browser CPU measurement.';
    report.finalizationNs = String(ended - finalizationStarted);
    report.groupDiagnostics = groupDiagnostics;
    report.memoryAfterTiming = process.memoryUsage();
    report.maximumRssKiBAfterTiming = process.resourceUsage().maxRSS;
    report.mainThreadFileOperations = filesystem.operations.slice(operationsStart);
    report.contentFinalization = contentStore.getLastEndImportSessionMetrics();
    report.recordFinalization = store.getLastEndImportSessionMetrics();
    assert.equal(report.recordFinalization.lookupIndexWorkerFileCount, 2, 'Actual VNDB index-worker route did not activate');
    assert.deepEqual({
        hashPairs: db._termEntryContentMetaHashPairCount,
        recentSources: db._recentTermContentSourceBatches.size,
        recentSourceBytes: db._recentTermContentSourceBatchBytes,
        recentSourceIdTableLength: db._termEntryContentMetaRecentSourceBatchIdTable.length,
        recentSourceOffsetTableLength: db._termEntryContentMetaRecentSourceOffsetTable.length,
    }, canonicalState, 'Component altered canonical database state');
    blockSession.close();
    // I/O is durably joined above. Terminate all compressor/index transports
    // before exhaustive untimed decode, preserving receipts on any failure.
    await Promise.all(workers.map((worker) => worker.terminate()));
    assert.equal(filesystem.openResourceCount, 0, 'Parent file handle remains open after durable drain');
    report.postFinalizationQuiescence = await assertNodeOpfsQuiescent(filesystem);
    report.workerTransports = workers.map(({kind, readySeen, messages, transferBytes, failures}) => ({kind, readySeen, messages, transferBytes, failures}));
    assert(workers.every(({failures}) => failures.length === 0), 'A worker failed or exited unexpectedly');
    assert.equal(workers.filter(({kind}) => kind === 'index').length, 1);
    assert(workers.filter(({kind}) => kind === 'compression').every(({messages}) => messages === 0));
    await phase('timing-complete-verification-pending');
    assert.equal(inputWitness(groups), beforeWitness, 'In-memory source graph changed during append');
    await verifyIdentities();
    await verifyCaptureFiles(captureDirectory, manifest);
    report.verification = await verifyAliasObservation({
        rootPath: opfsDirectory, groups, outputs, arm, store, contentStore, blockStore, load,
    });
    report.inputWitnessAfter = inputWitness(groups);
    assert.equal(report.inputWitnessAfter, beforeWitness, 'In-memory source graph changed during verification');
    await verifyIdentities();
    await verifyCaptureFiles(captureDirectory, manifest);
    report.maximumRssKiBIncludingVerification = process.resourceUsage().maxRSS;
    report.complete = true;
    await phase('complete');
} catch (error) {
    report.failures.push({name: error?.name ?? null, message: String(error), stack: error?.stack ?? null});
    await save();
    throw error;
} finally {
    if (!finalized) {
        const cleanup = await Promise.allSettled([contentStore?.endImportSession(), store?.endImportSession()]);
        for (const item of cleanup) {
            if (item.status === 'rejected') { report.cleanupFailures.push(String(item.reason)); }
        }
    }
    blockSession?.close();
    await Promise.allSettled(workers.map((worker) => worker.terminate()));
    if (filesystem) {
        try { await filesystem.dispose({remove: false}); }
        catch (error) { report.cleanupFailures.push(String(error)); }
    }
    report.workerFailures = workers.flatMap(({kind, failures}) => failures.map((failure) => ({kind, ...failure})));
    if (report.cleanupFailures.length || report.workerFailures.length) { report.complete = false; }
    await save();
}
if (!report.complete) { throw new Error('Component ended without a complete source/semantic proof'); }
console.log(JSON.stringify({arm, block, ordinal, elapsedMs: report.elapsedMs, complete: report.complete, logicalSha256: report.verification.logicalSha256, normalizedPhysicalSha256: report.verification.normalizedPhysicalSha256}));
