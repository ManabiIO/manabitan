/* Copyright (C) 2026 Manabitan authors; SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {STORE_PATH, exposeValidator, identity, localImport, sha256, updateFramed, updateValidationDigest} from './common.mjs';

// One fresh process measures exactly one arm and one boundary. Fixture loading,
// source checks, two full warmups, explicit GC, and output verification are
// outside the measured region. Repetition counts are fixed before acquisition.
const [rootArg, inputArg, boundary] = process.argv.slice(2);
assert(rootArg && inputArg && ['validator', 'sidecar'].includes(boundary));
assert.equal(typeof globalThis.gc, 'function');
const sourceRoot = resolve(rootArg);
const inputRoot = resolve(inputArg);
const manifestBytes = await readFile(join(inputRoot, 'inputs.json'));
const manifest = JSON.parse(manifestBytes.toString());
assert.equal(manifest.complete, true);
const source = await identity(sourceRoot);
const expected = sourceRoot === manifest.baseline.root ? manifest.baseline : manifest.candidate;
assert.deepEqual(source, expected);
assert.equal(source.trackedChanges, '');
const inputBytes = await readFile(join(inputRoot, 'inputs.bin'));
assert.equal(inputBytes.byteLength, manifest.inputBytes);
assert.equal(sha256(inputBytes), manifest.inputSha256);
assert.equal(inputBytes.byteOffset % 8, 0);
const inputs = manifest.inputs.filter((input) => boundary === 'sidecar' || input.format === 2).map((input) => {
    for (const [offset, length] of [[input.payloadOffset, input.payloadLength], [input.fieldsOffset, input.fieldsLength]]) {
        assert(Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length > 0);
        assert.equal(offset % 8, 0);
        assert(offset + length <= inputBytes.byteLength);
    }
    return {...input,
        payload: new Uint8Array(inputBytes.buffer, inputBytes.byteOffset + input.payloadOffset, input.payloadLength),
        fields: new Uint8Array(inputBytes.buffer, inputBytes.byteOffset + input.fieldsOffset, input.fieldsLength),
    };
});
const rows = inputs.reduce((total, input) => total + input.count, 0);
assert.equal(rows, boundary === 'validator' ? manifest.compactRows : manifest.rows);
assert(rows > 0);
Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {hardwareConcurrency: 1, deviceMemory: 4}});
const repeats = boundary === 'validator' ? 32 : 4;
const validate = boundary === 'validator' ? await exposeValidator(sourceRoot) : null;
const store = boundary === 'sidecar' ? new (await localImport(sourceRoot, STORE_PATH)).TermRecordOpfsStore() : null;
const createSidecar = (input) => store._createLookupIndexChunk(input.firstId, input.count, input.base,
    input.payload, input.fields, input.format);
const operation = boundary === 'validator' ? (input) => {
    const result = validate(input.fields, input.count);
    const last = input.count - 1;
    return result.offsets[last] + result.lengths[last] + result.scoreKeys[last] + result.scores[result.scoreKeys[last]];
} : (input) => {
    const result = createSidecar(input);
    return result.byteLength + result[0] + result[24] + result[28] + result[32] + result[result.byteLength - 1];
};
function run() {
    let sink = 0;
    for (let repetition = 0; repetition < repeats; ++repetition) {
        for (const input of inputs) { sink = (sink + operation(input)) >>> 0; }
    }
    return sink;
}
const warmupSinks = [run(), run()];
globalThis.gc();
const beforeMemory = process.memoryUsage();
const beforeCpu = process.cpuUsage();
const start = performance.now();
const sink = run();
const elapsedMs = performance.now() - start;
const cpu = process.cpuUsage(beforeCpu);
const afterMemory = process.memoryUsage();
assert.equal(warmupSinks[0], sink);
assert.equal(warmupSinks[1], sink);

// Every measured input is verified after timing; no digest work is timed.
const digest = createHash('sha256');
for (const input of inputs) {
    if (boundary === 'validator') {
        updateValidationDigest(digest, validate(input.fields, input.count));
    } else {
        const output = createSidecar(input);
        assert.equal(sha256(output), input.envelopeSha256);
        updateFramed(digest, output);
    }
}
const outputDigest = digest.digest('hex');
assert.equal(outputDigest, boundary === 'validator' ? manifest.expectedValidatorDigest : manifest.expectedSidecarDigest);
assert.equal(sha256(inputBytes), manifest.inputSha256);
assert.deepEqual(await identity(sourceRoot), source);
console.log(JSON.stringify({
    complete: true, dictionary: manifest.dictionary, boundary, source, node: process.version,
    scope: boundary === 'validator' ? 'Private compact-field validator, unchanged body exposed for component replay.' :
        'Complete production _createLookupIndexChunk: dimensions and field validation, lookup split, all checksums, final envelope allocation and copies.',
    exclusions: 'Fixture loading, parser, record encoding, compression, persistence, worker IPC, browser, UI, and import completion. Resident corpus replay does not establish an import or lookup speedup.',
    fixtureShape: 'All runs captured from sequential one-bank encoders; payload/field views packed at 8-byte boundaries in one resident fixture slab.',
    repeats, rows, rowVisits: rows * repeats, runs: inputs.length, elapsedMs,
    cpuMs: (cpu.user + cpu.system) / 1000, sink, warmups: 2,
    inputSha256: manifest.inputSha256, manifestSha256: sha256(manifestBytes), outputDigest,
    runnerSha256: sha256(await readFile(new URL(import.meta.url))),
    commonSha256: sha256(await readFile(new URL('./common.mjs', import.meta.url))),
    beforeMemory, afterMemory, lifetimeMaxRssKiB: process.resourceUsage().maxRSS,
    memoryScope: 'Child lifetime includes fixture input and untimed verification; not whole-import memory.',
}));
