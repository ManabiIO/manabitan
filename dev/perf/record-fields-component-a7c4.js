#!/usr/bin/env node
// Fixed feasibility screen for native record-field encoding; not browser/import timing.
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile, execFileSync} from 'node:child_process';
import {promisify, parseArgs} from 'node:util';
import {performance} from 'node:perf_hooks';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const {values: options} = parseArgs({
    options: {
        'source-root': {type: 'string'},
        'capture-dir': {type: 'string'},
        wrapper: {type: 'string'},
        wasm: {type: 'string'},
        out: {type: 'string'},
        child: {type: 'string'},
        'verify-only': {type: 'boolean', default: false},
    },
});
for (const key of ['source-root', 'capture-dir', 'wrapper', 'wasm', 'out']) {
    if (!options[key]) { throw new Error('Missing --' + key); }
}
const sourceRoot = path.resolve(options['source-root']);
const captureDir = path.resolve(options['capture-dir']);
const wrapperPath = path.resolve(options.wrapper);
const wasmPath = path.resolve(options.wasm);
const outputPath = path.resolve(options.out);
const runnerPath = fileURLToPath(import.meta.url);
const expectedCommit = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2';
const expectedRows = [50000, 40000, 40000, 40000, 50000, 50000, 40000, 50000, 40000, 40000, 40000, 48299];
const schedule = ['AA', 'AB', 'BA', 'AB', 'AA'];
const protocol = {
    schedule,
    freshObservations: 10,
    warmupCorpusPasses: 2,
    measuredCorpusPasses: 5,
    timer: 'performance.now; process.cpuUsage, summed across the five measured passes',
    measured: 'Full field-encoder calls: native eligibility, input copies, C kernel, owned output copy, and actual JS fallback. Twelve owned outputs retained until each pass oracle.',
    excluded: 'Capture, source and data checks, module compilation/instantiation, offset-base admission, byte equality, input hashes, output ownership checks, memory snapshots.',
    limits: 'Actual ordinary JMdict scores/raw lengths/row-to-unique IDs, controlled raw-cumulative offsets. CPU component feasibility only; no browser, whole import, compressed-reference geometry or peak-memory claim.',
    nativeMemoryBytes: 4 * 1024 * 1024,
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
const bytesOf = (view) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
const formatOf = (bytes, count) => bytes.length === count * 12 ? 'legacy' : bytes.length === count * 16 ? 'float64' : 'compact';
const writeJson = async (file, data) => writeFile(file, JSON.stringify(data, null, 2) + '\n');
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
await mkdir(path.dirname(outputPath), {recursive: true});
assert.equal(process.version, 'v22.22.0', 'This frozen feasibility uses Node 22.22.0');
assert.equal(new Uint8Array(new Uint32Array([0x01020304]).buffer)[0], 4, 'Capture typed-array files require little endian');

async function loadInputs() {
    const manifestBytes = await readFile(path.join(captureDir, 'manifest.json'));
    const manifest = JSON.parse(manifestBytes);
    assert.equal(manifest.partial, false);
    assert.equal(manifest.sourceCommit, expectedCommit);
    assert.equal(manifest.dictionary, 'jmdict');
    assert.equal(manifest.rows, 528299);
    assert.equal(manifest.recordBatches.length, 12);
    assert.deepEqual(manifest.recordBatches.map((batch) => batch.rowCount), expectedRows);
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], {cwd: sourceRoot, encoding: 'utf8'}).trim(), expectedCommit);
    const dirty = execFileSync('git', ['diff', '--name-only'], {cwd: sourceRoot, encoding: 'utf8'}).trim();
    assert.equal(dirty, 'ext/js/dictionary/term-record-opfs-store.js', 'Only the declared export suffix may differ');
    for (const [relativePath, digest] of Object.entries(manifest.sourceHashes)) {
        assert.equal(hash(await readFile(path.join(sourceRoot, relativePath))), digest, 'Source drift: ' + relativePath);
    }
    const storePath = path.join(sourceRoot, 'ext/js/dictionary/term-record-opfs-store.js');
    const storeSource = await readFile(storePath, 'utf8');
    assert(storeSource.endsWith(manifest.recordStoreOverlay));
    assert.equal(hash(storeSource), manifest.instrumentedRecordStoreSha256);
    assert.equal(hash(storeSource.slice(0, -manifest.recordStoreOverlay.length)), manifest.originalRecordStoreSha256);
    const module = await import(pathToFileURL(storePath).href);
    const store = new module.TermRecordOpfsStore();
    const constructors = {Int32Array, Uint32Array, Float64Array};
    const batches = [];
    for (const record of manifest.recordBatches) {
        const columns = {};
        for (const [name, field] of Object.entries(record.fields)) {
            assert.equal(path.basename(field.filename), field.filename);
            const bytes = await readFile(path.join(captureDir, field.filename));
            assert.equal(bytes.byteLength, field.bytes);
            assert.equal(hash(bytes), field.sha256);
            const Constructor = constructors[field.type];
            assert(Constructor);
            assert.equal(field.elements * Constructor.BYTES_PER_ELEMENT, bytes.byteLength);
            const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            columns[name] = new Constructor(buffer);
        }
        const {scores, uniqueIndexes, offsets, lengths, flatOffsets, flatLengths} = columns;
        assert(scores instanceof Int32Array && uniqueIndexes instanceof Uint32Array);
        assert(offsets instanceof Float64Array && lengths instanceof Uint32Array);
        const chunk = module.createArtifactTermRecordChunkWithResolvedContent(
            {dictionary: record.dictionary, rowCount: record.rowCount, scoreList: scores},
            uniqueIndexes, offsets, lengths,
        );
        assert(module.getSynchronousRecordFieldReferences(chunk, chunk.rowCount));
        const base = validateBase(module, chunk, flatOffsets, flatLengths);
        assert.equal(base, record.contentOffsetBase);
        assert.equal(path.basename(record.expected.filename), record.expected.filename);
        const expected = await readFile(path.join(captureDir, record.expected.filename));
        assert.equal(expected.length, record.expected.bytes);
        assert.equal(hash(expected), record.expected.sha256);
        assert.equal(formatOf(expected, chunk.rowCount), record.expected.format);
        batches.push({chunk, base, flatOffsets, flatLengths, columns, expected, record});
    }
    const wrapperBytes = await readFile(wrapperPath);
    const wasmBytes = await readFile(wasmPath);
    const identities = {
        baselineCommit: expectedCommit,
        captureManifestSha256: hash(manifestBytes),
        fixtureSha256: manifest.dictionaryArchiveSha256,
        captureScriptSha256: manifest.captureScriptSha256,
        ownershipSupportSha256: manifest.ownershipSupportSha256,
        captureSourceHashes: manifest.sourceHashes,
        originalRecordStoreSha256: manifest.originalRecordStoreSha256,
        instrumentedRecordStoreSha256: manifest.instrumentedRecordStoreSha256,
        recordStoreOverlay: manifest.recordStoreOverlay,
        wrapperSha256: hash(wrapperBytes),
        wasmSha256: hash(wasmBytes),
        wasmBytes: wasmBytes.byteLength,
        runnerSha256: hash(await readFile(runnerPath)),
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        rowCounts: expectedRows,
        inputDigest: digestInputs(batches),
        expectedOutputDigest: digestExpected(batches),
        fieldBytesPerCorpus: batches.reduce((sum, batch) => sum + batch.expected.byteLength, 0),
        batches: batches.map(({record}) => ({
            group: record.group, rowCount: record.rowCount, referenceCount: record.referenceCount,
            distinctScores: record.distinctScores, base: record.contentOffsetBase,
            bytes: record.expected.bytes, format: record.expected.format,
        })),
    };
    return {manifest, module, store, batches, identities, wasmBytes};
}

