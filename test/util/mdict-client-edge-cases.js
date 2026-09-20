/*
 * Copyright (C) 2026  Yomitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import assert from 'node:assert/strict';
import {afterEach, beforeEach, test} from 'node:test';
import {setImmediate as tick} from 'node:timers/promises';
import {Mdx} from '../../ext/js/comm/mdx.js';

/** @typedef {{data?: unknown, message?: string}} WorkerEvent */
/** @typedef {{mdxBytes: ArrayBuffer, mddFiles: Array<{name: string, bytes: ArrayBuffer}>, options: {enableAudio: boolean, includeAssets: boolean}}} RequestParams */
/** @typedef {{state: 'pending'|'resolved'|'rejected', error: unknown, done: Promise<void>}} Observation */

const originalWorker = globalThis.Worker;
/** @type {TestWorker[]} */
let workers = [];
/** @type {Mdx[]} */
let clients = [];
/** @type {Error|null} */
let constructionError = null;
/** @type {Error|null} */
let postingError = null;

class TestWorker {
    /** */
    constructor() {
        if (constructionError !== null) { throw constructionError; }
        /** @type {Map<string, (event: WorkerEvent) => void>} */
        this.listeners = new Map();
        /** @type {RequestParams|null} */
        this.params = null;
        /** @type {Transferable[]} */
        this.transfer = [];
        this.terminations = 0;
        workers.push(this);
    }

    /**
     * @param {string} name
     * @param {(event: WorkerEvent) => void} callback
     */
    addEventListener(name, callback) { this.listeners.set(name, callback); }

    /**
     * @param {{params: RequestParams}} message
     * @param {Transferable[]} transfer
     */
    postMessage(message, transfer) {
        if (postingError !== null) { throw postingError; }
        this.params = message.params;
        this.transfer = transfer;
    }

    /** */
    terminate() { ++this.terminations; }

    /** @param {unknown} data */
    emit(data) { this.listeners.get('message')?.({data}); }

    /** */
    complete() {
        this.emit({action: 'complete', params: {result: {archiveContent: new ArrayBuffer(1)}}});
    }
}

beforeEach(() => {
    workers = [];
    clients = [];
    constructionError = null;
    postingError = null;
    globalThis.Worker = /** @type {typeof Worker} */ (/** @type {unknown} */ (TestWorker));
});
afterEach(() => {
    for (const client of clients) { client.disconnect(); }
    globalThis.Worker = originalWorker;
});

/** @returns {Mdx} */
function createClient() {
    const client = new Mdx();
    clients.push(client);
    return client;
}

/**
 * @param {string} [name]
 * @returns {File}
 */
function createFile(name = 'Book.mdx') { return new File(['x'], name); }

/**
 * @param {string} [name]
 * @returns {{file: File, resolve: () => void, reject: () => void}}
 */
function delayedFile(name = 'Book.mdx') {
    let resolve = () => {};
    let reject = () => {};
    const pending = new Promise((resolvePromise, rejectPromise) => {
        resolve = () => resolvePromise(new ArrayBuffer(1));
        reject = () => rejectPromise(new Error('late read error'));
    });
    const file = createFile(name);
    Object.defineProperty(file, 'arrayBuffer', {value: () => pending});
    return {file, resolve, reject};
}

/**
 * @param {Promise<unknown>} promise
 * @returns {Observation}
 */
function observe(promise) {
    /** @type {Observation} */
    const result = {state: 'pending', error: null, done: Promise.resolve()};
    result.done = promise.then(
        () => { result.state = 'resolved'; },
        (error) => {
            result.state = 'rejected';
            result.error = error;
        },
    );
    return result;
}

/**
 * @param {Mdx} [client]
 * @param {Parameters<Mdx['convertDictionary']>[1]} [onProgress]
 * @returns {Promise<{client: Mdx, result: Observation, worker: TestWorker}>}
 */
async function start(client = createClient(), onProgress = null) {
    const result = observe(client.convertDictionary({mdxFile: createFile()}, onProgress));
    await tick();
    const worker = workers.at(-1);
    assert.ok(worker);
    return {client, result, worker};
}

