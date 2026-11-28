import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';

const [inputPath, arm, mode, outputPath] = process.argv.slice(2);
assert(['A', 'B', 'C'].includes(arm));
assert(['preflight', 'counter', 'measure'].includes(mode));
assert(!fs.existsSync(outputPath));
const inputBytes = fs.readFileSync(inputPath);
const input = JSON.parse(inputBytes);
const root = input.roots[arm];
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const identity = () => Object.fromEntries(input.sourceFiles.map((name) => [name, sha(fs.readFileSync(path.join(root, name)))]));
const expectedIdentity = input.identities[arm === 'C' ? 'A' : arm];
const before = identity();
assert.deepEqual(before, expectedIdentity);
const archive = fs.readFileSync(input.fixture.path);
assert.equal(archive.length, input.fixture.bytes);
assert.equal(sha(archive), input.fixture.sha256);
const sources = input.banks.map((bank) => {
    const bytes = archive.subarray(bank.offset, bank.offset + bank.compressedSize);
    assert.equal(sha(bytes), bank.compressedSha256);
    return {...bank, bytes, estimatedBytes: bank.uncompressedSize};
});
const totalBytes = sources.reduce((sum, source) => sum + source.uncompressedSize, 0);
assert.equal(totalBytes, 171617523);
const parserSource = fs.readFileSync(path.join(root, 'ext/js/dictionary/term-bank-wasm-parser.js'), 'utf8');
const extract = (name) => {
    const match = parserSource.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
    assert(match, name);
    return match[0];
};
const partitionSource = extract('partitionSourceBanks');
const byteLengthSource = extract('getPartitionSourceByteLength');
const partition = new Function(`${byteLengthSource}\n${partitionSource}\nreturn partitionSourceBanks;`)();
const groups = partition(sources, totalBytes, input.groupPolicy.requestedGroups);
assert.equal(groups.length, 12);
assert.deepEqual(groups.map((group) => group.length), input.groupPolicy.expectedGroupBankCounts);
const parser = await load('ext/js/dictionary/term-bank-wasm-parser.js');
const {shouldOwnTermContentBytes} = await load('ext/js/dictionary/term-content-ownership.js');
const {snapshotTermBankExperiments} = await load('ext/js/dictionary/term-bank-experiments.js');
const {MIN_EXACT_LOOKUP_SOURCE_BYTES} = await load('ext/js/dictionary/term-lookup-route.js');
assert.equal(input.options.prepareLookupRoute, totalBytes >= MIN_EXACT_LOOKUP_SOURCE_BYTES);
const options = {...input.options};
const modulePath = mode === 'counter' ? input.counterWasm.path : path.join(root, 'dev/data/dictionary-wasm/term-bank-parser.wasm');
const moduleBytes = fs.readFileSync(modulePath);
assert.equal(sha(moduleBytes), mode === 'counter' ? input.counterWasm.sha256 : expectedIdentity['dev/data/dictionary-wasm/term-bank-parser.wasm']);
assert(mode !== 'counter' || arm === 'B');
const module = await WebAssembly.compile(moduleBytes);
const originalInstantiate = WebAssembly.instantiate;
let nativeExports;
let nativeCallCount = 0;
let nativeElapsedMs = 0;
let measuring = false;
WebAssembly.instantiate = async (...args) => {
    const instance = await originalInstantiate(...args);
    if (args[0] !== module) { return instance; }
    nativeExports = instance.exports;
    const wrapped = {...nativeExports};
    const actual = nativeExports.parse_and_encode_term_bank_token_binary_dedup;
    wrapped.parse_and_encode_term_bank_token_binary_dedup = (...callArgs) => {
        nativeCallCount++;
        const start = measuring ? performance.now() : 0;
        try { return actual(...callArgs); }
        finally { if (measuring) { nativeElapsedMs += performance.now() - start; } }
    };
    // The stock loader reads instance.exports only. The native module, imports,
    // arguments and returned data are unchanged; both controls use this wrapper.
    return {exports: wrapped};
};
parser.setTermBankWasmModule(module);

