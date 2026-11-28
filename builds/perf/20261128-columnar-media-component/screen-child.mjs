import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream, openAsBlob} from 'node:fs';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {Worker as ThreadWorker} from 'node:worker_threads';
import {appendValue, columnFields, digestValue} from './screen-digest.mjs';

const [repository, archivePath, fixturePath, mode, outputPath] = process.argv.slice(2);
assert.ok(repository && archivePath && fixturePath && outputPath);
assert.ok(mode === 'qualify' || mode === 'timing');
const qualify = mode === 'qualify';
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const report = {schemaVersion: 1, mode, repository, node: process.version, passed: false};
const terminations = [];
const workers = [];
const groups = new Map();
const proofs = new Map();
const ownershipReceipts = [];
const detachedResults = new Set();
const unhandled = [];
let parser;
let sourcePipeline;
let zipReader;
process.on('unhandledRejection', (error) => unhandled.push(String(error)));

function dispatchError(target, error) {
    const event = new Event('error');
    Object.defineProperty(event, 'message', {value: String(error?.stack ?? error)});
    target.dispatchEvent(event);
}

class BrowserWorker extends EventTarget {
    constructor(url) {
        super();
        this.index = workers.length;
        this.closed = false;
        workers.push(this);
        const adapter = qualify ? new URL('screen-worker.mjs', import.meta.url) :
            pathToFileURL(path.join(repository, 'test/fixtures/parser-settlement/worker-node.mjs'));
        this.worker = new ThreadWorker(adapter, {
            workerData: {url: url.href},
            resourceLimits: {maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 64},
        });
        this.worker.on('message', (data) => {
            try {
                if (data.type === 'screen-transfer-detached') {
                    assert.equal(data.detached, true, `Worker ${this.index} did not detach result ${data.id}`);
                    detachedResults.add(data.id);
                    return;
                }
                if (data.type === 'result') {
                    assert.ok(groups.has(data.id), `Unexpected result ${data.id}`);
                    if (qualify && data.chunk !== null) {
                        assert.equal(data.screenProof.payloadHash, digestValue(columnFields(data.chunk)), `Transfer payload ${data.id}`);
                        assert.equal(data.screenProof.bufferCount, data.screenProof.uniqueBufferCount);
                        assert.ok(data.screenProof.transferredBytes > 0);
                        proofs.set(data.id, {...data.screenProof, worker: this.index,
                            ownsContentBytes: data.ownsContentBytes === true,
                            borrowsWorkerMemory: data.borrowsWorkerMemory === true});
                    }
                }
                this.dispatchEvent(new MessageEvent('message', {data}));
            } catch (error) { dispatchError(this, error); }
        });
        this.worker.on('error', (error) => dispatchError(this, error));
        this.worker.on('messageerror', () => this.dispatchEvent(new MessageEvent('messageerror')));
        this.worker.on('exit', (code) => {
            if (!this.closed) { dispatchError(this, new Error(`Unexpected worker exit ${code}`)); }
        });
    }

    postMessage(data, transfer) {
        if (data.type === 'parse') {
            assert.ok(!groups.has(data.id));
            groups.set(data.id, {
                id: data.id,
                worker: this.index,
                metadata: data.sourceMetadata,
                options: data.options,
            });
        }
        this.worker.postMessage(data, transfer);
        if (qualify && data.type === 'parse') {
            assert.ok(transfer.every((buffer) => buffer.byteLength === 0), 'Source input did not transfer');
        }
    }

    terminate() {
        this.closed = true;
        terminations.push(this.worker.terminate());
    }
}

async function hashFile(filename) {
    const hash = createHash('sha256');
    let sizeBytes = 0;
    for await (const bytes of createReadStream(filename)) { hash.update(bytes); sizeBytes += bytes.length; }
    return {sizeBytes, sha256: hash.digest('hex')};
}

async function missingImageMessage(importer, pathName, entry) {
    try {
        await importer._getImageMedia({media: new Map(), fileMap: new Map()}, pathName, entry);
    } catch (error) {
        assert.ok(error instanceof Error && error.message.startsWith('Could not find image at path '));
        return error.message;
    }
    throw new Error('Missing image unexpectedly resolved');
}

