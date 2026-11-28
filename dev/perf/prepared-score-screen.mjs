/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * UNQUALIFIED EXPERIMENT. Node component timing, not whole-import timing.
 * Usage: node --expose-gc prepared-score-screen.mjs ROOT JMdict.zip REPORT.json
 * Optional env: SCORE_BLOCKS=15 SCORE_REPEATS=8. No retries/outlier deletion.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream, openAsBlob} from 'node:fs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {dirname, join, resolve} from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {Worker as ThreadWorker} from 'node:worker_threads';
import {performance} from 'node:perf_hooks';
import os from 'node:os';

const PIN = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2';
const [rootArg, zipArg, outputArg] = process.argv.slice(2);
assert(rootArg && zipArg && outputArg, 'Usage: ROOT JMdict.zip REPORT.json');
const root = resolve(rootArg), zipPath = resolve(zipArg), output = resolve(outputArg);
const blocks = Number(process.env.SCORE_BLOCKS ?? 15);
const repeats = Number(process.env.SCORE_REPEATS ?? 8);
assert(Number.isSafeInteger(blocks) && blocks >= 5);
assert(Number.isSafeInteger(repeats) && repeats >= 1);
assert.equal(typeof globalThis.gc, 'function', 'Use --expose-gc');
const sha = (x) => createHash('sha256').update(x).digest('hex');
const local = (name) => import(pathToFileURL(join(root, name)).href);
execFileSync('git', ['diff', '--exit-code', PIN, '--', 'ext', 'dev/dictionary-wasm.js', 'test/perf/dictionaries.lock.json'], {cwd: root});
const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
const module = await local('ext/js/dictionary/term-record-opfs-store.js');
const store = new module.TermRecordOpfsStore();
const baseline = (c) => store._encodeArtifactRecordFields(c.chunk, [], [], c.base);
const planData = new WeakMap(), contentData = new WeakMap();
const ABLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
let checksum = 0;
const touch = (bytes) => { checksum = (checksum + bytes.byteLength + (bytes[0] ?? 0) + (bytes.at(-1) ?? 0)) >>> 0; };

