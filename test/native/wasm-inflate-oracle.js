// SPDX-License-Identifier: GPL-3.0-or-later
// Complete production WASM; independent node:zlib bytes. Not database parity.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {crc32, deflateRawSync, inflateRawSync} from 'node:zlib';

const [before, after, output, manifestPath] = process.argv.slice(2);
assert(before && after && output, 'usage: node wasm-inflate-oracle.js BEFORE.wasm AFTER.wasm OUTPUT.json [BANK-MANIFEST.json]');
/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
/**
 * @typedef {{memory: WebAssembly.Memory, wasm_reset_heap: () => void,
 * wasm_alloc: (length: number) => number,
 * inflate_and_join_term_banks: (...args: number[]) => number}} Inflater
 * @typedef {{dictionary: string, file: string, method: number, size: number,
 * crc: number, rows: number, compressedSha256: string, rawSha256: string}} Bank
 */
/** @type {Array<{wasm: Inflater, filename: string, sha256: string}>} */
const modules = [];
for (const filename of [before, after]) {
    const bytes = readFileSync(filename);
    const {instance} = await WebAssembly.instantiate(bytes);
    const wasm = /** @type {Inflater} */ (/** @type {unknown} */ (instance.exports));
    modules.push({wasm, filename, sha256: sha(bytes)});
}
/**
 * @type {{node: string, platform: string, arch: string,
 * modules: Array<{filename: string, sha256: string}>, cases: number,
 * fixtureBanks: number, fixtureBytes: number, fixtures?: Record<string, object>,
 * runs: Array<{dictionary: string, pair: number, warmup: boolean, arm: number,
 * elapsedMs: number, cpuUs: number}>, scope: string}}
 */
const report = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    modules: modules.map(({filename, sha256}) => ({filename, sha256})),
    cases: 0,
    fixtureBanks: 0,
    fixtureBytes: 0,
    runs: [],
    scope: 'inflate/CRC/array-compaction only; not full import',
};
/**
 * @param {number} v
 * @returns {boolean}
 */
const whitespace = (v) => [9, 10, 13, 32].includes(v);
/**
 * @param {Buffer} raw
 * @returns {Buffer}
 */
function oracle(raw) {
    let s = 0;
    let e = raw.length;
    while (s < e && whitespace(raw[s])) { ++s; }
    while (e > s && whitespace(raw[e - 1])) { --e; }
    assert(raw[s] === 91 && raw[e - 1] === 93);
    ++s;
    --e;
    while (s < e && whitespace(raw[s])) { ++s; }
    while (e > s && whitespace(raw[e - 1])) { --e; }
    return Buffer.concat([Buffer.from('['), raw.subarray(s, e), Buffer.from(']')]);
}
/**
 * @param {Inflater} wasm
 * @param {Buffer} compressed
 * @param {Buffer} raw
 * @param {{pad?: number, cap?: number, size?: number, method?: number, crc?: number}} options
 * @returns {{status: number, bytes: Buffer|null, elapsedMs: number, cpuUs: number}}
 */
function run(wasm, compressed, raw, options = {}) {
    wasm.wasm_reset_heap();
    const pad = options.pad ?? 0;
    const inputBase = wasm.wasm_alloc(compressed.length + 32 + pad);
    const input = inputBase + 16 + pad;
    const meta = wasm.wasm_alloc(24);
    const cap = options.cap ?? raw.length + 2;
    const outputBase = wasm.wasm_alloc(cap + 32 + pad);
    const dest = outputBase + 16 + pad;
    const heap = new Uint8Array(wasm.memory.buffer);
    heap.fill(0xa5, inputBase, input + compressed.length + 16);
    heap.set(compressed, input);
    heap.fill(0xa5, outputBase, dest + cap + 16);
    new Uint32Array(wasm.memory.buffer, meta, 6).set([
        0, compressed.length, options.size ?? raw.length, options.method ?? 8, options.crc ?? crc32(raw), 0,
    ]);
    const cpu0 = process.cpuUsage();
    const start = performance.now();
    const status = wasm.inflate_and_join_term_banks(
        input, compressed.length, meta, meta + 4, meta + 8, meta + 12, meta + 16, 1, dest, cap,
    );
    const elapsedMs = performance.now() - start;
    const cpu = process.cpuUsage(cpu0);
    assert(heap.subarray(outputBase, dest).every((v) => v === 0xa5), 'prefix guard overwritten');
    assert(heap.subarray(dest + cap, dest + cap + 16).every((v) => v === 0xa5), 'suffix guard overwritten');
    assert.deepEqual(Buffer.from(heap.subarray(input, input + compressed.length)), Buffer.from(compressed), 'input mutated');
    return {
        status,
        bytes: status < 0 ? null : Buffer.from(heap.subarray(dest, dest + status)),
        elapsedMs,
        cpuUs: cpu.user + cpu.system,
    };
}
/**
 * @param {Buffer} compressed
 * @param {Buffer} raw
 * @param {{pad?: number, cap?: number, size?: number, method?: number, crc?: number}} options
 * @param {Buffer|undefined} expected
 */
