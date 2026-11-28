import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const [rootArg, output, countArg = '12', candidateArg, cacheMode = 'no-store'] = process.argv.slice(2);
const root = fs.realpathSync(rootArg);
const candidate = candidateArg ? fs.realpathSync(candidateArg) : null;
let activeRoot = root;
const {chromium} = await import(pathToFileURL(path.join(root, 'node_modules/playwright/index.mjs')));
const count = Number(countArg);
const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://localhost');
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        res.setHeader('Cache-Control', cacheMode === 'cached' ? 'public, max-age=3600' : 'no-store');
        if (url.pathname === '/') {
            res.setHeader('Content-Type', 'text/html');
            res.end('<!doctype html><title>Parser startup component timing</title>');
            return;
        }
        const file = path.resolve(activeRoot, '.' + decodeURIComponent(url.pathname));
        if (!file.startsWith(activeRoot + path.sep)) throw new Error('Outside root');
        res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.json') ? 'application/json' : /\.(m?js)$/.test(file) ? 'text/javascript' : 'application/octet-stream');
        if (file.endsWith('/term-bank-wasm-parser-worker.js')) {
            const source = await fsp.readFile(file, 'utf8');
            res.end(source + '\nself.postMessage({type:"startup-probe-module-evaluated",absoluteTime:performance.timeOrigin+performance.now(),resources:performance.getEntriesByType("resource").map(x=>({name:x.name,startTime:x.startTime,responseEnd:x.responseEnd,duration:x.duration,transferSize:x.transferSize,encodedBodySize:x.encodedBodySize}))});\n');
            return;
        }
        res.end(await fsp.readFile(file));
    } catch (error) {
        res.writeHead(404).end(String(error));
    }
});
await new Promise((resolve, reject) => {server.on('error', reject);server.listen(0, '127.0.0.1', resolve);});
const report = {
    boundary: 'Parser prewarm in fresh page contexts; injected no-op worker module-evaluated event; HTTP localhost; component only, not extension import',
    root,
    candidate,
    cacheMode,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(),
    host: {cpuCount: os.cpus().length, availableParallelism: os.availableParallelism(), loadavg: os.loadavg()},
    trials: [],
};
let browser;
try {
    browser = await chromium.launch({headless: true, args: ['--no-sandbox']});
    for (let trial = -2; trial < count; ++trial) {
        const variant = candidate !== null && (trial === -1 || trial % 4 === 1 || trial % 4 === 2) ? 'candidate' : 'baseline';
        activeRoot = variant === 'candidate' ? candidate : root;
        const context = await browser.newContext();
        try {
            const page = await context.newPage();
            await page.goto(`http://127.0.0.1:${server.address().port}`);
            const sample = await page.evaluate(async () => {
                const events = [];
                let start = 0;
                const mark = (name, details = {}) => events.push({name, ms: performance.now() - start, ...details});
                const parser = await import('/ext/js/dictionary/term-bank-wasm-parser.js');
                const nativeFetch = fetch;
                globalThis.fetch = async (...args) => {
                    mark('fetch-start');
                    const response = await nativeFetch(...args);
                    mark('fetch-response');
                    const nativeArrayBuffer = response.arrayBuffer.bind(response);
                    response.arrayBuffer = async () => {
                        mark('buffer-start');
                        const bytes = await nativeArrayBuffer();
                        mark('buffer-end', {bytes: bytes.byteLength});
                        return bytes;
                    };
                    return response;
                };
                const nativeCompile = WebAssembly.compile;
                WebAssembly.compile = async (...args) => {
                    mark('compile-start');
                    const module = await nativeCompile(...args);
                    mark('compile-end');
                    return module;
                };
                const NativeWorker = Worker;
                let workerId = 0;
                globalThis.Worker = class extends NativeWorker {
                    constructor(...args) {
                        const id = ++workerId;
                        mark('worker-construct-start', {id});
                        super(...args);
                        mark('worker-construct-end', {id});
                        this.addEventListener('message', ({data}) => {
                            if (data.type === 'startup-probe-module-evaluated') {
                                mark('worker-module-evaluated-received', {id, workerTimeMs: data.absoluteTime - performance.timeOrigin - start, resources: data.resources});
                            } else if (data.type === 'ready') {
                                mark('worker-ready', {id});
                            }
                        });
                        const nativePost = this.postMessage.bind(this);
                        this.postMessage = (...args) => {
                            if (args[0]?.type === 'initialize') mark('worker-initialize-send', {id});
                            return nativePost(...args);
                        };
                    }
                };
                start = performance.now();
                const ready = await parser.prewarmParallelTermBankParser();
                mark('prewarm-end', {ready});
                await parser.disposeParallelTermBankParser();
                return {events, hardwareConcurrency: navigator.hardwareConcurrency, deviceMemory: navigator.deviceMemory, userAgent: navigator.userAgent};
            });
            report.trials.push({trial, warmup: trial < 0, variant, ...sample});
            const times = Object.fromEntries(sample.events.filter(x => !x.id).map(x => [x.name, x.ms]));
            console.log(JSON.stringify({trial, variant, fetchMs: times['fetch-response'] - times['fetch-start'], bodyMs: times['buffer-end'] - times['buffer-start'], compileMs: times['compile-end'] - times['compile-start'], maxOverlapMs: times['compile-end'], totalMs: times['prewarm-end']}));
        } finally {
            await context.close();
        }
    }
} finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    await fsp.writeFile(output, JSON.stringify(report, null, 2));
}
