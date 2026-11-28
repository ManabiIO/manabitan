import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const [rootArg, outputArg] = process.argv.slice(2);
const root = fs.realpathSync(rootArg);
const output = path.resolve(outputArg);
const baseline = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2';
const entry = 'ext/js/dictionary/term-bank-wasm-parser-worker.js';
const bundledEntry = 'ext/js/dictionary/term-bank-wasm-parser-worker.bundle.js';
const rssLimitMiB = 1024;
const minimumAvailableMiB = 1536;
const initialAvailableKiB = Number((await fsp.readFile('/proc/meminfo', 'utf8')).match(/^MemAvailable:\s+(\d+) kB$/m)?.[1]);
if (!Number.isFinite(initialAvailableKiB) || initialAvailableKiB < minimumAvailableMiB * 1024) throw new Error('Less than 1.5 GiB physical memory available before probe');
const {default: esbuild} = await import(pathToFileURL(path.join(root, 'node_modules/esbuild/lib/main.js')));
const {chromium} = await import(pathToFileURL(path.join(root, 'node_modules/playwright/index.mjs')));
const sha256 = source => crypto.createHash('sha256').update(source).digest('hex');
const bundleOptions = {absWorkingDir: root, entryPoints: [entry], bundle: true, format: 'esm', target: 'es2020', minify: false, sourcemap: false, write: false, metafile: true, outfile: bundledEntry};
const initialBuild = await esbuild.build(bundleOptions);
const sources = new Map();
const copyrights = new Set();
for (const file of Object.keys(initialBuild.metafile.inputs)) {
    const bytes = await fsp.readFile(path.join(root, file));
    const committed = execFileSync('git', ['show', baseline + ':' + file], {cwd: root});
    if (!bytes.equals(committed)) throw new Error('Baseline source changed: ' + file);
    sources.set('/' + file, bytes);
    for (const notice of bytes.toString().match(/^ \* Copyright[^\n]*/gm) ?? []) copyrights.add(notice);
}
const entryHeader = sources.get('/' + entry).toString().match(/^\/\*[\s\S]*?\*\//)?.[0];
if (!entryHeader || !entryHeader.includes('GNU General Public License')) throw new Error('GPL worker header not found');
const banner = entryHeader.replace(/^ \* Copyright[^\n]*\n/m, [...copyrights].join('\n') + '\n');
const build = await esbuild.build({...bundleOptions, banner: {js: banner}});
const bundle = Buffer.from(build.outputFiles[0].contents);
const outputMeta = Object.values(build.metafile.outputs)[0];
if (outputMeta.imports.length !== 0 || outputMeta.exports.length !== 0) throw new Error('Unexpected external bundle imports/exports');
if (!bundle.toString().includes('new URL("../../lib/term-bank-parser.wasm", import.meta.url)')) throw new Error('Bundled WASM URL changed');
await fsp.writeFile(output.replace(/\.json$/, '.bundle.js'), bundle);
await fsp.writeFile(output.replace(/\.json$/, '.metafile.json'), JSON.stringify(build.metafile, null, 2));
const probe = '\nself.postMessage({type:"startup-probe-module-evaluated",absoluteTime:performance.timeOrigin+performance.now(),resources:performance.getEntriesByType("resource").map(x=>({name:x.name,startTime:x.startTime,responseEnd:x.responseEnd,duration:x.duration,transferSize:x.transferSize,encodedBodySize:x.encodedBodySize}))});\n';
const orders = ['ABC', 'BCA', 'CAB', 'ACB', 'CBA', 'BAC'];
const schedule = [
    ...['A', 'B', 'C'].map((arm, index) => ({block: -1, position: index, arm, warmup: true})),
    ...orders.flatMap((order, block) => [...order].map((arm, position) => ({block, position, arm, warmup: false}))),
];
const report = {
    boundary: 'Parser prewarm in fresh browser page contexts; three warmup runs then six balanced ABC blocks. A and C are the identical untouched baseline worker; B is a same-directory esbuild bundle with all original copyright notices and GPL header. HTTP localhost no-store; component only, not extension import.',
    limitations: ['Worker module fetching/evaluation is measured over localhost HTTP, not chrome-extension URLs.', 'No dictionary rows, OPFS writes, compression, or complete import are included.', 'One browser process serves the fixed cohort; fresh contexts partition web state but browser/V8 process resources can remain warm.'],
    baseline, root, node: process.version, esbuildVersion: esbuild.version,
    host: {availableParallelism: os.availableParallelism(), cpuCount: os.cpus().length, cpuModel: os.cpus()[0]?.model, loadavg: os.loadavg()},
    resourcePlan: {rssLimitMiB, minimumAvailableMiB, initialAvailableKiB},
    bundle: {options: bundleOptions, banner, bytes: bundle.length, withoutBannerBytes: initialBuild.outputFiles[0].contents.length, sha256: sha256(bundle), imports: outputMeta.imports, sourceFileCount: sources.size, sourceBytes: [...sources.values()].reduce((sum, bytes) => sum + bytes.length, 0), inputSources: [...sources].map(([file, bytes]) => ({path: file, bytes: bytes.length, sha256: sha256(bytes)}))},
    schedule, observations: [], memory: [], requests: [], failures: [],
};
let currentTrial = null;
let activeBrowser;
let resourceFailure;
let timer;
let sampling = false;
function memorySample(label) {
    const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,rss='], {encoding: 'utf8'}).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    const descendants = new Set([process.pid]);
    for (let changed = true; changed;) {
        changed = false;
        for (const [pid, ppid] of rows) if (descendants.has(ppid) && !descendants.has(pid)) {descendants.add(pid);changed = true;}
    }
    const rssKiB = rows.filter(([pid]) => descendants.has(pid)).reduce((sum, row) => sum + row[2], 0);
    report.memory.push({label, rssKiB, processCount: descendants.size, trial: currentTrial});
    if (rssKiB > rssLimitMiB * 1024) throw new Error('Stopped at process-tree RSS ' + rssKiB + ' KiB above ' + rssLimitMiB + ' MiB limit');
}
const server = http.createServer(async (req, res) => {
    const observedTrial = currentTrial;
    try {
        const url = new URL(req.url, 'http://localhost');
        for (const [name, value] of Object.entries({'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': 'no-store'})) res.setHeader(name, value);
        if (url.pathname === '/') {res.setHeader('Content-Type', 'text/html');res.end('<!doctype html><title>Parser worker bundle startup comparison</title>');return;}
        const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
        if (!file.startsWith(root + path.sep)) throw new Error('Outside root');
        let bytes;
        if (url.pathname === '/' + bundledEntry) {
            bytes = Buffer.concat([bundle, Buffer.from(probe)]);
        } else {
            bytes = sources.get(url.pathname);
            if (!bytes) {bytes = await fsp.readFile(file);sources.set(url.pathname, bytes);}
            if (url.pathname === '/' + entry) bytes = Buffer.concat([bytes, Buffer.from(probe)]);
        }
        res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.json') ? 'application/json' : /\.(m?js)$/.test(file) ? 'text/javascript' : 'application/octet-stream');
        report.requests.push({trial: observedTrial, path: url.pathname, bytes: bytes.length});
        res.end(bytes);
    } catch (error) {report.failures.push({trial: observedTrial, request: req.url, error: String(error)});res.writeHead(404).end(String(error));}
});
await new Promise((resolve, reject) => {server.on('error', reject);server.listen(0, '127.0.0.1', resolve);});
try {
    activeBrowser = await chromium.launch({headless: true, args: ['--no-sandbox']});
    report.browserVersion = activeBrowser.version();
    memorySample('browser-started');
    timer = setInterval(() => {
        if (sampling || resourceFailure) return;
        sampling = true;
        try {memorySample('during-cohort');} catch (error) {resourceFailure = error;void activeBrowser.close().catch(() => {});} finally {sampling = false;}
    }, 150);
    for (const trial of schedule) {
        if (resourceFailure) throw resourceFailure;
        currentTrial = trial;
        const context = await activeBrowser.newContext();
        const page = await context.newPage();
        const pageErrors = [];
        page.on('pageerror', error => pageErrors.push(error.stack ?? String(error)));
        try {
            await page.goto('http://127.0.0.1:' + server.address().port);
            const sample = await page.evaluate(async (arm) => {
                const events = [];
                let start = 0;
                const mark = (name, details = {}) => events.push({name, ms: performance.now() - start, ...details});
                const parser = await import('/ext/js/dictionary/term-bank-wasm-parser.js');
                const nativeFetch = fetch;
                globalThis.fetch = async (...args) => {
                    mark('fetch-start', {url: String(args[0])});
                    const response = await nativeFetch(...args);
                    mark('fetch-response', {url: String(args[0])});
                    const nativeArrayBuffer = response.arrayBuffer.bind(response);
                    response.arrayBuffer = async () => {mark('buffer-start');const bytes = await nativeArrayBuffer();mark('buffer-end', {bytes: bytes.byteLength});return bytes;};
                    return response;
                };
                const nativeCompile = WebAssembly.compile;
                WebAssembly.compile = async (...args) => {mark('compile-start');const module = await nativeCompile(...args);mark('compile-end');return module;};
                const NativeWorker = Worker;
                let workerId = 0;
                globalThis.Worker = class extends NativeWorker {
                    constructor(url, options) {
                        const id = ++workerId;
                        const originalUrl = String(url);
                        const effectiveUrl = arm === 'B' && originalUrl.endsWith('/term-bank-wasm-parser-worker.js') ? new URL('term-bank-wasm-parser-worker.bundle.js', originalUrl) : url;
                        mark('worker-construct-start', {id, originalUrl, effectiveUrl: String(effectiveUrl)});
                        super(effectiveUrl, options);
                        mark('worker-construct-end', {id});
                        this.addEventListener('message', ({data}) => {
                            if (data.type === 'startup-probe-module-evaluated') mark('worker-module-evaluated-received', {id, workerTimeMs: data.absoluteTime - performance.timeOrigin - start, resources: data.resources});
                            else if (data.type === 'ready') mark('worker-ready', {id});
                            else if (data.type === 'initialization-error') mark('worker-initialization-error', {id, error: data.error});
                        });
                        this.addEventListener('error', error => mark('worker-error', {id, message: error.message}));
                        const nativePost = this.postMessage.bind(this);
                        this.postMessage = (...args) => {if (args[0]?.type === 'initialize') mark('worker-initialize-send', {id});return nativePost(...args);};
                    }
                };
                start = performance.now();
                const ready = await parser.prewarmParallelTermBankParser();
                mark('prewarm-end', {ready});
                await parser.disposeParallelTermBankParser();
                const workers = events.filter(event => event.name === 'worker-construct-start');
                if (!ready || workers.length === 0 || events.filter(event => event.name === 'worker-ready').length !== workers.length || events.filter(event => event.name === 'worker-module-evaluated-received').length !== workers.length) throw new Error('Incomplete worker readiness or instrumentation');
                return {events, workerCount: workers.length, hardwareConcurrency: navigator.hardwareConcurrency, deviceMemory: navigator.deviceMemory, userAgent: navigator.userAgent, pageResources: performance.getEntriesByType('resource').map(x => ({name: x.name, startTime: x.startTime, duration: x.duration, transferSize: x.transferSize, encodedBodySize: x.encodedBodySize}))};
            }, trial.arm);
            if (pageErrors.length > 0) throw new Error('Page errors: ' + pageErrors.join('\n'));
            report.observations.push({...trial, ...sample, pageErrors});
            memorySample('after-trial');
            await fsp.writeFile(output, JSON.stringify(report, null, 2));
            const elapsed = sample.events.find(event => event.name === 'prewarm-end').ms;
            console.log(JSON.stringify({...trial, totalMs: elapsed, workers: sample.workerCount}));
        } finally {await context.close();}
    }
    const median = values => {const sorted = [...values].sort((a, b) => a - b);return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;};
    const timed = report.observations.filter(row => !row.warmup);
    report.summary = {arms: {}, pairs: []};
    for (const arm of ['A', 'B', 'C']) {
        const rows = timed.filter(row => row.arm === arm);
        const times = rows.map(row => row.events.find(event => event.name === 'prewarm-end').ms);
        const workerTimes = rows.flatMap(row => row.events.filter(event => event.name === 'worker-ready').map(event => event.ms - row.events.find(start => start.name === 'worker-construct-start' && start.id === event.id).ms));
        report.summary.arms[arm] = {n: rows.length, medianMs: median(times), minMs: Math.min(...times), maxMs: Math.max(...times), workerReadyMedianMs: median(workerTimes)};
    }
    for (let block = 0; block < orders.length; ++block) {
        const byArm = Object.fromEntries(timed.filter(row => row.block === block).map(row => [row.arm, row.events.find(event => event.name === 'prewarm-end').ms]));
        report.summary.pairs.push({block, ...byArm, bOverA: byArm.B / byArm.A, bOverC: byArm.B / byArm.C, cOverA: byArm.C / byArm.A});
    }
    for (const key of ['bOverA', 'bOverC', 'cOverA']) report.summary[key] = {medianRatio: median(report.summary.pairs.map(row => row[key])), faster: report.summary.pairs.filter(row => row[key] < 1).length};
    report.success = true;
    console.log(JSON.stringify({summary: report.summary, bundleBytes: bundle.length, sourceBytes: report.bundle.sourceBytes, maxSampledTreeRssMiB: Math.max(...report.memory.map(row => row.rssKiB)) / 1024}, null, 2));
} catch (error) {
    report.success = false;report.failure = (resourceFailure ?? error).stack ?? String(resourceFailure ?? error);process.exitCode = 1;console.error(report.failure);
} finally {
    clearInterval(timer);
    await activeBrowser?.close().catch(() => {});
    await new Promise(resolve => server.close(resolve));
    await fsp.writeFile(output, JSON.stringify(report, null, 2));
}
