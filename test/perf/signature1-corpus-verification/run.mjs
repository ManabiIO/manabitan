// Full current-parent/candidate term-sink parity and implicit metadata allocation census.
// This derivative preserves v5 production grouping/worker/store boundaries. No timing claim.
// Media files/requirements do not mutate columnPayload on the default direct
// artifact route; this runner omits their separate persistence and UI work.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {openAsBlob} from 'node:fs';
import {mkdir, readFile, readdir, stat, statfs, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Worker as NodeWorker} from 'node:worker_threads';
import {analyzeFields, decodeFields, sha256, summarize} from './field-analysis.mjs';
import {catalogSourceFiles, openSourceCatalog, sourceManifest} from './archive-catalog.mjs';
import {createBoundedNodeOpfs} from './node-opfs-bounded.mjs';
import {digestStoredFiles} from './file-oracle.mjs';
import {
    helperRoot, parseRunArguments, fileHashes, fileIdentity, resources, sourceReceipt,
    loadVerificationManifest, readPinnedOracle, evidenceReceipt, assertHistoricalOracleIdentity,
} from './common.mjs';
import {allocationReceipt, metadataDigest, parserOutputDigest} from './metadata-oracle.mjs';

const configuration = parseRunArguments();
if (configuration === null) { process.exit(0); }
const {corpus, arm, sourceRoot, sourceCommit, output, cacheRoot, evidenceRoot, expectedNodeSha256} = configuration;
await mkdir(output); // Never replace a previous failed or successful acquisition.
// Source tree/file receipts are checked before importing from this CLI-selected checkout.
// eslint-disable-next-line no-unsanitized/method
const sourceModule = (file) => import(pathToFileURL(path.join(sourceRoot, file)).href);
const save = (name, data) => writeFile(path.join(output, name), `${JSON.stringify(data, null, 2)}\n`);
const helpers = ['run.mjs',
    'field-analysis.mjs',
    'common.mjs',
    'metadata-oracle.mjs',
    'metadata-oracle.contract.mjs',
    'logical-record-ids.mjs',
    'logical-record-ids.contract.mjs',
    'archive-catalog.mjs',
    'node-opfs-bounded.mjs',
    'node-opfs-bounded.contract.mjs',
    'file-oracle.mjs',
    'vndb-media-oracle.py',
    'compare-results.mjs',
    'launch.py'];
const extraSources = [
    'ext/js/dictionary/term-record-import-index-worker.js',
    'ext/js/dictionary/term-record-import-index-worker-client.js',
    'ext/js/dictionary/term-record-import-index-writer.js',
    'ext/js/dictionary/term-lookup-index-preparation.js',
    'ext/js/dictionary/term-lookup-route.js',
    'ext/js/dictionary/term-lookup-index.js',
    'ext/js/dictionary/term-record-preinterned-plan.js',
    'ext/js/pages/settings/dictionary-import-controller.js',
    'package-lock.json',
    ...catalogSourceFiles,
];
const budget = {minimumTempBytes: 512 * 1024 * 1024,
    minimumReportBytes: 16 * 1024 * 1024,
    maximumRssBytes: 3 * 1024 * 1024 * 1024,
    maximumWallMs: 20 * 60 * 1000};
const startedAt = Date.now();
const chunks = [];
const groupResults = [];
const sourceChecks = [];
const workers = [];
const pools = new Set();
let source;
let sourceFamily;
let verification;
let recordIdRepresentation = 'physical-float64';
let evidenceIdentity;
let runtimeIdentity;
let expectedOutputOracle;
let helperIdentity;
let fixture;
let lockSha256;
let env;
let zip;
let database;
let currentGroup = -1;
let stage = 'source preflight';
let totalBytes = 0;
let rows = 0;
let mediaRows = 0;
let fatalWorkerError = null;
let compressionRequests = 0;
let compressionReplies = 0;
let sourceConsumedReplies = 0;
let plannedBlocks = 0;
let indexUnsupportedReplies = 0;
let peakRss = 0;
let initialResources;
let expectedJmdict;
let expectedVndbMedia;
let vndbMediaOracleReceipt;
let expectedVndbMediaFiles;
const projectedMediaPathDigest = createHash('sha256');
const projectedMediaUniquePaths = new Set();
let projectedMediaPathCount = 0;
let policy;
const codecEntry = pathToFileURL(path.join(sourceRoot, 'ext/js/dictionary/zstd-term-content-compression-worker.js')).href;
const indexEntry = pathToFileURL(path.join(sourceRoot, 'ext/js/dictionary/term-record-import-index-worker.js')).href;

function constant(sourceText, name) {
    const match = sourceText.match(new RegExp(`^(?:export )?const ${name} = ([0-9_* ]+);$`, 'm'));
    assert(match, `Missing frozen numeric source constant ${name}`);
    const parts = match[1].split('*').map((value) => Number(value.trim().replaceAll('_', '')));
    assert(parts.every((value) => Number.isSafeInteger(value) && value > 0));
    return parts.reduce((a, b) => a * b, 1);
}

