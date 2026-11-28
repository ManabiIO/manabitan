import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import path from 'node:path';
import {openArm} from './wasm-arm.mjs';

const output = path.resolve(process.argv[2]);
const corpus = path.resolve(process.argv[3]);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifestBytes = await readFile(path.join(corpus, 'expected-manifest.json'));
const expected = JSON.parse(manifestBytes);
const sourcePins = JSON.parse(await readFile(new URL('./source-pins.json', import.meta.url), 'utf8'));
assert.equal(hash(manifestBytes), sourcePins.expectedCorpusManifestSha256);
const report = {
    status: 'started', boundary: 'Actual WASM correctness only. No timing observations.',
    node: process.version, corpusManifestSha256: hash(manifestBytes),
    canonicalFrames: [], syntheticCases: [], boundaryProbes: {}, failures: [],
};
const arms = {};
const dictionary = await readFile(path.join(output, 'inputs/jmdict.zdict'));
const maximumSourceBytes = Math.max(4 * 1024 * 1024 + 1, ...expected.blocks.map((b) => b.bytes));
const maximumDictionaryBytes = Math.max(64, dictionary.byteLength);
const frameHashes = Object.fromEntries(['P', 'A', 'B', 'C'].map((a) => [a, createHash('sha256')]));
const envelopeHashes = Object.fromEntries(['P', 'A', 'B', 'C'].map((a) => [a, createHash('sha256')]));
const frameBytes = {P: 0, A: 0, B: 0, C: 0};

function same(actual, wanted, detail) {
    if (!actual.equals(wanted)) { report.failures.push(detail); }
}

async function checkCase(name, bytes, dict, canonical, worker) {
    const results = {};
    const receipts = {};
    for (const label of ['P', 'A', 'B', 'C']) {
        const result = arms[label].compress(bytes, dict, worker);
        results[label] = result;
        if ('error' in result) {
            receipts[label] = {error: result.error};
            continue;
        }
        receipts[label] = {bytes: result.length, frameSha256: hash(result.frame), envelopeSha256: hash(result.envelope)};
        if (canonical) {
            frameHashes[label].update(result.frame);
            envelopeHashes[label].update(result.envelope);
            frameBytes[label] += result.length;
        }
        // Every arm's bytes are decoded both by itself and unchanged production.
        for (const decoder of new Set([label, 'P'])) {
            const decoded = arms[decoder].decompress(result.frame, dict);
            if ('error' in decoded) { report.failures.push({name, label, decoder, reason: 'decode error', error: decoded.error}); }
            else { same(decoded.bytes, bytes, {name, label, decoder, reason: 'decoded bytes differ'}); }
        }
    }
    const baseline = results.P;
    for (const label of ['A', 'B', 'C']) {
        const candidate = results[label];
        if ('error' in baseline || 'error' in candidate) {
            if (baseline.error !== candidate.error) { report.failures.push({name, label, reason: 'error outcome differs', baseline: baseline.error, candidate: candidate.error}); }
        } else {
            same(candidate.frame, baseline.frame, {name, label, reason: 'compressed frame differs'});
            same(candidate.envelope, baseline.envelope, {name, label, reason: 'complete envelope differs'});
        }
    }
    (canonical ? report.canonicalFrames : report.syntheticCases).push({name, sourceBytes: bytes.byteLength,
        sourceSha256: hash(bytes), dictionarySha256: hash(dict), worker, arms: receipts});
}

async function checkBoundaries(label) {
    const bytes = await readFile(path.join(output, 'arms', label, 'count-probe.wasm'));
    const {instance} = await WebAssembly.instantiate(bytes, {wasi_snapshot_preview1: {
        proc_exit(code) { throw new Error(`Probe exited ${code}`); },
    }});
    instance.exports._initialize?.();
    const memory = new Uint8Array(instance.exports.memory.buffer);
    const count = instance.exports.count_probe;
    const countTwo = instance.exports.count_two_probe;
    assert.equal(typeof count, 'function');
    assert.equal(typeof countTwo, 'function');
    const heapEnd = memory.length;
    let checks = 0;
    const check = (actual, wanted) => { ++checks; assert.equal(actual, wanted, `count oracle ${label} check${checks}`); };
    // Alternate which operand ends at the real linear-memory boundary.
    for (const reverse of [false, true]) {
        for (let slackA = 0; slackA < 16; ++slackA) {
            for (let slackB = 0; slackB < 16; ++slackB) {
                for (let n = 0; n <= 80; ++n) {
                    const x = heapEnd - (reverse ? 65536 : 0) - slackA - n;
                    const y = heapEnd - (reverse ? 0 : 65536) - slackB - n;
                    for (let i = 0; i < n; ++i) { memory[x + i] = memory[y + i] = (i * 29 + n) & 255; }
                    check(count(x, y, x + n), n);
                    for (let i = 0; i < n; ++i) {
                        memory[y + i] ^= 1 << (i % 8);
                        check(count(x, y, x + n), i);
                        memory[y + i] ^= 1 << (i % 8);
                    }
                }
            }
        }
    }
    for (const n of [127, 128, 129, 255, 256, 257, 511, 512, 513, 1023, 1024, 1025, 4095, 4096]) {
        const x = heapEnd - n;
        const y = heapEnd - 65536 - n;
        for (let i = 0; i < n; ++i) { memory[x + i] = memory[y + i] = (i * 17) & 255; }
        check(count(x, y, x + n), n);
        for (let i = 0; i < n; ++i) {
            memory[y + i] ^= 0x80;
            check(count(x, y, x + n), i);
            memory[y + i] ^= 0x80;
        }
    }
    for (const reverse of [false, true]) {
        for (let n = 0; n <= 64; ++n) {
            for (let first = 0; first <= n; ++first) {
                const x = heapEnd - 131072 - n;
                const y = heapEnd - (reverse ? 65536 : 0) - first;
                const z = heapEnd - (reverse ? 0 : 65536) - (n - first);
                for (let i = 0; i < n; ++i) {
                    memory[x + i] = (i * 19 + n) & 255;
                    memory[i < first ? y + i : z + i - first] = memory[x + i];
                }
                check(countTwo(x, y, x + n, y + first, z), n);
                for (let i = 0; i < n; ++i) {
                    const changed = i < first ? y + i : z + i - first;
                    memory[changed] ^= 0x40;
                    check(countTwo(x, y, x + n, y + first, z), i);
                    memory[changed] ^= 0x40;
                }
            }
        }
    }
    return {status: 'passed', checks, wasmSha256: hash(bytes), memoryBytes: memory.length,
        scope: 'Exact source helpers compiled separately with pinned toolchain, scalar expected prefix and actual memory-end traps; no runtime export changes'};
}