function compare(compressed, raw, options, expected = void 0) {
    const a = run(modules[0].wasm, compressed, raw, options);
    const b = run(modules[1].wasm, compressed, raw, options);
    assert.equal(b.status, a.status, 'status differs');
    assert.deepEqual(b.bytes, a.bytes, 'bytes differ');
    if (typeof expected !== 'undefined') { assert.deepEqual(b.bytes, expected, 'independent oracle differs'); }
    ++report.cases;
}
for (const level of [0, 1, 6, 9]) {
    for (let n = 0; n < 32; ++n) {
        const raw = Buffer.from(` \n[ ${JSON.stringify(`日本語🙂:${n}:${'abcd'.repeat(n * 73)}`)} ]\t`);
        const compressed = deflateRawSync(raw, {level});
        assert.deepEqual(inflateRawSync(compressed), raw);
        for (const pad of [0, 1, 7, 15]) { compare(compressed, raw, {pad}, oracle(raw)); }
        compare(compressed, raw, {crc: crc32(raw) ^ 1});
        compare(compressed, raw, {cap: Math.max(2, raw.length - 1)});
        compare(compressed, raw, {size: raw.length + 1});
        compare(Buffer.concat([compressed, Buffer.from([0, 1])]), raw, {});
        for (let cut = 0; cut < Math.min(16, compressed.length); ++cut) {
            compare(compressed.subarray(0, compressed.length - cut - 1), raw, {});
        }
        for (let j = 0; j < 8; ++j) {
            const modified = Buffer.from(compressed);
            modified[Math.floor((modified.length - 1) * j / 7)] ^= 1 << (j % 8);
            compare(modified, raw, {});
        }
    }
}
if (manifestPath) {
    /** @type {{fixtures: Record<string, object>, banks: Bank[]}} */
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    report.fixtures = manifest.fixtures;
    const banks = manifest.banks.map((entry) => {
        const compressed = readFileSync(resolve(dirname(manifestPath), entry.file));
        assert.equal(sha(compressed), entry.compressedSha256);
        const raw = entry.method === 0 ? compressed : inflateRawSync(compressed);
        assert.equal(raw.length, entry.size);
        assert.equal(crc32(raw), entry.crc);
        assert.equal(sha(raw), entry.rawSha256);
        const expected = oracle(raw);
        compare(compressed, raw, {method: entry.method}, expected);
        ++report.fixtureBanks;
        report.fixtureBytes += raw.length;
        return {...entry, compressed, raw, expected};
    });
    // Each dictionary stays separate; all checks/copies happen outside call timing.
    for (const dictionary of Object.keys(manifest.fixtures)) {
        const group = banks.filter((bank) => bank.dictionary === dictionary);
        for (let pair = 0; pair <= 6; ++pair) {
            for (const arm of pair % 2 ? [1, 0] : [0, 1]) {
                let elapsedMs = 0;
                let cpuUs = 0;
                for (const bank of group) {
                    const r = run(modules[arm].wasm, bank.compressed, bank.raw, {method: bank.method});
                    assert.deepEqual(r.bytes, bank.expected);
                    elapsedMs += r.elapsedMs;
                    cpuUs += r.cpuUs;
                }
                report.runs.push({dictionary, pair, warmup: pair === 0, arm, elapsedMs, cpuUs});
            }
        }
    }
}
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({cases: report.cases, fixtureBanks: report.fixtureBanks, fixtureBytes: report.fixtureBytes, measuredCalls: report.runs.length}));
