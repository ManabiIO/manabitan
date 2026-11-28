#!/usr/bin/env node
/* Copyright (C) 2026 Manabitan authors. SPDX-License-Identifier: GPL-3.0-or-later */
// Functional research canary only. No timing or browser-memory qualification.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {constants, crc32, deflateRawSync, inflateRawSync} from 'node:zlib';

const args = process.argv.slice(2);
const fixturesOnly = args.includes('--fixtures-only');
const positional = args.filter((arg) => arg !== '--fixtures-only');
assert.equal(positional.length, 3, 'Provide baseline root, candidate root, and report path');
const roots = {A: path.resolve(positional[0]), C: path.resolve(positional[1])};
const reportPath = path.resolve(positional[2]);
const limit = 16 * 1024 * 1024;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (root, ...command) => execFileSync('git', command, {cwd: root, encoding: 'utf8'}).trim();
const requireCandidate = createRequire(path.join(roots.C, 'package.json'));
const browserLockBytes = await readFile(path.join(roots.C, 'node_modules/playwright-core/browsers.json'));
const browserLock = JSON.parse(browserLockBytes).browsers.find(({name}) => name === 'chromium');
assert.equal(browserLock.browserVersion, '153.0.8010.12');
const encoder = new TextEncoder();
const fixtures = new Map();
const source = (name, text, rows = 0) => {
    const decoded = encoder.encode(text);
    const bytes = deflateRawSync(decoded);
    fixtures.set(name, {bytes, decoded});
    return {fixtureId: name, compressionMethod: 8, compressedSize: bytes.length,
        uncompressedSize: decoded.length, signature: crc32(decoded), decodedSha256: sha(decoded), rows};
};
const corrupt = (name, item, kind) => {
    const original = fixtures.get(item.fixtureId);
    const bytes = kind === 'truncated' ? original.bytes.subarray(0, -2) : original.bytes;
    fixtures.set(name, {bytes, decoded: original.decoded});
    return {...item, fixtureId: name, compressedSize: bytes.length,
        signature: kind === 'crc' ? (item.signature ^ 1) >>> 0 : item.signature};
};
const empty = source('empty', ' '.repeat(64) + '[]');
const neighbor = source('neighbor-64k', ' '.repeat(64 * 1024) + '[]');
const exact = source('exact-16m', ' '.repeat(limit - 2) + '[]');
const above = source('above-16m', ' '.repeat(limit - 1) + '[]');
const small = source('small-row', JSON.stringify([['小', '', '', '', 0, ['abc'.repeat(700)], 1, '']]), 1);
const large = source('larger-row', JSON.stringify([['大', '', '', '', 0, ['xyz'.repeat(5000)], 2, '']]), 1);
const repetitive = source('repetitive-row', JSON.stringify([['反復', '', '', '', 0, ['x'.repeat(2 * 1024 * 1024)], 3, '']]), 1);
const badCrc = corrupt('bad-crc', empty, 'crc');
const truncated = corrupt('truncated', empty, 'truncated');
const oversizedClaim = {...empty, uncompressedSize: limit + 1};
const smallClaim = {...neighbor, uncompressedSize: 128};
const cases = [
    {name: 'multibank-group-budget', sources: [small, large], native: true, checkLargerSmallBankWrite: true},
    {name: 'group-budget-clipped-at-16m', sources: [exact, neighbor], native: true, reuseCrc: false, checkClippedBudget: true},
    {name: 'single-bank-exact-16m', sources: [exact], native: true},
    {name: 'later-bank-over-16m', sources: [small, above], native: false, reuseCrc: false, overLimit: true},
    {name: 'earlier-bank-over-16m', sources: [above, small], native: false, reuseCrc: false, overLimit: true},
    {name: 'deferred-crc-stays-wasm', sources: [repetitive, repetitive], native: false, deferred: true},
    {name: 'real-native-small-bank-overrun-settlement', sources: [smallClaim, neighbor], rejects: true, nativeError: true, gated: true},
    {name: 'earlier-crc-later-deflate', sources: [badCrc, truncated, neighbor], rejects: true, nativeError: true},
    {name: 'earlier-deflate-later-crc', sources: [truncated, badCrc, neighbor], rejects: true, nativeError: true},
    {name: 'crc-before-oversized-before-deflate', sources: [badCrc, oversizedClaim, truncated], rejects: true, native: false, reuseCrc: false, overLimit: true},
    {name: 'oversized-before-crc-before-deflate', sources: [oversizedClaim, badCrc, truncated], rejects: true, native: false, reuseCrc: false, overLimit: true},
    {name: 'deflate-before-oversized-before-crc', sources: [truncated, oversizedClaim, badCrc], rejects: true, native: false, reuseCrc: false, overLimit: true},
].map((item) => {
    const decodedBytes = item.sources.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
    const compressedBytes = item.sources.reduce((sum, entry) => sum + entry.compressedSize, 0);
    const inputChunkSize = Math.max(1, Math.floor(Math.min(decodedBytes, limit) / 1032));
    const oldChunkSizes = item.sources.map(({uncompressedSize}) => Math.max(1, Math.floor(uncompressedSize / 1032)));
    const contentHash = createHash('sha256');
    for (const entry of item.sources) { contentHash.update(fixtures.get(entry.fixtureId).decoded); }
    const reuseCrc = item.reuseCrc !== false;
    const deferred = reuseCrc && item.sources.length > 1 && decodedBytes >= 4 * 1024 * 1024 && compressedBytes <= Math.floor(decodedBytes / 32);
    assert(item.sources.every((entry) => entry.compressedSize <= entry.uncompressedSize));
    if (item.native === true || item.nativeError) {
        assert(!deferred);
        assert(item.sources.every((entry) => entry.uncompressedSize <= limit));
    }
    if (item.overLimit) { assert(!deferred && item.sources.some((entry) => entry.uncompressedSize > limit)); }
    if (item.deferred) { assert(deferred && item.sources.every((entry) => entry.uncompressedSize <= limit)); }
    if (item.gated) {
        assert(item.sources[0].compressedSize > inputChunkSize && inputChunkSize > oldChunkSizes[0]);
        const partial = inflateRawSync(fixtures.get(item.sources[0].fixtureId).bytes.subarray(0, inputChunkSize), {finishFlush: constants.Z_SYNC_FLUSH});
        assert(partial.length > item.sources[0].uncompressedSize);
    }
    if (item.checkClippedBudget) {
        assert(decodedBytes > limit && Math.floor(decodedBytes / 1032) > inputChunkSize);
        assert(item.sources[0].compressedSize > inputChunkSize);
    }
    return {...item, reuseCrc, flags: {experimentalTermBankSpans: true, experimentalValidatedGlossaryReuse: true},
        decodedBytes, compressedBytes, inputChunkSize, oldChunkSizes, expectedRows: item.sources.reduce((sum, entry) => sum + entry.rows, 0),
        expectedSourceSha256: contentHash.digest('hex'),
        sources: item.sources.map((entry) => ({...entry, compressedSha256: sha(fixtures.get(entry.fixtureId).bytes)}))};
});
const report = {schemaVersion: 1, scope: 'Actual Chrome functional source/integrity/resource-policy validation only. The 16 MiB rule is a nominal decoded-burst policy, not an absolute browser-memory bound. No performance or memory qualification.',
    instrumentation: 'Genuine native DecompressionStream, readable and writable operations throughout. The overrun case holds API promise completion after real native operations settle; it supplies no synthetic decoded bytes. This tests the parser joining API operations, not allocator lifetime or a native-memory ceiling.',
    policy: {maximumAdmittedBankBytes: limit, inputChunkFormula: 'max(1,floor(min(groupDecodedBytes,16777216)/1032))', conservativeDeferredCrcExclusion: true},
    cases, fixtures: [...fixtures].map(([id, value]) => ({id, bytes: value.bytes.length, compressedSha256: sha(value.bytes), decodedBytes: value.decoded.length, decodedSha256: sha(value.decoded)})),
    runnerSha256: sha(await readFile(fileURLToPath(import.meta.url))), browserLock, browserLockSha256: sha(browserLockBytes),
    node: process.version, sources: {}, observations: [], servedFileHashes: {}, status: 'preparing'};