for (const boundary of ['mdx', 'mdd']) {
    test(`cancellation between fulfilled ${boundary.toUpperCase()} read and its continuation starts no next read`, async () => {
        const client = createClient();
        let nextReads = 0;
        const nextFile = createFile('Book.1.mdd');
        Object.defineProperty(nextFile, 'arrayBuffer', {value: async () => {
            ++nextReads;
            return new ArrayBuffer(1);
        }});
        const mddFiles = boundary === 'mdx' ? [nextFile] : [createFile('Book.mdd'), nextFile];
        const result = observe(client.convertDictionary({mdxFile: createFile(), mddFiles}, ({completed}) => {
            if (completed === (boundary === 'mdx' ? 1 : 2)) {
                // Runs after readFile has returned bytes but before prepare resumes.
                queueMicrotask(() => client.disconnect());
            }
        }));
        await tick();
        assert.equal(result.state, 'rejected');
        assert.equal(nextReads, 0);
        assert.equal(workers.length, 0);
    });
}

test('caller mutation cannot add resources after conversion has started', async () => {
    const client = createClient();
    const input = delayedFile();
    const resources = [createFile('Book.mdd')];
    const result = observe(client.convertDictionary({mdxFile: input.file, mddFiles: resources}));
    resources.push(createFile('Unrelated.mdd'));
    input.resolve();
    await tick();
    assert.ok(workers[0].params);
    assert.deepEqual(workers[0].params.mddFiles.map(({name}) => name), ['Book.mdd']);
    workers[0].complete();
    await result.done;
    assert.equal(result.state, 'resolved');
});

test('throwing worker-progress callback rejects immediately and terminates once', async () => {
    const expected = new Error('progress rendering failed');
    const {client, result, worker} = await start(createClient(), ({stage}) => {
        if (stage === 'convert') { throw expected; }
    });
    assert.doesNotThrow(() => worker.emit({action: 'progress', params: {details: {stage: 'convert', completed: 1, total: 2}}}));
    await tick();
    assert.equal(result.error, expected);
    assert.equal(client.isActive(), false);
    assert.equal(client.isConnected(), false);
    assert.equal(worker.terminations, 1);
    client.disconnect();
    worker.complete();
    assert.equal(worker.terminations, 1);
});

test('progress can supersede a worker and then throw without cancelling its replacement', async () => {
    const client = createClient();
    /** @type {Observation|null} */
    let replacement = null;
    const {result, worker} = await start(client, ({stage}) => {
        if (stage === 'convert') {
            replacement = observe(client.convertDictionary({mdxFile: createFile('Next.mdx')}));
            throw new Error('old callback failed');
        }
    });
    assert.doesNotThrow(() => worker.emit({action: 'progress', params: {details: {stage: 'convert', completed: 1, total: 2}}}));
    await tick();
    assert.equal(result.state, 'rejected');
    assert.equal(client.isActive(), true);
    assert.equal(workers.length, 2);
    assert.equal(workers[1].terminations, 0);
    workers[1].complete();
    await tick();
    assert.equal(/** @type {Observation|null} */ (replacement)?.state, 'resolved');
});

for (const extension of ['mdx', 'mdd']) {
    test(`timeout covers pending ${extension.toUpperCase()} reads without starting late workers`, async (context) => {
        context.mock.timers.enable({apis: ['setTimeout']});
        const client = createClient();
        const input = delayedFile(`Book.${extension}`);
        const details = extension === 'mdx' ? {mdxFile: input.file} : {mdxFile: createFile(), mddFiles: [input.file]};
        const result = observe(client.convertDictionary(details));
        await tick();
        context.mock.timers.tick(180_000);
        await tick();
        assert.equal(result.state, 'rejected');
        assert.match(String(result.error), /timed out/u);
        input.resolve();
        await tick();
        assert.equal(workers.length, 0);
        assert.equal(client.isActive(), false);
    });
}

test('file reads and worker conversion share one timeout budget', async (context) => {
    context.mock.timers.enable({apis: ['setTimeout']});
    const client = createClient();
    const input = delayedFile();
    const result = observe(client.convertDictionary({mdxFile: input.file}));
    context.mock.timers.tick(170_000);
    input.resolve();
    await tick();
    assert.equal(result.state, 'pending');
    assert.equal(workers.length, 1);
    context.mock.timers.tick(10_000);
    await tick();
    assert.equal(result.state, 'rejected');
    assert.equal(workers[0].terminations, 1);
});

