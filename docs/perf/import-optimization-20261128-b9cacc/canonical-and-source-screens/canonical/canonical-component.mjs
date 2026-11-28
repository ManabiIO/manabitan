import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream, openAsBlob} from 'node:fs';
import {appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync, writeSync} from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {Worker as ThreadWorker} from 'node:worker_threads';
import {gzipSync, gunzipSync} from 'node:zlib';

const [mode, registrationPath, registrationHash, outputPath, extra, firstUseBlock] = process.argv.slice(2);
const ownPath = fileURLToPath(import.meta.url);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const registrationBytes = readFileSync(registrationPath);
assert.equal(hash(registrationBytes), registrationHash, 'Frozen registration identity');
const registration = JSON.parse(registrationBytes);
assert.equal(hash(readFileSync(ownPath)), registration.harness.sha256, 'Frozen harness identity');
const root = registration.baseline.path;
const candidateRoot = registration.candidate.path;
const output = path.resolve(outputPath);
const sourceImport = (relative) => import(pathToFileURL(path.join(root, relative)));
const wasmName = 'term-content-canonical-scan-v1.wasm';
const baselineBytes = readFileSync(path.join(root, 'dev/data/dictionary-wasm', wasmName));
const candidateBytes = readFileSync(path.join(candidateRoot, 'dev/data/dictionary-wasm', wasmName));
assert.equal(hash(baselineBytes), registration.baseline.wasmSha256);
assert.equal(hash(candidateBytes), registration.candidate.wasmSha256);
assert.equal(process.version, registration.nodeVersion);
const armBytes = {A: baselineBytes, B: candidateBytes, C: baselineBytes};
const {CANONICAL_SCAN_LAYOUT: layout, CANONICAL_SCAN_EXACT_BATCH_SIZE} = await sourceImport('ext/js/dictionary/term-content-canonical-layout.js');
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const save = (name, value) => writeFileSync(path.join(output, name), json(value));
const append = (name, value) => appendFileSync(path.join(output, name), JSON.stringify(value) + '\n');
const median = (values) => {
    const a = [...values].sort((x, y) => x - y);
    return (a[Math.floor((a.length - 1) / 2)] + a[Math.floor(a.length / 2)]) / 2;
};
function semanticHash(memory) {
    const bytes = new Uint8Array(memory.buffer);
    return createHash('sha256').update(bytes.subarray(1024, 1052))
        .update(bytes.subarray(1088, 1176)).update(bytes.subarray(layout.META)).digest('hex');
}
function checkedSource() {
    assert.equal(hash(readFileSync(registrationPath)), registrationHash, 'Registration remains frozen');
    assert.equal(hash(readFileSync(ownPath)), registration.harness.sha256, 'Harness remains frozen');
    assert.equal(hash(readFileSync(registration.watchdog.path)), registration.watchdog.sha256, 'Watchdog remains frozen');
    assert.equal(hash(readFileSync(path.join(root, 'dev/data/dictionary-wasm', wasmName))), registration.baseline.wasmSha256);
    assert.equal(hash(readFileSync(path.join(candidateRoot, 'dev/data/dictionary-wasm', wasmName))), registration.candidate.wasmSha256);
    const identities = {};
    for (const [label, source] of [['baseline', registration.baseline], ['candidate', registration.candidate]]) {
        const actual = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: source.path, encoding: 'utf8'}).trim();
        assert.equal(actual, source.commit, label + ' source commit');
        execFileSync('git', ['diff', '--quiet', 'HEAD', '--'], {cwd: source.path});
        identities[label] = {commit: actual, tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {cwd: source.path, encoding: 'utf8'}).trim()};
    }
    for (const [relative, digest] of Object.entries(registration.baselineFiles)) {
        assert.equal(hash(readFileSync(path.join(root, relative))), digest, relative);
    }
    return identities;
}
async function checkedFixture() {
    const lockBytes = readFileSync(path.join(root, 'test/perf/dictionaries.lock.json'));
    assert.equal(hash(lockBytes), registration.fixture.lockSha256);
    const fixture = JSON.parse(lockBytes).dictionaries.jmdict;
    assert.equal(fixture.sha256, registration.fixture.sha256);
    assert.equal(statSync(registration.fixture.path).size, fixture.sizeBytes);
    const digest = createHash('sha256');
    for await (const bytes of createReadStream(registration.fixture.path)) { digest.update(bytes); }
    const sha256 = digest.digest('hex');
    assert.equal(sha256, fixture.sha256);
    return {sha256, sizeBytes: fixture.sizeBytes};
}
function validateModule(module) {
    assert.deepEqual(WebAssembly.Module.imports(module), [{module: 'env', name: 'memory', kind: 'memory'}]);
}
function makeInstance(module, memory) {
    const instance = new WebAssembly.Instance(module, {env: {memory}});
    assert.equal(instance.exports.canonical_abi_version(), 1);
    assert.equal(instance.exports.canonical_layout_end(), layout.usedBytes);
    return {memory, run: instance.exports.scan_canonical};
}
function restoreCapture(capture, memory) {
    const compressed = readFileSync(path.join(output, capture.file));
    assert.equal(hash(compressed), capture.compressedSha256);
    const bytes = gunzipSync(compressed, {maxOutputLength: registration.limits.maxArenaBytes});
    assert.equal(bytes.byteLength, capture.memoryBytes);
    assert.equal(hash(bytes), capture.inputSha256);
    if (memory) { new Uint8Array(memory.buffer).set(bytes); }
    return bytes;
}
function verifyCall(capture, arm, returned) {
    assert.equal(returned, capture.expectedReturn, 'Native return code');
    assert.equal(semanticHash(arm.memory), capture.outputSha256, 'Complete semantic native state');
    assert.deepEqual([...new Uint32Array(arm.memory.buffer, 1024, 7)], capture.header, 'All native header words');
}
function loadManifest() {
    const manifestBytes = readFileSync(path.join(output, 'capture-manifest.json'));
    const manifest = JSON.parse(manifestBytes);
    assert.equal(manifest.registrationSha256, registrationHash);
    assert.equal(manifest.status, 'qualified-source-derived-component');
    assert.deepEqual(manifest.groups.map((group) => group.census), registration.expectedGroups);
    assert.equal(manifest.captures.length, registration.expectedGroups.length);
    return {manifest, manifestSha256: hash(manifestBytes)};
}

