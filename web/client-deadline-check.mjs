/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const ts = createRequire(import.meta.url)('typescript');
const directory = await mkdtemp(join(tmpdir(), 'manabitan-deadlines-'));

// Compile the production client, not a copied model of its ownership decisions.
for (const name of ['client', 'protocol']) {
    const source = await readFile(new URL(`../ext/web/${name}.ts`, import.meta.url), 'utf8');
    const result = ts.transpileModule(source, {
        fileName: `${name}.ts`,
        compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022},
        reportDiagnostics: true,
    });
    assert.equal(result.diagnostics?.length ?? 0, 0);
    await writeFile(join(directory, `${name}.js`), result.outputText);
}
await writeFile(join(directory, 'package.json'), '{"type":"module"}');
const {ManabiTanWebClient} = await import(pathToFileURL(join(directory, 'client.js')).href);

class Clock {
    now = 0;
    nextId = 0;
    timers = new Map();
    set = (callback, delay) => {
        const id = ++this.nextId;
        this.timers.set(id, {callback, due: this.now + delay});
        return id;
    };

    clear = (id) => this.timers.delete(id);
    advance(milliseconds) {
        const end = this.now + milliseconds;
        for (let iterations = 0; ; ++iterations) {
            assert.ok(iterations < 1000, 'unbounded timer replay');
            const next = [...this.timers].filter(([, t]) => t.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
            if (!next) { break; }
            const [id, timer] = next;
            this.now = timer.due;
            this.timers.delete(id);
            timer.callback();
        }
        this.now = end;
    }
}
class ControlledWorker extends EventTarget {
    static latest;
    requests = [];
    terminated = false;
    throwOnPost = false;
    constructor() { super(); ControlledWorker.latest = this; }
    postMessage(request) {
        if (this.throwOnPost) { throw new DOMException('Not cloneable', 'DataCloneError'); }
        this.requests.push(request);
    }

    terminate() { this.terminated = true; }
    emit(id, body) {
        if (!this.terminated) { this.dispatchEvent(new MessageEvent('message', {data: {version: 1, id, ...body}})); }
    }

