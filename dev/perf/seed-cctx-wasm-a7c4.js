#!/usr/bin/env node
// Finite packed-block WASM feasibility. No product integration or browser claim.
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify, parseArgs} from 'node:util';
import {performance} from 'node:perf_hooks';
import {fileURLToPath, pathToFileURL} from 'node:url';
import os from 'node:os';
import path from 'node:path';

const {values: args} = parseArgs({options: {
    capture: {type: 'string'}, build: {type: 'string'}, dictionary: {type: 'string'},
    out: {type: 'string'}, child: {type: 'string'},
}});
for (const key of ['capture', 'build', 'dictionary', 'out']) { assert(args[key], 'Missing --' + key); }
assert.equal(process.version, 'v22.22.0');
const capture = path.resolve(args.capture);
const build = path.resolve(args.build);
const output = path.resolve(args.out);
const oracleDirectory = path.join(path.dirname(output), 'frame-oracle');
const runner = fileURLToPath(import.meta.url);
const hash = (data) => createHash('sha256').update(data).digest('hex');
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
const execute = promisify(execFile);
const orders = ['AA', 'ABC', 'BCA', 'CAB', 'ACB', 'CBA', 'BAC', 'AA'];
const protocol = {
    orders, freshTimedProcesses: 22, warmupCorpusPasses: 2, measuredCorpusPasses: 5,
    arms: {A: 'Exact reproduced stock WASM/raw dictionary API', B: 'Seed-context API in candidate WASM', C: 'Unchanged raw dictionary API in the same candidate WASM'},
    measured: 'Fresh context/scratch allocation, one dictionary copy, all103 packed input copies, compression, owned frame copies, context diagnostics, and all native frees per corpus pass; elapsed and process CPU',
    excluded: 'Module load/compile/instantiate, capture/file I/O, source identity, byte/decode oracles, input hashes and output hashes',
    scope: 'Pinned JMdict packed-block WASM component only. No span-gather, IPC, envelope, OPFS, browser import or whole-process peak-memory claim. C/A exposes additional-export binary effects; A/A exposes process noise. One fresh compressor context handles all103 blocks per pass; production worker assignment/context count is not simulated.',
    reruns: 0,
};
await mkdir(path.dirname(output), {recursive: true});

async function inputs() {
    const manifestBytes = await readFile(path.join(capture, 'manifest.json'));
    assert.equal(hash(manifestBytes), '589185f792e3e9a80ec0d912173b64443362a221a9852d54d298db7ffe1f0a5e');
    const manifest = JSON.parse(manifestBytes);
    assert.equal(manifest.partial, false);
    assert.equal(manifest.sourceCommit, '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2');
    assert.equal(manifest.dictionary, 'jmdict');
    assert.equal(manifest.rows, 528299);
    assert.equal(manifest.blocks.length, 103);
    assert.equal(manifest.packedBytes, 100300626);
    assert.equal(manifest.blockTargetBytes, 1048576);
    const dictionary = await readFile(args.dictionary);
    assert.equal(hash(dictionary), 'f384a821c2f122bde518ee8a513ea76cbe9876c3534fc1fff4cacdf1ecc509cb');
    const blocks = [];
    for (const item of manifest.blocks) {
        assert.equal(path.basename(item.filename), item.filename);
        const bytes = await readFile(path.join(capture, item.filename));
        assert.equal(bytes.byteLength, item.bytes);
        assert.equal(hash(bytes), item.sha256);
        blocks.push({item, bytes});
    }
    assert.equal(blocks.reduce((sum, {bytes}) => sum + bytes.length, 0), manifest.packedBytes);
    const receiptBytes = await readFile(path.join(build, 'build-receipt.json'));
    const receipt = JSON.parse(receiptBytes);
    assert.equal(receipt.status, 'complete');
    const modules = {};
    for (const stem of ['stock', 'seed']) {
        const javascript = await readFile(path.join(build, stem + '-module.mjs'));
        const wasm = await readFile(path.join(build, stem + '-module.wasm'));
        assert.equal(hash(javascript), receipt[stem].javascriptSha256);
        assert.equal(hash(wasm), receipt[stem].wasmSha256);
        modules[stem] = {wasm, filename: path.join(build, stem + '-module.mjs')};
    }
    assert.equal(receipt.stock.wasmSha256, 'ad3a18c197d72167262d01fd202976325f57a6697bca627f4527c96d4dbbcfcc');
    return {manifest, dictionary, blocks, modules, identities: {
        manifestSha256: hash(manifestBytes), buildReceiptSha256: hash(receiptBytes),
        runnerSha256: hash(await readFile(runner)), dictionarySha256: hash(dictionary),
        stock: receipt.stock, candidate: receipt.seed,
        sourceCommit: manifest.sourceCommit, zstdCommit: receipt.zstdCommit,
        emsdkCommit: receipt.emsdkCommit, sdkBuild: receipt.sdkBuild,
        inputDigest: inputDigest(blocks),
    }};
}