test('an old timeout cannot expire a replacement conversion', async (context) => {
    context.mock.timers.enable({apis: ['setTimeout']});
    const first = await start();
    context.mock.timers.tick(100_000);
    const second = await start(first.client);
    context.mock.timers.tick(80_000);
    await tick();
    assert.equal(first.result.state, 'rejected');
    assert.equal(second.result.state, 'pending');
    assert.equal(second.worker.terminations, 0);
    second.worker.complete();
    await second.result.done;
    context.mock.timers.tick(180_000);
    assert.equal(second.result.state, 'resolved');
    assert.equal(second.worker.terminations, 1);
});

for (const [completed, total] of [[-1, 1], [1, -1], [2, 1], [Number.NaN, 1], [1, Infinity]]) {
    test(`invalid worker progress ${completed}/${total} rejects instead of poisoning UI state`, async () => {
        const {result, worker, client} = await start();
        worker.emit({action: 'progress', params: {details: {stage: 'convert', completed, total}}});
        await tick();
        assert.equal(result.state, 'rejected');
        assert.match(String(result.error), /malformed message/u);
        assert.equal(worker.terminations, 1);
        assert.equal(client.isActive(), false);
    });
}

for (const [completed, total] of [[0, 0], [0, 2], [2, 2]]) {
    test(`valid worker progress ${completed}/${total} remains accepted`, async () => {
        const {result, worker} = await start();
        worker.emit({action: 'progress', params: {details: {stage: 'convert', completed, total}}});
        worker.complete();
        await result.done;
        assert.equal(result.state, 'resolved');
    });
}

test('a late rejected read after timeout cannot alter a fresh conversion', async (context) => {
    context.mock.timers.enable({apis: ['setTimeout']});
    const client = createClient();
    const input = delayedFile();
    const old = observe(client.convertDictionary({mdxFile: input.file}));
    context.mock.timers.tick(180_000);
    await tick();
    assert.equal(old.state, 'rejected');
    const fresh = await start(client);
    input.reject();
    await tick();
    assert.equal(fresh.result.state, 'pending');
    assert.equal(fresh.worker.terminations, 0);
    fresh.worker.complete();
    await fresh.result.done;
    assert.equal(fresh.result.state, 'resolved');
});

for (const stage of ['construction', 'posting']) {
    test(`${stage} failure releases client state and allows a retry`, async () => {
        const expected = new Error(`${stage} failed`);
        if (stage === 'construction') {
            constructionError = expected;
        } else {
            postingError = expected;
        }
        const client = createClient();
        await assert.rejects(client.convertDictionary({mdxFile: createFile()}), expected);
        assert.equal(client.isActive(), false);
        assert.equal(client.isConnected(), false);
        constructionError = null;
        postingError = null;
        const fresh = await start(client);
        fresh.worker.complete();
        await fresh.result.done;
        assert.equal(fresh.result.state, 'resolved');
    });
}

for (const eventName of ['error', 'messageerror']) {
    test(`worker ${eventName} cleans up and ignores subsequent completion`, async () => {
        const {result, worker, client} = await start();
        worker.listeners.get(eventName)?.({message: 'worker failed'});
        worker.complete();
        await result.done;
        assert.equal(result.state, 'rejected');
        assert.equal(client.isActive(), false);
        assert.equal(worker.terminations, 1);
    });
}

test('invalid file result fails before creating a worker', async () => {
    const client = createClient();
    const file = createFile();
    Object.defineProperty(file, 'arrayBuffer', {value: async () => 'not an ArrayBuffer'});
    const result = observe(client.convertDictionary({mdxFile: file}));
    await tick();
    assert.equal(result.state, 'rejected');
    assert.equal(workers.length, 0);
});

test('success transfers original buffers and preserves conversion defaults', async () => {
    const client = createClient();
    const result = observe(client.convertDictionary({mdxFile: createFile(), mddFiles: [createFile('Book.mdd')]}));
    await tick();
    const worker = workers[0];
    assert.ok(worker.params);
    assert.equal(worker.transfer[0], worker.params.mdxBytes);
    assert.equal(worker.transfer[1], worker.params.mddFiles[0].bytes);
    assert.equal(worker.params.options.enableAudio, false);
    assert.equal(worker.params.options.includeAssets, true);
    worker.complete();
    await result.done;
    assert.equal(result.state, 'resolved');
});
