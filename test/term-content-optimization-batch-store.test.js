/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, test, vi} from 'vitest';
import {arrayBufferDigest} from '../ext/js/core/utilities.js';
import {TermContentOptimizationBatchStore} from '../ext/js/dictionary/term-content-optimization-batch-store.js';
import {wrapCompressedTermContentBlock} from '../ext/js/dictionary/term-content-block-envelope.js';
import {createTermContentOptimizationCheckpoint, TermContentOptimizationIntegrityError, TermContentOptimizationUnsupportedFrameError} from '../ext/js/dictionary/term-content-optimization-controller.js';

/** @typedef {import('../ext/js/dictionary/term-content-optimization-batch-store.js').BatchFileObservation} Receipt */
/** @typedef {import('../ext/js/dictionary/term-content-optimization-batch-store.js').BatchSource} Source */
/** @typedef {import('../ext/js/dictionary/term-content-optimization-controller.js').OptimizationJob} Job */
/** @typedef {import('../ext/js/dictionary/term-content-optimization-controller.js').BatchPlan} Plan */
/** @typedef {import('../ext/js/dictionary/term-content-optimization-controller.js').OptimizationBatch} Batch */
/** @typedef {import('../ext/js/dictionary/term-content-optimization-checkpoint.js').OnlineContentFrameDescriptor} SourceFrame */
/** @typedef {import('../ext/js/dictionary/term-content-layout.js').PhysicalFile} PhysicalFile */
/** @typedef {import('../ext/js/dictionary/term-content-layout.js').Frame} Frame */