try {
    const archiveIdentity = await hashFile(archivePath);
    assert.equal(archiveIdentity.sha256, fixture.sha256);
    assert.equal(archiveIdentity.sizeBytes, fixture.sizeBytes);
    report.fixture = {...fixture, archivePath};
    globalThis.Worker = BrowserWorker;
    Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {hardwareConcurrency: 4, deviceMemory: 8}});
    const load = (filename) => import(pathToFileURL(path.join(repository, filename)).href);
    const {DictionaryImporter} = await load('ext/js/dictionary/dictionary-importer.js');
    const {DictionaryImporterMediaLoader} = await load('test/mocks/dictionary-importer-media-loader.js');
    const {RawZipPayloadReader, TermBankSourcePipeline} = await load('ext/js/dictionary/term-bank-source-pipeline.js');
    parser = await load('ext/js/dictionary/term-bank-wasm-parser.js');
    const {takeOwnedTermContent} = await load('ext/js/dictionary/term-content-ownership.js');
    const wasmPath = path.join(repository, 'ext/lib/term-bank-parser.wasm');
    report.wasm = await hashFile(wasmPath);
    const wasmModule = await WebAssembly.compile(await readFile(wasmPath));
    parser.setTermBankWasmModule(wasmModule);
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
    importer._skipImageMetadata = true;
    const archive = await openAsBlob(archivePath);
    const catalog = await importer._getFilesFromArchive(archive);
    zipReader = catalog.zipReader;
    const termFiles = importer._getArchiveFiles(catalog.fileMap).get('termFiles');
    assert.ok(termFiles.length >= 4);
    const rawReader = new RawZipPayloadReader(archive);
    sourcePipeline = new TermBankSourcePipeline({
        termFiles,
        enabled: true,
        deviceMemory: 8,
        read: async () => { throw new Error('Unexpected uncompressed fallback'); },
        readCompressed: async (file, signal) => await rawReader.read(file, signal, true),
    });
    const sourcePlan = sourcePipeline.createCompressedImportRunPlan(0);
    assert.ok(sourcePlan !== null && sourcePlan.files.length === termFiles.length);
    report.catalog = catalog.catalog;
    report.sourceCount = termFiles.length;
    report.sourceEstimatedBytes = sourcePlan.estimatedByteLengths.reduce((a, b) => a + b, 0);
    report.experiments = importer._termBankExperiments;
    const deferred = [];
    const firstOwners = new Set();
    const columnsHash = createHash('sha256');
    const referencesHash = createHash('sha256');
    const firstOwnersHash = createHash('sha256');
    const ownedByWorker = new Map();
    const chunkProofs = [];
    let rows = 0;
    let referenceCount = 0;
    let reuseChecks = 0;
    let lastProgress;
    report.memoryBefore = process.memoryUsage();
    const startedAt = performance.now();
    await importer._readTermBankFileFast(
        termFiles[0], 3, fixture.expectedTitle, false, true, true, 'raw-bytes',
        async (chunk, requirements, progress) => {
            rows += chunk.rowCount;
            lastProgress = progress;
            const group = groups.get(progress.chunkIndex);
            assert.ok(group);
            if (qualify) {
                const proof = proofs.get(progress.chunkIndex);
                const bytes = chunk.contentBytesBuffer;
                const complete = bytes instanceof Uint8Array && bytes.byteOffset === 0 &&
                    bytes.byteLength > 0 && bytes.byteLength === bytes.buffer.byteLength;
                const expectedReceipt = proof.ownsContentBytes && !proof.borrowsWorkerMemory && complete;
                // Observe the real parent's one-time receipt only in qualification.
                // The timed sink neither consumes nor manufactures a witness.
                const receipt = bytes instanceof Uint8Array && takeOwnedTermContent(bytes);
                assert.equal(receipt, expectedReceipt, `Owned-content receipt for group ${progress.chunkIndex}`);
                ownershipReceipts.push({id: progress.chunkIndex, expected: expectedReceipt, received: receipt});
                const prior = ownedByWorker.get(group.worker);
                if (prior) {
                    assert.equal(digestValue(prior.fields), prior.hash, `Owned fields reused by worker ${group.worker}`);
                    ++reuseChecks;
                }
                const fields = columnFields(chunk);
                const hash = digestValue(fields);
                appendValue(columnsHash, hash);
                const keyFields = Object.fromEntries(Object.entries(fields).filter(([key]) => /expression|reading|score|sequence|termRecord/.test(key)));
                const contentFields = Object.fromEntries(Object.entries(fields).filter(([key]) => /content|Content/.test(key)));
                chunkProofs.push({id: progress.chunkIndex, rows: chunk.rowCount, allColumns: hash,
                    content: digestValue(contentFields), keys: digestValue(keyFields), lookup: digestValue(chunk.preparedLookupIndexes)});
                const owned = columnFields(chunk, typeof chunk.releaseBorrowedContent === 'function');
                ownedByWorker.set(group.worker, {fields: owned, hash: digestValue(owned)});
            }
            for (const requirement of requirements ?? []) {
                ++referenceCount;
                const name = requirement.source.path;
                let diagnostic;
                if (qualify) {
                    diagnostic = await missingImageMessage(importer, name, requirement.entry);
                    appendValue(referencesHash, [requirement.type, name, diagnostic]);
                }
                if (firstOwners.has(name)) { continue; }
                firstOwners.add(name);
                importer._assignRequirementNoMetadata(requirement);
                deferred.push(importer._createDeferredMediaRequirement(requirement));
                if (qualify) { appendValue(firstOwnersHash, [requirement.type, name, diagnostic]); }
            }
        },
        {loaders: sourcePlan.loaders, estimatedByteLengths: sourcePlan.estimatedByteLengths, compressed: true},
        null, true,
    );
    report.componentWallMs = performance.now() - startedAt;
    report.memoryAfter = process.memoryUsage();
    report.profile = importer._lastFastTermBankReadProfile;
    report.rows = rows;
    report.referenceCount = referenceCount;
    report.uniqueMediaPaths = firstOwners.size;
    report.workerCount = workers.length;
    report.groups = [...groups.values()].sort((a, b) => a.id - b.id);
    report.groupBoundaryHash = digestValue(report.groups.map(({id, metadata}) => ({id, metadata})));
    report.rawZipRangeReads = rawReader.getCoalescedRangeReadCounts();
    assert.equal(rows, fixture.termRows);
    assert.equal(firstOwners.size, fixture.mediaFiles);
    assert.equal(lastProgress.processedRows, fixture.termRows);
    assert.equal(lastProgress.totalRows, fixture.termRows);
    assert.equal(workers.length, 3);
    assert.equal(report.profile.parserProfile.parallelWorkerCount, 3);
    assert.equal(report.profile.parserProfile.parallelPipelineGroupsPerWorker, 3);
    assert.equal(report.groups.length, report.profile.parserProfile.parallelGroupCount);
    assert.deepEqual(report.groups.flatMap(({metadata}) => metadata.map(({filename}) => filename)), termFiles.map(({filename}) => filename));
    if (qualify) {
        for (const prior of ownedByWorker.values()) { assert.equal(digestValue(prior.fields), prior.hash); ++reuseChecks; }
        const diagnosticSurvivalHash = createHash('sha256');
        for (const requirement of deferred) {
            const name = requirement.source.path;
            const diagnostic = await missingImageMessage(importer, name, requirement);
            appendValue(diagnosticSurvivalHash, [requirement.type, name, diagnostic]);
        }
        const firstOwnerDigest = firstOwnersHash.digest('hex');
        assert.equal(diagnosticSurvivalHash.digest('hex'), firstOwnerDigest, 'First-owner diagnostics changed after all native reuse');
        for (let turn = 0; turn < 100 && detachedResults.size < groups.size; ++turn) { await nextTurn(); }
        assert.equal(proofs.size, groups.size);
        assert.equal(detachedResults.size, groups.size);
        report.qualification = {
            columnsHash: columnsHash.digest('hex'),
            referencesHash: referencesHash.digest('hex'),
            firstOwnerHash: firstOwnerDigest,
            diagnosticSurvival: true,
            reuseChecks,
            chunkProofs,
            transferProofs: [...proofs].sort(([a], [b]) => a - b),
            sourceBuffersDetached: true,
            ownershipReceipts,
        };
    }
    await nextTurn();
    assert.deepEqual(unhandled, []);
    report.passed = true;
} catch (error) {
    report.error = {message: String(error), stack: error?.stack};
    process.exitCode = 1;
} finally {
    const cleanupErrors = [];
    for (const cleanup of [
        async () => await sourcePipeline?.abortAndJoin(),
        async () => await parser?.disposeParallelTermBankParser(),
        async () => await Promise.all(terminations),
        async () => await zipReader?.close(),
    ]) {
        try { await cleanup(); } catch (error) { cleanupErrors.push(String(error)); }
    }
    if (cleanupErrors.length > 0) {
        report.cleanupErrors = cleanupErrors;
        report.passed = false;
        process.exitCode = 1;
    }
    report.unhandled = unhandled;
    report.memoryFinal = process.memoryUsage();
    report.rssScope = 'All Node workers are threads in this process. RSS is common and must not be summed; realm heap/external snapshots are feasibility only.';
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, {flag: 'wx'});
    console.log(JSON.stringify({passed: report.passed, rows: report.rows, groups: report.groups?.length, mode, error: report.error?.message}));
}
