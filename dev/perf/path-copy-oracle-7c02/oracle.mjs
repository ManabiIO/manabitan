import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createReadStream, openAsBlob} from 'node:fs';
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {Worker as ThreadWorker} from 'node:worker_threads';

const [baseArgument, candidateArgument, outputArgument] = process.argv.slice(2);
assert(baseArgument && candidateArgument && outputArgument);
const baseRoot = resolve(baseArgument);
const candidateRoot = resolve(candidateArgument);
const outputRoot = resolve(outputArgument);
const ownRoot = dirname(fileURLToPath(import.meta.url));
const BASE = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2';
const PARSER = 'ext/js/dictionary/term-bank-wasm-parser.js';
const WORKER = 'ext/js/dictionary/term-bank-wasm-parser-worker.js';
const WASM = 'ext/lib/term-bank-parser.wasm';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const local = (path) => import(pathToFileURL(join(baseRoot, path)));
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const EXPECTED = {
    baselineParser: '31854cfb3d20ba60b701ec31cf19de26bd55cc745cc4f998cb33f0554ec83cca',
    baselineWorker: '47f1d827d94f4c5aac639bf2dceff33f483e969447ca77bd1ae24c1eb014eef1',
    candidateParser: '69f6f44bb25b1ade2e77ad51a5c830ac359ec3d44f364a3c0ed6131728f54518',
    candidateWorker: 'b368f85dc737f4cd2567fa1723e69f3276f6f8c0441085af3b94ac80ed2a0057',
    wasm: '8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee',
    fixtureLock: '60aa981791f3b60ca17588212aea5bd3536fb8f59288855e5accd019c6e4cf89',
};
const trackedInputs = [
    [join(baseRoot, PARSER), EXPECTED.baselineParser], [join(baseRoot, WORKER), EXPECTED.baselineWorker],
    [join(candidateRoot, PARSER), EXPECTED.candidateParser], [join(candidateRoot, WORKER), EXPECTED.candidateWorker],
    [join(baseRoot, WASM), EXPECTED.wasm], [join(baseRoot, 'test/perf/dictionaries.lock.json'), EXPECTED.fixtureLock],
];
const fixtureManifestPath = join(ownRoot, 'reference-manifest.json');
const fixtureManifestBytes = await readFile(fixtureManifestPath);
const fixtureManifestSha256 = sha(fixtureManifestBytes);
assert.equal(fixtureManifestSha256, '810c067eabf70271a5440775751420ce065e3bfc1ce2a47bfd2cb61c4876a8a2');
const expectedGroups = JSON.parse(fixtureManifestBytes).groups;
const candidateCommit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: candidateRoot, encoding: 'utf8'}).trim();
if (process.env.CANDIDATE_SOURCE_COMMIT) assert.equal(candidateCommit, process.env.CANDIDATE_SOURCE_COMMIT);
const outputPath = join(outputRoot, 'manifest.json');
await mkdir(outputRoot, {recursive: true});
const report = {
    schemaVersion: 1, complete: false, startedAt: new Date().toISOString(), baseCommit: BASE,
    node: process.version, candidateRoot, baseRoot, failures: [], rows: 0, mediaRows: 0,
    fixtureManifestSha256, candidateCommit,
    scope: 'Untimed actual candidate worker/parser copy differential. Snapshot raw JSON/semantic columns before the actual batched copy. Candidate public false-branch copy supplies strict complete alias/byte equality in the same module; frozen baseline copy supplies full independent value/byte equality. Actual share/project/production-route arguments are identical. No aliases are normalized and no performance claim is made.',
};
await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
const save = () => writeFile(outputPath, JSON.stringify(report, null, 2) + '\n');
async function fileIdentity(path) { const bytes = await readFile(path); return {path, bytes: bytes.length, sha256: sha(bytes)}; }
async function writeOrVerify(path, source) {
    try { await writeFile(path, source, {flag: 'wx'}); }
    catch (error) { if (error.code !== 'EEXIST') throw error; assert.equal(await readFile(path, 'utf8'), source); }
}
async function verifyBase() {
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], {cwd: baseRoot, encoding: 'utf8'}).trim(), BASE);
    execFileSync('git', ['diff', '--exit-code', BASE, '--', 'ext/js', 'package-lock.json', 'test/perf/dictionaries.lock.json', 'test/fixtures/parser-settlement/worker-node.mjs'], {cwd: baseRoot});
    for (const [path, digest] of trackedInputs) assert.equal(sha(await readFile(path)), digest, path);
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], {cwd: candidateRoot, encoding: 'utf8'}).trim(), candidateCommit);
    execFileSync('git', ['diff', '--exit-code', BASE, '--', 'ext/js', ':(exclude)' + PARSER, ':(exclude)' + WORKER, 'package-lock.json', 'test/perf/dictionaries.lock.json'], {cwd: candidateRoot});
    assert.equal(sha(await readFile(fixtureManifestPath)), fixtureManifestSha256);
    assert.equal(sha(await readFile(join(candidateRoot, PARSER))), '69f6f44bb25b1ade2e77ad51a5c830ac359ec3d44f364a3c0ed6131728f54518');
}
try {
    await verifyBase();
    const packageManifest = await readJson(join(ownRoot, 'package-manifest.json'));
    for (const file of packageManifest.files) assert.equal(sha(await readFile(join(ownRoot, file.path))), file.sha256, file.path);
    const candidateSource = await readFile(join(candidateRoot, PARSER), 'utf8');
    const candidateProbe = join(baseRoot, 'ext/js/dictionary/path-copy-oracle-candidate-7c02.js');
    await writeOrVerify(candidateProbe, candidateSource);
    const publicProof = await readJson(join(ownRoot, 'public-false-branch-proof.json'));
    assert(publicProof.complete && publicProof.exactTextEqual && publicProof.publicWrapperPassesLiteralFalse);
    assert.equal(publicProof.candidateParserSha256, sha(candidateSource));
    const aliasProof = await readJson(join(ownRoot, 'zero-alias-diagnostic.json'));
    assert(aliasProof.complete && aliasProof.cases.length === 2);
    const candidateWorker = await readFile(join(candidateRoot, WORKER), 'utf8');
    const copyLine = '                resultChunk = copyParserWorkerColumnChunk(chunk, shareContentBytes, options.projectImagePaths === true, options.prepareLookupRoute === true, preloadedSource);';
    assert.equal(candidateWorker.split(copyLine).length, 2);
    const parserImport = "from './term-bank-wasm-parser.js';";
    assert.equal(candidateWorker.split(parserImport).length, 2);
    const observerSource = candidateWorker.replace(copyLine,
        '                const copyOracleSnapshot = globalThis.__beforePathCopy(chunk, preloadedSource);\n' + copyLine +
        '\n                globalThis.__verifyPathCopy(chunk, shareContentBytes, options.projectImagePaths === true, options.prepareLookupRoute === true, preloadedSource, resultChunk, data, copyOracleSnapshot);')
        .replace(parserImport, "from './path-copy-oracle-candidate-7c02.js';");
    const observerPath = join(baseRoot, 'ext/js/dictionary/path-copy-oracle-observer-v2-7c02.js');
    await writeOrVerify(observerPath, observerSource);
    report.sourceInputs = await Promise.all([
        ...trackedInputs.map(([path]) => path), import.meta.filename,
        join(ownRoot, 'worker.mjs'), candidateProbe, observerPath,
        join(baseRoot, 'ext/js/dictionary/term-lookup-route.js'),
        join(ownRoot, 'public-false-branch-proof.json'), join(ownRoot, 'zero-alias-diagnostic.json'),
        join(ownRoot, 'reference-manifest.json'), join(ownRoot, 'package-manifest.json'),
    ].map(fileIdentity));
    await save();
    const lock = await readJson(join(baseRoot, 'test/perf/dictionaries.lock.json'));
    const spec = lock.dictionaries.vndb;
    const archivePath = join(baseRoot, 'builds/e2e-dictionary-cache', spec.cacheFile);
    const archiveHash = createHash('sha256');
    for await (const bytes of createReadStream(archivePath)) archiveHash.update(bytes);
    assert.equal(archiveHash.digest('hex'), spec.sha256);
    const archive = await openAsBlob(archivePath);
    assert.equal(archive.size, spec.sizeBytes);
    const parser = await local(PARSER);
    parser.setTermBankWasmModule(await WebAssembly.compile(await readFile(join(baseRoot, WASM))));
    const pipelineModule = await local('ext/js/dictionary/term-bank-source-pipeline.js');
    const {readDenseZipFileMap} = await local('ext/js/dictionary/dense-zip-directory.js');
    const {MIN_EXACT_LOOKUP_SOURCE_BYTES} = await local('ext/js/dictionary/term-lookup-route.js');
    const {Uint8ArrayWriter} = await local('node_modules/@zip.js/zip.js/index.js');
    const terminations = [];
    const sourceGroups = [];
    class BrowserWorker extends EventTarget {
        constructor(url) {
            super();
            assert.equal(url.href, pathToFileURL(join(baseRoot, WORKER)).href);
            this.worker = new ThreadWorker(pathToFileURL(join(ownRoot, 'worker.mjs')), {workerData: {
                url: pathToFileURL(observerPath).href, candidateProbe: pathToFileURL(candidateProbe).href,
                baselineParser: pathToFileURL(join(baseRoot, PARSER)).href,
                fixtureManifestPath, fixtureManifestSha256, receiptRoot: outputRoot,
            }});
            this.worker.on('message', (data) => this.dispatchEvent(new MessageEvent('message', {data})));
            this.worker.on('error', (error) => {
                const event = new Event('error'); Object.defineProperty(event, 'message', {value: error.message}); this.dispatchEvent(event);
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
        assert(writer instanceof Uint8ArrayWriter); ++fallbackReads;
        const signal = options.signal ?? new AbortController().signal;
        const bytes = await rawReader.read(this, signal);
        const decoded = await parser.inflateCompressedZipMediaBatchWasm([{...this, bytes}]);
        signal.throwIfAborted(); return decoded.sources[0];
    }
    const fileMap = await readDenseZipFileMap(archive, getData);
    assert(fileMap !== null);
    const termFiles = [...fileMap.keys()].filter((name) => /^term_bank_\d+\.json$/.test(name))
        .sort((a, b) => Number(a.slice(10, -5)) - Number(b.slice(10, -5))).map((name) => fileMap.get(name));
    const rawTermBankSourceBytes = termFiles.reduce((n, entry) => n + entry.uncompressedSize, 0);
    const prepareLookupRoute = rawTermBankSourceBytes >= MIN_EXACT_LOOKUP_SOURCE_BYTES;
    assert(prepareLookupRoute);
    const pipeline = new pipelineModule.TermBankSourcePipeline({termFiles, enabled: true,
        read: async (file) => await file.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true}),
        readCompressed: async (file, signal) => await rawReader.read(file, signal)});
    const options = {emitTermByteLists: false, computeContentHashes: true, emitContentSlab: true,
        emitTokenBinaryContent: true, mediaHintFastScan: true, projectImagePaths: true,
        validateGlossaryTypes: true, prepareLookupIndexes: true, prepareLookupRoute, maxPendingChunks: 2};
    report.fixture = spec;
    report.options = options;
    report.sourceGroups = sourceGroups;
    report.routeAdmission = {rawTermBankSourceBytes, minimumSourceBytes: MIN_EXACT_LOOKUP_SOURCE_BYTES, prepareLookupRoute,
        note: 'Production importer derives this flag from total raw term-bank bytes. Projection-only fixtures omitted route construction; this untimed full-copy oracle enables the production-admitted route path.'};
    const consume = (chunk) => {
        report.rows += chunk.rowCount; report.mediaRows += chunk.mediaRows.length;
        if (report.rows % 400000 === 0) process.stderr.write('Verified full copies for ' + report.rows + '/' + spec.termRows + ' rows\n');
    };
    try {
        for (let start = 0; start < termFiles.length;) {
            const plan = pipeline.createCompressedImportRunPlan(start);
            if (plan !== null) {
                assert.equal(await parser.parseTermBankWithWasmColumnChunksParallelCompressedLazy(plan.loaders, plan.estimatedByteLengths, 3, consume, options), true);
                pipeline.releaseBatch(plan.files); start += plan.files.length;
            } else {
                const files = pipeline.getBatch(start); const batch = await pipeline.readBatch(files);
                if (batch?.promises) assert.equal(await parser.parseTermBankWithWasmColumnChunksParallelDeferred(batch.promises, batch.estimatedByteLengths, 3, consume, options), true);
                else await parser.parseTermBankWithWasmColumnChunks(batch, 3, consume, 2048, {...options, singleChunk: true});
                pipeline.releaseBatch(files); start += files.length;
            }
        }
        assert.equal(report.rows, spec.termRows);
    } finally {
        await pipeline.dispose(); await parser.disposeParallelTermBankParser(); await Promise.all(terminations);
        fileMap.clear(); report.fallbackReads = fallbackReads; await save();
    }
    const names = (await readdir(outputRoot)).filter((name) => /^group-\d+\.json$/.test(name)).sort();
    assert.equal(names.length, expectedGroups.length);
    const groups = [];
    for (const name of names) {
        const bytes = await readFile(join(outputRoot, name)); const group = JSON.parse(bytes);
        const expected = expectedGroups.find((x) => x.groupKey === group.groupKey);
        assert(expected && group.complete); assert.deepEqual(group.files, expected.files);
        assert.equal(group.sourceRows, expected.sourceRows); assert.equal(group.mediaRows, expected.counts.mediaRows);
        assert.equal(group.preparedIndexes, 1); assert.equal(group.preparedRoutes, 1);
        groups.push({...group, receiptFile: name, receiptSha256: sha(bytes)});
    }
    const key = (x) => Number(x.files[0].slice(10, -5));
    const sorted = (groups) => [...groups].sort((a, b) => key(a) - key(b));
    const originalCapture = JSON.parse(fixtureManifestBytes);
    assert.deepEqual(sorted(sourceGroups).map(({files, bytes}) => ({files, bytes})), sorted(originalCapture.sourceGroups).map(({files, bytes}) => ({files, bytes})));
    assert.equal(groups.reduce((n, group) => n + group.sourceRows, 0), spec.termRows);
    assert.equal(groups.reduce((n, group) => n + group.mediaRows, 0), report.mediaRows);
    report.groups = groups;
    report.preparedIndexes = groups.reduce((n, group) => n + group.preparedIndexes, 0);
    report.preparedRoutes = groups.reduce((n, group) => n + group.preparedRoutes, 0);
    assert.equal(report.preparedIndexes, 170); assert.equal(report.preparedRoutes, 170);
    report.shareContentGroups = groups.filter((group) => group.shareContentBytes).length;
    report.privateContentGroups = groups.filter((group) => !group.shareContentBytes).length;
    report.exactPlannerGroupsMatch = true;
    report.sameModulePublicFalseBranchAliasComparison = true;
    report.independentFrozenBaselineFullValueByteComparison = true;
    report.aliasNormalization = false;
    for (const input of report.sourceInputs) assert.equal(sha(await readFile(input.path)), input.sha256, input.path);
    for (const file of packageManifest.files) assert.equal(sha(await readFile(join(ownRoot, file.path))), file.sha256, file.path);
    await verifyBase();
    report.complete = true;
} catch (error) {
    report.failures.push({error: String(error?.stack ?? error)});
    process.exitCode = 1;
} finally {
    report.finishedAt = new Date().toISOString(); report.maxRssKiB = process.resourceUsage().maxRSS;
    await save();
    console.log('PATH_COPY_ORACLE_RECEIPT ' + JSON.stringify({complete: report.complete, failures: report.failures, rows: report.rows, mediaRows: report.mediaRows,
        groups: report.groups?.length, preparedIndexes: report.preparedIndexes, preparedRoutes: report.preparedRoutes,
        shareContentGroups: report.shareContentGroups, privateContentGroups: report.privateContentGroups,
        baseCommit: BASE, candidateCommit, fixtureManifestSha256, manifestSha256: sha(await readFile(outputPath)),
        candidateParserSha256: EXPECTED.candidateParser, parserWasmSha256: EXPECTED.wasm}));
}
