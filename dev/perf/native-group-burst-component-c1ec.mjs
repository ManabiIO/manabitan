#!/usr/bin/env node
/* Copyright (C) 2026 Manabitan authors. SPDX-License-Identifier: GPL-3.0-or-later */

// New prospective group-burst study. The prior writer run failed before any probe or observation.
// This component study is not an import or memory qualification.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {openAsBlob, createReadStream} from 'node:fs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const args = process.argv.slice(2);
const fixturesOnly = args.includes('--fixtures-only');
const positional = args.filter((arg) => arg !== '--fixtures-only');
assert.equal(positional.length, 6, 'Provide A root, B root, C root, cache, output directory, and plan JSON');
const [a, b, c, cacheInput, outputInput, planInput] = positional;
const roots = {A: path.resolve(a), B: path.resolve(b), C: path.resolve(c), D: path.resolve(a)};
const output = path.resolve(outputInput);
const planBytes = await readFile(path.resolve(planInput));
const plan = JSON.parse(planBytes);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const git = (root, ...command) => execFileSync('git', command, {cwd: root, encoding: 'utf8'}).trim();
const requireCandidate = createRequire(path.join(roots.C, 'package.json'));
const {BlobReader, ZipReader} = requireCandidate('@zip.js/zip.js');
const permutations = ['ABC', 'CBA', 'BCA', 'ACB', 'CAB', 'BAC'];
const expectedSchedule = [];
for (const [index, order] of permutations.entries()) {
    for (const arm of order) { expectedSchedule.push({id: `triple-${String(index + 1).padStart(2, '0')}-${arm}`, kind: 'comparison', triple: index + 1, arm}); }
    if (index === 1) {
        for (const arm of ['A', 'D']) { expectedSchedule.push({id: `control-01-${arm}`, kind: 'identical-control', pair: 1, arm}); }
    }
    if (index === 3) {
        for (const arm of ['D', 'A']) { expectedSchedule.push({id: `control-02-${arm}`, kind: 'identical-control', pair: 2, arm}); }
    }
}
assert.deepEqual(plan.schedule, expectedSchedule);
assert.equal(plan.observations, 22);
assert.equal(plan.measurement.warmupsPerObservation, 2);
assert.equal(plan.measurement.measuredPassesPerObservation, 1);
assert.equal(plan.grouping.expectedGroupCount, 12);
assert.equal(plan.fixture.dictionary, 'jmdict');
assert.equal(plan.fixture.rows, 528299);
assert.equal(plan.fixture.termBankCount, 53);
assert.equal(plan.arms.A.sha, '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2');
assert.equal(plan.arms.B.sha, 'b00df9aea6cc752aad2096bf6dc075dc8981575b');
assert.equal(plan.arms.C.sha, '9e14b5304ab1153e9720d112c830d325021eb07f');
assert.equal(plan.arms.D.sha, plan.arms.A.sha);

const lockBytes = await readFile(path.join(roots.A, 'test/perf/dictionaries.lock.json'));
assert.equal(sha(lockBytes), plan.fixture.lockSha256);
const fixture = JSON.parse(lockBytes).dictionaries.jmdict;
assert.equal(fixture.sha256, plan.fixture.archiveSha256);
assert.equal(fixture.sizeBytes, plan.fixture.archiveBytes);
const archivePath = path.join(path.resolve(cacheInput), fixture.cacheFile);
const hash = createHash('sha256');
for await (const bytes of createReadStream(archivePath)) { hash.update(bytes); }
assert.equal(hash.digest('hex'), fixture.sha256);
const archive = await openAsBlob(archivePath);
assert.equal(archive.size, fixture.sizeBytes);
const zip = new ZipReader(new BlobReader(archive));
const entries = (await zip.getEntries()).filter(({filename}) => /^term_bank_\d+\.json$/.test(filename))
    .sort((left, right) => Number(left.filename.slice(10, -5)) - Number(right.filename.slice(10, -5)));
