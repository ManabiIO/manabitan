/* Copyright (C) 2026 Manabitan authors; SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {crc32, deflateRawSync} from 'node:zlib';
import {parseArgs} from 'node:util';
import path from 'node:path';
import {proofConsumerFixtures, acceptedNegativeZeroSequenceFixture, invalidNullScoreAfterProof} from './qualification/term-bank-row-suffix-proof-fixtures.js';

const {values, positionals} = parseArgs({allowPositionals: true, options: {'disabled-reuse': {type: 'boolean'}}});
const [sourceRoot, diagnosticWasm] = positionals;
const disabledReuse = values['disabled-reuse'] === true;
assert(sourceRoot);
let diagnosticExports;
if (diagnosticWasm) {
    const instantiate = WebAssembly.instantiate.bind(WebAssembly);
    WebAssembly.instantiate = async (...args) => {
        const result = await instantiate(...args);
        diagnosticExports = result instanceof WebAssembly.Instance ? result.exports : result.instance.exports;
        return result;
    };
}
const parser = await import(pathToFileURL(path.join(sourceRoot, 'ext/js/dictionary/term-bank-wasm-parser.js')));
parser.setTermBankWasmModule(await WebAssembly.compile(await readFile(diagnosticWasm ?? path.join(sourceRoot, 'ext/lib/term-bank-parser.wasm'))));
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {ignoreBOM: true});
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const diagnosticFields = ["attempts", "boundedRanges", "tailRejected", "fullRejected", "hits", "hitBytes", "potentialRangeBytes", "eligibleStreakRows", "numericRejected", "actualSuffixSuccessRows", "scoreTokenEndScansAvoided", "sequenceTokenEndScansAvoided", "numericCopyRows", "scoreConversionsAvoided", "sequenceConversionsAvoided", "ordinaryContentComparisonsAvoided"];
const counters = () => Object.fromEntries(diagnosticFields.map((key, index) => [key,
    diagnosticExports ? Number(diagnosticExports.row_suffix_diag_get(index)) : 0]));
const delta = (before, after) => Object.fromEntries(diagnosticFields.map((key) => [key, after[key] - before[key]]));
function checkConsumers(counts) {
    assert.equal(counts.actualSuffixSuccessRows, counts.hits, 'Only positive full-suffix proofs supply the status');
    assert.equal(counts.scoreTokenEndScansAvoided, counts.actualSuffixSuccessRows);
    assert(counts.sequenceTokenEndScansAvoided <= counts.actualSuffixSuccessRows);
    assert(counts.numericCopyRows <= counts.actualSuffixSuccessRows, 'Current key processing can fail after proof');
    assert.equal(counts.scoreConversionsAvoided, counts.numericCopyRows);
    assert(counts.sequenceConversionsAvoided <= counts.numericCopyRows);
    assert(counts.ordinaryContentComparisonsAvoided <= counts.numericCopyRows);
}
const bytesSnapshot = (view) => view ? {length: view.length, sha256: hash(view)} : null;

function snapshot(chunk) {
    return {
        rows: Array.from({length: chunk.rowCount}, (_, i) => {
            const meta = chunk.contentMetaList;
            const offset = meta ? (chunk.contentBytesBaseOffset ?? 0) + meta[i * 4] : 0;
            const content = meta && chunk.contentBytesBuffer ?
                chunk.contentBytesBuffer.subarray(offset, offset + meta[i * 4 + 1]) : chunk.contentBytesList[i];
            return {expression: decoder.decode(chunk.expressionBytesList[i]), reading: decoder.decode(chunk.readingBytesList[i]),
                equal: chunk.readingEqualsExpressionList[i], score: chunk.scoreList[i], negativeZero: Object.is(chunk.scoreList[i], -0),
                sequence: chunk.sequenceList[i], content: hash(content)};
        }),
        mediaRows: chunk.mediaRows.map(({index, row, imagePaths}) => ({index, imagePaths: imagePaths ?? null,
            row: Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
                value instanceof Uint8Array ? bytesSnapshot(value) : Object.is(value, -0) ? {negativeZero: true} : value ?? null,
            ]))})),
        uniqueIndexes: bytesSnapshot(chunk.contentUniqueIndexList),
        uniqueRows: bytesSnapshot(chunk.contentDedupPlan?.uniqueRowIndexes),
        uniqueSignatures: bytesSnapshot(chunk.contentDedupPlan?.uniqueSignatures),
        uniqueCount: chunk.contentDedupPlan?.uniqueCount ?? null,
        contentMetaByUniqueIndex: chunk.contentMetaByUniqueIndex ?? false,
        useResolvedContentReferences: chunk.useResolvedContentReferences ?? false,
    };
}

async function parse(banks, experiments = {}) {
    const sourceBanks = banks.length === 1 ? [...banks, '[]'] : banks;
    const sources = sourceBanks.map((text) => {
        const decoded = encoder.encode(text);
        const bytes = new Uint8Array(deflateRawSync(decoded));
        return {bytes, compressedSize: bytes.length, uncompressedSize: decoded.length, compressionMethod: 8, signature: crc32(decoded)};
    });
    const options = {experimentalNativeEscapedKeys: true, singleChunk: true, emitTermByteLists: true,
        computeContentHashes: true, emitContentSlab: true, emitTokenBinaryContent: true,
        mediaHintFastScan: true, validateGlossaryTypes: true, ...experiments,
        ...(disabledReuse ? {experimentalValidatedGlossaryReuse: false} : {})};
    const preloadedSource = await parser.inflateCompressedTermBankSourcesWasm(sources, options, true);
    const results = [];
    await parser.parseTermBankWithWasmColumnChunks(new Uint8Array(0), 3, (chunk) => results.push(snapshot(chunk)), 2048, {...options, preloadedSource});
    assert.equal(parser.consumeLastTermBankWasmParseProfile()?.fusedParseAttempts, 1, 'Synthetic input must exercise the default multi-bank fused route');
    return results;
}

const glossary = '[{"type":"text","text":"  shared text  "},{"type":"image","path":"image.png"}]';
const body = ({score = '-5', sequence = '17', definitionTags = '"noun"', rules = '""', termTags = '"common"', gloss = glossary} = {}) =>
    `${definitionTags},${rules},${score},${gloss},${sequence},${termTags}`;
const row = (expression, fields = {}, reading = '""') => `[${JSON.stringify(expression)},${reading},${body(fields)}]`;
const bank = (...rows) => `[${rows.join(',')}]`;
const prefix = bank(row('first'), row('second'));
const three = (one = {}, two = one, last = two) => bank(row('first', one), row('second', two), row('last', last));
const valid = [
    {name: 'equal-numerics-cross-bank-escaped-keys', banks: [prefix, `[["\\u0061","a",${body()}],["a","a",${body()}]]`], minHits: 2},
    {name: 'same-length-unequal-glossary', banks: [three({}, {}, {gloss: glossary.replace('shared', 'differ')})], exact: {attempts: 1, hits: 0, fullRejected: 1}},
    {name: 'unequal-definition-tags', banks: [three({}, {}, {definitionTags: '"verb"'})], exact: {attempts: 1, hits: 0}},
    {name: 'unequal-term-tags', banks: [three({}, {}, {termTags: '"public"'})], exact: {attempts: 1, hits: 0, tailRejected: 1}},
    {name: 'unequal-current-score', banks: [three({}, {}, {score: '-4'})], exact: {attempts: 1, hits: 0}},
    {name: 'unequal-current-sequence', banks: [three({}, {}, {sequence: '18'})], exact: {attempts: 1, hits: 0}},
    {name: 'differing-prior-scores', banks: [three({}, {score: '-4'}, {score: '-4'})], exact: {attempts: 0, hits: 0, numericRejected: 1}},
    {name: 'differing-prior-sequences', banks: [three({}, {sequence: '18'}, {sequence: '18'})], exact: {attempts: 0, hits: 0, numericRejected: 1}},
    {name: 'differing-prior-numerics-cross-bank', banks: [bank(row('first')), bank(row('second', {score: '-4', sequence: '18'})), bank(row('third', {score: '-4', sequence: '18'}))], exact: {attempts: 0, hits: 0, numericRejected: 1}},
    {name: 'nullable-tags-and-sequence', banks: [three({score: '0', sequence: 'null', definitionTags: 'null'})], minHits: 1},
    {name: 'empty-bank-between-equal-pairs', banks: [prefix, '[]', bank(row('last'))], minHits: 1},
    {name: 'score-fraction-fallback', banks: [three({score: '0.5'})]},
    {name: 'score-exponent-fallback', banks: [three({score: '1e1'})]},
    {name: 'sequence-exponent-fallback', banks: [three({sequence: '1e1'})]},
    {name: 'negative-zero-fallback', banks: [three({score: '-0'})]},
    {name: 'fraction-after-equal-prior-pair', banks: [three({}, {}, {score: '0.5'})]},
    {name: 'negative-zero-after-equal-prior-pair', banks: [three({score: '0'}, {score: '0'}, {score: '-0'})]},
    {name: 'numeric-prefix-extension-valid', banks: [three({score: '1'}, {score: '1'}, {score: '10'})], exact: {attempts: 1, hits: 0}},
];
const malformed = [
    {name: 'fractional-sequence-rejected-after-fallback', banks: [three({sequence: '0.5'})]},
    {name: 'extra-field-after-equal-pair', banks: [prefix, `[["last","",${body()},true]]`]},
    {name: 'suffix-token-extension', banks: [prefix, `[["last","",${body()} null]]`]},
    {name: 'post-row-token-after-proven-suffix', banks: [prefix, `[${row('last')} null]`]},
    {name: 'truncated-bank', banks: [prefix, `[["last","",${body().slice(0, -1)}`]},
    {name: 'truncated-bank-followed-by-completing-bytes', banks: [prefix, `[["last","",${body().slice(0, -1)}`, '"]]]']},
    {name: 'boolean-score-after-equal-pair', banks: [prefix, bank(row('last', {score: 'false'}))]},
    {name: 'invalid-definition-tags-after-equal-pair', banks: [prefix, bank(row('last'), row('broken', {definitionTags: '{}'}))]},
    {name: 'numeric-prefix-extension-invalid', banks: [bank(row('first', {score: '0'}), row('second', {score: '0'})), bank(row('last', {score: '00'}))]},
    {name: 'malformed-expression-after-equal-pair', banks: [prefix, `[["bad\\x","",${body()}]]`]},
    {name: 'malformed-reading-after-equal-pair', banks: [prefix, `[["last","bad\\x",${body()}]]`]},
    {name: 'malformed-sequence-after-equal-pair', banks: [prefix, bank(row('last', {sequence: '17e'}))]},
];
malformed.push({name: 'strict-null-score-after-positive-proof', banks: invalidNullScoreAfterProof});
const results = [];
const diagnostics = [];
for (const test of valid) {
    const before = counters();
    results.push({name: test.name, chunks: await parse(test.banks)});
    if (diagnosticWasm) {
        const counts = delta(before, counters());
        checkConsumers(counts);
        if (disabledReuse) {
            assert.equal(counts.attempts, 0, `${test.name}: disabled reuse attempted a suffix proof`);
            assert.equal(counts.hits, 0, `${test.name}: disabled reuse accepted a suffix proof`);
        } else {
            if (test.minHits) { assert(counts.hits >= test.minHits, `${test.name}: expected suffix activation`); }
            for (const [key, expected] of Object.entries(test.exact ?? {})) { assert.equal(counts[key], expected, `${test.name}: ${key}`); }
        }
        diagnostics.push({name: test.name, ...counts});
    }
}
for (const test of [...proofConsumerFixtures, acceptedNegativeZeroSequenceFixture]) {
    const before = counters();
    results.push({name: test.name, chunks: await parse(test.banks, test.experiments)});
    if (diagnosticWasm) {
        const counts = delta(before, counters());
        checkConsumers(counts);
        const disabled = disabledReuse || test.experiments?.experimentalValidatedGlossaryReuse === false;
        const rows = test.banks.flatMap((bank) => JSON.parse(bank));
        const allNull = rows.every((row) => row[6] === null);
        const allNonNull = rows.every((row) => row[6] !== null);
        assert(allNull || allNonNull, `${test.name}: mixed sequence kinds need an explicit scan expectation`);
        const expected = disabled ? 0 : test.expectedProofs;
        assert.equal(counts.hits, expected, `${test.name}: actual byte-proof hits`);
        assert.equal(counts.actualSuffixSuccessRows, expected, `${test.name}: returned proof status`);
        assert.equal(counts.scoreTokenEndScansAvoided, expected, `${test.name}: avoided score-end scans`);
        assert.equal(counts.sequenceTokenEndScansAvoided, allNull ? 0 : expected, `${test.name}: avoided sequence-end scans`);
        assert.equal(counts.numericCopyRows, disabled ? 0 : test.expectedNumericReuseRows, `${test.name}: numeric-copy rows`);
        assert.equal(counts.scoreConversionsAvoided, disabled ? 0 : test.expectedNumericReuseRows, `${test.name}: avoided score conversions`);
        assert.equal(counts.sequenceConversionsAvoided, disabled ? 0 : test.expectedSequenceConversionsAvoided, `${test.name}: avoided sequence conversions`);
        assert.equal(counts.ordinaryContentComparisonsAvoided, disabled ? 0 : test.expectedOrdinaryComparisonSkips, `${test.name}: ordinary comparisons avoided`);
        diagnostics.push({name: test.name, ...counts});
    }
}
for (const test of malformed) {
    const before = counters();
    await assert.rejects(() => parse(test.banks), `${test.name}: malformed bank accepted`);
    if (diagnosticWasm) { diagnostics.push({name: test.name, ...delta(before, counters())}); }
}
results.push({name: 'fresh-valid-input-after-all-failures', chunks: await parse([bank(row('fresh', {score: '3', sequence: '9', gloss: '["new"]'})), '[]'])});
if (diagnosticWasm && disabledReuse) {
    assert.equal(counters().attempts, 0, 'Disabled reuse attempted suffix proofs across successive failed/successful calls');
    assert.equal(counters().hits, 0, 'Disabled reuse accepted suffix proofs across successive failed/successful calls');
}
if (diagnosticWasm) { checkConsumers(counters()); }
console.log(JSON.stringify({disabledReuse, validCases: valid.length + proofConsumerFixtures.length + 1, originalValidCases: valid.length, proofConsumerCases: proofConsumerFixtures.length + 1, malformedCases: malformed.length, results,
    diagnosticAttempts: diagnosticWasm ? counters().attempts : null,
    diagnosticHits: diagnosticWasm ? counters().hits : null, diagnostics}));
