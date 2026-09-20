// SPDX-License-Identifier: GPL-3.0-or-later
// Synthetic raw ZIP-reader stage benchmark. This is NOT a whole import benchmark.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {openAsBlob} from 'node:fs';
import {mkdir, mkdtemp, open, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

const {values} = parseArgs({options: {
    'baseline-ref': {type: 'string', default: '54ac62a39386459b7822fc644e5a1a6b1a619619'},
    'baseline-file': {type: 'string'},
    'candidate-file': {type: 'string'},
    runtime: {type: 'string', default: 'all'},
    rounds: {type: 'string', default: '6'},
    output: {type: 'string', default: 'builds/zip-header-benchmark.json'},
}});
const rounds = Number(values.rounds);
if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 100) { throw new Error('rounds must be an integer from 1 through 100'); }
if (!['node', 'chromium', 'all'].includes(values.runtime)) { throw new Error('runtime must be node, chromium, or all'); }
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const modulePath = 'ext/js/dictionary/term-bank-source-pipeline.js';
const baselineSource = values['baseline-file'] ? await readFile(values['baseline-file'], 'utf8') :
    execFileSync('git', ['show', `${values['baseline-ref']}:${modulePath}`], {cwd: repositoryRoot, encoding: 'utf8'});
const candidateSource = await readFile(values['candidate-file'] ?? path.join(repositoryRoot, modulePath), 'utf8');
const blobHash = (source) => createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest('hex');
const importSource = async (source) => await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const directory = await mkdtemp(path.join(os.tmpdir(), 'manabitan-zip-header-'));
const outputPath = path.resolve(values.output);
const report = {
    kind: 'synthetic raw ZIP-reader stage; not dictionary import, decompression, WASM, database write, or lookup',
    complete: false,
    baselineRef: values['baseline-file'] ? null : values['baseline-ref'],
    baselineBlob: blobHash(baselineSource),
    candidateBlob: blobHash(candidateSource),
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    cpu: os.cpus()[0]?.model,
    rounds,
    order: 'ABBA; one A and one B warmup per fixture; fresh reader per measured iteration; warm filesystem cache',
    fixture: 'Deterministic xorshift32 bytes in synthetic local ZIP records, method STORE, sparse padded to 129 MiB. Not valid term-bank JSON or complete dictionary ZIPs.',
    results: [],
};
const persist = async () => {
    await mkdir(path.dirname(outputPath), {recursive: true});
    await writeFile(outputPath, `${JSON.stringify(report, null, 4)}\n`);
};

async function makeFixtures() {
    const fixtures = [];
    for (const [name, count, size, concurrency] of [
        ['tiny-256', 256, 512, 3],
        ['medium-67', 67, 64 * 1024, 3],
        ['large-67', 67, 1024 * 1024, 3],
        ['medium-67-sequential', 67, 64 * 1024, 1],
    ]) {
        const filename = path.join(directory, `${name}.zip`);
        const handle = await open(filename, 'w');
        const files = [];
        const hash = createHash('sha256');
        let offset = 0;
        let seed = 0x12345678;
        try {
            for (let index = 0; index < count; ++index) {
                const entryName = `term_bank_${index + 1}.json`;
                const rawFilename = new TextEncoder().encode(entryName);
                const prefix = new Uint8Array(30 + rawFilename.length + index % 17);
                const view = new DataView(prefix.buffer);
                view.setUint32(0, 0x04034b50, true);
                view.setUint16(6, 8, true);
                view.setUint16(26, rawFilename.length, true);
                view.setUint16(28, index % 17, true);
                prefix.set(rawFilename, 30);
                const payload = new Uint8Array(size);
                for (let i = 0; i < size; ++i) {
                    seed ^= seed << 13;
                    seed ^= seed >>> 17;
                    seed ^= seed << 5;
                    payload[i] = seed & 255;
                }
                // FileHandle.write can be partial: use writeFile with the current
                // file position, which joins the complete write before proceeding.
                await handle.writeFile(prefix);
                await handle.writeFile(payload);
                hash.update(payload);
                files.push({filename: entryName, rawFilename: [...rawFilename], offset, compressedSize: size, compressionMethod: 0});
                offset += prefix.length + payload.length;
            }
            await handle.truncate(Math.max(offset, 129 * 1024 * 1024));
        } finally {
            await handle.close();
        }
        fixtures.push({name, path: filename, concurrency, files, payloadBytes: count * size, expectedSha256: hash.digest('hex')});
    }
    return fixtures;
}

async function readWorkload(Reader, archive, files, concurrency) {
    const reader = new Reader(archive);
    const signal = new AbortController().signal;
    const output = new Array(files.length);
    let nextIndex = 0;
    const start = performance.now();
    await Promise.all(Array.from({length: concurrency}, async () => {
        while (nextIndex < files.length) {
            const index = nextIndex++;
            output[index] = await reader.read(files[index], signal);
        }
    }));
    return {ms: performance.now() - start, output};
}

