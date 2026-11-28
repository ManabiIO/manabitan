#!/usr/bin/env node
/* Untimed diagnostic only. No parser source or production state is changed. */
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {openAsBlob, createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {crc32, inflateRawSync} from 'node:zlib';
import path from 'node:path';

const [archivePath, outputPath] = process.argv.slice(2);
assert(archivePath && outputPath, 'Expected the locked JMdict archive and a fresh output directory');
const root = '/workspace/scratch/c563d487c718/manabitan';
const output = path.resolve(outputPath);
await mkdir(output, {recursive: false});
const require = createRequire(path.join(root, 'package.json'));
const {ZipReader, BlobReader} = require('@zip.js/zip.js');
const {RawZipPayloadReader} = await import(pathToFileURL(path.join(root, 'ext/js/dictionary/term-bank-source-pipeline.js')));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const scriptBytes = await readFile(fileURLToPath(import.meta.url));
await writeFile(path.join(output, 'observer-source.mjs'), scriptBytes);
const lockBytes = await readFile(path.join(root, 'test/perf/dictionaries.lock.json'));
const fixture = JSON.parse(lockBytes).dictionaries.jmdict;
const wasmBytes = await readFile(path.join(root, 'ext/lib/term-bank-parser.wasm'));
assert.equal(sha(wasmBytes), '8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee');
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(), '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2');
const native = (await WebAssembly.instantiate(wasmBytes, {})).instance.exports;
const counterNames = ['rows', 'firstRows', 'priorStreakRows', 'existingLookbackZero', 'existingLookbackPositive',
    'existingGlossaryReuses', 'recentRawContentHits', 'groupEndingRawHits', 'eligible', 'boundsRejects',
    'spanPasses', 'spanRejects', 'spanBytesOffered', 'spanLogicalBytesCompared', 'passedSpanBytes',
    'glossaryCandidateBytesOffered', 'glossaryTailRejects', 'glossaryMiddleRejects', 'glossaryFullRejects',
    'fullEqualityBytesOffered', 'fullEqualityHits', 'glossaryValidationBytesReusable',
    'hitsAfterZeroPriorStreak', 'hitsAfterNonzeroPriorStreak', 'hitsWithExactFullContent', 'crossBankHits'];
const categories = ['null', 'negative', 'nonnegative'];
const emptyCounters = () => Object.fromEntries(counterNames.map((name) => [name, 0]));
const selectorCounterNames = ['zeroLookbackRows', 'keyRejected', 'admissions', 'candidateRecordsInspected',
    'definitionLengthRejected', 'rulesLengthRejected', 'definitionSignatureRejected', 'rulesSignatureRejected',
    'currentSignatureBytesRead', 'candidateSignatureBytesRead', 'noPrefixCandidate', 'selected', 'selectedBytes',
    'selectedAtLeast512', 'selectedAtLeast512Bytes', 'selectedExactPrefix', 'selectedSignatureCollision',
    'boundsRejected', 'openerRejected', 'tailRejected', 'middleRejected', 'fullRejected',
    'tailBytesOffered', 'tailLogicalBytesCompared', 'middleBytesOffered', 'middleLogicalBytesCompared',
    'fullBytesOffered', 'fullLogicalBytesCompared', 'failedFullBytesOffered', 'failedFullLogicalBytesCompared',
    'hits', 'hitBytes', 'fullContentHits', 'fullContentHitBytes', 'crossBankSelected', 'crossBankHits',
    'oraclePrefixCandidates', 'oracleAmbiguousPrefixRows', 'oracleLaterPrefixCandidates',
    'oracleFailedBlocksLaterPrefixGlossary', 'oracleFailedBlocksLaterPrefixGlossaryBytes',
    'oracleFailedBlocksLaterPrefixContent', 'oracleFailedBlocksLaterPrefixContentBytes',
    'oracleFailedBlocksLaterAnyGlossary', 'oracleFailedBlocksLaterAnyGlossaryBytes'];
const selectorEmptyCounters = () => Object.fromEntries(selectorCounterNames.map((name) => [name, 0]));
const selectorEmptyMaxima = () => ({selectedLength: 0, hitLength: 0, failedLength: 0,
    fullComparisonLength: 0, failedFullComparisonLength: 0});
const makeSelectorCell = () => ({counters: selectorEmptyCounters(), maxima: selectorEmptyMaxima()});
const makeSelectorStats = () => ({...makeSelectorCell(), byKeyKind: {}, bySelectedDistance: {},
    bySelectedLength: {}, oraclePrefixCandidateCount: {0: 0, 1: 0, 2: 0, 3: 0, 4: 0}});