const pipeline = await import(pathToFileURL(path.join(roots.A, 'ext/js/dictionary/term-bank-source-pipeline.js')));
const pipelineSha256 = sha(await readFile(path.join(roots.A, 'ext/js/dictionary/term-bank-source-pipeline.js')));
assert.equal(pipelineSha256, plan.identities.sourcePipelineSha256);
const rawReader = new pipeline.RawZipPayloadReader(archive);
const sources = new Map();
const fixtureReadSignal = new AbortController().signal;
for (const entry of entries) {
    assert(Number.isSafeInteger(entry.offset) && entry.offset >= 0, `Missing real ZIP offset: ${entry.filename}`);
    assert(!entry.encrypted && 'getData' in entry, `Unsupported ZIP entry: ${entry.filename}`);
    const bytes = await rawReader.read(entry, fixtureReadSignal);
    assert.equal(bytes.byteLength, entry.compressedSize);
    sources.set(entry.filename, {bytes, metadata: {filename: entry.filename, offset: entry.offset, encrypted: entry.encrypted, compressionMethod: entry.compressionMethod,
        compressedSize: entry.compressedSize, uncompressedSize: entry.uncompressedSize, signature: entry.signature,
        compressedSha256: sha(bytes)}});
}
await zip.close();
const metadata = [...sources.values()].map(({metadata: item}) => item);
assert.equal(metadata.length, 53);
assert.equal(metadata.reduce((sum, item) => sum + item.compressedSize, 0), plan.fixture.compressedTermSourceBytes);
assert.equal(metadata.reduce((sum, item) => sum + item.uncompressedSize, 0), plan.fixture.rawTermSourceBytes);
assert.deepEqual(plan.grouping.groups.flatMap(({files}) => files), metadata.map(({filename}) => filename));
for (const group of plan.grouping.groups) {
    const items = group.files.map((filename) => sources.get(filename).metadata);
    assert.deepEqual(items.map(({compressedSize}) => compressedSize), group.compressedBytes);
    const compressed = items.reduce((sum, item) => sum + item.compressedSize, 0);
    const decoded = items.reduce((sum, item) => sum + item.uncompressedSize, 0);
    assert(items.every((item) => item.compressionMethod === 8 && item.compressedSize <= item.uncompressedSize));
    assert(items.every((item) => item.uncompressedSize <= plan.groupBurstPolicy.maximumAdmittedBankBytes));
    assert(items.every((item) => Number.isInteger(item.signature) && item.signature >= 0 && item.signature <= 0xffffffff));
    assert(!(items.length > 1 && decoded >= 4 * 1024 * 1024 && compressed <= Math.floor(decoded / 32)), 'Fixture group unexpectedly enters deferred CRC');
}
const report = {schemaVersion: 1, scope: 'Actual Chromium, sequential source inflation/CRC and parser/lookup/route components only. Production result copy, owned shared slabs, worker transport, compression, storage and UI are excluded. No forced GC. Not an import, memory or PR qualification.',
    startedAt: new Date().toISOString(), planSha256: sha(planBytes), runnerSha256: sha(await readFile(fileURLToPath(import.meta.url))),
    node: process.version, hostEnvironment: {platform: process.platform, arch: process.arch,
        cpuModel: os.cpus()[0]?.model, logicalCpuCount: os.cpus().length, availableParallelism: os.availableParallelism(),
        totalMemoryBytes: os.totalmem(), freeMemoryBytes: os.freemem(), loadAverage: os.loadavg()},
    fixture, metadata, sourceIdentities: {}, preflight: {}, observations: [], status: 'preparing'};
await mkdir(output, {recursive: false});
const save = async () => writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
await writeFile(path.join(output, 'registered-plan.json'), planBytes, {flag: 'wx'});
await save();
// This admission-only check runs in Node before any browser or parser starts.
// The browser preflight below reconstructs the same unused getData interface.
report.activeStage = {id: 'preflight-node-metadata-admission', kind: 'preflight', startedAt: new Date().toISOString()};
await save();
try {
    let decodedReads = 0;
    let compressedReads = 0;
    let getDataCalls = 0;
    const plannerBanks = metadata.map((file) => ({...file, getData: async () => {
        ++getDataCalls;
        throw new Error('Unexpected decoded ZIP entry read');
    }}));
    const admission = new pipeline.TermBankSourcePipeline({termFiles: plannerBanks, enabled: true, deviceMemory: 8,
        read: async () => { ++decodedReads; throw new Error('Unexpected decoded metadata preflight read'); },
        readCompressed: async () => { ++compressedReads; throw new Error('Unexpected compressed metadata preflight read'); }});
    try {
        const run = admission.createCompressedImportRunPlan(0);
        assert(run, 'Faithful ZIP metadata was not admitted');
        assert.equal(run.files.length, 53); assert.equal(run.loaders.length, 53);
        assert.deepEqual(run.files.map(({filename}) => filename), metadata.map(({filename}) => filename));
        assert.deepEqual(run.estimatedByteLengths, metadata.map(({uncompressedSize}) => uncompressedSize));
        assert.equal(plannerBanks.filter((file) => admission.canPrefetch(file)).length, 53);
        report.preflight.plannerMetadataAdmission = {sourcePipelineSha256: pipelineSha256,
            fileCount: run.files.length, loaderCount: run.loaders.length, canPrefetchCount: 53,
            filenames: run.files.map(({filename}) => filename), estimatedByteLengths: run.estimatedByteLengths,
            offsets: metadata.map(({offset}) => offset), encrypted: metadata.map(({encrypted}) => encrypted ?? null)};
    } finally { await admission.dispose(); }
    assert.equal(decodedReads, 0); assert.equal(compressedReads, 0); assert.equal(getDataCalls, 0);
    Object.assign(report.preflight.plannerMetadataAdmission, {decodedReads, compressedReads, getDataCalls});
    report.activeStage = null;
    await save();
} catch (error) {
    report.status = 'failed'; report.failure = {name: error.name, message: error.message, stack: error.stack};
    await save(); throw error;
}
if (fixturesOnly) {
    report.status = 'fixtures-only-passed';
    await save();
    console.log(JSON.stringify({status: report.status, banks: metadata.length, groups: plan.grouping.groups.length, rows: fixture.termRows}));
    process.exit(0);
}