function validateBase(module, chunk, flatOffsets, flatLengths) {
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    for (let row = 0; row < chunk.rowCount; ++row) {
        const offset = module.getArtifactContentOffset(chunk, flatOffsets, row);
        const length = module.getArtifactContentLength(chunk, flatLengths, row);
        module.validateContentOffset(offset);
        module.validateContentLength(length);
        if (offset >= 0) {
            minimum = Math.min(minimum, offset);
            maximum = Math.max(maximum, offset);
        }
    }
    const base = minimum === Number.POSITIVE_INFINITY ? 0 : minimum;
    module.getContentOffsetDelta(maximum, base);
    return base;
}

function digestInputs(batches) {
    const digest = createHash('sha256');
    for (const {columns, chunk, base} of batches) {
        digest.update(JSON.stringify([chunk.rowCount, chunk.dictionary, base]));
        for (const name of Object.keys(columns).sort()) {
            const column = columns[name];
            digest.update(name + ':' + column.constructor.name + ':' + column.byteLength + '\n');
            digest.update(bytesOf(column));
        }
    }
    return digest.digest('hex');
}

function digestExpected(batches) {
    const digest = createHash('sha256');
    for (const batch of batches) { digest.update(batch.expected); }
    return digest.digest('hex');
}

async function initializeNative(context) {
    const {createCompactRecordFieldEncoder} = await import(pathToFileURL(wrapperPath).href);
    const {module, wasmBytes} = context;
    return await createCompactRecordFieldEncoder(
        wasmBytes, module.getSynchronousRecordFieldReferences,
        module.getResolvedContentReferenceOriginForExperiment,
    );
}

