import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {makeMdictFixture} from '../test/util/mdict-binary-fixture.js';
import {armBrowserImportTiming} from '../test/e2e/import-timing.js';

const evidence = path.resolve('builds/mdict-qualification');
const extension = path.join(evidence, 'extension');
const sourcePath = 'js/dictionary/mdx/mdx-converter.js';
const sources = {
    A: await readFile(path.join(evidence, 'baseline-converter.js')),
    B: await readFile(path.join('ext', sourcePath)),
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const rows = 50000;
const probes = Array.from({length: 12}, (_,i) => Math.floor(i * (rows - 1) / 11));
const median = (values) => [...values].sort((a,b) => a-b)[Math.floor(values.length / 2)];
const results = [];
let browserVersion;
await mkdir(evidence, {recursive: true});

async function send(page, action, params) {
    return await page.evaluate(({action, params}) => new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({action, params}, (response) => {
            if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); }
            else if (response?.error) { reject(new Error(JSON.stringify(response.error))); }
            else { resolve(response?.result); }
        });
    }), {action, params});
}

async function run(label, fixture, control) {
    // Same unpacked path/origin; no browser is alive during the source swap.
    await writeFile(path.join(extension, sourcePath), sources[control ? 'A' : label]);
    const profile = await mkdtemp(path.join(os.tmpdir(), 'mdict-qualification-'));
    let context;
    try {
        context = await chromium.launchPersistentContext(profile, {
            headless: true, channel: 'chromium',
            args: ['--no-sandbox', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
        });
        browserVersion ??= context.browser()?.version();
        const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', {timeout: 30000});
        const page = await context.newPage();
        const pageErrors = [];
        page.on('pageerror', (error) => pageErrors.push(String(error)));
        await page.goto(`chrome-extension://${new URL(worker.url()).hostname}/settings.html`);
        await page.waitForFunction(() => document.documentElement.dataset.loaded === 'true', {}, {timeout: 60000});
        await page.evaluate(armBrowserImportTiming);
        await page.setInputFiles('#dictionary-import-file-input', fixture);
        await page.waitForFunction(() => globalThis.__manabitanBrowserImportTiming?.completedAtMs != null, {}, {timeout: 120000});
        const timing = await page.evaluate(() => globalThis.__manabitanBrowserImportTiming);
        assert.equal(timing.errorCount, 0, JSON.stringify(timing));
        assert.ok(timing.completedAtMs > timing.startedAtMs);
        // Everything below is excluded from the measured change-event-to-success interval.
        const info = await send(page, 'getDictionaryInfo');
        assert.equal(info.length, 1);
        assert.equal(info[0].importSuccess, true);
        assert.equal(info[0].storageHealth, 'available');
        const counts = await send(page, 'getDictionaryCounts', {dictionaryNames: [info[0].title], getTotal: false});
        assert.equal(counts.counts[0].terms, rows);
        const lookups = [];
        for (const index of probes) {
            const term = `word${String(index).padStart(5, '0')}`;
            const found = await send(page, 'termsFind', {
                text: term, details: {primaryReading: '', matchType: 'exact', deinflect: false}, optionsContext: {index: 0},
            });
            assert.ok(found.dictionaryEntries.length > 0, `No lookup result for ${term}`);
            lookups.push(found.dictionaryEntries);
        }
        const missing = await send(page, 'termsFind', {
            text: 'not-in-the-dictionary', details: {primaryReading: '', matchType: 'exact', deinflect: false}, optionsContext: {index: 0},
        });
        assert.equal(missing.dictionaryEntries.length, 0);
        assert.deepEqual(pageErrors, []);
        return {ms: timing.completedAtMs - timing.startedAtMs, outputHash: hash(JSON.stringify({counts, lookups, missing: missing.dictionaryEntries}))};
    } finally {
        await context?.close();
        await rm(profile, {recursive: true, force: true});
    }
}

const cases = [
    ['plain', (i) => `Meaning ${i}: a Japanese dictionary definition. 日本語の説明。`],
    ['mixed', (i) => i % 4 === 0 ? `<b>Meaning ${i}</b>` : `Meaning ${i}: 日本語の説明。`],
    ['html-control', (i) => `<div><b>Meaning ${i}</b>: <i>a Japanese dictionary definition.</i> 日本語の説明。</div>`],
];
for (const [control, repetitions, workloads] of [[true, 5, cases.slice(0, 1)], [false, 9, cases]]) {
    for (const [name, definition] of workloads) {
        const fixture = makeMdictFixture(Array.from({length: rows}, (_,i) => ({key: `word${String(i).padStart(5, '0')}`, value: definition(i)})), {
            compression: 'zlib', recordBlockSize: 32768, keysPerBlock: 256,
        });
        const file = path.join(evidence, `${name}.mdx`);
        await writeFile(file, fixture.bytes);
        const reference = await run('A', file, control);
        assert.equal((await run('B', file, control)).outputHash, reference.outputHash);
        const samples = [];
        for (let pair = 0; pair < repetitions; ++pair) {
            const sample = {};
            for (const label of pair % 2 ? ['B', 'A'] : ['A', 'B']) {
                const result = await run(label, file, control);
                assert.equal(result.outputHash, reference.outputHash);
                sample[label] = result.ms;
            }
            sample.pct = (sample.B / sample.A - 1) * 100;
            samples.push(sample);
            console.log(JSON.stringify({control, name, pair, ...sample}));
        }
        results.push({control, name, rows, repetitions, fixtureSha256: hash(fixture.bytes), outputHash: reference.outputHash,
            medianA: median(samples.map((s) => s.A)), medianB: median(samples.map((s) => s.B)),
            pairedPct: median(samples.map((s) => s.pct)), wins: samples.filter((s) => s.B < s.A).length, samples});
        await writeFile(path.join(evidence, 'results.json'), JSON.stringify({
            node: process.version, platform: process.platform, cpu: os.cpus()[0].model, cpuCount: os.cpus().length,
            browserVersion, sourceSha256: {A: hash(sources.A), B: hash(sources.B)},
            protocol: 'Fresh profile each arm; fixed unpacked extension path/origin. One excluded AB warmup per cohort. Alternating AB/BA. Five A/A calibration pairs then nine pairs per A/B workload. No traces/profiling/experimental options. File change event to current-run import success. Counts, storage health, 12 exact lookup payloads and missing-key control checked after timer. All measured samples retained.',
            results,
        }, null, 2));
    }
}
const [aa, plain, mixed, html] = results;
const eligible = Math.abs(aa.pairedPct) < 5 && plain.pairedPct < -5 && plain.wins >= 7 && mixed.pairedPct < 0 && mixed.wins >= 6 && html.pairedPct < 5;
await writeFile(path.join(evidence, 'eligible.json'), JSON.stringify({eligible, gate: 'A/A median within 5%; plain faster by >5% and >=7/9 wins; mixed faster and >=6/9 wins; HTML control <5% regression', aa: aa.pairedPct, plain: plain.pairedPct, mixed: mixed.pairedPct, html: html.pairedPct}, null, 2));
console.log(JSON.stringify({eligible}));