function partitionBanks(banks, byteCount, requestedCount) {
    // Exact partitionSourceBanks algorithm, bounded by the source receipt.
    const groupCount = Math.min(requestedCount, banks.length);
    const groups = [];
    let start = 0;
    let consumed = 0;
    for (let groupIndex = 0; groupIndex < groupCount - 1; ++groupIndex) {
        const remaining = groupCount - groupIndex;
        const target = (byteCount - consumed) / remaining;
        let end = start + 1;
        let bytes = banks[start].uncompressedSize;
        const maxEnd = banks.length - (remaining - 1);
        while (end < maxEnd) {
            const next = bytes + banks[end].uncompressedSize;
            if (Math.abs(next - target) > Math.abs(bytes - target)) { break; }
            bytes = next;
            ++end;
        }
        groups.push(banks.slice(start, end));
        start = end;
        consumed += bytes;
    }
    groups.push(banks.slice(start));
    return groups;
}

async function resourceBoundary() {
    const memory = process.memoryUsage();
    peakRss = Math.max(peakRss, memory.rss);
    assert(memory.rss < budget.maximumRssBytes, 'Census RSS budget exceeded');
    assert(Date.now() - startedAt < budget.maximumWallMs, 'Census wall deadline exceeded');
    for (const [location, minimum] of [[os.tmpdir(), budget.minimumTempBytes], [output, budget.minimumReportBytes]]) {
        const info = await statfs(location);
        assert(info.bavail * info.bsize >= minimum, `Census free-space floor: ${location}`);
    }
    return memory;
}

function codecBoundary() {
    assert.equal(fatalWorkerError, null);
    assert([...pools].every((pool) => pool._pending.size === 0), 'Codec request still pending');
    assert.equal(compressionRequests, plannedBlocks);
    assert.equal(compressionReplies, compressionRequests);
    assert.equal(sourceConsumedReplies, compressionRequests);
    assert.equal(database._inFlightTermContentSourceBatches.size, 0, 'Retained in-flight source');
}

const bridge = `
    import {parentPort, workerData} from 'node:worker_threads';
    import {readFile} from 'node:fs/promises';
    globalThis.self = {
        addEventListener(type, listener) {
            if (type !== 'message') throw Error('Unexpected worker listener');
            parentPort.on('message', data => listener({data}));
        },
        postMessage(message, transfer = []) { parentPort.postMessage(message, transfer); },
    };
    globalThis.fetch = async input => {
        const url = new URL(String(input));
        if (url.protocol !== 'file:') throw Error('Worker boundary cannot fetch network resources');
        return new Response(await readFile(url), {headers: {'Content-Type': 'application/wasm'}});
    };
    await import(workerData.entry);
`;

class ActualWorker extends EventTarget {
    constructor(entry) {
        super();
        assert([codecEntry, indexEntry].includes(String(entry)), `Unexpected worker: ${String(entry)}`);
        this.kind = String(entry) === codecEntry ? 'codec' : 'index';
        this.terminated = false;
        this.ready = new Promise((resolve, reject) => {
            this.resolveReady = resolve;
            this.rejectReady = reject;
        });
        void this.ready.catch(() => {});
        this.thread = new NodeWorker(new URL(`data:text/javascript,${encodeURIComponent(bridge)}`), {workerData: {entry: String(entry)}});
        workers.push(this);
        this.thread.on('message', (data) => {
            if (data.type === 'ready') { this.resolveReady(); }
            if (data.type === 'initialization-error') { this.rejectReady(new Error(String(data.error))); }
            if (this.kind === 'codec') {
                if (data.type === 'source-consumed') { ++sourceConsumedReplies; }
                if (data.compressed instanceof ArrayBuffer) { ++compressionReplies; }
            } else if (data.result === 'unsupported') { ++indexUnsupportedReplies; }
            this.dispatchEvent(new MessageEvent('message', {data}));
        });
        const fail = (error) => {
            fatalWorkerError ??= error;
            this.rejectReady(error);
            const event = new Event('error');
            Object.defineProperty(event, 'message', {value: String(error.message)});
            this.dispatchEvent(event);
        };
        this.thread.on('error', fail);
        this.thread.on('messageerror', () => {
            fatalWorkerError ??= new Error('Worker message deserialization failed');
            this.dispatchEvent(new MessageEvent('messageerror'));
        });
        this.thread.on('exit', (code) => {
            if (!this.terminated) { fail(new Error(`Unexpected ${this.kind} worker exit ${code}`)); }
        });
    }

    postMessage(data, transfer = []) {
        if (this.kind === 'codec') {
            assert(data.source instanceof Uint8Array);
            ++compressionRequests;
        }
        this.thread.postMessage(data, transfer);
    }

    terminate() {
        this.terminated = true;
        this.termination ??= this.thread.terminate();
    }
}

