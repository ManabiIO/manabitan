/* SPDX-License-Identifier: GPL-3.0-or-later */
// Component replay, not a browser whole-import benchmark. Production parser,
// canonical dedup, compression workers, record encoders and stores are unchanged.
// Only Worker/fetch/OPFS boundaries are adapted. SQL setup/publication is absent.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream, openAsBlob} from 'node:fs';
import {readFile, readdir, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join, relative, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Worker as ThreadWorker} from 'node:worker_threads';
import {execFileSync} from 'node:child_process';
import {installFileFetch} from './node-sink-file-fetch.mjs';
import {createNodeOpfs} from './node-sink-opfs.mjs';

const [sourcePath, cachePath, outputPath, dictionary = 'jmdict', fileLimitText = '0', verifyText = '1'] = process.argv.slice(2);
assert(sourcePath && cachePath && outputPath, 'Usage: node node-sink-replay.mjs SOURCE CACHE OUTPUT [jmdict] [FILE_LIMIT=0] [SOURCE_DIGEST=1]');
const root = resolve(sourcePath);
const fileLimit = Number(fileLimitText);
const verify = verifyText !== '0';
const cpus = 4;
const memory = 8;
const importSource = (file) => import(pathToFileURL(join(root, file)));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const require = createRequire(join(root, 'package.json'));
const {BlobReader, Uint8ArrayWriter, ZipReader} = require('@zip.js/zip.js');
installFileFetch();
const fs = await createNodeOpfs();
Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {hardwareConcurrency: cpus, deviceMemory: memory, storage: {getDirectory: async () => fs.root}}});
const workers = [];
const sourceGroups = [];
let startTime = null;
class BrowserWorker extends EventTarget {
    constructor(url) {
        super();
        this.url = String(url);
        this.isCompression = this.url.endsWith('/zstd-term-content-compression-worker.js');
        this.worker = new ThreadWorker(new URL('./node-sink-worker.mjs', import.meta.url), {workerData: {url: this.url, cpus, memory}});
        let readyResolve;
        let readyReject;
        this.ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
        void this.ready.catch(() => {});
        this.worker.on('message', (data) => {
            if (data.type === 'ready') { readyResolve(); }
            if (data.type === 'initialization-error') { readyReject(new Error(data.error)); }
            this.dispatchEvent(new MessageEvent('message', {data}));
        });
        this.worker.on('error', (error) => {
            readyReject(error);
            const event = new Event('error');
            Object.defineProperty(event, 'message', {value: error.message});
            this.dispatchEvent(event);
        });
        this.worker.on('messageerror', () => this.dispatchEvent(new MessageEvent('messageerror')));
        workers.push(this);
    }
    postMessage(data, transfer) {
        if (data.type === 'parse') {
            sourceGroups.push({id: data.id, atMs: startTime === null ? null : performance.now() - startTime, files: data.sourceMetadata?.map(({filename}) => filename) ?? null, bytes: data.sourceBuffers?.map((buffer) => buffer.byteLength) ?? null});
        }
        this.worker.postMessage(data, transfer);
    }
    terminate() { this.termination ??= this.worker.terminate(); return this.termination; }
}
globalThis.Worker = BrowserWorker;

