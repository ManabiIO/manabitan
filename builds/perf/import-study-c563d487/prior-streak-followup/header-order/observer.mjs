#!/usr/bin/env node
/* Untimed default-path shadow only. It neither changes nor builds product code. */
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {openAsBlob, createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {crc32, inflateRawSync} from 'node:zlib';
import path from 'node:path';

const root = '/workspace/scratch/c563d487c718/manabitan';
const baselineHead = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2';
const baselineC = '5a8257cb77d061694b6b2d247057aebb53ea2f49521d8d9893b3af175f145d8a';
const baselineWasm = '8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee';
const previousPath = '/workspace/scratch/c563d487c718/experiments/sequence-probe-opportunity/run-4-prior-streak/result.json';
const previousSha = 'c70338754be1040215faf478bbcd179bd9af7ca3b5ff51de4f6c60586e6d1b31';
const sha = (value) => createHash('sha256').update(value).digest('hex');
const fields = ['glossary', 'rules', 'definitionTags', 'termTags'];
const headers = fields.slice(1);
const workNames = ['lengthChecks', 'lengthRejects', 'equalityCalls', 'equalCalls', 'unequalCalls', 'zeroLengthCalls',
    'bytesOffered', 'logicalBytesCompared', 'sourceSimdBytesPerOperand', 'sourceScalarBytesPerOperand', 'witnessBypasses'];
const baselineNames = ['rows', 'firstRows', 'priorStreakRows', 'existingLookbackZero', 'existingLookbackPositive',
    'existingGlossaryReuses', 'recentRawContentHits', 'groupEndingRawHits'];
const emptyWork = () => Object.fromEntries(workNames.map((key) => [key, 0]));
const emptyVariant = () => ({calls: 0, matches: 0, misses: 0, knownGlossaryCalls: 0, fields: Object.fromEntries(fields.map((key) => [key, emptyWork()]))});
const emptyStats = () => ({...Object.fromEntries(baselineNames.map((key) => [key, 0])), signatureComputations: 0,
    witnessSignatureCopies: 0, signatureComparisons: 0, signatureRejects: 0, signaturePasses: 0,
    routes: {witnessShortcut: {calls: 0, matches: 0, misses: 0}, signatureMatch: {calls: 0, matches: 0, misses: 0}},
    original: emptyVariant(), headersFirst: emptyVariant(),
    savedGlossary: {calls: 0, wouldMatch: 0, wouldDiffer: 0, bytesOffered: 0, logicalBytesCompared: 0,
        sourceSimdBytesPerOperand: 0, sourceScalarBytesPerOperand: 0, headerRejections: {}},
    extraHeadersAfterGlossaryReject: {calls: 0, equalityCalls: 0, bytesOffered: 0, logicalBytesCompared: 0,
        sourceSimdBytesPerOperand: 0, sourceScalarBytesPerOperand: 0}});

function readSignature(bytes, offset) {
    if (offset >= bytes.length) { return 0; }
    if (bytes.length - offset >= 4) { return bytes.readUInt32LE(offset); }
    let value = 0;
    for (let i = 0; i < bytes.length - offset; ++i) { value |= bytes[offset + i] << (i * 8); }
    return value >>> 0;
}

function quickSignature(row) {
    const length = row.glossary.length;
    const lastOffset = length > 4 ? length - 4 : 0;
    const first = readSignature(row.glossary, 0);
    const middle = lastOffset === 0 ? first : readSignature(row.glossary, Math.floor(lastOffset / 2));
    const last = lastOffset === 0 ? first : readSignature(row.glossary, lastOffset);
    let value = Math.imul(length, 0x9e3779b1);
    value ^= Math.imul(row.rules.length, 0x85ebca6b);
    value ^= Math.imul(row.definitionTags.length, 0xc2b2ae35);
    value ^= Math.imul(row.termTags.length, 0x27d4eb2f);
    value ^= first;
    value = (value << 13) | (value >>> 19);
    value ^= Math.imul(middle, 0x165667b1);
    value = (value << 11) | (value >>> 21);
    return (value ^ last) >>> 0;
}

// A logical prefix ends at its first unequal byte. The two source models count
// bytes in complete 32/8-byte blocks and the byte tail, per operand. They are
// not runtime measurements, cache traffic, or guarantees about generated code.
function comparison(first, second) {
    assert.equal(first.length, second.length);
    const length = first.length;
    const equal = first.equals(second);
    let logical = length;
    if (!equal) {
        logical = 0;
        while (logical < length && first[logical] === second[logical]) { ++logical; }
        assert(logical < length);
        ++logical;
    }
    const blockRange = (simd) => {
        if (equal) { return length; }
        const mismatch = logical - 1;
        const wide = simd ? Math.floor(length / 32) * 32 : 0;
        if (mismatch < wide) { return (Math.floor(mismatch / 32) + 1) * 32; }
        const narrow = Math.floor((length - wide) / 8) * 8;
        if (mismatch < wide + narrow) { return wide + (Math.floor((mismatch - wide) / 8) + 1) * 8; }
        return logical;
    };
    return {equal, bytesOffered: length, logicalBytesCompared: logical,
        sourceSimdBytesPerOperand: blockRange(true), sourceScalarBytesPerOperand: blockRange(false)};
}

function predicate(first, second, glossaryKnown, headerFirst) {
    const work = emptyVariant();
    work.calls = 1;
    work.knownGlossaryCalls = glossaryKnown ? 1 : 0;
    let rejection = null;
    const lengthCheck = (field) => {
        ++work.fields[field].lengthChecks;
        if (first[field].length !== second[field].length) {
            ++work.fields[field].lengthRejects;
            rejection = `${field}.length`;
            return false;
        }
        return true;
    };
    const equalBytes = (field) => {
        const cell = work.fields[field];
        ++cell.equalityCalls;
        if (first[field].length === 0) { ++cell.zeroLengthCalls; }
        const result = comparison(first[field], second[field]);
        for (const name of ['bytesOffered', 'logicalBytesCompared', 'sourceSimdBytesPerOperand', 'sourceScalarBytesPerOperand']) { cell[name] += result[name]; }
        ++cell[result.equal ? 'equalCalls' : 'unequalCalls'];
        if (!result.equal) { rejection = `${field}.bytes`; }
        return result.equal;
    };
    const glossary = () => {
        if (glossaryKnown) { ++work.fields.glossary.witnessBypasses; return true; }
        return equalBytes('glossary');
    };
    const headerFields = () => {
        for (const field of headers) { if (!lengthCheck(field) || !equalBytes(field)) { return false; } }
        return true;
    };
    const equal = lengthCheck('glossary') && (headerFirst ? (headerFields() && glossary()) : (glossary() && headerFields()));
    ++work[equal ? 'matches' : 'misses'];
    return {equal, work, rejection};
}

function addVariant(target, source) {
    for (const name of ['calls', 'matches', 'misses', 'knownGlossaryCalls']) { target[name] += source[name]; }
    for (const field of fields) { for (const name of workNames) { target.fields[field][name] += source.fields[field][name]; } }
}

function sameContent(first, second) {
    return first.glossary.equals(second.glossary) && first.rules.equals(second.rules) &&
        first.definitionTags.equals(second.definitionTags) && first.termTags.equals(second.termTags);
}

function copyTuple(row) {
    return {bank: row.bank, groupRow: row.groupRow, signature: row.signature,
        ...Object.fromEntries(fields.map((field) => [field, Buffer.from(row[field])]))};
}

function scalarBeforeComma(bytes, start, nextFieldStart) {
    const space = (byte) => byte === 32 || byte === 9 || byte === 10 || byte === 13;
    let end = nextFieldStart;
    while (end > start && space(bytes[end - 1])) { --end; }
    assert.equal(bytes[--end], 44);
    while (end > start && space(bytes[end - 1])) { --end; }
    return bytes.toString('ascii', start, end);
}

function runSelfTests() {
    let comparisons = 0;
    let signatures = 0;
    // Independently advance the actual source block widths until a differing
    // block, rather than using the arithmetic closed form under review.
    const sourceLoop = (a, b, simd) => {
        let i = 0;
        for (const width of simd ? [32, 8, 1] : [8, 1]) {
            while (a.length - i >= width) {
                const equal = a.subarray(i, i + width).equals(b.subarray(i, i + width));
                i += width;
                if (!equal) { return i; }
            }
        }
        return i;
    };
    const bigSignature = (row) => {
        const u32 = (value) => BigInt.asUintN(32, value);
        const read = (offset) => {
            let value = 0n;
            for (let i = 0; i < 4 && offset + i < row.glossary.length; ++i) { value |= BigInt(row.glossary[offset + i]) << BigInt(8 * i); }
            return value;
        };
        const last = Math.max(0, row.glossary.length - 4);
        let value = u32(BigInt(row.glossary.length) * 0x9e3779b1n) ^ u32(BigInt(row.rules.length) * 0x85ebca6bn) ^
            u32(BigInt(row.definitionTags.length) * 0xc2b2ae35n) ^ u32(BigInt(row.termTags.length) * 0x27d4eb2fn) ^ read(0);
        value = u32((value << 13n) | (value >> 19n));
        value ^= u32(read(Math.floor(last / 2)) * 0x165667b1n);
        value = u32((value << 11n) | (value >> 21n));
        return Number(u32(value ^ read(last)));
    };
    for (const length of [0, 1, 3, 4, 7, 8, 9, 15, 16, 31, 32, 33, 39, 40, 63, 64, 65, 240, 511, 512, 4096]) {
        const a = Buffer.from(Array.from({length}, (_, i) => (i * 47 + 13) & 255));
        for (const mismatch of [-1, 0, 7, 8, 15, 16, 31, 32, 63, length - 1]) {
            if (mismatch >= length || mismatch < -1) { continue; }
            const b = Buffer.from(a);
            if (mismatch >= 0) { b[mismatch] ^= 1; }
            const result = comparison(a, b);
            assert.equal(result.equal, mismatch === -1);
            assert.equal(result.logicalBytesCompared, mismatch === -1 ? length : mismatch + 1);
            assert.equal(result.sourceSimdBytesPerOperand, sourceLoop(a, b, true));
            assert.equal(result.sourceScalarBytesPerOperand, sourceLoop(a, b, false));
            ++comparisons;
        }
        for (const headerLength of [0, 1, 4, 17, 257]) {
            const row = {glossary: a, rules: Buffer.alloc(headerLength), definitionTags: Buffer.alloc(headerLength + 3), termTags: Buffer.alloc(headerLength + 7)};
            assert.equal(quickSignature(row), bigSignature(row));
            ++signatures;
        }
    }
    let predicates = 0;
    const base = {glossary: Buffer.from('["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]'), rules: Buffer.from('"v1"'), definitionTags: Buffer.from('"n"'), termTags: Buffer.from('"uk"')};
    for (const changed of [null, ...fields]) {
        for (const mode of ['equalLengthDifference', 'differentLength']) {
            const second = Object.fromEntries(fields.map((field) => [field, Buffer.from(base[field])]));
            if (changed) {
                if (mode === 'differentLength') { second[changed] = Buffer.concat([second[changed], Buffer.from('x')]); }
                else { second[changed][1] ^= 1; }
            }
            for (const known of [false, true]) {
                if (known && changed === 'glossary') { continue; }
                const first = predicate(base, second, known, false);
                const reordered = predicate(base, second, known, true);
                assert.equal(first.equal, sameContent(base, second));
                assert.equal(reordered.equal, first.equal);
                if (known) { assert.equal(first.work.fields.glossary.equalityCalls + reordered.work.fields.glossary.equalityCalls, 0); }
                ++predicates;
            }
        }
    }
    return {passed: true, sourceRangeCases: comparisons, independentBigIntSignatureCases: signatures, predicateSemanticCases: predicates};
}

async function main(archivePath, outputPath) {
    assert(archivePath && outputPath, 'Expected locked JMdict archive and a fresh output directory');
    const output = path.resolve(outputPath);
    await mkdir(output, {recursive: false});
    const scriptBytes = await readFile(fileURLToPath(import.meta.url));
    await writeFile(path.join(output, 'observer-source.mjs'), scriptBytes);
    const report = {schema: 1, complete: false, scope: 'Untimed original-default-path shadow of exact comparison ordering; no selector calls, source mutation, timings, warmups or benchmark observations',
        methodology: 'Keep the first glossary-length guard, then compare exact rules/definitionTags/termTags before glossary equality. Native validated witnesses bypass glossary bytes in both orders. Match indexes, original four-row budget/streak and exact quick-signature filtering must agree on every row. Logical and source 32/8/byte comparison ranges are model outputs, not elapsed savings or actual hardware traffic.',
        baselineHead, observerSha256: sha(scriptBytes), previousResultSha256: previousSha, node: process.version,
        invocation: {executable: process.execPath, execArgv: process.execArgv, argv: process.argv.slice(1)},
        constants: {banksPerGroup: 7, recentWindow: 4, probeBudget: 4, admissionMatches: 4, longGlossaryBytes: 512},
        limits: {nodeHeapMiB: 256, decodedBanksRetained: 1, priorTuplesRetained: 4},
        totals: emptyStats(), banks: [], groups: [], failures: [], savedGlossaryLengthHistogram: {},
        maxima: {decodedBankBytes: 0, retainedTupleBytes: 0, wasmHeapBytes: 0}, selfTests: runSelfTests()};
    const save = async () => writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
    let location = {};
    let bankStats;
    let groupStats;
    const contexts = () => [report.totals, bankStats, groupStats];
    const update = (key, amount = 1) => { for (const stats of contexts()) { stats[key] += amount; } };
    const callPredicate = (current, candidate, known, route) => {
        if (known) { assert(current.glossary.equals(candidate.glossary), 'Invalid baseline witness'); }
        const original = predicate(current, candidate, known, false);
        const changed = predicate(current, candidate, known, true);
        assert.equal(changed.equal, original.equal, 'Reordering changed a predicate result');
        assert.equal(original.equal, sameContent(current, candidate), 'Original predicate disagrees with raw-byte oracle');
        for (const stats of contexts()) {
            ++stats.routes[route].calls;
            ++stats.routes[route][original.equal ? 'matches' : 'misses'];
            addVariant(stats.original, original.work);
            addVariant(stats.headersFirst, changed.work);
            if (original.work.fields.glossary.equalityCalls > changed.work.fields.glossary.equalityCalls) {
                assert(!known && changed.rejection && !changed.rejection.startsWith('glossary'));
                const cell = stats.savedGlossary;
                ++cell.calls;
                ++cell[original.work.fields.glossary.equalCalls ? 'wouldMatch' : 'wouldDiffer'];
                for (const key of ['bytesOffered', 'logicalBytesCompared', 'sourceSimdBytesPerOperand', 'sourceScalarBytesPerOperand']) { cell[key] += original.work.fields.glossary[key]; }
                cell.headerRejections[changed.rejection] = (cell.headerRejections[changed.rejection] ?? 0) + 1;
            }
            if (original.rejection === 'glossary.bytes') {
                const cell = stats.extraHeadersAfterGlossaryReject;
                ++cell.calls;
                for (const field of headers) {
                    for (const key of ['equalityCalls', 'bytesOffered', 'logicalBytesCompared', 'sourceSimdBytesPerOperand', 'sourceScalarBytesPerOperand']) {
                        cell[key] += changed.work.fields[field][key] - original.work.fields[field][key];
                    }
                }
            }
        }
        if (original.work.fields.glossary.equalityCalls > changed.work.fields.glossary.equalityCalls) {
            const length = current.glossary.length;
            const cell = report.savedGlossaryLengthHistogram[length] ??= {calls: 0, wouldMatch: 0, wouldDiffer: 0};
            ++cell.calls;
            ++cell[original.work.fields.glossary.equalCalls ? 'wouldMatch' : 'wouldDiffer'];
        }
        return original.equal;
    };
    try {
        assert.equal(process.version, 'v22.22.0');
        assert(process.execArgv.includes('--max-old-space-size=256'), 'Expected the bounded 256 MiB JavaScript heap');
        assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(), baselineHead);
        const sourceBytes = await readFile(path.join(root, 'ext/js/dictionary/wasm/term-bank-parser.c'));
        assert.equal(sha(sourceBytes), baselineC);
        report.baselineCSourceSha256 = sha(sourceBytes);
        const wasmBytes = await readFile(path.join(root, 'ext/lib/term-bank-parser.wasm'));
        assert.equal(sha(wasmBytes), baselineWasm);
        report.wasmSha256 = sha(wasmBytes);
        const native = (await WebAssembly.instantiate(wasmBytes, {})).instance.exports;
        const lockBytes = await readFile(path.join(root, 'test/perf/dictionaries.lock.json'));
        report.fixtureLockSha256 = sha(lockBytes);
        const fixture = JSON.parse(lockBytes).dictionaries.jmdict;
        const previousBytes = await readFile(previousPath);
        assert.equal(sha(previousBytes), previousSha);
        const previousFull = JSON.parse(previousBytes);
        assert(previousFull.complete && previousFull.failures.length === 0);
        const legacy = (value) => Object.fromEntries(baselineNames.map((key) => [key, value[key]]));
        const previous = {totals: legacy(previousFull.totals), metadataDigest: previousFull.metadataDigest,
            banks: previousFull.banks.map((value) => ({name: value.name, group: value.group, sourceSha256: value.sourceSha256,
                metadataSha256: value.metadataSha256, nativeResult: value.nativeResult, nativeCapacity: value.nativeCapacity, ...legacy(value)})),
            groups: previousFull.groups.map((value) => ({group: value.group, finalBudget: value.finalBudget, finalStreak: value.finalStreak, ...legacy(value)}))};
        for (const key of ['node', 'wasmSha256', 'fixtureLockSha256', 'baselineCSourceSha256']) { assert.equal(report[key], previousFull[key]); }
        const archiveHash = createHash('sha256');
        for await (const bytes of createReadStream(archivePath)) { archiveHash.update(bytes); }
        report.archiveSha256 = archiveHash.digest('hex');
        assert.equal(report.archiveSha256, fixture.sha256);
        assert.equal(report.archiveSha256, previousFull.archiveSha256);
        const require = createRequire(path.join(root, 'package.json'));
        const {ZipReader, BlobReader} = require('@zip.js/zip.js');
        const {RawZipPayloadReader} = await import(pathToFileURL(path.join(root, 'ext/js/dictionary/term-bank-source-pipeline.js')));
        const archive = await openAsBlob(archivePath);
        const reader = new ZipReader(new BlobReader(archive));
        let entries;
        try { entries = await reader.getEntries(); } finally { await reader.close(); }
        const banks = entries.filter((entry) => /^term_bank_\d+\.json$/.test(entry.filename))
            .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)));
        entries = null;
        const payloads = new RawZipPayloadReader(archive);
        const metadataHash = createHash('sha256');
        const matchedIndexesHash = createHash('sha256');
        const oracleIndexesHash = createHash('sha256');
        const stateHash = createHash('sha256');
        const signatureHash = createHash('sha256');
        let state;
        for (let bankIndex = 0; bankIndex < banks.length; ++bankIndex) {
            const entry = banks[bankIndex];
            if (bankIndex % 7 === 0) {
                groupStats = {group: Math.floor(bankIndex / 7), ...emptyStats()};
                report.groups.push(groupStats);
                state = {budget: 0, streak: 0, cache: [], rows: 0, lastRawHit: false};
            }
            bankStats = {name: entry.filename, group: groupStats.group, ...emptyStats()};
            report.banks.push(bankStats);
            location = {bank: entry.filename};
            const compressed = await payloads.read(entry, new AbortController().signal, true);
            assert.equal(entry.compressionMethod, 8);
            const bytes = inflateRawSync(compressed);
            assert.equal(bytes.length, entry.uncompressedSize);
            assert.equal(crc32(bytes), entry.signature >>> 0);
            bankStats.sourceSha256 = sha(bytes);
            report.maxima.decodedBankBytes = Math.max(report.maxima.decodedBankBytes, bytes.length);
            native.wasm_reset_heap();
            const sourcePointer = native.wasm_alloc(bytes.length) >>> 0;
            const metadataPointer = native.wasm_alloc(1024 * 17 * 4) >>> 0;
            assert(sourcePointer && metadataPointer);
            new Uint8Array(native.memory.buffer, sourcePointer, bytes.length).set(bytes);
            const rows = native.parse_term_bank_with_media_hints(sourcePointer, bytes.length, metadataPointer, 1024, 0, 0, 1);
            bankStats.nativeResult = rows;
            bankStats.nativeCapacity = native.wasm_get_last_parse_capacity();
            assert(rows >= 0, 'Unchanged native strict parser rejected locked bank');
            const metas = new Uint32Array(native.memory.buffer, metadataPointer, rows * 17);
            const metadataBytes = Buffer.from(metas.buffer, metas.byteOffset, metas.byteLength);
            bankStats.metadataSha256 = sha(metadataBytes);
            metadataHash.update(entry.filename);
            metadataHash.update(metadataBytes);
            report.maxima.wasmHeapBytes = Math.max(report.maxima.wasmHeapBytes, native.memory.buffer.byteLength);
            for (let row = 0; row < rows; ++row) {
                location = {bank: entry.filename, row, groupRow: state.rows};
                const offset = row * 17;
                const field = (index) => bytes.subarray(metas[offset + index], metas[offset + index] + metas[offset + index + 1]);
                const glossaryStart = metas[offset + 9];
                const termTagsStart = metas[offset + 12];
                const sequenceNull = metas[offset + 11] === 0xffffffff;
                const sequenceToken = sequenceNull ? 'null' : scalarBeforeComma(bytes, metas[offset + 11], termTagsStart);
                const sequence = JSON.parse(sequenceToken);
                const scoreToken = scalarBeforeComma(bytes, metas[offset + 8], glossaryStart);
                const score = JSON.parse(scoreToken);
                assert(/^-?(0|[1-9]\d*)$/.test(scoreToken) && Number.isSafeInteger(score) && score >= -2147483648 && score <= 2147483647 && !Object.is(score, -0));
                assert(sequenceNull || (/^-?(0|[1-9]\d*)$/.test(sequenceToken) && Number.isSafeInteger(sequence) && sequence >= -2147483648 && sequence <= 2147483647));
                const current = {bank: entry.filename, groupRow: state.rows, glossary: field(9), definitionTags: field(4), rules: field(6), termTags: field(12)};
                update('rows');
                if (state.streak > 0) { update('priorStreakRows'); }
                const prior = state.cache.at(-1);
                const lookback = prior ? (state.budget > 0 ? 4 : prior.glossary.length >= 512 ? 1 : 0) : 0;
                if (prior) { update(lookback === 0 ? 'existingLookbackZero' : 'existingLookbackPositive'); }
                else { update('firstRows'); }
                let witness = null;
                for (let i = state.cache.length - 1; i >= Math.max(0, state.cache.length - lookback); --i) {
                    if (current.glossary.equals(state.cache[i].glossary)) { witness = state.cache[i]; break; }
                }
                if (witness) { update('existingGlossaryReuses'); state.budget = 4; }
                else if (state.budget > 0) { --state.budget; }
                let match = null;
                if (witness && callPredicate(current, witness, true, 'witnessShortcut')) {
                    match = witness;
                    current.signature = witness.signature;
                    update('witnessSignatureCopies');
                } else {
                    current.signature = quickSignature(current);
                    update('signatureComputations');
                    for (let i = state.cache.length - 1; i >= 0; --i) {
                        const candidate = state.cache[i];
                        update('signatureComparisons');
                        if (candidate.signature !== current.signature) { update('signatureRejects'); continue; }
                        update('signaturePasses');
                        if (callPredicate(current, candidate, candidate === witness, 'signatureMatch')) { match = candidate; break; }
                    }
                }
                // Independent unfiltered semantic oracle: a signature must not
                // suppress an exact recent match, and ordering cannot choose a
                // different row. This adds no calls to either measured model.
                let oracleMatch = null;
                for (let i = state.cache.length - 1; i >= 0; --i) {
                    if (sameContent(current, state.cache[i])) { oracleMatch = state.cache[i]; break; }
                }
                assert.equal(match?.groupRow ?? -1, oracleMatch?.groupRow ?? -1);
                const indexRecord = Buffer.allocUnsafe(12);
                indexRecord.writeUInt32LE(groupStats.group, 0);
                indexRecord.writeUInt32LE(state.rows, 4);
                indexRecord.writeUInt32LE(match?.groupRow ?? 0xffffffff, 8);
                matchedIndexesHash.update(indexRecord);
                indexRecord.writeUInt32LE(oracleMatch?.groupRow ?? 0xffffffff, 8);
                oracleIndexesHash.update(indexRecord);
                const signatureRecord = Buffer.allocUnsafe(4);
                signatureRecord.writeUInt32LE(current.signature);
                signatureHash.update(signatureRecord);
                state.lastRawHit = match !== null;
                if (match) {
                    update('recentRawContentHits');
                    if (state.streak >= 4 || ++state.streak >= 4) { state.budget = 4; }
                } else { state.streak = 0; }
                const stateRecord = Buffer.allocUnsafe(8);
                stateRecord.writeUInt32LE(state.budget, 0);
                stateRecord.writeUInt32LE(state.streak, 4);
                stateHash.update(stateRecord);
                state.cache.push(copyTuple(current));
                if (state.cache.length > 4) { state.cache.shift(); }
                report.maxima.retainedTupleBytes = Math.max(report.maxima.retainedTupleBytes,
                    state.cache.reduce((sum, item) => sum + fields.reduce((n, key) => n + item[key].length, 0), 0));
                ++state.rows;
            }
            if ((bankIndex + 1) % 7 === 0 || bankIndex + 1 === banks.length) {
                if (state.lastRawHit) { update('groupEndingRawHits'); }
                groupStats.finalBudget = state.budget;
                groupStats.finalStreak = state.streak;
            }
            const old = previous.banks[bankIndex];
            for (const [key, value] of Object.entries(old)) { assert.deepEqual(bankStats[key], value, `Baseline bank mismatch: ${entry.filename}/${key}`); }
            await save();
        }
        report.metadataDigest = metadataHash.digest('hex');
        report.matchIndexesDigest = matchedIndexesHash.digest('hex');
        report.unfilteredOracleMatchIndexesDigest = oracleIndexesHash.digest('hex');
        report.postRowBudgetAndStreakDigest = stateHash.digest('hex');
        report.quickSignaturesDigest = signatureHash.digest('hex');
        assert.equal(report.matchIndexesDigest, report.unfilteredOracleMatchIndexesDigest);
        assert.equal(report.metadataDigest, previous.metadataDigest);
        assert.equal(report.metadataDigest, 'd6965c13c73fbe3312802d1e4800b0acd8942f317b3ed065d7c8edd25c1c0809');
        assert.equal(report.totals.rows, fixture.termRows);
        assert.deepEqual(legacy(report.totals), previous.totals);
        assert.equal(report.groups.length, previous.groups.length);
        assert.equal(report.banks.length, previous.banks.length);
        for (let i = 0; i < report.groups.length; ++i) {
            for (const [key, value] of Object.entries(previous.groups[i])) { assert.deepEqual(report.groups[i][key], value, `Baseline group mismatch: ${i}/${key}`); }
        }
        for (const stats of [report.totals, ...report.banks, ...report.groups]) {
            assert.equal(stats.signatureComputations + stats.witnessSignatureCopies, stats.rows);
            assert.equal(stats.signaturePasses + stats.signatureRejects, stats.signatureComparisons);
            assert.equal(stats.original.calls, stats.routes.witnessShortcut.calls + stats.routes.signatureMatch.calls);
            assert.equal(stats.original.matches, stats.recentRawContentHits);
            assert.equal(stats.original.matches, stats.headersFirst.matches);
            assert.equal(stats.original.misses, stats.headersFirst.misses);
            stats.netComparisonRangesSaved = Object.fromEntries(['bytesOffered', 'logicalBytesCompared', 'sourceSimdBytesPerOperand', 'sourceScalarBytesPerOperand']
                .map((name) => [name, fields.reduce((sum, field) => sum + stats.original.fields[field][name] - stats.headersFirst.fields[field][name], 0)]));
        }
        report.baselineReplayReconciled = true;
        report.everyPredicateAndRecentMatchIndexEquivalent = true;
        report.complete = true;
        await save();
        console.log(JSON.stringify({complete: true, rows: report.totals.rows, witnesses: report.totals.existingGlossaryReuses,
            recentRawHits: report.totals.recentRawContentHits, metadataDigest: report.metadataDigest,
            rawPredicateCalls: report.totals.original.calls, savedGlossary: report.totals.savedGlossary,
            extraHeadersAfterGlossaryReject: report.totals.extraHeadersAfterGlossaryReject,
            netComparisonRangesSaved: report.totals.netComparisonRangesSaved, timingsCollected: false}));
    } catch (error) {
        report.failures.push({location, message: error.message, stack: error.stack});
        await save();
        throw error;
    }
}

if (process.argv[2] === '--self-test') { console.log(JSON.stringify(runSelfTests())); }
else { await main(...process.argv.slice(2)); }
