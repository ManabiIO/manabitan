// Prepared prospective component driver. The build workflow never invokes it.
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import path from 'node:path';
import {openArm} from './wasm-arm.mjs';

const artifactRoot = path.resolve(process.argv[2]);
const resultPath = path.resolve(process.argv[3]);
assert.equal(process.argv[4], '--frozen-screen', 'Explicit frozen-screen selection required');
assert.equal(typeof global.gc, 'function', 'Use --expose-gc');
const here = import.meta.dirname;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const buildBytes = await readFile(path.join(artifactRoot, 'manifest.json'));
const build = JSON.parse(buildBytes);
assert.equal(build.status, 'passed');
assert.equal(build.qualification.status, 'passed');
const corpusRoot = path.join(artifactRoot, 'corpus-jmdict');
const manifestBytes = await readFile(path.join(corpusRoot, 'expected-manifest.json'));
assert.equal(sha(manifestBytes), build.sourcePins.expectedCorpusManifestSha256);
const manifest = JSON.parse(manifestBytes);
const dictionary = await readFile(path.join(artifactRoot, 'inputs/jmdict.zdict'));
const dictionaryHash = sha(dictionary);
const schedule = [
    ['P', 'A', 'B', 'C'], ['A', 'B', 'C', 'P'], ['B', 'C', 'P', 'A'], ['C', 'P', 'A', 'B'],
    ['C', 'B', 'A', 'P'], ['P', 'C', 'B', 'A'], ['A', 'P', 'C', 'B'], ['B', 'A', 'P', 'C'],
];
const report = {status: 'started', boundary: 'Sequential actual-WASM compression component including equal source/dictionary HEAPU8 copies; no full importer, scheduling, output hashing or storage work',
    buildManifestSha256: sha(buildBytes), productionVsRebuilt: build.productionVsRebuilt,
    controlC: build.controlC, node: process.version, schedule, repetitions: 1,
    warmupCorpusPassesPerArm: 2, observations: [], failures: [], sourcePins: build.sourcePins};
await writeFile(resultPath, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
const save = () => writeFile(resultPath, JSON.stringify(report, null, 2) + '\n');
const arms = {};
const blocks = [];

async function identities() {
    assert.equal(sha(await readFile(path.join(artifactRoot, 'manifest.json'))), sha(buildBytes));
    assert.equal(sha(await readFile(path.join(corpusRoot, 'expected-manifest.json'))), sha(manifestBytes));
    assert.equal(sha(dictionary), dictionaryHash);
    for (const [relative, hash] of Object.entries(build.researchFiles)) {
        assert.equal(sha(await readFile(path.join(here, relative))), hash, relative);
    }
    for (const label of ['P', 'A', 'B', 'C']) {
        for (const [name, receipt] of Object.entries(build.arms[label].files)) {
            assert.equal(sha(await readFile(path.join(artifactRoot, 'arms', label, name))), receipt.sha256);
        }
    }
    for (let i = 0; i < blocks.length; ++i) {
        assert.equal(sha(blocks[i]), manifest.blocks[i].sha256);
        assert.equal(sha(gunzipSync(await readFile(path.join(corpusRoot, manifest.blocks[i].name)))), manifest.blocks[i].sha256);
    }
}

function execute(label) {
    let total = 0;
    for (let i = 0; i < blocks.length; ++i) {
        const result = arms[label].compress(blocks[i], dictionary, i % 4, false);
        if ('error' in result) { throw new Error(`${label} block${i} compression error ${result.error}`); }
        total += result.length;
    }
    return total;
}

function oracle() {
    const hashes = Object.fromEntries(['P', 'A', 'B', 'C'].map((a) => [a, createHash('sha256')]));
    for (let i = 0; i < blocks.length; ++i) {
        const outputs = Object.fromEntries(['P', 'A', 'B', 'C'].map((a) => [a, arms[a].compress(blocks[i], dictionary, i % 4)]));
        for (const label of ['P', 'A', 'B', 'C']) {
            assert.ok(!('error' in outputs[label]));
            assert.deepEqual(outputs[label].frame, outputs.P.frame);
            assert.deepEqual(outputs[label].envelope, outputs.P.envelope);
            hashes[label].update(outputs[label].frame);
        }
    }
    const result = Object.fromEntries(Object.entries(hashes).map(([a, h]) => [a, h.digest('hex')]));
    for (const label of ['P', 'A', 'B', 'C']) { assert.equal(result[label], build.qualification.canonical.frameSha256[label]); }
    return result;
}

const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return (sorted[3] + sorted[4]) / 2;
};
function comparison(numerator, denominator, metric) {
    const pairs = schedule.map((_, block) => {
        const a = report.observations.find((x) => x.block === block && x.arm === denominator);
        const b = report.observations.find((x) => x.block === block && x.arm === numerator);
        assert.ok(a && b && !a.error && !b.error);
        return {a: a[metric], b: b[metric]};
    });
    return {medianPercent: median(pairs.map(({a, b}) => 100 * (b / a - 1))),
        medianSavingMs: median(pairs.map(({a, b}) => a - b)),
        faster: pairs.filter(({a, b}) => b < a).length,
        equalWorkPercent: 100 * (pairs.reduce((sum, {b}) => sum + b, 0) / pairs.reduce((sum, {a}) => sum + a, 0) - 1)};
}

