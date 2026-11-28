/*
 * Copyright (C) 2026 Manabitan authors
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

import {expect, test} from 'vitest';
import {encodeRawTermContentCompactBlockReference} from '../ext/js/dictionary/raw-term-content.js';
import {ZstdTrainingCorpusError, ZstdTrainingResourceError} from '../ext/js/dictionary/zstd-trainer-worker-owner.js';
import {createTermContentOptimizationCheckpoint, TermContentOptimizationController, TermContentOptimizationIntegrityError, TermContentOptimizationResourceError, TermContentOptimizationUnsupportedFrameError} from '../ext/js/dictionary/term-content-optimization-controller.js';
import {completeTrainingSampleSelection, observeTrainingFrame, planTrainingSampleStep, startTrainingSampleSelection} from '../ext/js/dictionary/term-content-training-sampler.js';

/** @typedef {import('../ext/js/dictionary/term-content-optimization-controller.js').OptimizationHost} Host */
/** @typedef {import('../ext/js/dictionary/term-content-optimization-controller.js').OptimizationJob} Job */
/** @typedef {import('../ext/js/dictionary/term-content-optimization-controller.js').OptimizationCheckpoint} State */
/** @typedef {import('../ext/js/dictionary/term-content-optimization-controller.js').OptimizationPhase} Phase */
/** @typedef {import('../ext/js/dictionary/term-content-optimization-controller.js').CheckpointFile} CheckpointFile */
/** @typedef {import('../ext/js/dictionary/term-content-optimization-controller.js').Trainer} Trainer */
/** @typedef {import('../ext/js/dictionary/term-content-optimization-checkpoint.js').OnlineContentFrameDescriptor} Frame */

const parameters = {dictionaryCapacity: 16384, strategy: 1, level: 1};
const identity = 'generation:window64k-f18-d16-v1';

/**
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<string>}
 */