async function storedFileSizes(root, relative = '') {
    const result = [];
    for (const entry of await readdir(path.join(root, relative), {withFileTypes: true})) {
        const name = path.join(relative, entry.name);
        if (entry.isDirectory()) {
            result.push(...await storedFileSizes(root, name));
        } else {
            result.push({path: name, bytes: (await stat(path.join(root, name))).size});
        }
    }
    return result.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

try {
    initialResources = await resources(output);
    verification = await loadVerificationManifest(evidenceRoot);
    recordIdRepresentation = verification.manifest.logicalRecordIdRepresentation ?? 'physical-float64';
    assert.equal(process.version, verification.manifest.recordedNodeVersion, 'Use the recorded Node version');
    runtimeIdentity = await fileIdentity(process.execPath);
    if (expectedNodeSha256 !== null) { assert.equal(runtimeIdentity.sha256, expectedNodeSha256, 'Requested Node executable identity'); }
    evidenceIdentity = await evidenceReceipt(evidenceRoot, verification.manifest);
    const expectedOutput = await readPinnedOracle(evidenceRoot, verification.manifest, `${corpus}-output`);
    expectedOutputOracle = JSON.parse(expectedOutput.bytes);
    await resourceBoundary();
    source = await sourceReceipt(sourceRoot, sourceCommit, arm, verification.manifest);
    source.identity = {...source.identity, ...await fileHashes(sourceRoot, extraSources)};
    sourceFamily = {arm,
        historicalRuntimeCommit: verification.manifest.historicalSource.commit,
        runtimeProfileCommit: verification.manifest.sourceProfiles[arm].runtimeCommit,
        verificationManifest: verification.identity};
    helperIdentity = await fileHashes(helperRoot, helpers);
    const lockBytes = await readFile(path.join(sourceRoot, 'test/perf/dictionaries.lock.json'));
    lockSha256 = sha256(lockBytes);
    fixture = JSON.parse(lockBytes).dictionaries[corpus];
    const archivePath = path.join(cacheRoot, fixture.cacheFile);
    assert.deepEqual(await fileIdentity(archivePath), {bytes: fixture.sizeBytes, sha256: fixture.sha256});
    if (corpus === 'jmdict') {
        const {filename: oraclePath, bytes} = await readPinnedOracle(evidenceRoot, verification.manifest, 'jmdict-reference');
        expectedJmdict = JSON.parse(bytes);
        assert.equal(expectedJmdict.success, true);
        assert.equal(expectedJmdict.source.commit, verification.manifest.historicalSource.commit);
        assert.equal(expectedJmdict.fixtureSha256, fixture.sha256);
        assertHistoricalOracleIdentity(expectedJmdict.source.identity, source.canonicalIdentity, verification.manifest, arm);
        await save('jmdict-oracle-receipt.json', {path: oraclePath, sha256: sha256(bytes), capture: expectedJmdict.lookupCapture});
    }
    if (corpus === 'vndb') {
        const {filename: oraclePath, bytes} = await readPinnedOracle(evidenceRoot, verification.manifest, 'vndb-corpus');
        const oracleSha256 = sha256(bytes);
        assert.equal(oracleSha256, '62985f33f3ea1a2cb679c39db6b04921192a624b7f5ec8cc0c8379e2e681418a');
        expectedVndbMedia = JSON.parse(bytes);
        assert.equal(expectedVndbMedia.complete, true);
        assert.equal(expectedVndbMedia.fixture.sha256, fixture.sha256);
        assert.equal(expectedVndbMedia.fixture.lockSha256, lockSha256);
        assert.equal(expectedVndbMedia.totals.rows, fixture.termRows);
        assert.equal(expectedVndbMedia.uniqueImagePaths, fixture.mediaFiles);
        vndbMediaOracleReceipt = {path: oraclePath,
            sha256: oracleSha256,
            sourceCommit: expectedVndbMedia.head,
            scope: expectedVndbMedia.scope,
            note: 'Independent legacy JSON/native projection oracle: per-group representatives are not distinct archive media files.'};
        const {filename: fileOraclePath, bytes: fileOracleBytes} = await readPinnedOracle(evidenceRoot, verification.manifest, 'vndb-media-files');
        expectedVndbMediaFiles = JSON.parse(fileOracleBytes);
        assert.equal(expectedVndbMediaFiles.success, true);
        assert.equal(expectedVndbMediaFiles.fixtureSha256, fixture.sha256);
        assert.equal(expectedVndbMediaFiles.fixtureBytes, fixture.sizeBytes);
        assert.equal(expectedVndbMediaFiles.lockSha256, lockSha256);
        assert.equal(expectedVndbMediaFiles.uniqueImagePaths, fixture.mediaFiles);
        assert.equal(expectedVndbMediaFiles.mediaBytes, fixture.mediaBytes);
        const originalMediaHelper = await readPinnedOracle(evidenceRoot, verification.manifest, 'vndb-media-original-helper');
        assert.equal(expectedVndbMediaFiles.helperSha256, originalMediaHelper.identity.sha256);
        vndbMediaOracleReceipt.independentFileOracle = {path: fileOraclePath, sha256: sha256(fileOracleBytes)};
        await save('media-oracle-receipt.json', vndbMediaOracleReceipt);
    }
    globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        assert.equal(url.protocol, 'file:');
        return new Response(await readFile(url), {headers: {'Content-Type': 'application/wasm'}});
    };
    env = await createBoundedNodeOpfs();
    assert.equal(path.dirname(env.temporaryRoot), os.tmpdir());
    assert(path.basename(env.temporaryRoot).startsWith('manabitan-opfs-bounded-'));
    stage = 'module and archive catalog setup';
    await save('setup.json', {stage,
        corpus,
        arm,
        source,
        sourceFamily,
        helperIdentity,
        fixture,
        lockSha256,
        node: process.version,
        execArgv: process.execArgv,
        budget,
        initialResources,
        opfsTemporaryRoot: env.temporaryRoot ?? env.rootPath});
    // Current 4-core/8GiB capability policy chooses three parser workers.
    // Codec worker count is independent, fixed at the production value four.
    Object.defineProperty(globalThis, 'navigator', {configurable: true,
        value: {hardwareConcurrency: 4, deviceMemory: 8, storage: {getDirectory: async () => env.root}}});
    globalThis.Worker = ActualWorker;
    const api = await sourceModule('ext/js/dictionary/zstd-term-content.js');
    const {compileCanonicalScanModule} = await sourceModule('ext/js/dictionary/term-content-canonical-scan.js');
    const {RawZipPayloadReader} = await sourceModule('ext/js/dictionary/term-bank-source-pipeline.js');
    const {getParallelTermBankParserWorkerCount} = await sourceModule('ext/js/dictionary/term-bank-wasm-parser.js');
    const {MIN_EXACT_LOOKUP_SOURCE_BYTES} = await sourceModule('ext/js/dictionary/term-lookup-route.js');
    const {registerOwnedTermContent} = await sourceModule('ext/js/dictionary/term-content-ownership.js');
    const {RAW_TERM_CONTENT_TOKEN_DICT_NAME} = await sourceModule('ext/js/dictionary/raw-term-content.js');
    const {DictionaryDatabase} = await sourceModule('ext/js/dictionary/dictionary-database.js');
    const {TermRecordOpfsStore} = await sourceModule('ext/js/dictionary/term-record-opfs-store.js');
    const parserSource = await readFile(path.join(sourceRoot, 'ext/js/dictionary/term-bank-wasm-parser.js'), 'utf8');
    const importerSource = await readFile(path.join(sourceRoot, 'ext/js/dictionary/dictionary-importer.js'), 'utf8');
    const archive = await openAsBlob(archivePath);
    const opened = await openSourceCatalog(sourceRoot, archive);
    zip = opened.zipReader;
    const {index, banks} = opened;
    assert.equal(index.title, fixture.expectedTitle);
    assert.equal(index.revision, fixture.revision);
    const manifestSha256 = sha256(JSON.stringify(sourceManifest(banks)));
    if (corpus === 'vndb') {
        const {bytes: referenceBytes} = await readPinnedOracle(evidenceRoot, verification.manifest, 'vndb-directory');
        const reference = JSON.parse(referenceBytes);
        assert(reference.success && reference.independentCentralDirectoryExactMatch);
        assert.equal(opened.catalog, 'dense-zip');
        assert.equal(reference.manifestSha256, manifestSha256);
        assertHistoricalOracleIdentity(reference.source.identity, source.canonicalIdentity, verification.manifest, arm);
        await save('catalog-oracle-receipt.json', {sha256: sha256(referenceBytes), manifestSha256});
    }
    totalBytes = banks.reduce((total, bank) => total + bank.uncompressedSize, 0);
    const hasMedia = fixture.mediaFiles > 0;
    const parserWorkers = getParallelTermBankParserWorkerCount();
    const groupsPerWorker = constant(parserSource, hasMedia ? 'MEDIA_PARALLEL_SOURCE_PIPELINE_GROUPS_PER_WORKER' : 'PLAIN_PARALLEL_SOURCE_PIPELINE_GROUPS_PER_WORKER');
    const targetGroupBytes = constant(parserSource, 'LAZY_PARALLEL_SOURCE_TARGET_GROUP_BYTES');
    const groups = partitionBanks(banks, totalBytes, Math.max(parserWorkers * groupsPerWorker, Math.ceil(totalBytes / targetGroupBytes)));
    const projectImagePaths = hasMedia && totalBytes >= constant(importerSource, 'MIN_NATIVE_IMAGE_PROJECTION_SOURCE_BYTES');
    const largeProjectedImport = projectImagePaths && totalBytes >= constant(parserSource, 'OWNED_PROJECTED_CONTENT_MIN_SOURCE_BYTES');
    const options = {
        copyContentBytes: false,
        includeContentMetadata: true,
        initialContentBytesPerRow: constant(importerSource, 'TERM_BANK_WASM_INITIAL_CONTENT_BYTES_PER_ROW'),
        minimalDecode: true,
        reuseExpressionForReadingDecode: true,
        preallocateChunkRows: true,
        skipTagRuleDecode: hasMedia,
        lazyGlossaryDecode: true,
        mediaHintFastScan: hasMedia,
        projectImagePaths,
        validateGlossaryTypes: true,
        computeContentHashes: true,
        emitContentSlab: true,
        emitTokenBinaryContent: true,
        emitTermByteLists: false,
        prepareLookupIndexes: true,
        prepareLookupRoute: totalBytes >= MIN_EXACT_LOOKUP_SOURCE_BYTES,
        ownContentBytes: largeProjectedImport,
        experimentalNativeEscapedKeys: largeProjectedImport,
    };
    policy = {capabilities: {hardwareConcurrency: 4, deviceMemory: 8},
        parserWorkers,
        groupsPerWorker,
        targetGroupBytes,
        groups: groups.length,
        options,
        note: 'Sequential calls retain current source grouping and sink order; not the concurrent browser schedule.'};
    assert.equal(parserWorkers, 3);
    if (expectedJmdict) {
        assert.equal(totalBytes, expectedJmdict.totalBytes);
        assert.deepEqual(groups.map((group) => group.map((bank) => bank.filename)), expectedJmdict.groupResults.map((group) => group.banks));
    }
    await save('preflight.json', {arm,
        recordIdRepresentation,
        source,
        sourceFamily,
        helperIdentity,
        fixture,
        lockSha256,
        policy,
        totalBytes,
        archiveCatalog: opened.catalog,
        archiveEntryCount: opened.entryCount,
        manifestSha256,
        bankCount: banks.length,
        budget,
        initialResources,
        opfsTemporaryRoot: env.temporaryRoot ?? env.rootPath,
        boundary: 'Actual sink record fields only. Source CRC/size validation remains in the production worker; no media file persistence or browser timing.'});

    const originalBegin = api.TermContentCompressionPool.prototype.beginCompressWrappedSpans;
    api.TermContentCompressionPool.prototype.beginCompressWrappedSpans = function observeCompression(...args) {
        pools.add(this);
        plannedBlocks += args[4].length;
        return originalBegin.apply(this, args);
    };
    const validation = new WeakMap();
    const originalEncode = TermRecordOpfsStore.prototype._encodeArtifactRecordFields;
    TermRecordOpfsStore.prototype._encodeArtifactRecordFields = function observeRecordFields(chunk, offsets, lengths, base) {
        const fields = Reflect.apply(originalEncode, this, arguments);
        const format = fields.byteLength === chunk.rowCount * 16 ? 3 : (fields.byteLength === chunk.rowCount * 12 ? 1 : 2);
        const decoded = decodeFields(fields, chunk.rowCount, format);
        const references = chunk.resolvedContentReferences;
        const fixed = typeof chunk.fixedContentOffsetBase === 'number' && Number.isFinite(chunk.fixedContentOffsetBase) && chunk.fixedContentOffsetBase >= 0 &&
        typeof chunk.fixedContentLength === 'number' && Number.isFinite(chunk.fixedContentLength) && chunk.fixedContentLength >= 0;
        for (let row = 0; row < chunk.rowCount; ++row) {
            const unique = references?.uniqueIndexList[row];
            const offset = fixed ?
chunk.fixedContentOffsetBase + row * chunk.fixedContentLength :
                (references ? references.offsets[unique] : offsets[row]);
            const length = typeof chunk.fixedContentLength === 'number' ?
chunk.fixedContentLength :
                (references ? references.lengths[unique] : lengths[row]);
            const score = chunk.scoreList[row] ?? 0;
            const actual = decoded.get(row);
            assert.equal(actual[0], offset < 0 ? 0xffffffff : offset - base, `Row ${row} offset/source`);
            assert.equal(actual[1], length < 0 ? (format === 2 ? 0xffff : 0xffffffff) : length, `Row ${row} length/source`);
            assert(Object.is(actual[2], score), `Row ${row} score/source`);
        }
        const check = {group: currentGroup,
            rows: chunk.rowCount,
            format,
            contentOffsetBase: base,
            sourceShape: fixed ? 'fixed-span' : (references ? 'resolved-references' : 'row-columns'),
            allRowsMatchSource: true};
        sourceChecks.push(check);
        validation.set(fields, check);
        return fields;
    };
    const originalEnvelope = TermRecordOpfsStore.prototype._createLookupIndexChunk;
    TermRecordOpfsStore.prototype._createLookupIndexChunk = function observeIndexChunk(firstId, count, base, payload, fields, format) {
        const encoded = Reflect.apply(originalEnvelope, this, arguments);
        const check = validation.get(fields);
        assert(check && check.rows === count && check.format === format && check.contentOffsetBase === base);
        assert.equal(firstId, chunks.length === 0 ? 1 : chunks.at(-1).firstId + chunks.at(-1).count);
        const report = analyzeFields(fields, count, format, {group: currentGroup,
            firstId,
            contentOffsetBase: base,
            lookupPayloadBytes: payload.byteLength,
            currentEnvelopeBytes: encoded.byteLength,
            allRowsMatchSource: true});
        if (expectedJmdict) {
            const reference = expectedJmdict.lookupCapture.sections[chunks.length];
            assert(reference, 'Unexpected JMdict record-field split');
            for (const [key, actual] of Object.entries({group: currentGroup,
                firstId,
                count,
                contentOffsetBase: base,
                recordFieldsFormat: format,
                recordFieldsSha256: report.fieldsSha256,
                payloadSha256: sha256(payload),
                expectedOutputSha256: sha256(encoded)})) {
                assert.equal(actual, reference[key], `Frozen JMdict field oracle ${chunks.length}/${key}`);
            }
            report.matchesFrozenJmdictOracle = true;
        }
        report.lookupPayloadSha256 = sha256(payload);
        report.encodedEnvelopeSha256 = sha256(encoded);
        chunks.push(report);
        return encoded;
    };

    let parserListener;
    let parserReply = null;
    globalThis.self = {
        addEventListener(type, listener) { assert.equal(type, 'message'); parserListener = listener; },
        postMessage(message, transfer = []) {
            assert(parserReply);
            const resolve = parserReply;
            parserReply = null;
            resolve(structuredClone(message, {transfer}));
        },
    };
    await sourceModule('ext/js/dictionary/term-bank-wasm-parser-worker.js');
    async function parseRequest(message) {
        assert.equal(parserReply, null);
        let timeout;
        const result = new Promise((resolve, reject) => {
            parserReply = resolve;
            timeout = setTimeout(() => reject(new Error('Parser response deadline exceeded')), 300000);
        });
        try {
            parserListener({data: message});
            const reply = await result;
            assert(!reply.error, JSON.stringify(reply.error));
            return reply;
        } finally { clearTimeout(timeout); }
    }
    stage = 'initialize native modules and stores';
    await parseRequest({type: 'initialize', module: await WebAssembly.compile(await readFile(path.join(sourceRoot, 'ext/lib/term-bank-parser.wasm')))});
    await api.initializeTermContentZstd();
    assert.equal(workers.filter((worker) => worker.kind === 'codec').length, 4);
    await Promise.all(workers.map((worker) => worker.ready));
    await compileCanonicalScanModule();
    database = new DictionaryDatabase();
    database.setImportOptimizationFlags({termContentStorageMode: 'raw-bytes', queueTermContentWrites: true, rawTermBankSourceBytes: totalBytes});
    database._bulkImportTransactionOpen = true;
    database._deferTermsVirtualTableSync = true;
    database._termContentZstdInitialized = true;
    await database._termContentStore.prepare();
    await database._termRecordStore.prepare();
    await database._termContentStore.beginImportSession();
    await database._termRecordStore.beginImportSession();
    database._termContentBlockImportSession = database._termContentBlockStore.beginImportSession();
    const payloads = new RawZipPayloadReader(archive);
    let estimatedRows = 0;
    for (currentGroup = 0; currentGroup < groups.length; ++currentGroup) {
        stage = 'read and parse source group';
        codecBoundary();
        const group = groups[currentGroup];
        const sourceBuffers = [];
        for (const bank of group) {
            const bytes = await payloads.read(bank, new AbortController().signal);
            sourceBuffers.push(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        }
        const parsed = await parseRequest({type: 'parse',
            id: currentGroup,
            version: index.format ?? index.version,
            sourceBuffers,
            sourceMetadata: group.map(({filename, compressedSize, uncompressedSize, compressionMethod, signature}) => ({filename, compressedSize, uncompressedSize, compressionMethod, signature})),
            chunkSize: constant(importerSource, 'TERM_BANK_WASM_ROW_CHUNK_SIZE'),
            options});
        const chunk = parsed.chunk;
        parsed.chunk = null;
        assert(chunk && parsed.profile);
        assert.equal(chunk.rowCount, parsed.rowCount);
        assert.equal(chunk.useResolvedContentReferences, true);
        assert(chunk.preparedLookupIndexes instanceof Map);
        const ownsContentBytes = parsed.ownsContentBytes === true && parsed.borrowsWorkerMemory !== true && registerOwnedTermContent(chunk.contentBytesBuffer);
        const borrowsWorkerMemory = parsed.borrowsWorkerMemory === true || (chunk.contentBytesBuffer.buffer instanceof SharedArrayBuffer && !ownsContentBytes);
        let consumed = false;
        const consume = () => { consumed = true; };
        if (borrowsWorkerMemory) { chunk.releaseBorrowedContent = consume; }
        const {mediaRows: groupMediaRows, ...columnPayload} = chunk;
        const sourceBytes = group.reduce((total, bank) => total + bank.uncompressedSize, 0);
        if (currentGroup === 0) { estimatedRows = Math.max(chunk.rowCount, Math.round(chunk.rowCount * totalBytes / sourceBytes)); }
        rows += chunk.rowCount;
        mediaRows += groupMediaRows.length;
        if (expectedVndbMedia) {
            const expectedGroup = expectedVndbMedia.groups[currentGroup];
            assert.equal(expectedGroup.index, currentGroup);
            assert.deepEqual(expectedGroup.banks, group.map((bank) => bank.filename));
            assert.equal(expectedGroup.sourceBytes, sourceBytes);
            assert.equal(expectedGroup.rows, chunk.rowCount);
            assert.equal(expectedGroup.mediaRows, groupMediaRows.length);
            assert.equal(expectedGroup.fallbackRows, 0);
            let groupProjectedPaths = 0;
            for (const {imagePaths} of groupMediaRows) {
                assert(Array.isArray(imagePaths));
                assert.equal(imagePaths.length, 1);
                assert.equal(typeof imagePaths[0], 'string');
                projectedMediaPathDigest.update(`${JSON.stringify(imagePaths)}\n`);
                projectedMediaUniquePaths.add(imagePaths[0]);
                groupProjectedPaths += imagePaths.length;
            }
            assert.equal(groupProjectedPaths, expectedGroup.projectedPaths);
            projectedMediaPathCount += groupProjectedPaths;
        }
        const payload = {...columnPayload,
            dictionary: index.title,
            dictionaryTotalRows: currentGroup + 1 === groups.length ? rows : Math.max(rows, estimatedRows),
            contentDictNameList: null,
            uniformContentDictName: RAW_TERM_CONTENT_TOKEN_DICT_NAME};
        const sourceOutputDigest = parserOutputDigest(chunk);
        stage = 'actual public canonical sink';
        const firstFieldChunk = chunks.length;
        try { await database.bulkAddArtifactTermsChunk(payload); } finally {
            if (borrowsWorkerMemory) {
                consume();
                delete chunk.releaseBorrowedContent;
            }
        }
        codecBoundary();
        if (borrowsWorkerMemory) { assert(consumed); }
        const groupFields = chunks.slice(firstFieldChunk);
        assert.equal(groupFields.reduce((total, entry) => total + entry.count, 0), chunk.rowCount);
        const metrics = database._lastBulkAddTermsMetrics;
        const memory = await resourceBoundary();
        groupResults.push({group: currentGroup,
            banks: group.map((bank) => ({filename: bank.filename,
                compressedSize: bank.compressedSize,
                uncompressedSize: bank.uncompressedSize,
                compressionMethod: bank.compressionMethod,
                signature: bank.signature})),
            rows: chunk.rowCount,
            sourceBytes,
            mediaRows: groupMediaRows.length,
            projectedMediaRows: groupMediaRows.filter((row) => Array.isArray(row.imagePaths)).length,
            dictionaryTotalRows: payload.dictionaryTotalRows,
            ownsContentBytes,
            borrowsWorkerMemory,
            contentBytesLength: chunk.contentBytesLength,
            contentBackingBytes: chunk.contentBytesBuffer.buffer.byteLength,
            uniquePlanCount: chunk.contentDedupPlan?.uniqueCount,
            preparedRanges: [...chunk.preparedLookupIndexes.keys()],
            fieldChunks: groupFields.length,
            parserSourceCompressedBytes: parsed.profile.sourceCompressedBytes,
            parserSourceUncompressedBytes: parsed.profile.sourceUncompressedBytes,
            parserNativeSegmentedLookupSegments: parsed.profile.nativeSegmentedLookupSegments,
            dedupNativeFallbackCount: metrics.dedupNativeFallbackCount,
            memory,
            sourceOutputDigest,
            metadataAllocation: allocationReceipt(database, recordIdRepresentation),
            summary: summarize(groupFields)});
        await save('progress.json', {corpus,
            groupsFinished: groupResults.length,
            totalGroups: groups.length,
            rows,
            mediaRows,
            plannedBlocks,
            summary: summarize(chunks),
            groupResults,
            chunks});
        if (currentGroup % 10 === 0 || currentGroup + 1 === groups.length) {
            console.log(JSON.stringify({corpus,
                group: currentGroup + 1,
                groups: groups.length,
                rows,
                currentFieldsBytes: summarize(chunks).currentFieldsBytes,
                savingsBytes: summarize(chunks).savingsBytes}));
        }
    }
    assert.equal(rows, fixture.termRows);
    assert.equal(sourceChecks.reduce((total, check) => total + check.rows, 0), rows);
    let mediaOracle = null;
    if (expectedVndbMedia) {
        assert.equal(groups.length, expectedVndbMedia.partition.groupCount);
        assert.equal(mediaRows, expectedVndbMedia.totals.mediaRows);
        assert.equal(projectedMediaPathCount, expectedVndbMedia.totals.projectedPaths);
        assert.equal(projectedMediaUniquePaths.size, expectedVndbMedia.uniqueImagePaths);
        assert.equal(projectedMediaUniquePaths.size, fixture.mediaFiles);
        const projectedPathDigest = projectedMediaPathDigest.digest('hex');
        assert.equal(projectedPathDigest, expectedVndbMedia.projectedPathDigest);
        const uniquePathDigest = createHash('sha256');
        for (const value of [...projectedMediaUniquePaths].sort()) { uniquePathDigest.update(`${JSON.stringify(value)}\n`); }
        const uniqueImagePathsSha256 = uniquePathDigest.digest('hex');
        assert.equal(uniqueImagePathsSha256, expectedVndbMediaFiles.imagePathsSha256);
        mediaOracle = {...vndbMediaOracleReceipt,
            groupsMatched: groups.length,
            mediaRows,
            projectedPaths: projectedMediaPathCount,
            uniqueImagePaths: projectedMediaUniquePaths.size,
            repeatedProjectedReferences: projectedMediaPathCount - projectedMediaUniquePaths.size,
            projectedPathDigest,
            uniqueImagePathsSha256,
            allGroupsAndProjectedPathsMatch: true};
        await save('media-oracle-result.json', mediaOracle);
    } else if (typeof fixture.mediaRows === 'number') { assert.equal(mediaRows, fixture.mediaRows); }
    if (expectedJmdict) { assert.equal(chunks.length, expectedJmdict.lookupCapture.calls); }
    stage = 'drain actual storage';
    database._termContentBlockImportSession.close();
    database._termContentBlockImportSession = null;
    await Promise.all([database._termContentStore.endImportSession(), database._termRecordStore.endImportSession()]);
    codecBoundary();
    const files = await storedFileSizes(env.rootPath);
    const finalOracle = {persisted: await digestStoredFiles(env.rootPath, (raw) => save('raw-final-files.json', raw)),
        metadata: metadataDigest(database, arm, Object.keys(expectedOutputOracle.metadata), recordIdRepresentation)};
    await save('final-output-oracle.json', finalOracle);
    const metadataAllocation = allocationReceipt(database, recordIdRepresentation);
    await save('metadata-allocation.json', {arm,
        corpus,
        recordIdRepresentation,
        final: metadataAllocation,
        groups: groupResults.map((group) => ({group: group.group, ...group.metadataAllocation})),
        nullPhysicalSignature1EveryGroup: groupResults.every((group) => group.metadataAllocation.physicalSignature1IsNull),
        nullPhysicalDictionaryNameIdsEveryGroup: groupResults.every((group) => group.metadataAllocation.dictionaryNameIds.physicalIsNull)});
    assert.deepEqual(finalOracle, expectedOutputOracle, 'Complete recorded file and logical metadata oracle');
    const expectedOracleIdentity = verification.manifest.oracles[`${corpus}-output`];
    assert.equal((await fileIdentity(path.join(output, 'final-output-oracle.json'))).sha256, expectedOracleIdentity.sha256);
    const completeFileOracle = {allFileBytesMatch: true,
        allLogicalMetadataMatches: true,
        expectedOracleSha256: expectedOracleIdentity.sha256,
        normalization: 'Only independently linked random16-byte file generations, logical S1 markers and the independently reconstructed dictionary-name prefix; the explicitly selected current profile additionally decodes empty Float64 record IDs as positive zero. Prefix scalars and upstream ID backing are retained in allocation receipts',
        recordIdRepresentation};
    await save('complete-file-oracle.json', completeFileOracle);
    const finalSource = await sourceReceipt(sourceRoot, sourceCommit, arm, verification.manifest);
    finalSource.identity = {...finalSource.identity, ...await fileHashes(sourceRoot, extraSources)};
    assert.deepEqual(finalSource, source);
    assert.deepEqual(await fileHashes(helperRoot, helpers), helperIdentity);
    assert.deepEqual(await evidenceReceipt(evidenceRoot, verification.manifest), evidenceIdentity);
    const summary = summarize(chunks);
    const actualIndexBytes = files.filter((file) => file.path.endsWith('.mbtr.mbti')).reduce((total, file) => total + file.bytes, 0);
    const actualContentBytes = files.filter((file) => file.path.startsWith('manabitan-term-content.bin')).reduce((total, file) => total + file.bytes, 0);
    const actualAllFilesBytes = files.reduce((total, file) => total + file.bytes, 0);
    assert(summary.currentFieldsBytes <= actualIndexBytes);
    await save('result.json', {success: true,
        timingEligible: false,
        corpus,
        arm,
        recordIdRepresentation,
        source,
        sourceFamily,
        helperIdentity,
        fixture,
        lockSha256,
        node: process.version,
        runtimeIdentity,
        evidenceIdentity,
        execArgv: process.execArgv,
        boundary: 'Actual current parent/candidate parser, public DB sink, real codecs and record-store fields with exact source grouping and ordered sink, bounded filesystem-backed Node OPFS adapter. Every persisted file and logical metadata column hashed. No import-speed or browser-memory claim.',
        mediaBoundary: 'Default skipImageMetadata/direct-artifact route passes columnPayload unchanged. Media requirements/files, UI, SQLite transaction, browser scheduling, restart and lookup are outside this census.',
        indexStorageBoundary: 'Real import-index worker runs when eligible; Node adapter handles lack createSyncAccessHandle and production code falls back to its asynchronous writer.',
        policy,
        rows,
        mediaRows,
        mediaOracle,
        totalBytes,
        bankCount: banks.length,
        archiveCatalog: opened.catalog,
        archiveEntryCount: opened.entryCount,
        manifestSha256,
        compression: {codecWorkers: workers.filter((worker) => worker.kind === 'codec').length,
            plannedBlocks,
            compressionRequests,
            compressionReplies,
            sourceConsumedReplies},
        indexWorker: {count: workers.filter((worker) => worker.kind === 'index').length, unsupportedOpenReplies: indexUnsupportedReplies},
        summary,
        actualIndexBytes,
        actualContentBytes,
        actualAllFilesBytes,
        hypotheticalIndexBytes: actualIndexBytes - summary.savingsBytes,
        hypotheticalAllFilesBytes: actualAllFilesBytes - summary.savingsBytes,
        files,
        completeFileOracle,
        finalOracle: await fileIdentity(path.join(output, 'final-output-oracle.json')),
        metadataAllocation,
        nullPhysicalSignature1EveryGroup: groupResults.every((group) => group.metadataAllocation.physicalSignature1IsNull),
        nullPhysicalDictionaryNameIdsEveryGroup: groupResults.every((group) => group.metadataAllocation.dictionaryNameIds.physicalIsNull),
        sourceChecks,
        groupResults,
        chunks,
        budget,
        peakRssDiagnosticBytes: peakRss,
        initialResources,
        finalResources: await resources(output)});
    console.log(JSON.stringify({corpus, success: true, summary, actualIndexBytes, actualAllFilesBytes}));
} catch (error) {
    await save('failure.json', {success: false,
        corpus,
        arm,
        stage,
        currentGroup,
        error: String(error?.stack ?? error),
        source,
        helperIdentity,
        evidenceIdentity,
        runtimeIdentity,
        configuration,
        fixture,
        lockSha256,
        policy,
        rows,
        mediaRows,
        totalBytes,
        groupResults,
        sourceChecks,
        chunks,
        budget,
        plannedBlocks,
        compressionRequests,
        compressionReplies,
        sourceConsumedReplies,
        indexUnsupportedReplies,
        initialResources,
        finalResources: await resources(output)});
    throw error;
} finally {
    for (const worker of workers) { worker.terminate(); }
    await Promise.all(workers.map((worker) => worker.termination));
    database?._termContentBlockImportSession?.close();
    await zip?.close();
    await env?.dispose();
}
