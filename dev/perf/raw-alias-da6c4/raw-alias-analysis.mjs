// SPDX-License-Identifier: GPL-3.0-or-later
// Pure prospectively fixed arithmetic; no timing or favorable-sample selection.
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

export function evaluateAliasCohort(observations, protocol, binding) {
    assert.equal(observations.length, 36);
    assert.equal(protocol.schedule.blocks, 12);
    assert.equal(protocol.schedule.componentWarmups, 0);
    assert.equal(protocol.advanceCriteria.medianDeltaMsAtMost, -10);
    assert.equal(protocol.advanceCriteria.medianDeltaPercentAtMost, -10);
    const logical = new Set(), inputs = new Set();
    const physical = {A: new Set(), B: new Set(), C: new Set()};
    const rows = protocol.schedule.permutations.map((order, block) => {
        const values = observations.slice(block * 3, block * 3 + 3);
        assert.equal(values.map(({arm}) => arm).join(''), order);
        const row = {block, order};
        for (let offset = 0; offset < values.length; ++offset) {
            const value = values[offset];
            assert(value.complete && value.failures.length === 0 && value.cleanupFailures.length === 0);
            assert.deepEqual(value.workerFailures, []);
            assert.equal(value.block, block); assert.equal(value.ordinal, block * 3 + offset);
            assert.equal(value.protocolSha256, binding.protocolSha256);
            assert.equal(value.protocolBlob, '83930b97ad2fc05697dbf83455229fe148962010');
            assert.deepEqual(value.researchBinding, binding.researchBinding);
            assert.equal(value.captureManifestSha256, binding.captureManifestSha256);
            assert.deepEqual(value.sourceHashes, binding.sourceHashes);
            assert.deepEqual(value.harnessHashes, binding.harnessHashes);
            assert.equal(value.baselineCommit, binding.baselineCommit);
            assert.equal(value.node, 'v22.22.0');
            assert.equal(value.inputWitnessBefore, value.inputWitnessAfter);
            assert.equal(value.verification.verifiedRows, 400000);
            assert(value.verification.lookupProbes > 0);
            assert.equal(value.recordFinalization.lookupIndexWorkerFileCount, 2);
            assert.equal(value.postFinalizationQuiescence.parentOpenResources, 0);
            assert.deepEqual(value.postFinalizationQuiescence.lockEntries, []);
            assert.deepEqual(value.postFinalizationQuiescence.stagingEntries, []);
            assert(Number.isFinite(value.elapsedMs) && value.elapsedMs > 0);
            assert.equal(value.elapsedMs, Number(BigInt(value.elapsedNs)) / 1e6);
            logical.add(value.verification.logicalSha256);
            inputs.add(value.inputWitnessBefore);
            physical[value.arm].add(value.verification.normalizedPhysicalSha256);
            row[value.arm] = value.elapsedMs;
        }
        return row;
    });
    assert.equal(logical.size, 1, 'Logical record/content outputs differ across arms');
    assert.equal(inputs.size, 1, 'Input ownership graph differs across fresh children');
    assert.equal(physical.A.size, 1); assert.equal(physical.C.size, 1); assert.equal(physical.B.size, 1);
    assert.equal([...physical.A][0], [...physical.C][0], 'Identical controls differ physically after only generation normalization');
    const first = Object.fromEntries(['A', 'B', 'C'].map((arm) => [arm, observations.find((value) => value.arm === arm)]));
    const dimensions = ['descriptorBytes', 'indexBytes', 'lookupPayloadBytes', 'affectedPayloadBytes', 'addedContentBytes'];
    const physicalSizes = Object.fromEntries(['A', 'B', 'C'].map((arm) => [arm, Object.fromEntries(dimensions.map((key) => [key, first[arm].verification[key]]))]));
    for (const value of observations) {
        for (const key of dimensions) { assert.equal(value.verification[key], physicalSizes[value.arm][key]); }
    }
    return {
        schemaVersion: 1, complete: true, protocolSha256: binding.protocolSha256,
        protocolBlob: binding.protocolBlob, researchBinding: binding.researchBinding,
        captureManifestSha256: binding.captureManifestSha256,
        sourceHashes: binding.sourceHashes, harnessHashes: binding.harnessHashes,
        inputWitnessSha256: [...inputs][0], logicalSha256: [...logical][0],
        physicalHashes: Object.fromEntries(['A', 'B', 'C'].map((arm) => [arm, [...physical[arm]][0]])),
        physicalSizes, physicalDeltaBMinusA: Object.fromEntries(dimensions.map((key) => [key, physicalSizes.B[key] - physicalSizes.A[key]])),
        ...evaluateAliasRows(rows),
    };
}

