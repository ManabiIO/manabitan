/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, test} from 'vitest';
import {createContentLayoutResolver} from '../ext/js/dictionary/term-content-layout.js';
import {inspectTermContentTrainingReference} from '../ext/js/dictionary/term-content-optimization-candidate-source.js';
import {TermContentOptimizationFrameReader} from '../ext/js/dictionary/term-content-optimization-frame-reader.js';
import {createTermContentOptimizationCheckpoint, TermContentOptimizationResourceError} from '../ext/js/dictionary/term-content-optimization-controller.js';

/** @typedef {import('../ext/js/dictionary/term-content-frame-codec-worker-owner.js').TermContentFrameCodecRequest} CodecRequest */
/** @typedef {import('../ext/js/dictionary/term-content-optimization-checkpoint.js').OnlineContentFrameDescriptor} Frame */

function fixture() {
    /** @type {import('../ext/js/dictionary/term-content-optimization-controller.js').OptimizationJob} */
    const job = {jobId: 'job',
        dictionaryTitle: 'Test',
        dictionaryGeneration: 'generation',
        strategyVersion: 'strategy',
        phase: 'sample',
        checkpointVersion: 0,
        retryAfter: null,
        checkpoint: createTermContentOptimizationCheckpoint('generation:strategy', {dictionaryCapacity: 16384, strategy: 1, level: 1})};
    /** @type {Frame} */
    const frame = {identity: {kind: 'block',
        logicalOffset: 0,
        recordLength: 3,
        sourceStoredLength: 3,
        originalCodecId: null,
        originalEnvelope: 'none',
        expectedDecodedLength: 32},
    physicalKey: 'file:0:3',
    storedLength: 3,
    decodedLength: 32,
    codecId: null,
    envelope: 'none',
    decodedDigest: null};
    const decoded = Uint8Array.from({length: 32}, (_, index) => index);
    const state = {current: true,
        owned: true,
        acquired: 0,
        released: 0,
        created: 0,
        closed: 0,
        chunks: [new Uint8Array([1]), new Uint8Array([2, 3])],
        observed: {...frame},
        onChunk: /** @type {() => void} */ (() => {}),
        decode: /** @type {(request: CodecRequest, options: {signal?: AbortSignal}) => Promise<Uint8Array>} */ (async () => decoded),
        requests: /** @type {CodecRequest[]} */ ([])};
    const reader = new TermContentOptimizationFrameReader({
        assertOwned: () => { if (!state.owned) { throw new Error('Stale job owner'); } },
        acquire: () => {
            ++state.acquired;
            return {snapshot: {rootId: 'root', epoch: 1, logicalHighWater: 3},
                target: {title: 'Test', termRecordStorageName: 'Test', generation: 'generation'},
                source: {logicalHighWater: 3,
                    assertCurrent: () => { if (!state.current) { throw new Error('Target generation changed'); } },
                    describe: async () => state.observed,
                    findOverride: async () => null,
                    readSlice: async () => { throw new Error('Canonical reader must stream its resolved frame'); }},
                readFrameChunks: async function *readChunks() {
                    for (const chunk of state.chunks) {
                        state.onChunk();
                        yield chunk;
                    }
                },
                close: async () => { ++state.released; }};
        },
        createCodec: () => {
            ++state.created;
            return {run: async (request, options = {}) => {
                state.requests.push(request);
                return await state.decode(request, options);
            },
            close: () => { ++state.closed; }};
        },
    });
    return {job, frame, decoded, state, reader};
}

test('reads an owned decoded window through private streamed input and a disposable codec', async () => {
    const f = fixture();
    const bytes = await f.reader.readWindow(f.job, f.frame, 5, 4, new AbortController().signal);
    expect(bytes).toEqual(new Uint8Array([5, 6, 7, 8]));
    bytes[0] = 99;
    expect(f.decoded[5]).toBe(5);
    expect(f.state.requests[0]).toMatchObject({action: 'decode',
        codecId: null,
        expectedDecodedLength: 32,
        maxOutputSize: 32,
        bytes: new Uint8Array([1, 2, 3])});
    expect(f.state).toMatchObject({acquired: 1, released: 1, created: 1, closed: 1});
});

test.each(['unknown-length', 'giant-input', 'giant-decoded'])('defers %s before allocating input or acquiring a source lease', async (kind) => {
    const f = fixture();
    if (kind === 'unknown-length') { f.frame.decodedLength = null; }
    if (kind === 'giant-input') { f.frame.storedLength = 16 * 1024 * 1024 + 1; }
    if (kind === 'giant-decoded') { f.frame.decodedLength = 128 * 1024 * 1024 + 1; }
    await expect(f.reader.readWindow(f.job, f.frame, 0, 1, new AbortController().signal)).rejects.toBeInstanceOf(TermContentOptimizationResourceError);
    expect(f.state).toMatchObject({acquired: 0, created: 0});
});

test('a changed physical frame cannot reach payload reads or decoding', async () => {
    const f = fixture();
    f.state.observed.physicalKey = 'replacement:0:3';
    await expect(f.reader.readWindow(f.job, f.frame, 0, 1, new AbortController().signal)).rejects.toThrow('physical identity changed');
    expect(f.state).toMatchObject({released: 1, created: 0});
});

test.each(['short', 'extra', 'empty'])('rejects a %s immutable input stream before creating a decoder', async (kind) => {
    const f = fixture();
    f.state.chunks = kind === 'short' ?
[new Uint8Array([1])] :
        (kind === 'extra' ? [new Uint8Array([1, 2, 3, 4])] : [new Uint8Array(0)]);
    await expect(f.reader.readWindow(f.job, f.frame, 0, 1, new AbortController().signal)).rejects.toThrow(/immutable observation/);
    expect(f.state).toMatchObject({released: 1, created: 0});
});