async function digest(bytes) {
    return [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 *
 * @param {number} [offset]
 * @returns {Frame}
 */
function frame(offset = 0) {
    return {identity: {kind: 'block',
        logicalOffset: offset,
        recordLength: 100,
        sourceStoredLength: 100,
        originalCodecId: null,
        expectedDecodedLength: 65536,
        originalEnvelope: 'mbc2'},
    physicalKey: 'pack:' + offset,
    storedLength: 100,
    codecId: null,
    envelope: 'mbc2',
    decodedLength: 65536,
    decodedDigest: null};
}

/**
 *
 * @param {Phase} phase
 * @param {Partial<State>} [patch]
 * @returns {Job}
 */
function makeJob(phase, patch = {}) {
    return {jobId: 'job',
        dictionaryTitle: 'Title',
        dictionaryGeneration: 'generation',
        strategyVersion: 'window64k-f18-d16-v1',
        phase,
        checkpoint: {...createTermContentOptimizationCheckpoint(identity, parameters), ...patch},
        checkpointVersion: 0,
        retryAfter: null};
}

/**
 *
 * @param {Phase} [phase]
 * @param {Partial<State>} [patch]
 * @returns {{state: {job: Job|null, current: boolean, now: number, reclaimDone: boolean, lateAck: boolean, published: number, closed: number, staged: number, writes: number}, host: Host, files: Map<string, Uint8Array>, intents: Set<string>, frames: Frame[], events: string[], controller: (trainer?: Trainer) => TermContentOptimizationController}}
 */
function fixture(phase = 'discover', patch = {}) {
    const state = {job: /** @type {Job|null} */ (makeJob(phase, patch)),
        current: true,
        now: 100000,
        reclaimDone: true,
        lateAck: false,
        published: 0,
        closed: 0,
        staged: 0,
        writes: 0};
    /** @type {Map<string, Uint8Array>} */
    const files = new Map();
    /** @type {Set<string>} */
    const intents = new Set();
    /** @type {Frame[]} */
    const frames = [];
    /** @type {string[]} */
    const events = [];
    /** @type {Host} */
    const host = {
        getJob: () => state.job,
        findCandidate: () => null,
        createJob: (job) => { state.job = structuredClone(job); return state.job; },
        assertOwned: (job) => {
            if (state.job === null || state.job.jobId !== job.jobId || state.job.checkpointVersion !== job.checkpointVersion) {
                throw new Error('Stale owner');
            }
        },
        isTargetCurrent: () => state.current,
        save: (job, nextPhase, checkpoint, effects = {}, retryAfter = null) => {
            host.assertOwned(job);
            if (['completed', 'no-gain', 'failed'].includes(nextPhase) && intents.size > 0) { throw new Error('Unreclaimed files'); }
            events.push('save:' + nextPhase);
            for (const id of effects.reserveFileIds ?? []) {
                intents.add(id);
                events.push('intent:' + id);
            }
            for (const item of effects.frames ?? []) {
                if (!frames.some((entry) => entry.identity.logicalOffset === item.identity.logicalOffset)) { frames.push(item); }
            }
            state.job = {...job, phase: nextPhase, checkpoint: structuredClone(checkpoint), checkpointVersion: job.checkpointVersion + 1, retryAfter};
            return state.job;
        },
        acquireSource: () => ({source: {logicalHighWater: 4096,
            assertCurrent: () => {
                if (!state.current) { throw new Error('Stale generation'); }
            },
            readSlice: async () => null,
            describe: async () => frame(),
            findOverride: async () => null},
        close: async () => { ++state.closed; }}),
        readDiscovery: async () => ({item: null, cursor: null, done: true}),
        framePage: (job, cursor) => {
            host.assertOwned(job);
            const index = cursor === null ? 0 : Number(cursor);
            return {frame: frames[index] ?? null, cursor: index + 1};
        },
        readSample: async (job, request) => new Uint8Array(request.length).fill(request.sampleIndex + 1),
        writeFile: async (job, id, bytes) => {
            host.assertOwned(job);
            if (!intents.has(id)) { throw new Error('Write before intent'); }
            events.push('write:' + id);
            ++state.writes;
            files.set(id, new Uint8Array(bytes));
        },
        readFile: async (job, file) => {
            host.assertOwned(job);
            const bytes = files.get(file.fileId);
            if (!bytes) { throw new Error('Missing checkpoint file'); }
            return new Uint8Array(bytes);
        },
        planBatch: async () => ({id: 'batch-1', fileIds: ['pack-1'], token: {sourceLayoutIds: ['layout-1']}, nextCursor: 1, last: false}),
        stageBatch: async (job, batch) => {
            host.assertOwned(job);
            if (batch.fileIds.some((id) => !intents.has(id))) { throw new Error('Stage before intent'); }
            ++state.staged;
            events.push('stage:' + batch.id);
        },
        verificationPage: async () => ({original: Uint8Array.of(1, 2), replacement: Uint8Array.of(1, 2), cursor: 2, done: true}),
        measureBatch: () => ({beforeBytes: 50000, afterBytes: 10000}),
        publishBatch: (job, batch, next) => {
            host.assertOwned(job);
            if (!state.current) { throw new Error('Stale generation'); }
            events.push('publish:' + batch.id);
            ++state.published;
            for (const id of batch.fileIds) { intents.delete(id); }
            state.job = {...job, phase: 'reclaim', checkpoint: structuredClone(next), checkpointVersion: job.checkpointVersion + 1, retryAfter: null};
            if (state.lateAck) { throw new Error('Commit acknowledged late'); }
            return state.job;
        },
        reclaimStep: async (job) => {
            host.assertOwned(job);
            events.push('reclaim');
            if (state.reclaimDone) {
                for (const id of job.checkpoint.batch?.fileIds ?? []) {
                    intents.delete(id);
                    files.delete(id);
                }
                if (job.checkpoint.afterReclaim !== 'recompress') {
                    intents.clear();
                    files.clear();
                }
            }
            return {job, done: state.reclaimDone, ...(state.reclaimDone ? {} : {retryAt: state.now + 1000})};
        },
    };
    /**
     *
     * @param {Trainer} [trainer]
     * @returns {TermContentOptimizationController}
     */
    const controller = (trainer) => new TermContentOptimizationController({host,
        strategyVersion: 'window64k-f18-d16-v1',
        ...parameters,
        now: () => state.now,
        ...(trainer ? {createTrainer: () => trainer} : {})});
    return {state, host, files, intents, frames, events, controller};
}

/**
 *
 * @param {ReturnType<typeof fixture>} f
 * @returns {Promise<CheckpointFile>}
 */
async function dictionary(f) {
    await seedTrainingSamples(f);
    const bytes = new Uint8Array(1024).fill(3);
    const file = {fileId: 'job-dictionary', byteLength: bytes.length, sha256: await digest(bytes)};
    f.files.set(file.fileId, bytes);
    f.intents.add(file.fileId);
    if (f.state.job === null) { throw new Error('Missing fixture job'); }
    f.state.job.checkpoint.dictionary = file;
    return file;
}

/**
 *
 * @param {'write'|'verify'|'publish'} stage
 * @param {boolean} [last]
 * @returns {NonNullable<State['batch']>}
 */
function batch(stage, last = false) {
    return {id: 'batch-1', fileIds: ['pack-1'], token: {sourceLayoutIds: ['layout-1']}, nextCursor: 1, last, stage, verifyCursor: null};
}

/** @returns {AbortSignal} */
function signal() { return new AbortController().signal; }

test('a simultaneous idle step cannot reserve a second owner while discovery is awaiting I/O', async () => {
    const f = fixture();
    /** @type {(value: {item: null, cursor: null, done: boolean}) => void} */
    let release = () => {};
    f.host.readDiscovery = async () => await new Promise((resolve) => { release = resolve; });
    const controller = f.controller();
    const active = controller.runStep(signal());
    await expect(controller.runStep(signal())).rejects.toThrow('already has a running step');
    release({item: null, cursor: null, done: true});
    await active;
    expect(f.state.job?.checkpointVersion).toBe(1);
});

test('foreground preemption after a metadata read preserves the old durable cursor', async () => {
    const f = fixture();
    const abort = new AbortController();
    f.host.readDiscovery = async () => {
        abort.abort();
        return {item: null, cursor: 10, done: true};
    };
    await expect(f.controller().runStep(abort.signal)).rejects.toMatchObject({name: 'AbortError'});
    expect(f.state.job).toMatchObject({phase: 'discover', checkpointVersion: 0, checkpoint: {discoveryCursor: null}});
});

test('a generation change during frame inspection closes its lease and cannot record a frame', async () => {
    const f = fixture('discover', {pendingDiscovery: {item: {kind: 'artifact',
        artifact: {contentOffset: 0,
            contentLength: 100,
            contentDictName: 'raw-v4',
            uncompressedLength: 65536}},
    nextCursor: 1,
    done: true,
    inspection: null}});
    const acquire = f.host.acquireSource;
    f.host.acquireSource = (job, activeSignal) => {
        const result = acquire(job, activeSignal);
        result.source.describe = async () => {
            f.state.current = false;
            return frame();
        };
        return result;
    };
    await expect(f.controller().runStep(signal())).rejects.toThrow('Stale generation');
    expect(f.state.closed).toBe(1);
    expect(f.frames).toHaveLength(0);
    expect(f.state.job?.checkpoint.resumePhase).toBe('discover');
    f.state.now += 30000;
    await f.controller().runStep(signal());
    expect(f.state.job).toMatchObject({phase: 'reclaim', checkpoint: {afterReclaim: 'failed'}});
});

test('restart resumes a persisted sample intent without advancing its sampler before readback', async () => {
    const f = fixture('sample');
    f.frames.push(frame());
    const sampler = observeTrainingFrame(
        createTermContentOptimizationCheckpoint(identity, parameters).sampler,
        {key: 'pack:0', offset: 0, length: 65536},
    );
    const selected = startTrainingSampleSelection(sampler);
    if (f.state.job === null) { throw new Error('Missing fixture job'); }
    f.state.job.checkpoint = {...f.state.job.checkpoint, sampler: selected, sampleMode: 'select'};
    const abort = new AbortController();
    await f.controller().runStep(signal());
    expect(f.state.job?.checkpoint.pendingSample?.fileId).toBe('job-sample-0');
    expect(f.state.job?.checkpoint.sampler).toMatchObject({sampleIndex: 0});
    const write = f.host.writeFile;
    f.host.writeFile = async (...args) => {
        await write(...args);
        abort.abort();
    };
    await expect(f.controller().runStep(abort.signal)).rejects.toMatchObject({name: 'AbortError'});
    expect(f.state.job?.checkpoint.samples).toHaveLength(0);
    expect(f.state.job?.checkpoint.pendingSample).not.toBeNull();
    f.host.writeFile = write;
    await f.controller().runStep(signal());
    expect(f.state.job?.checkpoint.samples).toHaveLength(1);
    expect(f.state.job?.checkpoint.sampler).toMatchObject({sampleIndex: 1});
    expect(f.events.indexOf('intent:job-sample-0')).toBeLessThan(f.events.indexOf('write:job-sample-0'));
    expect(f.state.writes).toBe(2);
});

test('the complete batch plan and every file intent survive restart before any staging starts', async () => {
    const f = fixture('recompress');
    await dictionary(f);
    await f.controller().runStep(signal());
    expect(f.state.staged).toBe(0);
    expect(f.state.job?.checkpoint.batch).toEqual(batch('write'));
    expect(f.intents.has('pack-1')).toBe(true);
    await f.controller().runStep(signal());
    expect(f.state.staged).toBe(1);
    expect(f.state.job?.checkpoint.batch?.stage).toBe('verify');
});

test('independent decoder corruption preserves staged intents and cannot publish or claim no-gain', async () => {
    const f = fixture('recompress', {batch: batch('verify')});
    await dictionary(f);
    f.intents.add('pack-1');
    f.host.verificationPage = async () => ({original: Uint8Array.of(1, 2), replacement: Uint8Array.of(1, 9), cursor: 2, done: true});
    await expect(f.controller().runStep(signal())).rejects.toThrow('verification mismatch');
    expect(f.state.published).toBe(0);
    expect(f.intents.has('pack-1')).toBe(true);
    expect(f.state.job).toMatchObject({phase: 'reclaim', checkpoint: {afterReclaim: 'failed', batch: {stage: 'verify'}}});
});

test('no-gain is terminal only after temporary output and training files are reclaimed', async () => {
    const f = fixture('recompress', {batch: batch('publish', true)});
    await dictionary(f);
    f.intents.add('pack-1');
    f.host.measureBatch = () => ({beforeBytes: 10000, afterBytes: 10000});
    await f.controller().runStep(signal());
    expect(f.state.job?.phase).toBe('reclaim');
    expect(f.state.job?.checkpoint.afterReclaim).toBe('no-gain');
    expect(f.state.published).toBe(0);
    f.state.reclaimDone = false;
    const held = await f.controller().runStep(signal());
    expect(held.retryAt).toBe(101000);
    expect(f.state.job?.phase).toBe('reclaim');
    f.state.reclaimDone = true;
    await f.controller().runStep(signal());
    expect(f.state.job?.phase).toBe('no-gain');
    expect(f.intents.size).toBe(0);
    expect(f.files.size).toBe(0);
});

test('published reclamation advances to the next batch and retains the trained dictionary', async () => {
    const f = fixture('recompress', {batch: batch('publish')});
    await dictionary(f);
    f.intents.add('pack-1');
    await f.controller().runStep(signal());
    expect(f.state.job).toMatchObject({phase: 'reclaim', checkpoint: {publishedBatches: 1, afterReclaim: 'recompress', frameCursor: 1}});
    f.state.reclaimDone = false;
    await f.controller().runStep(signal());
    expect(f.state.staged).toBe(0);
    f.state.reclaimDone = true;
    await f.controller().runStep(signal());
    expect(f.state.job).toMatchObject({phase: 'recompress', checkpoint: {batch: null, frameCursor: 1}});
    expect(f.files.has('job-dictionary')).toBe(true);
});

test('a late publication acknowledgement reloads committed reclaim state and never repeats cutover', async () => {
    const f = fixture('recompress', {batch: batch('publish', true)});
    await dictionary(f);
    f.state.lateAck = true;
    expect(await f.controller().runStep(signal())).toEqual({pending: true});
    expect(f.state.published).toBe(1);
    expect(f.state.job).toMatchObject({phase: 'reclaim', retryAfter: null, checkpoint: {resumePhase: null, publishedBatches: 1}});
    await f.controller().runStep(signal());
    expect(f.state.job?.phase).toBe('completed');
    expect(f.state.published).toBe(1);
});

test('target deletion during staging leaves the durable batch available for cleanup', async () => {
    const f = fixture('recompress', {batch: batch('write')});
    await dictionary(f);
    f.intents.add('pack-1');
    f.host.stageBatch = async () => { f.state.current = false; };
    await expect(f.controller().runStep(signal())).rejects.toThrow('target generation changed');
    expect(f.state.published).toBe(0);
    expect(f.state.job?.checkpoint.batch?.fileIds).toEqual(['pack-1']);
    f.state.now += 30000;
    await f.controller().runStep(signal());
    await f.controller().runStep(signal());
    expect(f.state.job?.phase).toBe('failed');
    expect(f.files.size).toBe(0);
});

test('giant frame capacity failure defers the exact pending plan rather than publishing or recording no-gain', async () => {
    const f = fixture('recompress', {batch: batch('write')});
    await dictionary(f);
    f.intents.add('pack-1');
    f.host.stageBatch = async () => { throw new TermContentOptimizationResourceError('Giant frame exceeds private streaming budget'); };
    await expect(f.controller().runStep(signal())).rejects.toThrow('Giant frame');
    expect(f.state.job).toMatchObject({phase: 'deferred',
        retryAfter: 130000,
        checkpoint: {resumePhase: 'recompress', batch: {stage: 'write', fileIds: ['pack-1']}}});
    expect(f.state.published).toBe(0);
});

test('a frame beyond the strategy limit releases the job after cleanup', async () => {
    const f = fixture('recompress', {batch: batch('write')});
    await dictionary(f);
    f.host.stageBatch = async () => { throw new TermContentOptimizationUnsupportedFrameError('Frame requires streaming'); };
    await expect(f.controller().runStep(signal())).rejects.toThrow('Frame requires streaming');
    expect(f.state.job).toMatchObject({phase: 'reclaim', checkpoint: {afterReclaim: 'failed'}});
    await f.controller().runStep(signal());
    expect(f.state.job?.phase).toBe('failed');
    expect(f.files.size).toBe(0);
    expect(f.state.published).toBe(0);
});

test('corrupt persisted dictionary is detected before compression starts', async () => {
    const f = fixture('recompress', {batch: batch('write')});
    await dictionary(f);
    f.files.get('job-dictionary')?.fill(9);
    await expect(f.controller().runStep(signal())).rejects.toBeInstanceOf(TermContentOptimizationIntegrityError);
    expect(f.state.staged).toBe(0);
    expect(f.state.job).toMatchObject({phase: 'reclaim', checkpoint: {afterReclaim: 'failed', resumePhase: null}});
    await f.controller().runStep(signal());
    expect(f.state.job?.phase).toBe('failed');
    expect(f.files.size).toBe(0);
});

test('a whole-layout plan exceeding bounded JSON admission cannot reserve files or stage output', async () => {
    const f = fixture('recompress');
    await dictionary(f);
    f.host.planBatch = async () => ({id: 'batch-1', fileIds: ['pack-1'], token: 'x'.repeat(32768), nextCursor: 1, last: false});
    await expect(f.controller().runStep(signal())).rejects.toThrow('checkpoint exceeds admission');
    expect(f.intents.has('pack-1')).toBe(false);
    expect(f.state.staged).toBe(0);
});

test('verification remains a bounded resumable window and cannot publish before its final page', async () => {
    const f = fixture('recompress', {batch: batch('verify')});
    await dictionary(f);
    f.host.verificationPage = async () => ({original: Uint8Array.of(1), replacement: Uint8Array.of(1), cursor: 1, done: false});
    await f.controller().runStep(signal());
    expect(f.state.job?.checkpoint.batch).toMatchObject({stage: 'verify', verifyCursor: 1});
    expect(f.state.published).toBe(0);
    f.host.verificationPage = async () => ({original: new Uint8Array(1024 * 1024 + 1), replacement: new Uint8Array(1024 * 1024 + 1), cursor: 2, done: true});
    await expect(f.controller().runStep(signal())).rejects.toThrow('verification page exceeds admission');
    expect(f.state.job?.checkpoint.batch?.verifyCursor).toBe(1);
});

/**
 * @param {ReturnType<typeof fixture>} f
 * @returns {Promise<void>}
 * @throws {Error} If the fixture has no durable job.
 */
async function seedTrainingSamples(f) {
    if (f.state.job === null) { throw new Error('Missing fixture job'); }
    let discovery = createTermContentOptimizationCheckpoint(identity, parameters).sampler;
    for (let index = 0; index < 8; ++index) { discovery = observeTrainingFrame(discovery, {key: 'p:' + index, offset: index * 100, length: 32}); }
    let sampler = startTrainingSampleSelection(discovery);
    /** @type {CheckpointFile[]} */
    const samples = [];
    for (let index = 0; index < 8; ++index) {
        const metadata = {key: 'p:' + index, offset: index * 100, length: 32};
        const selected = planTrainingSampleStep(sampler, metadata);
        sampler = selected.state;
        sampler = planTrainingSampleStep(sampler, metadata).state;
        const bytes = new Uint8Array(32).fill(index + 1);
        const file = {fileId: 'job-sample-' + index, byteLength: bytes.length, sha256: await digest(bytes)};
        samples.push(file);
        f.files.set(file.fileId, bytes);
        f.intents.add(file.fileId);
    }
    f.state.job.checkpoint = {...f.state.job.checkpoint, samples, sampleMode: 'select', sampler: completeTrainingSampleSelection(sampler)};
}

test('restart uses persisted sampler and exact dictionary parameters before training', async () => {
    const f = fixture('train');
    await seedTrainingSamples(f);
    const abort = new AbortController();
    /** @type {Trainer} */
    const trainer = {train: async (request, options) => {
        expect(request).toMatchObject(parameters);
        expect(request.samples.byteLength).toBe(256);
        expect(options.signal).toBe(abort.signal);
        abort.abort();
        throw new DOMException('Terminated', 'AbortError');
    }};
    await f.controller(trainer).runStep(signal());
    expect(f.intents.has('job-dictionary')).toBe(true);
    await expect(f.controller(trainer).runStep(abort.signal)).rejects.toMatchObject({name: 'AbortError'});
    expect(f.state.job?.checkpoint.dictionary).toBeNull();
    expect(f.state.job?.checkpoint.pendingDictionary).toBe('job-dictionary');
    expect(f.state.job?.checkpoint.samples).toHaveLength(8);
    const succeeding = f.controller({train: async () => ({dictionary: new Uint8Array(1024).fill(7)})});
    await succeeding.runStep(signal());
    expect(f.state.job).toMatchObject({phase: 'recompress', checkpoint: {pendingDictionary: null, dictionary: {fileId: 'job-dictionary', byteLength: 1024}}});
});

test('durable strategy mismatch never retrains with different parameters', async () => {
    const f = fixture('train');
    if (f.state.job === null) { throw new Error('Missing fixture job'); }
    f.state.job.checkpoint.parameters.level = 2;
    await f.controller().runStep(signal());
    expect(f.state.writes).toBe(0);
    expect(f.state.job).toMatchObject({phase: 'reclaim', checkpoint: {parameters: {level: 2}, afterReclaim: 'failed', resumePhase: null}});
    await f.controller().runStep(signal());
    expect(f.state.job?.phase).toBe('failed');
});


test('deleting a title while its published batch is reclaiming redirects cleanup before the next batch', async () => {
    const f = fixture('reclaim', {batch: batch('publish'), afterReclaim: 'recompress', publishedBatches: 1});
    await dictionary(f);
    f.state.current = false;
    await f.controller().runStep(signal());
    expect(f.state.job).toMatchObject({phase: 'reclaim', checkpoint: {afterReclaim: 'failed'}});
    await f.controller().runStep(signal());
    expect(f.state.job?.phase).toBe('failed');
    expect(f.files.size).toBe(0);
    expect(f.state.staged).toBe(0);
});


test('an inconsistent persisted sample cannot reach private file I/O', async () => {
    const f = fixture('sample');
    f.frames.push(frame());
    const sampler = startTrainingSampleSelection(observeTrainingFrame(
        createTermContentOptimizationCheckpoint(identity, parameters).sampler,
        {key: 'pack:0', offset: 0, length: 65536},
    ));
    if (f.state.job === null) { throw new Error('Missing fixture job'); }
    f.state.job.checkpoint = {...f.state.job.checkpoint, sampler, sampleMode: 'select'};
    await f.controller().runStep(signal());
    const pending = f.state.job.checkpoint.pendingSample;
    if (pending === null) { throw new Error('Missing pending sample'); }
    pending.request.windowOffset = 1;
    await f.controller().runStep(signal());
    expect(f.state.job).toMatchObject({phase: 'reclaim', checkpoint: {afterReclaim: 'failed', pendingSample: null}});
    await f.controller().runStep(signal());
    expect(f.state.job?.phase).toBe('failed');
    expect(f.intents.size).toBe(0);
    expect(f.state.writes).toBe(0);
    expect(f.state.published).toBe(0);
});

test('verification cannot repeatedly checkpoint the same decoded window', async () => {
    const f = fixture('recompress', {batch: batch('verify')});
    await dictionary(f);
    f.host.verificationPage = async () => ({original: Uint8Array.of(1), replacement: Uint8Array.of(1), cursor: null, done: false});
    await expect(f.controller().runStep(signal())).rejects.toThrow('no forward progress');
    expect(f.state.published).toBe(0);
    expect(f.state.job).toMatchObject({phase: 'deferred', checkpoint: {batch: {stage: 'verify', verifyCursor: null}}});
});


test('one bounded discovery page shares its lease and checkpoints unique frames once', async () => {
    const f = fixture();
    const item = {kind: /** @type {const} */ ('artifact'),
        artifact: {contentOffset: 0,
            contentLength: 100,
            contentDictName: 'raw-v4',
            uncompressedLength: 65536}};
    f.host.readDiscovery = async () => ({items: Array.from({length: 64}, () => item), cursor: 64, done: true});
    await f.controller().runStep(signal());
    expect(f.state.job).toMatchObject({phase: 'sample', checkpointVersion: 1, checkpoint: {discoveryCursor: 64, pendingDiscovery: null}});
    expect(f.frames).toEqual([frame()]);
    expect(f.state.closed).toBe(1);
});

test('preemption midway through discovery replays its bounded page without partial frame checkpoints', async () => {
    const f = fixture();
    const item = {kind: /** @type {const} */ ('artifact'),
        artifact: {contentOffset: 0,
            contentLength: 100,
            contentDictName: 'raw-v4',
            uncompressedLength: 65536}};
    f.host.readDiscovery = async () => ({items: Array.from({length: 64}, () => item), cursor: 64, done: true});
    const abort = new AbortController();
    const acquire = f.host.acquireSource;
    let inspected = 0;
    f.host.acquireSource = (job, activeSignal) => {
        const lease = acquire(job, activeSignal);
        lease.source.describe = async () => {
            if (++inspected === 32) { abort.abort(); }
            return frame();
        };
        return lease;
    };
    await expect(f.controller().runStep(abort.signal)).rejects.toMatchObject({name: 'AbortError'});
    expect(f.frames).toHaveLength(0);
    expect(f.state.job).toMatchObject({phase: 'discover', checkpointVersion: 0, checkpoint: {discoveryCursor: null}});
    f.host.acquireSource = acquire;
    await f.controller().runStep(signal());
    expect(f.frames).toEqual([frame()]);
    expect(f.state.job).toMatchObject({phase: 'sample', checkpointVersion: 1});
    expect(f.state.closed).toBe(2);
});

test('oversized discovery pages cannot reach optional source acquisition', async () => {
    const f = fixture();
    const item = {kind: /** @type {const} */ ('artifact'),
        artifact: {contentOffset: 0,
            contentLength: 100,
            contentDictName: 'raw-v4',
            uncompressedLength: 65536}};
    f.host.readDiscovery = async () => ({items: Array.from({length: 65}, () => item), cursor: 65, done: true});
    await expect(f.controller().runStep(signal())).rejects.toThrow('exceeds admission');
    expect(f.state.closed).toBe(0);
    expect(f.frames).toHaveLength(0);
    expect(f.state.writes).toBe(0);
});


test.each(['corpus', 'resource'])('classifies training %s failure without claiming measured no-gain', async (kind) => {
    const f = fixture('train');
    await seedTrainingSamples(f);
    const trainer = {train: async () => {
        if (kind === 'corpus') { throw new ZstdTrainingCorpusError('Fixed corpus is not trainable'); }
        throw new ZstdTrainingResourceError('Temporary memory admission failure', void 0);
    }};
    await f.controller(trainer).runStep(signal());
    if (kind === 'resource') {
        await expect(f.controller(trainer).runStep(signal())).rejects.toThrow('memory admission');
        expect(f.state.job).toMatchObject({phase: 'deferred', checkpoint: {resumePhase: 'train'}});
        expect(f.intents.size).toBe(9);
        expect(f.state.writes).toBe(0);
        return;
    }
    await f.controller(trainer).runStep(signal());
    expect(f.state.job).toMatchObject({phase: 'reclaim', checkpoint: {afterReclaim: 'failed'}});
    expect(f.intents.size).toBe(9);
    f.state.reclaimDone = false;
    await f.controller(trainer).runStep(signal());
    expect(f.state.job?.phase).toBe('reclaim');
    f.state.reclaimDone = true;
    await f.controller(trainer).runStep(signal());
    expect(f.state.job?.phase).toBe('failed');
    expect(f.intents.size).toBe(0);
    expect(f.files.size).toBe(0);
});


test('deferred reclaim survives a strategy and parameter update without retraining', async () => {
    const f = fixture('deferred', {resumePhase: 'reclaim', afterReclaim: 'failed'});
    await dictionary(f);
    if (f.state.job === null) { throw new Error('Missing fixture job'); }
    f.state.job.checkpoint.parameters.level = 2;
    const controller = new TermContentOptimizationController({host: f.host,
        strategyVersion: 'new-strategy-v2',
        ...parameters,
        now: () => f.state.now});
    await controller.runStep(signal());
    expect(f.state.job).toMatchObject({phase: 'reclaim', checkpoint: {resumePhase: null}});
    await controller.runStep(signal());
    expect(f.state.job?.phase).toBe('failed');
    expect(f.files.size).toBe(0);
    expect(f.state.writes).toBe(0);
});

test('an awaited stale callback cannot defer a successor checkpoint of the same job', async () => {
    const f = fixture();
    f.host.readDiscovery = async (job) => {
        f.host.save(job, 'discover', {...job.checkpoint, discoveryCursor: 123});
        return {item: null, cursor: 456, done: true};
    };
    await expect(f.controller().runStep(signal())).rejects.toThrow('Stale owner');
    expect(f.state.job).toMatchObject({phase: 'discover',
        checkpointVersion: 1,
        retryAfter: null,
        checkpoint: {discoveryCursor: 123, failures: 0}});
    expect(f.events).toEqual(['save:discover']);
});

test('an exact checkpoint receipt reconciles its own failed acknowledgement', async () => {
    const f = fixture();
    const save = f.host.save;
    f.host.save = (...args) => {
        save(...args);
        throw new Error('Checkpoint acknowledged late');
    };
    expect(await f.controller().runStep(signal())).toEqual({pending: true});
    expect(f.state.job).toMatchObject({phase: 'sample',
        checkpointVersion: 1,
        retryAfter: null,
        checkpoint: {failures: 0, resumePhase: null}});
    expect(f.events).toEqual(['save:sample']);
});

test('a same-version but different checkpoint is not mistaken for an exact own receipt', async () => {
    const f = fixture();
    const save = f.host.save;
    f.host.save = (...args) => {
        const committed = save(...args);
        committed.checkpoint.discoveryCursor = 999;
        throw new Error('Different durable receipt');
    };
    await expect(f.controller().runStep(signal())).rejects.toThrow('Different durable receipt');
    expect(f.state.job).toMatchObject({phase: 'sample',
        checkpointVersion: 1,
        retryAfter: null,
        checkpoint: {discoveryCursor: 999, failures: 0}});
    expect(f.events).toEqual(['save:sample']);
});

test.each(['count', 'bytes', 'unfinished'])('resumed training rejects %s sampler inconsistency before file reads', async (kind) => {
    const f = fixture('train');
    await seedTrainingSamples(f);
    if (f.state.job === null) { throw new Error('Missing fixture job'); }
    const state = f.state.job.checkpoint;
    if (kind === 'count') {
        state.samples.push({...state.samples[0], fileId: 'extra-sample'});
    } else if (kind === 'bytes') {
        --state.samples[0].byteLength;
    } else {
        const sampler = state.sampler;
        if (sampler.phase !== 'done') { throw new Error('Missing completed sampler'); }
        state.sampler = {...sampler, phase: 'sample'};
    }
    let reads = 0;
    f.host.readFile = async () => {
        ++reads;
        throw new Error('Unexpected private read');
    };
    await expect(f.controller().runStep(signal())).rejects.toThrow(kind === 'unfinished' ? 'completed durable sampling' : 'samples disagree');
    expect(reads).toBe(0);
    expect(f.state.writes).toBe(0);
    expect(f.intents.has('job-dictionary')).toBe(false);
});

test('a resumed selection with missing committed windows cannot create a new sample intent', async () => {
    const f = fixture('sample');
    await seedTrainingSamples(f);
    if (f.state.job === null || f.state.job.checkpoint.sampler.phase !== 'done') { throw new Error('Missing completed sampler'); }
    const sampler = f.state.job.checkpoint.sampler;
    f.state.job.checkpoint.sampler = {...sampler, phase: 'sample'};
    f.state.job.checkpoint.samples.pop();
    await expect(f.controller().runStep(signal())).rejects.toThrow('samples disagree');
    expect(f.state.writes).toBe(0);
    expect(f.state.job?.checkpoint.pendingSample).toBeNull();
});

test('canonical parity failure retains intents until failed-job reclamation completes', async () => {
    const f = fixture('recompress', {batch: batch('verify')});
    await dictionary(f);
    f.intents.add('pack-1');
    f.host.verificationPage = async () => ({original: Uint8Array.of(1), replacement: Uint8Array.of(2), cursor: 1, done: true});
    await expect(f.controller().runStep(signal())).rejects.toBeInstanceOf(TermContentOptimizationIntegrityError);
    expect(f.state.job).toMatchObject({phase: 'reclaim', checkpoint: {afterReclaim: 'failed'}});
    expect(f.intents.has('pack-1')).toBe(true);
    f.state.reclaimDone = false;
    await f.controller().runStep(signal());
    expect(f.state.job?.phase).toBe('reclaim');
    f.state.reclaimDone = true;
    await f.controller().runStep(signal());
    expect(f.state.job?.phase).toBe('failed');
    expect(f.intents.size).toBe(0);
    expect(f.state.published).toBe(0);
});

test('unknown stage I/O errors continue deferring the intact plan', async () => {
    const f = fixture('recompress', {batch: batch('write')});
    await dictionary(f);
    f.intents.add('pack-1');
    f.host.stageBatch = async () => { throw new Error('Transient OPFS observation failure'); };
    await expect(f.controller().runStep(signal())).rejects.toThrow('Transient OPFS');
    expect(f.state.job).toMatchObject({phase: 'deferred',
        retryAfter: 130000,
        checkpoint: {resumePhase: 'recompress', batch: {stage: 'write'}}});
    expect(f.intents.has('pack-1')).toBe(true);
});


test('an exact job-creation receipt survives its failed acknowledgement without acquiring another job', async () => {
    const f = fixture();
    f.state.job = null;
    let candidates = 0;
    f.host.findCandidate = () => {
        ++candidates;
        return {jobId: 'job', dictionaryTitle: 'Title', dictionaryGeneration: 'generation'};
    };
    const create = f.host.createJob;
    f.host.createJob = (job) => {
        create(job);
        throw new Error('Creation acknowledged late');
    };
    expect(await f.controller().runStep(signal())).toEqual({pending: true});
    expect(f.state.job).toMatchObject({phase: 'discover', checkpointVersion: 0, retryAfter: null});
    await f.controller().runStep(signal());
    expect(candidates).toBe(1);
    expect(f.host.getJob()?.phase).toBe('sample');
});


test.each([
    /** @type {const} */ ('reclaim'),
    /** @type {const} */ ('deferred'),
])('obsolete strategy in %s cleans training files before releasing its singleton', async (phase) => {
    const f = fixture(phase, {resumePhase: phase === 'deferred' ? 'reclaim' : null, afterReclaim: 'recompress'});
    await dictionary(f);
    f.intents.add('obsolete-output');
    const controller = new TermContentOptimizationController({host: f.host,
        strategyVersion: 'new-strategy-v2',
        ...parameters,
        now: () => f.state.now});
    await controller.runStep(signal());
    expect(f.state.job).toMatchObject({phase: 'reclaim', checkpoint: {afterReclaim: 'failed', resumePhase: null}});
    expect(f.files.size).toBe(9);
    await controller.runStep(signal());
    expect(f.state.job?.phase).toBe('failed');
    expect(f.files.size).toBe(0);
    expect(f.intents.size).toBe(0);
    expect(f.state.staged).toBe(0);
    expect(f.state.published).toBe(0);
});


test.each(/** @type {const} */ (['train', 'recompress', 'deferred']))('obsolete %s strategy reclaims owned files and frees maintenance for current work', async (phase) => {
    const f = fixture(phase, {resumePhase: phase === 'deferred' ? 'train' : null});
    await dictionary(f);
    const trainer = {train: async () => { throw new Error('Obsolete training must not start'); }};
    const controller = new TermContentOptimizationController({host: f.host,
        strategyVersion: 'new-strategy-v2',
        ...parameters,
        now: () => f.state.now,
        createTrainer: () => trainer});
    await controller.runStep(signal());
    expect(f.state.job).toMatchObject({phase: 'reclaim', retryAfter: null, checkpoint: {afterReclaim: 'failed', resumePhase: null}});
    expect(f.files.size).toBe(9);
    await controller.runStep(signal());
    expect(f.state.job?.phase).toBe('failed');
    expect(f.files.size).toBe(0);
    expect(f.intents.size).toBe(0);
    expect(f.state.staged).toBe(0);
    expect(f.state.published).toBe(0);
});


test('resumes after a committed legacy activation by resetting the unpinned cursor', async () => {
    const f = fixture('discover', {legacyProbe: true, discoveryCursor: {stage: 'artifact'}});
    f.host.isLegacyRoot = () => false;
    f.host.readDiscovery = async (_job, cursor) => {
        expect(cursor).toBeNull();
        return {items: [], cursor: null, done: true};
    };
    await f.controller().runStep(signal());
    expect(f.state.job).toMatchObject({phase: 'discover', checkpoint: {legacyProbe: false, discoveryCursor: null}});
    await f.controller().runStep(signal());
    expect(f.state.job?.phase).toBe('sample');
    expect(f.frames).toEqual([]);
});

test('only a valid generic legacy frame requests activation', async () => {
    const f = fixture('discover', {legacyProbe: true});
    const bytes = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x20, 3, 25, 0, 0, 97, 98, 99]);
    let legacy = true;
    f.host.isLegacyRoot = () => legacy;
    f.host.acquireLegacyProbe = () => ({
        source: {logicalHighWater: bytes.length, assertCurrent: () => {},
            readSlice: async (offset, length) => bytes.slice(offset, offset + length)},
        activate: async () => { legacy = false; },
    });
    f.host.readDiscovery = async () => ({items: [{kind: 'reference',
        reference: {recordId: 1, entryContentOffset: 0, entryContentLength: 3, entryContentDictName: ''}}],
    cursor: 2, done: true});
    await f.controller().runStep(signal());
    expect(legacy).toBe(false);
    expect(f.state.job).toMatchObject({phase: 'discover', checkpoint: {legacyProbe: false, discoveryCursor: null}});
    expect(f.frames).toEqual([]);
});