async function runABBA({baseline, candidate, archive, fixture, verify, rounds, gc}) {
    const files = fixture.files.map((file) => ({...file, rawFilename: Uint8Array.from(file.rawFilename)}));
    const classes = {A: baseline, B: candidate};
    for (const variant of ['A', 'B']) {
        const {output} = await readWorkload(classes[variant], archive, files, fixture.concurrency);
        await verify(output, fixture.expectedSha256);
    }
    const samples = [];
    for (let round = 0; round < rounds; ++round) {
        for (const variant of ['A', 'B', 'B', 'A']) {
            gc();
            const {ms, output} = await readWorkload(classes[variant], archive, files, fixture.concurrency);
            await verify(output, fixture.expectedSha256);
            samples.push({round, variant, ms});
        }
    }
    const totals = {A: 0, B: 0};
    for (const {variant, ms} of samples) { totals[variant] += ms; }
    const cycles = [];
    for (let round = 0; round < rounds; ++round) {
        const pair = {A: 0, B: 0};
        for (const sample of samples) {
            if (sample.round === round) { pair[sample.variant] += sample.ms; }
        }
        cycles.push({round, changePercent: (pair.B / pair.A - 1) * 100});
    }
    return {name: fixture.name, concurrency: fixture.concurrency, entryCount: files.length, payloadBytes: fixture.payloadBytes, archiveBytes: archive.size, samples, cycles, totals, changePercent: (totals.B / totals.A - 1) * 100};
}

try {
    const fixtures = await makeFixtures();
    if (values.runtime !== 'chromium') {
        const {RawZipPayloadReader: baseline} = await importSource(baselineSource);
        const {RawZipPayloadReader: candidate} = await importSource(candidateSource);
        for (const fixture of fixtures) {
            const result = await runABBA({baseline, candidate, archive: await openAsBlob(fixture.path), fixture, rounds,
                verify(output, expected) {
                    const hash = createHash('sha256');
                    for (const bytes of output) { hash.update(bytes); }
                    if (hash.digest('hex') !== expected) { throw new Error('Payload SHA-256 mismatch'); }
                },
                gc: () => globalThis.gc?.(),
            });
            report.results.push({runtime: 'node', gcAvailable: typeof globalThis.gc === 'function', verification: `SHA-256 ${fixture.expectedSha256}, after timing`, ...result});
            await persist();
            console.log('node', fixture.name, result.changePercent.toFixed(2));
        }
    }
    if (values.runtime !== 'node') {
        const {chromium} = await import(process.env.MANABITAN_PLAYWRIGHT_MODULE ?? '@playwright/test');
        const browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH, args: ['--js-flags=--expose-gc']});
        try {
            const page = await browser.newPage();
            await page.setContent('<input type="file" id="fixture">');
            const benchmarkSource = `${readWorkload.toString()}\nexport ${runABBA.toString()}`;
            await page.evaluate(async (sources) => {
                globalThis.zipBenchModules = [];
                for (const source of sources) {
                    const url = URL.createObjectURL(new Blob([source], {type: 'text/javascript'}));
                    try { globalThis.zipBenchModules.push(await import(url)); }
                    finally { URL.revokeObjectURL(url); }
                }
            }, [baselineSource, candidateSource, benchmarkSource]);
            for (const fixture of fixtures) {
                await page.locator('#fixture').setInputFiles(fixture.path);
                const result = await page.evaluate(async ({fixture, rounds}) => {
                    const [{RawZipPayloadReader: baseline}, {RawZipPayloadReader: candidate}, {runABBA}] = globalThis.zipBenchModules;
                    return await runABBA({baseline, candidate, archive: document.querySelector('#fixture').files[0], fixture, rounds,
                        verify(output) {
                            let seed = 0x12345678;
                            let total = 0;
                            for (const bytes of output) {
                                for (let i = 0; i < bytes.length; ++i) {
                                    seed ^= seed << 13;
                                    seed ^= seed >>> 17;
                                    seed ^= seed << 5;
                                    if (bytes[i] !== (seed & 255)) { throw new Error('Payload byte mismatch'); }
                                }
                                total += bytes.length;
                            }
                            if (total !== fixture.payloadBytes) { throw new Error('Payload size mismatch'); }
                        },
                        gc: () => globalThis.gc?.(),
                    });
                }, {fixture, rounds});
                report.results.push({runtime: `Chromium ${browser.version()}`, gcAvailable: await page.evaluate(() => typeof globalThis.gc === 'function'), verification: 'Every byte checked against deterministic fixture generator after timing', ...result});
                await persist();
                console.log('chromium', fixture.name, result.changePercent.toFixed(2));
            }
        } finally {
            await browser.close();
        }
    }
    report.complete = true;
    await persist();
} finally {
    await rm(directory, {recursive: true, force: true});
}