async function fixture() {
    const dictionary = new Uint8Array(32).fill(7);
    const sha256 = await arrayBufferDigest('SHA-256', dictionary.buffer);
    const codecId = 'manabitan-zstd-' + sha256;
    /** @type {Job} */
    const job = {
        jobId: 'job',
        dictionaryTitle: 'Test',
        dictionaryGeneration: 'generation',
        strategyVersion: 'v1',
        phase: 'recompress',
        checkpointVersion: 5,
        retryAfter: null,
        checkpoint: {
            ...createTermContentOptimizationCheckpoint('generation:v1', {dictionaryCapacity: 32768, strategy: 0, level: 1}),
            dictionary: {fileId: 'dictionary', byteLength: dictionary.byteLength, sha256},
        },
    };
    const regions = [
        {regionId: 'left', layoutId: 'left-layout', logicalStart: 0, logicalLength: 64},
        {regionId: 'right', layoutId: 'right-layout', logicalStart: 64, logicalLength: 64},
    ];
    const files = regions.map(({regionId, logicalLength}) => ({fileId: regionId + '-bytes', byteLength: logicalLength, sha256: null}));
    /** @type {Source['window']} */
    const window = {
        manifests: regions.map(({regionId, logicalStart, logicalLength}, index) => ({
            version: 1,
            regionId,
            logicalStart,
            logicalLength,
            blocks: [],
            removed: [],
            extents: [{logicalOffset: 0, length: logicalLength, physicalOffset: 0, fileId: files[index].fileId}],
        })),
        externalFrames: [],
        files,
        physicalFiles: files.map((file) => ({...file})),
        codecs: [],
    };
    /** @type {SourceFrame[]} */
    const discovered = [8, 56, 96].map((offset) => ({
        identity: {
            kind: 'block',
            logicalOffset: offset,
            recordLength: 20,
            sourceStoredLength: 20,
            originalCodecId: null,
            expectedDecodedLength: 48,
            originalEnvelope: 'mbc2',
        },
        physicalKey: 'original-' + offset,
        storedLength: 20,
        codecId: null,
        envelope: 'mbc2',
        decodedLength: 48,
        decodedDigest: null,
    }));
    const oldBytes = new Map(files.map(({fileId, byteLength}, index) => [fileId,
        Uint8Array.from({length: byteLength}, (_value, offset) => index * 64 + offset)]));
    /** @type {Map<string, Uint8Array>} */
    const stored = new Map();
    /** @type {Map<string, Receipt>} */
    const receipts = new Map();
    /** @type {Source['read']} */
    const read = async (fileId, offset, length) => {
        const bytes = oldBytes.get(fileId);
        if (!bytes) { throw new Error('No file'); }
        return bytes.slice(offset, offset + length);
    };
    const close = vi.fn(async () => {});
    /** @type {(job: Job, offset: number, signal: AbortSignal) => Promise<Source>} */
    const acquire = async (_job, offset, _signal) => {
        const start = offset < 64 ? 0 : 1;
        return {
            regions: regions.slice(start),
            window: {...window, manifests: window.manifests.slice(start)},
            describe: async (frame) => ({...frame, physicalKey: 'current-' + frame.identity.logicalOffset}),
            read,
            close,
        };
    };
    const observe = vi.fn(async (/** @type {string} */ fileId) => stored.get(fileId)?.byteLength ?? null);
    const write = vi.fn(async (
        /** @type {string} */ fileId,
        /** @type {AsyncIterable<Uint8Array>|Iterable<Uint8Array>} */ chunks,
        /** @type {{expectedByteLength: number}} */ {expectedByteLength},
    ) => {
        const bytes = new Uint8Array(expectedByteLength);
        let at = 0;
        for await (const chunk of chunks) {
            bytes.set(chunk, at);
            at += chunk.byteLength;
        }
        if (at !== expectedByteLength) { throw new Error('Wrong length'); }
        stored.set(fileId, bytes);
        return at;
    });
    const readSlice = vi.fn(async (
        /** @type {string} */ fileId,
        /** @type {number} */ expected,
        /** @type {number} */ offset,
        /** @type {number} */ length,
    ) => {
        const bytes = stored.get(fileId);
        if (!bytes || bytes.byteLength !== expected || offset + length > expected) { throw new Error('Invalid closed file'); }
        return bytes.slice(offset, offset + length);
    });
    const remove = vi.fn(async (/** @type {string} */ fileId) => { stored.delete(fileId); });
    const observeSeal = vi.fn();
    /** @type {(job: Job, observations: PhysicalFile[]) => void} */
    const seal = (owner, observations) => {
        observeSeal();
        for (const observation of observations) {
            receipts.set(observation.fileId, {...observation, ownerJobId: owner.jobId, state: 'staged'});
        }
    };
    const freshBytes = wrapCompressedTermContentBlock(Uint8Array.of(10, 11));
    const recompress = vi.fn(async (
        /** @type {Job} */ _job,
        /** @type {SourceFrame} */ original,
        /** @type {Uint8Array} */ _dictionary,
        /** @type {{fileId: string, physicalOffset: number}} */ destination,
    ) => ({
        bytes: new Uint8Array(freshBytes),
        frame: /** @type {Frame} */ ({
            ...original.identity,
            ...destination,
            codecId,
            envelope: 'mbc2',
            storedLength: freshBytes.byteLength,
            decodedLength: original.decodedLength ?? 0,
            decodedDigest: 'f'.repeat(64),
        }),
    }));
    const verify = vi.fn(async (
        /** @type {Job} */ _job,
        /** @type {SourceFrame} */ _original,
        /** @type {Frame} */ frame,
        /** @type {Uint8Array} */ _dictionary,
        /** @type {(frame: Frame, signal: AbortSignal) => AsyncIterable<Uint8Array>} */ readChunks,
        /** @type {AbortSignal} */ signal,
    ) => {
        const closed = new Uint8Array(frame.storedLength);
        let offset = 0;
        for await (const chunk of readChunks(frame, signal)) {
            closed.set(chunk, offset);
            offset += chunk.byteLength;
        }
        expect(closed).toEqual(freshBytes);
    });
    const batchStore = new TermContentOptimizationBatchStore({
        store: {observe, write, readSlice, remove},
        replacement: {recompress, verify},
        frames: (_job, after, limit) => discovered.filter(({identity}) => identity.logicalOffset > (after ?? -1)).slice(0, limit),
        acquire,
        lookup: (_job, fileId) => {
            const result = receipts.get(fileId);
            if (!result) { throw new Error('No intent'); }
            return result;
        },
        seal,
        assertOwned: () => {},
        readDictionary: async () => new Uint8Array(dictionary),
    });
    /**
     * @param {Plan|null} plan
     * @returns {Batch}
     */
    const reserve = (plan) => {
        if (plan === null) { throw new Error('Expected a plan'); }
        for (const fileId of plan.fileIds) { receipts.set(fileId, {fileId, ownerJobId: job.jobId, state: 'intent', byteLength: 0, sha256: null}); }
        return {...plan, stage: 'write', verifyCursor: null};
    };
    return {job, dictionary, codecId, discovered, stored, write, readSlice, remove, observeSeal, recompress, verify, reserve, batchStore, signal: new AbortController().signal};
}

