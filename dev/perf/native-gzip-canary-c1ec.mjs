#!/usr/bin/env node
/* Copyright (C) 2026 Manabitan authors. SPDX-License-Identifier: GPL-3.0-or-later */

// Research validation only. No timings from this instrumented canary qualify a speedup.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {crc32, deflateRawSync, gzipSync} from 'node:zlib';
import {chromium} from 'playwright';

const [baselineInput, candidateInput, outputInput] = process.argv.slice(2);
assert(baselineInput && candidateInput && outputInput, 'Provide baseline root, candidate root, report path');
const roots = {A: path.resolve(baselineInput), B: path.resolve(candidateInput)};
const reportPath = path.resolve(outputInput);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const browserLockBytes = await readFile(path.join(roots.B, 'node_modules/playwright-core/browsers.json'));
const chromiumLock = JSON.parse(browserLockBytes).browsers.find((item) => item.name === 'chromium');
assert(chromiumLock?.browserVersion, 'Missing pinned Chromium metadata');
const git = (root, ...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trim();
const encoder = new TextEncoder();
const row = '["猫","ねこ","","",0,["cat"],1,""]';
const bank = `[${row}]`;
const paddedEmptyBank = ' '.repeat(64) + '[]';
const source = (text, method = 8) => {
    const decoded = encoder.encode(text);
    const bytes = method === 8 ? deflateRawSync(decoded) : decoded;
    return {bytes: [...bytes], compressionMethod: method, compressedSize: bytes.length,
        uncompressedSize: decoded.length, signature: crc32(decoded)};
};
const corrupt = (kind) => {
    // Keep every malformed fixture inside the native admission boundary,
    // including the extra concatenated-member bytes and short declared size.
    const item = source(kind === 'array-wrapper' ? ' '.repeat(64) + '{"bad":[]}' : `[${Array(8).fill(row).join(',')}]`);
    if (kind === 'crc') { item.signature = (item.signature ^ 1) >>> 0; }
    if (kind === 'short-size') { --item.uncompressedSize; }
    if (kind === 'long-size') { ++item.uncompressedSize; }
    if (kind === 'truncated') { item.bytes = item.bytes.slice(0, -2); }
    if (kind === 'trailing') { item.bytes.push(0xde, 0xad); }
    if (kind === 'trailing-zero') { item.bytes.push(0); }
    if (kind === 'concatenated-members') {
        item.bytes = [...deflateRawSync(new Uint8Array(0)), ...new Uint8Array(8),
            0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255, ...item.bytes];
    }
    item.compressedSize = item.bytes.length;
    return item;
};
const repeatedBank = JSON.stringify([['繰返し', '', '', '', 0, ['x'.repeat(2 * 1024 * 1024)], 2, '']]);
const declaredOutputOverrun = source(repeatedBank);
declaredOutputOverrun.uncompressedSize = Math.max(declaredOutputOverrun.compressedSize, 2048);
const cases = [
    {name: 'single-compact', sources: [source(bank)], native: true},
    {name: 'single-padded', sources: [source(` \n[ \t${row} \r]\n `)], native: true},
    {name: 'single-empty', sources: [source(paddedEmptyBank)], native: true},
    {name: 'independent-banks', sources: [source(bank), source(paddedEmptyBank), source(bank)], native: true},
    {name: 'explicit-single-boundary', sources: [source(` \n${bank}\t`)], flags: {experimentalTermBankSpans: true}, native: true},
    {name: 'mixed-stored-deflate', sources: [source('[]', 0), source(bank)], native: false},
    {name: 'expanding-deflate', sources: [source('[]')], native: false},
    {name: 'outside-worker', sources: [source(bank)], worker: false, native: false},
    {name: 'high-ratio-crc-reuse', sources: [source(repeatedBank), source(repeatedBank)], native: false},
    {name: 'admitted-large-output-overrun', sources: [declaredOutputOverrun], rejects: true, nativeError: true},
    ...['crc', 'short-size', 'long-size', 'truncated', 'trailing', 'trailing-zero', 'array-wrapper', 'concatenated-members']
        .map((kind) => ({name: kind, sources: [source(paddedEmptyBank), corrupt(kind), source(paddedEmptyBank)], rejects: true, nativeError: true})),
    {name: 'earlier-crc-later-deflate', sources: [corrupt('crc'), corrupt('truncated')], rejects: true, nativeError: true},
    {name: 'earlier-deflate-later-crc', sources: [corrupt('truncated'), corrupt('crc')], rejects: true, nativeError: true},
];
for (const item of cases) {
    if (item.native === true || item.nativeError === true) {
        assert(item.sources.every((entry) => entry.compressionMethod === 8 && entry.compressedSize <= entry.uncompressedSize),
            `Fixture bypasses native admission: ${item.name}`);
    }
}
const validGzip = gzipSync(encoder.encode(bank));
const badCrc = Buffer.from(validGzip);
badCrc[badCrc.length - 8] ^= 1;
const badSize = Buffer.from(validGzip);
badSize[badSize.length - 4] ^= 1;
const nativeCases = [
    {name: 'valid', bytes: [...validGzip], decodedSha256: sha(encoder.encode(bank))},
    {name: 'valid-empty', bytes: [...gzipSync(new Uint8Array(0))], decodedSha256: sha(new Uint8Array(0))},
    {name: 'concatenated-members', bytes: [...gzipSync(new Uint8Array(0)), ...validGzip], rejects: true},
    {name: 'crc', bytes: [...badCrc], rejects: true},
    {name: 'isize', bytes: [...badSize], rejects: true},
    {name: 'truncated', bytes: [...validGzip.subarray(0, -3)], rejects: true},
    {name: 'trailing', bytes: [...validGzip, 0xde, 0xad], rejects: true},
    {name: 'trailing-zero', bytes: [...validGzip, 0], rejects: true},
];
if (process.argv.includes('--fixtures-only')) {
    console.log(JSON.stringify({status: 'fixtures-validated', parserCases: cases.length, nativeCases: nativeCases.length,
        nativeAdmissionCases: cases.filter((item) => item.native === true || item.nativeError === true).length}));
    process.exit(0);
}

// Executed in a real dedicated Chrome Worker, with the actual selected parser module.
async function browserWorker() {
    self.onmessage = async ({data}) => {
        try {
            const {arm, origin, cases: testCases, nativeCases: streamCases} = data;
            const hash = async (value) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', value))]
                .map((byte) => byte.toString(16).padStart(2, '0')).join('');
            const nativeResults = [];
            for (const item of streamCases) {
                try {
                    const stream = new Blob([Uint8Array.from(item.bytes)]).stream().pipeThrough(new DecompressionStream('gzip'));
                    nativeResults.push({name: item.name, ok: true, sha256: await hash(await new Response(stream).arrayBuffer())});
                } catch (error) {
                    nativeResults.push({name: item.name, ok: false, error: {name: error.name, message: error.message}});
                }
            }
            const NativeDecompressionStream = self.DecompressionStream;
            let nativeCalls = 0;
            self.DecompressionStream = class extends NativeDecompressionStream {
                constructor(format) { super(format); ++nativeCalls; }
            };
            self.__manabitanTermBankParserWorker = true;
            const parser = await import(`${origin}/${arm}/ext/js/dictionary/term-bank-wasm-parser.js`);
            const prep = await import(`${origin}/${arm}/ext/js/dictionary/term-lookup-index-preparation.js`);
            const wasmResponse = await fetch(`${origin}/${arm}/ext/lib/term-bank-parser.wasm`);
            if (!wasmResponse.ok) { throw new Error(`WASM fetch failed: ${wasmResponse.status}`); }
            parser.setTermBankWasmModule(await WebAssembly.compile(await wasmResponse.arrayBuffer()));
            const convert = (items) => items.map((item) => ({...item, bytes: Uint8Array.from(item.bytes)}));
            const initial = await parser.inflateCompressedTermBankSourcesWasm(convert(testCases[0].sources), {}, true);
            const originalInflate = initial.wasm.inflate_and_join_term_banks;
            let wasmCalls = 0;
            initial.wasm.inflate_and_join_term_banks = (...args) => { ++wasmCalls; return originalInflate(...args); };
            const results = [];
            for (const item of testCases) {
                nativeCalls = 0;
                wasmCalls = 0;
                self.__manabitanTermBankParserWorker = item.worker !== false;
                let publishedChunks = 0;
                try {
                    const flags = item.flags ?? {};
                    const preloaded = await parser.inflateCompressedTermBankSourcesWasm(convert(item.sources), flags, true);
                    const sourceSha256 = await hash(Uint8Array.from(new Uint8Array(preloaded.wasm.memory.buffer, preloaded.jsonPtr, preloaded.jsonLength)));
                    const spans = [...new Uint32Array(preloaded.wasm.memory.buffer, preloaded.bankSpansPtr ?? 0, (preloaded.bankSpanCount ?? 0) * 2)];
                    const parts = [];
                    const addView = (view) => { if (view) { parts.push(Uint8Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))); } };
                    let rows = 0;
                    let indexBytes = 0;
                    await parser.parseTermBankWithWasmColumnChunks(new Uint8Array(0), 3, (chunk) => {
                        ++publishedChunks;
                        rows += chunk.rowCount;
                        if (chunk.rowCount > 0 && !chunk.preparedLookupIndexes) {
                            const prepared = prep.prepareTermLookupIndexesFromPreinternedPlan(chunk, null, flags);
                            if (!prepared) { throw new Error('Missing completed lookup indexes'); }
                            chunk.preparedLookupIndexes = prepared.indexes;
                        }
                        if (chunk.rowCount > 0 && !prep.hasCompletePreparedTermLookupIndexes(chunk.preparedLookupIndexes, chunk.rowCount)) {
                            throw new Error('Incomplete lookup indexes');
                        }
                        for (const [key, entry] of chunk.preparedLookupIndexes ?? []) {
                            parts.push(new TextEncoder().encode(key));
                            addView(entry.bytes);
                            indexBytes += entry.bytes.byteLength;
                            for (const view of [entry.preinternedPlan.stringLengths, entry.preinternedPlan.stringOffsets,
                                entry.preinternedPlan.stringHashes, entry.preinternedPlan.stringsBuffer,
                                Uint32Array.from(entry.preinternedPlan.expressionIndexes), entry.preinternedPlan.readingIndexes]) { addView(view); }
                        }
                        addView(chunk.readingEqualsExpressionList);
                        addView(chunk.scoreList);
                        addView(chunk.sequenceList);
                        const {contentMetaList, contentBytesBuffer, contentBytesBaseOffset} = chunk;
                        if (chunk.rowCount > 0 && (!contentMetaList || !contentBytesBuffer || typeof contentBytesBaseOffset !== 'number')) {
                            throw new Error('Missing complete content slab');
                        }
                        for (let rowIndex = 0; rowIndex < chunk.rowCount; ++rowIndex) {
                            const offset = contentBytesBaseOffset + contentMetaList[rowIndex * 4];
                            addView(contentBytesBuffer.subarray(offset, offset + contentMetaList[rowIndex * 4 + 1]));
                            addView(contentMetaList.subarray(rowIndex * 4 + 1, rowIndex * 4 + 4));
                        }
                    }, 2048, {...flags, preloadedSource: preloaded, singleChunk: true, emitTermByteLists: false,
                        computeContentHashes: true, emitContentSlab: true, emitTokenBinaryContent: true,
                        mediaHintFastScan: true, validateGlossaryTypes: true, prepareLookupIndexes: true});
                    const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
                    let offset = 0;
                    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
                    results.push({name: item.name, ok: true, sourceSha256, spans, rows, indexBytes,
                        outputSha256: await hash(bytes), publishedChunks, nativeCalls, wasmCalls});
                } catch (error) {
                    results.push({name: item.name, ok: false, error: {name: error.name, message: error.message}, publishedChunks, nativeCalls, wasmCalls});
                }
            }
            self.postMessage({arm, workerContext: self.constructor.name, crossOriginIsolated: self.crossOriginIsolated,
                hasSharedArrayBuffer: typeof SharedArrayBuffer === 'function',
                sharedWasmMemory: typeof SharedArrayBuffer === 'function' && initial.wasm.memory.buffer instanceof SharedArrayBuffer,
                nativeResults, results});
        } catch (error) {
            self.postMessage({fatal: {name: error.name, message: error.message, stack: error.stack}});
        }
    };
}

