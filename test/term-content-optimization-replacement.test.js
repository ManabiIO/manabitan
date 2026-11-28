/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, test, vi} from 'vitest';
import {wrapCompressedTermContentBlock} from '../ext/js/dictionary/term-content-block-envelope.js';
import {TermContentFrameCodecError} from '../ext/js/dictionary/term-content-frame-codec-worker-owner.js';
import {createTermContentOptimizationCheckpoint, TermContentOptimizationIntegrityError, TermContentOptimizationUnsupportedFrameError} from '../ext/js/dictionary/term-content-optimization-controller.js';
import {TermContentOptimizationReplacement} from '../ext/js/dictionary/term-content-optimization-replacement.js';

/** @typedef {import('../ext/js/dictionary/term-content-optimization-controller.js').OptimizationJob} Job */
/** @typedef {import('../ext/js/dictionary/term-content-optimization-checkpoint.js').OnlineContentFrameDescriptor} SourceFrame */
/** @typedef {import('../ext/js/dictionary/term-content-frame-codec-worker-owner.js').TermContentFrameCodecRequest} CodecRequest */
/** @typedef {import('../ext/js/dictionary/term-content-layout.js').Frame} ReplacementFrame */

function fixture() {
    /** @type {Job} */
    const job = {
        jobId: 'job',
        dictionaryTitle: 'Dictionary',
        dictionaryGeneration: 'generation',
        strategyVersion: 'v1',
        phase: 'recompress',
        checkpointVersion: 0,
        retryAfter: null,
        checkpoint: createTermContentOptimizationCheckpoint('generation:v1', {dictionaryCapacity: 32768, strategy: 0, level: 3}),
    };
    const canonical = new Uint8Array([97, 98, 99]);
    const dictionary = new Uint8Array(32).fill(4);
    /** @type {SourceFrame} */
    const source = {
        identity: {
            kind: 'block',
            logicalOffset: 128,
            recordLength: 32,
            sourceStoredLength: 32,
            originalCodecId: null,
            expectedDecodedLength: canonical.byteLength,
            originalEnvelope: 'mbc2',
        },
        physicalKey: 'private-source',
        storedLength: 32,
        codecId: null,
        envelope: 'mbc2',
        decodedLength: canonical.byteLength,
        decodedDigest: null,
    };
    const destination = {fileId: 'pack', physicalOffset: 64};
    const staged = wrapCompressedTermContentBlock(new Uint8Array([1, 2, 3, 4]));
    const readFrame = vi.fn(async (/** @type {Job} */ _job, /** @type {SourceFrame} */ _frame, /** @type {AbortSignal} */ _signal) => new Uint8Array(canonical));
    const compressor = {run: vi.fn(async (/** @type {CodecRequest} */ _request) => new Uint8Array(staged)), close: vi.fn()};
    const stageDecoder = {run: vi.fn(async (/** @type {CodecRequest} */ _request) => new Uint8Array(canonical)), close: vi.fn()};
    const createCodec = vi.fn().mockReturnValueOnce(compressor).mockReturnValue(stageDecoder);
    const replacement = new TermContentOptimizationReplacement({reader: {readFrame}, createCodec});
    const signal = new AbortController().signal;

    const observeClosedRead = vi.fn();
    /**
     * @param {Uint8Array} closed
     * @returns {(frame: Readonly<ReplacementFrame>, signal: AbortSignal) => AsyncIterable<Uint8Array>}
     */
    const readClosed = (closed) => async function *read(frame, readSignal) {
        observeClosedRead(frame, readSignal);
        yield closed.subarray(0, 3);
        yield closed.subarray(3);
    };

    return {job, canonical, dictionary, source, destination, staged, readFrame, compressor, stageDecoder, createCodec, replacement, signal, readClosed, observeClosedRead};
}

test('writes an MBC2 candidate and independently verifies the exact staged physical span', async () => {
    const {job, canonical, dictionary, source, destination, staged, readFrame, compressor, stageDecoder, createCodec, replacement, signal, readClosed, observeClosedRead} = fixture();
    const candidate = await replacement.recompress(job, source, dictionary, destination, signal);
    expect(candidate.bytes).toEqual(staged);
    expect(candidate.frame).toEqual({
        ...source.identity,
        ...destination,
        codecId: expect.stringMatching(/^manabitan-zstd-[a-f0-9]{64}$/),
        envelope: 'mbc2',
        storedLength: staged.byteLength,
        decodedLength: canonical.byteLength,
        decodedDigest: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    });
    expect(compressor.run).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({action: 'compress', bytes: canonical, wrap: true, level: 3}), {signal});
    expect(compressor.close).toHaveBeenCalledOnce();

    // Use a distinct closed observation so the verifier cannot accidentally
    // decode the compressor's in-memory output. The mocked codec makes the
    // alternate MBC2 payload decode to the same canonical content.
    const closed = wrapCompressedTermContentBlock(new Uint8Array([5, 6, 7, 8]));
    const read = readClosed(closed);
    await replacement.verify(job, source, candidate.frame, dictionary, read, signal);
    expect(createCodec).toHaveBeenCalledTimes(2);
    expect(readFrame).toHaveBeenCalledTimes(2);
    expect(observeClosedRead).toHaveBeenCalledExactlyOnceWith(candidate.frame, signal);
    expect(stageDecoder.run).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        action: 'decode',
        bytes: closed,
        codecId: candidate.frame.codecId,
        dictionary,
        envelope: 'mbc2',
        expectedDecodedLength: canonical.byteLength,
        maxOutputSize: canonical.byteLength,
    }), {signal});
    expect(stageDecoder.close).toHaveBeenCalledOnce();
});