const makeStats = () => ({...emptyCounters(), byPriorSequence: Object.fromEntries(categories.map((name) => [name, emptyCounters()])), extension: {missingWitnessFullContent: {}, adjacentGlossaryAtZeroLookback: {}, keyAtZeroLookback: {}, existingWitnessIntersection: {}}, selector: makeSelectorStats(), priorStreakSelector: {zero: makeSelectorStats(), positive: makeSelectorStats()}});
const report = {schema: 1, complete: false, extension: 'One untimed prior-streak-nonzero partition of the frozen run-3 selector; all previous results remain unchanged',
    scope: 'Untimed baseline opportunity observer. Sequence-span equality only rejects candidates; a complete bounded glossary equality proof is mandatory. Hypothetical witnesses never alter the replay budget, streak, metadata, or outputs. Byte counts describe offered ranges/reusable validation, not avoided I/O or predicted runtime.',
    selectorProtocol: 'At ORIGINAL lookback0 with an existing bounded adjacent-key identity, select the FIRST newest-first prior record among the unchanged four-row window whose definitionTags and rules lengths and raw first up-to-four-byte signatures match. Attempt only that glossary, bounded to the current logical bank, using opener, tail/middle rejection samples and complete raw equality. No dictionary/tag/distance literal, added cap, second attempt, or hypothetical state update. Ambiguity/later-match/actual extent/content/hints are separate post-admission oracle work. Signature bytes are complete field-signature reads; logical equality bytes include the first mismatch and overlapping samples. All run-2 legacy totals/banks/groups must match exactly.',
    priorStreakProtocol: 'Partition ONLY the ORIGINAL pre-row recent_content_match_streak === 0 versus != 0 at original lookback0. Reuse the exact run-3 key admission, first prefix selection and complete glossary proof once; no new witness affects original budget/streak/state. All original run-3 scalar, bank, group and metadata results must reconcile.',
    parentObserverSha256: '548b43bb6f16301aa279bd35dd2f559298f4e69a246770cf24731c3853ad3dad',
    parentResultSha256: 'adfe631bc36931eef394075c456b75bd0252001f0613171ebcc2a009fa5cb362',
    node: process.version, observerSha256: sha(scriptBytes), wasmSha256: sha(wasmBytes), fixtureLockSha256: sha(lockBytes),
    baselineCSourceSha256: sha(await readFile(path.join(root, 'ext/js/dictionary/wasm/term-bank-parser.c'))),
    constants: {banksPerGroup: 7, recentWindow: 4, probeBudget: 4, admissionMatches: 4, longGlossaryBytes: 512},
    totals: makeStats(), banks: [], groups: [], failures: [],
    limits: {nodeHeapMiB: 256, decodedBanksRetained: 1, priorTuplesRetained: 4},
    maxima: {decodedBankBytes: 0, retainedTupleBytes: 0, wasmHeapBytes: 0, sequenceSpanBytes: 0, eligibleGlossaryBytes: 0},
    hitGlossaryLengthHistogram: {}};
