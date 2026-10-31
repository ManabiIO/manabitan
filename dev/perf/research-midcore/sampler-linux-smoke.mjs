import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {createProcessTreeSampler} from './process-tree-memory.mjs';
assert.equal(process.platform, 'linux');
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1200)'], {stdio: 'ignore'});
const joined = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({code, signal})); });
const sampler = createProcessTreeSampler({intervalMs: 100, includePss: true});
let result;
try {
    await sampler.start(process.pid);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await sampler.sampleNow();
} finally { result = await sampler.stop(); await joined; }
assert.ok(result.summary.maxObservedProcessCount >= 2);
assert.ok(result.summary.completeRssSampleCount >= 2);
assert.ok(result.summary.completePssSampleCount >= 2);
assert.ok(result.summary.peakSampledAggregateRssBytes > 0);
assert.ok(result.summary.peakSampledAggregatePssBytes > 0);
assert.ok(result.samples.some((sample) => sample.members?.some((member) => member.pid === child.pid)));
await writeFile(process.env.MIDCORE_SMOKE_REPORT, JSON.stringify(result, null, 2) + '\n', {flag: 'wx'});