    request(name) { return this.requests.find((request) => request.operation === name); }
}
const track = (promise) => promise.then((value) => ({ok: true, value}), (error) => ({ok: false, code: error.code, name: error.name}));
const saved = {Worker: globalThis.Worker, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout};
let count = 0;
let failures = 0;
async function scenario(name, action) {
    const clock = new Clock();
    globalThis.Worker = ControlledWorker;
    globalThis.setTimeout = clock.set;
    globalThis.clearTimeout = clock.clear;
    const client = new ManabiTanWebClient();
    const worker = ControlledWorker.latest;
    try {
        const opened = client.open();
        worker.emit(worker.request('open').id, {result: {dictionaries: []}});
        await opened;
        await action({clock, client, worker});
        console.log(`PASS ${name}`);
    } catch (error) {
        failures++;
        console.error(`FAIL ${name}: ${error.message}`);
    } finally {
        // Settle every promise retained at the controlled transport boundary.
        worker.dispatchEvent(new Event('error'));
        clock.timers.clear();
        Object.assign(globalThis, saved);
        count++;
    }
}
try {
    for (const operation of ['status', 'lookup']) {
        await scenario(`queued ${operation} does not kill a progressing import`, async ({clock, client, worker}) => {
            let progress = 0;
            const imported = track(client.importDictionary(new Blob(['fixture']), {onProgress: () => progress++}));
            const queued = track(operation === 'status' ? client.status() : client.lookup('日本'));
            for (let i = 0; i < 4; i++) {
                clock.advance(10_000);
                worker.emit(worker.request('import').id, {progress: i});
            }
            assert.equal(worker.terminated, false);
            assert.equal(progress, 4);
            worker.emit(worker.request('import').id, {result: {cancelledAfterCommit: false}});
            worker.emit(worker.request(operation).id, {result: {}});
            assert.equal((await imported).ok, true);
            assert.equal((await queued).ok, true);
        });
    }
    await scenario('queued request receives its full execution allowance', async ({clock, client, worker}) => {
        const imported = track(client.importDictionary(new Blob(['fixture'])));
        const queued = track(client.status());
        clock.advance(40_000);
        assert.equal(worker.terminated, false);
        worker.emit(worker.request('import').id, {result: {}});
        assert.equal((await imported).ok, true);
        clock.advance(29_999);
        assert.equal(worker.terminated, false);
        clock.advance(1);
        assert.equal(worker.terminated, true);
        assert.equal((await queued).code, 'worker_timeout');
    });
    await scenario('active import still has a bounded deadline', async ({clock, client, worker}) => {
        const imported = track(client.importDictionary(new Blob(['fixture'])));
        const queued = track(client.lookup('本'));
        clock.advance(15 * 60_000 - 1);
        assert.equal(worker.terminated, false);
        clock.advance(1);
        assert.equal((await imported).code, 'worker_timeout');
        assert.equal((await queued).code, 'worker_timeout');
    });
    await scenario('cancelled active caller retains watchdog until worker acknowledgement', async ({clock, client, worker}) => {
        const controller = new AbortController();
        const active = track(client.status({signal: controller.signal}));
        const imported = track(client.importDictionary(new Blob(['fixture'])));
        clock.advance(10_000);
        controller.abort();
        assert.equal((await active).name, 'AbortError');
        clock.advance(20_000);
        assert.equal(worker.terminated, true);
        assert.equal((await imported).code, 'worker_timeout');
    });
    await scenario('cancelled queued caller neither resets nor steals active deadline', async ({clock, client, worker}) => {
        const imported = track(client.importDictionary(new Blob(['fixture'])));
        const controller = new AbortController();
        const queued = track(client.status({signal: controller.signal}));
        clock.advance(100_000);
        controller.abort();
        assert.equal((await queued).name, 'AbortError');
        worker.emit(worker.request('status').id, {error: {name: 'AbortError', message: 'cancelled'}});
        clock.advance(800_000);
        assert.equal((await imported).code, 'worker_timeout');
        assert.equal(worker.terminated, true);
    });
    await scenario('out-of-order busy reply cannot retire current owner', async ({clock, client, worker}) => {
        const imported = track(client.importDictionary(new Blob(['fixture'])));
        const queued = track(client.status());
        worker.emit(worker.request('status').id, {error: {code: 'busy', name: 'WebRuntimeError', message: 'busy'}});
        assert.equal((await queued).code, 'busy');
        clock.advance(899_999);
        assert.equal(worker.terminated, false);
        clock.advance(1);
        assert.equal((await imported).code, 'worker_timeout');
    });
    await scenario('retired watchdog callback cannot terminate a successor', async ({clock, client, worker}) => {
        const imported = track(client.importDictionary(new Blob(['fixture'])));
        const oldCallback = [...clock.timers.values()][0].callback;
        const queued = track(client.status());
        worker.emit(worker.request('import').id, {result: {}});
        await imported;
        oldCallback();
        assert.equal(worker.terminated, false);
        worker.emit(worker.request('status').id, {result: {}});
        assert.equal((await queued).ok, true);
    });
    await scenario('postMessage failure leaves no phantom FIFO owner', async ({clock, client, worker}) => {
        worker.throwOnPost = true;
        assert.equal((await track(client.status())).name, 'DataCloneError');
        assert.equal(clock.timers.size, 0);
        worker.throwOnPost = false;
        const imported = track(client.importDictionary(new Blob(['fixture'])));
        clock.advance(40_000);
        assert.equal(worker.terminated, false);
        worker.emit(worker.request('import').id, {result: {}});
        assert.equal((await imported).ok, true);
    });
    await scenario('cancelled import still reports a committed result', async ({clock, client, worker}) => {
        const controller = new AbortController();
        const imported = track(client.importDictionary(new Blob(['fixture']), {signal: controller.signal}));
        controller.abort();
        clock.advance(40_000);
        assert.equal(worker.terminated, false);
        worker.emit(worker.request('import').id, {result: {cancelledAfterCommit: true}});
        const result = await imported;
        assert.equal(result.ok, true);
        assert.equal(result.value.cancelledAfterCommit, true);
    });
    await scenario('close retains a whole-shutdown deadline', async ({clock, client, worker}) => {
        const imported = track(client.importDictionary(new Blob(['fixture'])));
        const closed = track(client.close());
        clock.advance(60_000);
        assert.equal((await closed).ok, false);
        assert.equal((await imported).ok, false);
        assert.equal(worker.terminated, true);
    });
} finally {
    Object.assign(globalThis, saved);
    await rm(directory, {recursive: true, force: true});
}
console.log(`${count} cases; ${failures} failures; actual client with controlled Worker/timers, not browser/OPFS qualification`);
process.exitCode = failures ? 1 : 0;