let bankStats;
let groupStats;
let currentLocation = {};
const update = (name, amount = 1, category = null) => {
    for (const stats of [report.totals, bankStats, groupStats]) {
        stats[name] += amount;
        if (category !== null) { stats.byPriorSequence[category][name] += amount; }
    }
};
const save = async () => writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
const asciiSpace = (byte) => byte === 32 || byte === 9 || byte === 10 || byte === 13;
function scalarBeforeComma(bytes, start, nextFieldStart) {
    let end = nextFieldStart;
    while (end > start && asciiSpace(bytes[end - 1])) { --end; }
    assert.equal(bytes[--end], 44);
    while (end > start && asciiSpace(bytes[end - 1])) { --end; }
    return bytes.toString('ascii', start, end);
}
function sameContent(first, second, glossaryKnown = false) {
    return (glossaryKnown || first.glossary.equals(second.glossary)) && first.rules.equals(second.rules) &&
        first.definitionTags.equals(second.definitionTags) && first.termTags.equals(second.termTags);
}
function copyTuple(row) {
    return {...row, expression: Buffer.from(row.expression), reading: Buffer.from(row.reading), glossary: Buffer.from(row.glossary), sequenceSpan: Buffer.from(row.sequenceSpan),
        definitionTags: Buffer.from(row.definitionTags), rules: Buffer.from(row.rules), termTags: Buffer.from(row.termTags)};
}
function bucket(section, key, bytes, hit = false, candidateBytes = 0) {
    for (const stats of [report.totals, bankStats, groupStats]) {
        const table = stats.extension[section];
        const cell = table[key] ??= {rows: 0, glossaryBytes: 0, equalGlossaryRows: 0, equalGlossaryBytes: 0, candidateBytesOffered: 0};
        ++cell.rows;
        cell.glossaryBytes += bytes;
        cell.candidateBytesOffered += candidateBytes;
        if (hit) { ++cell.equalGlossaryRows; cell.equalGlossaryBytes += bytes; }
    }
}
function keyEvidence(current, prior) {
    const expression = current.expression.equals(prior.expression);
    const nonemptyReading = current.reading.length > 2 && prior.reading.length > 2;
    const reading = nonemptyReading && current.reading.equals(prior.reading);
    const boundedExpression = expression && current.expression.length <= 34;
    const boundedReading = reading && current.reading.length <= 34;
    const readingEqualsExpression = current.reading.length === 2 || current.reading.equals(current.expression);
    return {expression, reading, all: expression || reading,
        boundedExpression, boundedReading, bounded: boundedExpression || boundedReading,
        readingEqualsExpression, existingComparisons: boundedExpression || (boundedReading && !readingEqualsExpression)};
}
function rawSpanPass(bytes, current, prior) {
    const n = prior.glossary.length;
    const m = prior.sequenceSpan.length;
    if (n > bytes.length - current.glossaryStart || m > bytes.length - current.glossaryStart - n) { return false; }
    return bytes.subarray(current.glossaryStart + n, current.glossaryStart + n + m).equals(prior.sequenceSpan);
}
function bucketZeroLookback(bytes, current, prior) {
    const equalGlossary = current.glossary.equals(prior.glossary);
    const prefix = current.definitionTags.equals(prior.definitionTags) && current.rules.equals(prior.rules);
    const sameScore = current.score === prior.score;
    const key = keyEvidence(current, prior);
    const n = current.glossary.length;
    bucket('keyAtZeroLookback', 'allRows', n, equalGlossary);
    for (const property of ['expression', 'reading', 'all', 'boundedExpression', 'boundedReading', 'bounded', 'existingComparisons']) {
        if (key[property]) { bucket('keyAtZeroLookback', property, n, equalGlossary, prior.glossary.length); }
    }
    if (key.expression && key.reading) { bucket('keyAtZeroLookback', 'expressionAndReading', n, equalGlossary); }
    if (key.expression && !key.reading) { bucket('keyAtZeroLookback', 'expressionOnly', n, equalGlossary); }
    if (key.reading && !key.expression) { bucket('keyAtZeroLookback', 'readingOnly', n, equalGlossary); }
    if (key.boundedReading && key.readingEqualsExpression) { bucket('keyAtZeroLookback', 'readingEqualityNotComparedByBaseline', n, equalGlossary); }
    if (!equalGlossary) { return; }
    const spanPass = rawSpanPass(bytes, current, prior);
    const category = spanPass ? 'sequenceSpanPass' : current.sequenceToken !== prior.sequenceToken ? 'differentSequenceToken' : 'separatorSpacingOrLength';
    bucket('adjacentGlossaryAtZeroLookback', 'all', n, true);
    bucket('adjacentGlossaryAtZeroLookback', category, n, true);
    bucket('adjacentGlossaryAtZeroLookback', `priorSequence:${prior.sequenceClass}`, n, true);
    bucket('adjacentGlossaryAtZeroLookback', `prefix:${prefix ? 'equal' : 'different'}/score:${sameScore ? 'equal' : 'different'}`, n, true);
    if (!spanPass && current.sequenceToken !== prior.sequenceToken) {
        const currentNegative = current.sequenceToken.startsWith('-');
        const priorNegative = prior.sequenceToken.startsWith('-');
        const currentMagnitude = currentNegative ? current.sequenceToken.slice(1) : current.sequenceToken;
        const priorMagnitude = priorNegative ? prior.sequenceToken.slice(1) : prior.sequenceToken;
        const signOnly = currentNegative !== priorNegative && currentMagnitude === priorMagnitude;
        bucket('adjacentGlossaryAtZeroLookback', signOnly ? 'oppositeSignSameMagnitude' : 'otherSequenceDifference', n, true);
    }
    if (key.existingComparisons) { bucket('adjacentGlossaryAtZeroLookback', 'existingKeyComparisonGate', n, true); }
}
function bucketExistingState(current, prior, witness, recentMatch, lookback) {
    if (witness && recentMatch) { bucket('existingWitnessIntersection', 'oldWitnessRawHit', current.glossary.length); }
    if (witness && !recentMatch) { bucket('existingWitnessIntersection', 'oldWitnessNoRawHit', current.glossary.length); }
    if (!recentMatch || witness) { return; }
    bucket('existingWitnessIntersection', 'noWitnessRawHit', current.glossary.length);
    const distance = current.groupRow - recentMatch.groupRow;
    assert(distance >= 1 && distance <= 4);
    assert.notEqual(lookback, 4, 'A full-content witness in the four-row window must have an old glossary witness at lookback4');
    const prefix = current.definitionTags.equals(prior.definitionTags) && current.rules.equals(prior.rules);
    const sameScore = current.score === prior.score;
    const evidence = keyEvidence(current, prior);
    const key = `lookback:${lookback}/distance:${distance}/adjacentPrefix:${prefix ? 'equal' : 'different'}/score:${sameScore ? 'equal' : 'different'}/existingKeyGate:${evidence.existingComparisons ? 'yes' : 'no'}`;
    bucket('missingWitnessFullContent', key, current.glossary.length);
}