for (const [arm, root] of Object.entries(roots)) {
    const files = ['ext/js/dictionary/term-bank-wasm-parser.js', 'ext/lib/term-bank-parser.wasm', 'package-lock.json'];
    report.sources[arm] = {sha: git(root, 'rev-parse', 'HEAD'), tree: git(root, 'rev-parse', 'HEAD^{tree}'),
        sourceHashes: Object.fromEntries(await Promise.all(files.map(async (file) => [file, sha(await readFile(path.join(root, file)))])))};
}
assert.equal(report.sources.A.tree, 'd99ea4d04658f7ec1c76acdc5f3684594212a471');
assert.equal(report.sources.C.tree, 'e9a70a78ee4e6b499dbafb5fcc8318f74afcd867');
assert.equal(report.sources.A.sourceHashes['ext/js/dictionary/term-bank-wasm-parser.js'], '31854cfb3d20ba60b701ec31cf19de26bd55cc745cc4f998cb33f0554ec83cca');
assert.equal(report.sources.C.sourceHashes['ext/js/dictionary/term-bank-wasm-parser.js'], 'ad56163e4876e6b8d888c1a37c91ab56e1c9d6a2518ff73b01251645c2113d51');
for (const arm of ['A', 'C']) {
    assert.equal(report.sources[arm].sourceHashes['ext/lib/term-bank-parser.wasm'], '8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee');
    assert.equal(report.sources[arm].sourceHashes['package-lock.json'], '01e065503317a90b43a5bc60cd9f874238762c75a13c8115a9c484a626960a96');
}
if (fixturesOnly) {
    console.log(JSON.stringify({status: 'fixtures-validated', cases: cases.length, nativePositive: cases.filter((item) => item.native === true).length,
        protectedFallback: cases.filter((item) => item.native === false).length, nativeError: cases.filter((item) => item.nativeError).length}));
    process.exit(0);
}