async function acquire() {
    assert(!existsSync(output), 'Never overwrite an acquisition');
    mkdirSync(output, {recursive: true});
    const identities = checkedSource();
    const priorRetainedTemporaryBytes = Number(process.env.MANABITAN_CANONICAL_PREEXISTING_BYTES);
    assert(Number.isSafeInteger(priorRetainedTemporaryBytes) && priorRetainedTemporaryBytes >= 0, 'Independent guard supplies retained byte count');
    const state = {schemaVersion: 1, status: 'incomplete', timingScope: 'Untimed source-derived acquisition with raw persistence substitute; not a browser memory capture',
        registrationSha256: registrationHash, harnessSha256: registration.harness.sha256, identities,
        priorRetainedTemporaryBytes, groups: [], captures: [], sourceGroups: [], parserWorkers: 0};
    save('capture-manifest.json', state);
    const {BlobReader, Uint8ArrayWriter, ZipReader} = await sourceImport('node_modules/@zip.js/zip.js/index.js');
    const parser = await sourceImport('ext/js/dictionary/term-bank-wasm-parser.js');
    const pipeline = await sourceImport('ext/js/dictionary/term-bank-source-pipeline.js');
    const native = await sourceImport('dev/dictionary-wasm.js');
    const {DictionaryDatabase} = await sourceImport('ext/js/dictionary/dictionary-database.js');
    const {NativeCanonicalScanner} = await sourceImport('ext/js/dictionary/term-content-canonical-scan.js');
    const {RAW_TERM_CONTENT_TOKEN_DICT_NAME} = await sourceImport('ext/js/dictionary/raw-term-content.js');
    const modules = native.loadDictionaryWasm(root);
    parser.setTermBankWasmModule(await WebAssembly.compile(modules.get('term-bank-parser.wasm')));
    const nativeModule = await WebAssembly.compile(baselineBytes);
    validateModule(nativeModule);
    const lockBytes = readFileSync(path.join(root, 'test/perf/dictionaries.lock.json'));
    assert.equal(hash(lockBytes), registration.fixture.lockSha256);
    const fixture = JSON.parse(lockBytes).dictionaries.jmdict;
    assert.equal(fixture.sha256, registration.fixture.sha256);
    assert.equal(statSync(registration.fixture.path).size, fixture.sizeBytes);
    await checkedFixture();
    const archive = await openAsBlob(registration.fixture.path);
    const terminations = [];
    const sourceByRequestId = new Map();
    class BrowserWorker extends EventTarget {
        constructor(url) {
            super();
            ++state.parserWorkers;
            this.worker = new ThreadWorker(pathToFileURL(path.join(root, 'test/fixtures/parser-settlement/worker-node.mjs')), {workerData: {url: url.href}});
            this.worker.on('message', (data) => this.dispatchEvent(new MessageEvent('message', {data})));
            this.worker.on('error', (error) => {
                const event = new Event('error');
                Object.defineProperty(event, 'message', {value: error.message});
                this.dispatchEvent(event);
            });
            this.worker.on('messageerror', () => this.dispatchEvent(new MessageEvent('messageerror')));
        }
        postMessage(data, transfer) {
            if (data.type === 'parse') {
                assert(Number.isInteger(data.id) && data.id >= 1 && data.id <= registration.expectedGroups.length);
                assert(!sourceByRequestId.has(data.id), 'Unique request identity within the single registered source run');
                const witness = {id: data.id, files: data.sourceMetadata?.map(({filename}) => filename) ?? null,
                    rawSourceBytes: data.sourceMetadata?.reduce((sum, item) => sum + item.uncompressedSize, 0) ?? null,
                    transferredBytes: data.sourceBuffers.reduce((sum, buffer) => sum + buffer.byteLength, 0)};
                sourceByRequestId.set(data.id, witness);
                state.sourceGroups.push(witness); // Preserve actual dispatch order separately.
            }
            this.worker.postMessage(data, transfer);
        }
        terminate() { terminations.push(this.worker.terminate()); }
    }
    globalThis.Worker = BrowserWorker;
    Object.defineProperty(globalThis, 'navigator', {configurable: true,
        value: {hardwareConcurrency: registration.parserPolicy.hardwareConcurrency, deviceMemory: registration.parserPolicy.deviceMemory}});
    const reader = new ZipReader(new BlobReader(archive));
    const entries = await reader.getEntries();
    const termFiles = entries.filter(({filename}) => /^term_bank_\d+\.json$/.test(filename))
        .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)));
    assert.equal(termFiles.length, registration.fixture.termBanks);
    const byName = new Map(termFiles.map((file) => [file.filename, file]));
    const rawReader = new pipeline.RawZipPayloadReader(archive);
    const sourcePipeline = new pipeline.TermBankSourcePipeline({termFiles, enabled: true,
        read: (file) => file.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true}),
        readCompressed: (file, signal) => rawReader.read(file, signal)});
    const db = new DictionaryDatabase();
    const rawPath = path.join(output, 'raw-content.bin');
    const rawFd = openSync(rawPath, 'wx+');
    let rawBytes = 0;
    let compressedBytes = 0;
    let activeGroup = null;
    let pendingCapture = null;
    function enforceDisk(nextBytes) {
        assert(priorRetainedTemporaryBytes + rawBytes + compressedBytes + nextBytes <= registration.limits.maxTemporaryBytes, 'Registered combined temporary byte limit');
    }
    db._bulkImportTransactionOpen = true;
    db._appendResolvedArtifactTermRecords = async () => {};
    db._persistArtifactTermContent = async (_dictionary, _content, _names, _uniform, spans) => {
        assert(activeGroup && spans);
        assert.equal(spans.buffer, activeGroup.chunk.contentBytesBuffer);
        const pendingOffsets = new Float64Array(spans.offsets.length);
        for (let i = 0; i < spans.offsets.length; ++i) {
            assert(spans.offsets[i] + spans.lengths[i] <= activeGroup.chunk.contentBytesBuffer.byteLength);
            pendingOffsets[i] = activeGroup.rawBase + spans.offsets[i];
        }
        return {pendingOffsets, pendingLengths: new Uint32Array(spans.lengths), pendingResolvedDictNames: RAW_TERM_CONTENT_TOKEN_DICT_NAME, blockProfile: null};
    };
    db._readTermEntryContentBytesDetailed = async (offset, length, dictName) => {
        assert.equal(dictName, RAW_TERM_CONTENT_TOKEN_DICT_NAME);
        assert(Number.isSafeInteger(offset) && offset >= 0 && offset + length <= rawBytes);
        const bytes = new Uint8Array(length);
        assert.equal(readSync(rawFd, bytes, 0, length, offset), length);
        return {status: 'ok', bytes};
    };
    db._readTermEntryContentBytesDetailedBatch = async (requests) => Promise.all(requests.map(
        ({contentOffset, contentLength, contentDictName}) => db._readTermEntryContentBytesDetailed(contentOffset, contentLength, contentDictName)));
    db._nativeCanonicalScanner = new NativeCanonicalScanner({loadModule: async () => nativeModule, hooks: {
        beforeNative({a, beforeDense, beforePending}) {
            assert(activeGroup && pendingCapture === null);
            assert(a.memory.buffer.byteLength <= registration.limits.maxArenaBytes, 'Registered native arena limit');
            const bytes = new Uint8Array(a.memory.buffer);
            const compressed = gzipSync(bytes, {level: 6});
            enforceDisk(compressed.byteLength);
            const capture = {index: state.captures.length, group: activeGroup.index, memoryBytes: bytes.byteLength,
                inputSha256: hash(bytes), compressedSha256: hash(compressed), compressedBytes: compressed.byteLength,
                config: [...new Uint32Array(bytes.buffer, 1088, 22)], beforeDense, beforePending,
                file: 'native-' + String(state.captures.length).padStart(3, '0') + '.bin.gz'};
            writeFileSync(path.join(output, capture.file), compressed, {flag: 'wx'});
            compressedBytes += compressed.byteLength;
            state.captures.push(capture);
            pendingCapture = capture;
            save('capture-manifest.json', state);
        },
        beforeOutputView({header, a, column}) {
            if (column !== 0) { return; }
            assert(pendingCapture);
            pendingCapture.header = [...header];
            pendingCapture.outputSha256 = semanticHash(a.memory);
            // This corpus has fewer than4096 exact candidates per group. The
            // checked baseline kernel returns0 after reaching its final cursor.
            assert(header[3] < CANONICAL_SCAN_EXACT_BATCH_SIZE);
            assert.equal(header[1], pendingCapture.config[14] - pendingCapture.config[13]);
            pendingCapture.expectedReturn = 0;
            pendingCapture = null;
            save('capture-manifest.json', state);
        },
    }});
    let processedRows = 0;
    async function consume(chunk, progress) {
        const index = state.groups.length;
        assert(index < registration.expectedGroups.length);
        assert.equal(progress.chunkIndex, index + 1);
        assert.equal(progress.chunkCount, registration.expectedGroups.length);
        assert(chunk.contentDedupPlan && chunk.contentBytesBuffer);
        assert.equal(chunk.mediaRows?.length ?? 0, 0);
        assert.equal(typeof chunk.releaseBorrowedContent, 'undefined');
        const beforeCalls = state.captures.length;
        enforceDisk(chunk.contentBytesBuffer.byteLength);
        const rawBase = rawBytes;
        assert.equal(writeSync(rawFd, chunk.contentBytesBuffer, 0, chunk.contentBytesBuffer.byteLength, rawBase), chunk.contentBytesBuffer.byteLength);
        rawBytes += chunk.contentBytesBuffer.byteLength;
        const materialized = {...chunk, dictionary: fixture.expectedTitle, dictionaryTotalRows: progress.totalRows,
            contentDictNameList: null, uniformContentDictName: RAW_TERM_CONTENT_TOKEN_DICT_NAME};
        activeGroup = {index, rawBase, chunk: materialized};
        await db._bulkAddArtifactTermsChunkWithContentDedup(materialized);
        const captures = state.captures.slice(beforeCalls);
        const metrics = {...db._lastBulkAddTermsMetrics};
        const source = sourceByRequestId.get(progress.chunkIndex);
        assert(source && source.files?.length > 0);
        const sourceBytes = source.files.reduce((sum, name) => sum + byName.get(name).uncompressedSize, 0);
        const census = {group: index, rowCount: chunk.rowCount, uniqueCount: chunk.contentDedupPlan.uniqueCount,
            pendingContentCount: metrics.dedupUniqueCount, sourceBytes, ownedContentBytes: chunk.contentBytesBuffer.byteLength};
        assert.deepEqual(census, registration.expectedGroups[index], 'Hosted baseline per-group census');
        assert.equal(metrics.dedupNativeFallbackCount ?? 0, 0);
        assert.equal(captures.length, 1, 'Registered corpus native call count');
        assert.equal(captures[0].header[2], census.pendingContentCount);
        assert.equal(captures[0].header[3], metrics.dedupPersistedHitCount);
        state.groups.push({census, dictionaryTotalRows: progress.totalRows, sourceFiles: source.files,
            nativeCalls: captures.length, nativePendingRows: captures[0].header[2], exactMatches: metrics.dedupPersistedHitCount,
            recentSourceHits: metrics.dedupRecentSourceHitCount, rawBase});
        processedRows += chunk.rowCount;
        activeGroup = null;
        save('capture-manifest.json', state);
        process.stdout.write(JSON.stringify({event: 'acquired-group', group: index, rows: processedRows, rawBytes, compressedBytes}) + '\n');
    }
    try {
        const options = {...registration.parserPolicy.options};
        let sourceRuns = 0;
        for (let start = 0; start < termFiles.length;) {
            assert.equal(++sourceRuns, 1, 'This locked workload uses one import-wide source run; request IDs cannot cross batches');
            const compressed = sourcePipeline.createCompressedImportRunPlan(start);
            assert(compressed !== null, 'Locked JMdict must follow the actual compressed lazy source path');
            assert.deepEqual(compressed.files.map(({filename}) => filename), termFiles.map(({filename}) => filename));
            assert.equal(await parser.parseTermBankWithWasmColumnChunksParallelCompressedLazy(
                compressed.loaders, compressed.estimatedByteLengths, fixture.format ?? 3, consume, options), true);
            sourcePipeline.releaseBatch(compressed.files);
            start += compressed.files.length;
        }
        assert.equal(processedRows, registration.fixture.termRows);
        assert.equal(state.parserWorkers, registration.parserPolicy.workerCount);
        assert.equal(state.groups.length, registration.expectedGroups.length);
        assert.equal(sourceByRequestId.size, registration.expectedGroups.length);
        assert.deepEqual(state.groups.flatMap(({sourceFiles}) => sourceFiles), termFiles.map(({filename}) => filename),
            'All53 term banks appear once, in original source order');
        assert.equal(state.groups.reduce((sum, x) => sum + x.exactMatches, 0), registration.fixture.exactMatches);
        assert.equal(db._nativeCanonicalScanner.stats.fallbacks, 0);
        state.nativeStats = {...db._nativeCanonicalScanner.stats};
        state.rawBytes = rawBytes;
        state.compressedBytes = compressedBytes;
        state.status = 'captured-awaiting-final-identity-verification';
    } finally {
        await sourcePipeline.dispose();
        await parser.disposeParallelTermBankParser();
        await Promise.all(terminations);
        await reader.close();
        closeSync(rawFd);
        save('capture-manifest.json', state);
    }
    if (state.status === 'captured-awaiting-final-identity-verification') {
        state.finalIdentities = checkedSource();
        state.finalFixtureIdentity = await checkedFixture();
        unlinkSync(rawPath);
        state.rawSourceFileRemovedAfterVerifiedAcquisition = true;
        state.status = 'qualified-source-derived-component';
        state.resourceQualificationRequiresIndependentWatchdog = true;
        save('capture-manifest.json', state);
    }
}

