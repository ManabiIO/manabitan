/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, test} from 'vitest';
import {TermContentImmutableFileStore} from '../ext/js/dictionary/term-content-immutable-file-store.js';
import {TermContentOptimizationArtifacts} from '../ext/js/dictionary/term-content-optimization-artifacts.js';
import {createTermContentOptimizationCheckpoint} from '../ext/js/dictionary/term-content-optimization-controller.js';

class MemoryStore extends TermContentImmutableFileStore {
    constructor() {
        super();
        /** @type {Uint8Array|null} */
        this.bytes = null;
        this.writes = 0;
        this.removals = 0;
        /** @type {() => void} */
        this.afterObserve = () => {};
        /** @type {Error|null} */
        this.readError = null;
    }

    /**
     *
     * @param {string} fileId
     * @returns {Promise<number|null>}
     */
    async observe(fileId) {
        const result = this.bytes?.byteLength ?? null;
        this.afterObserve();
        return result;
    }

    /**
     *
     * @param {string} fileId
     * @param {number} expected
     * @param {number} offset
     * @param {number} length
     * @returns {Promise<Uint8Array>}
     */
    async readSlice(fileId, expected, offset, length) {
        if (this.readError !== null) { throw this.readError; }
        if (this.bytes === null || this.bytes.byteLength !== expected) { throw new Error('Missing file'); }
        return this.bytes.slice(offset, offset + length);
    }

    /**
     *
     * @param {string} fileId
     * @param {AsyncIterable<Uint8Array>|Iterable<Uint8Array>} chunks
     * @param {{expectedByteLength: number}} options
     * @returns {Promise<number>}
     */
    async write(fileId, chunks, {expectedByteLength}) {
        expect(this.bytes === null || this.bytes.byteLength === 0).toBe(true);
        const output = new Uint8Array(expectedByteLength);
        let cursor = 0;
        for await (const chunk of chunks) {
            output.set(chunk, cursor);
            cursor += chunk.byteLength;
        }
        expect(cursor).toBe(expectedByteLength);
        this.bytes = output;
        ++this.writes;
        return cursor;
    }

    /**
     *
     * @param {string} fileId
     * @returns {Promise<void>}
     */
    async remove(fileId) {
        ++this.removals;
        this.bytes = null;
    }
}

function fixture() {
    const store = new MemoryStore();
    /** @type {import('../ext/js/dictionary/term-content-optimization-controller.js').OptimizationJob} */
    const job = {jobId: 'job',
        dictionaryTitle: 'Test',
        dictionaryGeneration: 'generation',
        strategyVersion: 'strategy',
        phase: 'sample',
        checkpointVersion: 0,
        retryAfter: null,
        checkpoint: createTermContentOptimizationCheckpoint('generation:strategy', {dictionaryCapacity: 16384, strategy: 0, level: 1})};
    /** @type {import('../ext/js/dictionary/term-content-optimization-artifacts.js').ArtifactObservation} */
    const observation = {fileId: 'job-sample-0', ownerJobId: 'job', state: 'intent', byteLength: 0, sha256: null};
    const controller = new AbortController();
    const io = new TermContentOptimizationArtifacts({store,
        lookup: () => observation,
        assertOwned: (value) => {
            expect(value).toBe(job);
            if (value.checkpointVersion !== 0) { throw new Error('Stale job'); }
        }});
    return {store, job, observation, controller, io};
}

test.each([null, new Uint8Array(0)])('creates an owned empty artifact once and reuses closed bytes', async (initial) => {
    const f = fixture();
    f.store.bytes = initial;
    const bytes = new Uint8Array([1, 2, 3]);
    await f.io.write(f.job, 'job-sample-0', bytes, f.controller.signal);
    bytes[0] = 7;
    expect(await f.io.read(f.job, 'job-sample-0', f.controller.signal)).toEqual(new Uint8Array([1, 2, 3]));
    await f.io.write(f.job, 'job-sample-0', new Uint8Array([1, 2, 3]), f.controller.signal);
    expect(f.store.writes).toBe(1);
    expect(f.store.removals).toBe(0);
});

test('discards only an owned partial intent before replay', async () => {
    const f = fixture();
    f.store.bytes = new Uint8Array([9]);
    await f.io.write(f.job, 'job-sample-0', new Uint8Array([1, 2, 3]), f.controller.signal);
    expect(f.store.removals).toBe(1);
    expect(f.store.writes).toBe(1);
    expect(f.store.bytes).toEqual(new Uint8Array([1, 2, 3]));
});

test.each(['missing', 'changed-size', 'changed-bytes'])('never replaces a sealed artifact: %s', async (fault) => {
    const f = fixture();
    Object.assign(f.observation, {state: 'staged', byteLength: 3, sha256: 'a'.repeat(64)});
    f.store.bytes = fault === 'missing' ? null : new Uint8Array(fault === 'changed-size' ? [1] : [9, 8, 7]);
    await expect(f.io.write(f.job, 'job-sample-0', new Uint8Array([1, 2, 3]), f.controller.signal)).rejects.toThrow();
    expect(f.store.removals).toBe(0);
    expect(f.store.writes).toBe(0);
});

test('a transient read failure does not erase an unpublished artifact', async () => {
    const f = fixture();
    f.store.bytes = new Uint8Array([1, 2, 3]);
    f.store.readError = new Error('Temporary I/O failure');
    await expect(f.io.write(f.job, 'job-sample-0', new Uint8Array([1, 2, 3]), f.controller.signal)).rejects.toThrow('Temporary I/O');
    expect(f.store.removals).toBe(0);
    expect(f.store.writes).toBe(0);
});

test.each(['preempted', 'stale-job', 'foreign-file'])('rechecks ownership after observation: %s', async (fault) => {
    const f = fixture();
    f.store.bytes = new Uint8Array([9]);
    f.store.afterObserve = () => {
        if (fault === 'preempted') { f.controller.abort(); }
        if (fault === 'stale-job') { ++f.job.checkpointVersion; }
        if (fault === 'foreign-file') { f.observation.ownerJobId = 'other'; }
    };
    await expect(f.io.write(f.job, 'job-sample-0', new Uint8Array([1, 2, 3]), f.controller.signal)).rejects.toThrow();
    expect(f.store.removals).toBe(0);
    expect(f.store.writes).toBe(0);
});