function inputDigest(blocks) {
    const digest = createHash('sha256');
    for (const {bytes} of blocks) { digest.update(bytes); }
    return digest.digest('hex');
}

async function initialize(context, arm) {
    const spec = context.modules[arm === 'A' ? 'stock' : 'seed'];
    const start = performance.now();
    const {default: factory} = await import(pathToFileURL(spec.filename).href);
    const module = await factory({wasmBinary: spec.wasm});
    assert.equal(typeof module._ZSTD_compress_usingDict, 'function');
    if (arm !== 'A') { assert.equal(typeof module._mb_compress, 'function'); }
    return {module, initializationMs: performance.now() - start};
}

function pass(context, module, arm, timed, selectedBlocks = context.blocks) {
    const outputs = new Array(selectedBlocks.length);
    const maxInput = Math.max(...selectedBlocks.map(({bytes}) => bytes.length), 1);
    const capacity = module._ZSTD_compressBound(maxInput) >>> 0;
    const memoryBefore = module.HEAPU8.byteLength;
    const cpuStart = timed ? process.cpuUsage() : null;
    const start = timed ? performance.now() : 0;
    let ctx = 0, dictPointer = 0, sourcePointer = 0, destinationPointer = 0;
    const metadata = {};
    try {
        ctx = arm === 'B' ? module._mb_create() : module._ZSTD_createCCtx();
        dictPointer = module._malloc(context.dictionary.length);
        sourcePointer = module._malloc(maxInput);
        destinationPointer = module._malloc(capacity);
        assert(ctx && dictPointer && sourcePointer && destinationPointer, 'Native allocation failed');
        module.HEAPU8.set(context.dictionary, dictPointer);
        for (let index = 0; index < selectedBlocks.length; ++index) {
            const {bytes} = selectedBlocks[index];
            module.HEAPU8.set(bytes, sourcePointer);
            const fn = arm === 'B' ? module._mb_compress : module._ZSTD_compress_usingDict;
            const size = fn(ctx, destinationPointer, capacity, sourcePointer, bytes.length, dictPointer, context.dictionary.length, -1) >>> 0;
            assert.equal(module._ZSTD_isError(size), 0, 'Compression returned error');
            assert(size <= capacity);
            outputs[index] = module.HEAPU8.slice(destinationPointer, destinationPointer + size);
        }
        if (arm === 'B') {
            metadata.contextBytes = module._mb_context_bytes(ctx) >>> 0;
            metadata.seedBuilds = module._mb_seed_builds(ctx) >>> 0;
            metadata.directFallbacks = module._mb_direct_fallbacks(ctx) >>> 0;
        } else if (typeof module._ZSTD_sizeof_CCtx === 'function') {
            metadata.contextBytes = module._ZSTD_sizeof_CCtx(ctx) >>> 0;
        }
    } finally {
        if (ctx) { if (arm === 'B') { module._mb_free(ctx); } else { module._ZSTD_freeCCtx(ctx); } }
        for (const pointer of [dictPointer, sourcePointer, destinationPointer]) { if (pointer) { module._free(pointer); } }
    }
    const elapsedMs = timed ? performance.now() - start : null;
    const cpu = timed ? process.cpuUsage(cpuStart) : null;
    return {outputs, metrics: {
        elapsedMs, cpuUserMs: cpu === null ? null : cpu.user / 1000,
        cpuSystemMs: cpu === null ? null : cpu.system / 1000,
        cpuTotalMs: cpu === null ? null : (cpu.user + cpu.system) / 1000,
        memoryBefore, memoryAfter: module.HEAPU8.byteLength,
        inputBytes: selectedBlocks.reduce((sum, {bytes}) => sum + bytes.length, 0),
        outputBytes: outputs.reduce((sum, bytes) => sum + bytes.length, 0),
        blocks: outputs.length, ...metadata,
    }};
}

