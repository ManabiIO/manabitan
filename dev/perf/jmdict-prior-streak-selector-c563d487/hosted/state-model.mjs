/* Untimed, independent finite-state fixture oracle; no native module or timers. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {rowSpec, rowsPerBank, rowsPerCase, caseNames, validateGeometry} from './fixture-model.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const fields = JSON.parse(await readFile(new URL('./diagnostic-fields.json', import.meta.url)));
const expected = JSON.parse(await readFile(new URL('./expected-counts.json', import.meta.url)));
assert.equal(fields.length, 48);
const contentEqual = (a, b) => [2, 3, 5, 7].every((index) => a.tokens[index] === b.tokens[index]);

function bankSizes(caseId) {
    const lengths = [1, 1];
    for (let index = 0; index < rowsPerCase; ++index) {
        const row = rowSpec(caseId, index);
        // Each row has exactly one following delimiter: ',' or the bank ']'.
        lengths[row.bank] += row.text.length + 1;
    }
    return lengths;
}

function forwardSpan(caseId, current, offset, length) {
    let index = current.index;
    let remainingOffset = current.glossaryOffset + offset;
    let result = '';
    const end = (current.bank + 1) * rowsPerBank;
    while (index < end && result.length < length) {
        const value = (index === current.index ? current : rowSpec(caseId, index)).text + (index + 1 === end ? ']' : ',');
        if (remainingOffset < value.length) {
            result += value.slice(remainingOffset, remainingOffset + length - result.length);
            remainingOffset = 0;
        } else {
            remainingOffset -= value.length;
        }
        ++index;
    }
    assert.equal(result.length, length, 'A logical-bank bound must precede every source read');
    return result;
}

function prove(caseId, current, prior, available, counters = null) {
    const length = prior.glossary.length;
    const reject = (field) => { if (counters) { ++counters[field]; } return false; };
    if (length === 0 || length > available) { return reject('boundsRejected'); }
    if (!['[', '{'].includes(current.glossary[0]) || current.glossary[0] !== prior.glossary[0]) { return reject('openerRejected'); }
    const sample = Math.min(length, 8);
    if (forwardSpan(caseId, current, length - sample, sample) !== prior.glossary.slice(length - sample)) { return reject('tailRejected'); }
    const middle = Math.floor((length - sample) / 2);
    if (forwardSpan(caseId, current, middle, sample) !== prior.glossary.slice(middle, middle + sample)) { return reject('middleRejected'); }
    if (counters) { counters.fullBytesOffered += length; }
    if (forwardSpan(caseId, current, 0, length) !== prior.glossary) {
        if (counters) {
            counters.failedFullBytesOffered += length;
            counters.maxFailedFullBytes = Math.max(counters.maxFailedFullBytes, length);
        }
        return reject('fullRejected');
    }
    if (counters) { ++counters.hits; counters.hitBytes += length; }
    // Current extent is a post-proof oracle, never an admission or selection input.
    assert.equal(current.glossary.length, length);
    return true;
}

function keyMatches(current, previous, counts) {
    ++counts.keyPredicateRows;
    const compare = (a, b) => {
        ++counts.keyComparisonCalls;
        counts.keyComparisonBytesOffered += a.length - 2;
        counts.maxKeyComparisonBytes = Math.max(counts.maxKeyComparisonBytes, a.length - 2);
        return a.slice(1, -1) === b.slice(1, -1);
    };
    const expression = current.tokens[0];
    if (expression.length >= 2 && expression.length <= 34 && expression.length === previous.tokens[0].length && compare(expression, previous.tokens[0])) {
        ++counts.expressionMatches;
        return true;
    }
    const reading = current.tokens[1];
    if (reading.length <= 2 || reading.length > 34 || reading.length !== previous.tokens[1].length) {
        ++counts.readingIneligibleRows;
        return false;
    }
    if (reading.length === expression.length && compare(reading, expression)) {
        ++counts.readingAliasRejected;
        return false;
    }
    const match = compare(reading, previous.tokens[1]);
    if (match) { ++counts.readingMatches; }
    return match;
}

export function modelCase(caseId) {
    const counts = Object.fromEntries(fields.map((field) => [field, 0]));
    const sizes = bankSizes(caseId);
    const recent = [];
    const globalContentHashes = new Set();
    const shadow = {selectedCrossBank: 0, recentCrossBank: 0, firstSelectedFailureBlockingLaterTrueGlossary: 0,
        firstSelectedFailureBlockingLaterTrueContent: 0, maxRecentStreak: 0, maxProbeBudget: 0, traces: []};
    let budget = 0;
    let streak = 0;
    let rowStart = 1;
    for (let index = 0; index < rowsPerCase; ++index) {
        const row = rowSpec(caseId, index);
        if (index % rowsPerBank === 0) { rowStart = 1; }
        const available = sizes[row.bank] - rowStart - row.glossaryOffset;
        const lookback = recent.length === 0 ? 0 : budget > 0 ? 4 : recent.at(-1).glossary.length >= 512 ? 1 : 0;
        if (streak > 0) { ++counts.priorStreakRows; }
        if (budget > 0) { ++counts.budgetPositiveRows; }
        if (recent.length > 0) {
            ++counts[lookback === 0 ? 'originalLookbackZeroRows' : 'originalLookbackPositiveRows'];
            if (lookback === 0 && streak > 0) { ++counts.priorStreakLookbackZeroRows; }
        }
        let witness = null;
        let selectorDistance = 0;
        let proof = null;
        const priorStreak = streak;
        if (lookback > 0) {
            for (let distance = 1; distance <= Math.min(lookback, recent.length); ++distance) {
                const prior = recent.at(-distance);
                if (prove(caseId, row, prior, available)) { witness = prior; ++counts.originalGlossaryReuses; break; }
            }
        } else if (recent.length > 0 && streak > 0 && keyMatches(row, recent.at(-1), counts)) {
            ++counts.admissions;
            for (let distance = 1; distance <= recent.length; ++distance) {
                const prior = recent.at(-distance);
                ++counts.candidateRecordsInspected;
                if (row.tokens[2].length !== prior.tokens[2].length) { ++counts.definitionLengthRejected; continue; }
                if (row.tokens[3].length !== prior.tokens[3].length) { ++counts.rulesLengthRejected; continue; }
                if (row.tokens[2].slice(0, 4) !== prior.tokens[2].slice(0, 4)) { ++counts.definitionSignatureRejected; continue; }
                if (row.tokens[3].slice(0, 4) !== prior.tokens[3].slice(0, 4)) { ++counts.rulesSignatureRejected; continue; }
                selectorDistance = distance;
                ++counts.selected;
                ++counts[`selectedDistance${distance}`];
                counts.selectedBytes += prior.glossary.length;
                counts.maxSelectedBytes = Math.max(counts.maxSelectedBytes, prior.glossary.length);
                if (prior.glossary.length >= 512) { ++counts.selectedAtLeast512; counts.selectedAtLeast512Bytes += prior.glossary.length; }
                if (prior.bank !== row.bank) { ++shadow.selectedCrossBank; }
                proof = prove(caseId, row, prior, available, counts);
                if (proof) { witness = prior; ++counts[`hitDistance${distance}`]; }
                if (!proof) {
                    // Shadow checks never retry proof, redirect selection, or change budget/streak.
                    if (recent.slice(0, recent.length - distance).some((older) => row.glossary === older.glossary)) { ++shadow.firstSelectedFailureBlockingLaterTrueGlossary; }
                    if (recent.slice(0, recent.length - distance).some((older) => contentEqual(row, older))) { ++shadow.firstSelectedFailureBlockingLaterTrueContent; }
                }
                break;
            }
            if (selectorDistance === 0) { ++counts.noPrefixCandidate; }
        }
        if (witness !== null) { ++counts.totalGlossaryReuses; }
        if (witness !== null && lookback > 0) { budget = 4; }
        else if (budget > 0) { --budget; }
        let contentDistance = 0;
        for (let distance = 1; distance <= recent.length; ++distance) {
            if (contentEqual(row, recent.at(-distance))) { contentDistance = distance; break; }
        }
        if (contentDistance > 0) {
            ++counts.recentContentHits;
            if (recent.at(-contentDistance).bank !== row.bank) { ++shadow.recentCrossBank; }
            if (streak >= 4 || ++streak >= 4) { budget = 4; ++counts.budgetRefreshByRecentStreak; }
        } else { streak = 0; }
        shadow.maxRecentStreak = Math.max(shadow.maxRecentStreak, streak);
        shadow.maxProbeBudget = Math.max(shadow.maxProbeBudget, budget);
        globalContentHashes.add(sha([2, 3, 5, 7].map((field) => row.tokens[field]).join('\0')));
        if (index < 12 || Math.abs(index - rowsPerBank) <= 5 || index >= rowsPerCase - 6) {
            shadow.traces.push({index, bank: row.bank, block: row.block, phase: row.phase, glossaryBytes: row.glossary.length,
                priorStreak, lookback, selectorDistance, proof, contentDistance, nextStreak: streak, nextBudget: budget});
        }
        recent.push(row);
        if (recent.length > 4) { recent.shift(); }
        rowStart += row.text.length + 1;
        ++counts.rows;
    }
    const result = {caseId, name: caseNames[caseId - 1], counts, uniqueCount: globalContentHashes.size, bankBytes: sizes, shadow};
    const target = expected.cases.find(({id}) => id === caseId);
    assert.deepEqual(counts, target.expectedMechanics, `All48 model counters must match independently derived case${caseId} expectations`);
    assert.equal(result.uniqueCount, target.expectedUniqueCount);
    for (const [key, value] of Object.entries(target.expectedShadow)) { assert.equal(shadow[key], value, `Case${caseId} shadow ${key}`); }
    return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    assert(process.argv[2], 'Expected a NEW model receipt path; native execution and timing are not part of this model');
    validateGeometry();
    const report = {schema: 1, scope: 'Excluded independent finite-state synthetic-input oracle; no native module, timings, or speed conclusion',
        sourceSha256: sha(await readFile(fileURLToPath(import.meta.url))), fixtureModelSha256: sha(await readFile(new URL('./fixture-model.mjs', import.meta.url))),
        expectedCountsSha256: sha(await readFile(new URL('./expected-counts.json', import.meta.url))), cases: [], complete: false};
    try {
        for (let id = 1; id <= 6; ++id) { report.cases.push(modelCase(id)); }
        report.complete = true;
    } catch (error) {
        report.error = {message: String(error), stack: error.stack};
        throw error;
    } finally {
        await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
    }
}