function assertOwnedOutputs(outputs, batches) {
    const seen = new Set();
    const inputBuffers = new Set(batches.flatMap((batch) => Object.values(batch.columns).map((view) => view.buffer)));
    for (let index = 0; index < outputs.length; ++index) {
        const output = outputs[index];
        assert(output instanceof Uint8Array);
        assert(output.buffer instanceof ArrayBuffer && !(typeof SharedArrayBuffer !== 'undefined' && output.buffer instanceof SharedArrayBuffer));
        assert.equal(output.byteOffset, 0);
        assert.equal(output.byteLength, output.buffer.byteLength, 'Output must be an exact owned allocation');
        assert(!seen.has(output.buffer), 'Output buffers alias each other');
        assert(!inputBuffers.has(output.buffer), 'Output aliases an input');
        seen.add(output.buffer);
        assert(Buffer.from(output).equals(batches[index].expected), 'Full-byte mismatch in group ' + index);
    }
}

function statsDelta(before, after) {
    const result = {};
    for (const key of ['calls', 'successes', 'fallbacks', 'inputCopyBytes', 'outputCopyBytes']) {
        result[key] = (after?.[key] ?? 0) - (before?.[key] ?? 0);
    }
    result.peakLayoutBytes = after?.peakLayoutBytes ?? 0;
    result.memoryBytes = after?.memoryBytes ?? 0;
    return result;
}

function runPass(context, native, arm, timed) {
    const {store, batches, identities} = context;
    const outputs = new Array(batches.length);
    const beforeStats = native ? {...native.stats} : null;
    let nativeSuccesses = 0;
    let nativeFallbacks = 0;
    const beforeCpu = timed ? process.cpuUsage() : null;
    const start = timed ? performance.now() : 0;
    for (let index = 0; index < batches.length; ++index) {
        const {chunk, flatOffsets, flatLengths, base} = batches[index];
        let output = null;
        if (arm === 'B') {
            output = native.tryEncodeCompactRecordFields(chunk, base);
            if (output === null) { ++nativeFallbacks; } else { ++nativeSuccesses; }
        }
        outputs[index] = output ?? store._encodeArtifactRecordFields(chunk, flatOffsets, flatLengths, base);
    }
    const elapsedMs = timed ? performance.now() - start : null;
    const cpu = timed ? process.cpuUsage(beforeCpu) : null;
    assertOwnedOutputs(outputs, batches);
    assert.equal(digestInputs(batches), identities.inputDigest, 'Encoder mutated input columns');
    const digest = createHash('sha256');
    let outputBytes = 0;
    for (const output of outputs) { digest.update(output); outputBytes += output.byteLength; }
    assert.equal(digest.digest('hex'), identities.expectedOutputDigest);
    const result = {
        elapsedMs,
        cpuUserMs: cpu === null ? null : cpu.user / 1000,
        cpuSystemMs: cpu === null ? null : cpu.system / 1000,
        cpuTotalMs: cpu === null ? null : (cpu.user + cpu.system) / 1000,
        rows: 528299, chunks: batches.length, outputBytes,
        nativeSuccesses, nativeFallbacks,
        baselineCalls: arm === 'A' ? batches.length : nativeFallbacks,
        nativeStats: statsDelta(beforeStats, native?.stats),
        outputDigest: identities.expectedOutputDigest,
        inputDigest: identities.inputDigest,
        byteEquality: true, ownedOutputs: true, inputUnchanged: true,
    };
    return result;
}