try {
    for (const label of ['P', 'A', 'B', 'C']) {
        arms[label] = await openArm(path.join(output, 'arms', label), maximumSourceBytes, maximumDictionaryBytes);
    }
    let inputBytes = 0;
    for (let i = 0; i < expected.blocks.length; ++i) {
        const entry = expected.blocks[i];
        const bytes = gunzipSync(await readFile(path.join(corpus, entry.name)));
        assert.equal(bytes.byteLength, entry.bytes);
        assert.equal(hash(bytes), entry.sha256);
        inputBytes += bytes.byteLength;
        await checkCase(entry.name, bytes, dictionary, true, i % 4);
    }
    assert.equal(inputBytes, expected.persistedBytes);
    report.canonical = {rows: expected.rows, unique: expected.unique, inputBytes,
        blocks: expected.blocks.length, dictionarySha256: hash(dictionary),
        frameBytes, frameSha256: Object.fromEntries(Object.entries(frameHashes).map(([k, v]) => [k, v.digest('hex')])),
        envelopeSha256: Object.fromEntries(Object.entries(envelopeHashes).map(([k, v]) => [k, v.digest('hex')]))};
    // Empty/tiny, 8-byte and Zstd block boundaries; long and short matches.
    const lengths = new Set(Array.from({length: 33}, (_, i) => i));
    for (let exponent = 6; exponent <= 18; ++exponent) {
        for (const delta of [-1, 0, 1]) { lengths.add(2 ** exponent + delta); }
    }
    for (const delta of [-1, 0, 1]) { lengths.add(4 * 1024 * 1024 + delta); }
    let caseIndex = 0;
    for (const length of lengths) {
        const bytes = Buffer.alloc(length);
        for (let i = 0; i < length; ++i) { bytes[i] = i % 97 < 80 ? (i % 31) : ((i * 29) & 255); }
        await checkCase(`boundary-${length}`, bytes, dictionary, false, caseIndex++ % 4);
    }
    const switchingInput = Buffer.alloc(32769);
    for (let i = 0; i < switchingInput.length; ++i) { switchingInput[i] = dictionary[i % dictionary.length]; }
    const malformed = Buffer.from([0x37, 0xa4, 0x30, 0xec, 1, 2, 3, 4, 255, 255, 255, 255]);
    for (const [name, dict] of [['none', Buffer.alloc(0)], ['raw-tiny', Buffer.from('small raw dictionary')],
        ['malformed-trained', malformed], ['trained-again', dictionary]]) {
        await checkCase(`switch-${name}`, switchingInput, dict, false, 0);
    }
    // A wrong dictionary must keep production's exact failure/readback result.
    const valid = arms.P.compress(switchingInput, dictionary, 1);
    assert.ok(!('error' in valid));
    const wrongResults = Object.fromEntries(['P', 'A', 'B', 'C'].map((label) => {
        const result = arms[label].decompress(valid.frame, Buffer.alloc(0));
        return [label, 'error' in result ? result : {bytes: result.bytes.length, sha256: hash(result.bytes)}];
    }));
    for (const label of ['A', 'B', 'C']) { assert.deepEqual(wrongResults[label], wrongResults.P); }
    report.wrongDictionary = wrongResults;
    for (const label of ['A', 'B']) { report.boundaryProbes[label] = await checkBoundaries(label); }
    // Re-read canonical inputs and all runtime artifacts after qualification.
    const buildManifest = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'));
    for (const label of ['P', 'A', 'B', 'C']) {
        for (const [name, receipt] of Object.entries(buildManifest.arms[label].files)) {
            assert.equal(hash(await readFile(path.join(output, 'arms', label, name))), receipt.sha256);
        }
    }
    for (const entry of expected.blocks) {
        assert.equal(hash(gunzipSync(await readFile(path.join(corpus, entry.name)))), entry.sha256);
    }
    assert.equal(hash(await readFile(path.join(corpus, 'expected-manifest.json'))), sourcePins.expectedCorpusManifestSha256);
    report.postIdentity = 'passed';
    report.status = report.failures.length === 0 ? 'passed' : 'failed';
} catch (error) {
    report.status = 'failed';
    report.exception = {message: String(error), stack: error.stack};
} finally {
    for (const arm of Object.values(arms)) { arm.close(); }
    await writeFile(path.join(output, 'qualification.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({status: report.status, frames: report.canonicalFrames.length,
    syntheticCases: report.syntheticCases.length, probes: report.boundaryProbes, failures: report.failures.length}));
if (report.status !== 'passed') { process.exitCode = 1; }