const lockBytes = await readFile(join(root, 'test/perf/dictionaries.lock.json'));
const fixture = JSON.parse(lockBytes).dictionaries[dictionary];
assert(fixture);
const archivePath = join(cachePath, fixture.cacheFile);
const archiveHash = createHash('sha256');
for await (const bytes of createReadStream(archivePath)) { archiveHash.update(bytes); }
assert.equal(archiveHash.digest('hex'), fixture.sha256);
const archive = await openAsBlob(archivePath);
assert.equal(archive.size, fixture.sizeBytes);
const parser = await importSource('ext/js/dictionary/term-bank-wasm-parser.js');
const pipelineModule = await importSource('ext/js/dictionary/term-bank-source-pipeline.js');
const {DictionaryDatabase} = await importSource('ext/js/dictionary/dictionary-database.js');
const zstd = await importSource('ext/js/dictionary/zstd-term-content.js');
const {RAW_TERM_CONTENT_TOKEN_DICT_NAME} = await importSource('ext/js/dictionary/raw-term-content.js');
const {isNativeImageProjectionSourceSizeEligible} = await importSource('ext/js/dictionary/dictionary-importer.js');
const {MIN_EXACT_LOOKUP_SOURCE_BYTES} = await importSource('ext/js/dictionary/term-lookup-route.js');
const wasm = await readFile(join(root, 'ext/lib/term-bank-parser.wasm'));
parser.setTermBankWasmModule(await WebAssembly.compile(wasm));
await zstd.initializeTermContentZstd();
await Promise.all(workers.filter((worker) => worker.isCompression).map((worker) => worker.ready));
await parser.prewarmParallelTermBankParser();
const reader = new ZipReader(new BlobReader(archive));
const entries = await reader.getEntries();
const allTermFiles = entries.filter(({filename}) => /^term_bank_\d+\.json$/.test(filename)).sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)));
const termFiles = fileLimit > 0 ? allTermFiles.slice(0, fileLimit) : allTermFiles;
const rawTermBankSourceBytes = termFiles.reduce((sum, file) => sum + file.uncompressedSize, 0);
const rawReader = new pipelineModule.RawZipPayloadReader(archive);
const sourcePipeline = new pipelineModule.TermBankSourcePipeline({
    termFiles,
    enabled: true,
    read: async (file) => await file.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true}),
    readCompressed: async (file, signal) => await rawReader.read(file, signal),
});
const database = new DictionaryDatabase();
// Random identity is an external boundary. Generate the production ID, then
// replace only those random bytes with a reproducible per-shard identity so
// whole files (including their generation checksums) can be compared exactly.
const realGeneration = database._termRecordStore._createShardGenerationId.bind(database._termRecordStore);
let generationSerial = 0;
database._termRecordStore._createShardGenerationId = () => {
    const value = realGeneration();
    value.set(createHash('sha256').update(`node-sink-replay-shard-${generationSerial++}`).digest().subarray(0, value.length));
    return value;
};
database.setImportOptimizationFlags({termContentStorageMode: 'raw-bytes', queueTermContentWrites: true, rawTermBankSourceBytes, termContentBlockTargetBytes: null});
await database._termContentStore.prepare();
await database._termRecordStore.prepare();
await database._termContentStore.beginImportSession();
await database._termRecordStore.beginImportSession();
database._bulkImportTransactionOpen = true;
database._deferTermsVirtualTableSync = true;
database._termContentZstdInitialized = true;
database._termContentBlockImportSession = database._termContentBlockStore.beginImportSession();
const blockTargetBytes = database._termContentBlockStore._blockTargetBytes;
const groups = [];
const profiles = [];
let activeGroup = null;
let rowCount = 0;
const sourceDigest = createHash('sha256');
// Pure observation of the exact production planner; no planner output is used
// by the import. Kept verbatim from planContentSpansIntoSlabs for a census.
function plannedLengths(lengths, targetBytes) {
    const blocks = [];
    let startIndex = 0;
    while (startIndex < lengths.length) {
        let totalBytes = 0;
        let endIndex = startIndex;
        while (endIndex < lengths.length) {
            const nextBytes = lengths[endIndex];
            if (totalBytes > 0 && totalBytes + nextBytes > targetBytes && nextBytes > 0) { break; }
            totalBytes += nextBytes;
            ++endIndex;
        }
        blocks.push(totalBytes);
        startIndex = endIndex;
    }
    return blocks;
}
const realResolve = database._resolveArtifactTermContentDedup.bind(database);
database._resolveArtifactTermContentDedup = async (...args) => {
    const result = await realResolve(...args);
    const spans = result.pendingContentSpans;
    if (activeGroup !== null) {
        activeGroup.pendingContentCount = result.pendingContentCount;
        activeGroup.persistedHitCount = result.persistedHitCount;
        activeGroup.recentSourceHitCount = result.recentSourceHitCount;
        activeGroup.pendingSpans = spans === null ? null : {
            count: spans.lengths.length,
            bytes: spans.lengths.reduce((sum, length) => sum + length, 0),
            blockLengths: plannedLengths(spans.lengths, blockTargetBytes),
            hypothetical4MiBBlockLengths: plannedLengths(spans.lengths, 4 * 1024 * 1024),
            shared: spans.buffer.buffer instanceof SharedArrayBuffer,
            sourceViewBytes: spans.buffer.byteLength,
            sourceBackingBytes: spans.buffer.buffer.byteLength,
        };
    }
    return result;
};
const realBegin = database._termContentBlockStore._beginAppendSharedSpans.bind(database._termContentBlockStore);
database._termContentBlockStore._beginAppendSharedSpans = (...args) => {
    const group = activeGroup;
    const at = performance.now();
    const operation = realBegin(...args);
    if (group !== null) {
        group.reservationStartedMs = at - startTime;
        group.initialSelection = args[5];
        void operation.storage.then(() => { group.reservationReadyMs = performance.now() - startTime; }, () => {});
        void operation.sourceConsumed.then(() => { group.compressionSourceConsumedMs = performance.now() - startTime; }, () => {});
        void operation.completion.then(() => { group.persistenceCompletedMs = performance.now() - startTime; }, () => {});
    }
    return operation;
};
function hashChunk(chunk) {
    for (const key of ['rowCount', 'contentBytesBaseOffset', 'contentBytesLength', 'contentMetaByUniqueIndex']) { sourceDigest.update(`${key}:${chunk[key]}\n`); }
    for (const key of ['contentBytesBuffer', 'contentMetaList', 'contentUniqueIndexList', 'scoreList', 'sequenceList', 'readingEqualsExpressionList']) {
        const value = chunk[key];
        sourceDigest.update(`${key}:${value?.byteLength}\n`);
        if (ArrayBuffer.isView(value)) { sourceDigest.update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)); }
    }
    // Preinterned record plans and actual persisted bytes verify term fields.
}
async function consume(chunk, progress) {
    const group = {index: groups.length, rows: chunk.rowCount, rowStart: rowCount, arrivedMs: performance.now() - startTime, contentBytes: chunk.contentBytesLength, shared: chunk.contentBytesBuffer?.buffer instanceof SharedArrayBuffer, borrowed: typeof chunk.releaseBorrowedContent === 'function', parserUnique: chunk.contentDedupPlan?.uniqueCount, parserSourceRows: chunk.contentDedupPlan?.sourceRowCount};
    activeGroup = group;
    if (verify) { hashChunk(chunk); }
    const before = performance.now();
    await database._bulkAddArtifactTermsChunkWithContentDedup({...chunk, dictionary: fixture.expectedTitle, dictionaryTotalRows: progress.totalRows, contentDictNameList: null, uniformContentDictName: RAW_TERM_CONTENT_TOKEN_DICT_NAME});
    group.sinkMs = performance.now() - before;
    group.returnedMs = performance.now() - startTime;
    group.metrics = {...database._lastBulkAddTermsMetrics};
    group.pendingCompletionAfterReturn = database._deferredArtifactContentPersistence !== null && database._deferredArtifactContentPersistence !== undefined;
    rowCount += chunk.rowCount;
    groups.push(group);
    activeGroup = null;
}
const media = fixture.mediaFiles > 0;
const options = {emitTermByteLists: false, computeContentHashes: true, emitContentSlab: true, emitTokenBinaryContent: true, mediaHintFastScan: media, projectImagePaths: media && isNativeImageProjectionSourceSizeEligible(rawTermBankSourceBytes), validateGlossaryTypes: true, prepareLookupIndexes: true, prepareLookupRoute: rawTermBankSourceBytes >= MIN_EXACT_LOOKUP_SOURCE_BYTES, maxPendingChunks: 2};
let complete = false;
let failure = null;
let timings = null;
let finalDeferredMetrics = null;
let files = [];
try {
    const cpuBefore = process.cpuUsage();
    startTime = performance.now();
    for (let start = 0; start < termFiles.length;) {
        const plan = sourcePipeline.createCompressedImportRunPlan(start);
        if (plan !== null) {
            assert.equal(await parser.parseTermBankWithWasmColumnChunksParallelCompressedLazy(plan.loaders, plan.estimatedByteLengths, 3, consume, options), true);
            profiles.push(parser.consumeLastTermBankWasmParseProfile());
            sourcePipeline.releaseBatch(plan.files);
            start += plan.files.length;
        } else {
            const batchFiles = sourcePipeline.getBatch(start);
            const batch = await sourcePipeline.readBatch(batchFiles);
            if (batch?.promises) {
                const used = await parser.parseTermBankWithWasmColumnChunksParallelDeferred(batch.promises, batch.estimatedByteLengths, 3, consume, options);
                if (!used) { await parser.parseTermBankWithWasmColumnChunks(await Promise.all(batch.promises), 3, consume, 2048, {...options, singleChunk: true}); }
            } else {
                await parser.parseTermBankWithWasmColumnChunks(batch, 3, consume, 2048, {...options, singleChunk: true});
            }
            profiles.push(parser.consumeLastTermBankWasmParseProfile());
            sourcePipeline.releaseBatch(batchFiles);
            start += batchFiles.length;
        }
    }
    const parserSinkDoneMs = performance.now() - startTime;
    if (typeof database._drainDeferredArtifactContentPersistence === 'function') { finalDeferredMetrics = await database._drainDeferredArtifactContentPersistence(); }
    const contentDrainDoneMs = performance.now() - startTime;
    await Promise.all([database._termContentStore.endImportSession(), database._termRecordStore.endImportSession()]);
    const elapsedMs = performance.now() - startTime;
    const cpu = process.cpuUsage(cpuBefore);
    timings = {elapsedMs, parserSinkDoneMs, contentDrainDoneMs, cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000, cpuTotalMs: (cpu.user + cpu.system) / 1000, peakRssKiB: process.resourceUsage().maxRSS};
    if (!fileLimit) { assert.equal(rowCount, fixture.termRows); }
    complete = true;
} catch (error) {
    failure = error.stack ?? String(error);
    process.stderr.write(`${failure}\n`);
    process.exitCode = 1;
} finally {
    await sourcePipeline.dispose();
    await parser.disposeParallelTermBankParser();
    await Promise.all(workers.map((worker) => worker.terminate()));
    await reader.close();
    if (complete) {
        async function collect(path) {
            for (const entry of await readdir(path, {withFileTypes: true})) {
                const filename = join(path, entry.name);
                if (entry.isDirectory()) { await collect(filename); }
                else { const data = await readFile(filename); files.push({name: relative(fs.rootPath, filename), bytes: data.byteLength, sha256: sha(data)}); }
            }
        }
        await collect(fs.rootPath);
        files.sort((a, b) => a.name.localeCompare(b.name));
    }
    const sourceFiles = {};
    for (const name of ['ext/js/dictionary/dictionary-database.js', 'ext/js/dictionary/term-bank-wasm-parser.js', 'ext/js/dictionary/term-content-block-store.js', 'ext/js/dictionary/zstd-term-content.js', 'ext/js/dictionary/term-record-opfs-store.js', 'ext/lib/zstd.wasm', 'ext/lib/term-content-canonical-scan-v1.wasm']) { sourceFiles[name] = sha(await readFile(join(root, name))); }
    const report = {
        complete, failure, scope: 'Node component: actual compressed source pipeline → native parser workers → native global dedup → actual Zstd workers → actual record encoder/store; async filesystem OPFS boundary and deterministic random generation identities. Excludes SQLite journal/publication, UI, media, browser OPFS SAH, browser restart. Never a full browser import speed claim.',
        node: process.version, root, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(), dirty: execFileSync('git', ['status', '--porcelain'], {cwd: root, encoding: 'utf8'}).trim(), cpus, memory, fixture, fileLimit, fileCount: termFiles.length, rawTermBankSourceBytes, blockTargetBytes, rows: rowCount, timings, parserOptions: options, sourceHashingInsideTimer: verify, sourceDigestSha256: verify ? sourceDigest.digest('hex') : null, sourceFiles, parserWasmSha256: sha(wasm), lockSha256: sha(lockBytes), files, totalPersistedBytes: files.reduce((sum, file) => sum + file.bytes, 0), filesDigestSha256: sha(JSON.stringify(files)), finalDeferredMetrics, contentEndMetrics: database._termContentStore._lastEndImportSessionMetrics, recordEndMetrics: database._termRecordStore._lastEndImportSessionMetrics, groups, sourceGroups, profiles, storageOperations: fs.operations,
    };
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, {flag: 'wx'});
    process.stdout.write(`${JSON.stringify({complete, rows: rowCount, timings, groups: groups.length, totalPersistedBytes: report.totalPersistedBytes, filesDigestSha256: report.filesDigestSha256, outputPath})}\n`);
    await fs.dispose();
}