try {
    for (const entry of manifest.blocks) {
        const block = gunzipSync(await readFile(path.join(corpusRoot, entry.name)));
        assert.equal(block.byteLength, entry.bytes);
        assert.equal(sha(block), entry.sha256);
        blocks.push(block);
    }
    await identities();
    for (const label of ['P', 'A', 'B', 'C']) {
        arms[label] = await openArm(path.join(artifactRoot, 'arms', label), Math.max(...blocks.map((b) => b.length)), dictionary.length);
    }
    report.preOracle = oracle();
    for (const arm of ['P', 'A', 'B', 'C']) {
        for (let pass = 0; pass < 2; ++pass) { global.gc(); execute(arm); }
    }
    for (let block = 0; block < schedule.length; ++block) {
        for (let position = 0; position < 4; ++position) {
            const arm = schedule[block][position];
            const row = {block, position, arm};
            try {
                global.gc();
                const cpuBefore = process.cpuUsage();
                const wallBefore = performance.now();
                const compressedBytes = execute(arm);
                row.wallMs = performance.now() - wallBefore;
                const cpu = process.cpuUsage(cpuBefore);
                row.cpuMs = (cpu.user + cpu.system) / 1000;
                row.compressedBytes = compressedBytes;
                assert.equal(compressedBytes, build.qualification.canonical.frameBytes[arm]);
                assert.ok(Number.isFinite(row.cpuMs) && row.cpuMs > 0 && Number.isFinite(row.wallMs) && row.wallMs > 0);
            } catch (error) {
                row.error = String(error.stack ?? error);
                report.failures.push({block, position, arm, error: row.error});
            }
            report.observations.push(row);
            await save();
        }
    }
    report.postOracle = oracle();
    await identities();
    report.postIdentity = 'passed';
    if (report.failures.length === 0) {
        report.comparisons = {};
        for (const [numerator, denominator] of [['B', 'P'], ['B', 'A'], ['B', 'C'], ['C', 'A'], ['A', 'P']]) {
            report.comparisons[`${numerator}/${denominator}`] = Object.fromEntries(['cpuMs', 'wallMs'].map((metric) => [metric, comparison(numerator, denominator, metric)]));
        }
        report.armMedians = Object.fromEntries(['P', 'A', 'B', 'C'].map((arm) => [arm,
            Object.fromEntries(['cpuMs', 'wallMs'].map((metric) => [metric, median(report.observations.filter((x) => x.arm === arm).map((x) => x[metric]))]))]));
        const gain = ['B/P', 'B/A', 'B/C'].every((pair) => ['cpuMs', 'wallMs'].every((metric) => {
            const value = report.comparisons[pair][metric];
            return value.medianPercent <= -5 && value.faster >= 7 && value.equalWorkPercent < 0;
        }) && report.comparisons[pair].cpuMs.medianSavingMs >= 10);
        const controls = ['cpuMs', 'wallMs'].every((metric) => Math.abs(report.comparisons['C/A'][metric].medianPercent) <= 5);
        const productionControl = !build.productionVsRebuilt.wasmIdentical || ['cpuMs', 'wallMs'].every((metric) => Math.abs(report.comparisons['A/P'][metric].medianPercent) <= 5);
        const complete = report.observations.length === 32;
        report.gates = {complete, exactOraclesAndIdentity: true,
            gain, controls, productionControl, advance: complete && gain && controls && productionControl};
        report.status = 'completed';
    } else { report.status = 'failed'; }
} catch (error) {
    report.status = 'failed';
    report.exception = String(error.stack ?? error);
} finally {
    for (const arm of Object.values(arms)) { arm.close(); }
    await save();
}
console.log(JSON.stringify({status: report.status, observations: report.observations.length, gates: report.gates}));
if (report.status !== 'completed') { process.exitCode = 1; }