test('immutable block ranges coalesce duplicate references and block descriptions', async () => {
    const f = fixture();
    let reads = 0;
    let described = 0;
    const encoded = encodeRawTermContentCompactBlockReference(2000, 100, 65536, 0);
    f.host.acquireSource = () => ({source: {
        logicalHighWater: 4096,
        assertCurrent: () => {},
        readSlice: async () => { ++reads; return encoded.slice(); },
        describe: async (identity) => { ++described; return {...frame(2000), identity}; },
        findOverride: async () => null,
    }, close: async () => {}});
    f.host.readDiscovery = async () => ({
        items: Array.from({length: 1024}, (_, index) => ({kind: /** @type {const} */ ('reference'),
            reference: {recordId: index + 1, entryContentOffset: index % 2 ? 20 : 0,
                entryContentLength: 3, entryContentDictName: 'raw-block-v2'}})),
        cursor: 1024,
        done: false,
        resumeAfterBlockReference: () => { throw new Error('One shared block cannot exhaust the frame budget'); },
    });
    await f.controller().runStep(signal());
    expect(reads).toBe(2);
    expect(described).toBe(1);
    expect(f.frames).toHaveLength(1);
    expect(f.state.job).toMatchObject({phase: 'discover', checkpoint: {discoveryCursor: 1024, pendingDiscovery: null}});
});