const report = {schemaVersion: 1, scope: 'Chrome worker capability and integrity validation; no performance qualification',
    browserLock: chromiumLock, browserLockSha256: sha(browserLockBytes),
    startedAt: new Date().toISOString(), node: process.version, sources: {}, cases: cases.map(({sources, ...item}) => ({...item,
        sources: sources.map(({bytes, ...metadata}) => ({...metadata, compressedSha256: sha(Uint8Array.from(bytes))}))})), nativeCases: nativeCases.map(({bytes, ...item}) => ({...item, sha256: sha(Uint8Array.from(bytes))})), observations: []};
for (const [arm, root] of Object.entries(roots)) {
    const files = ['ext/js/dictionary/term-bank-wasm-parser.js', 'ext/lib/term-bank-parser.wasm', 'package-lock.json'];
    report.sources[arm] = {root, sha: git(root, 'rev-parse', 'HEAD'), tree: git(root, 'rev-parse', 'HEAD^{tree}'),
        sourceHashes: Object.fromEntries(await Promise.all(files.map(async (file) => [file, sha(await readFile(path.join(root, file)))])))};
}
assert.equal(report.sources.A.sourceHashes['ext/lib/term-bank-parser.wasm'], report.sources.B.sourceHashes['ext/lib/term-bank-parser.wasm']);
assert.equal(report.sources.A.sourceHashes['package-lock.json'], report.sources.B.sourceHashes['package-lock.json']);
report.runnerSha256 = sha(await readFile(fileURLToPath(import.meta.url)));
await mkdir(path.dirname(reportPath), {recursive: true});
const save = async () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
await save();
const server = createServer(async (request, response) => {
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    try {
        const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Native gzip integrity canary</title>'); return; }
        const arm = pathname.split('/')[1];
        if (!(arm in roots)) { response.writeHead(404); response.end(); return; }
        const target = path.resolve(roots[arm], pathname.slice(3));
        if (!target.startsWith(roots[arm] + path.sep)) { response.writeHead(403); response.end(); return; }
        response.setHeader('Content-Type', target.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        response.end(await readFile(target));
    } catch (error) { response.writeHead(500); response.end(String(error)); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
    browser = await chromium.launch({headless: true});
    report.browserVersion = browser.version();
    assert.equal(report.browserVersion, chromiumLock.browserVersion, 'Unexpected pinned Chromium version');
    const page = await browser.newPage();
    await page.goto(origin);
    for (const arm of ['A', 'B']) {
        const observation = await page.evaluate(({arm, origin, cases, nativeCases, workerCode}) => new Promise((resolve, reject) => {
            const url = URL.createObjectURL(new Blob([`(${workerCode})();`], {type: 'text/javascript'}));
            const worker = new Worker(url, {type: 'module'});
            const timeout = setTimeout(() => { worker.terminate(); URL.revokeObjectURL(url); reject(new Error('Worker canary timed out')); }, 120000);
            worker.onerror = (event) => { clearTimeout(timeout); worker.terminate(); URL.revokeObjectURL(url); reject(new Error(event.message)); };
            worker.onmessage = ({data}) => { clearTimeout(timeout); worker.terminate(); URL.revokeObjectURL(url); resolve(data); };
            worker.postMessage({arm, origin, cases, nativeCases});
        }), {arm, origin, cases, nativeCases, workerCode: browserWorker.toString()});
        report.observations.push(observation);
        await save();
        assert(!observation.fatal, JSON.stringify(observation.fatal));
        assert.equal(observation.workerContext, 'DedicatedWorkerGlobalScope', 'Canary did not execute in a dedicated worker');
        assert.equal(observation.crossOriginIsolated, true, 'Worker is not cross-origin isolated');
        assert.equal(observation.hasSharedArrayBuffer, true, 'SharedArrayBuffer is unavailable');
    }
    const [a, b] = report.observations;
    for (let index = 0; index < cases.length; ++index) {
        const item = cases[index];
        const before = a.results[index];
        const after = b.results[index];
        const resultOnly = ({nativeCalls, wasmCalls, ...result}) => result;
        assert.deepEqual(resultOnly(after), resultOnly(before), `Parser result differs: ${item.name}`);
        assert.equal(after.ok, !item.rejects, `Unexpected acceptance/rejection: ${item.name}`);
        if (item.rejects) { assert.equal(after.publishedChunks, 0, `Published invalid source: ${item.name}`); }
        if (item.nativeError === true) {
            assert(after.nativeCalls > 0, `Malformed fixture did not exercise native validation: ${item.name}`);
            assert.equal(after.wasmCalls, 1, `Malformed native fixture did not retry the original validator: ${item.name}`);
        }
        if (item.native === true) {
            assert.equal(before.wasmCalls, 1, `Baseline did not use WASM: ${item.name}`);
            assert.equal(after.nativeCalls, item.sources.length, `Native fast path was not exercised: ${item.name}`);
            assert.equal(after.wasmCalls, 0, `Candidate fell back on a valid native case: ${item.name}`);
        } else if (item.native === false) {
            assert.equal(after.nativeCalls, 0, `Protected fallback changed: ${item.name}`);
            assert.equal(after.wasmCalls, 1, `Expected existing WASM route: ${item.name}`);
        }
    }
    report.moduleParityPassed = true;
    for (const observation of [a, b]) {
        for (let index = 0; index < nativeCases.length; ++index) {
            const expected = nativeCases[index];
            const actual = observation.nativeResults[index];
            assert.equal(actual.ok, !expected.rejects, `Native gzip conformance: ${expected.name}`);
            if (!expected.rejects) { assert.equal(actual.sha256, expected.decodedSha256); }
        }
    }
    report.nativeConformancePassed = true;
    report.nativeFastPathExercised = true;
    report.status = 'success';
} catch (error) {
    report.status = 'failure';
    report.failure = {name: error.name, message: error.message, stack: error.stack};
    process.exitCode = 1;
} finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    report.completedAt = new Date().toISOString();
    await save();
    console.log(JSON.stringify({status: report.status, browserVersion: report.browserVersion,
        moduleParityPassed: report.moduleParityPassed, nativeConformancePassed: report.nativeConformancePassed,
        nativeFastPathExercised: report.nativeFastPathExercised, failure: report.failure}));
}