test('stages a complete crossing frame and resumes sealed independent verification without writing again', async () => {
    const {job, dictionary, codecId, stored, write, observeSeal, recompress, verify, reserve, batchStore, signal} = await fixture();
    const first = reserve(await batchStore.planBatch(job, null, signal));
    expect(first.fileIds).toHaveLength(3);
    expect(first.nextCursor).toBe(56);
    expect(first.last).toBe(false);
    await batchStore.stageBatch(job, first, dictionary, signal);
    const receipt = await batchStore.readPreparedBatch(job, first, signal);
    expect(receipt.layouts.map(({regionId}) => regionId)).toEqual(['left', 'right']);
    expect(receipt.codec?.codecId).toBe(codecId);
    expect(receipt.retiredCandidates).toEqual(['left-bytes', 'right-bytes']);
    expect(receipt.replacements.map(({frame}) => frame.logicalOffset)).toEqual([8, 56]);
    expect(stored.get(first.fileIds[1])?.subarray(0, 8)).toEqual(Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]));
    expect(stored.get(first.fileIds[2])?.[0]).toBe(76);
    expect(write).toHaveBeenCalledTimes(3);
    expect(observeSeal).toHaveBeenCalledOnce();

    await batchStore.stageBatch(job, first, dictionary, signal);
    expect(recompress).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledTimes(3);
    expect(await batchStore.verificationPage(job, first, null, signal)).toEqual({cursor: 1, done: false});
    expect(await batchStore.verificationPage(job, first, 1, signal)).toEqual({cursor: 2, done: true});
    expect(verify).toHaveBeenCalledTimes(2);

    const last = await batchStore.planBatch(job, first.nextCursor, signal);
    expect(last?.fileIds).toHaveLength(2);
    expect(last?.nextCursor).toBe(96);
    expect(last?.last).toBe(true);
    expect(await batchStore.planBatch(job, last?.nextCursor, signal)).toBeNull();
});

test('replaces only bytes covered by an unpublished intent and requires closed retained parity before sealing', async () => {
    const {job, dictionary, stored, readSlice, write, remove, observeSeal, reserve, batchStore, signal} = await fixture();
    const batch = reserve(await batchStore.planBatch(job, null, signal));
    const existing = batch.fileIds[1];
    stored.set(existing, Uint8Array.of(1, 2, 3));
    readSlice.mockImplementationOnce(async (_fileId, _expected, _offset, length) => new Uint8Array(length).fill(255));
    await expect(batchStore.stageBatch(job, batch, dictionary, signal)).rejects.toBeInstanceOf(TermContentOptimizationIntegrityError);
    expect(remove).toHaveBeenCalledExactlyOnceWith(existing);
    expect(observeSeal).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledOnce();
    await batchStore.stageBatch(job, batch, dictionary, signal);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(observeSeal).toHaveBeenCalledOnce();
});

test('an oversized frame cannot turn a partial pass into a no-gain disposition', async () => {
    const {job, discovered, batchStore, signal} = await fixture();
    const decodedLength = 16 * 1024 * 1024 + 1;
    discovered[1].decodedLength = decodedLength;
    discovered[1].identity.expectedDecodedLength = decodedLength;
    const first = await batchStore.planBatch(job, null, signal);
    expect(first?.nextCursor).toBe(8);
    expect(first?.last).toBe(false);
    await expect(batchStore.planBatch(job, first?.nextCursor, signal)).rejects.toBeInstanceOf(TermContentOptimizationUnsupportedFrameError);
});