async function firstUse(armName) {
    const {manifest, manifestSha256} = loadManifest();
    assert(['A', 'B', 'C'].includes(armName));
    const block = Number(firstUseBlock);
    assert(Number.isInteger(block) && block >= 0 && block < registration.schedule.firstUseOrders.length);
    const capture = manifest.captures[0];
    const input = restoreCapture(capture);
    const memory = new WebAssembly.Memory({initial: input.byteLength /65536, maximum: input.byteLength /65536});
    new Uint8Array(memory.buffer).set(input);
    const observation = {arm: armName, block, manifestSha256, compileMs: null, instantiateMs: null, kernelMs: null,
        scope: 'Fresh Node process, first module compile/instance and first scan_canonical invocation; ABI exports run before its clock; OS caches uncontrolled', verified: false};
    try {
        let module;
        const t0 = performance.now();
        try { module = await WebAssembly.compile(armBytes[armName]); }
        finally { observation.compileMs = performance.now() - t0; }
        validateModule(module);
        let instance;
        const t1 = performance.now();
        try { instance = new WebAssembly.Instance(module, {env: {memory}}); }
        finally { observation.instantiateMs = performance.now() - t1; }
        assert.equal(instance.exports.canonical_abi_version(), 1);
        assert.equal(instance.exports.canonical_layout_end(), layout.usedBytes);
        const arm = {memory, run: instance.exports.scan_canonical};
        let returned;
        const t2 = performance.now();
        try { returned = arm.run(); }
        finally { observation.kernelMs = performance.now() - t2; }
        observation.returned = returned;
        verifyCall(capture, arm, returned);
        observation.verified = true;
    } catch (error) {
        observation.exception = error.message;
        throw error;
    } finally {
        append('first-use-observations.jsonl', observation);
    }
    process.stdout.write(JSON.stringify(observation) + '\n');
}