async function runControls(context, native) {
    const {module, store} = context;
    const results = [];
    const make = (count = 64) => {
        const scores = Int32Array.from({length: count}, (_, i) => [-2147483648, -50000, -257, -256, -1, 0, 255, 256, 50000, 2147483647][i % 10]);
        const unique = Uint32Array.from({length: count}, (_, i) => i);
        const offsets = Float64Array.from({length: count}, (_, i) => 1000 + i * 31);
        const lengths = new Uint32Array(count).fill(20);
        const chunk = module.createArtifactTermRecordChunkWithResolvedContent(
            {dictionary: 'control', rowCount: count, scoreList: scores}, unique, offsets, lengths,
        );
        return {chunk, flatOffsets: Array.from(offsets), flatLengths: Array.from(lengths), observers: {}};
    };
    const countObserver = (state, key) => { state.observers[key] = (state.observers[key] ?? 0) + 1; };
    const proxied = (value, state, label) => new Proxy(value, {
        get(target, key) { countObserver(state, label + '.get'); return Reflect.get(target, key, target); },
        getPrototypeOf(target) { countObserver(state, label + '.prototype'); return Reflect.getPrototypeOf(target); },
        getOwnPropertyDescriptor(target, key) { countObserver(state, label + '.descriptor'); return Reflect.getOwnPropertyDescriptor(target, key); },
    });
    async function compare(name, setup, expectation = 'fallback') {
        const execute = (arm) => {
            const state = setup();
            let nativeAccepted = false;
            let bytes = null;
            let error = null;
            try {
                const base = validateBase(module, state.chunk, state.flatOffsets, state.flatLengths);
                let encoded = null;
                if (arm === 'B') {
                    encoded = native.tryEncodeCompactRecordFields(state.chunk, base);
                    nativeAccepted = encoded !== null;
                }
                bytes = encoded ?? store._encodeArtifactRecordFields(state.chunk, state.flatOffsets, state.flatLengths, base);
                bytes = Buffer.from(bytes);
            } catch (caught) { error = {name: caught.name, message: caught.message}; }
            finally { state.cleanup?.(); }
            return {nativeAccepted, bytes, error, observers: state.observers};
        };
        const a = execute('A');
        const b = execute('B');
        assert.deepEqual(b.error, a.error, name + ' error parity');
        assert.deepEqual(b.observers, a.observers, name + ' observer parity');
        if (a.bytes !== null) { assert(b.bytes?.equals(a.bytes), name + ' bytes'); }
        if (expectation === 'native') { assert.equal(b.nativeAccepted, true, name + ' should enter native path'); }
        if (expectation === 'fallback') { assert.equal(b.nativeAccepted, false, name + ' should fall back'); }
        if (expectation === 'admission-error') { assert(a.error, name + ' admission must reject'); }
        results.push({
            name, expectation, nativeAccepted: b.nativeAccepted, bytes: b.bytes?.length ?? 0,
            outputSha256: b.bytes === null ? null : hash(b.bytes), error: b.error,
            observers: b.observers, passed: true,
        });
    }
    await compare('private mixed signed first-use palette', () => make(), 'native');
    await compare('null offsets and length 65534', () => {
        const s = make(); s.chunk.resolvedContentReferences.offsets[0] = -1;
        s.chunk.resolvedContentReferences.lengths[0] = 0;
        s.chunk.resolvedContentReferences.lengths[1] = 65534; return s;
    }, 'native');
    await compare('large safe base and maximum compact delta', () => {
        const s = make(); const refs = s.chunk.resolvedContentReferences;
        refs.offsets.fill(2 ** 40); refs.offsets[1] += 0xfffffffe; refs.offsets[2] = -1; return s;
    }, 'native');
    await compare('length 65535 selects legacy', () => {
        const s = make(); s.chunk.resolvedContentReferences.lengths[7] = 65535; return s;
    });
    await compare('65534 distinct scores reject compact size', () => {
        const s = make(65534); s.chunk.scoreList = Int32Array.from({length: 65534}, (_, i) => i); return s;
    });
    await compare('65535 distinct scores reserved count and row bound', () => {
        const s = make(65535); s.chunk.scoreList = Int32Array.from({length: 65535}, (_, i) => i); return s;
    });
    await compare('bounded scratch rejects oversized unused references', () => {
        const s = make();
        const offsets = new Float64Array(500000).fill(1000);
        const lengths = new Uint32Array(500000).fill(20);
        s.chunk = module.createArtifactTermRecordChunkWithResolvedContent(s.chunk, s.chunk.resolvedContentReferences.uniqueIndexList, offsets, lengths);
        return s;
    });
    await compare('float64 and signed zero scores', () => {
        const s = make(); s.chunk.scoreList = Float64Array.from(s.chunk.scoreList); s.chunk.scoreList[1] = 0.5; s.chunk.scoreList[2] = -0; return s;
    });
    await compare('fixed span numeric fields', () => {
        const s = make(); s.chunk.fixedContentOffsetBase = 1000; s.chunk.fixedContentLength = 20; return s;
    });
    await compare('shared score column', () => {
        const s = make(); const scores = new Int32Array(new SharedArrayBuffer(s.chunk.scoreList.byteLength)); scores.set(s.chunk.scoreList); s.chunk.scoreList = scores; return s;
    });
    await compare('typed array subclass', () => {
        const s = make(); class Scores extends Int32Array {} s.chunk.scoreList = new Scores(s.chunk.scoreList); return s;
    });
    await compare('foreign plain resolved object', () => {
        const s = make(); s.chunk = {...s.chunk}; return s;
    });
    await compare('foreign proxy chunk without extra traps', () => {
        const s = make(); s.chunk = proxied(s.chunk, s, 'chunk'); return s;
    });
    await compare('factory reference object replaced with proxy', () => {
        const s = make(); s.chunk.resolvedContentReferences = proxied(s.chunk.resolvedContentReferences, s, 'references'); return s;
    });
    await compare('factory score column replaced with proxy', () => {
        const s = make(); s.chunk.scoreList = proxied(s.chunk.scoreList, s, 'scores'); return s;
    });
    await compare('factory score accessor without extra reads', () => {
        const s = make(); const scores = s.chunk.scoreList;
        Object.defineProperty(s.chunk, 'scoreList', {get() { countObserver(s, 'scoreGetter'); return scores; }, configurable: true});
        return s;
    });
    await compare('factory reference accessor without extra reads', () => {
        const s = make(); const refs = s.chunk.resolvedContentReferences; const offsets = refs.offsets;
        Object.defineProperty(refs, 'offsets', {get() { countObserver(s, 'offsetsGetter'); return offsets; }, configurable: true});
        return s;
    });
    await compare('spoofed own byteOffset uses intrinsic coordinates', () => {
        const s = make(); const scores = new Int32Array(new ArrayBuffer((s.chunk.rowCount + 8) * 4), 16, s.chunk.rowCount);
        scores.set(s.chunk.scoreList); Object.defineProperty(scores, 'byteOffset', {value: 0}); s.chunk.scoreList = scores; return s;
    }, 'native');
    await compare('concrete prototype buffer accessor preserves reads', () => {
        const s = make();
        const prototype = Object.getPrototypeOf(Int32Array.prototype);
        const getter = Object.getOwnPropertyDescriptor(prototype, 'buffer').get;
        assert.equal(Object.hasOwn(Int32Array.prototype, 'buffer'), false);
        Object.defineProperty(Int32Array.prototype, 'buffer', {configurable: true, get() { countObserver(s, 'prototypeBuffer'); return getter.call(this); }});
        s.cleanup = () => { delete Int32Array.prototype.buffer; };
        return s;
    });
    await compare('short score list keeps zero default', () => {
        const s = make(); s.chunk.scoreList = s.chunk.scoreList.slice(0, 32); return s;
    });
    await compare('invalid reference index rejected by actual admission', () => {
        const s = make(); s.chunk.resolvedContentReferences.uniqueIndexList[9] = 1000; return s;
    }, 'admission-error');
    await compare('invalid negative offset rejected by actual admission', () => {
        const s = make(); s.chunk.resolvedContentReferences.offsets[9] = -2; return s;
    }, 'admission-error');
    await compare('uint32 null length rejected by actual admission', () => {
        const s = make(); s.chunk.resolvedContentReferences.lengths[9] = 0xffffffff; return s;
    }, 'admission-error');

    async function splitRun(arm) {
        const state = make(96);
        const refs = state.chunk.resolvedContentReferences;
        for (let index = 0; index < 96; ++index) { refs.offsets[index] = index < 32 ? 1000 + index : 1000 + 2 ** 32 + index; }
        Object.assign(state.chunk, {
            expressionBytesList: Array.from({length: 96}, () => new Uint8Array([97])),
            readingBytesList: Array.from({length: 96}, () => new Uint8Array(0)),
            readingEqualsExpressionList: new Uint8Array(96),
            sequenceList: new Int32Array(96),
        });
        const splitStore = new module.TermRecordOpfsStore();
        const outputs = [];
        splitStore._encodeArtifactChunkRecords = async (chunk, offsets, lengths, _plan, _index, base) => {
            const nativeOutput = arm === 'B' ? native.tryEncodeCompactRecordFields(chunk, base) : null;
            const fields = nativeOutput ?? splitStore._encodeArtifactRecordFields(chunk, offsets, lengths, base);
            return {
                contentOffsetBase: base, lookupIndexBytes: new Uint8Array(0), recordFields: fields,
                recordFieldsFormat: formatOf(fields, chunk.rowCount) === 'compact' ? 2 : 0,
                validationMs: 0, recordFieldEncodeMs: 0, lookupIndexEncodeMs: 0,
            };
        };
        splitStore._appendEncodedChunk = async (_storeState, firstId, count, _dictionary, base, _index, fields) => {
            outputs.push({firstId, count, base, fields: Buffer.from(fields)});
            if (outputs.length === 1) {
                await Promise.resolve();
                state.chunk.scoreList[40] = 9999;
            }
        };
        await splitStore._encodeAndAppendArtifactChunkForState({}, state.chunk, 500, state.flatOffsets, state.flatLengths);
        assert.deepEqual(outputs.map((item) => item.count), [32, 64]);
        return outputs;
    }
    const splitA = await splitRun('A');
    const splitB = await splitRun('B');
    assert.deepEqual(splitB, splitA, 'Actual offset-driven split and post-await score mutation');
    results.push({
        name: 'Actual offset admission splits 32/64 and re-reads post-await mutated scores',
        passed: true,
        segments: splitB.map(({firstId, count, base, fields}) => ({firstId, count, base, bytes: fields.length, sha256: hash(fields)})),
    });
    return results;
}