function compare(context, outputs, expected) {
    assert.equal(outputs.length, expected.length);
    const buffers = new Set();
    for (let index = 0; index < outputs.length; ++index) {
        const bytes = outputs[index];
        assert(bytes instanceof Uint8Array && bytes.buffer instanceof ArrayBuffer);
        assert.equal(bytes.byteOffset, 0);
        assert.equal(bytes.byteLength, bytes.buffer.byteLength);
        assert(!buffers.has(bytes.buffer));
        buffers.add(bytes.buffer);
        assert(Buffer.from(bytes).equals(expected[index]), 'Full compressed byte mismatch at block ' + index);
    }
    assert.equal(inputDigest(context.blocks), context.identities.inputDigest, 'Input mutation');
    const digest = createHash('sha256');
    for (const bytes of outputs) { digest.update(bytes); }
    return digest.digest('hex');
}

function decodeAll(context, module, outputs, selectedBlocks = context.blocks) {
    const dctx = module._ZSTD_createDCtx();
    const dict = module._malloc(context.dictionary.length);
    const source = module._malloc(Math.max(...outputs.map((bytes) => bytes.length), 1));
    const capacity = Math.max(...selectedBlocks.map(({bytes}) => bytes.length), 1);
    const target = module._malloc(capacity);
    assert(dctx && dict && source && target);
    try {
        module.HEAPU8.set(context.dictionary, dict);
        for (let index = 0; index < outputs.length; ++index) {
            const bytes = outputs[index];
            module.HEAPU8.set(bytes, source);
            const n = module._ZSTD_decompress_usingDict(dctx, target, capacity, source, bytes.length, dict, context.dictionary.length) >>> 0;
            assert.equal(module._ZSTD_isError(n), 0);
            assert.equal(n, selectedBlocks[index].bytes.length);
            assert(Buffer.from(module.HEAPU8.subarray(target, target + n)).equals(selectedBlocks[index].bytes));
        }
    } finally {
        module._ZSTD_freeDCtx(dctx);
        for (const pointer of [dict, source, target]) { module._free(pointer); }
    }
}