const viewBytes = (value) => new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
function digestOutputs(chunk) {
    const digest = crypto.createHash('sha256');
    const lengths = {};
    const add = (label, value) => {
        if (ArrayBuffer.isView(value)) {
            const bytes = viewBytes(value);
            digest.update(`${label}:${value.constructor.name}:${bytes.byteLength}:`);
            digest.update(bytes);
            lengths[label] = bytes.byteLength;
        } else {
            const text = JSON.stringify(value) ?? 'undefined';
            digest.update(`${label}:${text.length}:${text}`);
        }
    };
    add('rowCount', chunk.rowCount);
    add('contentMetaByUniqueIndex', chunk.contentMetaByUniqueIndex === true);
    for (const key of ['readingEqualsExpressionList', 'scoreList', 'sequenceList', 'contentMetaList', 'contentUniqueIndexList', 'contentHash1List', 'contentHash2List', 'contentBytesBuffer']) { add(key, chunk[key] ?? null); }
    for (const key of ['expressionBytesList', 'readingBytesList', 'contentBytesList']) {
        add(`${key}.count`, chunk[key].length);
        for (let index = 0; index < chunk[key].length; index++) { add(`${key}.${index}`, chunk[key][index]); }
    }
    for (const key of ['stringLengths', 'stringOffsets', 'stringHashes', 'stringsBuffer', 'expressionIndexes', 'readingIndexes']) { add(`recordPlan.${key}`, chunk.termRecordPreinternedPlan[key] ?? null); }
    assert(chunk.contentDedupPlan?.resolutionDeferred === true);
    for (const key of Object.keys(chunk.contentDedupPlan).sort()) { add(`dedup.${key}`, chunk.contentDedupPlan[key]); }
    assert(chunk.preparedLookupIndexes instanceof Map);
    add('lookupCount', chunk.preparedLookupIndexes.size);
    for (const [name, entry] of chunk.preparedLookupIndexes) {
        add('lookup.name', name); add(`${name}.bytes`, entry.bytes); add(`${name}.route`, entry.routeFilter ?? null);
        for (const key of ['stringLengths', 'stringOffsets', 'stringHashes', 'stringsBuffer', 'expressionIndexes', 'readingIndexes']) { add(`${name}.plan.${key}`, entry.preinternedPlan[key] ?? null); }
    }
    assert.equal(chunk.mediaRows.length, 0);
    return {sha256: digest.digest('hex'), lengths};
}

const report = {schemaVersion: 1, complete: false, arm, mode, inputSha256: sha(inputBytes), root, source: input.source, before, moduleSha256: sha(moduleBytes), node: process.version, v8: process.versions.v8, runnerSha256: sha(fs.readFileSync(new URL(import.meta.url))), partitionFunctionSha256: sha(partitionSource), byteLengthFunctionSha256: sha(byteLengthSource), options, experiments: snapshotTermBankExperiments(options), groupGeometry: groups.map((group) => ({firstBank: group[0].filename, lastBank: group.at(-1).filename, banks: group.length, rows: group.reduce((sum, bank) => sum + bank.rows, 0), sourceBytes: group.reduce((sum, bank) => sum + bank.uncompressedSize, 0)})), warmups: [], measured: null, diagnostic: null, limitations: ['Serial source-bound native component; no actual parser worker scheduling, DB/compression/storage/finalization or browser import.', 'Primary endpoint is the sum of complete native fused parse/intern/encode/dedup calls, including their original allocation/growth. It excludes initialization/compilation, inflate, CRC, JavaScript lookup/copy and output verification.', 'Secondary full group wall endpoint includes native inflate, copied source, strict parser, CRC, JavaScript/native lookup, route construction and unchanged cacheable-owned result copy.', 'Every timed observation is a fresh process with two fixed full warmup sweeps and one measured sweep; every output digest is computed after that group timing ends.', 'Counter module is used only in a separate untimed preflight. No counter module is admitted to timing.']};
const save = () => fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
save();

