import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {evaluateFifoCohort} from './gate-evaluator.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = (name) => readFileSync('artifact-metadata/' + name);
const expected = {
    'component.mjs': 'd807572f19125d79121be2bb4d355e5fe108cc6fbc2048b533d9ab8445ef1407',
    'plan.json': '164b283162ba8e73fada533ea8733279582bbb0e5b17bbc56985773479c6951f',
    'dispatcher-tests.mjs': '9421c5e1501f8f6c4f6bac93d0b93420a95f1191af5d805921d8d9c89425038f',
    'run.py': 'd98524bcfb1cbaa7b76287ea9f78de248306d904c925276f6566a2dc0d5ea01c',
};
for (const [name, hash] of Object.entries(expected)) {
    assert.equal(sha(read(name)), hash, name);
}
const evaluatorSha = sha(readFileSync('gate-evaluator.mjs'));
assert.equal(evaluatorSha, 'ad7b8d250d212d7f889209d1bf3ca678510ffabe5286a1883fb79f15bd73a053');
const report = JSON.parse(read('observations.json'));
const setup = JSON.parse(read('setup.json'));
const plan = JSON.parse(read('plan.json'));
const config = JSON.parse(read('component-config.json'));
assert.equal(setup.workflowSha, '81d35bc83af349b611f9ad51cc223de788a2d0d6');
assert.equal(setup.runId, '46113052837');
assert.equal(setup.runAttempt, '1');
assert.equal(setup.captureCommit, '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2');
assert.equal(report.sourceCaptureCommit, setup.captureCommit);
assert.deepEqual(report.plan, plan);
assert.equal(report.configSha256, sha(read('component-config.json')));
assert.equal(config.scriptSha256, expected['component.mjs']);
assert.equal(config.planSha256, expected['plan.json']);
assert.deepEqual(report.runtimeSourceHashes, setup.preTimingInputProof.runtimeSourceHashes);
assert.equal(setup.preTimingInputProof.manifestSha256, sha(read('regenerated-manifest-db-1m.json')));
assert.equal(setup.preTimingInputProof.referenceManifestSha256, sha(read('reference-manifest-db-1m.json')));
assert(setup.phases.every((phase) => phase.returnCode === 0 && phase.shellEquivalentExitCode === 0));
const result = evaluateFifoCohort(report, setup, expected['plan.json']);
const receipt = {
    analysisNode: process.version,
    analysisSourceSha256: sha(readFileSync(new URL(import.meta.url))),
    sourceHashes: expected,
    evaluatorSha,
    artifactVerification: JSON.parse(readFileSync('artifact-verification.json')),
    observationSha: sha(read('observations.json')),
    setupSha: sha(read('setup.json')),
    fullSourceAndSemanticGateEvaluated: true,
    compressionWorkersFinalState: report.compressionWorkersFinalState,
    warmups: report.warmups.length,
    observations: report.observations.length,
    ownershipChecks: report.sourceOwnershipChecks.length,
    decodeChecks: report.exhaustiveDecodeVerification.length,
    failures: report.failures,
    result,
};
writeFileSync('full-fixed-gate-result.json', JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({
    fullSourceAndSemanticGateEvaluated: true,
    advance: result.advance,
    terminal: receipt.compressionWorkersFinalState,
    counts: [receipt.warmups, receipt.observations, receipt.ownershipChecks, receipt.decodeChecks],
    comparisons: Object.fromEntries(Object.entries(result.comparisons).map(([name, value]) => [name, {
        medianSavingMs: value.pairedMedianSavingMs,
        medianSavingPercent: value.pairedMedianSavingPercent,
        fasterPairs: value.fasterPairs,
        equalWorkChangePercent: value.equalWorkChangePercent,
        msInterval: value.pairedMedianDifferenceMs95,
        percentInterval: value.pairedMedianDifferencePercent95,
        checks: value.checks,
    }])),
    control: result.control,
    bootstrap: result.bootstrap,
    observationSha: receipt.observationSha,
}));