test('an overfull immutable block range resumes immediately after its committed prefix', async () => {
    const f = fixture();
    const records = Array.from({length: 130}, (_, index) => ({kind: /** @type {const} */ ('reference'),
        reference: {recordId: index * 2 + 1, entryContentOffset: index * 20,
            entryContentLength: 3, entryContentDictName: 'raw-block-v2'}}));
    f.host.acquireSource = () => ({source: {
        logicalHighWater: 50000,
        assertCurrent: () => {},
        readSlice: async (offset) => encodeRawTermContentCompactBlockReference(10000 + offset * 8, 100, 65536, 0),
        describe: async (identity) => ({...frame(identity.logicalOffset), identity}),
        findOverride: async () => null,
    }, close: async () => {}});
    f.host.readDiscovery = async (_job, cursor) => {
        const priorRecord = typeof cursor === 'number' ? cursor : 0;
        return {items: records.filter((item) => item.reference.recordId > priorRecord), cursor: 299, done: true,
            resumeAfterBlockReference: (recordId) => recordId};
    };
    await f.controller().runStep(signal());
    expect(f.frames).toHaveLength(64);
    expect(f.state.job?.checkpoint.discoveryCursor).toBe(127);
    await f.controller().runStep(signal());
    expect(f.frames).toHaveLength(128);
    expect(f.state.job?.checkpoint.discoveryCursor).toBe(255);
    await f.controller().runStep(signal());
    expect(f.frames).toHaveLength(130);
    expect(f.state.job).toMatchObject({phase: 'sample', checkpoint: {discoveryCursor: 299, pendingDiscovery: null}});
});