function prepareScores(values) {
    if (!ArrayBuffer.isView(values) || Object.getPrototypeOf(values) !== Int32Array.prototype ||
        Object.hasOwn(values, 'length') || Object.hasOwn(values, 'buffer')) { return null; }
    try { ABLength.call(values.buffer); } catch { return null; }
    const count = values.length;
    if (count === 0) { return null; }
    const keys = new Uint16Array(count), scores = [], map = new Map();
    const inline = count >= 64 ? new Uint16Array(512) : null;
    for (let row = 0; row < count; ++row) {
        const score = values[row], offset = score + 256;
        const useInline = inline !== null && offset >= 0 && offset < inline.length;
        let key = useInline ? inline[offset] - 1 : (map.get(score) ?? -1);
        if (key < 0) {
            key = scores.length;
            if (key >= 65534) { return null; }
            if (useInline) { inline[offset] = key + 1; } else { map.set(score, key); }
            scores.push(score);
        }
        keys[row] = key;
    }
    const retainedBytes = keys.byteLength + scores.length * 4;
    // Preserve the existing format rule; preparation can decline independently.
    // The second condition only prevents replacing a smaller raw score column.
    if (16 + scores.length * 4 + count * 8 >= count * 12 || retainedBytes > values.byteLength) { return null; }
    const dictionary = Int32Array.from(scores);
    const token = Object.freeze({rows: count, distinct: dictionary.length, retainedBytes});
    planData.set(token, {dictionary, keys});
    return token;
}
function plan(token) {
    const p = planData.get(token);
    if (!p) { throw new TypeError('Invalid private prepared-score plan'); }
    return p;
}
function restoreScores(token, start, count) {
    const p = plan(token);
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(count) ||
        count < 0 || start + count > token.rows) { throw new RangeError('Invalid private prepared-score range'); }
    const values = new Int32Array(count);
    for (let row = 0; row < count; ++row) { values[row] = p.dictionary[p.keys[start + row]]; }
    return values;
}
function makeCase(group, start, count, ids, offsets, lengths, base) {
    assert.equal(ids.length, count);
    assert.equal(offsets.length, lengths.length);
    const refs = {ids: new Uint32Array(ids), offsets: new Float64Array(offsets), lengths: new Uint32Array(lengths)};
    const chunk = module.createArtifactTermRecordChunkWithResolvedContent(
        {rowCount: count, scoreList: group.scores.subarray(start, start + count)},
        refs.ids, refs.offsets, refs.lengths);
    const c = {group, start, count, base, chunk};
    contentData.set(c, refs);
    return c;
}
function encodeRestored(c, values) {
    const r = contentData.get(c);
    assert(r, 'Unregistered private content input');
    const chunk = module.createArtifactTermRecordChunkWithResolvedContent(
        {rowCount: c.count, scoreList: values}, r.ids, r.offsets, r.lengths);
    return store._encodeArtifactRecordFields(chunk, [], [], c.base);
}
function encodeExact(c, token) {
    assert.equal(token.rows, c.count, 'Exact range required');
    const p = plan(token), r = contentData.get(c);
    assert(r, 'Unregistered private content input');
    for (let row = 0; row < c.count; ++row) {
        const unique = r.ids[row];
        if (unique >= r.lengths.length) { throw new RangeError('Invalid resolved term content reference index: ' + unique); }
        if (r.lengths[unique] >= 65535) { return encodeRestored(c, restoreScores(token, 0, c.count)); }
    }
    const out = new Uint8Array(16 + p.dictionary.byteLength + c.count * 8);
    const header = new Uint32Array(out.buffer, 0, 4);
    header.set([0x3246524d, c.count, p.dictionary.length, 2]);
    let cursor = 16;
    new Int32Array(out.buffer, cursor, p.dictionary.length).set(p.dictionary);
    cursor += p.dictionary.byteLength;
    const offsets = new Uint32Array(out.buffer, cursor, c.count);
    cursor += c.count * 4;
    const lengths = new Uint16Array(out.buffer, cursor, c.count);
    cursor += c.count * 2;
    new Uint16Array(out.buffer, cursor, c.count).set(p.keys);
    for (let row = 0; row < c.count; ++row) {
        const unique = r.ids[row], offset = r.offsets[unique];
        offsets[row] = offset < 0 ? 0xffffffff : offset - c.base;
        lengths[row] = r.lengths[unique];
    }
    return out;
}
function prepareGroup(g) {
    if (!(g.scores instanceof Int32Array) || g.ranges === null) { return null; }
    const segments = [], exact = new Map();
    for (const range of g.ranges) {
        const token = prepareScores(g.scores.subarray(range.start, range.start + range.count));
        if (token === null) { return null; } // Group retains its original scores.
        segments.push({...range, token});
        exact.set(range.start + ':' + range.count, token);
    }
    return {segments, exact};
}
function encodeCandidate(c, prepared) {
    if (prepared === null) { return baseline(c); }
    const exact = prepared.exact.get(c.start + ':' + c.count);
    if (exact) { return encodeExact(c, exact); }
    // Unexpected storage/content-dictionary splits must reestablish first-use
    // dictionary order and compact/legacy choice through the original encoder.
    const values = new Int32Array(c.count);
    let written = 0;
    for (const segment of prepared.segments) {
        const first = Math.max(c.start, segment.start);
        const end = Math.min(c.start + c.count, segment.start + segment.count);
        if (end <= first) { continue; }
        const p = plan(segment.token);
        for (let row = first; row < end; ++row) { values[row - c.start] = p.dictionary[p.keys[row - segment.start]]; }
        written += end - first;
    }
    assert.equal(written, c.count, 'Prepared score coverage');
    return encodeRestored(c, values);
}
function decoded(bytes, count) {
    if (count === 0) { assert.equal(bytes.length, 0); return () => null; }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length === count * 12 || bytes.length === count * 16) {
        const width = bytes.length / count;
        return (row) => [view.getUint32(row * width, true), view.getUint32(row * width + 4, true),
            width === 16 ? view.getFloat64(row * width + 8, true) : view.getInt32(row * width + 8, true)];
    }
    assert.equal(view.getUint32(0, true), 0x3246524d);
    assert.equal(view.getUint32(4, true), count);
    const size = view.getUint32(8, true);
    assert(size > 0 && size < 65535);
    assert.equal(view.getUint32(12, true), 2);
    assert.equal(bytes.length, 16 + 4 * size + 8 * count);
    const offsetStart = 16 + 4 * size, lengthStart = offsetStart + 4 * count, keyStart = lengthStart + 2 * count;
    return (row) => {
        const key = view.getUint16(keyStart + row * 2, true);
        assert(key < size);
        const length = view.getUint16(lengthStart + row * 2, true);
        return [view.getUint32(offsetStart + row * 4, true), length === 65535 ? 0xffffffff : length, view.getInt32(16 + key * 4, true)];
    };
}
function equalBytes(c, prepared) {
    const a = baseline(c), b = encodeCandidate(c, prepared);
    assert.deepEqual(b, a, 'Exact record-field bytes');
    const da = decoded(a, c.count), db = decoded(b, c.count);
    for (let row = 0; row < c.count; ++row) {
        assert.deepEqual(db(row), da(row));
        assert(Object.is(db(row)[2], c.group.scores[c.start + row]));
    }
    return b;
}
function selfTests() {
    const values = [-2147483648, -257, -256, 0, 255, 256, 2147483647];
    const fixture = (count = 128) => {
        const g = {scores: Int32Array.from({length: count}, (_, i) => values[i % values.length]), ranges: [{start: 0, count}]};
        const c = makeCase(g, 0, count, Uint32Array.from({length: count}, (_, i) => i),
            Float64Array.from({length: count}, (_, i) => 2 ** 40 + i * 19),
            Uint32Array.from({length: count}, (_, i) => i % 31), 2 ** 40);
        return {g, c};
    };
    let checked = 0;
    for (const length of [0, 65534, 65535, 65536, 0xffffffff]) {
        const {g, c} = fixture(), r = contentData.get(c);
        r.lengths[2] = length; r.offsets[3] = -1;
        equalBytes(c, prepareGroup(g)); ++checked;
    }
    for (const legacy of [false, true]) {
        const {g, c} = fixture(), r = contentData.get(c), p = prepareGroup(g);
        if (legacy) { r.lengths[0] = 65535; }
        r.ids[127] = r.lengths.length;
        let a, b;
        try { baseline(c); } catch (e) { a = e; }
        try { encodeCandidate(c, p); } catch (e) { b = e; }
        assert(a instanceof RangeError && b instanceof RangeError);
        assert.equal(b.message, a.message); ++checked;
    }
    const {g, c} = fixture(), p = prepareGroup(g), r = contentData.get(c);
    for (const [start, count] of [[1, 63], [31, 65], [64, 64]]) {
        equalBytes(makeCase(g, start, count, r.ids.subarray(start, start + count), r.offsets, r.lengths, c.base), p);
        ++checked;
    }
    // A split spanning two producer plans must also reconstruct a single range.
    const two = fixture(); two.g.ranges = [{start: 0, count: 64}, {start: 64, count: 64}];
    const rr = contentData.get(two.c), pp = prepareGroup(two.g);
    equalBytes(makeCase(two.g, 31, 65, rr.ids.subarray(31, 96), rr.offsets, rr.lengths, two.c.base), pp); ++checked;
    const expected = encodeCandidate(c, p); g.scores.fill(99);
    assert.deepEqual(encodeCandidate(c, p), expected, 'Plan owns an immutable score snapshot'); ++checked;
    assert.throws(() => restoreScores({}, 0, 1), TypeError);
    assert.throws(() => restoreScores(p.segments[0].token, 127, 2), RangeError); checked += 2;
    for (const scores of [new Int32Array(0), Int32Array.from({length: 128}, (_, i) => i),
        Int32Array.from({length: 65535}, (_, i) => i), new Float64Array([1.5, -0]),
        new Int32Array(new SharedArrayBuffer(128 * 4))]) {
        assert.equal(prepareScores(scores), null); ++checked;
    }
    return checked;
}

