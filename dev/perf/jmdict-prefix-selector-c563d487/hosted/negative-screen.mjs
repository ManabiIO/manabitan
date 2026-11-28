#!/usr/bin/env node
/* One fresh child: two excluded full warmups, then 16 measured complete passes. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {writeSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import path from 'node:path';
import {digestChunk} from './output-digest.mjs';

const {values, positionals} = parseArgs({allowPositionals: true, options: {
    'source-root': {type: 'string'}, 'fixtures-dir': {type: 'string'},
    'diagnostic-wasm': {type: 'string'}, 'verify-only': {type: 'boolean'},
}});
const caseId = Number(positionals[0]);
assert([1, 2, 3].includes(caseId) && values['source-root'] && values['fixtures-dir']);
assert(!(values['diagnostic-wasm'] && values['verify-only']));
const sourceRoot = path.resolve(values['source-root']);
const fixtureRoot = path.resolve(values['fixtures-dir']);
const diagnosticWasm = values['diagnostic-wasm'] ?? null;
const verificationOnly = values['verify-only'] === true;
const excludedOnly = diagnosticWasm !== null || verificationOnly;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifestBytes = await readFile(path.join(fixtureRoot, 'manifest.json'));
const manifest = JSON.parse(manifestBytes);
assert.equal(manifest.node, process.version);
assert.equal(manifest.rowsPerCase, 20000);
assert.equal(manifest.rowsPerBank, 10000);
assert.equal(manifest.banksPerCase, 2);
const fixture = manifest.cases.find(({id}) => id === caseId);
assert(fixture && fixture.banks.length === 2);
const sources = [];
for (const bank of fixture.banks) {
    const bytes = await readFile(path.join(fixtureRoot, bank.compressedFile));
    assert.equal(sha(bytes), bank.compressedSha256);
    assert.equal(bytes.length, bank.compressedSize);
    sources.push({...bank, bytes});
}
const fieldsBytes = await readFile(new URL('./diagnostic-fields.json', import.meta.url));
const fields = JSON.parse(fieldsBytes);
let diagnosticExports = null;
if (diagnosticWasm !== null) {
    const instantiate = WebAssembly.instantiate.bind(WebAssembly);
    WebAssembly.instantiate = async (...args) => {
        const result = await instantiate(...args);
        const exports = result instanceof WebAssembly.Instance ? result.exports : result.instance.exports;
        if (typeof exports.prefix_selector_diag_get === 'function') { diagnosticExports = exports; }
        return result;
    };
}
const parser = await import(pathToFileURL(path.join(sourceRoot, 'ext/js/dictionary/term-bank-wasm-parser.js')));
const prep = await import(pathToFileURL(path.join(sourceRoot, 'ext/js/dictionary/term-lookup-index-preparation.js')));
const wasmPath = diagnosticWasm ?? path.join(sourceRoot, 'ext/lib/term-bank-parser.wasm');
const wasmBytes = await readFile(wasmPath);
parser.setTermBankWasmModule(await WebAssembly.compile(wasmBytes));
const sourcePaths = ['ext/js/dictionary/wasm/term-bank-parser.c', 'ext/js/dictionary/term-bank-wasm-parser.js',
    'ext/js/dictionary/term-bank-experiments.js', 'ext/js/dictionary/term-bank-source-crc.js',
    'ext/js/dictionary/term-lookup-scratch.js', 'ext/js/dictionary/term-lookup-index-preparation.js',
    'ext/js/dictionary/term-lookup-index.js', 'ext/js/dictionary/term-record-preinterned-plan.js',
    'dev/data/dictionary-wasm/manifest.json', 'package-lock.json'];
const sourceHashes = {};
for (const file of sourcePaths) { sourceHashes[file] = sha(await readFile(path.join(sourceRoot, file))); }
const flags = {};
const options = {singleChunk: true, emitTermByteLists: false, computeContentHashes: true,
    emitContentSlab: true, emitTokenBinaryContent: true, mediaHintFastScan: true,
    validateGlossaryTypes: true, prepareLookupIndexes: true};
const uncompressedBytes = sources.reduce((sum, source) => sum + source.uncompressedSize, 0);

async function execute() {
    let chunk = null;
    let chunkCount = 0;
    let extraLookupMs = 0;
    const beforeCpu = process.cpuUsage();
    const started = performance.now();
    // A fresh source object and native inflate/CRC transaction on EVERY pass.
    const preloadedSource = await parser.inflateCompressedTermBankSourcesWasm(sources, options, true);
    const inflateMs = performance.now() - started;
    const inflateCpu = process.cpuUsage(beforeCpu);
    const parseStarted = performance.now();
    await parser.parseTermBankWithWasmColumnChunks(new Uint8Array(0), 3, (value) => {
        ++chunkCount;
        chunk = value;
        if (!value.preparedLookupIndexes) {
            const built = prep.prepareTermLookupIndexesFromPreinternedPlan(value, null, flags);
            if (!built) { throw new Error('Lookup construction failed'); }
            value.preparedLookupIndexes = built.indexes;
            extraLookupMs += built.totalMs;
        }
    }, 2048, {...options, preloadedSource});
    const parseMs = performance.now() - parseStarted;
    const elapsedMs = performance.now() - started;
    const cpu = process.cpuUsage(beforeCpu);
    // All assertions/digests below occur after both clocks stop, before the
    // next inflate can reuse the backing WASM memory.
    const profile = parser.consumeLastTermBankWasmParseProfile();
    assert(chunk && profile && chunkCount === 1);
    assert.equal(chunk.rowCount, fixture.rows);
    assert.equal(profile.fusedParseAttempts, 1);
    assert.equal(profile.fusedParseFallbacks ?? 0, 0);
    assert.equal(profile.validatedGlossaryReuseCount ?? 0, 0);
    assert.equal(profile.recentContentDedupHitCount ?? 0, 0);
    assert(prep.hasCompletePreparedTermLookupIndexes(chunk.preparedLookupIndexes, chunk.rowCount));
    assert.equal(chunk.contentDedupPlan?.uniqueCount, fixture.rows);
    const crcMode = preloadedSource.crcSignaturesPtr ? 'deferred-native-per-bank' : 'native-inflate-per-bank';
    if (preloadedSource.crcSignaturesPtr) {
        assert.equal(preloadedSource.crcVerified, true);
        assert.equal(preloadedSource.crcScannedBytes, uncompressedBytes);
        assert.equal(preloadedSource.crcReusedBytes, 0);
        assert.equal(preloadedSource.crcReusedGlossaryCount, 0);
    }
    const verified = digestChunk(chunk, chunk.preparedLookupIndexes);
    return {elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000, inflateMs,
        inflateCpuMs: (inflateCpu.user + inflateCpu.system) / 1000, parseMs,
        lookupMs: extraLookupMs + (profile.lookupIndexPrepareMs ?? 0),
        nativeParseMs: (profile.parseBankMs ?? 0) + (profile.encodeContentMs ?? 0),
        rows: chunk.rowCount, fusedAttempts: profile.fusedParseAttempts, fusedFallbacks: profile.fusedParseFallbacks ?? 0,
        glossaryReuseCount: profile.validatedGlossaryReuseCount ?? 0,
        recentContentDedupHitCount: profile.recentContentDedupHitCount ?? 0,
        maxWasmHeapBytes: profile.maxWasmHeapBytes ?? 0,
        nativeSegments: profile.nativeSegmentedLookupSegments ?? 0,
        scratchReusedBytes: profile.nativeLookupScratchReusedBytes ?? 0,
        crcMode, crcVerifiedBytes: preloadedSource.crcSignaturesPtr ? preloadedSource.crcScannedBytes : uncompressedBytes,
        crcReusedBytes: preloadedSource.crcReusedBytes ?? 0, ...verified};
}
const warmups = [];
const repetitions = [];
let activePass = null;
const progress = (value) => writeSync(2, 'PREFIX_NEGATIVE_PASS ' + JSON.stringify(value) + '\n');
writeSync(2, 'PREFIX_NEGATIVE_CHILD_START ' + JSON.stringify({caseId, sourceRoot, sourceHashes,
    node: process.version, wasmSha256: sha(wasmBytes), fixtureManifestSha256: sha(manifestBytes),
    runnerSha256: sha(await readFile(fileURLToPath(import.meta.url))), excludedOnly, diagnosticWasm}) + '\n');
try {
for (let i = 0; i < (excludedOnly ? 0 : 2); ++i) {
    activePass = {phase: 'warmup', repetition: i};
    const result = {excluded: true, repetition: i, ...await execute()};
    warmups.push(result);
    progress({caseId, ...activePass, ...result});
}
globalThis.gc?.();
for (let i = 0; i < (excludedOnly ? 1 : 16); ++i) {
    activePass = {phase: excludedOnly ? 'untimed-verification' : 'measured', repetition: i};
    const result = {repetition: i, ...await execute()};
    repetitions.push(result);
    progress({caseId, ...activePass, ...result});
}
const first = repetitions[0];
for (const result of [...warmups, ...repetitions]) {
    for (const key of ['digest', 'rows', 'indexBytes', 'fusedAttempts', 'fusedFallbacks', 'glossaryReuseCount', 'recentContentDedupHitCount', 'crcMode', 'crcVerifiedBytes', 'crcReusedBytes']) {
        assert.equal(result[key], first[key], `Pass output/work changed: ${key}`);
    }
}
const sums = {};
for (const key of ['elapsedMs', 'cpuMs', 'inflateMs', 'inflateCpuMs', 'parseMs', 'lookupMs', 'nativeParseMs', 'rows', 'indexBytes']) {
    sums[key] = repetitions.reduce((sum, repetition) => sum + repetition[key], 0);
}
for (const file of sourcePaths) { assert.equal(sha(await readFile(path.join(sourceRoot, file))), sourceHashes[file]); }
assert.equal(sha(await readFile(wasmPath)), sha(wasmBytes));
assert.equal(sha(await readFile(path.join(fixtureRoot, 'manifest.json'))), sha(manifestBytes));
for (const bank of fixture.banks) { assert.equal(sha(await readFile(path.join(fixtureRoot, bank.compressedFile))), bank.compressedSha256); }
if (diagnosticWasm !== null) { assert(diagnosticExports, 'Diagnostic module did not activate'); }
console.log(JSON.stringify({schema: 1, complete: true, caseId, caseName: fixture.name, scope: excludedOnly ?
    'One untimed verification/mechanics pass; all displayed durations excluded from performance conclusions' :
    'One fresh-process negative-control observation: sum of16 complete inflate/CRC/strict-parse/lookup passes;2 excluded warmups; digest after each clock stops',
    excludedOnly, diagnosticWasm, verificationOnly, flags, validateGlossaryTypes: true, sourceRoot, sourceHashes,
    gitHead: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: sourceRoot, encoding: 'utf8'}).trim(),
    gitTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {cwd: sourceRoot, encoding: 'utf8'}).trim(),
    trackedChanges: execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {cwd: sourceRoot, encoding: 'utf8'}).trim(),
    node: process.version, wasmSha256: sha(wasmBytes), runnerSha256: sha(await readFile(fileURLToPath(import.meta.url))),
    outputDigestSha256: sha(await readFile(new URL('./output-digest.mjs', import.meta.url))),
    diagnosticFieldsSha256: sha(fieldsBytes), fixtureManifestSha256: sha(manifestBytes), generatorSha256: manifest.generatorSha256,
    bankIdentities: fixture.banks, warmupPasses: warmups.length, measuredRepetitions: excludedOnly ? 0 : repetitions.length,
    warmups, repetitions, ...sums, perPassRows: first.rows, perPassIndexBytes: first.indexBytes, digest: first.digest,
    maxWasmHeapBytes: Math.max(...repetitions.map(({maxWasmHeapBytes}) => maxWasmHeapBytes)),
    diagnostic: diagnosticExports === null ? null : Object.fromEntries(fields.map((key, index) => [key, Number(diagnosticExports.prefix_selector_diag_get(index))])),
    afterVerificationMemory: process.memoryUsage(), lifetimeMaxRssKiB: process.resourceUsage().maxRSS}));
} catch (error) {
    writeSync(2, 'PREFIX_NEGATIVE_CHILD_FAILED ' + JSON.stringify({caseId, sourceRoot,
        sourceHashes, wasmSha256: sha(wasmBytes), fixtureManifestSha256: sha(manifestBytes),
        excludedOnly, activePass, warmups, repetitions, message: String(error), stack: error.stack}) + '\n');
    throw error;
}