// Exactly read_content_signature(field, field.length, 0): up to four raw bytes,
// little endian and zero-padded. Field lengths are checked separately.
function prefixSignature(field) {
    let result = 0;
    for (let i = 0; i < Math.min(4, field.length); ++i) { result |= field[i] << (i * 8); }
    return result >>> 0;
}
function hasPrefixSignature(current, candidate, definitionSignature, rulesSignature) {
    return current.definitionTags.length === candidate.definitionTags.length &&
        current.rules.length === candidate.rules.length &&
        definitionSignature === prefixSignature(candidate.definitionTags) &&
        rulesSignature === prefixSignature(candidate.rules);
}
function addSelectorCell(cell, counters, maxima) {
    for (const [name, value] of Object.entries(counters)) { cell.counters[name] += value; }
    for (const [name, value] of Object.entries(maxima)) { cell.maxima[name] = Math.max(cell.maxima[name], value); }
}
function observeSelector(bytes, current, cache, priorStreak) {
    assert(Number.isInteger(priorStreak) && priorStreak >= 0 && priorStreak < report.constants.admissionMatches,
        'Original zero lookback cannot retain a streak that already refreshed the original budget');
    const partition = priorStreak === 0 ? 'zero' : 'positive';
    const contexts = [report.totals, bankStats, groupStats].flatMap((stats) =>
        [stats.selector, stats.priorStreakSelector[partition]]);
    for (const stats of contexts) { ++stats.counters.zeroLookbackRows; }
    const keys = keyEvidence(current, cache.at(-1));
    if (!keys.existingComparisons) {
        for (const stats of contexts) { ++stats.counters.keyRejected; }
        return;
    }
    const readingGate = keys.boundedReading && !keys.readingEqualsExpression;
    const keyKind = keys.boundedExpression ? (readingGate ? 'expressionAndReading' : 'expression') : 'reading';
    const counters = {admissions: 1, candidateRecordsInspected: 0};
    const maxima = {};
    const definitionSignature = prefixSignature(current.definitionTags);
    const rulesSignature = prefixSignature(current.rules);
    counters.currentSignatureBytesRead = Math.min(4, current.definitionTags.length) + Math.min(4, current.rules.length);
    counters.candidateSignatureBytesRead = 0;
    const increment = (name, amount = 1) => { counters[name] = (counters[name] ?? 0) + amount; };
    let selectedIndex = -1;
    // The selector stops at its FIRST matching prefix. Bounds or a failed
    // glossary proof below never cause it to try another candidate.
    for (let i = cache.length - 1; i >= 0; --i) {
        ++counters.candidateRecordsInspected;
        const candidate = cache[i];
        if (current.definitionTags.length !== candidate.definitionTags.length) { increment('definitionLengthRejected'); continue; }
        if (current.rules.length !== candidate.rules.length) { increment('rulesLengthRejected'); continue; }
        counters.candidateSignatureBytesRead += Math.min(4, candidate.definitionTags.length);
        if (definitionSignature !== prefixSignature(candidate.definitionTags)) { increment('definitionSignatureRejected'); continue; }
        counters.candidateSignatureBytesRead += Math.min(4, candidate.rules.length);
        if (rulesSignature !== prefixSignature(candidate.rules)) { increment('rulesSignatureRejected'); continue; }
        selectedIndex = i;
        break;
    }
    let selectedDistance = null;
    let lengthClass = null;
    let proven = false;
    if (selectedIndex < 0) {
        counters.noPrefixCandidate = 1;
    } else {
        const selected = cache[selectedIndex];
        const n = selected.glossary.length;
        const start = current.glossaryStart;
        counters.selected = 1;
        counters.selectedBytes = n;
        maxima.selectedLength = n;
        selectedDistance = current.groupRow - selected.groupRow;
        assert(selectedDistance >= 1 && selectedDistance <= 4);
        lengthClass = n < 512 ? 'below512' : 'atLeast512';
        if (n >= 512) { counters.selectedAtLeast512 = 1; counters.selectedAtLeast512Bytes = n; }
        if (selected.bank !== current.bank) { counters.crossBankSelected = 1; }
        const compareRange = (offset, length, stage) => {
            increment(`${stage}BytesOffered`, length);
            const logicalCounter = `${stage}LogicalBytesCompared`;
            for (let i = 0; i < length; ++i) {
                increment(logicalCounter);
                if (bytes[start + offset + i] !== selected.glossary[offset + i]) { return false; }
            }
            return true;
        };
        if (start >= bytes.length || n === 0 || n > bytes.length - start) {
            counters.boundsRejected = 1;
        } else if ((bytes[start] !== 91 && bytes[start] !== 123) || bytes[start] !== selected.glossary[0]) {
            counters.openerRejected = 1;
        } else {
            const sample = Math.min(n, 8);
            if (!compareRange(n - sample, sample, 'tail')) { counters.tailRejected = 1; }
            else if (!compareRange(Math.floor((n - sample) / 2), sample, 'middle')) { counters.middleRejected = 1; }
            else {
                maxima.fullComparisonLength = n;
                if (!compareRange(0, n, 'full')) {
                    counters.fullRejected = 1;
                    counters.failedFullBytesOffered = n;
                    counters.failedFullLogicalBytesCompared = counters.fullLogicalBytesCompared;
                    maxima.failedFullComparisonLength = n;
                } else {
                    proven = true;
                    counters.hits = 1;
                    counters.hitBytes = n;
                    maxima.hitLength = n;
                    // Actual native extent/hints are ORACLES only, never
                    // admission or selector inputs.
                    assert.equal(current.glossary.length, n);
                    assert(current.glossary.equals(selected.glossary));
                    assert.deepEqual(current.hints, selected.hints);
                    if (sameContent(current, selected, true)) {
                        counters.fullContentHits = 1;
                        counters.fullContentHitBytes = n;
                    }
                    if (selected.bank !== current.bank) { counters.crossBankHits = 1; }
                }
            }
        }
        if (!proven) { maxima.failedLength = n; }
        // This does not affect a failed proof or retry another candidate.
        assert.equal(proven, current.glossary.equals(selected.glossary));
        const exactPrefix = current.definitionTags.equals(selected.definitionTags) && current.rules.equals(selected.rules);
        counters[exactPrefix ? 'selectedExactPrefix' : 'selectedSignatureCollision'] = 1;
    }

    // Shadow ORACLE work below measures ambiguity and lost opportunity. Its
    // scans are excluded from candidateRecordsInspected/signature/proof costs.
    const prefixCandidates = [];
    for (let i = cache.length - 1; i >= 0; --i) {
        if (hasPrefixSignature(current, cache[i], definitionSignature, rulesSignature)) { prefixCandidates.push(i); }
    }
    assert(prefixCandidates.length <= 4);
    assert.equal(prefixCandidates[0] ?? -1, selectedIndex);
    counters.oraclePrefixCandidates = prefixCandidates.length;
    if (prefixCandidates.length > 1) { counters.oracleAmbiguousPrefixRows = 1; }
    counters.oracleLaterPrefixCandidates = Math.max(0, prefixCandidates.length - 1);
    if (selectedIndex >= 0 && !proven) {
        let prefixGlossary = null;
        let prefixContent = null;
        let anyGlossary = null;
        for (let i = selectedIndex - 1; i >= 0; --i) {
            const candidate = cache[i];
            if (!current.glossary.equals(candidate.glossary)) { continue; }
            anyGlossary ??= candidate;
            if (!hasPrefixSignature(current, candidate, definitionSignature, rulesSignature)) { continue; }
            prefixGlossary ??= candidate;
            if (sameContent(current, candidate, true)) { prefixContent ??= candidate; }
        }
        for (const [kind, match] of [['PrefixGlossary', prefixGlossary], ['PrefixContent', prefixContent], ['AnyGlossary', anyGlossary]]) {
            if (match) {
                counters[`oracleFailedBlocksLater${kind}`] = 1;
                counters[`oracleFailedBlocksLater${kind}Bytes`] = match.glossary.length;
            }
        }
    }
    for (const stats of contexts) {
        addSelectorCell(stats, counters, maxima);
        addSelectorCell(stats.byKeyKind[keyKind] ??= makeSelectorCell(), counters, maxima);
        if (selectedDistance !== null) {
            addSelectorCell(stats.bySelectedDistance[selectedDistance] ??= makeSelectorCell(), counters, maxima);
            addSelectorCell(stats.bySelectedLength[lengthClass] ??= makeSelectorCell(), counters, maxima);
        }
        ++stats.oraclePrefixCandidateCount[prefixCandidates.length];
    }
}
function observe(bytes, current, prior, priorStreak) {
    const category = prior.sequenceClass;
    update('eligible', 1, category);
    const n = prior.glossary.length;
    const spanLength = prior.sequenceSpan.length;
    report.maxima.sequenceSpanBytes = Math.max(report.maxima.sequenceSpanBytes, spanLength);
    report.maxima.eligibleGlossaryBytes = Math.max(report.maxima.eligibleGlossaryBytes, n);
    // The actual current glossary length and sequence are deliberately absent
    // from admission. Only the already-known start and source-bank end bound it.
    if (current.glossaryStart > bytes.length || n > bytes.length - current.glossaryStart ||
        spanLength > bytes.length - current.glossaryStart - n) {
        update('boundsRejects', 1, category);
        return;
    }
    const predictedEnd = current.glossaryStart + n;
    update('spanBytesOffered', spanLength, category);
    for (let i = 0; i < spanLength; ++i) {
        update('spanLogicalBytesCompared', 1, category);
        if (bytes[predictedEnd + i] !== prior.sequenceSpan[i]) { update('spanRejects', 1, category); return; }
    }
    update('spanPasses', 1, category);
    update('passedSpanBytes', spanLength, category);
    update('glossaryCandidateBytesOffered', n, category);
    const sample = Math.min(n, 8);
    const candidate = bytes.subarray(current.glossaryStart, predictedEnd);
    if (!candidate.subarray(n - sample).equals(prior.glossary.subarray(n - sample))) { update('glossaryTailRejects', 1, category); return; }
    const middle = Math.floor((n - sample) / 2);
    if (!candidate.subarray(middle, middle + sample).equals(prior.glossary.subarray(middle, middle + sample))) { update('glossaryMiddleRejects', 1, category); return; }
    update('fullEqualityBytesOffered', n, category);
    if (!candidate.equals(prior.glossary)) { update('glossaryFullRejects', 1, category); return; }
    // Baseline strict parsing remains authoritative for every counted proof.
    assert.equal(current.glossary.length, n, 'Predicted glossary extent differs from native metadata');
    assert(current.glossary.equals(prior.glossary));
    assert.deepEqual(current.hints, prior.hints, 'Equal glossary produced unequal native hints');
    update('fullEqualityHits', 1, category);
    update('glossaryValidationBytesReusable', n, category);
    update(priorStreak === 0 ? 'hitsAfterZeroPriorStreak' : 'hitsAfterNonzeroPriorStreak', 1, category);
    if (sameContent(current, prior, true)) { update('hitsWithExactFullContent', 1, category); }
    if (current.bank !== prior.bank) { update('crossBankHits', 1, category); }
    report.hitGlossaryLengthHistogram[n] = (report.hitGlossaryLengthHistogram[n] ?? 0) + 1;
}