const report = {
    schemaVersion: 1, complete: false, pinnedSource: PIN, gitHead,
    scope: 'Node record-field encoder component on actual complete pinned JMdict parser output. Native parser and ordinary three-worker source grouping are real. Content offsets are deterministic synthetic raw spans; persistence, compression, global content dedup, UI, and worker transfer of score plans are not timed or qualified.',
    limitations: [
        'Unmodified production encoder versus an experimental private replacement score representation.',
        'No production integration, browser timing, full-import speedup, total process peak-memory or native-ABI claim.',
        'Column byte accounting excludes JS Map/object overhead, native WASM heap retention, and benchmark capture copies.',
        'The experiment bypasses worker transport/admission of prepared score plans; a real implementation must validate and own that boundary.',
    ],
    node: process.version, platform: process.platform, arch: process.arch,
    cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length,
    hardwareHints: {hardwareConcurrency: 4, deviceMemory: 8},
    plan: {warmupRounds: 3, blocks, repeats, arms: ['baselineA', 'preparedSink', 'preparation', 'baselineC', 'total'], retainAllObservations: true},
    sourceGroups: [], groups: [], observations: [],
};
const groups = [], cases = [], terminations = [];
const fieldDigest = createHash('sha256'), lookupDigest = createHash('sha256');
let pipeline = null, zipReader = null, parser = null;
let totalRows = 0, contentBase = 2 ** 40;
function preparedRanges(indexes, count) {
    if (!(indexes instanceof Map)) { return null; }
    const ranges = [];
    for (const key of indexes.keys()) {
        const m = /^([0-9]+):([0-9]+)$/.exec(key);
        if (m === null) { return null; }
        const start = Number(m[1]), size = Number(m[2]);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || size <= 0) { return null; }
        ranges.push({start, count: size});
    }
    ranges.sort((a, b) => a.start - b.start);
    let covered = 0;
    for (const r of ranges) { if (r.start !== covered) { return null; } covered += r.count; }
    return covered === count ? ranges : null;
}
async function captureChunk(chunk) {
    const dedup = chunk.contentDedupPlan;
    assert(dedup && chunk.contentUniqueIndexList instanceof Uint32Array);
    assert(chunk.contentMetaList instanceof Uint32Array);
    const group = {
        index: groups.length, rowCount: chunk.rowCount,
        scores: chunk.scoreList instanceof Int32Array ? new Int32Array(chunk.scoreList) : new Float64Array(chunk.scoreList),
        ranges: preparedRanges(chunk.preparedLookupIndexes, chunk.rowCount), cases: [],
    };
    const offsets = new Float64Array(dedup.uniqueCount), lengths = new Uint32Array(dedup.uniqueCount);
    for (let i = 0; i < dedup.uniqueCount; ++i) {
        const meta = (chunk.contentMetaByUniqueIndex ? i : dedup.uniqueRowIndexes[i]) * 4;
        offsets[i] = contentBase + chunk.contentMetaList[meta];
        lengths[i] = chunk.contentMetaList[meta + 1];
    }
    const captureStore = new module.TermRecordOpfsStore();
    const original = captureStore._encodeArtifactRecordFields.bind(captureStore);
    let capturedRows = 0;
    captureStore._encodeArtifactRecordFields = (run, contentOffsets, contentLengths, base) => {
        const refs = run.resolvedContentReferences;
        assert(refs && run.scoreList.length === run.rowCount);
        assert.deepEqual(run.scoreList, group.scores.subarray(capturedRows, capturedRows + run.rowCount));
        const c = makeCase(group, capturedRows, run.rowCount,
            refs.uniqueIndexList, refs.offsets, refs.lengths, base);
        group.cases.push(c); cases.push(c); capturedRows += run.rowCount;
        const bytes = original(run, contentOffsets, contentLengths, base);
        assert.deepEqual(baseline(c), bytes);
        return bytes;
    };
    captureStore._appendEncodedChunk = async (...args) => {
        lookupDigest.update(args[5]); fieldDigest.update(args[6]);
    };
    const recordChunk = module.createArtifactTermRecordChunkWithResolvedContent(
        {...chunk, dictionary: report.fixture.expectedTitle},
        chunk.contentUniqueIndexList, offsets, lengths, chunk.preparedLookupIndexes);
    await captureStore._encodeAndAppendArtifactChunkForState(
        {}, recordChunk, totalRows + 1, new Float64Array(0), new Uint32Array(0),
        chunk.termRecordPreinternedPlan, 'raw', chunk.preparedLookupIndexes);
    assert.equal(capturedRows, chunk.rowCount);
    groups.push(group);
    totalRows += chunk.rowCount;
    const contentBytes = chunk.contentBytesLength ?? chunk.contentBytesBuffer.byteLength;
    assert(Number.isSafeInteger(contentBytes) && contentBytes >= 0);
    contentBase += contentBytes;
    report.groups.push({
        index: group.index, rows: chunk.rowCount, scoreType: group.scores.constructor.name,
        preparedLookupRanges: group.ranges,
        recordRanges: group.cases.map((c) => ({start: c.start, count: c.count})),
    });
    process.stderr.write('Captured JMdict rows ' + totalRows + '/' + report.fixture.termRows + '\n');
}
async function capture() {
    const lockBytes = await readFile(join(root, 'test/perf/dictionaries.lock.json'));
    const fixture = JSON.parse(lockBytes).dictionaries.jmdict;
    report.fixture = fixture; report.lockSha256 = sha(lockBytes);
    const digest = createHash('sha256'); let fileBytes = 0;
    for await (const bytes of createReadStream(zipPath)) { digest.update(bytes); fileBytes += bytes.length; }
    assert.equal(fileBytes, fixture.sizeBytes); assert.equal(digest.digest('hex'), fixture.sha256);
    const wasmBytes = await readFile(join(root, 'ext/lib/term-bank-parser.wasm'));
    assert.equal(sha(wasmBytes), '8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee');
    report.parserWasmSha256 = sha(wasmBytes);
    report.sourceHashes = {};
    for (const path of ['ext/js/dictionary/term-record-opfs-store.js', 'ext/js/dictionary/term-bank-wasm-parser.js',
        'ext/js/dictionary/term-bank-wasm-parser-worker.js', 'ext/js/dictionary/term-bank-source-pipeline.js',
        'ext/js/dictionary/term-lookup-index-preparation.js']) {
        report.sourceHashes[path] = sha(await readFile(join(root, path)));
    }
    report.driverSha256 = sha(await readFile(fileURLToPath(import.meta.url)));
    parser = await local('ext/js/dictionary/term-bank-wasm-parser.js');
    parser.setTermBankWasmModule(await WebAssembly.compile(wasmBytes));
    class BrowserWorker extends EventTarget {
        constructor(url) {
            super();
            this.worker = new ThreadWorker(pathToFileURL(join(root, 'test/fixtures/parser-settlement/worker-node.mjs')),
                {workerData: {url: url.href}});
            this.worker.on('message', (data) => this.dispatchEvent(new MessageEvent('message', {data})));
            this.worker.on('error', (error) => {
                const event = new Event('error'); Object.defineProperty(event, 'message', {value: error.message});
                this.dispatchEvent(event);
            });
            this.worker.on('messageerror', () => this.dispatchEvent(new MessageEvent('messageerror')));
        }
        postMessage(data, transfer) {
            if (data.type === 'parse') {
                report.sourceGroups.push({
                    id: data.id, files: data.sourceMetadata?.map(({filename}) => filename) ?? null,
                    sourceBytes: data.sourceBuffers.map((buffer) => buffer.byteLength),
                });
            }
            this.worker.postMessage(data, transfer);
        }
        terminate() { terminations.push(this.worker.terminate()); }
    }
    globalThis.Worker = BrowserWorker;
    Object.defineProperty(globalThis, 'navigator', {configurable: true, value: report.hardwareHints});
    assert.equal(parser.getParallelTermBankParserWorkerCount(), 3);
    const {BlobReader, Uint8ArrayWriter, ZipReader} = await local('node_modules/@zip.js/zip.js/index.js');
    const {RawZipPayloadReader, TermBankSourcePipeline} = await local('ext/js/dictionary/term-bank-source-pipeline.js');
    const archive = await openAsBlob(zipPath), raw = new RawZipPayloadReader(archive);
    zipReader = new ZipReader(new BlobReader(archive), {useWebWorkers: false});
    const termFiles = (await zipReader.getEntries())
        .filter(({filename}) => /^term_bank_\d+\.json$/.test(filename))
        .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)));
    pipeline = new TermBankSourcePipeline({
        termFiles, enabled: true,
        read: async (file) => file.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true}),
        readCompressed: async (file, signal) => raw.read(file, signal),
    });
    report.profiles = [];
    for (let start = 0; start < termFiles.length;) {
        const run = pipeline.createCompressedImportRunPlan(start);
        assert(run !== null, 'This screen requires the ordinary compressed native worker path');
        const ok = await parser.parseTermBankWithWasmColumnChunksParallelCompressedLazy(
            run.loaders, run.estimatedByteLengths, 3, captureChunk, {
                emitTermByteLists: false, computeContentHashes: true, emitContentSlab: true,
                emitTokenBinaryContent: true, mediaHintFastScan: false, projectImagePaths: false,
                validateGlossaryTypes: true, prepareLookupIndexes: true, maxPendingChunks: 2,
            });
        assert.equal(ok, true);
        report.profiles.push(parser.consumeLastTermBankWasmParseProfile());
        pipeline.releaseBatch(run.files); start += run.files.length;
    }
    assert.equal(totalRows, fixture.termRows);
    assert.equal(totalRows, 528299);
    assert.equal(groups.length, 12, 'Frozen JMdict three-worker grouping changed');
}
async function cleanupCapture() {
    await pipeline?.dispose();
    await parser?.disposeParallelTermBankParser();
    await Promise.all(terminations);
    await zipReader?.close();
    pipeline = null; zipReader = null; parser = null;
}