// This function is serialized into an actual dedicated module Worker. It has no Node dependencies.
async function componentWorker() {
    self.onmessage = async ({data}) => {
        const partial = {arm: data.arm, probe: data.probe, passes: [], activePass: null, activeGroup: null};
        let nativeCalls = 0;
        let wasmCalls = 0;
        try {
            const {origin, arm, banks, groups, probe, warmups} = data;
            const ensure = (condition, message) => { if (!condition) { throw new Error(message); } };
            const text = new TextEncoder();
            const hashBytes = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
                .map((value) => value.toString(16).padStart(2, '0')).join('');
            const framedHash = async (parts) => {
                const framed = [];
                for (const [name, value] of parts) {
                    const bytes = ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : text.encode(JSON.stringify(value));
                    const header = text.encode(JSON.stringify([name, ArrayBuffer.isView(value) ? value.constructor.name : 'json', bytes.byteLength]));
                    framed.push(new Uint32Array([header.byteLength, bytes.byteLength]), header, bytes);
                }
                const joined = new Uint8Array(framed.reduce((sum, view) => sum + view.byteLength, 0));
                let offset = 0;
                for (const view of framed) {
                    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
                    joined.set(bytes, offset); offset += bytes.byteLength;
                }
                return await hashBytes(joined);
            };
            const NativeStream = self.DecompressionStream;
            if (probe) {
                self.DecompressionStream = class extends NativeStream {
                    constructor(format) { super(format); ++nativeCalls; }
                };
            }
            self.__manabitanTermBankParserWorker = true;
            const parser = await import(`${origin}/${arm}/ext/js/dictionary/term-bank-wasm-parser.js`);
            const prep = await import(`${origin}/${arm}/ext/js/dictionary/term-lookup-index-preparation.js`);
            const routes = await import(`${origin}/${arm}/ext/js/dictionary/term-lookup-route.js`);
            const experiments = await import(`${origin}/${arm}/ext/js/dictionary/term-bank-experiments.js`);
            const wasmBytes = await (await fetch(`${origin}/${arm}/ext/lib/term-bank-parser.wasm`)).arrayBuffer();
            parser.setTermBankWasmModule(await WebAssembly.compile(wasmBytes));
            await parser.initializeTermBankWasmParser();
            const resident = new Map();
            for (const item of banks) {
                const response = await fetch(`${origin}/fixture/${item.filename}`);
                ensure(response.ok, `Compressed source fetch failed: ${item.filename}`);
                const bytes = new Uint8Array(await response.arrayBuffer());
                ensure(bytes.byteLength === item.compressedSize && await hashBytes(bytes) === item.compressedSha256, `Compressed source mismatch: ${item.filename}`);
                resident.set(item.filename, {...item, bytes});
            }
            const options = {singleChunk: true, maxPendingChunks: 1, compactContentMetadata: true,
                emitTermByteLists: false, computeContentHashes: true, emitContentSlab: true, emitTokenBinaryContent: true,
                mediaHintFastScan: false, projectImagePaths: false, validateGlossaryTypes: true,
                prepareLookupIndexes: true, prepareLookupRoute: true};
            const flags = experiments.snapshotTermBankExperiments(options);
            if (probe) {
                const preloaded = await parser.inflateCompressedTermBankSourcesWasm(groups[0].files.map((name) => resident.get(name)), flags, true);
                const original = preloaded.wasm.inflate_and_join_term_banks;
                preloaded.wasm.inflate_and_join_term_banks = (...args) => { ++wasmCalls; return original(...args); };
            }
            const digestChunk = async (chunk) => {
                const parts = [['rows', chunk.rowCount], ['readingEqualsExpression', chunk.readingEqualsExpressionList],
                    ['scores', chunk.scoreList], ['sequences', chunk.sequenceList]];
                const addPlan = (prefix, value) => {
                    for (const key of ['stringLengths', 'stringOffsets', 'stringHashes', 'stringsBuffer', 'readingIndexes']) {
                        parts.push([`${prefix}/${key}`, value[key] ?? null]);
                    }
                    parts.push([`${prefix}/expressionIndexes`, Uint32Array.from(value.expressionIndexes)]);
                };
                addPlan('recordPlan', chunk.termRecordPreinternedPlan);
                for (const [key, index] of chunk.preparedLookupIndexes) {
                    parts.push([`index/${key}/bytes`, index.bytes], [`index/${key}/route`, index.routeFilter ?? null]);
                    addPlan(`index/${key}/plan`, index.preinternedPlan);
                }
                const {contentMetaList: meta, contentBytesBuffer: slab, contentBytesBaseOffset: base} = chunk;
                ensure(meta && slab && typeof base === 'number', 'Missing complete row content');
                ensure(chunk.contentRowStart === 0, 'Unexpected partial content row range');
                ensure(Number.isSafeInteger(chunk.contentBytesLength) && chunk.contentBytesLength >= 0 &&
                    base >= 0 && base + chunk.contentBytesLength <= slab.byteLength, 'Invalid logical content slab');
                if (chunk.contentMetaByUniqueIndex === true) {
                    ensure(chunk.contentUniqueIndexList?.length === chunk.rowCount, 'Incomplete unique row mapping');
                }
                const rowMeta = new Uint32Array(chunk.rowCount * 3);
                let length = 0;
                for (let row = 0; row < chunk.rowCount; ++row) {
                    const slot = (chunk.contentMetaByUniqueIndex ? chunk.contentUniqueIndexList[row] : row) * 4;
                    ensure(Number.isSafeInteger(slot) && slot >= 0 && slot + 4 <= meta.length, 'Invalid row metadata mapping');
                    ensure(meta[slot] + meta[slot + 1] <= chunk.contentBytesLength, 'Row exceeds logical content slab');
                    rowMeta[row * 3] = meta[slot + 1]; rowMeta[row * 3 + 1] = meta[slot + 2]; rowMeta[row * 3 + 2] = meta[slot + 3];
                    length += meta[slot + 1];
                }
                const rowContent = new Uint8Array(length);
                let offset = 0;
                for (let row = 0; row < chunk.rowCount; ++row) {
                    const slot = (chunk.contentMetaByUniqueIndex ? chunk.contentUniqueIndexList[row] : row) * 4;
                    const start = base + meta[slot], size = meta[slot + 1];
                    ensure(start >= 0 && start + size <= slab.byteLength, 'Content row outside source slab');
                    rowContent.set(slab.subarray(start, start + size), offset); offset += size;
                }
                parts.push(['rowContentMetadata', rowMeta], ['rowContentIncludingTagsRules', rowContent],
                    ['contentRelativeMetadata', meta],
                    ['contentLogicalRange', {contentRowStart: chunk.contentRowStart, contentBytesLength: chunk.contentBytesLength,
                        contentMetaByUniqueIndex: chunk.contentMetaByUniqueIndex === true,
                        useResolvedContentReferences: chunk.useResolvedContentReferences === true}],
                    ['contentUniqueIndexes', chunk.contentUniqueIndexList ?? null],
                    ['uniqueRows', chunk.contentDedupPlan?.uniqueRowIndexes ?? null],
                    ['uniqueSignatures', chunk.contentDedupPlan?.uniqueSignatures ?? null],
                    ['dedupCounts', chunk.contentDedupPlan ? [chunk.contentDedupPlan.uniqueCount, chunk.contentDedupPlan.sourceRowCount] : null]);
                ensure(chunk.mediaRows.length === 0, 'Unexpected JMdict media projection');
                return {rows: chunk.rowCount, indexBytes: [...chunk.preparedLookupIndexes.values()].reduce((sum, index) => sum + index.bytes.byteLength, 0),
                    rowContentBytes: length, outputSha256: await framedHash(parts)};
            };
            const passes = partial.passes;
            for (let pass = 0; pass <= warmups; ++pass) {
                nativeCalls = 0; wasmCalls = 0;
                const results = [];
                const passRecord = {pass, excludedWarmup: pass < warmups, groups: results, status: 'in-progress'};
                passes.push(passRecord);
                partial.activePass = pass;
                for (const [groupIndex, group] of groups.entries()) {
                    const inputs = group.files.map((name) => resident.get(name));
                    partial.activeGroup = {groupIndex, files: group.files, stage: 'inflation'};
                    const beforeInflate = performance.now();
                    const preloaded = await parser.inflateCompressedTermBankSourcesWasm(inputs, flags, true);
                    const inflateMs = performance.now() - beforeInflate;
                    partial.activeGroup.inflateMs = inflateMs;
                    partial.activeGroup.stage = 'source-verification';
                    ensure(preloaded.wasm.memory.buffer instanceof SharedArrayBuffer, 'WASM memory is not shared');
                    ensure(preloaded.sourceCount === group.files.length && preloaded.bankSpanCount === group.files.length, 'Source bank boundaries differ');
                    ensure(!preloaded.crcSignaturesPtr, 'Unexpected deferred CRC in JMdict component');
                    const sourceSha256 = await hashBytes(Uint8Array.from(new Uint8Array(preloaded.wasm.memory.buffer, preloaded.jsonPtr, preloaded.jsonLength)));
                    const spans = [...new Uint32Array(preloaded.wasm.memory.buffer, preloaded.bankSpansPtr ?? 0, (preloaded.bankSpanCount ?? 0) * 2)];
                    Object.assign(partial.activeGroup, {sourceSha256, spans, stage: 'parse-lookup'});
                    let result = null;
                    const beforeParse = performance.now();
                    await parser.parseTermBankWithWasmColumnChunks(new Uint8Array(0), 3, (chunk) => {
                        ensure(result === null, 'Multiple component result chunks');
                        if (!(chunk.preparedLookupIndexes instanceof Map)) {
                            const prepared = prep.prepareTermLookupIndexesFromPreinternedPlan(chunk, null, flags);
                            ensure(prepared !== null, 'Missing lookup construction');
                            chunk.preparedLookupIndexes = prepared.indexes;
                        }
                        for (const index of chunk.preparedLookupIndexes.values()) {
                            index.routeFilter ??= routes.buildTermLookupFilter(index.preinternedPlan.stringHashes);
                        }
                        result = chunk;
                    }, 2048, {...options, ...flags, preloadedSource: preloaded});
                    const parseLookupMs = performance.now() - beforeParse;
                    Object.assign(partial.activeGroup, {parseLookupMs, stage: 'output-verification'});
                    const profile = parser.consumeLastTermBankWasmParseProfile();
                    ensure(result && profile && result.rowCount === group.rows, 'Missing or incomplete result rows');
                    ensure(prep.hasCompletePreparedTermLookupIndexes(result.preparedLookupIndexes, result.rowCount), 'Incomplete indexes');
                    const digest = await digestChunk(result);
                    results.push({groupIndex, files: group.files, sourceSha256, spans, ...digest,
                        sourceLength: preloaded.jsonLength, sourceCount: preloaded.sourceCount,
                        bankSpanCount: preloaded.bankSpanCount, deferredCrc: Boolean(preloaded.crcSignaturesPtr),
                        inflateMs, parseLookupMs, measuredComponentsMs: inflateMs + parseLookupMs,
                        maxWasmHeapBytes: profile.maxWasmHeapBytes, sourceCompressedBytes: preloaded.compressedBytes,
                        sourceUncompressedBytes: preloaded.uncompressedBytes});
                    result = null;
                    partial.activeGroup = null;
                }
                Object.assign(passRecord, {status: 'complete', rows: results.reduce((sum, value) => sum + value.rows, 0),
                    totals: Object.fromEntries(['inflateMs', 'parseLookupMs', 'measuredComponentsMs'].map((key) => [key, results.reduce((sum, value) => sum + value[key], 0)])),
                    nativeCalls: probe ? nativeCalls : null, wasmCalls: probe ? wasmCalls : null});
                partial.activePass = null;
            }
            self.postMessage({...partial, arm, probe, workerContext: self.constructor.name, crossOriginIsolated: self.crossOriginIsolated,
                hasSharedArrayBuffer: typeof SharedArrayBuffer === 'function', hasForcedGc: typeof self.gc === 'function',
                hardwareConcurrency: navigator.hardwareConcurrency, deviceMemoryGiB: navigator.deviceMemory, passes});
        } catch (error) {
            self.postMessage({...partial, nativeCalls: data.probe ? nativeCalls : null, wasmCalls: data.probe ? wasmCalls : null,
                fatal: {name: error.name, message: error.message, stack: error.stack}});
        }
    };
}