async function verify(context) {
    const stock = await initialize(context, 'A');
    const candidate = await initialize(context, 'B');
    const baseline = pass(context, stock.module, 'A', false);
    const rawCandidate = pass(context, candidate.module, 'C', false);
    const seeded = pass(context, candidate.module, 'B', false);
    const expected = baseline.outputs.map((bytes) => Buffer.from(bytes));
    const digest = compare(context, baseline.outputs, expected);
    assert.equal(compare(context, rawCandidate.outputs, expected), digest);
    assert.equal(compare(context, seeded.outputs, expected), digest);
    decodeAll(context, stock.module, baseline.outputs);
    decodeAll(context, candidate.module, seeded.outputs);
    assert.equal(seeded.metrics.directFallbacks, 0);
    assert(seeded.metrics.seedBuilds > 0 && seeded.metrics.seedBuilds <= 103);
    const first = context.blocks[0].bytes;
    const sizes = [first.length, 0, 1, 7, 1024, 8192, 16384, 65536, 98303, 98304, 131071, 131072, 262144, first.length, 0, first.length];
    const prefixes = sizes.map((length) => ({bytes: first.subarray(0, length)}));
    const controlsA = pass(context, stock.module, 'A', false, prefixes);
    const controlsC = pass(context, candidate.module, 'C', false, prefixes);
    const controlsB = pass(context, candidate.module, 'B', false, prefixes);
    const expectedControls = controlsA.outputs.map((bytes) => Buffer.from(bytes));
    compare(context, controlsC.outputs, expectedControls);
    compare(context, controlsB.outputs, expectedControls);
    decodeAll(context, candidate.module, controlsB.outputs, prefixes);
    assert.equal(controlsB.metrics.directFallbacks, 2);
    await mkdir(oracleDirectory, {recursive: true});
    const frames = [];
    for (let index = 0; index < expected.length; ++index) {
        const filename = 'frame-' + String(index).padStart(3, '0') + '.bin';
        await writeFile(path.join(oracleDirectory, filename), expected[index], {flag: 'wx'});
        frames.push({filename, bytes: expected[index].length, sha256: hash(expected[index])});
    }
    const oracle = {identities: context.identities, digest, frames, seedBuilds: seeded.metrics.seedBuilds};
    await save(path.join(oracleDirectory, 'oracle.json'), oracle);
    return {
        kind: 'untimed-correctness', passed: true, protocol, identities: context.identities,
        stock: baseline.metrics, candidateRaw: rawCandidate.metrics, seeded: seeded.metrics,
        prefixControls: sizes.map((inputBytes, index) => ({inputBytes, outputBytes: expectedControls[index].length, sha256: hash(expectedControls[index])})),
        initializationMs: {stock: stock.initializationMs, candidate: candidate.initializationMs},
        outputDigest: digest, fullByteEquality: true, decodeEquality: true, ownedOutputs: true,
    };
}