async function execute(verify, timed) {
    const sweep = {rows: 0, nativeCalls: 0, nativeFusedMs: timed ? 0 : null, fullGroupMs: timed ? 0 : null, groups: []};
    nativeCallCount = 0; nativeElapsedMs = 0;
    for (const [index, group] of groups.entries()) {
        nativeExports?.census_child_stats_reset?.();
        let resultChunk;
        let owned = false;
        measuring = timed;
        const start = timed ? performance.now() : 0;
        let preloaded;
        try {
            preloaded = await parser.inflateCompressedTermBankSourcesWasm(group, options, true);
            await parser.parseTermBankWithWasmColumnChunks(new Uint8Array(0), 3, (chunk) => {
                assert.equal(resultChunk, undefined);
                const ownCacheable = shouldOwnTermContentBytes(chunk.contentBytesLength, chunk.contentDedupPlan?.uniqueCount, chunk.contentDedupPlan?.sourceRowCount, chunk.rowCount);
                resultChunk = parser.copyWasmBackedColumnChunk(chunk, true, false, options.prepareLookupRoute, preloaded);
                if (ownCacheable && resultChunk.contentBytesBuffer instanceof Uint8Array && resultChunk.contentBytesBuffer.buffer === chunk.contentBytesBuffer?.buffer) {
                    const bytes = new Uint8Array(new SharedArrayBuffer(resultChunk.contentBytesBuffer.byteLength));
                    bytes.set(resultChunk.contentBytesBuffer);
                    resultChunk.contentBytesBuffer = bytes;
                }
                owned = ownCacheable || resultChunk.contentBytesBuffer?.buffer instanceof ArrayBuffer;
            }, 2048, {...options, preloadedSource: preloaded});
        } finally {
            if (timed) { sweep.fullGroupMs += performance.now() - start; }
            measuring = false;
        }
        assert(resultChunk);
        const profile = parser.consumeLastTermBankWasmParseProfile();
        assert(profile);
        assert.equal(profile.fusedParseAttempts, 1);
        assert.equal(profile.fusedParseFallbacks, 0);
        assert.equal(resultChunk.rowCount, report.groupGeometry[index].rows);
        assert(owned);
        const output = verify ? digestOutputs(resultChunk) : null;
        const counters = mode === 'counter' ? Array.from(new Uint32Array(nativeExports.memory.buffer, nativeExports.census_child_stats_ptr(), 4)) : null;
        sweep.groups.push({index, rows: resultChunk.rowCount, profile, owned, output, counters});
        sweep.rows += resultChunk.rowCount;
        resultChunk = null;
    }
    assert.equal(sweep.rows, 528299);
    assert.equal(nativeCallCount, 12);
    sweep.nativeCalls = nativeCallCount;
    if (timed) { sweep.nativeFusedMs = nativeElapsedMs; }
    return sweep;
}

try {
    if (mode === 'measure') {
        for (let index = 0; index < 2; index++) { report.warmups.push(await execute(false, false)); save(); }
        globalThis.gc?.();
        report.measured = await execute(true, true);
    } else {
        report.diagnostic = await execute(true, false);
    }
    report.after = identity();
    assert.deepEqual(report.after, report.before);
    assert.equal(sha(archive), input.fixture.sha256);
    report.memory = process.memoryUsage();
    report.maxRssKiB = process.resourceUsage().maxRSS;
    report.complete = true;
} catch (error) {
    report.error = {name: error?.name, message: String(error), stack: error?.stack};
    throw error;
} finally {
    measuring = false;
    WebAssembly.instantiate = originalInstantiate;
    save();
}
process.stdout.write(JSON.stringify({complete: report.complete, arm, mode, nativeFusedMs: report.measured?.nativeFusedMs ?? null, fullGroupMs: report.measured?.fullGroupMs ?? null, output: outputPath}) + '\n');