let server;
try {
    assert.equal(process.version, 'v22.22.0');
    const browserLockBytes = await readFile(path.join(roots.C, 'node_modules/playwright-core/browsers.json'));
    const browserLock = JSON.parse(browserLockBytes).browsers.find((item) => item.name === 'chromium');
    assert.equal(browserLock.browserVersion, plan.identities.chromiumVersion);
    report.browserLock = browserLock;
    report.browserLockSha256 = sha(browserLockBytes);
    const extTree = (root) => git(root, 'ls-tree', '-r', 'HEAD', '--', 'ext').split('\n')
        .filter((line) => !line.endsWith('\text/js/dictionary/term-bank-wasm-parser.js'));
    for (const arm of ['A', 'B', 'C', 'D']) {
        assert.match(plan.arms[arm].sha, /^[a-f0-9]{40}$/);
        assert.equal(git(roots[arm], 'rev-parse', 'HEAD'), plan.arms[arm].sha);
        assert.equal(git(roots[arm], 'status', '--porcelain', '--untracked-files=no'), '', `Dirty tracked source ${arm}`);
        assert.deepEqual(extTree(roots[arm]), extTree(roots.A), `Unexpected additional runtime change ${arm}`);
        const hashes = {};
        for (const file of ['ext/js/dictionary/term-bank-wasm-parser.js', 'ext/lib/term-bank-parser.wasm', 'package-lock.json', 'test/perf/dictionaries.lock.json']) {
            hashes[file] = sha(await readFile(path.join(roots[arm], file)));
        }
        assert.equal(hashes['ext/js/dictionary/term-bank-wasm-parser.js'], plan.identities.runtimeSha256[arm]);
        assert.equal(hashes['ext/lib/term-bank-parser.wasm'], plan.identities.parserWasmSha256);
        assert.equal(hashes['package-lock.json'], plan.identities.packageLockSha256);
        assert.equal(hashes['test/perf/dictionaries.lock.json'], plan.fixture.lockSha256);
        const tree = git(roots[arm], 'rev-parse', 'HEAD^{tree}');
        assert.equal(tree, plan.identities.sourceTrees[arm]);
        report.sourceIdentities[arm] = {sha: plan.arms[arm].sha, tree, hashes};
    }
    report.servedFileHashes = {};
    server = createServer(async (request, response) => {
        response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        response.setHeader('Cache-Control', 'no-store');
        try {
            const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
            if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Native transport component diagnostic</title>'); return; }
            if (pathname.startsWith('/fixture/')) {
                const source = sources.get(pathname.slice('/fixture/'.length));
                if (!source) { response.writeHead(404); response.end(); return; }
                response.setHeader('Content-Type', 'application/octet-stream'); response.end(source.bytes); return;
            }
            const arm = pathname.split('/')[1];
            if (!(arm in roots)) { response.writeHead(404); response.end(); return; }
            const relative = pathname.slice(3);
            const target = path.resolve(roots[arm], relative);
            if (!target.startsWith(roots[arm] + path.sep) || !relative.startsWith('ext/')) { response.writeHead(403); response.end(); return; }
            const bytes = await readFile(target);
            const key = `${arm}/${relative}`;
            const digest = sha(bytes);
            assert(!report.servedFileHashes[key] || report.servedFileHashes[key] === digest, `Source changed while serving ${key}`);
            report.servedFileHashes[key] = digest;
            response.setHeader('Content-Type', target.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
            response.end(bytes);
        } catch (error) { response.writeHead(500); response.end(String(error)); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const {chromium} = requireCandidate('playwright');
    const launch = async () => {
        const browser = await chromium.launch({headless: true});
        assert.equal(browser.version(), plan.identities.chromiumVersion);
        return browser;
    };
    const pageFor = async (browser) => {
        const page = await browser.newPage();
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'hardwareConcurrency', {configurable: true, value: 4});
            Object.defineProperty(navigator, 'deviceMemory', {configurable: true, value: 8});
        });
        await page.goto(origin);
        return page;
    };
    // Actual production partitioning is captured before timing, in a separate browser.
    {
        report.activeStage = {id: 'preflight-production-planner', kind: 'preflight', startedAt: new Date().toISOString()};
        await save();
        const browser = await launch();
        try {
            const page = await pageFor(browser);
            report.preflight.productionPlanner = await page.evaluate(async ({origin, banks}) => {
                const groups = [];
                const NativeWorker = window.Worker;
                window.Worker = class extends NativeWorker {
                    postMessage(message, transfer) {
                        if (message.type === 'parse') { groups.push({files: message.sourceMetadata.map(({filename}) => filename), compressedBytes: message.sourceBuffers.map((buffer) => buffer.byteLength)}); }
                        super.postMessage(message, transfer);
                    }
                };
                const parser = await import(`${origin}/A/ext/js/dictionary/term-bank-wasm-parser.js`);
                const {TermBankSourcePipeline} = await import(`${origin}/A/ext/js/dictionary/term-bank-source-pipeline.js`);
                parser.setTermBankWasmModule(await WebAssembly.compile(await (await fetch(`${origin}/A/ext/lib/term-bank-parser.wasm`)).arrayBuffer()));
                const plannerBanks = banks.map((file) => ({...file, getData: async () => {
                    throw new Error('Unexpected decoded ZIP entry read');
                }}));
                const sourcePipeline = new TermBankSourcePipeline({termFiles: plannerBanks, enabled: true,
                    read: async () => { throw new Error('Unexpected decoded planner input'); },
                    readCompressed: async (file) => new Uint8Array(await (await fetch(`${origin}/fixture/${file.filename}`)).arrayBuffer())});
                let rows = 0;
                let profile;
                try {
                    const run = sourcePipeline.createCompressedImportRunPlan(0);
                    if (!run || run.files.length !== 53) { throw new Error('Production run plan differs'); }
                    const ok = await parser.parseTermBankWithWasmColumnChunksParallelCompressedLazy(run.loaders, run.estimatedByteLengths, 3,
                        (chunk) => { rows += chunk.rowCount; }, {emitTermByteLists: false, computeContentHashes: true,
                            emitContentSlab: true, emitTokenBinaryContent: true, mediaHintFastScan: false, projectImagePaths: false,
                            validateGlossaryTypes: true, prepareLookupIndexes: true, prepareLookupRoute: true, maxPendingChunks: 2});
                    if (!ok) { throw new Error('Production parallel planner declined'); }
                    profile = parser.consumeLastTermBankWasmParseProfile();
                } finally { await sourcePipeline.dispose(); await parser.disposeParallelTermBankParser(); window.Worker = NativeWorker; }
                groups.sort((left, right) => Number(left.files[0].slice(10, -5)) - Number(right.files[0].slice(10, -5)));
                return {rows, groups, workers: profile.parallelWorkerCount, pipelineGroupsPerWorker: profile.parallelPipelineGroupsPerWorker,
                    groupCount: profile.parallelGroupCount, hardwareConcurrency: navigator.hardwareConcurrency, deviceMemoryGiB: navigator.deviceMemory};
            }, {origin, banks: metadata});
        } finally { await browser.close(); }
    }
    const captured = report.preflight.productionPlanner;
    assert.equal(captured.rows, fixture.termRows);
    assert.equal(captured.workers, 3);
    assert.equal(captured.pipelineGroupsPerWorker, 4);
    assert.equal(captured.groupCount, 12);
    assert.equal(captured.hardwareConcurrency, 4); assert.equal(captured.deviceMemoryGiB, 8);
    assert.deepEqual(captured.groups, plan.grouping.groups.map(({files, compressedBytes}) => ({files, compressedBytes})));
    report.activeStage = null;
    await save();
    const observe = async (arm, probe) => {
        const browser = await launch();
        try {
            const page = await pageFor(browser);
            return await page.evaluate(({workerSource, payload}) => new Promise((resolve, reject) => {
                const url = URL.createObjectURL(new Blob([`(${workerSource})();`], {type: 'text/javascript'}));
                const worker = new Worker(url, {type: 'module'});
                const clean = () => { clearTimeout(timeout); worker.terminate(); URL.revokeObjectURL(url); };
                const timeout = setTimeout(() => { clean(); reject(new Error('Component worker exceeded 120 seconds')); }, 120000);
                worker.onerror = (event) => { clean(); reject(new Error(event.message)); };
                worker.onmessage = ({data}) => { clean(); resolve(data); };
                worker.postMessage(payload);
            }), {workerSource: componentWorker.toString(), payload: {origin, arm, banks: metadata,
                groups: plan.grouping.groups, probe, warmups: probe ? 0 : plan.measurement.warmupsPerObservation}});
        } finally { await browser.close(); }
    };
    let reference = null;
    const fingerprint = (group) => Object.fromEntries(['groupIndex', 'files', 'sourceSha256', 'spans', 'sourceLength', 'sourceCount', 'bankSpanCount',
        'deferredCrc', 'rows', 'indexBytes', 'rowContentBytes', 'outputSha256', 'sourceCompressedBytes', 'sourceUncompressedBytes'].map((key) => [key, group[key]]));
    const validate = (result, arm, probe) => {
        assert(!result.fatal, JSON.stringify(result.fatal));
        assert.equal(result.arm, arm); assert.equal(result.probe, probe);
        assert.equal(result.workerContext, 'DedicatedWorkerGlobalScope');
        assert.equal(result.crossOriginIsolated, true); assert.equal(result.hasSharedArrayBuffer, true);
        assert.equal(result.hasForcedGc, false, 'Unexpected exposed GC in a no-forced-GC lane');
        assert.equal(result.activePass, null); assert.equal(result.activeGroup, null);
        assert.equal(result.passes.length, probe ? 1 : 3);
        for (const [index, pass] of result.passes.entries()) {
            assert.equal(pass.status, 'complete');
            assert.equal(pass.pass, index); assert.equal(pass.excludedWarmup, !probe && index < 2);
            assert.equal(pass.rows, fixture.termRows); assert.equal(pass.groups.length, 12);
            const current = pass.groups.map(fingerprint);
            reference ??= current;
            assert.deepEqual(current, reference, `Complete source/output projection differs in ${arm}/pass${index}`);
            for (const group of pass.groups) {
                for (const key of ['inflateMs', 'parseLookupMs', 'measuredComponentsMs']) { assert(Number.isFinite(group[key]) && group[key] > 0); }
            }
            if (probe) {
                assert.equal(pass.nativeCalls, arm === 'A' ? 0 : 53);
                assert.equal(pass.wasmCalls, arm === 'A' ? 12 : 0);
            } else { assert.equal(pass.nativeCalls, null); assert.equal(pass.wasmCalls, null); }
        }
    };
    report.preflight.admission = [];
    for (const arm of ['A', 'B', 'C']) {
        report.activeStage = {id: `preflight-admission-${arm}`, kind: 'preflight', arm, startedAt: new Date().toISOString()};
        await save();
        const result = await observe(arm, true);
        report.preflight.admission.push(result); await save(); validate(result, arm, true);
        report.activeStage = null;
    }
    report.status = 'acquiring'; await save();
    for (const item of expectedSchedule) {
        report.activeObservation = {...item, startedAt: new Date().toISOString()};
        report.activeStage = {id: item.id, kind: 'observation', arm: item.arm};
        await save();
        const result = await observe(item.arm, false);
        const observation = {...item, result};
        report.observations.push(observation);
        await writeFile(path.join(output, `${item.id}.json`), JSON.stringify(observation, null, 2) + '\n', {flag: 'wx'});
        await save(); validate(result, item.arm, false);
        report.activeObservation = null; report.activeStage = null; await save();
        console.log(JSON.stringify({id: item.id, totals: result.passes[2].totals}));
    }
    const median = (items) => { const values = [...items].sort((left, right) => left - right); const middle = Math.floor(values.length / 2); return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2; };
    report.comparisons = {};
    for (const [name, numerator, denominator, kind, pairKey, count] of [['C/B', 'C', 'B', 'comparison', 'triple', 6], ['C/A', 'C', 'A', 'comparison', 'triple', 6], ['B/A', 'B', 'A', 'comparison', 'triple', 6], ['D/A', 'D', 'A', 'identical-control', 'pair', 2]]) {
        const values = report.observations.filter((item) => item.kind === kind);
        report.comparisons[name] = {};
        for (const key of ['inflateMs', 'parseLookupMs', 'measuredComponentsMs']) {
            const pairs = [];
            for (let pair = 1; pair <= count; ++pair) {
                const get = (arm) => { const matches = values.filter((item) => item[pairKey] === pair && item.arm === arm); assert.equal(matches.length, 1); return matches[0].result.passes[2].totals[key]; };
                const a = get(denominator), b = get(numerator); pairs.push({pair, denominatorMs: a, numeratorMs: b, ratio: b / a});
            }
            report.comparisons[name][key] = {pairs, medianPairedChangePercent: (median(pairs.map(({ratio}) => ratio)) - 1) * 100,
                equalWorkChangePercent: (pairs.reduce((sum, pair) => sum + pair.numeratorMs, 0) / pairs.reduce((sum, pair) => sum + pair.denominatorMs, 0) - 1) * 100,
                fasterPairs: pairs.filter(({ratio}) => ratio < 1).length};
        }
    }
    // Match the existing descriptive reader's seeded complete-pair bootstrap.
    report.comparisons = JSON.parse(execFileSync('python3', ['-c', `
import json, random, statistics, sys
comparisons = json.load(sys.stdin)
for metrics in comparisons.values():
    for result in metrics.values():
        ratios = [pair['ratio'] for pair in result['pairs']]
        rng = random.Random(897)
        resampled = sorted(statistics.median(rng.choices(ratios, k=len(ratios))) for _ in range(10000))
        result['count'] = len(ratios)
        result['worstPairChangePercent'] = (max(ratios) - 1) * 100
        result['descriptiveBootstrap95Percent'] = [(resampled[index] - 1) * 100 for index in (249, 9749)]
json.dump(comparisons, sys.stdout)
`], {input: JSON.stringify(report.comparisons), encoding: 'utf8'}));
    report.status = 'complete-component-diagnostic-only'; await save();
    console.log(JSON.stringify({status: report.status, observations: report.observations.length, comparisons: report.comparisons}));
} catch (error) {
    report.status = 'failed'; report.failure = {name: error.name, message: error.message, stack: error.stack};
    await save(); throw error;
} finally { if (server) { await new Promise((resolve) => server.close(resolve)); } }
