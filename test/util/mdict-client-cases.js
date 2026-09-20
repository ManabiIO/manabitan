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
import {setImmediate as tick} from 'node:timers/promises';
import {afterEach, beforeEach, test} from 'node:test';
import {Mdx} from '../../ext/js/comm/mdx.js';

const originalWorker = globalThis.Worker;
/** @type {FakeWorker[]} */
let workers = [];
let autoComplete = true;

class FakeWorker {
    /** */
    constructor() {
        /** @type {Map<string, Array<(event: {data: unknown}) => void>>} */
        this.listeners = new Map();
        this.terminated = false;
        workers.push(this);
    }

    /**
     * @param {string} name
     * @param {(event: {data: unknown}) => void} listener
     */
    addEventListener(name, listener) {
        const listeners = this.listeners.get(name) ?? [];
        listeners.push(listener);
        this.listeners.set(name, listeners);
    }

    /** */
    postMessage() {
        if (autoComplete) {
            queueMicrotask(() => this.emit({action: 'complete', params: {result: {archiveContent: new ArrayBuffer(1), archiveFileName: 'fixture.zip'}}}));
        }
    }

    /** @param {unknown} data */
    emit(data) {
        for (const listener of this.listeners.get('message') ?? []) { listener({data}); }
    }

    /** */
    terminate() { this.terminated = true; }
}

beforeEach(() => {
    workers = [];
    autoComplete = true;
    globalThis.Worker = /** @type {typeof Worker} */ (/** @type {unknown} */ (FakeWorker));
});
afterEach(() => {
    globalThis.Worker = originalWorker;
});

/** @returns {{file: File, release: () => void}} */
function delayedFile() {
    let release = () => {};
    const pending = new Promise((resolve) => { release = () => resolve(new ArrayBuffer(1)); });
    const file = new File(['x'], 'fixture.mdx');
    Object.defineProperty(file, 'arrayBuffer', {value: () => pending});
    return {file, release};
}

/**
 * @param {Promise<unknown>} promise
 * @returns {{state: string, done: Promise<void>}}
 */
function observe(promise) {
    const result = {state: 'pending', done: Promise.resolve()};
    result.done = promise.then(() => { result.state = 'resolved'; }, (error) => { result.state = String(error.message); });
    return result;
}

test('disconnect during MDX upload rejects promptly and never starts a worker', async () => {
    const mdx = new Mdx();
    const {file, release} = delayedFile();
    const progress = [];
    const result = observe(mdx.convertDictionary({mdxFile: file}, (details) => progress.push(details)));
    try {
        assert.equal(mdx.isActive(), true);
        mdx.disconnect();
        await tick();
        assert.equal(result.state, 'MDX conversion cancelled');
        release();
        await tick();
        assert.equal(workers.length, 0);
        assert.equal(progress.length, 0);
        assert.equal(mdx.isActive(), false);
    } finally {
        release();
        await tick();
        mdx.disconnect();
        await result.done;
    }
});

test('disconnect during MDD upload does not read later assets', async () => {
    const mdx = new Mdx();
    const {file, release} = delayedFile();
    let laterReads = 0;
    const later = new File(['z'], 'later.mdd');
    Object.defineProperty(later, 'arrayBuffer', {value: async () => { laterReads += 1; return new ArrayBuffer(1); }});
    const result = observe(mdx.convertDictionary({mdxFile: new File(['x'], 'fixture.mdx'), mddFiles: [file, later]}));
    try {
        await tick();
        mdx.disconnect();
        await tick();
        assert.equal(result.state, 'MDX conversion cancelled');
        release();
        await tick();
        assert.equal(laterReads, 0);
        assert.equal(workers.length, 0);
    } finally {
        release();
        await tick();
        mdx.disconnect();
        await result.done;
    }
});

test('disconnect from upload progress prevents worker creation', async () => {
    const mdx = new Mdx();
    const result = observe(mdx.convertDictionary({mdxFile: new File(['x'], 'fixture.mdx')}, () => mdx.disconnect()));
    await result.done;
    assert.equal(result.state, 'MDX conversion cancelled');
    assert.equal(workers.length, 0);
});

test('new conversion supersedes a pending upload without being cancelled by it', async () => {
    const mdx = new Mdx();
    const {file, release} = delayedFile();
    const first = observe(mdx.convertDictionary({mdxFile: file}));
    const second = observe(mdx.convertDictionary({mdxFile: new File(['y'], 'new.mdx')}));
    try {
        await second.done;
        await tick();
        assert.equal(first.state, 'MDX conversion cancelled');
        assert.equal(second.state, 'resolved');
        release();
        await tick();
        assert.equal(workers.length, 1);
        assert.equal(mdx.isActive(), false);
    } finally {
        release();
        await tick();
        mdx.disconnect();
        await first.done;
    }
});

test('queued worker progress is ignored after cancellation', async () => {
    autoComplete = false;
    const mdx = new Mdx();
    const progress = [];
    const result = observe(mdx.convertDictionary({mdxFile: new File(['x'], 'fixture.mdx')}, (details) => progress.push(details)));
    await tick();
    assert.equal(workers.length, 1);
    mdx.disconnect();
    const count = progress.length;
    workers[0].emit({action: 'progress', params: {details: {stage: 'convert', completed: 1, total: 1}}});
    await result.done;
    assert.equal(result.state, 'MDX conversion cancelled');
    assert.equal(progress.length, count);
    assert.equal(workers[0].terminated, true);
});

test('failed upload clears state and permits a later successful conversion', async () => {
    const mdx = new Mdx();
    const file = new File(['x'], 'fixture.mdx');
    Object.defineProperty(file, 'arrayBuffer', {value: async () => { throw new Error('file read failed'); }});
    await assert.rejects(mdx.convertDictionary({mdxFile: file}), /file read failed/u);
    assert.equal(mdx.isActive(), false);
    const result = await mdx.convertDictionary({mdxFile: new File(['y'], 'new.mdx')});
    assert.equal(result.archiveFileName, 'fixture.zip');
    assert.equal(workers.length, 1);
});

test('successful MDX/MDD upload completes and releases its worker', async () => {
    const mdx = new Mdx();
    const result = await mdx.convertDictionary({mdxFile: new File(['x'], 'fixture.mdx'), mddFiles: [new File(['y'], 'fixture.mdd')]});
    assert.equal(result.archiveContent.byteLength, 1);
    assert.equal(workers.length, 1);
    assert.equal(workers[0].terminated, true);
    assert.equal(mdx.isActive(), false);
});
