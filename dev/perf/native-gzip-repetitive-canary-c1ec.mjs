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
        uncompressedSize: decoded.length, signature: crc32(decoded),
        referenceDecodedSize: decoded.length, referenceDecodedSha256: sha(decoded)};
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
// Large raw input with tiny parser output keeps negative probes bounded. Every
// ordinary member compresses, including empty-bank controls.
const paddedBank = (body = bank) => ' '.repeat(2 * 1024 * 1024) + body;
const highRatioSource = source(paddedBank());
const highRatioSources = () => [structuredClone(highRatioSource), structuredClone(highRatioSource)];
const highRatioCorrupt = (kind) => {
    const item = kind === 'wrapper' ? source(paddedBank('{"bad":[]}')) :
        kind === 'bom' ? source('\uFEFF' + paddedBank()) : structuredClone(highRatioSource);
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
const declaredOutputOverrun = source(repeatedBank);
declaredOutputOverrun.uncompressedSize = Math.max(declaredOutputOverrun.compressedSize, 2048);
const highRatioOutputOverrun = structuredClone(highRatioSource);
highRatioOutputOverrun.uncompressedSize = 1024 * 1024;
const cases = [
    {name: 'single-compact', sources: [source(bank)], native: true},
    {name: 'single-padded', sources: [source(` \n[ \t${row} \r]\n `)], native: true},
    {name: 'single-empty', sources: [source(paddedEmptyBank)], native: true},
    {name: 'independent-banks', sources: [source(bank), source(paddedEmptyBank), source(bank)], native: true},
    {name: 'explicit-single-boundary', sources: [source(` \n${bank}\t`)], flags: {experimentalTermBankSpans: true}, native: true},
    {name: 'mixed-stored-deflate', sources: [source('[]', 0), source(bank)], native: false},
    {name: 'expanding-deflate', sources: [source('[]')], native: false},
    {name: 'outside-worker', sources: [source(bank)], worker: false, native: false},
    {name: 'high-ratio-crc-reuse', sources: [source(repeatedBank), source(repeatedBank)],
        native: true, highRatio: true, requireBaselineReuse: true, sameCanonicalContent: true},
    {name: 'admitted-large-output-overrun', sources: [declaredOutputOverrun], rejects: true, nativeError: true},
    ...['crc', 'short-size', 'long-size', 'truncated', 'trailing', 'trailing-zero', 'array-wrapper', 'concatenated-members']
        .map((kind) => ({name: kind, sources: [source(paddedEmptyBank), corrupt(kind), source(paddedEmptyBank)], rejects: true, nativeError: true})),
    {name: 'earlier-crc-later-deflate', sources: [corrupt('crc'), corrupt('truncated')], rejects: true, nativeError: true},
    {name: 'earlier-deflate-later-crc', sources: [corrupt('truncated'), corrupt('crc')], rejects: true, nativeError: true},
    {name: 'high-ratio-small-output', sources: highRatioSources(), native: true, highRatio: true},
    {name: 'high-ratio-large-output-overrun', sources: [highRatioOutputOverrun, ...highRatioSources()],
        highRatio: true, rejects: true, nativeError: true},
    {name: 'high-ratio-raw-distinct-canonical-equal', sources: [
        source(paddedBank('[ ["a","","","",0,["cat"],1,""] ]')),
        source(paddedBank('[ ["b","","","",0,[{"type":"text","text":"cat"}],2,""] ]')),
    ], native: true, highRatio: true, sameCanonicalContent: true, rawDistinct: true},
    {name: 'high-ratio-escaped-key-fallback', sources: [
        source(paddedBank('[ ["\\u0061","","","",0,["cat"],1,""] ]')), structuredClone(highRatioSource),
    ], flags: {experimentalNativeEscapedKeys: false}, native: true, highRatio: true, requireParserFallback: true},
    {name: 'high-ratio-media-output', sources: [
        source(paddedBank(JSON.stringify([['image', '', '', '', 0, [{type: 'image', path: 'img.png', width: 7, height: 9}], 1, '']]))),
        structuredClone(highRatioSource),
    ], native: true, highRatio: true, requireMediaRows: true},
    ...[0, 1, 2].map((index) => {
        const sources = [...highRatioSources(), structuredClone(highRatioSource)];
        sources[index] = highRatioCorrupt('crc');
        return {name: `high-ratio-crc-bank-${index}`, sources, highRatio: true, rejects: true, nativeError: true};
    }),
    ...['short-size', 'long-size', 'truncated', 'trailing', 'trailing-zero', 'wrapper', 'bom', 'concatenated-members']
        .map((kind) => ({name: `high-ratio-${kind}`, sources: [highRatioCorrupt(kind), structuredClone(highRatioSource)],
            highRatio: true, rejects: true, nativeError: true})),
    ...['wrapper', 'truncated', 'trailing', 'bom'].flatMap((kind) => [
        {name: `high-ratio-crc-before-${kind}`, sources: [highRatioCorrupt('crc'), highRatioCorrupt(kind)],
            highRatio: true, rejects: true, nativeError: true, errorControl: 'high-ratio-crc-bank-0'},
        {name: `high-ratio-${kind}-before-crc`, sources: [highRatioCorrupt(kind), highRatioCorrupt('crc')],
            highRatio: true, rejects: true, nativeError: true, errorControl: `high-ratio-${kind}`},
    ]),
    ...['parse-trap', 'allocation-throw'].flatMap((fault) => [
        {name: `high-ratio-${fault}-valid-crc`, sources: highRatioSources(), fault,
            highRatio: true, native: true, rejects: true},
        {name: `high-ratio-${fault}-bad-crc`, sources: [highRatioCorrupt('crc'), structuredClone(highRatioSource)], fault,
            highRatio: true, nativeError: true, rejects: true, errorControl: 'high-ratio-crc-bank-0'},
    ]),
    {name: 'high-ratio-mixed-stored', sources: [...highRatioSources(), source('[]', 0)], highRatio: true, native: false},
    {name: 'high-ratio-expanding-member', sources: [...highRatioSources(), source('[]')], highRatio: true, native: false},
    {name: 'high-ratio-outside-worker', sources: highRatioSources(), highRatio: true, worker: false, native: false},
    {name: 'high-ratio-unsupported-decoder', sources: highRatioSources(), highRatio: true, unsupportedDecoder: true},
    // A successful transaction after all injected failures catches leaked fault
    // switches, stale rejection state, or damaged reusable parser memory.
    {name: 'high-ratio-recovery', sources: highRatioSources(), highRatio: true, native: true},
];
for (const item of cases) {
    for (const entry of item.sources) {
        assert.equal(entry.bytes.length, entry.compressedSize, `Compressed length: ${item.name}`);
        assert(Number.isSafeInteger(entry.uncompressedSize) && entry.uncompressedSize > 0, `Decoded length: ${item.name}`);
        assert(Number.isInteger(entry.signature) && entry.signature >= 0 && entry.signature <= 0xffffffff, `CRC metadata: ${item.name}`);
    }
    if (item.native === true || item.nativeError === true) {
        assert(item.sources.every((entry) => entry.compressionMethod === 8 && entry.compressedSize <= entry.uncompressedSize),
            `Fixture bypasses native admission: ${item.name}`);
    }
    if (item.highRatio) {
        const decoded = item.sources.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
        const compressed = item.sources.reduce((sum, entry) => sum + entry.compressedSize, 0);
        assert(item.sources.length > 1 && decoded >= 4 * 1024 * 1024 && compressed <= Math.floor(decoded / 32),
            `Fixture bypasses baseline deferred-CRC admission: ${item.name}`);
    }
    if (item.rawDistinct) { assert.notEqual(item.sources[0].referenceDecodedSha256, item.sources[1].referenceDecodedSha256); }
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
        nativeAdmissionCases: cases.filter((item) => item.native === true || item.nativeError === true).length,
        deferredAdmissionCases: cases.filter((item) => item.highRatio).length}));
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
            const CountingStream = class extends NativeDecompressionStream {
                constructor(format) { super(format); ++nativeCalls; }
            };
            const UnsupportedStream = class {
                constructor() { ++nativeCalls; throw new TypeError('Canary decoder is unavailable'); }
            };
            self.DecompressionStream = CountingStream;
            self.__manabitanTermBankParserWorker = true;
            const parser = await import(`${origin}/${arm}/ext/js/dictionary/term-bank-wasm-parser.js`);
            const prep = await import(`${origin}/${arm}/ext/js/dictionary/term-lookup-index-preparation.js`);
            const wasmResponse = await fetch(`${origin}/${arm}/ext/lib/term-bank-parser.wasm`);
            if (!wasmResponse.ok) { throw new Error(`WASM fetch failed: ${wasmResponse.status}`); }
            parser.setTermBankWasmModule(await WebAssembly.compile(await wasmResponse.arrayBuffer()));
            const convert = (items) => items.map((item) => ({...item, bytes: Uint8Array.from(item.bytes)}));
            const initial = await parser.inflateCompressedTermBankSourcesWasm(convert(testCases[0].sources), {}, true);
            const originalInflate = initial.wasm.inflate_and_join_term_banks;
            const originalVerify = initial.wasm.verify_term_bank_source_crcs;
            const originalFused = initial.wasm.parse_and_encode_term_bank_token_binary_dedup;
            const originalAllocate = initial.wasm.wasm_alloc;
            if (typeof originalVerify !== 'function') { throw new Error('Missing deferred source verifier'); }
            let wasmCalls = 0;
            let verifierCalls = 0;
            let fusedCalls = 0;
            let witnessCalls = 0;
            let faultCalls = 0;
            let activeFault = null;
            let wasmDeferredFlags = [];
            initial.wasm.inflate_and_join_term_banks = (...args) => {
                ++wasmCalls;
                wasmDeferredFlags.push(args.at(-1));
                return originalInflate(...args);
            };
            initial.wasm.verify_term_bank_source_crcs = (...args) => { ++verifierCalls; return originalVerify(...args); };
            initial.wasm.parse_and_encode_term_bank_token_binary_dedup = (...args) => {
                if (args.length !== 39) { throw new Error('Unexpected source-bound fused parser signature'); }
                ++fusedCalls;
                // The source-bound native signature ends in witness and media
                // pointers. This observation does not mutate either column.
                if (args.at(-2) !== 0) { ++witnessCalls; }
                if (activeFault === 'parse-trap') { ++faultCalls; throw new WebAssembly.RuntimeError('Canary injected parse trap'); }
                return originalFused(...args);
            };
            initial.wasm.wasm_alloc = (...args) => {
                if (activeFault === 'allocation-throw') { ++faultCalls; throw new RangeError('Canary injected allocation failure'); }
                return originalAllocate(...args);
            };
            const results = [];
            for (const item of testCases) {
                nativeCalls = 0;
                wasmCalls = 0;
                verifierCalls = 0;
                fusedCalls = 0;
                witnessCalls = 0;
                faultCalls = 0;
                wasmDeferredFlags = [];
                activeFault = null;
                self.__manabitanTermBankParserWorker = item.worker !== false;
                self.DecompressionStream = item.unsupportedDecoder ? UnsupportedStream : CountingStream;
                parser.consumeLastTermBankWasmParseProfile();
                let publishedChunks = 0;
                let preloaded = null;
                let stage = 'inflate';
                const diagnostics = () => ({nativeCalls, wasmCalls, verifierCalls, fusedCalls, witnessCalls, faultCalls, wasmDeferredFlags,
                    hasPreloadedSource: preloaded !== null,
                    deferredCrc: Boolean(preloaded?.crcSignaturesPtr), crcStats: Boolean(preloaded?.crcStatsPtr),
                    crcVerified: preloaded?.crcVerified === true,
                    crcReusedBytes: preloaded?.crcReusedBytes ?? 0, crcScannedBytes: preloaded?.crcScannedBytes ?? 0});
                try {
                    const flags = item.flags ?? {};
                    preloaded = await parser.inflateCompressedTermBankSourcesWasm(convert(item.sources), flags, true);
                    const sourceSha256 = await hash(Uint8Array.from(new Uint8Array(preloaded.wasm.memory.buffer, preloaded.jsonPtr, preloaded.jsonLength)));
                    const spans = [...new Uint32Array(preloaded.wasm.memory.buffer, preloaded.bankSpansPtr ?? 0, (preloaded.bankSpanCount ?? 0) * 2)];
                    const parts = [];
                    const addView = (label, view) => {
                        if (view == null) { return; }
                        if (!ArrayBuffer.isView(view)) { throw new Error(`Unexpected result column: ${label}`); }
                        parts.push({label, type: view.constructor.name,
                            bytes: Uint8Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))});
                    };
                    const addJson = (label, value) => parts.push({label, type: 'json', bytes: new TextEncoder().encode(JSON.stringify(value))});
                    let rows = 0;
                    let indexBytes = 0;
                    let mediaRows = 0;
                    stage = 'parse';
                    activeFault = item.fault ?? null;
                    await parser.parseTermBankWithWasmColumnChunks(new Uint8Array(0), 3, (chunk) => {
                        ++publishedChunks;
                        if (preloaded.crcSignaturesPtr && preloaded.crcVerified !== true) {
                            throw new Error('A deferred CRC source reached the sink before verification');
                        }
                        const prefix = `chunk${publishedChunks}`;
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
                            addJson(`${prefix}/index-key`, key);
                            addView(`${prefix}/index/${key}/bytes`, entry.bytes);
                            indexBytes += entry.bytes.byteLength;
                            for (const field of ['stringLengths', 'stringOffsets', 'stringHashes', 'stringsBuffer', 'readingIndexes']) {
                                addView(`${prefix}/index/${key}/${field}`, entry.preinternedPlan[field]);
                            }
                            addView(`${prefix}/index/${key}/expressionIndexes`, entry.preinternedPlan.expressionIndexes);
                        }
                        for (const field of ['readingEqualsExpressionList', 'scoreList', 'sequenceList', 'contentMetaList',
                            'contentUniqueIndexList', 'contentHash1List', 'contentHash2List']) { addView(`${prefix}/${field}`, chunk[field]); }
                        for (const field of ['expressionBytesList', 'readingBytesList', 'contentBytesList']) {
                            for (const [index, view] of (chunk[field] ?? []).entries()) { addView(`${prefix}/${field}/${index}`, view); }
                        }
                        for (const field of ['stringLengths', 'stringOffsets', 'stringHashes', 'stringsBuffer', 'readingIndexes']) {
                            addView(`${prefix}/termPlan/${field}`, chunk.termRecordPreinternedPlan?.[field]);
                        }
                        if (chunk.termRecordPreinternedPlan) {
                            addView(`${prefix}/termPlan/expressionIndexes`, chunk.termRecordPreinternedPlan.expressionIndexes);
                        }
                        addJson(`${prefix}/shape`, {rowCount: chunk.rowCount, contentRowStart: chunk.contentRowStart,
                            contentBytesLength: chunk.contentBytesLength, contentMetaByUniqueIndex: chunk.contentMetaByUniqueIndex,
                            useResolvedContentReferences: chunk.useResolvedContentReferences});
                        addJson(`${prefix}/dedupPlan`, chunk.contentDedupPlan);
                        addJson(`${prefix}/mediaRows`, chunk.mediaRows);
                        mediaRows += chunk.mediaRows.length;
                        const {contentMetaList, contentBytesBuffer, contentBytesBaseOffset} = chunk;
                        if (chunk.rowCount > 0 && (!contentMetaList || !contentBytesBuffer || typeof contentBytesBaseOffset !== 'number')) {
                            throw new Error('Missing complete content slab');
                        }
                        if (contentBytesBuffer) {
                            addView(`${prefix}/contentSlab`, contentBytesBuffer.subarray(contentBytesBaseOffset, contentBytesBaseOffset + chunk.contentBytesLength));
                        }
                        for (let rowIndex = 0; rowIndex < chunk.rowCount; ++rowIndex) {
                            const meta = (chunk.contentMetaByUniqueIndex ? chunk.contentUniqueIndexList[rowIndex] : rowIndex) * 4;
                            const offset = contentBytesBaseOffset + contentMetaList[meta];
                            addView(`${prefix}/rowContent/${rowIndex}`, contentBytesBuffer.subarray(offset, offset + contentMetaList[meta + 1]));
                        }
                    }, 2048, {...flags, preloadedSource: preloaded, singleChunk: true, emitTermByteLists: false,
                        computeContentHashes: true, emitContentSlab: true, emitTokenBinaryContent: true,
                        mediaHintFastScan: true, validateGlossaryTypes: true, prepareLookupIndexes: true});
                    activeFault = null;
                    const profile = parser.consumeLastTermBankWasmParseProfile();
                    const partDigests = [];
                    for (const {label, type, bytes} of parts) {
                        partDigests.push({label, type, byteLength: bytes.byteLength, sha256: await hash(bytes)});
                    }
                    results.push({name: item.name, ok: true, sourceSha256, spans, rows, indexBytes, mediaRows,
                        outputSha256: await hash(new TextEncoder().encode(JSON.stringify(partDigests))), partDigests, publishedChunks,
                        parserFallbacks: profile?.fusedParseFallbacks ?? 0, diagnostics: diagnostics()});
                } catch (error) {
                    results.push({name: item.name, ok: false, stage, error: {name: error.name, message: error.message},
                        publishedChunks, diagnostics: diagnostics()});
                } finally {
                    activeFault = null;
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

const report = {schemaVersion: 2,
    scope: 'Actual Chrome dedicated-worker parser transaction, native capability, high-ratio CRC admission, complete framed output parity, and injected failure validation. Instrumented and untimed; no import persistence, worker transport, memory, or performance qualification.',
    faultScope: 'Parser traps and allocation throws are injected only after source inflation. They test CRC failure precedence and cleanup, not an actual host out-of-memory condition.',
    browserLock: chromiumLock, browserLockSha256: sha(browserLockBytes),
    startedAt: new Date().toISOString(), node: process.version, sources: {}, cases: cases.map(({sources, ...item}) => ({...item,
        sources: sources.map(({bytes, ...metadata}) => ({...metadata, compressedSha256: sha(Uint8Array.from(bytes))}))})), nativeCases: nativeCases.map(({bytes, ...item}) => ({...item, sha256: sha(Uint8Array.from(bytes))})), observations: []};
for (const [arm, root] of Object.entries(roots)) {
    const files = ['ext/js/dictionary/term-bank-wasm-parser.js', 'ext/js/dictionary/term-bank-source-crc.js',
        'ext/js/dictionary/term-lookup-index-preparation.js', 'ext/js/dictionary/term-bank-experiments.js',
        'ext/lib/term-bank-parser.wasm', 'package-lock.json'];
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
        const resultOnly = ({diagnostics, ...result}) => result;
        assert.deepEqual(resultOnly(after), resultOnly(before), `Parser result differs: ${item.name}`);
        assert.equal(after.ok, !item.rejects, `Unexpected acceptance/rejection: ${item.name}`);
        if (item.rejects) { assert.equal(after.publishedChunks, 0, `Published invalid source: ${item.name}`); }
        const oldPath = before.diagnostics;
        const newPath = after.diagnostics;
        if (item.highRatio) {
            assert.equal(oldPath.wasmDeferredFlags[0], 1, `Baseline did not admit deferred CRC: ${item.name}`);
        }
        if (item.nativeError === true) {
            assert(newPath.nativeCalls > 0 && newPath.nativeCalls <= item.sources.length,
                `Malformed fixture did not exercise native validation: ${item.name}`);
            assert.equal(newPath.wasmCalls, oldPath.wasmCalls, `Fallback call count differs: ${item.name}`);
            assert.deepEqual(newPath.wasmDeferredFlags, oldPath.wasmDeferredFlags, `Deferred/immediate fallback order differs: ${item.name}`);
            assert.equal(newPath.verifierCalls, oldPath.verifierCalls, `Deferred fallback verifier differs: ${item.name}`);
            assert.equal(newPath.deferredCrc, oldPath.deferredCrc, `Fallback CRC transaction differs: ${item.name}`);
        }
        if (item.native === true) {
            assert.equal(oldPath.wasmCalls, 1, `Baseline did not use WASM: ${item.name}`);
            assert.equal(newPath.nativeCalls, item.sources.length, `Native fast path was not exercised: ${item.name}`);
            assert.equal(newPath.wasmCalls, 0, `Candidate fell back on a valid native case: ${item.name}`);
            assert.equal(newPath.verifierCalls, 0, `Native success invoked the deferred verifier: ${item.name}`);
            assert.equal(newPath.witnessCalls, 0, `Native success allocated a glossary CRC witness: ${item.name}`);
            assert.equal(newPath.deferredCrc, false, `Native success retained CRC signatures: ${item.name}`);
            assert.equal(newPath.crcStats, false, `Native success retained CRC scratch: ${item.name}`);
            if (item.highRatio) {
                assert.equal(oldPath.deferredCrc, true, `Baseline deferred source was lost: ${item.name}`);
                assert.equal(oldPath.verifierCalls, 1, `Baseline deferred source was not verified exactly once: ${item.name}`);
                assert.equal(oldPath.crcVerified, true, `Baseline did not finish its CRC transaction: ${item.name}`);
                if (item.fault !== 'allocation-throw') { assert(oldPath.witnessCalls > 0, `Baseline witness was absent: ${item.name}`); }
            }
        } else if (item.native === false) {
            assert.equal(newPath.nativeCalls, 0, `Protected fallback changed: ${item.name}`);
            assert.equal(newPath.wasmCalls, oldPath.wasmCalls, `Expected existing WASM route: ${item.name}`);
            assert.deepEqual(newPath.wasmDeferredFlags, oldPath.wasmDeferredFlags, `Protected CRC route changed: ${item.name}`);
            assert.equal(newPath.verifierCalls, oldPath.verifierCalls, `Protected verifier changed: ${item.name}`);
        }
        if (item.unsupportedDecoder) {
            assert.equal(newPath.nativeCalls, 1, 'Unsupported decoder did not fail its capability probe');
            assert.deepEqual(newPath.wasmDeferredFlags, oldPath.wasmDeferredFlags, 'Unsupported decoder changed deferred fallback');
            assert.equal(newPath.verifierCalls, oldPath.verifierCalls, 'Unsupported decoder skipped deferred CRC');
        }
        if (item.requireBaselineReuse) {
            assert(oldPath.crcReusedBytes > 0, 'Positive control did not reuse a baseline glossary CRC');
            assert.equal(oldPath.crcScannedBytes + oldPath.crcReusedBytes,
                item.sources.reduce((sum, entry) => sum + entry.uncompressedSize, 0));
        }
        if (item.requireParserFallback) { assert(after.parserFallbacks > 0, 'Escaped-key case missed the parser fallback'); }
        if (item.fault) {
            assert.equal(oldPath.faultCalls, 1, `Baseline missed fault injection: ${item.name}`);
            assert.equal(newPath.faultCalls, 1, `Candidate missed fault injection: ${item.name}`);
            if (!item.errorControl) {
                assert.deepEqual(after.error, item.fault === 'parse-trap' ?
                    {name: 'RuntimeError', message: 'Canary injected parse trap'} :
                    {name: 'RangeError', message: 'Canary injected allocation failure'}, `Injected failure changed: ${item.name}`);
            }
        }
        if (item.requireMediaRows) { assert(after.mediaRows > 0, 'Media fixture did not emit media rows'); }
        if (item.sameCanonicalContent) {
            const contents = after.partDigests.filter((part) => part.label.includes('/rowContent/'));
            assert(contents.length >= 2, 'Canonical-equality case emitted too few rows');
            assert(contents.every((part) => part.sha256 === contents[0].sha256), 'Expected canonical content equality');
        }
        if (item.errorControl) {
            const control = a.results.find((result) => result.name === item.errorControl);
            assert(control && !control.ok, `Missing first-error control: ${item.errorControl}`);
            assert.deepEqual(after.error, control.error, `First source failure precedence changed: ${item.name}`);
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
    report.highRatioNativePathExercised = true;
    for (const [arm, root] of Object.entries(roots)) {
        for (const [file, expectedHash] of Object.entries(report.sources[arm].sourceHashes)) {
            assert.equal(sha(await readFile(path.join(root, file))), expectedHash, `Source changed during canary: ${arm}/${file}`);
        }
    }
    assert.equal(sha(await readFile(fileURLToPath(import.meta.url))), report.runnerSha256, 'Canary changed during execution');
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
        nativeFastPathExercised: report.nativeFastPathExercised, highRatioNativePathExercised: report.highRatioNativePathExercised,
        failure: report.failure}));
}