async function runChild(arm) {
    const context = await loadInputs();
    const native = arm === 'A' ? null : await initializeNative(context);
    if (arm === 'VERIFY') {
        const controls = await runControls(context, native);
        const baseline = runPass(context, native, 'A', false);
        const candidate = runPass(context, native, 'B', false);
        assert.equal(candidate.nativeSuccesses, 12, 'All actual JMdict groups must reach the native path');
        const result = {
            kind: 'untimed-correctness', protocol, identities: context.identities,
            controls, baseline, candidate, nativeStats: {...native.stats}, passed: true,
        };
        await writeJson(outputPath, result);
        console.log('A7C4_RECORD_VERIFY ' + JSON.stringify({passed: true, controls: controls.length, groups: 12, rows: 528299, nativeGroups: candidate.nativeSuccesses}));
        return;
    }
    assert(['A', 'B'].includes(arm));
    const warmups = [];
    for (let pass = 0; pass < protocol.warmupCorpusPasses; ++pass) { warmups.push(runPass(context, native, arm, false)); }
    globalThis.gc?.();
    const memoryBefore = process.memoryUsage();
    const passes = [];
    for (let pass = 0; pass < protocol.measuredCorpusPasses; ++pass) { passes.push(runPass(context, native, arm, true)); }
    const memoryAfter = process.memoryUsage();
    const total = {};
    for (const key of ['elapsedMs', 'cpuUserMs', 'cpuSystemMs', 'cpuTotalMs', 'rows', 'chunks', 'outputBytes', 'nativeSuccesses', 'nativeFallbacks', 'baselineCalls']) {
        total[key] = passes.reduce((sum, pass) => sum + pass[key], 0);
    }
    const result = {
        kind: 'fresh-process-observation', arm, protocol, identities: context.identities,
        warmups, passes, total, memoryBefore, memoryAfter,
        memoryScope: 'Two snapshots, not peak; candidate alone owns additional fixed 4 MiB native memory.',
        nativeStats: native ? {...native.stats} : null,
        gcAvailable: typeof globalThis.gc === 'function',
        passed: true,
    };
    await writeJson(outputPath, result);
    console.log('A7C4_RECORD_OBSERVATION ' + JSON.stringify({arm, total, identity: context.identities.wasmSha256, passed: true}));
}