export function evaluateAliasRows(rows) {
    if (rows.length !== 12 || rows.some((row) => !['A', 'B', 'C'].every((key) => Number.isFinite(row[key]) && row[key] > 0))) {
        throw new Error('Exactly twelve finite positive paired rows are required');
    }
    const median = (values) => {
        const sorted = [...values].sort((a, b) => a - b);
        const middle = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    };
    const percentile = (sorted, probability) => {
        const index = (sorted.length - 1) * probability;
        const lower = Math.floor(index);
        const fraction = index - lower;
        return sorted[lower] + fraction * (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]);
    };
    const metrics = {};
    for (const control of ['A', 'C']) {
        metrics[control] = {
            differencesMs: rows.map((row) => row.B - row[control]),
            differencesPercent: rows.map((row) => (100 * (row.B - row[control])) / row[control]),
            bootstrapMs: [], bootstrapPercent: [],
        };
    }
    let state = 0x000da6c4;
    for (let sample = 0; sample < 20000; ++sample) {
        const indexes = [];
        for (let draw = 0; draw < 12; ++draw) {
            state ^= state << 13;
            state ^= state >>> 17;
            state ^= state << 5;
            state >>>= 0;
            indexes.push(Math.floor(state / 4294967296 * 12));
        }
        for (const metric of Object.values(metrics)) {
            metric.bootstrapMs.push(median(indexes.map((index) => metric.differencesMs[index])));
            metric.bootstrapPercent.push(median(indexes.map((index) => metric.differencesPercent[index])));
        }
    }
    const comparisons = {};
    for (const control of ['A', 'C']) {
        const metric = metrics[control];
        const candidateTotalMs = rows.reduce((sum, row) => sum + row.B, 0);
        const controlTotalMs = rows.reduce((sum, row) => sum + row[control], 0);
        const interval = (values) => {
            values.sort((a, b) => a - b);
            return [percentile(values, 0.025), percentile(values, 0.975)];
        };
        const savingMs = -median(metric.differencesMs);
        const savingPercent = -median(metric.differencesPercent);
        const ms95 = interval(metric.bootstrapMs);
        const percent95 = interval(metric.bootstrapPercent);
        const fasterPairs = rows.filter((row) => row.B < row[control]).length;
        const checks = {
            medianSavingMs: savingMs >= 10,
            medianSavingPercent: savingPercent >= 10,
            fasterPairs: fasterPairs >= 9,
            equalWork: candidateTotalMs < controlTotalMs,
            millisecondInterval: ms95[1] < 0,
            percentageInterval: percent95[1] < 0,
        };
        comparisons['B/' + control] = {
            differencesMs: metric.differencesMs,
            differencesPercent: metric.differencesPercent,
            pairedMedianSavingMs: savingMs, pairedMedianSavingPercent: savingPercent,
            fasterPairs, candidateTotalMs, controlTotalMs,
            equalWorkChangePercent: 100 * (candidateTotalMs / controlTotalMs - 1),
            pairedMedianDifferenceMs95: ms95, pairedMedianDifferencePercent95: percent95,
            checks, pass: Object.values(checks).every(Boolean),
        };
    }
    const controlDifferencesPercent = rows.map((row) => (100 * (row.C - row.A)) / row.A);
    const controlMedianPercent = median(controlDifferencesPercent);
    const maximumControlDriftPercent = 0.5 * Math.min(
        Math.abs(comparisons['B/A'].pairedMedianSavingPercent), Math.abs(comparisons['B/C'].pairedMedianSavingPercent),
    );
    const controlDriftPass = Math.abs(controlMedianPercent) < maximumControlDriftPercent;
    const advance = comparisons['B/A'].pass && comparisons['B/C'].pass && controlDriftPass;
    return {
        advance,
        outcome: advance ? 'advance-to-private-ownership-design-and-separate-browser-qualification' : 'inconclusive-or-reject',
        scope: 'Immutable completed-content-tail record sink component only; no whole-import or browser-memory claim.',
        rows, comparisons,
        control: {differencesPercent: controlDifferencesPercent, pairedMedianPercent: controlMedianPercent,
            maximumAbsolutePercentExclusive: maximumControlDriftPercent, pass: controlDriftPass},
        bootstrap: {samples: 20000, seedHex: '0x000da6c4', finalState: state,
            resamplingUnit: 'Twelve paired rounds with one shared index stream for all four metrics',
            interval: '95% percentile, type7'},
    };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const input = JSON.parse(await readFile(process.argv[2]));
    const result = evaluateAliasCohort(input.observations, input.protocol, input.binding);
    await writeFile(process.argv[3], JSON.stringify(result, null, 2) + '\n', {flag: 'wx'});
    console.log(JSON.stringify({advance: result.advance, outcome: result.outcome, comparisons: result.comparisons, control: result.control}));
}