test('rejects a valid staged digest when the independently read source bytes disagree', async () => {
    const {job, dictionary, source, destination, staged, readFrame, replacement, signal, readClosed} = fixture();
    const {frame} = await replacement.recompress(job, source, dictionary, destination, signal);
    readFrame.mockResolvedValueOnce(new Uint8Array([97, 98, 100]));
    await expect(replacement.verify(job, source, frame, dictionary, readClosed(staged), signal))
        .rejects.toThrow('canonical bytes differ from the original');
});

test('rejects staged canonical digest mismatches and closes its decoder context', async () => {
    const {job, dictionary, source, destination, staged, stageDecoder, replacement, signal, readClosed} = fixture();
    const {frame} = await replacement.recompress(job, source, dictionary, destination, signal);
    stageDecoder.run.mockResolvedValueOnce(new Uint8Array([97, 98, 100]));
    await expect(replacement.verify(job, source, frame, dictionary, readClosed(staged), signal))
        .rejects.toThrow('canonical digest disagrees with its manifest');
    expect(stageDecoder.close).toHaveBeenCalledOnce();
});

test('requires an exact closed physical length and a content-addressed dictionary', async () => {
    const {job, dictionary, source, destination, staged, stageDecoder, replacement, signal, readClosed, observeClosedRead} = fixture();
    const {frame} = await replacement.recompress(job, source, dictionary, destination, signal);
    const truncated = readClosed(staged.subarray(0, staged.byteLength - 1));
    await expect(replacement.verify(job, source, frame, dictionary, truncated, signal)).rejects.toThrow('ended before its immutable span');
    const extra = readClosed(new Uint8Array(staged.byteLength + 1));
    await expect(replacement.verify(job, source, frame, dictionary, extra, signal)).rejects.toThrow('exceeds its immutable span');
    observeClosedRead.mockClear();
    const read = readClosed(staged);
    const wrongDictionary = dictionary.map((value) => value + 1);
    await expect(replacement.verify(job, source, frame, wrongDictionary, read, signal)).rejects.toThrow('disagrees with its codec identity');
    await expect(replacement.verify(job, source, {...frame, logicalOffset: frame.logicalOffset + 1}, dictionary, read, signal)).rejects.toThrow('metadata disagrees');
    expect(observeClosedRead).not.toHaveBeenCalled();
    expect(stageDecoder.run).not.toHaveBeenCalled();
});

test('preserves the distinction between deterministic integrity and transient codec failure', async () => {
    const {job, dictionary, source, destination, staged, stageDecoder, replacement, signal, readClosed} = fixture();
    const {frame} = await replacement.recompress(job, source, dictionary, destination, signal);
    const corruption = new TermContentFrameCodecError('invalid MBC2 checksum', 'invalid-input');
    stageDecoder.run.mockRejectedValueOnce(corruption);
    await expect(replacement.verify(job, source, frame, dictionary, readClosed(staged), signal)).rejects.toBeInstanceOf(TermContentOptimizationIntegrityError);
    const unavailable = new TermContentFrameCodecError('codec temporarily unavailable');
    stageDecoder.run.mockRejectedValueOnce(unavailable);
    await expect(replacement.verify(job, source, frame, dictionary, readClosed(staged), signal)).rejects.toBe(unavailable);
    expect(stageDecoder.close).toHaveBeenCalledTimes(2);
});

test('foreground abort closes the staged iterator and prevents codec admission', async () => {
    const {job, dictionary, source, destination, staged, stageDecoder, readFrame, replacement, signal} = fixture();
    const {frame} = await replacement.recompress(job, source, dictionary, destination, signal);
    const controller = new AbortController();
    const closed = vi.fn();
    await expect(replacement.verify(job, source, frame, dictionary, async function *read() {
        try {
            controller.abort();
            yield staged;
        } finally {
            closed();
        }
    }, controller.signal)).rejects.toMatchObject({name: 'AbortError'});
    expect(closed).toHaveBeenCalledOnce();
    expect(readFrame).toHaveBeenCalledOnce();
    expect(stageDecoder.run).not.toHaveBeenCalled();
});

test('foreground abort reaches the decoder and closes its temporary context', async () => {
    const {job, dictionary, source, destination, staged, stageDecoder, replacement, signal, readClosed} = fixture();
    const {frame} = await replacement.recompress(job, source, dictionary, destination, signal);
    const controller = new AbortController();
    stageDecoder.run.mockImplementationOnce(async () => {
        controller.abort();
        throw controller.signal.reason;
    });
    await expect(replacement.verify(job, source, frame, dictionary, readClosed(staged), controller.signal))
        .rejects.toMatchObject({name: 'AbortError'});
    expect(stageDecoder.run).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({action: 'decode'}), {signal: controller.signal});
    expect(stageDecoder.close).toHaveBeenCalledOnce();
});

test('jumbo frames are explicitly unsupported before reading or opening a codec', async () => {
    const {job, dictionary, source, destination, readFrame, createCodec, replacement, signal} = fixture();
    const decodedLength = 16 * 1024 * 1024 + 1;
    const giant = {...source, decodedLength, identity: {...source.identity, expectedDecodedLength: decodedLength}};
    await expect(replacement.recompress(job, giant, dictionary, destination, signal)).rejects.toBeInstanceOf(TermContentOptimizationUnsupportedFrameError);
    expect(readFrame).not.toHaveBeenCalled();
    expect(createCodec).not.toHaveBeenCalled();
});