async function replay() {
    const identities = checkedSource();
    const {manifest, manifestSha256} = loadManifest();
    for (const name of ['replay-registration.json', 'first-use-observations.jsonl', 'observations.jsonl', 'blocks.jsonl', 'replay-analysis.json']) {
        assert(!existsSync(path.join(output, name)), 'Never overwrite or append to a previous timing attempt: ' + name);
    }
    writeFileSync(path.join(output, 'replay-registration.json'), json({registrationSha256: registrationHash, harnessSha256: registration.harness.sha256,
        manifestSha256, identities, schedule: registration.schedule, stage3Authorized: false}), {flag: 'wx'});
    const firstUseObservations = [];
    for (const [index, order] of registration.schedule.firstUseOrders.entries()) {
        for (const arm of order) {
            const result = JSON.parse(execFileSync(process.execPath, [ownPath, 'first-use', registrationPath, registrationHash, output, arm, String(index)],
                {encoding: 'utf8', timeout: 30000, env: {...process.env, NODE_DISABLE_COMPILE_CACHE: '1'}}).trim());
            assert.equal(result.manifestSha256, manifestSha256);
            assert.equal(result.block, index);
            assert.equal(result.arm, arm);
            firstUseObservations.push(result);
        }
    }
    const modules = {};
    for (const arm of ['A', 'B', 'C']) {
        modules[arm] = await WebAssembly.compile(armBytes[arm]);
        validateModule(modules[arm]);
    }
    const geometries = new Map();
    const blocks = [];
    const schedule = [
        ...registration.schedule.warmupOrders.map((order) => ({order, warmup: true})),
        ...registration.schedule.measuredOrders.map((order) => ({order, warmup: false})),
    ];
    for (const [index, item] of schedule.entries()) {
        const block = {index, ...item, totalsMs: {A: 0, B: 0, C: 0}, calls: 0};
        for (const capture of manifest.captures) {
            let arms = geometries.get(capture.memoryBytes);
            if (!arms) {
                const pages = capture.memoryBytes /65536;
                const memory = new WebAssembly.Memory({initial: pages, maximum: pages});
                arms = Object.fromEntries(['A', 'B', 'C'].map((name) => [name, makeInstance(modules[name], memory)]));
                geometries.set(capture.memoryBytes, arms);
            }
            const input = restoreCapture(capture);
            for (const name of item.order) {
                const arm = arms[name];
                new Uint8Array(arm.memory.buffer).set(input);
                let returned;
                let failure;
                const start = performance.now();
                try { returned = arm.run(); } catch (error) { failure = error; }
                const elapsedMs = performance.now() - start;
                const observation = {block: index, warmup: item.warmup, order: item.order, capture: capture.index,
                    arm: name, elapsedMs, returned, exception: failure?.message, verified: false};
                try {
                    if (failure) { throw failure; }
                    verifyCall(capture, arm, returned);
                    observation.verified = true;
                } finally { append('observations.jsonl', observation); }
                block.totalsMs[name] += elapsedMs;
                ++block.calls;
            }
        }
        blocks.push(block);
        append('blocks.jsonl', block);
        process.stdout.write(JSON.stringify({event: 'completed-block', ...block}) + '\n');
    }
    const measured = blocks.filter((x) => !x.warmup);
    assert.equal(measured.length, 12);
    const comparisons = {};
    for (const control of ['A', 'C']) {
        const savings = measured.map((x) => x.totalsMs[control] - x.totalsMs.B);
        const changes = measured.map((x) => 100 * (x.totalsMs.B / x.totalsMs[control] - 1));
        comparisons[control] = {medianSavingsMs: median(savings), medianPairedChangePercent: median(changes),
            fasterBlocks: savings.filter((x) => x > 0).length, savingsMs: savings, changesPercent: changes};
    }
    const controlSavings = measured.map((x) => x.totalsMs.A - x.totalsMs.C);
    const controlChanges = measured.map((x) => 100 * (x.totalsMs.C / x.totalsMs.A - 1));
    const control = {medianSavingsMs: median(controlSavings), medianPairedChangePercent: median(controlChanges),
        savingsMs: controlSavings, changesPercent: controlChanges};
    const minimumSavings = Math.min(comparisons.A.medianSavingsMs, comparisons.C.medianSavingsMs);
    const minimumPercent = Math.min(-comparisons.A.medianPairedChangePercent, -comparisons.C.medianPairedChangePercent);
    const gate = ['A', 'C'].every((arm) => comparisons[arm].medianSavingsMs >= 10 &&
        comparisons[arm].medianPairedChangePercent <= -10 && comparisons[arm].fasterBlocks >= 10) &&
        Math.abs(control.medianSavingsMs) < minimumSavings /2 && Math.abs(control.medianPairedChangePercent) < minimumPercent /2;
    const finalIdentities = checkedSource();
    assert.equal(hash(readFileSync(path.join(output, 'capture-manifest.json'))), manifestSha256, 'Capture manifest remains frozen');
    save('replay-analysis.json', {schemaVersion: 1, status: 'complete', registrationSha256: registrationHash, manifestSha256, finalIdentities,
        timingScope: 'Warm Node native export only; reset, decompression, checks and hashing excluded; blocks aggregate each real captured call',
        warmCondition: 'Modules reused across the fixed cohort; optimized code may be shared by identical A/C bytes',
        firstUseObservations, blocks, medianCorpusKernelMs: Object.fromEntries(['A', 'B', 'C'].map((name) => [name, median(measured.map((x) => x.totalsMs[name]))])),
        candidateVsControl: comparisons, identicalCodeControl: control, passesRegisteredContinuationGate: gate,
        stage3Authorized: false, fullImportGainClaim: false, resourceQualificationRequiresIndependentWatchdog: true});
}
try {
    if (mode === 'acquire') { await acquire(); }
    else if (mode === 'first-use') { await firstUse(extra); }
    else if (mode === 'replay') { await replay(); }
    else { throw new Error('Expected acquire, first-use, or replay'); }
} catch (error) {
    if (existsSync(output)) {
        append('failures.jsonl', {mode, arm: mode === 'first-use' ? extra : undefined, message: error.message, stack: error.stack, registrationSha256: registrationHash});
    }
    throw error;
}