async function child(arm) {
    const context = await inputs();
    if (arm === 'VERIFY') {
        const result = await verify(context);
        await save(output, result);
        console.log('A7C4_SEED_WASM_VERIFY ' + JSON.stringify({passed: true, blocks: 103, prefixes: 16, outputDigest: result.outputDigest}));
        return;
    }
    assert(['A', 'B', 'C'].includes(arm));
    const oracle = JSON.parse(await readFile(path.join(oracleDirectory, 'oracle.json')));
    assert.deepEqual(oracle.identities, context.identities);
    const expected = [];
    for (const frame of oracle.frames) {
        assert.equal(path.basename(frame.filename), frame.filename);
        const bytes = await readFile(path.join(oracleDirectory, frame.filename));
        assert.equal(bytes.length, frame.bytes); assert.equal(hash(bytes), frame.sha256);
        expected.push(bytes);
    }
    const initialized = await initialize(context, arm);
    const warmups = [], measured = [];
    const one = (timed) => {
        const value = pass(context, initialized.module, arm, timed);
        assert.equal(compare(context, value.outputs, expected), oracle.digest);
        if (arm === 'B') {
            assert.equal(value.metrics.directFallbacks, 0);
            assert(value.metrics.seedBuilds > 0);
            assert.equal(value.metrics.seedBuilds, oracle.seedBuilds);
        }
        return {...value.metrics, fullByteEquality: true, inputUnchanged: true, ownedOutputs: true, outputDigest: oracle.digest};
    };
    for (let i = 0; i < protocol.warmupCorpusPasses; ++i) { warmups.push(one(false)); }
    globalThis.gc?.();
    const memoryBefore = process.memoryUsage();
    for (let i = 0; i < protocol.measuredCorpusPasses; ++i) { measured.push(one(true)); }
    const memoryAfter = process.memoryUsage();
    const totals = {};
    for (const key of ['elapsedMs', 'cpuUserMs', 'cpuSystemMs', 'cpuTotalMs', 'inputBytes', 'outputBytes', 'blocks']) {
        totals[key] = measured.reduce((sum, row) => sum + row[key], 0);
    }
    const result = {
        arm, passed: true, protocol, identities: context.identities, initializationMs: initialized.initializationMs,
        warmups, measured, totals, memoryBefore, memoryAfter,
        memoryScope: 'Snapshots and known context allocation only; not complete-import peak memory',
        host: {node: process.version, platform: os.platform(), release: os.release(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, loadAverage: os.loadavg()},
    };
    await save(output, result);
    console.log('A7C4_SEED_WASM_OBSERVATION ' + JSON.stringify({arm, totals, initializationMs: result.initializationMs}));
}

async function parent() {
    const report = {protocol, partial: true, started: new Date().toISOString(), verification: null, observations: [], groups: [], summary: null};
    const stem = output.replace(/\.json$/, '');
    const baseArgs = ['--expose-gc', runner, '--capture', capture, '--build', build, '--dictionary', path.resolve(args.dictionary)];
    const spawn = async (arm, label) => {
        const file = stem + '-' + label + '.json';
        try {
            const {stdout, stderr} = await execute(process.execPath, [...baseArgs, '--child', arm, '--out', file], {maxBuffer: 8 * 1024 * 1024});
            await writeFile(stem + '-' + label + '.stdout.txt', stdout);
            await writeFile(stem + '-' + label + '.stderr.txt', stderr);
        } catch (error) {
            await writeFile(stem + '-' + label + '.stdout.txt', error.stdout ?? '');
            await writeFile(stem + '-' + label + '.stderr.txt', error.stderr ?? '');
            throw error;
        }
        const observation = JSON.parse(await readFile(file));
        assert.equal(observation.passed, true);
        return {file: path.basename(file), ...observation};
    };
    await save(output, report);
    try {
        report.verification = await spawn('VERIFY', 'verify');
        await save(output, report);
        let sequence = 0;
        for (const order of orders) {
            const group = {order, observations: []};
            for (const arm of order) {
                const observation = await spawn(arm, String(++sequence).padStart(2, '0') + '-' + arm);
                assert.deepEqual(observation.identities, report.verification.identities);
                group.observations.push(report.observations.length);
                report.observations.push(observation);
                await save(output, report);
            }
            const items = group.observations.map((index) => report.observations[index]);
            group.ratios = {};
            const comparisons = order === 'AA' ? [['A2/A1', items[1], items[0]]] : [
                ['B/A', items.find((x) => x.arm === 'B'), items.find((x) => x.arm === 'A')],
                ['B/C', items.find((x) => x.arm === 'B'), items.find((x) => x.arm === 'C')],
                ['C/A', items.find((x) => x.arm === 'C'), items.find((x) => x.arm === 'A')],
            ];
            for (const [label, numerator, denominator] of comparisons) {
                group.ratios[label] = {elapsed: numerator.totals.elapsedMs / denominator.totals.elapsedMs, cpu: numerator.totals.cpuTotalMs / denominator.totals.cpuTotalMs};
            }
            report.groups.push(group);
            await save(output, report);
        }
        const median = (values) => { const sorted = [...values].sort((a, b) => a - b); const n = sorted.length; return n % 2 ? sorted[n >> 1] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2; };
        report.summary = {};
        for (const label of ['B/A', 'B/C', 'C/A', 'A2/A1']) {
            const rows = report.groups.filter((group) => label in group.ratios).map((group) => group.ratios[label]);
            report.summary[label] = {elapsedRatios: rows.map((x) => x.elapsed), cpuRatios: rows.map((x) => x.cpu), medianElapsedRatio: median(rows.map((x) => x.elapsed)), medianCpuRatio: median(rows.map((x) => x.cpu)), elapsedFaster: rows.filter((x) => x.elapsed < 1).length};
        }
        report.partial = false;
        report.finished = new Date().toISOString();
        await save(output, report);
        console.log('A7C4_SEED_WASM_RESULT ' + JSON.stringify(report.summary));
    } catch (error) {
        report.error = String(error?.stack ?? error);
        report.finished = new Date().toISOString();
        await save(output, report);
        throw error;
    }
}

if (args.child) { await child(args.child); } else { await parent(); }
