// Route-only diagnostic: exact pinned native groups + actual DB dedup/content
// codec policy + record-store dispatch/compaction. Final record encoding and
// append are intercepted. No elapsed-time or persisted-record parity claim.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile, writeFile, mkdir, rename, readdir, stat} from 'node:fs/promises';
import {Worker as NodeWorker} from 'node:worker_threads';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {loadProductionGroups} from './production-group-loader.mjs';
import {createRawAliasCapture} from './raw-alias-capture.mjs';

const {values} = parseArgs({options: {
    groups: {type: 'string', default: '170'},
    out: {type: 'string', default: '/workspace/scratch/da6c4dbd0097/profiling/vndb-record-route-three-groups.json'},
}});
const root = process.env.MANABITAN_ALIAS_BASELINE;
assert(root && path.isAbsolute(root));
const manifestPath = process.env.MANABITAN_ALIAS_SOURCE_MANIFEST;
assert(manifestPath && path.isAbsolute(manifestPath));
const fixtureDirectory = process.env.MANABITAN_ALIAS_FIXTURES;
assert(fixtureDirectory && path.isAbsolute(fixtureDirectory));
const temporaryDirectory = process.env.MANABITAN_ALIAS_TEMP;
assert(temporaryDirectory && path.isAbsolute(temporaryDirectory));
const load = (file) => import(pathToFileURL(path.join(root, file)));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const bytesOf = (view) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
const manifestBytes = await readFile(manifestPath);
const manifest = JSON.parse(manifestBytes);
assert(manifest.complete && manifest.dictionary === 'vndb');
assert(process.env.MANABITAN_ALIAS_CAPTURE && process.env.MANABITAN_ALIAS_ORIGINAL_ROUTE);
const capture = await createRawAliasCapture({directory: process.env.MANABITAN_ALIAS_CAPTURE, manifest, sourceManifestSha256: sha(manifestBytes), oraclePath: process.env.MANABITAN_ALIAS_ORIGINAL_ROUTE});
const groupLimit = Number(values.groups);
assert(Number.isInteger(groupLimit) && groupLimit > 0 && groupLimit <= manifest.groups.length);
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(), manifest.gitSha);
const identityFiles = [...new Set([...Object.keys(manifest.sourceHashes),
    'ext/js/dictionary/term-record-opfs-store.js', 'ext/js/dictionary/term-content-opfs-store.js',
    'ext/js/dictionary/term-record-preinterned-plan.js', 'ext/js/dictionary/term-lookup-index.js',
    'ext/js/dictionary/term-lookup-index-preparation.js', 'ext/js/dictionary/term-content-ownership.js',
    'ext/js/dictionary/term-content-reference-origin.js', 'ext/js/dictionary/term-lookup-route.js',
])];
const sourceHashes = {};
for (const file of identityFiles) {
    try { sourceHashes[file] = sha(await readFile(path.join(root, file))); }
    catch (error) { if (error.code !== 'ENOENT') { throw error; } sourceHashes[file] = null; }
    if (file in manifest.sourceHashes) { assert.equal(sourceHashes[file], manifest.sourceHashes[file]); }
}
const fixtureHash = createHash('sha256');
let fixtureBytes = 0;
for await (const bytes of createReadStream(path.join(fixtureDirectory, manifest.fixture.cacheFile))) { fixtureHash.update(bytes); fixtureBytes += bytes.length; }
assert.equal(fixtureBytes, manifest.fixture.sizeBytes);
assert.equal(fixtureHash.digest('hex'), manifest.fixture.sha256);