function median(values) { const a = [...values].sort((a, b) => a - b); return a.length % 2 ? a[a.length >> 1] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2; }
function pairedSummary(arm, control = 'baselineA', field = 'msPerCorpus') {
    const pairs = [];
    for (let block = 0; block < blocks; ++block) {
        const a = report.observations.find((x) => x.block === block && x.arm === control);
        const b = report.observations.find((x) => x.block === block && x.arm === arm);
        assert(a && b);
        pairs.push({a: a[field], b: b[field], percent: 100 * (b[field] / a[field] - 1)});
    }
    let seed = 20261128;
    const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    const boot = [];
    for (let trial = 0; trial < 10000; ++trial) {
        boot.push(median(Array.from({length: pairs.length}, () => pairs[Math.floor(rand() * pairs.length)].percent)));
    }
    boot.sort((a, b) => a - b);
    return {
        arm, control, field, pairs: pairs.length,
        baselineMedian: median(pairs.map((p) => p.a)), candidateMedian: median(pairs.map((p) => p.b)),
        pairedMedianChange: median(pairs.map((p) => p.b - p.a)),
        pairedMedianPercent: median(pairs.map((p) => p.percent)),
        pairedBootstrap95Percent: [boot[249], boot[9749]],
        fasterPairs: pairs.filter((p) => p.b < p.a).length,
    };
}
let preparedGroups;
function invoke(arm) {
    if (arm === 'baselineA' || arm === 'baselineC') {
        for (const c of cases) { touch(baseline(c)); }
    } else if (arm === 'preparedSink') {
        for (const c of cases) { touch(encodeCandidate(c, preparedGroups[c.group.index])); }
    } else if (arm === 'preparation') {
        for (const g of groups) {
            const p = prepareGroup(g);
            if (p !== null) {
                for (const s of p.segments) {
                    const data = plan(s.token);
                    checksum = (checksum + s.token.retainedBytes + data.keys.at(-1) + data.dictionary[0]) >>> 0;
                }
            }
        }
    } else if (arm === 'total') {
        // Charge producer work once per group, then consume that group; do not
        // pretend prepared keys are free or build every group before consuming.
        for (const g of groups) {
            const p = prepareGroup(g);
            for (const c of g.cases) { touch(encodeCandidate(c, p)); }
        }
    } else { throw new Error('Unknown arm'); }
}
function sample(arm, count) {
    globalThis.gc(); // Outside the timing; automatic GC during the loop remains charged.
    const cpu = process.cpuUsage(), start = performance.now();
    for (let i = 0; i < count; ++i) { invoke(arm); }
    const elapsedMs = performance.now() - start, cpuDelta = process.cpuUsage(cpu);
    return {elapsedMs, msPerCorpus: elapsedMs / count, cpuMsPerCorpus: (cpuDelta.user + cpuDelta.system) / 1000 / count};
}
try {
    report.syntheticSelfTests = selfTests();
    await capture();
    await cleanupCapture(); // No parser worker may overlap component timing.
    report.captureRecordFieldsSha256 = fieldDigest.digest('hex');
    report.captureLookupBytesSha256 = lookupDigest.digest('hex');
    preparedGroups = groups.map(prepareGroup);
    const allBytes = createHash('sha256');
    let preparedRows = 0, exactFastRows = 0, fallbackRows = 0;
    let baselineScoreBytes = 0, replacementScoreBytes = 0, distinctScores = 0, retainedPreparedBytes = 0;
    for (const g of groups) {
        const p = preparedGroups[g.index];
        baselineScoreBytes += g.scores.byteLength;
        if (p === null) { replacementScoreBytes += g.scores.byteLength; }
        else {
            preparedRows += g.rowCount;
            for (const segment of p.segments) {
                replacementScoreBytes += segment.token.retainedBytes;
                retainedPreparedBytes += segment.token.retainedBytes;
                distinctScores += segment.token.distinct;
            }
        }
        report.groups[g.index].scorePlans = p?.segments.map((s) => ({start: s.start, count: s.count, ...s.token})) ?? null;
        for (const c of g.cases) {
            const bytes = equalBytes(c, p);
            allBytes.update(bytes);
            const token = p?.exact.get(c.start + ':' + c.count), refs = contentData.get(c);
            const fast = token && !refs.ids.some((index) => refs.lengths[index] >= 65535);
            if (fast) { exactFastRows += c.count; } else { fallbackRows += c.count; }
        }
    }
    report.replayRecordFieldsSha256 = allBytes.digest('hex');
    assert.equal(report.replayRecordFieldsSha256, report.captureRecordFieldsSha256);
    report.corpus = {rows: totalRows, parserGroups: groups.length, recordChunks: cases.length,
        preparedRows, exactFastRows, fallbackRows, distinctScoresAcrossPlans: distinctScores};
    report.columnBytes = {
        baselineOwnedScores: baselineScoreBytes,
        replacementOwnedScores: replacementScoreBytes,
        replacementBytesSaved: baselineScoreBytes - replacementScoreBytes,
        retainedOriginalVariantExtraBytes: retainedPreparedBytes,
        baselineScoreKeyScratchAcrossEligibleEncodes: exactFastRows * 2,
        preparedSinkScoreKeyScratchAcrossExactEncodes: 0,
        note: 'Cumulative typed score columns across the corpus, not simultaneous process memory. Both arms retain the same corpus capture during timing. A replacement plan holds no reference to original Int32 scores. Output record bytes are identical. Temporary JS maps/arrays and WASM heap are not included.',
    };
    const arms = report.plan.arms;
    for (let warmup = 0; warmup < report.plan.warmupRounds; ++warmup) {
        for (const arm of arms) { sample(arm, 1); }
    }
    for (let block = 0; block < blocks; ++block) {
        let order = arms.slice(block % arms.length).concat(arms.slice(0, block % arms.length));
        if (block % 2) { order = order.reverse(); }
        for (let position = 0; position < order.length; ++position) {
            const arm = order[position], values = sample(arm, repeats);
            report.observations.push({block, position, arm, repeats, ...values});
        }
        process.stderr.write('Completed component block ' + (block + 1) + '/' + blocks + '\n');
    }
    report.summary = {
        sink: pairedSummary('preparedSink'),
        chargedPreparationAndSink: pairedSummary('total'),
        independentBaselineControl: pairedSummary('baselineC'),
        cpuSink: pairedSummary('preparedSink', 'baselineA', 'cpuMsPerCorpus'),
        cpuChargedPreparationAndSink: pairedSummary('total', 'baselineA', 'cpuMsPerCorpus'),
        preparationMedianMsPerCorpus: median(report.observations.filter((x) => x.arm === 'preparation').map((x) => x.msPerCorpus)),
        preparationMedianCpuMsPerCorpus: median(report.observations.filter((x) => x.arm === 'preparation').map((x) => x.cpuMsPerCorpus)),
        checksum,
    };
    report.complete = true;
} catch (error) {
    report.error = {message: String(error), stack: error?.stack};
    process.exitCode = 1;
} finally {
    try { await cleanupCapture(); } catch (error) {
        report.complete = false; report.cleanupError = String(error); process.exitCode = 1;
    }
    await mkdir(dirname(output), {recursive: true});
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
    const {profiles, sourceGroups, ...logReceipt} = report;
    console.log('PREPARED_SCORE_SCREEN_RESULT ' + JSON.stringify(logReceipt));
}