test('conflicting metadata for the same block leaves the previous cursor intact', async () => {
    const f = fixture();
    f.host.acquireSource = () => ({source: {
        logicalHighWater: 4096,
        assertCurrent: () => {},
        readSlice: async (offset) => encodeRawTermContentCompactBlockReference(2000, offset === 0 ? 100 : 101, 65536, 0),
        describe: async (identity) => ({...frame(2000), identity}),
        findOverride: async () => null,
    }, close: async () => {}});
    f.host.readDiscovery = async () => ({items: [0, 20].map((offset, index) => ({
        kind: /** @type {const} */ ('reference'), reference: {recordId: index + 1, entryContentOffset: offset,
            entryContentLength: 3, entryContentDictName: 'raw-block-v2'},
    })), cursor: 2, done: true, resumeAfterBlockReference: (id) => id});
    await expect(f.controller().runStep(signal())).rejects.toThrow(/conflicting immutable frame identities/);
    expect(f.frames).toEqual([]);
    expect(f.state.job?.checkpoint.discoveryCursor).toBeNull();
});

test('foreground abort inside a block range never persists a partly observed range', async () => {
    const f = fixture();
    const abort = new AbortController();
    f.host.acquireSource = () => ({source: {
        logicalHighWater: 4096, assertCurrent: () => {},
        readSlice: async (offset) => {
            if (offset > 0) { abort.abort(); }
            return encodeRawTermContentCompactBlockReference(2000 + offset * 8, 100, 65536, 0);
        },
        describe: async (identity) => ({...frame(identity.logicalOffset), identity}),
        findOverride: async () => null,
    }, close: async () => { ++f.state.closed; }});
    f.host.readDiscovery = async () => ({items: [0, 20].map((offset, index) => ({
        kind: /** @type {const} */ ('reference'), reference: {recordId: index + 1, entryContentOffset: offset,
            entryContentLength: 3, entryContentDictName: 'raw-block-v2'},
    })), cursor: 2, done: true, resumeAfterBlockReference: (id) => id});
    await expect(f.controller().runStep(abort.signal)).rejects.toMatchObject({name: 'AbortError'});
    expect(f.frames).toEqual([]);
    expect(f.state.closed).toBe(1);
    expect(f.state.job).toMatchObject({phase: 'discover', checkpointVersion: 0, checkpoint: {discoveryCursor: null}});
});