test('foreground preemption during input I/O closes the lease without starting CPU work', async () => {
    const f = fixture();
    const abort = new AbortController();
    f.state.onChunk = () => abort.abort();
    await expect(f.reader.readWindow(f.job, f.frame, 0, 1, abort.signal)).rejects.toMatchObject({name: 'AbortError'});
    expect(f.state).toMatchObject({released: 1, created: 0});
});

test.each(['target', 'owner', 'abort', 'decode-error', 'wrong-output'])('joins codec and source cleanup after %s changes during decode', async (kind) => {
    const f = fixture();
    const abort = new AbortController();
    f.state.decode = async () => {
        if (kind === 'target') { f.state.current = false; }
        if (kind === 'owner') { f.state.owned = false; }
        if (kind === 'abort') { abort.abort(); }
        if (kind === 'decode-error') { throw new Error('Temporary codec failure'); }
        return kind === 'wrong-output' ? new Uint8Array(1) : f.decoded;
    };
    await expect(f.reader.readWindow(f.job, f.frame, 0, 1, abort.signal)).rejects.toThrow();
    expect(f.state).toMatchObject({released: 1, created: 1, closed: 1});
});


test('samples an inspected legacy frame while its real layout identity keeps an unknown decoded length', async () => {
    const f = fixture();
    const bytes = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x20, 4, 0x21, 0, 0, 1, 2, 3, 4]);
    const files = [{fileId: 'original', byteLength: bytes.byteLength, sha256: null}];
    const resolver = createContentLayoutResolver({
        manifests: [{version: 1,
            regionId: 'original-region',
            logicalStart: 0,
            logicalLength: bytes.byteLength,
            extents: [{logicalOffset: 0, length: bytes.byteLength, fileId: 'original', physicalOffset: 0}],
            blocks: [],
            removed: []}],
        externalFrames: [],
        files,
        physicalFiles: files,
        codecs: [],
    });
    /** @type {import('../ext/js/dictionary/term-content-optimization-candidate-source.js').CandidateFrameSource} */
    const source = {
        logicalHighWater: bytes.byteLength,
        assertCurrent: () => {},
        readSlice: async (offset, length) => bytes.slice(offset, offset + length),
        findOverride: async () => null,
        describe: async (identity) => {
            const frame = resolver.resolveFrame(identity);
            return {identity: {...frame.identity},
                physicalKey: JSON.stringify([frame.spans, frame.codecId, frame.envelope, frame.decodedLength]),
                storedLength: frame.storedLength,
                codecId: frame.codecId,
                envelope: frame.envelope,
                decodedLength: frame.decodedLength,
                decodedDigest: frame.decodedDigest};
        },
    };
    const signal = new AbortController().signal;
    const inspected = await inspectTermContentTrainingReference(source, {recordId: 1,
        entryContentOffset: 0,
        entryContentLength: 999,
        entryContentDictName: ''}, signal);
    if (inspected.kind !== 'frame') { throw new Error('Expected an inspected legacy frame'); }
    const identityBefore = {...inspected.frame.identity};
    expect(inspected.frame.decodedLength).toBe(4);
    expect(identityBefore.expectedDecodedLength).toBeNull();
    f.state.observed = await source.describe(inspected.frame.identity);
    expect(f.state.observed.decodedLength).toBeNull();
    f.state.chunks = [bytes];
    f.state.decode = async () => new Uint8Array([1, 2, 3, 4]);
    await expect(f.reader.readWindow(f.job, inspected.frame, 1, 2, signal)).resolves.toEqual(new Uint8Array([2, 3]));
    expect(f.state.requests[0]).toMatchObject({expectedDecodedLength: 4, maxOutputSize: 4});
    expect(inspected.frame.identity).toEqual(identityBefore);
    expect(f.state.observed.identity).toEqual(identityBefore);
    expect(f.state).toMatchObject({acquired: 1, released: 1, created: 1, closed: 1});
    f.state.decode = async () => new Uint8Array(3);
    await expect(f.reader.readWindow(f.job, inspected.frame, 0, 1, signal)).rejects.toThrow('inconsistent frame length');
    expect(f.state).toMatchObject({acquired: 2, released: 2, created: 2, closed: 2});
});

test.each(['known-length', 'non-legacy', 'known-identity-length', 'custom-original', 'physical-key', 'stored-length', 'codec', 'envelope'])('does not substitute an inspected length for %s mismatches', async (kind) => {
    const f = fixture();
    f.frame.identity = {...f.frame.identity, kind: 'legacy-entry', expectedDecodedLength: null};
    f.state.observed = {...f.frame, identity: {...f.frame.identity}, decodedLength: null};
    if (kind === 'known-length') { f.state.observed.decodedLength = 31; }
    if (kind === 'physical-key') { f.state.observed.physicalKey = 'other-frame'; }
    if (kind === 'stored-length') { ++f.state.observed.storedLength; }
    if (kind === 'codec') { f.state.observed.codecId = 'other-codec'; }
    if (kind === 'envelope') { f.state.observed.envelope = 'mbc2'; }
    if (kind === 'non-legacy') {
        f.frame.identity.kind = 'block';
        f.state.observed.identity.kind = 'block';
    }
    if (kind === 'known-identity-length') {
        f.frame.identity.expectedDecodedLength = 32;
        f.state.observed.identity.expectedDecodedLength = 32;
    }
    if (kind === 'custom-original') {
        f.frame.identity.originalCodecId = 'custom';
        f.state.observed.identity.originalCodecId = 'custom';
    }
    await expect(f.reader.readWindow(f.job, f.frame, 0, 1, new AbortController().signal)).rejects.toThrow('physical identity changed');
    expect(f.state).toMatchObject({released: 1, created: 0});
});
