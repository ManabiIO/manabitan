import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createReadStream, openAsBlob} from 'node:fs';
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {Worker as ThreadWorker} from 'node:worker_threads';
import {gunzipSync} from 'node:zlib';

const [mode, baseArgument, candidateArgument, fixtureArgument, outputArgument] = process.argv.slice(2);
assert(['freeze', 'capture', 'run'].includes(mode));
assert(baseArgument && candidateArgument && fixtureArgument && outputArgument);
const baseRoot = resolve(baseArgument);
const candidateRoot = resolve(candidateArgument);
const fixtureRoot = resolve(fixtureArgument);
const outputPath = resolve(outputArgument);
const ownRoot = dirname(fileURLToPath(import.meta.url));
const frozenPath = join(ownRoot, 'frozen-inputs.json');
const BASE = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2';
const PARSER = 'ext/js/dictionary/term-bank-wasm-parser.js';
const WORKER = 'ext/js/dictionary/term-bank-wasm-parser-worker.js';
const WASM = 'ext/lib/term-bank-parser.wasm';
const CENSUS = resolve(ownRoot, '../reserved-envelope/vndb-dense/manifest.json');
const EXPECTED = {
    baselineParser: '31854cfb3d20ba60b701ec31cf19de26bd55cc745cc4f998cb33f0554ec83cca',
    candidateParser: '69f6f44bb25b1ade2e77ad51a5c830ac359ec3d44f364a3c0ed6131728f54518',
    baselineWorker: '47f1d827d94f4c5aac639bf2dceff33f483e969447ca77bd1ae24c1eb014eef1',
    candidateWorker: 'b368f85dc737f4cd2567fa1723e69f3276f6f8c0441085af3b94ac80ed2a0057',
    wasm: '8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee',
    lock: '60aa981791f3b60ca17588212aea5bd3536fb8f59288855e5accd019c6e4cf89',
    census: '1edb466e299e8e8532cf3991beab83383112e64df1288366f63fdfea9d4ea64b',
};
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const importLocal = (path) => import(pathToFileURL(join(baseRoot, path)));
const git = (args) => execFileSync('git', args, {cwd: baseRoot, maxBuffer: 4 * 1024 * 1024});
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const schedule = [['A', 'B', 'C'], ['C', 'B', 'A'], ['B', 'C', 'A'], ['A', 'C', 'B'], ['C', 'A', 'B'], ['B', 'A', 'C']];
const repetitions = 8;
const trackedInputs = [
    [join(baseRoot, PARSER), EXPECTED.baselineParser], [join(baseRoot, WORKER), EXPECTED.baselineWorker],
    [join(candidateRoot, PARSER), EXPECTED.candidateParser], [join(candidateRoot, WORKER), EXPECTED.candidateWorker],
    [join(baseRoot, WASM), EXPECTED.wasm], [join(baseRoot, 'test/perf/dictionaries.lock.json'), EXPECTED.lock],
    [CENSUS, EXPECTED.census],
];
async function verifyBase() {
    assert.equal(git(['rev-parse', 'HEAD']).toString().trim(), BASE);
    git(['diff', '--exit-code', BASE, '--', 'ext/js', 'package-lock.json', 'test/perf/dictionaries.lock.json', 'test/fixtures/parser-settlement/worker-node.mjs']);
    for (const [path, expected] of trackedInputs) assert.equal(sha(await readFile(path)), expected, path);
}
async function fileIdentity(path) { const bytes = await readFile(path); return {path, bytes: bytes.length, sha256: sha(bytes)}; }
async function writeOrVerify(path, bytes) {
    try { await writeFile(path, bytes, {flag: 'wx'}); }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        assert.equal(await readFile(path, 'utf8'), bytes, path);
    }
}
const scriptPaths = [import.meta.filename, join(ownRoot, 'capture-worker.mjs'), join(ownRoot, 'benchmark-plan.md')];
if (mode === 'freeze') {
    await verifyBase();
    const baseline = await readFile(join(baseRoot, PARSER), 'utf8');
    const candidate = await readFile(join(candidateRoot, PARSER), 'utf8');
    const worker = await readFile(join(baseRoot, WORKER), 'utf8');
    const probes = {};
    for (const arm of ['A', 'B', 'C']) {
        const path = join(baseRoot, 'ext/js/dictionary/path-projection-probe-7c02-' + arm + '.js');
        const source = (arm === 'B' ? candidate : baseline) + '\nexport {' +
            (arm === 'B' ? 'projectWorkerGlossaryImagePaths as projectBatchForExperiment' : 'tryProjectNativeGlossaryImagePath as projectOneForExperiment') + '};\n';
        await writeOrVerify(path, source);
        probes[arm] = await fileIdentity(path);
    }
    const copyLine = '                resultChunk = copyWasmBackedColumnChunk(chunk, shareContentBytes, options.projectImagePaths === true, options.prepareLookupRoute === true, preloadedSource);';
    assert.equal(worker.split(copyLine).length, 2);
    const observer = worker.replace(copyLine, copyLine + '\n                globalThis.__capturePathFixture(chunk, preloadedSource, data, resultChunk);');
    const observerPath = join(baseRoot, 'ext/js/dictionary/path-capture-observer-7c02.js');
    await writeOrVerify(observerPath, observer);
    const frozen = {
        schemaVersion: 1, frozenAt: new Date().toISOString(), baseCommit: BASE, baseRoot, candidateRoot,
        trackedInputs: await Promise.all(trackedInputs.map(([path]) => fileIdentity(path))),
        scripts: await Promise.all(scriptPaths.map(fileIdentity)), probes,
        observer: await fileIdentity(observerPath),
        baselineAdapter: 'rows.map(({row}) => row.termEntryContentBytes.length > 0 ? projectOneForExperiment(row, source) : null)',
        schedule, repetitions, excludedWarmupObservationsPerArmGroup: 2,
    };
    await writeFile(frozenPath, JSON.stringify(frozen, null, 2) + '\n', {flag: 'wx'});
    assert.equal(outputPath, frozenPath);
    console.log(JSON.stringify({mode, complete: true, frozenPath, frozenSha256: sha(await readFile(frozenPath)), scripts: frozen.scripts}));
} else {
    const frozenBytes = await readFile(frozenPath);
    const frozen = JSON.parse(frozenBytes);
    async function verifyFrozen() {
        await verifyBase();
        assert.equal(sha(await readFile(frozenPath)), sha(frozenBytes));
        for (const input of [...frozen.trackedInputs, ...frozen.scripts, ...Object.values(frozen.probes), frozen.observer]) {
            assert.equal(sha(await readFile(input.path)), input.sha256, input.path);
        }
    }
    const report = {
        schemaVersion: 1, mode, complete: false, startedAt: new Date().toISOString(), node: process.version,
        baseCommit: BASE, frozenInputsSha256: sha(frozenBytes), sourceIdentity: frozen,
        failures: [], observations: [],
    };
    await mkdir(dirname(outputPath), {recursive: true});
    await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
    const save = () => writeFile(outputPath, JSON.stringify(report, null, 2) + '\n');
    try {
        await verifyFrozen();
        if (mode === 'capture') {
            await mkdir(fixtureRoot, {recursive: true});
            assert.equal((await readdir(fixtureRoot)).filter((name) => name.endsWith('.json.gz')).length, 0);
            const lock = await json(join(baseRoot, 'test/perf/dictionaries.lock.json'));
            const spec = lock.dictionaries.vndb;
            const archivePath = join(baseRoot, 'builds/e2e-dictionary-cache', spec.cacheFile);
            const archiveHash = createHash('sha256');
            for await (const bytes of createReadStream(archivePath)) archiveHash.update(bytes);
            assert.equal(archiveHash.digest('hex'), spec.sha256);
            const archive = await openAsBlob(archivePath);
            assert.equal(archive.size, spec.sizeBytes);
            const parser = await importLocal(PARSER);
            parser.setTermBankWasmModule(await WebAssembly.compile(await readFile(join(baseRoot, WASM))));
            const pipelineModule = await importLocal('ext/js/dictionary/term-bank-source-pipeline.js');
            const {readDenseZipFileMap} = await importLocal('ext/js/dictionary/dense-zip-directory.js');
            const {Uint8ArrayWriter} = await importLocal('node_modules/@zip.js/zip.js/index.js');
            const terminations = [];
            const sourceGroups = [];
            class BrowserWorker extends EventTarget {
                constructor(url) {
                    super();
                    assert.equal(url.href, pathToFileURL(join(baseRoot, WORKER)).href);
                    this.worker = new ThreadWorker(pathToFileURL(join(ownRoot, 'capture-worker.mjs')), {
                        workerData: {url: pathToFileURL(frozen.observer.path).href,
                            baselineProbe: pathToFileURL(frozen.probes.A.path).href, fixtureRoot},
                    });
                    this.worker.on('message', (data) => this.dispatchEvent(new MessageEvent('message', {data})));
                    this.worker.on('error', (error) => {
                        const event = new Event('error');
                        Object.defineProperty(event, 'message', {value: error.message});
                        this.dispatchEvent(event);
                    });
                    this.worker.on('messageerror', () => this.dispatchEvent(new MessageEvent('messageerror')));
                }
                postMessage(data, transfer) {
                    if (data.type === 'parse') sourceGroups.push({id: data.id, files: data.sourceMetadata?.map(({filename}) => filename) ?? null,
                        bytes: data.sourceBuffers.map((buffer) => buffer.byteLength)});
                    this.worker.postMessage(data, transfer);
                }
                terminate() { terminations.push(this.worker.terminate()); }
            }
            globalThis.Worker = BrowserWorker;
            Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {hardwareConcurrency: 4, deviceMemory: 8}});
            const rawReader = new pipelineModule.RawZipPayloadReader(archive);
            let fallbackReads = 0;
            async function getData(writer, options = {}) {
                assert(writer instanceof Uint8ArrayWriter);
                ++fallbackReads;
                const signal = options.signal ?? new AbortController().signal;
                const bytes = await rawReader.read(this, signal);
                const decoded = await parser.inflateCompressedZipMediaBatchWasm([{...this, bytes}]);
                signal.throwIfAborted();
                return decoded.sources[0];
            }
            const fileMap = await readDenseZipFileMap(archive, getData);
            assert(fileMap !== null);
            const termFiles = [...fileMap.keys()].filter((name) => /^term_bank_\d+\.json$/.test(name))
                .sort((a, b) => Number(a.slice(10, -5)) - Number(b.slice(10, -5))).map((name) => fileMap.get(name));
            const pipeline = new pipelineModule.TermBankSourcePipeline({termFiles, enabled: true,
                read: async (file) => await file.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true}),
                readCompressed: async (file, signal) => await rawReader.read(file, signal)});
            const options = {emitTermByteLists: false, computeContentHashes: true, emitContentSlab: true,
                emitTokenBinaryContent: true, mediaHintFastScan: true, projectImagePaths: true,
                validateGlossaryTypes: true, prepareLookupIndexes: true, maxPendingChunks: 2};
            report.fixture = spec;
            report.options = options;
            report.catalogEntries = fileMap.size;
            report.sourceGroups = sourceGroups;
            report.rows = 0;
            report.copiedMediaRows = 0;
            const consume = (chunk) => {
                report.rows += chunk.rowCount;
                report.copiedMediaRows += chunk.mediaRows.length;
                if (report.rows % 400000 === 0) process.stderr.write('Captured ' + report.rows + '/' + spec.termRows + ' source rows\n');
            };
            try {
                for (let start = 0; start < termFiles.length;) {
                    const plan = pipeline.createCompressedImportRunPlan(start);
                    if (plan !== null) {
                        assert.equal(await parser.parseTermBankWithWasmColumnChunksParallelCompressedLazy(plan.loaders, plan.estimatedByteLengths, 3, consume, options), true);
                        pipeline.releaseBatch(plan.files);
                        start += plan.files.length;
                    } else {
                        const files = pipeline.getBatch(start);
                        const batch = await pipeline.readBatch(files);
                        if (batch?.promises) assert.equal(await parser.parseTermBankWithWasmColumnChunksParallelDeferred(batch.promises, batch.estimatedByteLengths, 3, consume, options), true);
                        else await parser.parseTermBankWithWasmColumnChunks(batch, 3, consume, 2048, {...options, singleChunk: true});
                        pipeline.releaseBatch(files);
                        start += files.length;
                    }
                }
                assert.equal(report.rows, spec.termRows);
            } finally {
                await pipeline.dispose();
                await parser.disposeParallelTermBankParser();
                await Promise.all(terminations);
                fileMap.clear();
                report.fallbackReads = fallbackReads;
                await save();
            }
            const census = await json(CENSUS);
            const key = (x) => Number(x.files[0].slice(10, -5));
            const sorted = (groups) => [...groups].sort((a, b) => key(a) - key(b));
            assert.deepEqual(sorted(sourceGroups).map(({files, bytes}) => ({files, bytes})), sorted(census.sourceGroups).map(({files, bytes}) => ({files, bytes})));
            const names = (await readdir(fixtureRoot)).filter((name) => /^group-\d+\.json\.gz$/.test(name)).sort();
            assert.equal(names.length, sourceGroups.length);
            const groups = [];
            const totals = {};
            const uniquePaths = new Set();
            for (const name of names) {
                const compressed = await readFile(join(fixtureRoot, name));
                const decoded = gunzipSync(compressed);
                const group = JSON.parse(decoded);
                const source = sourceGroups.find((x) => x.id === group.id);
                assert(source);
                assert.deepEqual(group.files, source.files);
                assert.equal(group.rows.length, group.counts.mediaRows);
                assert.equal(group.nativeOutputSha256, sha(JSON.stringify(group.expectedNative)));
                assert.equal(group.copiedOutputSha256, sha(JSON.stringify(group.expectedCopied)));
                for (const paths of group.expectedCopied) for (const path of paths ?? []) uniquePaths.add(path);
                for (const [counter, value] of Object.entries(group.counts)) totals[counter] = (totals[counter] ?? 0) + value;
                groups.push({name, groupKey: group.groupKey, id: group.id, files: group.files,
                    sourceRows: group.sourceRows, counts: group.counts, compressedBytes: compressed.length,
                    uncompressedBytes: decoded.length, compressedSha256: sha(compressed), uncompressedSha256: sha(decoded),
                    rawSpanSha256: group.rawSpanSha256, nativeOutputSha256: group.nativeOutputSha256, copiedOutputSha256: group.copiedOutputSha256});
            }
            assert.equal(totals.sourceRows, spec.termRows);
            assert.equal(totals.mediaRows, report.copiedMediaRows);
            assert.equal(uniquePaths.size, spec.mediaFiles);
            report.groups = groups;
            report.totals = totals;
            report.uniqueMediaPaths = uniquePaths.size;
            report.exactPlannerGroupsMatch = true;
            report.scope = 'Complete current planner/worker path fixture, before source reuse. Test hook runs after unchanged result copy. No timing, full chunk-column storage, browser import or memory claim.';
        } else {
            assert.equal(typeof global.gc, 'function', 'Run with --expose-gc');
            const manifestPath = join(fixtureRoot, 'manifest.json');
            const manifestBytes = await readFile(manifestPath);
            const manifest = JSON.parse(manifestBytes);
            assert(manifest.complete && manifest.exactPlannerGroupsMatch);
            assert.equal(manifest.frozenInputsSha256, sha(frozenBytes));
            assert.equal(manifest.rows, 6648310);
            const instance = await WebAssembly.instantiate(await WebAssembly.compile(await readFile(join(baseRoot, WASM))));
            const wasm = instance.exports;
            const arms = {};
            for (const arm of ['A', 'B', 'C']) {
                const module = await import(pathToFileURL(frozen.probes[arm].path));
                const projectOne = module.projectOneForExperiment;
                arms[arm] = arm === 'B' ? module.projectBatchForExperiment :
                    (rows, source) => rows.map(({row}) => row.termEntryContentBytes.length > 0 ? projectOne(row, source) : null);
            }
            report.fixtureManifestSha256 = sha(manifestBytes);
            report.fixtureTotals = manifest.totals;
            report.schedule = schedule;
            report.repetitions = repetitions;
            report.scope = 'Sum of bounded path-projection call intervals over every actual source group. Group restoration, source parsing, ZIP/media I/O and full-copy work are excluded. No whole-import or peak-memory claim.';
            const empty = new Uint8Array(0);
            const nonempty = new Uint8Array(1);
            let consumed = 0;
            let retainedResult;
            const normalize = (value) => value === null ? [] : value;
            const consume = (value) => {
                retainedResult = value;
                const length = value === null ? 0 : value.length;
                consumed = (consumed + length + (value?.[0]?.[0]?.length ?? 0) + (value?.[length - 1]?.[0]?.length ?? 0)) >>> 0;
            };
            for (const record of manifest.groups) {
                const file = join(fixtureRoot, record.name);
                const compressed = await readFile(file);
                assert.equal(sha(compressed), record.compressedSha256);
                const decoded = gunzipSync(compressed);
                assert.equal(sha(decoded), record.uncompressedSha256);
                const group = JSON.parse(decoded);
                assert.equal(group.rows.length, group.expectedNative.length);
                const inputRows = group.rows.map(([index, contentLength, glossaryJson, absoluteOffset, base64, backing]) => ({
                    index, contentLength, glossaryJson, absoluteOffset, backing,
                    bytes: base64 === null ? null : new Uint8Array(Buffer.from(base64, 'base64')),
                }));
                const nativeRows = inputRows.filter((row) => row.backing === 'wasm').sort((a, b) => a.absoluteOffset - b.absoluteOffset);
                const maximumEnd = Math.max(group.jsonPtr + group.jsonLength, ...nativeRows.map((row) => row.absoluteOffset + row.bytes.length));
                wasm.wasm_reset_heap();
                const heapBase = wasm.wasm_alloc(0);
                assert(group.jsonPtr >= heapBase);
                assert(wasm.wasm_alloc(maximumEnd - heapBase + 64) > 0);
                const memory = wasm.memory.buffer;
                assert.equal(memory instanceof SharedArrayBuffer, group.sourceShared);
                new Uint8Array(memory, group.jsonPtr, group.jsonLength).fill(0);
                let previousEnd = 0;
                for (const row of nativeRows) {
                    assert(row.absoluteOffset >= heapBase);
                    const overlap = Math.max(0, Math.min(previousEnd, row.absoluteOffset + row.bytes.length) - row.absoluteOffset);
                    if (overlap > 0) assert.deepEqual(new Uint8Array(memory, row.absoluteOffset, overlap), row.bytes.subarray(0, overlap));
                    new Uint8Array(memory, row.absoluteOffset, row.bytes.length).set(row.bytes);
                    previousEnd = Math.max(previousEnd, row.absoluteOffset + row.bytes.length);
                }
                const mediaRows = inputRows.map((input) => {
                    let bytes;
                    if (input.backing === 'wasm') bytes = new Uint8Array(memory, input.absoluteOffset, input.bytes.length);
                    else if (input.backing === 'shared') { bytes = new Uint8Array(new SharedArrayBuffer(input.bytes.length)); bytes.set(input.bytes); }
                    else if (input.backing === 'private') bytes = input.bytes;
                    return {index: input.index, row: {glossaryJson: input.glossaryJson, glossaryJsonBytes: bytes,
                        termEntryContentBytes: input.contentLength > 0 ? nonempty : empty}};
                });
                const source = {wasm, jsonPtr: group.jsonPtr, jsonLength: group.jsonLength};
                const heapEnd = wasm.wasm_alloc(0);
                const oracle = () => {
                    assert.equal(wasm.memory.buffer, memory);
                    assert.equal(wasm.wasm_alloc(0), heapEnd);
                    for (let i = 0; i < inputRows.length; ++i) {
                        const actual = mediaRows[i].row.glossaryJsonBytes;
                        if (actual instanceof Uint8Array) assert.equal(sha(actual), sha(inputRows[i].bytes));
                    }
                    for (const arm of ['A', 'B', 'C']) assert.deepEqual(normalize(arms[arm](mediaRows, source)), group.expectedNative);
                    assert.equal(sha(JSON.stringify(group.expectedNative)), record.nativeOutputSha256);
                };
                oracle();
                for (const arm of ['A', 'B', 'C']) for (let warmup = 0; warmup < 2; ++warmup) {
                    global.gc();
                    for (let repeat = 0; repeat < repetitions; ++repeat) consume(arms[arm](mediaRows, source));
                }
                for (let block = 0; block < schedule.length; ++block) {
                    for (let position = 0; position < 3; ++position) {
                        const arm = schedule[block][position];
                        try {
                            global.gc();
                            const threadBefore = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : null;
                            const cpuBefore = process.cpuUsage();
                            const wallBefore = performance.now();
                            for (let repeat = 0; repeat < repetitions; ++repeat) consume(arms[arm](mediaRows, source));
                            const wallMs = performance.now() - wallBefore;
                            const cpu = process.cpuUsage(cpuBefore);
                            const thread = threadBefore === null ? null : process.threadCpuUsage(threadBefore);
                            report.observations.push({group: group.groupKey, mediaRows: mediaRows.length, block, position, arm, repetitions,
                                cpuMs: (cpu.user + cpu.system) / 1000, wallMs,
                                threadCpuMs: thread === null ? null : (thread.user + thread.system) / 1000});
                        } catch (error) { report.failures.push({group: group.groupKey, block, position, arm, error: String(error?.stack ?? error)}); }
                    }
                }
                oracle();
                assert.equal(sha(await readFile(file)), record.compressedSha256);
                retainedResult = null;
                await save();
                if (group.groupKey % 40 === 1) process.stderr.write('Measured source group beginning at bank ' + group.groupKey + '\n');
            }
            report.consumed = consumed;
            void retainedResult;
            assert.equal(sha(await readFile(manifestPath)), sha(manifestBytes));
            for (const record of manifest.groups) assert.equal(sha(await readFile(join(fixtureRoot, record.name))), record.compressedSha256);
            report.aggregateObservations = schedule.flatMap((order, block) => order.map((arm) => {
                const observations = report.observations.filter((x) => x.block === block && x.arm === arm);
                return {block, arm, groups: observations.length, repetitions,
                    cpuMs: observations.reduce((n, x) => n + x.cpuMs, 0), wallMs: observations.reduce((n, x) => n + x.wallMs, 0),
                    threadCpuMs: observations.some((x) => x.threadCpuMs === null) ? null : observations.reduce((n, x) => n + x.threadCpuMs, 0)};
            }));
            const median = (values) => { const x = [...values].sort((a, b) => a - b); return (x[2] + x[3]) / 2; };
            report.comparisons = {};
            for (const [candidateArm, controlArm] of [['B', 'A'], ['B', 'C'], ['C', 'A']]) {
                const pairs = schedule.map((_, block) => {
                    const a = report.aggregateObservations.find((x) => x.block === block && x.arm === controlArm);
                    const b = report.aggregateObservations.find((x) => x.block === block && x.arm === candidateArm);
                    return {block, control: a, candidate: b, cpuChangePercent: 100 * (b.cpuMs / a.cpuMs - 1),
                        wallChangePercent: 100 * (b.wallMs / a.wallMs - 1), cpuSavedPerCorpusMs: (a.cpuMs - b.cpuMs) / repetitions,
                        wallSavedPerCorpusMs: (a.wallMs - b.wallMs) / repetitions};
                });
                report.comparisons[candidateArm + '/' + controlArm] = {pairs,
                    cpuMedianPercent: median(pairs.map((x) => x.cpuChangePercent)), wallMedianPercent: median(pairs.map((x) => x.wallChangePercent)),
                    cpuMedianSavedPerCorpusMs: median(pairs.map((x) => x.cpuSavedPerCorpusMs)), wallMedianSavedPerCorpusMs: median(pairs.map((x) => x.wallSavedPerCorpusMs)),
                    cpuFasterPairs: pairs.filter((x) => x.cpuChangePercent < 0).length, wallFasterPairs: pairs.filter((x) => x.wallChangePercent < 0).length};
            }
            const pairs = report.comparisons;
            const checks = {
                completeAndMatching: report.failures.length === 0 && report.observations.length === manifest.groups.length * 18,
                relativeGain: ['B/A', 'B/C'].every((p) => ['cpu', 'wall'].every((k) => pairs[p][k + 'MedianPercent'] <= -15 && pairs[p][k + 'FasterPairs'] >= 5)),
                absoluteCpuGain: ['B/A', 'B/C'].every((p) => pairs[p].cpuMedianSavedPerCorpusMs >= 15),
                unchangedControls: ['cpu', 'wall'].every((k) => Math.abs(pairs['C/A'][k + 'MedianPercent']) <= 5),
            };
            report.gates = {checks, allGatesPass: Object.values(checks).every(Boolean)};
        }
        await verifyFrozen();
        report.complete = report.failures.length === 0;
    } catch (error) {
        report.failures.push({stage: mode, error: String(error?.stack ?? error)});
        report.complete = false;
        if (report.gates) report.gates.allGatesPass = false;
    } finally {
        report.finishedAt = new Date().toISOString();
        report.maxRssKiB = process.resourceUsage().maxRSS;
        await save();
        console.log(JSON.stringify({mode, complete: report.complete, failures: report.failures,
            rows: report.rows, groups: report.groups?.length, totals: report.totals,
            uniqueMediaPaths: report.uniqueMediaPaths, observations: report.observations.length,
            gates: report.gates ?? null,
            comparisons: report.comparisons ? Object.fromEntries(Object.entries(report.comparisons).map(([key, {pairs, ...summary}]) => [key, summary])) : null}));
        if (!report.complete) process.exitCode = 1;
    }
}