async function runParent() {
    const report = {
        kind: 'finite-native-record-field-component', protocol, partial: true, started: new Date().toISOString(),
        observations: [], pairs: [], verification: null, summary: null,
    };
    const stem = outputPath.endsWith('.json') ? outputPath.slice(0, -5) : outputPath;
    const childArgs = [
        '--expose-gc', runnerPath, '--source-root', sourceRoot, '--capture-dir', captureDir,
        '--wrapper', wrapperPath, '--wasm', wasmPath,
    ];
    const spawn = async (arm, label) => {
        const childOutput = stem + '-' + label + '.json';
        let stdout = '';
        let stderr = '';
        try {
            ({stdout, stderr} = await execFileAsync(process.execPath, [...childArgs, '--child', arm, '--out', childOutput], {maxBuffer: 8 * 1024 * 1024}));
        } catch (error) {
            stdout = error.stdout ?? ''; stderr = error.stderr ?? '';
            await writeFile(stem + '-' + label + '.stdout.txt', stdout);
            await writeFile(stem + '-' + label + '.stderr.txt', stderr);
            throw error;
        }
        await writeFile(stem + '-' + label + '.stdout.txt', stdout);
        await writeFile(stem + '-' + label + '.stderr.txt', stderr);
        const observation = JSON.parse(await readFile(childOutput, 'utf8'));
        assert.equal(observation.passed, true);
        return {file: path.basename(childOutput), stdoutFile: path.basename(stem + '-' + label + '.stdout.txt'), stderrFile: path.basename(stem + '-' + label + '.stderr.txt'), ...observation};
    };
    await writeJson(outputPath, report);
    try {
        report.verification = await spawn('VERIFY', 'verify');
        await writeJson(outputPath, report);
        if (options['verify-only']) {
            report.partial = false; report.mode = 'untimed correctness only'; report.finished = new Date().toISOString();
            await writeJson(outputPath, report);
            console.log('A7C4_RECORD_RESULT ' + JSON.stringify({mode: report.mode, passed: true, controls: report.verification.controls.length, groups: 12}));
            return;
        }
        let sequence = 0;
        for (let pairIndex = 0; pairIndex < schedule.length; ++pairIndex) {
            const pair = {index: pairIndex + 1, order: schedule[pairIndex], observationIndexes: []};
            for (const arm of pair.order) {
                const label = String(++sequence).padStart(2, '0') + '-' + arm;
                const observation = await spawn(arm, label);
                assert.deepEqual(observation.identities, report.verification.identities, 'Identity drift');
                pair.observationIndexes.push(report.observations.length);
                report.observations.push(observation);
                await writeJson(outputPath, report);
            }
            const observations = pair.observationIndexes.map((index) => report.observations[index]);
            const a = pair.order === 'BA' ? observations[1] : observations[0];
            const b = pair.order === 'BA' ? observations[0] : observations[1];
            pair.elapsedRatio = b.total.elapsedMs / a.total.elapsedMs;
            pair.cpuRatio = b.total.cpuTotalMs / a.total.cpuTotalMs;
            pair.ratioMeaning = pair.order === 'AA' ? 'second A / first A' : 'candidate B / baseline A';
            report.pairs.push(pair);
            await writeJson(outputPath, report);
        }
        const candidates = report.pairs.filter((pair) => pair.order !== 'AA');
        report.summary = {
            candidateElapsedRatios: candidates.map((pair) => pair.elapsedRatio),
            medianCandidateElapsedRatio: median(candidates.map((pair) => pair.elapsedRatio)),
            candidateCpuRatios: candidates.map((pair) => pair.cpuRatio),
            medianCandidateCpuRatio: median(candidates.map((pair) => pair.cpuRatio)),
            candidateFasterPairs: candidates.filter((pair) => pair.elapsedRatio < 1).length,
            aaElapsedRatios: report.pairs.filter((pair) => pair.order === 'AA').map((pair) => pair.elapsedRatio),
            aaCpuRatios: report.pairs.filter((pair) => pair.order === 'AA').map((pair) => pair.cpuRatio),
            observations: 10, measuredCorpusPassesPerObservation: 5,
            measuredRowsPerObservation: 528299 * 5,
            scope: protocol.limits,
        };
        report.partial = false;
        report.finished = new Date().toISOString();
        await writeJson(outputPath, report);
        console.log('A7C4_RECORD_RESULT ' + JSON.stringify(report.summary));
    } catch (error) {
        report.error = String(error?.stack ?? error);
        report.finished = new Date().toISOString();
        await writeJson(outputPath, report);
        throw error;
    }
}

if (options.child) { await runChild(options.child); } else { await runParent(); }