try {
    const archiveHash = createHash('sha256');
    for await (const bytes of createReadStream(archivePath)) { archiveHash.update(bytes); }
    report.archiveSha256 = archiveHash.digest('hex');
    assert.equal(report.archiveSha256, fixture.sha256);
    const archive = await openAsBlob(archivePath);
    const reader = new ZipReader(new BlobReader(archive));
    let entries;
    try { entries = await reader.getEntries(); } finally { await reader.close(); }
    const banks = entries.filter((entry) => /^term_bank_\d+\.json$/.test(entry.filename))
        .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)));
    entries = null;
    const payloads = new RawZipPayloadReader(archive);
    const metadataHash = createHash('sha256');
    let state;
    for (let bankIndex = 0; bankIndex < banks.length; ++bankIndex) {
        const entry = banks[bankIndex];
        if (bankIndex % 7 === 0) {
            groupStats = {group: Math.floor(bankIndex / 7), ...makeStats()};
            report.groups.push(groupStats);
            state = {budget: 0, streak: 0, cache: [], rows: 0, lastRawHit: false};
        }
        bankStats = {name: entry.filename, group: groupStats.group, ...makeStats()};
        report.banks.push(bankStats);
        currentLocation = {bank: entry.filename};
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
        assert(rows >= 0, 'Unchanged native strict parser rejected a locked bank');
        const metas = new Uint32Array(native.memory.buffer, metadataPointer, rows * 17);
        const metadataBytes = Buffer.from(metas.buffer, metas.byteOffset, metas.byteLength);
        bankStats.metadataSha256 = sha(metadataBytes);
        metadataHash.update(entry.filename);
        metadataHash.update(metadataBytes);
        report.maxima.wasmHeapBytes = Math.max(report.maxima.wasmHeapBytes, native.memory.buffer.byteLength);
        for (let row = 0; row < rows; ++row) {
            const offset = row * 17;
            currentLocation = {bank: entry.filename, row, groupRow: state.rows};
            const field = (index) => bytes.subarray(metas[offset + index], metas[offset + index] + metas[offset + index + 1]);
            const glossaryStart = metas[offset + 9];
            const glossaryEnd = glossaryStart + metas[offset + 10];
            const termTagsStart = metas[offset + 12];
            const sequenceNull = metas[offset + 11] === 0xffffffff;
            const sequenceToken = sequenceNull ? 'null' : scalarBeforeComma(bytes, metas[offset + 11], termTagsStart);
            const sequence = JSON.parse(sequenceToken);
            const scoreToken = scalarBeforeComma(bytes, metas[offset + 8], glossaryStart);
            const score = JSON.parse(scoreToken);
            // Fixed-group baseline receipts have zero fused fallbacks. Verify
            // the numeric precondition rather than silently shadowing a fallback.
            assert(/^-?(0|[1-9]\d*)$/.test(scoreToken) && Number.isSafeInteger(score) && score >= -2147483648 && score <= 2147483647 && !Object.is(score, -0));
            assert(sequenceNull || (/^-?(0|[1-9]\d*)$/.test(sequenceToken) && Number.isSafeInteger(sequence) && sequence >= -2147483648 && sequence <= 2147483647));
            const current = {bank: entry.filename, groupRow: state.rows, score, scoreToken, sequenceToken, expression: field(0), reading: field(2), glossaryStart, glossary: field(9), definitionTags: field(4), rules: field(6), termTags: field(12),
                sequenceSpan: bytes.subarray(glossaryEnd, termTagsStart), sequenceClass: sequenceNull ? 'null' : sequence < 0 ? 'negative' : 'nonnegative',
                hints: [metas[offset + 14], metas[offset + 15], metas[offset + 16]]};
            assert(current.sequenceSpan.length >= 3);
            update('rows');
            if (state.streak > 0) { update('priorStreakRows'); }
            const prior = state.cache.at(-1);
            let lookback = 0;
            if (prior) { lookback = state.budget > 0 ? 4 : prior.glossary.length >= 512 ? 1 : 0; }
            else { update('firstRows'); }
            if (prior) {
                update(lookback === 0 ? 'existingLookbackZero' : 'existingLookbackPositive');
                if (lookback === 0) { observe(bytes, current, prior, state.streak); bucketZeroLookback(bytes, current, prior); observeSelector(bytes, current, state.cache, state.streak); }
            }
            let witness = null;
            for (let i = state.cache.length - 1; i >= Math.max(0, state.cache.length - lookback); --i) {
                if (current.glossary.equals(state.cache[i].glossary)) { witness = state.cache[i]; break; }
            }
            if (witness) { update('existingGlossaryReuses'); state.budget = 4; }
            else if (state.budget > 0) { --state.budget; }
            let recentMatch = witness && sameContent(current, witness, true) ? witness : null;
            if (!recentMatch) {
                for (let i = state.cache.length - 1; i >= 0; --i) {
                    if (sameContent(current, state.cache[i])) { recentMatch = state.cache[i]; break; }
                }
            }
            bucketExistingState(current, prior, witness, recentMatch, lookback);
            state.lastRawHit = recentMatch !== null;
            if (recentMatch) {
                update('recentRawContentHits');
                if (state.streak >= 4 || ++state.streak >= 4) { state.budget = 4; }
            } else { state.streak = 0; }
            state.cache.push(copyTuple(current));
            if (state.cache.length > 4) { state.cache.shift(); }
            assert(state.cache.length <= 4);
            report.maxima.retainedTupleBytes = Math.max(report.maxima.retainedTupleBytes,
                state.cache.reduce((sum, item) => sum + item.expression.length + item.reading.length + item.glossary.length + item.sequenceSpan.length + item.definitionTags.length + item.rules.length + item.termTags.length, 0));
            ++state.rows;
        }
        if ((bankIndex + 1) % 7 === 0 || bankIndex + 1 === banks.length) {
            if (state.lastRawHit) { update('groupEndingRawHits'); }
            groupStats.finalBudget = state.budget;
            groupStats.finalStreak = state.streak;
        }
        await save();
    }
    report.metadataDigest = metadataHash.digest('hex');
    assert.equal(report.metadataDigest, 'd6965c13c73fbe3312802d1e4800b0acd8942f317b3ed065d7c8edd25c1c0809', 'Native metadata differs from independently audited hosted oracle');
    assert.equal(report.totals.rows, fixture.termRows);
    assert.equal(report.totals.existingGlossaryReuses, 54629, 'Baseline glossary-reuse replay mismatch');
    assert.equal(report.totals.priorStreakRows, 154409, 'Baseline previous-content-hit replay mismatch');
    assert.equal(report.totals.recentRawContentHits - report.totals.groupEndingRawHits, report.totals.priorStreakRows);
    assert.equal(report.totals.existingLookbackZero, report.totals.eligible);
    assert.equal(Object.values(report.totals.extension.missingWitnessFullContent).reduce((sum, cell) => sum + cell.rows, 0), report.totals.extension.existingWitnessIntersection.noWitnessRawHit?.rows ?? 0);
    assert.equal((report.totals.extension.existingWitnessIntersection.oldWitnessRawHit?.rows ?? 0) + (report.totals.extension.existingWitnessIntersection.noWitnessRawHit?.rows ?? 0), report.totals.recentRawContentHits);
    assert.equal(report.totals.eligible, report.totals.boundsRejects + report.totals.spanPasses + report.totals.spanRejects);
    assert.equal(report.totals.spanPasses, report.totals.glossaryTailRejects + report.totals.glossaryMiddleRejects + report.totals.glossaryFullRejects + report.totals.fullEqualityHits);
    const previous = JSON.parse(await readFile(new URL('./run-2/result.json', import.meta.url), 'utf8'));
    assert(previous.complete && previous.failures.length === 0);
    for (const key of ['node', 'wasmSha256', 'fixtureLockSha256', 'baselineCSourceSha256', 'archiveSha256', 'metadataDigest', 'constants', 'limits', 'maxima', 'hitGlossaryLengthHistogram']) {
        assert.deepEqual(report[key], previous[key], `Run-2 ${key} differs`);
    }
    const compareLegacyStats = (current, old) => {
        for (const [key, value] of Object.entries(old)) { assert.deepEqual(current[key], value, `Run-2 legacy ${key} differs`); }
    };
    compareLegacyStats(report.totals, previous.totals);
    assert.equal(report.banks.length, previous.banks.length);
    assert.equal(report.groups.length, previous.groups.length);
    for (const collection of ['banks', 'groups']) {
        for (let i = 0; i < report[collection].length; ++i) { compareLegacyStats(report[collection][i], previous[collection][i]); }
    }
    for (const stats of [report.totals, ...report.banks, ...report.groups]) {
        const {counters: c, oraclePrefixCandidateCount: histogram} = stats.selector;
        assert.equal(c.zeroLookbackRows, stats.existingLookbackZero);
        assert.equal(c.admissions, stats.extension.keyAtZeroLookback.existingComparisons?.rows ?? 0);
        assert.equal(c.zeroLookbackRows, c.keyRejected + c.admissions);
        assert.equal(c.admissions, c.noPrefixCandidate + c.selected);
        assert.equal(c.candidateRecordsInspected, c.definitionLengthRejected + c.rulesLengthRejected + c.definitionSignatureRejected + c.rulesSignatureRejected + c.selected);
        assert.equal(c.selected, c.boundsRejected + c.openerRejected + c.tailRejected + c.middleRejected + c.fullRejected + c.hits);
        assert.equal(c.selected, c.selectedExactPrefix + c.selectedSignatureCollision);
        assert.equal(c.fullBytesOffered, c.hitBytes + c.failedFullBytesOffered);
        assert.equal(c.fullLogicalBytesCompared, c.hitBytes + c.failedFullLogicalBytesCompared);
        assert.equal(Object.values(histogram).reduce((sum, n) => sum + n, 0), c.admissions);
        assert.equal(histogram[0], c.noPrefixCandidate);
        assert.equal(Object.entries(histogram).reduce((sum, [n, rows]) => sum + Number(n) * rows, 0), c.oraclePrefixCandidates);
        assert.equal(histogram[2] + histogram[3] + histogram[4], c.oracleAmbiguousPrefixRows);
        assert.equal(Object.values(stats.selector.byKeyKind).reduce((sum, cell) => sum + cell.counters.admissions, 0), c.admissions);
        for (const collection of ['bySelectedDistance', 'bySelectedLength']) {
            assert.equal(Object.values(stats.selector[collection]).reduce((sum, cell) => sum + cell.counters.selected, 0), c.selected);
        }
    }
    report.legacyRun2Reconciled = true;
    const parentResultBytes = await readFile(new URL('./run-3/result.json', import.meta.url));
    assert.equal(sha(parentResultBytes), report.parentResultSha256);
    const parentResult = JSON.parse(parentResultBytes);
    assert(parentResult.complete && parentResult.failures.length === 0);
    for (const key of ['node', 'wasmSha256', 'fixtureLockSha256', 'baselineCSourceSha256', 'archiveSha256',
        'metadataDigest', 'constants', 'limits', 'maxima', 'hitGlossaryLengthHistogram', 'selectorProtocol', 'legacyRun2Reconciled']) {
        assert.deepEqual(report[key], parentResult[key], `Run-3 ${key} differs`);
    }
    compareLegacyStats(report.totals, parentResult.totals);
    for (const collection of ['banks', 'groups']) {
        assert.equal(report[collection].length, parentResult[collection].length);
        for (let i = 0; i < report[collection].length; ++i) {
            compareLegacyStats(report[collection][i], parentResult[collection][i]);
        }
    }
    const checkCells = (original, zero, positive) => {
        for (const name of selectorCounterNames) {
            assert.equal(original.counters[name], (zero?.counters[name] ?? 0) + (positive?.counters[name] ?? 0), name);
        }
        for (const name of Object.keys(selectorEmptyMaxima())) {
            assert.equal(original.maxima[name], Math.max(zero?.maxima[name] ?? 0, positive?.maxima[name] ?? 0), name);
        }
    };
    for (const stats of [report.totals, ...report.banks, ...report.groups]) {
        const {zero, positive} = stats.priorStreakSelector;
        checkCells(stats.selector, zero, positive);
        for (const partition of [zero, positive]) {
            const c = partition.counters;
            assert.equal(c.zeroLookbackRows, c.keyRejected + c.admissions);
            assert.equal(c.admissions, c.noPrefixCandidate + c.selected);
            assert.equal(c.selected, c.boundsRejected + c.openerRejected + c.tailRejected + c.middleRejected + c.fullRejected + c.hits);
            assert.equal(c.fullBytesOffered, c.hitBytes + c.failedFullBytesOffered);
            assert.equal(c.fullLogicalBytesCompared, c.hitBytes + c.failedFullLogicalBytesCompared);
        }
        for (const key of Object.keys(stats.selector.oraclePrefixCandidateCount)) {
            assert.equal(stats.selector.oraclePrefixCandidateCount[key], zero.oraclePrefixCandidateCount[key] + positive.oraclePrefixCandidateCount[key]);
        }
        for (const collection of ['byKeyKind', 'bySelectedDistance', 'bySelectedLength']) {
            assert.deepEqual([...new Set([...Object.keys(zero[collection]), ...Object.keys(positive[collection])])].sort(), Object.keys(stats.selector[collection]).sort());
            for (const key of Object.keys(stats.selector[collection])) {
                checkCells(stats.selector[collection][key], zero[collection][key], positive[collection][key]);
            }
        }
    }
    report.legacyRun3Reconciled = true;
    report.complete = true;
} catch (error) {
    report.failures.push({...currentLocation, message: String(error), stack: error.stack});
    throw error;
} finally {
    report.maxRssKiB = process.resourceUsage().maxRSS;
    await save();
    console.log(JSON.stringify({complete: report.complete, priorStreakPositive: report.totals.priorStreakSelector.positive.counters,
        originalSelectorHits: report.totals.selector.counters.hits, originalSelectorHitBytes: report.totals.selector.counters.hitBytes,
        metadataDigest: report.metadataDigest, legacyRun3Reconciled: report.legacyRun3Reconciled,
        maxRssKiB: report.maxRssKiB, failures: report.failures}));
}