async function browserWorker() {
    const results = [];
    let activeCase = null;
    self.onmessage = async ({data}) => {
        const {arm, origin, cases: testCases} = data;
        const ensure = (value, message) => { if (!value) { throw new Error(message); } };
        const describeError = (error) => ({name: error.name, message: error.message});
        const hash = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)))]
            .map((byte) => byte.toString(16).padStart(2, '0')).join('');
        const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return {promise, resolve}; };
        const bounded = async (promise, label) => {
            let timeout;
            try { return await Promise.race([promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Canary stage timed out: ' + label)), 10000); })]); }
            finally { clearTimeout(timeout); }
        };
        try {
            const parser = await import(origin + '/' + arm + '/ext/js/dictionary/term-bank-wasm-parser.js');
            parser.setTermBankWasmModule(await WebAssembly.compile(await (await fetch(origin + '/' + arm + '/ext/lib/term-bank-parser.wasm')).arrayBuffer()));
            const native = self.DecompressionStream;
            const cache = new Map();
            const load = async (entry) => {
                if (!cache.has(entry.fixtureId)) {
                    const response = await fetch(origin + '/fixture/' + entry.fixtureId);
                    ensure(response.ok, 'Fixture request failed');
                    const bytes = new Uint8Array(await response.arrayBuffer());
                    ensure(bytes.length === entry.compressedSize && await hash(bytes) === entry.compressedSha256, 'Fixture bytes differ');
                    cache.set(entry.fixtureId, bytes);
                }
                return {...entry, bytes: cache.get(entry.fixtureId)};
            };
            self.__manabitanTermBankParserWorker = false;
            const warm = await load(testCases.find(({name}) => name === 'multibank-group-budget').sources[0]);
            const initial = await parser.inflateCompressedTermBankSourcesWasm([warm]);
            const wasm = initial.wasm;
            const originalReset = wasm.wasm_reset_heap;
            const originalInflate = wasm.inflate_and_join_term_banks;
            let current = null;
            wasm.wasm_reset_heap = () => { if (current) { ++current.wasmResets; } return originalReset(); };
            wasm.inflate_and_join_term_banks = (...args) => {
                if (current) {
                    ++current.wasmCalls;
                    const snapshot = current.streams.map((state) => ({pendingWrite: state.pendingWrite, pendingRead: state.pendingRead,
                        pendingCancel: state.pendingCancel, pendingAbort: state.pendingAbort,
                        readerLocked: state.readable.locked, writerLocked: state.writable.locked}));
                    current.fallbackSnapshots.push(snapshot);
                    ensure(snapshot.every((state) => Object.values(state).every((value) => value === 0 || value === false)), 'WASM fallback preceded native settlement');
                    current.events.push('wasm-fallback');
                }
                return originalInflate(...args);
            };
            for (const item of testCases) {
                activeCase = item.name;
                self.postMessage({type: 'active', name: item.name});
                const sources = await Promise.all(item.sources.map(load));
                const gates = {write: deferred(), cancel: deferred(), abort: deferred(), writeHeld: deferred(), cancelHeld: deferred(), abortHeld: deferred()};
                const held = arm === 'C' && item.gated === true;
                current = {nativeCalls: 0, wasmCalls: 0, wasmResets: 0, streams: [], fallbackSnapshots: [], events: [], snapshots: []};
                const stats = current;
                const snap = (name, settled) => {
                    const value = {name, inflationSettled: settled, wasmCalls: stats.wasmCalls, wasmResets: stats.wasmResets,
                        streams: stats.streams.map((state) => ({pendingWrite: state.pendingWrite, pendingCancel: state.pendingCancel, pendingAbort: state.pendingAbort,
                            readerLocked: state.readable.locked, writerLocked: state.writable.locked}))};
                    stats.snapshots.push(value);
                    return value;
                };
                self.DecompressionStream = class extends native {
                    constructor(format) {
                        super(format);
                        const index = ++stats.nativeCalls - 3;
                        // The first two real native streams are the parser's
                        // capability probes. Each case has a fresh constructor.
                        if (index < 0) { return; }
                        const entry = sources[index];
                        ensure(entry, 'Unexpected native bank');
                        const state = {index, readable: this.readable, writable: this.writable, writes: [], readLengths: [],
                            pendingWrite: 0, pendingRead: 0, pendingCancel: 0, pendingAbort: 0, oversizedReads: 0,
                            readerReleased: false, writerReleased: false, cleanupReasons: []};
                        stats.streams.push(state);
                        const getReader = state.readable.getReader.bind(state.readable);
                        state.readable.getReader = () => {
                            const reader = getReader();
                            const read = reader.read.bind(reader);
                            const cancel = reader.cancel.bind(reader);
                            const release = reader.releaseLock.bind(reader);
                            reader.read = async () => {
                                ++state.pendingRead;
                                try {
                                    const value = await read();
                                    if (!value.done) {
                                        state.readLengths.push(value.value.byteLength);
                                        if (value.value.byteLength > entry.uncompressedSize) { ++state.oversizedReads; stats.events.push('real-native-oversized-read'); }
                                    }
                                    return value;
                                } finally { --state.pendingRead; }
                            };
                            reader.cancel = async (reason) => {
                                ++state.pendingCancel;
                                state.cleanupReasons.push({direction: 'cancel', ...describeError(reason)});
                                stats.events.push('cancel-requested');
                                try { return await cancel(reason); }
                                finally {
                                    if (held && index === 0) { gates.cancelHeld.resolve(); await gates.cancel.promise; }
                                    --state.pendingCancel;
                                    stats.events.push('cancel-settled');
                                }
                            };
                            reader.releaseLock = () => { const value = release(); state.readerReleased = true; return value; };
                            return reader;
                        };
                        const getWriter = state.writable.getWriter.bind(state.writable);
                        state.writable.getWriter = () => {
                            const writer = getWriter();
                            const write = writer.write.bind(writer);
                            const abort = writer.abort.bind(writer);
                            const release = writer.releaseLock.bind(writer);
                            writer.write = async (chunk) => {
                                const number = state.writes.length;
                                const payloadWrites = Math.ceil(entry.compressedSize / item.inputChunkSize);
                                const kind = number === 0 ? 'header' : number <= payloadWrites ? 'payload' : 'trailer';
                                if (kind === 'payload') {
                                    const offset = (number - 1) * item.inputChunkSize;
                                    const expected = entry.bytes.subarray(offset, Math.min(offset + item.inputChunkSize, entry.bytes.length));
                                    ensure(chunk.byteLength === expected.byteLength && expected.every((byte, at) => chunk[at] === byte), 'Native payload chunk differs from fixed group policy');
                                }
                                state.writes.push({kind, bytes: chunk.byteLength});
                                ++state.pendingWrite;
                                try { return await write(chunk); }
                                finally {
                                    if (held && index === 0 && number === 1) { gates.writeHeld.resolve(); await gates.write.promise; }
                                    --state.pendingWrite;
                                    stats.events.push('write-settled-' + index + '-' + number);
                                }
                            };
                            writer.abort = async (reason) => {
                                ++state.pendingAbort;
                                state.cleanupReasons.push({direction: 'abort', ...describeError(reason)});
                                stats.events.push('abort-requested');
                                try { return await abort(reason); }
                                finally {
                                    if (held && index === 0) { gates.abortHeld.resolve(); await gates.abort.promise; }
                                    --state.pendingAbort;
                                    stats.events.push('abort-settled');
                                }
                            };
                            writer.releaseLock = () => { const value = release(); state.writerReleased = true; return value; };
                            return writer;
                        };
                    }
                };
                self.__manabitanTermBankParserWorker = true;
                let inflationSettled = false;
                const operation = parser.inflateCompressedTermBankSourcesWasm(sources, item.flags, item.reuseCrc)
                    .then((value) => { inflationSettled = true; return {ok: true, value}; }, (error) => { inflationSettled = true; return {ok: false, error}; });
                if (held) {
                    try {
                        await bounded(Promise.all([gates.writeHeld.promise, gates.cancelHeld.promise, gates.abortHeld.promise]), 'real native overrun cleanup');
                        ensure(stats.streams[0].oversizedReads > 0, 'Actual native decoder did not emit an oversized chunk');
                        ensure(stats.streams[0].writes[1].bytes > item.oldChunkSizes[0], 'Malformed neighbor did not exercise a larger input write');
                        for (const reason of stats.streams[0].cleanupReasons) {
                            ensure(reason.name === 'Error' && reason.message === 'Native term-bank output exceeds its declared length', 'Unexpected cleanup reason');
                        }
                        const first = snap('all-three-directions-held', inflationSettled);
                        ensure(!first.inflationSettled && first.wasmCalls === 0 && first.wasmResets === 1, 'Fallback/reset occurred while native operations were held');
                        ensure(first.streams[0].pendingWrite === 1 && first.streams[0].pendingCancel === 1 && first.streams[0].pendingAbort === 1, 'Missing independently held native operation');
                        gates.write.resolve();
                        await new Promise((resolve) => setTimeout(resolve, 0));
                        const second = snap('write-released-cancel-abort-held', inflationSettled);
                        ensure(!second.inflationSettled && second.wasmCalls === 0 && second.wasmResets === 1 && second.streams[0].pendingWrite === 0, 'Fallback did not wait after native write settlement');
                        gates.cancel.resolve();
                        await new Promise((resolve) => setTimeout(resolve, 0));
                        const third = snap('cancel-released-abort-held', inflationSettled);
                        ensure(!third.inflationSettled && third.wasmCalls === 0 && third.wasmResets === 1 && third.streams[0].pendingCancel === 0 && third.streams[0].pendingAbort === 1, 'Fallback did not await native abort settlement');
                    } finally {
                        gates.write.resolve(); gates.cancel.resolve(); gates.abort.resolve();
                    }
                }
                const outcome = await bounded(operation, 'inflation outcome');
                const result = {name: item.name, ok: outcome.ok, sourceDelivered: outcome.ok, publishedChunks: 0, rows: 0,
                    nativeCalls: stats.nativeCalls, wasmCalls: stats.wasmCalls, inflationWasmResets: stats.wasmResets,
                    streams: stats.streams.map((state) => ({index: state.index, writes: state.writes, readLengths: state.readLengths,
                        oversizedReads: state.oversizedReads, readerReleased: state.readerReleased, writerReleased: state.writerReleased,
                        pendingWrite: state.pendingWrite, pendingRead: state.pendingRead, pendingCancel: state.pendingCancel, pendingAbort: state.pendingAbort,
                        readerLocked: state.readable.locked, writerLocked: state.writable.locked, cleanupReasons: state.cleanupReasons})),
                    fallbackSnapshots: stats.fallbackSnapshots, events: stats.events, gateSnapshots: stats.snapshots};
                if (!outcome.ok) { result.error = describeError(outcome.error); }
                else {
                    const preloaded = outcome.value;
                    result.sourceSha256 = await hash(new Uint8Array(wasm.memory.buffer, preloaded.jsonPtr, preloaded.jsonLength));
                    result.sourceLength = preloaded.jsonLength;
                    result.sourceCount = preloaded.sourceCount;
                    result.spans = [...new Uint32Array(wasm.memory.buffer, preloaded.bankSpansPtr ?? 0, (preloaded.bankSpanCount ?? 0) * 2)];
                    result.crcSignaturesPresent = (preloaded.crcSignaturesPtr ?? 0) > 0;
                    try {
                        await parser.parseTermBankWithWasmColumnChunks(new Uint8Array(0), 3, (chunk) => { ++result.publishedChunks; result.rows += chunk.rowCount; }, 2048,
                            {...item.flags, preloadedSource: preloaded, singleChunk: true, emitTermByteLists: false, computeContentHashes: true,
                                emitContentSlab: true, emitTokenBinaryContent: true, validateGlossaryTypes: true});
                        result.crcVerified = preloaded.crcVerified === true;
                    } catch (error) { result.ok = false; result.error = describeError(error); }
                }
                results.push(result);
                self.postMessage({type: 'case', result});
            }
            current = null;
            self.postMessage({type: 'complete', arm, workerContext: self.constructor.name, crossOriginIsolated: self.crossOriginIsolated,
                hasSharedArrayBuffer: typeof SharedArrayBuffer === 'function', sharedWasmMemory: wasm.memory.buffer instanceof SharedArrayBuffer, results});
        } catch (error) {
            self.postMessage({type: 'complete', arm, activeCase, results, fatal: describeError(error)});
        }
    };
}

await mkdir(path.dirname(reportPath), {recursive: true});
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
const save = async () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
const server = createServer(async (request, response) => {
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    try {
        const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Native group burst policy canary</title>'); return; }
        if (pathname.startsWith('/fixture/')) {
            const entry = fixtures.get(pathname.slice('/fixture/'.length));
            assert(entry, 'Unknown fixture');
            response.setHeader('Content-Type', 'application/octet-stream'); response.end(entry.bytes); return;
        }
        const arm = pathname.split('/')[1];
        assert(arm in roots, 'Unknown source arm');
        const target = path.resolve(roots[arm], pathname.slice(3));
        assert(target.startsWith(roots[arm] + path.sep), 'Source path escapes root');
        const bytes = await readFile(target);
        const key = arm + '/' + path.relative(roots[arm], target);
        const digest = sha(bytes);
        assert(!report.servedFileHashes[key] || report.servedFileHashes[key] === digest, 'Source changed while serving');
        report.servedFileHashes[key] = digest;
        response.setHeader('Content-Type', target.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'); response.end(bytes);
    } catch (error) { response.writeHead(500); response.end(String(error)); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
let browser;
try {
    const {chromium} = requireCandidate('playwright');
    browser = await chromium.launch({headless: true});
    report.browserVersion = browser.version();
    assert.equal(report.browserVersion, browserLock.browserVersion);
    const page = await browser.newPage();
    await page.goto(origin);
    for (const arm of ['A', 'C']) {
        report.activeArm = arm; await save();
        const observation = await page.evaluate(({arm, origin, cases, code}) => new Promise((resolve) => {
            const url = URL.createObjectURL(new Blob(['(' + code + ')();'], {type: 'text/javascript'}));
            const worker = new Worker(url, {type: 'module'});
            const progress = [];
            let activeCase = null;
            const done = (value) => { clearTimeout(timeout); worker.terminate(); URL.revokeObjectURL(url); resolve({...value, progress, activeCase}); };
            const timeout = setTimeout(() => done({arm, results: progress, fatal: {name: 'TimeoutError', message: 'Policy worker timed out'}}), 120000);
            worker.onerror = (event) => done({arm, results: progress, fatal: {name: 'WorkerError', message: event.message}});
            worker.onmessage = ({data}) => {
                if (data.type === 'active') { activeCase = data.name; }
                else if (data.type === 'case') { progress.push(data.result); }
                else if (data.type === 'complete') { done(data); }
            };
            worker.postMessage({arm, origin, cases});
        }), {arm, origin, cases, code: browserWorker.toString()});
        report.observations.push(observation); await save();
        assert(!observation.fatal, JSON.stringify(observation.fatal));
        assert.equal(observation.workerContext, 'DedicatedWorkerGlobalScope');
        assert(observation.crossOriginIsolated && observation.hasSharedArrayBuffer && observation.sharedWasmMemory);
        assert.deepEqual(observation.results, observation.progress);
        assert.equal(observation.results.length, cases.length);
    }
    const [baseline, candidate] = report.observations;
    for (const [index, item] of cases.entries()) {
        const a = baseline.results[index], c = candidate.results[index];
        assert.equal(a.name, item.name); assert.equal(c.name, item.name);
        assert.equal(a.nativeCalls, 0); assert.equal(a.wasmCalls, 1);
        assert.equal(c.ok, a.ok); assert.equal(c.ok, !item.rejects);
        if (item.rejects) {
            assert.deepEqual(c.error, a.error);
            assert.equal(a.publishedChunks, 0); assert.equal(c.publishedChunks, 0);
            assert.equal(a.sourceDelivered, false); assert.equal(c.sourceDelivered, false);
        } else {
            let offset = 0; const spans = [];
            for (const entry of item.sources) { spans.push(offset, entry.uncompressedSize); offset += entry.uncompressedSize; }
            for (const result of [a, c]) {
                assert.equal(result.sourceSha256, item.expectedSourceSha256);
                assert.equal(result.sourceLength, item.decodedBytes);
                assert.equal(result.sourceCount, item.sources.length);
                assert.deepEqual(result.spans, spans);
                assert.equal(result.rows, item.expectedRows);
            }
        }
        if (item.native === false) {
            assert.equal(c.nativeCalls, 0, 'Protected route must skip capability probing too: ' + item.name);
            assert.equal(c.wasmCalls, 1); assert.deepEqual(c.streams, []);
        } else {
            assert.equal(c.nativeCalls, c.streams.length + 2);
            assert(c.streams.length > 0);
            assert.equal(c.wasmCalls, item.nativeError ? 1 : 0);
            if (item.native === true) { assert.equal(c.streams.length, item.sources.length); }
            for (const state of c.streams) {
                assert(state.readerReleased && state.writerReleased);
                assert.equal(state.pendingWrite + state.pendingRead + state.pendingCancel + state.pendingAbort, 0);
                assert(!state.readerLocked && !state.writerLocked);
                if (item.native === true) {
                    const payload = state.writes.filter(({kind}) => kind === 'payload').map(({bytes}) => bytes);
                    const size = item.sources[state.index].compressedSize;
                    assert.equal(payload.length, Math.ceil(size / item.inputChunkSize));
                    assert.equal(payload.reduce((sum, length) => sum + length, 0), size);
                    assert(payload.every((length) => length <= item.inputChunkSize));
                    assert.equal(payload[0], Math.min(size, item.inputChunkSize));
                }
            }
        }
        if (item.checkLargerSmallBankWrite) { assert(c.streams[0].writes[1].bytes > item.oldChunkSizes[0]); }
        if (item.checkClippedBudget) { assert.equal(c.streams[0].writes[1].bytes, Math.floor(limit / 1032)); }
        if (item.deferred) { assert(a.crcSignaturesPresent && c.crcSignaturesPresent && a.crcVerified && c.crcVerified); }
        if (item.gated) {
            assert.equal(c.streams.length, 1); assert(c.streams[0].oversizedReads > 0);
            assert.equal(c.gateSnapshots.length, 3);
            assert(c.gateSnapshots.every((snapshot) => !snapshot.inflationSettled && snapshot.wasmCalls === 0 && snapshot.wasmResets === 1));
            assert.equal(c.inflationWasmResets, 2);
            assert.equal(c.fallbackSnapshots.length, 1);
        }
    }
    report.status = 'success'; report.policyParityPassed = true; report.actualNativeTransportExercised = true; report.activeArm = null;
    await save();
    console.log(JSON.stringify({status: report.status, browserVersion: report.browserVersion, casesPerArm: cases.length, actualNativeTransportExercised: true}));
} catch (error) {
    report.status = 'failed'; report.failure = {name: error.name, message: error.message, stack: error.stack}; await save(); throw error;
} finally {
    await browser?.close(); await new Promise((resolve) => server.close(resolve));
}
