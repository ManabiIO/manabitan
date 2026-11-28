/* SPDX-License-Identifier: GPL-3.0-or-later */

import assert from 'node:assert/strict';
import {test} from 'vitest';
import {
    createTrainingSampleDiscovery, observeTrainingFrame, startTrainingSampleSelection,
    planTrainingSampleStep, completeTrainingSampleSelection,
    validateTrainingSampleCheckpoint, copyTrainingSampleWindow,
} from '../ext/js/dictionary/term-content-training-sampler.js';

const WINDOW = 65536;
/**
 * @param {import('../ext/js/dictionary/term-content-training-sampler.js').TrainingFrameDescriptor[]} frames
 * @returns {import('../ext/js/dictionary/term-content-training-sampler.js').TrainingSampleSelection}
 */
function selection(frames) {
    let state = createTrainingSampleDiscovery('generation-7:frame64k-f18-16k-v1');
    for (const frame of frames) { state = observeTrainingFrame(state, frame); }
    return startTrainingSampleSelection(state);
}
/**
 * @param {import('../ext/js/dictionary/term-content-training-sampler.js').TrainingFrameDescriptor[]} frames
 * @returns {{requests: import('../ext/js/dictionary/term-content-training-sampler.js').TrainingSampleRequest[], state: import('../ext/js/dictionary/term-content-training-sampler.js').TrainingSampleSelection, steps: number}}
 */
function collect(frames) {
    let state = selection(frames);
    const requests = [];
    let steps = 0;
    for (const frame of frames) {
        for (;;) {
            const step = planTrainingSampleStep(JSON.parse(JSON.stringify(state)), frame);
            ++steps;
            state = step.state;
            if (step.kind === 'frame-complete') { break; }
            requests.push(step.request);
        }
    }
    return {requests, state: completeTrainingSampleSelection(state), steps};
}
/**
 * @param {import('../ext/js/dictionary/term-content-training-sampler.js').TrainingFrameDescriptor[]} frames
 * @returns {import('../ext/js/dictionary/term-content-training-sampler.js').TrainingSampleRequest[]}
 */
function oracle(frames) {
    /** @type {Array<Omit<import('../ext/js/dictionary/term-content-training-sampler.js').TrainingSampleRequest, 'sampleIndex'>>} */
    const candidates = [];
    for (const frame of frames) {
        for (let start = 0; start < frame.length; start += WINDOW) {
            candidates.push({key: frame.key,
                frameOffset: frame.offset,
                decodedLength: frame.length,
                windowOffset: start,
                length: Math.min(WINDOW, frame.length - start)});
        }
    }
    const count = Math.min(candidates.length, 64);
    return Array.from({length: count}, (_, index) => ({sampleIndex: index,
        ...candidates[Math.floor((index + 0.5) * candidates.length / count)]}));
}

test('matches the independently materialized native window64k midpoint oracle exactly', () => {
    const frames = Array.from({length: 47}, (_, index) => ({key: 'frame-' + index,
        offset: 2 ** 32 + index * 17,
        length: [1, WINDOW - 1, WINDOW, WINDOW + 1, 9 * WINDOW + 71][index % 5]}));
    const result = collect(frames);
    assert.deepEqual(result.requests, oracle(frames));
    assert.equal(result.state.sampleBytes, result.requests.reduce((sum, request) => sum + request.length, 0));
    assert.ok(result.state.sampleBytes <= 4 * 1024 * 1024);
    assert.ok(JSON.stringify(result.state).length < 2048);
});

test('a giant frame above 32 bits needs only 64 windows plus one metadata advance', () => {
    const frame = {key: 'huge', offset: 2 ** 42 + 123, length: 2 ** 43 + 71};
    const result = collect([frame]);
    assert.equal(result.requests.length, 64);
    assert.equal(result.steps, 65);
    assert.equal(result.state.sampleBytes, 4 * 1024 * 1024);
    assert.equal(result.requests[63].frameOffset, frame.offset);
    assert.ok(result.requests[63].windowOffset > 2 ** 32);
    assert.ok(result.requests.every((request) => Number.isSafeInteger(request.windowOffset) && request.windowOffset + request.length <= frame.length));
});

test('JSON interruption replay preserves the exact old checkpoint and next private sample', () => {
    const frame = {key: 'one', offset: 9, length: 2 * WINDOW + 3};
    const state = selection([frame]);
    const before = JSON.stringify(state);
    const first = planTrainingSampleStep(state, frame);
    const replay = planTrainingSampleStep(JSON.parse(before), frame);
    assert.deepEqual(first, replay);
    assert.equal(JSON.stringify(state), before);
    assert.equal(first.kind, 'sample');
    if (first.kind !== 'sample') { throw new Error('Expected a training sample'); }
    const source = new Uint8Array(first.request.length + 4).fill(7);
    const window = source.subarray(2, -2);
    const owned = copyTrainingSampleWindow(window, first.request);
    source.fill(3);
    assert.ok(owned.every((value) => value === 7));
    structuredClone(source, {transfer: [source.buffer]});
    assert.equal(source.byteLength, 0);
    assert.equal(owned.byteLength, first.request.length);
});

test('small and empty corpora keep exact tails without padding or budget refill', () => {
    assert.deepEqual(collect([]).requests, []);
    const frames = [{key: 'a', offset: 0, length: WINDOW + 1}, {key: 'b', offset: 11, length: 2}];
    const result = collect(frames);
    assert.deepEqual(result.requests.map(({length}) => length), [WINDOW, 1, 2]);
    assert.deepEqual(result.requests, oracle(frames));
});

test('source order and byte dimensions must agree with the discovery pass', () => {
    const frames = [{key: 'a', offset: 4, length: 12}, {key: 'b', offset: 9, length: 34}];
    let state = selection(frames);
    assert.throws(() => {
        for (const frame of [...frames].reverse()) {
            for (;;) {
                const step = planTrainingSampleStep(state, frame);
                state = step.state;
                if (step.kind === 'frame-complete') { break; }
            }
        }
    }, /discovery/);
});

test('checkpoint validation never invokes a phase accessor', () => {
    let called = false;
    const state = createTrainingSampleDiscovery('generation');
    Object.defineProperty(state, 'phase', {get() {
        called = true;
        return 'discover';
    },
    enumerable: true});
    assert.throws(() => validateTrainingSampleCheckpoint(state), TypeError);
    assert.equal(called, false);
});

test('impossible sample and summary cursors are rejected without source reads', () => {
    const frame = {key: 'a', offset: 0, length: WINDOW * 100};
    const state = selection([frame]);
    /** @type {Array<(value: import('core').SafeAny) => void>} */
    const mutations = [
        (value) => { value.version = 2; },
        (value) => { value.summary.candidates = 0; },
        (value) => { value.sampleIndex = 65; },
        (value) => { value.sampleBytes = Infinity; },
        (value) => { value.candidatesSeen = -1; },
        (value) => { value.extra = true; },
    ];
    for (const mutation of mutations) {
        const bad = JSON.parse(JSON.stringify(state));
        mutation(bad);
        assert.throws(() => validateTrainingSampleCheckpoint(bad), TypeError);
    }
    const ahead = {...state, sampleIndex: 64, sampleBytes: 64 * WINDOW};
    assert.throws(() => planTrainingSampleStep(ahead, {...frame, length: 1}), TypeError);
});
