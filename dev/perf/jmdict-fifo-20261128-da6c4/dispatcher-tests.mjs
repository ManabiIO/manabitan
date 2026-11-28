// Deterministic transport/lifetime checks. No codec timing or Wasm initialization.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

assert.equal(process.argv.length, 4);
const root = path.resolve(process.argv[2]);
const componentSource = await readFile(process.argv[3], 'utf8');
const start = componentSource.indexOf('class LogicalWorker');
const end = componentSource.indexOf('async function main()');
assert(start >= 0 && end > start);
const dispatcherSource = componentSource.slice(start, end);
const terminalStart = componentSource.indexOf('        pool.close();\n        await dispatcher.close();\n        workersTerminated = true;');
const terminalEnd = componentSource.indexOf("        report.startupMemory.push({phase: 'all-four-workers-terminated'", terminalStart);
assert(terminalStart >= 0 && terminalEnd > terminalStart);
const terminalSource = componentSource.slice(terminalStart, terminalEnd);
const {TermContentCompressionPool} = await import(pathToFileURL(path.join(root, 'ext/js/dictionary/zstd-term-content.js')));
const results = await (async () => {

const testResults = [];
class FakeWorker {
    static instances = [];
    constructor() {
        this.listeners = new Map();
        this.posts = [];
        this.terminated = false;
        FakeWorker.instances.push(this);
    }
    on(type, listener) {
        if (!this.listeners.has(type)) { this.listeners.set(type, []); }
        this.listeners.get(type).push(listener);
    }
    emit(type, value) {
        for (const listener of this.listeners.get(type) ?? []) { listener(value); }
    }
    postMessage(message, transfer) { this.posts.push({message, transfer}); }
    async terminate() {
        this.terminated = true;
        this.emit('exit', 1);
        return 1;
    }
}
let tick = 0n;
const fakeNs = () => String(++tick);
const classes = new Function(
    'assert', 'NodeWorker', 'pathToFileURL', 'path', 'ns', 'SharedArrayBuffer',
    dispatcherSource + '\nreturn {Dispatcher, LogicalWorker};',
)(assert, FakeWorker, (value) => ({href: String(value)}), {join: (...parts) => parts.join('/')}, fakeNs, SharedArrayBuffer);
const {Dispatcher} = classes;
async function setup(mode) {
    let activeGroup = 0;
    const dispatcher = new Dispatcher({root: '/runtime', bridgePath: '/bridge.mjs'}, () => activeGroup);
    const pool = new TermContentCompressionPool(dispatcher.logical);
    const starting = dispatcher.start();
    for (const {worker} of dispatcher.physical) { worker.emit('message', {type: 'ready'}); }
    await starting;
    dispatcher.reset(mode);
    return {dispatcher, pool, setGroup: (value) => { activeGroup = value; }};
}
function operation(pool, count) {
    const source = new Uint8Array(new SharedArrayBuffer(count));
    source.set(Array.from({length: count}, (_, index) => index + 1));
    const offsets = Uint32Array.from({length: count}, (_, index) => index);
    const lengths = new Uint32Array(count).fill(1);
    const starts = Uint32Array.from({length: count + 1}, (_, index) => index);
    const sizes = new Uint32Array(count).fill(1);
    const result = pool.beginCompressWrappedSpans(source, offsets, lengths, starts, sizes, 'jmdict');
    return {...result, source, offsets, lengths};
}
function consume(dispatcher, id) {
    const pending = dispatcher.pending.get(id);
    assert(pending);
    dispatcher.physical[pending.job.physicalWorker].worker.emit('message', {type: 'source-consumed', id});
}
function complete(dispatcher, id, value = id) {
    const pending = dispatcher.pending.get(id);
    assert(pending);
    const compressed = Uint8Array.of(value).buffer;
    dispatcher.physical[pending.job.physicalWorker].worker.emit('message', {
        id, compressed, envelopeMs: 0,
        __componentMetrics: {startedNs: fakeNs(), endedNs: fakeNs()},
    });
}
async function cleanup(dispatcher, pool) {
    pool.close();
    await dispatcher.close();
    assert(dispatcher.physical.every(({worker}) => worker.terminated));
}
async function test(name, callback) {
    await callback();
    testResults.push({name, passed: true});
}

await test('FIFO keeps four physical slots, global queue order and original result order', async () => {
    const {dispatcher, pool} = await setup('B-first-free-fifo');
    const work = operation(pool, 6);
    assert.deepEqual(dispatcher.physical.map(({posted}) => posted), [1, 1, 1, 1]);
    assert.equal(dispatcher.queue.length, 2);
    consume(dispatcher, 3);
    assert.equal(dispatcher.queue.length, 2);
    assert.equal(dispatcher.physical[2].worker.posts.length, 1);
    complete(dispatcher, 3);
    assert.equal(dispatcher.pending.get(5).job.physicalWorker, 2);
    consume(dispatcher, 1); complete(dispatcher, 1);
    assert.equal(dispatcher.pending.get(6).job.physicalWorker, 0);
    for (const id of [6, 2, 5, 4]) { consume(dispatcher, id); complete(dispatcher, id); }
    const result = await work.completion;
    await work.sourceConsumed;
    assert.deepEqual(result.chunks.map((chunk) => chunk[0]), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(dispatcher.queueEvents.filter((event) => event.event === 'dispatch').map(({id}) => id), [1, 2, 3, 4, 5, 6]);
    assert(dispatcher.physical.every(({maximumPosted}) => maximumPosted === 1));
    await cleanup(dispatcher, pool);
});

await test('production metadata snapshot isolates both immediately poisoned caller columns', async () => {
    const {dispatcher, pool} = await setup('B-first-free-fifo');
    const work = operation(pool, 6);
    work.offsets.fill(0xffffffff);
    work.lengths.fill(0xffffffff);
    for (let id = 1; id <= 6; ++id) {
        const pending = dispatcher.pending.get(id);
        assert.deepEqual([...pending.message.sourceOffsets], [id - 1]);
        assert.deepEqual([...pending.message.sourceLengths], [1]);
        consume(dispatcher, id); complete(dispatcher, id);
    }
    await work.completion; await work.sourceConsumed;
    await cleanup(dispatcher, pool);
});

await test('held logical completions do not block FIFO draining or native source barriers', async () => {
    const {dispatcher, pool} = await setup('B-first-free-fifo');
    dispatcher.holdFinalReplies = true;
    const work = operation(pool, 6);
    let completed = false;
    void work.completion.then(() => { completed = true; });
    for (let id = 1; id <= 6; ++id) { consume(dispatcher, id); complete(dispatcher, id); }
    await work.sourceConsumed;
    assert.equal(completed, false);
    assert.equal(dispatcher.heldReplies.length, 6);
    assert.equal(dispatcher.pending.size, 0);
    assert.equal(dispatcher.queue.length, 0);
    work.source.fill(0);
    dispatcher.releaseHeldReplies();
    await work.completion;
    assert.equal(completed, true);
    await cleanup(dispatcher, pool);
});

await test('A and C forward unchanged logical assignments including multiple queued jobs', async () => {
    for (const mode of ['A-rotation', 'C-rotation-control']) {
        const {dispatcher, pool} = await setup(mode);
        const work = operation(pool, 6);
        assert.deepEqual(dispatcher.physical.map(({posted}) => posted), [2, 2, 1, 1]);
        assert.equal(dispatcher.queue.length, 0);
        for (const id of [6, 5, 4, 3, 2, 1]) { consume(dispatcher, id); complete(dispatcher, id); }
        assert.deepEqual((await work.completion).chunks.map((chunk) => chunk[0]), [1, 2, 3, 4, 5, 6]);
        await work.sourceConsumed;
        await cleanup(dispatcher, pool);
    }
});

await test('one worker failure rejects running and queued jobs and both public barriers', async () => {
    const {dispatcher, pool} = await setup('B-first-free-fifo');
    const work = operation(pool, 6);
    const expected = new Error('worker-failure');
    dispatcher.physical[1].worker.emit('error', expected);
    const settled = await Promise.allSettled([work.sourceConsumed, work.completion]);
    assert(settled.every((result) => result.status === 'rejected'));
    assert.equal(pool.failed, true);
    assert.equal(pool._pending.size, 0);
    assert.equal(dispatcher.failure, expected);
    assert.throws(() => operation(pool, 1));
    await cleanup(dispatcher, pool);
});

await test('initialization errors reject readiness before any dispatch and all workers terminate', async () => {
    const dispatcher = new Dispatcher({root: '/runtime', bridgePath: '/bridge.mjs'}, () => 0);
    const pool = new TermContentCompressionPool(dispatcher.logical);
    const starting = dispatcher.start();
    dispatcher.physical[0].worker.emit('message', {type: 'initialization-error', error: 'init-failure'});
    const settled = await Promise.allSettled([starting]);
    assert.equal(settled[0].status, 'rejected');
    assert.equal(dispatcher.jobs.length, 0);
    await cleanup(dispatcher, pool);
});

await test('unexpected worker exit latches failure and rejects queued ownership', async () => {
    const {dispatcher, pool} = await setup('B-first-free-fifo');
    const work = operation(pool, 6);
    dispatcher.physical[0].worker.emit('exit', 7);
    const settled = await Promise.allSettled([work.sourceConsumed, work.completion]);
    assert(settled.every((result) => result.status === 'rejected'));
    assert.equal(pool._pending.size, 0);
    assert.match(String(dispatcher.failure), /exited unexpectedly: 7/);
    await cleanup(dispatcher, pool);
});


await test('idle failure after the final successful output rejects the exact terminal acceptance gate', async () => {
    const {dispatcher, pool} = await setup('B-first-free-fifo');
    const work = operation(pool, 1);
    consume(dispatcher, 1); complete(dispatcher, 1);
    assert.deepEqual((await work.completion).chunks.map((chunk) => chunk[0]), [1]);
    await work.sourceConsumed;
    assert.equal(pool._pending.size, 0);
    dispatcher.physical[0].worker.emit('exit', 7);
    const report = {}, witness = {};
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const finish = new AsyncFunction(
        'dispatcher', 'pool', 'report', 'witness', 'assert',
        'let workersTerminated = false; try {\n' + terminalSource +
        '\n} finally { witness.workersTerminated = workersTerminated; }',
    );
    let rejection = null;
    try { await finish(dispatcher, pool, report, witness, assert); }
    catch (error) { rejection = error; }
    assert(rejection, 'A terminal idle-worker failure must invalidate the cohort');
    assert.equal(witness.workersTerminated, true, 'The ownership flag is set before the acceptance assertion');
    assert(dispatcher.physical.every(({worker}) => worker.terminated));
    assert.equal(report.compressionWorkersFinalState.workerCount, 4);
    assert.equal(report.compressionWorkersFinalState.allTerminated, true);
    assert.match(report.compressionWorkersFinalState.failure.message, /exited unexpectedly: 7/);
});

return testResults;

})();
console.log(JSON.stringify({complete: true, scope: 'Deterministic fake transport with the actual frozen production pool and native Node SharedArrayBuffer; no codec timing.', tests: results}, null, 2));
