/* Copyright (C) 2026 Manabitan authors; SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {crc32, deflateRawSync} from 'node:zlib';
import {parseArgs} from 'node:util';
import path from 'node:path';
import {active, bank, fallbackCases, malformedCases, rawRow, row, selectorDiagnostics, validCases} from '../qualification/term-bank-prior-streak-selector-fixtures.js';

const {values, positionals} = parseArgs({allowPositionals: true, options: {baseline: {type: 'boolean'}, 'disabled-reuse': {type: 'boolean'}}});
const [sourceRoot, diagnosticWasm] = positionals;
assert(sourceRoot && positionals.length <= 2, 'Usage: smoke.mjs <sourceRoot> [diagnosticWasm] [--baseline] [--disabled-reuse]');
const baseline = values.baseline === true;
const disabledReuse = values['disabled-reuse'] === true;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourcePath = path.join(sourceRoot, 'ext/js/dictionary/wasm/term-bank-parser.c');
const sourceHash = sha256(await readFile(sourcePath));
assert.equal(sourceHash, baseline ?
    '5a8257cb77d061694b6b2d247057aebb53ea2f49521d8d9893b3af175f145d8a' :
    'f622f057b7de9db9082d79c6d67eb7d93b86d74cb5ec9b1674d8e9a67f6456fb', 'Unexpected native source identity');
const wasmPath = diagnosticWasm ?? path.join(sourceRoot, 'ext/lib/term-bank-parser.wasm');
const wasmBytes = await readFile(wasmPath);
const wasmHash = sha256(wasmBytes);
const fixturePath = fileURLToPath(new URL('../qualification/term-bank-prior-streak-selector-fixtures.js', import.meta.url));
const fixtureHash = sha256(await readFile(fixturePath));
const harnessHash = sha256(await readFile(fileURLToPath(import.meta.url)));

// A diagnostic build is optional. Unrelated WebAssembly instances, including
// the runtime's injected HTTP parser, must never replace these exports.
let diagnosticExports;
const nativeInstantiate = WebAssembly.instantiate.bind(WebAssembly);
if (diagnosticWasm) {
    WebAssembly.instantiate = async (...args) => {
        const result = await nativeInstantiate(...args);
        const exports = result instanceof WebAssembly.Instance ? result.exports : result.instance.exports;
        if (typeof exports.prior_streak_selector_diag_get === 'function') { diagnosticExports = exports; }
        return result;
    };
}
// This schema is shared with the separate source-bound diagnostic build.
// Public counters below remain mandatory even without that build.
const diagnosticFields = JSON.parse(await readFile(new URL('./diagnostic-fields.json', import.meta.url), 'utf8'));
assert(Array.isArray(diagnosticFields) && diagnosticFields.length === 48);
const maximumFields = new Set(['maxSelectedBytes', 'maxFailedFullBytes', 'maxKeyComparisonBytes']);
const disabledZeroFields = diagnosticFields.filter((key) => !['recentContentHits', 'rows'].includes(key));
const counters = () => Object.fromEntries(diagnosticFields.map((key, index) => [key,
    diagnosticExports ? Number(diagnosticExports.prior_streak_selector_diag_get(index)) : 0]));
const delta = (before, after) => ({...Object.fromEntries(diagnosticFields.filter((key) => !maximumFields.has(key))
    .map((key) => [key, after[key] - before[key]])),
    cumulativeMaxima: Object.fromEntries([...maximumFields].map((key) => [key, after[key]]))});
const importSource = (file) => import(pathToFileURL(path.join(sourceRoot, file)));
const parser = await importSource('ext/js/dictionary/term-bank-wasm-parser.js');
const {decodeRawTermContentTokenBinary} = await importSource('ext/js/dictionary/raw-term-content.js');
const {hashTermEntryContentBytesPair} = await importSource('ext/js/dictionary/term-entry-content-hash.js');
parser.setTermBankWasmModule(await WebAssembly.compile(wasmBytes));
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {ignoreBOM: true});

function expectedRows(banks, equals = []) {
    return banks.flatMap((text) => JSON.parse(text)).map(([expression, reading, definitionTags, rules, score, glossary, sequence, termTags], index) => ({
        expression: decoder.decode(encoder.encode(expression)), reading: decoder.decode(encoder.encode(reading || expression)),
        equal: equals[index] ?? (reading === '' || reading === expression ? 1 : 0),
        score, negativeZero: Object.is(score, -0), sequence: sequence ?? -1,
        content: {rules, definitionTags: definitionTags ?? '', termTags,
            glossary: glossary.map((value) => typeof value === 'object' && value.type === 'text' ? value.text : value)},
    }));
}

function snapshot(chunks) {
    const rows = [];
    const contentBytes = [];
    const indexes = [];
    const uniqueIndexes = [];
    const uniqueRows = [];
    const uniqueSignatures = [];
    const uniqueCounts = [];
    const media = [];
    for (const chunk of chunks) {
        const meta = chunk.contentMetaList;
        const source = chunk.contentBytesBuffer;
        const ids = chunk.contentUniqueIndexList;
        assert(meta instanceof Uint32Array && source instanceof Uint8Array && ids !== null && chunk.contentDedupPlan !== null,
            'Missing production content metadata');
        for (let i = 0; i < chunk.rowCount; ++i) {
            const m = (chunk.contentMetaByUniqueIndex ? ids[i] : i) * 4;
            const start = (chunk.contentBytesBaseOffset ?? 0) + meta[m];
            assert(start >= 0 && start <= source.length && meta[m + 1] <= source.length - start, 'Content extent exceeds owned source');
            const bytes = source.subarray(start, start + meta[m + 1]);
            assert.deepEqual(hashTermEntryContentBytesPair(bytes), [meta[m + 2], meta[m + 3]], 'Native content hashes disagree with output bytes');
            const content = decodeRawTermContentTokenBinary(bytes, decoder);
            assert(content, 'Malformed canonical term content');
            const expression = decoder.decode(chunk.expressionBytesList[i]);
            rows.push({expression, reading: chunk.readingEqualsExpressionList[i] === 1 ? expression : decoder.decode(chunk.readingBytesList[i]),
                equal: chunk.readingEqualsExpressionList[i], score: chunk.scoreList[i], negativeZero: Object.is(chunk.scoreList[i], -0),
                sequence: chunk.sequenceList[i], content: {rules: content.rules, definitionTags: content.definitionTags,
                    termTags: content.termTags, glossary: JSON.parse(content.glossaryJson)}});
            contentBytes.push([...bytes]);
        }
        uniqueIndexes.push(...ids);
        uniqueRows.push([...chunk.contentDedupPlan.uniqueRowIndexes]);
        uniqueSignatures.push([...chunk.contentDedupPlan.uniqueSignatures ?? []]);
        uniqueCounts.push(chunk.contentDedupPlan.uniqueCount);
        for (const [key, value] of chunk.preparedLookupIndexes ?? []) { indexes.push([key, [...value.bytes]]); }
        media.push(...chunk.mediaRows.map(({index, row: mediaRow, imagePaths}) => ({index, imagePaths: imagePaths ?? null,
            row: Object.fromEntries(Object.entries(mediaRow).map(([key, value]) => [key,
                value instanceof Uint8Array ? [...value] : Object.is(value, -0) ? {negativeZero: true} : value ?? null,
            ]))})));
    }
    return {rows, contentBytes, indexes, uniqueIndexes, uniqueRows, uniqueSignatures, uniqueCounts, media};
}

async function parse(banks, {experiments = {}, validateGlossaryTypes = true, corruptLastSignature = false, published = []} = {}) {
    const sourceBanks = banks.length === 1 ? [...banks, '[]'] : banks;
    const sources = sourceBanks.map((text, index) => {
        const decoded = encoder.encode(text);
        const compressionMethod = index % 2 === 0 ? 8 : 0;
        const bytes = compressionMethod === 8 ? new Uint8Array(deflateRawSync(decoded)) : decoded;
        return {bytes, compressionMethod, compressedSize: bytes.length, uncompressedSize: decoded.length, signature: crc32(decoded)};
    });
    if (corruptLastSignature) { sources[sources.length - 1].signature = (sources[sources.length - 1].signature ^ 1) >>> 0; }
    const options = {experimentalNativeEscapedKeys: true, ...experiments,
        ...(disabledReuse ? {experimentalValidatedGlossaryReuse: false} : {}),
        singleChunk: true, emitTermByteLists: true, computeContentHashes: true,
        emitContentSlab: true, emitTokenBinaryContent: true, mediaHintFastScan: true,
        validateGlossaryTypes, prepareLookupIndexes: true};
    const preloadedSource = await parser.inflateCompressedTermBankSourcesWasm(sources, options, true);
    await parser.parseTermBankWithWasmColumnChunks(new Uint8Array(0), 3,
        (chunk) => published.push(parser.copyWasmBackedColumnChunk(chunk)), 2048, {...options, preloadedSource});
    const profile = parser.consumeLastTermBankWasmParseProfile();
    assert(profile, 'Missing public parser profile');
    assert.equal(profile.fusedParseAttempts, experiments.experimentalSkipFusedParse === true ? 0 : 1,
        'Fixture did not exercise the required default multi-bank fused route');
    assert.equal(profile.fusedSingleBankGroups ?? 0, 0, 'Fixture relied on single-bank fusion');
    if (disabledReuse || experiments.experimentalValidatedGlossaryReuse === false) {
        assert.equal(profile.validatedGlossaryReuseCount, 0, 'Explicitly disabled reuse still accepted a proof');
    }
    return {chunks: published, profile, memory: preloadedSource.wasm.memory};
}

const expectedReuses = (test) => disabledReuse ? 0 : test.baselineReuses + (baseline ? 0 : test.selectorReuses);
const results = [];
const diagnostics = [];
for (const test of validCases) {
    const before = counters();
    const parsed = await parse(test.banks);
    assert.equal(parsed.profile.fusedParseFallbacks ?? 0, 0, `${test.name}: unexpected fused fallback`);
    assert.equal(parsed.profile.validatedGlossaryReuseCount, expectedReuses(test), `${test.name}: wrong reuse policy`);
    const actual = snapshot(parsed.chunks);
    const expected = expectedRows(test.banks, test.equals);
    assert.deepEqual(actual.rows, expected, `${test.name}: semantic mismatch`);
    if (expected.length > 0) { assert(actual.indexes.length > 0, `${test.name}: missing prepared lookup bytes`); }
    const mediaContents = new Set(expected.filter(({content}) => content.glossary.some((value) => typeof value === 'object' && value.type === 'image'))
        .map(({content}) => JSON.stringify(content)));
    assert.equal(actual.media.length, mediaContents.size,
        `${test.name}: incorrect media hint result`);
    if (diagnosticWasm) {
        const counts = delta(before, counters());
        assert.equal(counts.hits, disabledReuse || baseline ? 0 : test.selectorReuses, `${test.name}: wrong isolated selector proof count`);
        assert.equal(counts.originalGlossaryReuses, disabledReuse ? 0 : test.baselineReuses, `${test.name}: original reuse policy changed`);
        assert.equal(counts.totalGlossaryReuses, expectedReuses(test), `${test.name}: diagnostic and public proof counts disagree`);
        assert.equal(counts.expressionMatches + counts.readingMatches, counts.admissions, `${test.name}: identity arms disagree with admissions`);
        assert(counts.keyComparisonCalls <= 3 * counts.keyPredicateRows, `${test.name}: helper comparison count exceeds its bound`);
        assert(counts.keyComparisonBytesOffered <= 96 * counts.keyPredicateRows, `${test.name}: helper offered bytes exceed their bound`);
        assert(counts.cumulativeMaxima.maxKeyComparisonBytes <= 32, `${test.name}: an added key comparison exceeded 32 bytes`);
        if (disabledReuse) {
            for (const key of disabledZeroFields) {
                assert.equal(maximumFields.has(key) ? counts.cumulativeMaxima[key] : counts[key], 0, `${test.name}: disabled reuse performed ${key}`);
            }
        } else if (!baseline) {
            for (const [key, expectedCount] of Object.entries(selectorDiagnostics[test.name] ?? {})) {
                assert.equal(counts[key], expectedCount, `${test.name}: wrong selector stage ${key}`);
            }
        }
    }
    results.push({name: test.name, ...actual});
    diagnostics.push({name: test.name, expectedReuses: expectedReuses(test), actualReuses: parsed.profile.validatedGlossaryReuseCount,
        fusedParseAttempts: parsed.profile.fusedParseAttempts, fusedParseFallbacks: parsed.profile.fusedParseFallbacks ?? 0,
        ...(diagnosticWasm ? delta(before, counters()) : {})});
}

for (const test of malformedCases) {
    const before = counters();
    const published = [];
    await assert.rejects(() => parse(test.banks, {published}), `${test.name}: malformed bank accepted`);
    assert.equal(published.length, 0, `${test.name}: valid prefix escaped a failed parse`);
    const freshBanks = [bank(row('fresh', {score: '3', sequence: '9', gloss: '["new"]'})), '[]'];
    const fresh = await parse(freshBanks);
    assert.equal(fresh.profile.validatedGlossaryReuseCount, 0, `${test.name}: proof survived to an independent request`);
    assert.deepEqual(snapshot(fresh.chunks).rows, expectedRows(freshBanks));
    diagnostics.push({name: test.name, rejected: true, publishedRows: 0, ...(diagnosticWasm ? delta(before, counters()) : {})});
}

for (const test of fallbackCases) {
    const parsed = await parse(test.banks);
    assert.equal(parsed.profile.fusedParseFallbacks, 1, `${test.name}: ordinary numeric fallback did not execute`);
    const actual = snapshot(parsed.chunks);
    assert.deepEqual(actual.rows, expectedRows(test.banks, test.equals), `${test.name}: fallback changed semantics`);
    results.push({name: test.name, ...actual});
}

const escapedBanks = active(row('other', {}, '"reading"'), rawRow('"\\u0061"', {}, '"reading"'));
const escapedFallback = await parse(escapedBanks, {experiments: {experimentalNativeEscapedKeys: false}});
assert.equal(escapedFallback.profile.fusedParseFallbacks, 1, 'Disabled escaped-key support did not preserve fallback');
assert.deepEqual(snapshot(escapedFallback.chunks).rows, expectedRows(escapedBanks));
results.push({name: 'disabled escaped-key support preserves fallback', ...snapshot(escapedFallback.chunks)});

const nonStrictBanks = active(row('same'), row('same'));
const nonStrict = await parse(nonStrictBanks, {validateGlossaryTypes: false});
assert.equal(nonStrict.profile.fusedParseFallbacks ?? 0, 0);
assert.equal(nonStrict.profile.validatedGlossaryReuseCount, 0, 'Permissive parse enabled a strict-only selector');
assert.deepEqual(snapshot(nonStrict.chunks).rows, expectedRows(nonStrictBanks));
results.push({name: 'permissive parsing preserves original policy', ...snapshot(nonStrict.chunks)});

const longFixture = validCases.find(({name}) => name === 'active older 4096-byte candidate succeeds without a new cap');
assert(longFixture);
const published = [];
await assert.rejects(() => parse(longFixture.banks, {corruptLastSignature: true, published}), 'Corrupt current-bank CRC accepted');
assert.equal(published.length, 0, 'Corrupt current-bank CRC published rows');
const recovered = await parse(longFixture.banks);
assert.equal(recovered.profile.validatedGlossaryReuseCount, expectedReuses(longFixture));
assert.deepEqual(snapshot(recovered.chunks).rows, expectedRows(longFixture.banks));

const heldBanks = [bank(row('same'), row('same')), '[]', bank(row('same'))];
const held = await parse(heldBanks);
const saved = structuredClone(held.chunks);
assert.equal(held.profile.validatedGlossaryReuseCount, disabledReuse || baseline ? 0 : 1);
held.memory.grow(1);
await assert.rejects(() => parse([bank(row('same'), row('same')), `[${row('same')} null]`]), 'Post-growth malformed row accepted');
const freshBanks = [bank(row('fresh', {score: '7', sequence: '29', gloss: '["replacement"]'})), '[]'];
const fresh = await parse(freshBanks);
assert.equal(fresh.profile.validatedGlossaryReuseCount, 0, 'Independent request inherited a proof or key state');
assert.deepEqual(snapshot(fresh.chunks).rows, expectedRows(freshBanks));
const disabled = await parse(heldBanks, {experiments: {experimentalValidatedGlossaryReuse: false}});
assert.deepEqual(snapshot(disabled.chunks), snapshot(held.chunks), 'Explicit disabled reuse changed retained output');
assert.equal((await parse(heldBanks)).profile.validatedGlossaryReuseCount, disabledReuse || baseline ? 0 : 1);
assert.deepEqual(held.chunks, saved, 'Owned output changed after growth and subsequent requests');
results.push({name: 'ownership across growth and independent requests', ...snapshot(held.chunks)});

if (diagnosticWasm) {
    assert(diagnosticExports, 'Requested diagnostic module did not export prior_streak_selector_diag_get');
    const cumulative = counters();
    assert(cumulative.maxKeyComparisonBytes <= 32, 'An added key comparison exceeded 32 body bytes');
    if (disabledReuse) {
        for (const key of disabledZeroFields) { assert.equal(cumulative[key], 0, `Disabled smoke performed ${key}`); }
    }
}
await parser.disposeParallelTermBankParser();
if (diagnosticWasm) { WebAssembly.instantiate = nativeInstantiate; }
assert.equal(sha256(await readFile(sourcePath)), sourceHash, 'Native source changed during smoke');
assert.equal(sha256(await readFile(wasmPath)), wasmHash, 'Native module changed during smoke');
assert.equal(sha256(await readFile(fixturePath)), fixtureHash, 'Smoke fixtures changed during execution');
assert.equal(sha256(await readFile(fileURLToPath(import.meta.url))), harnessHash, 'Smoke harness changed during execution');
console.log(JSON.stringify({schema: 1, complete: true, scope: 'Untimed synthetic production-path correctness and policy checks',
    baseline, disabledReuse, sourceHash, wasmHash, fixtureHash, harnessHash,
    validCases: validCases.length, malformedCases: malformedCases.length, fallbackCases: fallbackCases.length,
    diagnosticFields, disabledZeroFields,
    results, diagnostics, nativeDiagnostics: diagnosticWasm ? counters() : null}));
