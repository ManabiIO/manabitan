import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdir, readFile, realpath, writeFile, open} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {getHostEnvironment} from '../host-environment.js';

const root = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'));
const browser = process.env.MIDCORE_BROWSER;
const dictionary = process.env.MIDCORE_DICTIONARY;
const mode = process.env.MIDCORE_MODE;
const evidence = await realpath(process.env.MIDCORE_EVIDENCE);
const adapter = await realpath(process.env.MIDCORE_ADAPTER);
const cohort = process.env.MIDCORE_COHORT ?? 'pilot';
assert.ok(['pilot', 'confirmation'].includes(cohort));
const contract = JSON.parse(await readFile(new URL(cohort === 'confirmation' ? 'confirmation-contract.json' : 'pilot-contract.json', import.meta.url), 'utf8'));
if (cohort === 'confirmation') { assert.equal(browser, 'chromium', 'This confirmation contract currently covers Chromium only'); }
assert.ok(['chromium', 'firefox'].includes(browser));
assert.ok(['jmdict', 'jitendex'].includes(dictionary));
assert.ok(['timing', 'memory'].includes(mode));
assert.equal(Number(process.versions.node.split('.')[0]), 22);
const host = getHostEnvironment();
assert.equal(host.platform, 'linux');
assert.equal(host.logicalCpuCount, 4);
assert.ok(host.cgroupCpuQuotaCores === null || host.cgroupCpuQuotaCores >= 4, 'CPU quota is not representative');
assert.ok(host.totalMemoryBytes > 4 * 1024 ** 3);
assert.ok(host.cgroupMemoryMaxBytes === null || host.cgroupMemoryMaxBytes > 4 * 1024 ** 3);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const adapterSha = sha(await readFile(adapter));
const samplerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'process-tree-memory.mjs');
const samplerSha = sha(await readFile(samplerPath));
const warmup = mode === 'timing' ? contract.pilot.timing.warmup : [];
const schedule = [...warmup, ...contract.pilot[mode].schedule];
const observations = [];
let identity = null;
let complete = false;
await writeFile(path.join(evidence, 'contract.json'), JSON.stringify({contract, cohort, browser, dictionary, mode, host, adapterSha, samplerSha, schedule, sourceRoot: root}, null, 2) + '\n', {flag: 'wx'});
try {
    for (const [index, arm] of schedule.entries()) {
        const label = `${String(index).padStart(2, '0')}-${arm}`;
        const output = path.join(evidence, label);
        await mkdir(output);
        const before = getHostEnvironment();
        const log = await open(path.join(output, 'run.log'), 'wx');
        let exit;
        try {
            exit = await new Promise((resolve, reject) => {
                const child = spawn(process.execPath, [adapter], {cwd: root,
                    env: {...process.env, MIDCORE_ARM: arm, MIDCORE_OUTPUT: output, MIDCORE_SOURCE_ROOT: root},
                    stdio: ['ignore', log.fd, log.fd]});
                child.once('error', reject);
                child.once('close', (code, signal) => resolve({code, signal}));
            });
        } finally { await log.close(); }
        const after = getHostEnvironment();
        await writeFile(path.join(output, 'host-and-exit.json'), JSON.stringify({before, after, exit}, null, 2) + '\n', {flag: 'wx'});
        assert.equal(exit.code, 0, label);
        assert.equal(exit.signal, null, label);
        const result = JSON.parse(await readFile(path.join(output, 'observation.json'), 'utf8'));
        assert.equal(result.status, 'success', label);
        assert.equal(result.skippedVerification, false);
        assert.equal(result.browser, browser);
        assert.equal(result.dictionary, dictionary);
        assert.equal(result.mode, mode);
        assert.equal(result.arm, arm);
        assert.equal(result.authoritativeTiming, mode === 'timing');
        const currentIdentity = {packageSha256: result.packageIdentity.packageSha256, nativeSha256: result.packageIdentity.nativeSha256,
            browserVersion: result.browserVersion};
        assert.match(currentIdentity.packageSha256, /^[0-9a-f]{64}$/);
        assert.match(currentIdentity.nativeSha256, /^[0-9a-f]{64}$/);
        assert.ok(currentIdentity.browserVersion);
        if (identity === null) { identity = currentIdentity; }
        else { assert.deepEqual(currentIdentity, identity, 'Package/native/browser changed inside cohort'); }
        const caps = result.environment.browser;
        assert.ok(Number.isInteger(caps.hardwareConcurrency) && caps.hardwareConcurrency >= 4 && caps.hardwareConcurrency <= 7);
        assert.ok(caps.deviceMemory === null || caps.deviceMemory > 4);
        const timing = result.timing.browser;
        assert.ok(timing.completedAtMs > timing.startedAtMs);
        assert.ok(Number.isSafeInteger(timing.sequence) && timing.sequence > timing.sequenceBefore);
        assert.equal(timing.errorCount, 0);
        assert.equal(timing.trigger, 'file-input-change');
        assert.ok(result.validation.contentReadable && result.validation.probeCount >= 12);
        if (mode === 'memory') {
            for (const window of [result.memory?.result, result.memory?.postCompletion?.result]) {
                assert.ok(window && window.summary.completeRssSampleCount >= 2, 'Insufficient complete RSS process-tree samples');
                assert.ok(window.summary.completePssSampleCount >= 2, 'Insufficient complete PSS process-tree samples');
                assert.ok(window.summary.maxObservedProcessCount >= 2, 'Browser descendants were not sampled');
                assert.equal(window.summary.rootExitObserved, false, 'Browser exited during the memory window');
                assert.deepEqual(window.summary.errors, [], 'Memory sampler errors');
            }
        } else { assert.equal(result.memory, null); }
        observations.push({label, excluded: index < warmup.length, arm,
            totalImportMs: result.timing.totalImportMs, workerImportMs: result.timing.workerImportMs,
            validation: result.validation, environment: result.environment, memory: result.memory,
            metrics: result.importDebug.importerPhaseTimings.find((phase) => typeof phase.details?.dedupUniqueCount === 'number').details,
            before, after, identity: currentIdentity});
        await writeFile(path.join(evidence, 'observations.json'), JSON.stringify(observations, null, 2) + '\n');
        console.log(JSON.stringify({browser, dictionary, mode, index, arm, excluded: index < warmup.length,
            totalImportMs: result.timing.totalImportMs, workerImportMs: result.timing.workerImportMs}));
    }
    assert.equal(sha(await readFile(adapter)), adapterSha);
    assert.equal(sha(await readFile(samplerPath)), samplerSha);
    if (cohort === 'confirmation') {
        const retained = observations.filter((row) => !row.excluded);
        const pairs = [];
        for (let index = 0; index < retained.length; index += 2) {
            const [first, second] = retained.slice(index, index + 2);
            assert.ok(first && second);
            const control = first.arm === second.arm;
            const a = control || first.arm === 'A' ? first : second;
            const b = a === first ? second : first;
            pairs.push({control, a, b});
        }
        const candidates = pairs.filter((pair) => !pair.control);
        const controls = pairs.filter((pair) => pair.control);
        const gates = [];
        if (mode === 'memory') {
            const ceiling = contract.confirmationGates.memory;
            for (const [index, pair] of candidates.entries()) {
                for (const window of ['result', 'postCompletion']) {
                    const summary = (row) => window === 'result' ? row.memory.result.summary : row.memory.postCompletion.result.summary;
                    for (const [metric, absolute, percent] of [
                        ['peakSampledAggregatePssBytes', 'maxPssIncreaseBytes', 'maxPssIncreasePercent'],
                        ['peakSampledAggregateRssBytes', 'maxRssIncreaseBytes', 'maxRssIncreasePercent'],
                    ]) {
                        const a = summary(pair.a)[metric];
                        const b = summary(pair.b)[metric];
                        const deltaBytes = b - a;
                        const deltaPercent = 100 * (b / a - 1);
                        gates.push({pair: index, window, metric, deltaBytes, deltaPercent,
                            passed: deltaBytes <= ceiling[absolute] && deltaPercent <= ceiling[percent]});
                    }
                }
            }
        } else {
            const deltas = candidates.map(({a, b}) => 100 * (b.totalImportMs / a.totalImportMs - 1)).sort((a, b) => a - b);
            assert.equal(deltas.length, 4);
            const median = (deltas[1] + deltas[2]) / 2;
            const controlsAbsolute = controls.map(({a, b}) => Math.abs(100 * (b.totalImportMs / a.totalImportMs - 1)));
            const maximumControl = Math.max(...controlsAbsolute);
            const ceiling = contract.confirmationGates.timing;
            gates.push({metric: 'visible import', pairedDeltas: deltas, medianPercent: median, controlsAbsolute, maximumControl,
                fasterPairs: deltas.filter((delta) => delta < 0).length,
                passed: deltas.filter((delta) => delta < 0).length >= ceiling.minimumFasterPairs &&
                    median <= -ceiling.minimumMedianVisibleReductionPercent && -median > maximumControl});
        }
        await writeFile(path.join(evidence, 'confirmation-gates.json'), JSON.stringify({passed: gates.every((gate) => gate.passed), gates,
            interpretation: 'Qualification for the next product correctness/lifecycle stage only; no default change or Hoshi target claim.'}, null, 2) + '\n', {flag: 'wx'});
    }
    complete = true;
} finally {
    await writeFile(path.join(evidence, 'cohort-exit.json'), JSON.stringify({complete, observationCount: observations.length, schedule, identity}, null, 2) + '\n', {flag: 'wx'});
}