const report = {
    schemaVersion: 1, complete: false, node: process.version, source: manifest.gitSha,
    scope: 'Routing diagnostic only: exact checksum-fixed native parser groups, native global canonical dedup, actual content compression policy/codec and content store over a Node file-backed OPFS shim, actual record-store content-name/run splitting and preinterned-plan compaction. Final record encoder and final record append are intercepted after routing. Serial producer replay, no media writes, SQLite setup/commit, browser transport, persisted record output, or performance claim.',
    manifestPath, manifestSha256: sha(manifestBytes), fixture: manifest.fixture, sourceHashes,
    harnessSha256: sha(await readFile(new URL(import.meta.url))),
    loaderSha256: sha(await readFile(new URL('./production-group-loader.mjs', import.meta.url))),
    groupLimit, groups: [], failures: [],
};
await writeFile(values.out, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
const save = async () => { const tmp = values.out + '.checkpoint.tmp'; await writeFile(tmp, JSON.stringify(report, null, 2) + '\n'); await rename(tmp, values.out); };

await mkdir(temporaryDirectory, {recursive: true});
const adapterOriginal = await readFile(path.join(root, 'test/fixtures/fused-score/node-opfs-adapter.mjs'), 'utf8');
const adapterSource = adapterOriginal.replace("path.join(os.tmpdir(), 'manabitan-opfs-')", `path.join(${JSON.stringify(temporaryDirectory)}, 'manabitan-opfs-')`);
assert.notEqual(adapterOriginal, adapterSource);
report.opfsShim = {originalSha256: sha(adapterOriginal), adaptedSha256: sha(adapterSource), onlyAdaptation: 'Temporary output-directory literal; file semantics unchanged.'};
const {createNodeOpfs} = await import('data:text/javascript;base64,' + Buffer.from(adapterSource).toString('base64'));
const filesystem = await createNodeOpfs();
report.opfsDirectory = filesystem.rootPath;
Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {hardwareConcurrency: 4, deviceMemory: 8, storage: {getDirectory: async () => filesystem.root}}});
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
    if (url.protocol !== 'file:') { return originalFetch(input, options); }
    return new Response(await readFile(url), {headers: {'Content-Type': url.pathname.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream'}});
};
const workers = [];
class WorkerAdapter {
    constructor(entry) {
        assert(new URL(entry).pathname.endsWith('/zstd-term-content-compression-worker.js'));
        this.listeners = new Map();
        this.worker = new NodeWorker(new URL('./compression-worker-node-bridge.mjs', import.meta.url), {workerData: {entry: String(entry)}, execArgv: []});
        workers.push(this);
        this.worker.on('message', (data) => { for (const listener of this.listeners.get('message') ?? []) { listener({data}); } });
        this.worker.on('error', (error) => { for (const listener of this.listeners.get('error') ?? []) { listener({error, message: error.message}); } });
    }
    addEventListener(type, listener) { if (!this.listeners.has(type)) { this.listeners.set(type, new Set()); } this.listeners.get(type).add(listener); }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    postMessage(data, transfer) { this.worker.postMessage(data, transfer); }
    terminate() { return this.worker.terminate(); }
}
globalThis.Worker = WorkerAdapter;
const {DictionaryDatabase} = await load('ext/js/dictionary/dictionary-database.js');
const {NativeCanonicalScanner} = await load('ext/js/dictionary/term-content-canonical-scan.js');
const {registerOwnedTermContent} = await load('ext/js/dictionary/term-content-ownership.js');
const {hasCompletePreparedTermLookupIndexes} = await load('ext/js/dictionary/term-lookup-index-preparation.js');
const {hasCompleteTermRecordPreinternedPlan} = await load('ext/js/dictionary/term-record-preinterned-plan.js');
const codec = await load('ext/js/dictionary/zstd-term-content.js');
await codec.initializeTermContentZstd();
const db = new DictionaryDatabase();
db.setImportOptimizationFlags({termContentStorageMode: 'raw-bytes', queueTermContentWrites: true, rawTermBankSourceBytes: manifest.totalSourceBytes, termContentBlockTargetBytes: null});
db.setTermEntryContentDedupEnabled(true);
const canonicalModule = await WebAssembly.compile(await readFile(path.join(root, 'ext/lib/term-content-canonical-scan-v1.wasm')));
db._nativeCanonicalScanner = new NativeCanonicalScanner({loadModule: async () => canonicalModule});
await db._termContentStore.prepare();
await db._termRecordStore.prepare();
await db._termContentStore.beginImportSession();
await db._termRecordStore.beginImportSession();
db._bulkImportState = 'active';
db._bulkImportTransactionOpen = true;
db._deferTermsVirtualTableSync = true;
db._termContentZstdInitialized = true;
db._termContentBlockImportSession = db._termContentBlockStore.beginImportSession();
report.contentPolicy = {targetBytes: db._termContentBlockStore._blockTargetBytes, minimumBytes: db._termContentBlockStore._minInputBytes};
assert.equal(report.contentPolicy.targetBytes, 1048576);
assert.equal(report.contentPolicy.minimumBytes, 524288);
const store = db._termRecordStore;
const empty = new Uint8Array(0);
let current = null;
let inputChunk = null;
let activeDispatch = null;
let lastEncoded = null;
let planOffsets = new WeakMap();
const routeWitness = createHash('sha256');

function planShape(plan) {
    return plan === null || typeof plan === 'undefined' ? null : {
        keys: plan.stringLengths.length, stringBytes: plan.stringsBuffer.byteLength,
        expressionRows: plan.expressionIndexes.length, readingRows: plan.readingIndexes.length,
        hasOffsets: plan.stringOffsets instanceof Uint32Array, hasHashes: plan.stringHashes instanceof Uint32Array,
        expressionIdType: plan.expressionIndexes.constructor.name,
    };
}
function offsetsFor(plan) {
    let offsets = planOffsets.get(plan);
    if (offsets) { return offsets; }
    offsets = plan.stringOffsets;
    if (!(offsets instanceof Uint32Array)) {
        offsets = new Uint32Array(plan.stringLengths.length);
        let cursor = 0;
        for (let i = 0; i < offsets.length; ++i) { offsets[i] = cursor; cursor += plan.stringLengths[i]; }
        assert.equal(cursor, plan.stringsBuffer.byteLength);
    }
    planOffsets.set(plan, offsets);
    return offsets;
}
function verifyRunPlan(plan, start, count, equals) {
    assert(hasCompleteTermRecordPreinternedPlan(plan, count));
    const original = inputChunk.termRecordPreinternedPlan;
    const sourceOffsets = offsetsFor(original), targetOffsets = offsetsFor(plan);
    const seen = new Map();
    let comparedKeys = 0;
    const verifyKey = (a, b) => {
        const prior = seen.get(a);
        if (typeof prior !== 'undefined') { assert.equal(prior, b); return; }
        assert.equal(original.stringLengths[a], plan.stringLengths[b]);
        const length = original.stringLengths[a];
        assert.deepEqual(original.stringsBuffer.subarray(sourceOffsets[a], sourceOffsets[a] + length), plan.stringsBuffer.subarray(targetOffsets[b], targetOffsets[b] + length));
        seen.set(a, b); ++comparedKeys;
    };
    for (let i = 0; i < count; ++i) {
        verifyKey(original.expressionIndexes[start + i], plan.expressionIndexes[i]);
        if (!equals[i]) { verifyKey(original.readingIndexes[start + i], plan.readingIndexes[i]); }
    }
    return comparedKeys;
}

const persistOriginal = db._persistArtifactTermContent;
db._persistArtifactTermContent = async function (...args) {
    const spans = args[4];
    assert(spans);
    const expected = manifest.groups[current.index];
    assert.equal(sha(spans.buffer), expected.sourceSha256);
    assert.equal(sha(bytesOf(spans.offsets)), expected.offsetsSha256);
    assert.equal(sha(bytesOf(spans.lengths)), expected.lengthsSha256);
    const wasSelected = this._termContentBlockImportSession._blockEnabledDictionaries.has(args[0]);
    const result = await persistOriginal.apply(this, args);
    current.persistence = {
        pendingRows: spans.lengths.length, pendingBytes: spans.lengths.reduce((a, b) => a + b, 0),
        sourceHash: expected.sourceSha256, offsetsHash: expected.offsetsSha256, lengthsHash: expected.lengthsSha256,
        blockSelectedBefore: wasSelected,
        blockSelectedAfter: this._termContentBlockImportSession._blockEnabledDictionaries.has(args[0]),
        resultNames: typeof result.pendingResolvedDictNames === 'string' ? result.pendingResolvedDictNames : [...new Set(result.pendingResolvedDictNames)],
        blockStorage: result.blockProfile !== null,
        minimumStoredOffset: Math.min(...result.pendingOffsets), maximumStoredOffset: Math.max(...result.pendingOffsets),
    };
    return result;
};

const appendOriginal = store.appendBatchFromArtifactChunkResolvedContent;
store.appendBatchFromArtifactChunkResolvedContent = async function (chunk, offsets, lengths, names) {
    const counts = {};
    const runs = [];
    for (let i = 0; i < chunk.rowCount; ++i) {
        const name = typeof names === 'string' ? names : names[i] ?? 'raw';
        counts[name] = (counts[name] ?? 0) + 1;
        if (i === 0 || runs.at(-1).name !== name) { runs.push({start: i, rows: 1, name}); } else { ++runs.at(-1).rows; }
    }
    current.recordEntry = {
        rows: chunk.rowCount, namesAreUniformString: typeof names === 'string', counts, nameRuns: runs,
        preparedMapSameAsParser: chunk.preparedLookupIndexes === inputChunk.preparedLookupIndexes,
        preparedKeys: [...(chunk.preparedLookupIndexes?.keys() ?? [])],
        preparedComplete: hasCompletePreparedTermLookupIndexes(chunk.preparedLookupIndexes, chunk.rowCount),
        planSameAsParser: chunk.termRecordPreinternedPlan === inputChunk.termRecordPreinternedPlan,
        plan: planShape(chunk.termRecordPreinternedPlan),
    };
    await capture.entry({group: current, chunk, contentOffsets: offsets, contentLengths: lengths, contentDictNames: names});
    return appendOriginal.call(this, chunk, offsets, lengths, names);
};
const dispatchOriginal = store._encodeAndAppendArtifactChunkForState;
store._encodeAndAppendArtifactChunkForState = async function (state, chunk, firstId, offsets, lengths, plan = null, name = 'raw', prepared = null) {
    const origin = inputChunk.termRecordPreinternedPlan;
    const start = firstId - current.firstId;
    assert(plan);
    assert.equal(plan.stringsBuffer, origin.stringsBuffer);
    assert.equal(plan.stringLengths, origin.stringLengths);
    assert.equal(plan.expressionIndexes.buffer, origin.expressionIndexes.buffer);
    assert.equal(plan.expressionIndexes.byteOffset, origin.expressionIndexes.byteOffset + start * origin.expressionIndexes.BYTES_PER_ELEMENT);
    const dispatch = {
        start, rows: chunk.rowCount, name, fileName: state.fileName,
        preparedKeys: [...(prepared?.keys() ?? [])], preparedMapPresent: prepared instanceof Map,
        preparedMapSameAsParser: prepared === inputChunk.preparedLookupIndexes,
        inputPlan: planShape(plan), fullSourceArenaRetained: true,
        inputPlanSameAsParser: plan === origin,
        finalRuns: [], nextRow: 0,
    };
    current.dispatches.push(dispatch);
    assert.equal(activeDispatch, null); activeDispatch = dispatch;
    try { return await dispatchOriginal.call(this, state, chunk, firstId, offsets, lengths, plan, name, prepared); }
    finally { assert.equal(dispatch.nextRow, dispatch.rows); delete dispatch.nextRow; activeDispatch = null; }
};
store._encodeArtifactChunkRecords = async function (chunk, _offsets, _lengths, plan = null, preparedBytes = null, validatedBase = null) {
    assert(activeDispatch && plan);
    const start = activeDispatch.start + activeDispatch.nextRow;
    const selectedPrepared = [...inputChunk.preparedLookupIndexes].find(([, value]) => value.bytes === preparedBytes);
    if (preparedBytes !== null) { assert(selectedPrepared, 'Unknown prepared byte buffer'); assert.equal(plan, selectedPrepared[1].preinternedPlan); }
    const checkedKeys = verifyRunPlan(plan, start, chunk.rowCount, chunk.readingEqualsExpressionList);
    const item = {
        start, rows: chunk.rowCount, preparedBytesPresent: preparedBytes !== null,
        parserPreparedRange: selectedPrepared?.[0] ?? null,
        preparedBytes: preparedBytes?.byteLength ?? 0,
        sourcePlanKeys: activeDispatch.inputPlan.keys, sourcePlanStringBytes: activeDispatch.inputPlan.stringBytes,
        sourcePlanHasOffsets: activeDispatch.inputPlan.hasOffsets, sourcePlanHasHashes: activeDispatch.inputPlan.hasHashes,
        finalPlan: planShape(plan), rowKeyReferencesVerified: chunk.rowCount, distinctSourceKeysCompared: checkedKeys,
        validatedContentOffsetBase: validatedBase,
    };
    activeDispatch.finalRuns.push(item);
    activeDispatch.nextRow += chunk.rowCount;
    lastEncoded = item;
    return {contentOffsetBase: validatedBase ?? 0, lookupIndexBytes: preparedBytes ?? empty, recordFields: empty, recordFieldsFormat: 0, validationMs: 0, recordFieldEncodeMs: 0, lookupIndexEncodeMs: 0};
};
store._appendEncodedChunk = async function (state, firstId, rows, name, base, bytes) {
    assert(lastEncoded && activeDispatch);
    assert.equal(rows, lastEncoded.rows); assert.equal(firstId, current.firstId + lastEncoded.start);
    assert.equal(name, activeDispatch.name); assert.equal(base, lastEncoded.validatedContentOffsetBase);
    assert.equal(bytes.byteLength, lastEncoded.preparedBytes);
    routeWitness.update(JSON.stringify({group: current.index, firstId, rows, name, base, preparedRange: lastEncoded.parserPreparedRange}));
    if (bytes.byteLength) { routeWitness.update(bytes); }
    lastEncoded = null;
};

let totalRows = 0;
try {
    for await (const {group, profile, chunk} of loadProductionGroups({root, manifestPath, cache: fixtureDirectory})) {
        if (group.index >= groupLimit) { break; }
        inputChunk = chunk; planOffsets = new WeakMap();
        assert(registerOwnedTermContent(chunk.contentBytesBuffer));
        current = {
            index: group.index, firstId: totalRows + 1, rows: chunk.rowCount,
            firstBank: group.firstBank, lastBank: group.lastBank,
            parserPlan: planShape(chunk.termRecordPreinternedPlan),
            parserPrepared: [...chunk.preparedLookupIndexes].map(([key, value]) => ({key, bytes: value.bytes.byteLength, sha256: sha(value.bytes), plan: planShape(value.preinternedPlan)})),
            parserCounts: Object.fromEntries(Object.entries(profile).filter(([key, value]) => typeof value === 'number' && !key.endsWith('Ms'))),
            dispatches: [],
        };
        report.groups.push(current);
        await db._bulkAddArtifactTermsChunkWithContentDedup(chunk);
        const metrics = db._lastBulkAddTermsMetrics;
        for (const key of ['dedupNativeCallCount', 'dedupNativeScannedRows', 'dedupNativeFallbackCount', 'dedupUniqueCount', 'dedupPersistedHitCount']) { assert.equal(metrics[key], group.dedupMetrics[key]); }
        assert.equal(current.dispatches.reduce((sum, item) => sum + item.rows, 0), chunk.rowCount);
        assert.equal(current.dispatches.flatMap((item) => item.finalRuns).reduce((sum, item) => sum + item.rows, 0), chunk.rowCount);
        current.dedupCounts = Object.fromEntries(Object.entries(metrics).filter(([key]) => !key.endsWith('Ms')));
        await capture.route(current);
        current.memorySample = process.memoryUsage();
        totalRows += chunk.rowCount;
        await save();
        console.log(JSON.stringify({group: current.index, rows: totalRows, pendingNames: current.persistence.resultNames, recordNames: current.recordEntry.counts, dispatches: current.dispatches.length, fallbackRows: current.dispatches.flatMap((item) => item.finalRuns).filter((item) => !item.preparedBytesPresent).reduce((sum, item) => sum + item.rows, 0), rss: current.memorySample.rss}));
        inputChunk = null; current = null; planOffsets = new WeakMap(); globalThis.gc?.();
        if (group.index + 1 >= groupLimit) { break; }
    }
    assert.equal(report.groups.length, groupLimit);
    assert.equal(store._nextId, totalRows + 1);
    await db._termContentStore.endImportSession();
    db._termContentBlockImportSession.close();
    report.rows = totalRows;
    report.metadataUniqueCount = db._termEntryContentMetaHashPairCount;
    report.shardFiles = [...store._shardStateByFileName.keys()];
    report.routeWitnessSha256 = routeWitness.digest('hex');
    report.contentFiles = [];
    for (const name of await readdir(filesystem.rootPath)) {
        const filename = path.join(filesystem.rootPath, name);
        if ((await stat(filename)).isFile()) { const bytes = await readFile(filename); report.contentFiles.push({name, bytes: bytes.byteLength, sha256: sha(bytes)}); }
    }
    for (const file of identityFiles) { if (sourceHashes[file] !== null) { assert.equal(sha(await readFile(path.join(root, file))), sourceHashes[file]); } }
    report.complete = true;
    report.aliasCapture = await capture.finish(report, filesystem.rootPath);
    await save();
    console.log(JSON.stringify({complete: true, groups: groupLimit, rows: totalRows, metadataUniqueCount: report.metadataUniqueCount, shardFiles: report.shardFiles, contentFiles: report.contentFiles}));
} catch (error) {
    report.complete = false;
    report.failures.push({message: String(error), stack: error.stack});
    await capture.failure(error);
    await save();
    throw error;
} finally {
    const terminations = await Promise.allSettled(workers.map((worker) => worker.terminate()));
    const cleanupErrors = terminations.filter(({status}) => status === 'rejected').map(({reason}) => reason);
    if (cleanupErrors.length) {
        report.complete = false;
        for (const error of cleanupErrors) { report.failures.push({phase: 'worker-termination', message: String(error), stack: error?.stack}); }
        const error = new AggregateError(cleanupErrors, 'Capture worker termination failed');
        await capture.failure(error);
        await save();
        throw error;
    }
}
