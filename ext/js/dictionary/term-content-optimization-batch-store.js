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

import {parseJson} from '../core/json.js';
import {arrayBufferDigest} from '../core/utilities.js';
import {parseOnlineContentFrameDescriptor} from './term-content-optimization-checkpoint.js';
import {TermContentOptimizationIntegrityError, TermContentOptimizationUnsupportedFrameError} from './term-content-optimization-controller.js';
import {iterateContentRepackCopyChunks, planContentRegionRepack} from './term-content-region-repack-planner.js';

/** @typedef {import('./term-content-optimization-controller.js').OptimizationJob} Job */
/** @typedef {import('./term-content-optimization-controller.js').OptimizationBatch} Batch */
/** @typedef {import('./term-content-optimization-controller.js').BatchPlan} BatchPlan */
/** @typedef {import('./term-content-optimization-checkpoint.js').OnlineContentFrameDescriptor} SourceFrame */
/** @typedef {import('./term-content-layout.js').Frame} Frame */
/** @typedef {import('./term-content-layout.js').PhysicalFile} PhysicalFile */
/** @typedef {import('./term-content-layout.js').Codec} Codec */
/** @typedef {import('./term-content-storage-snapshots.js').ContentRootRegion} Region */
/** @typedef {import('./term-content-region-repack-planner.js').ContentRepackWindow} Window */
/** @typedef {import('./term-content-region-repack-planner.js').ContentRepackWrite} PackWrite */
/** @typedef {import('./term-content-region-repack-planner.js').ContentRepackCopyChunk} CopyChunk */
/** @typedef {Pick<import('./term-content-immutable-file-store.js').TermContentImmutableFileStore, 'observe'|'write'|'readSlice'|'remove'>} FileStore */
/** @typedef {Pick<import('./term-content-optimization-replacement.js').TermContentOptimizationReplacement, 'recompress'|'verify'>} Replacement */
/** @typedef {{regions: Region[], window: Window, describe: (frame: SourceFrame) => Promise<SourceFrame>, read: (fileId: string, offset: number, length: number) => Promise<Uint8Array>, close: () => Promise<void>}} BatchSource */
/** @typedef {{fileId: string, ownerJobId: string, state: 'intent'|'staged', byteLength: number, sha256: string|null}} BatchFileObservation */
/** @typedef {{after: number|null, lastOffset: number, count: number, sourceLayouts: Region[]}} BatchToken */
/** @typedef {{layoutId: string, regionId: string, manifest: import('./term-content-layout.js').Manifest, manifestSha256: string}} StagedLayout */
/** @typedef {{source: SourceFrame, frame: Frame}} VerifiedReplacement */
/** @typedef {{version: 1, batchId: string, sourceLayouts: Region[], layouts: StagedLayout[], files: PhysicalFile[], retiredCandidates: string[], codec: Codec|null, replacements: VerifiedReplacement[]}} PreparedContentOptimizationBatch */

/**
 * @typedef {object} BatchStoreOptions
 * @property {FileStore} store
 * @property {Replacement} replacement
 * @property {(job: Job, after: number|null, limit: number) => SourceFrame[]} frames
 * @property {(job: Job, offset: number, signal: AbortSignal) => Promise<BatchSource>} acquire
 * @property {(job: Job, fileId: string) => BatchFileObservation} lookup
 * @property {(job: Job, files: PhysicalFile[]) => void} seal
 * @property {(job: Job) => void} assertOwned
 * @property {(job: Job, signal: AbortSignal) => Promise<Uint8Array>} readDictionary
 */

const MAX_FRAMES = 255;
const MAX_CODEC_BYTES = 16 * 1024 * 1024;
// Canonical frames are decoded one at a time. The retained in-memory spool
// consists only of compressed improvements, bounded by admitted stored bytes.
const MAX_BATCH_CANONICAL_BYTES = 384 * 1024 * 1024;
const MAX_SPOOL_BYTES = 64 * 1024 * 1024;
const MAX_PLAN_BYTES = 4 * 1024 * 1024;
const COPY_CHUNK_BYTES = 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true});

/**
 * Stages a bounded run of frame offsets under one or two adjacent region
 * layouts. Every file write follows its durable SQL intent. The final plan is
 * the stage receipt and becomes visible atomically with the sealed packs.
 */
export class TermContentOptimizationBatchStore {
    /**
     * @param {BatchStoreOptions} options
     */
    constructor({store, replacement, frames, acquire, lookup, seal, assertOwned, readDictionary}) {
        /** @type {FileStore} */
        this._store = store;
        /** @type {Replacement} */
        this._replacement = replacement;
        /** @type {BatchStoreOptions['frames']} */
        this._frames = frames;
        /** @type {BatchStoreOptions['acquire']} */
        this._acquire = acquire;
        /** @type {BatchStoreOptions['lookup']} */
        this._lookup = lookup;
        /** @type {BatchStoreOptions['seal']} */
        this._seal = seal;
        /** @type {BatchStoreOptions['assertOwned']} */
        this._assertOwned = assertOwned;
        /** @type {BatchStoreOptions['readDictionary']} */
        this._readDictionary = readDictionary;
    }

    /**
     * @param {Job} job
     * @param {unknown} cursor
     * @param {AbortSignal} signal
     * @returns {Promise<BatchPlan|null>}
     */
    async planBatch(job, cursor, signal) {
        this._check(job, signal);
        if (cursor !== null && !isOffset(cursor)) { throw new TypeError('Invalid repack frame cursor'); }
        const after = /** @type {number|null} */ (cursor);
        const observed = this._readFrames(job, after, MAX_FRAMES + 1);
        if (observed.length === 0) { return null; }
        const source = await this._acquire(job, observed[0].identity.logicalOffset, signal);
        try {
            this._check(job, signal);
            const first = source.regions[0];
            const second = source.regions[1];
            const firstEnd = first.logicalStart + first.logicalLength;
            const maximumEnd = second ? second.logicalStart + second.logicalLength : firstEnd;
            let count = 0;
            let decodedBytes = 0;
            let storedBytes = 0;
            let usesSecond = false;
            for (const frame of observed) {
                const {logicalOffset, sourceStoredLength} = frame.identity;
                if (logicalOffset < first.logicalStart) { throw new TermContentOptimizationIntegrityError('Repack frame precedes its source region'); }
                if (count === MAX_FRAMES || logicalOffset >= firstEnd) { break; }
                const end = logicalOffset + sourceStoredLength;
                if (end > maximumEnd || frame.decodedLength === null ||
                frame.decodedLength > MAX_CODEC_BYTES || frame.storedLength > MAX_CODEC_BYTES) {
                    if (count > 0) { break; }
                    throw new TermContentOptimizationUnsupportedFrameError('Repack frame exceeds the bounded whole-frame or region window');
                }
                if (decodedBytes + frame.decodedLength > MAX_BATCH_CANONICAL_BYTES || storedBytes + frame.storedLength > MAX_SPOOL_BYTES) { break; }
                ++count;
                decodedBytes += frame.decodedLength;
                storedBytes += frame.storedLength;
                usesSecond ||= end > firstEnd;
            }
            if (count === 0) { throw new TermContentOptimizationIntegrityError('Repack planning made no frame progress'); }
            const sourceLayouts = source.regions.slice(0, usesSecond ? 2 : 1);
            const lastOffset = observed[count - 1].identity.logicalOffset;
            const id = 'batch-' + crypto.randomUUID();
            const fileIds = [planId(id), ...sourceLayouts.map((_region, index) => packId(id, index))];
            const last = count === observed.length && this._readFrames(job, lastOffset, 1).length === 0;
            /** @type {BatchToken} */
            const token = {after, lastOffset, count, sourceLayouts};
            return {id, fileIds, token, nextCursor: lastOffset, last};
        } finally {
            await source.close();
        }
    }

    /**
     * @param {Job} job
     * @param {Batch} batch
     * @param {Uint8Array} dictionary
     * @param {AbortSignal} signal
     * @returns {Promise<void>}
     */
    async stageBatch(job, batch, dictionary, signal) {
        const token = readToken(batch);
        const artifact = this._file(job, planId(batch.id), signal);
        if (artifact.state === 'staged') {
            await this.readPreparedBatch(job, batch, signal);
            return;
        }
        const checkpoints = this._readFrames(job, token.after, token.count);
        if (checkpoints.length !== token.count || checkpoints.at(-1)?.identity.logicalOffset !== token.lastOffset) {
            throw new TermContentOptimizationIntegrityError('Durable repack frame selection changed');
        }
        const source = await this._acquire(job, checkpoints[0].identity.logicalOffset, signal);
        try {
            this._check(job, signal);
            if (JSON.stringify(source.regions.slice(0, token.sourceLayouts.length)) !== JSON.stringify(token.sourceLayouts)) {
                throw new TermContentOptimizationIntegrityError('Repack source layout changed before staging');
            }
            const prepared = await this._stageUnderLease(job, batch, token, checkpoints, dictionary, source, signal);
            const metadata = encoder.encode(JSON.stringify(prepared));
            if (metadata.byteLength > MAX_PLAN_BYTES) {
                throw new TermContentOptimizationUnsupportedFrameError('Repack plan receipt exceeds its byte admission');
            }
            const sha256 = await arrayBufferDigest('SHA-256', metadata.buffer);
            this._check(job, signal);
            /**
             * @param {CopyChunk} chunk
             * @returns {Promise<Uint8Array>}
             */
            const readPlanBytes = async (chunk) => metadata.subarray(chunk.sourceOffset, chunk.sourceOffset + chunk.length);
            await this._writeAndVerify(job, metadataWrite(batch.id, metadata.byteLength), readPlanBytes, signal);
            this._check(job, signal);
            // The stage receipt is the visibility fence for all packs. A late
            // acknowledgement is replayed by reading the already sealed plan.
            this._seal(job, [...prepared.files, {fileId: planId(batch.id), byteLength: metadata.byteLength, sha256}]);
        } finally {
            await source.close();
        }
    }

    /**
     * @param {Job} job
     * @param {Batch} batch
     * @param {BatchToken} token
     * @param {SourceFrame[]} checkpoints
     * @param {Uint8Array} dictionary
     * @param {BatchSource} source
     * @param {AbortSignal} signal
     * @returns {Promise<PreparedContentOptimizationBatch>}
     */
    async _stageUnderLease(job, batch, token, checkpoints, dictionary, source, signal) {
        /** @type {PreparedContentOptimizationBatch} */
        const prepared = {
            version: 1,
            batchId: batch.id,
            sourceLayouts: token.sourceLayouts,
            layouts: [],
            files: [],
            retiredCandidates: [],
            codec: null,
            replacements: [],
        };
        const dictionaryFile = job.checkpoint.dictionary;
        if (dictionaryFile === null || dictionaryFile.byteLength !== dictionary.byteLength) {
            throw new TermContentOptimizationIntegrityError('Repack dictionary receipt is missing');
        }
        const codecId = 'manabitan-zstd-' + dictionaryFile.sha256;
        const spoolId = batch.id + '-buffer';
        /** @type {Map<number, {offset: number, bytes: Uint8Array}>} */
        const inMemory = new Map();
        /** @type {Map<number, SourceFrame>} */
        const originalFrames = new Map();
        /** @type {Frame[]} */
        const replacements = [];
        let spoolLength = 0;
        for (const checkpoint of checkpoints) {
            this._check(job, signal);
            const original = await refreshSourceFrame(source, checkpoint);
            const result = await this._replacement.recompress(job, original, dictionary, {fileId: spoolId, physicalOffset: spoolLength}, signal);
            this._check(job, signal);
            if (result.frame.codecId !== codecId) { throw new TermContentOptimizationIntegrityError('Repack dictionary identity changed'); }
            if (result.bytes.byteLength >= original.storedLength) { continue; }
            const offset = original.identity.logicalOffset;
            inMemory.set(offset, {offset: spoolLength, bytes: result.bytes});
            originalFrames.set(offset, original);
            replacements.push(result.frame);
            spoolLength += result.bytes.byteLength;
            if (spoolLength > MAX_SPOOL_BYTES) { throw new TermContentOptimizationUnsupportedFrameError('Repack buffer exceeds its byte admission'); }
        }
        if (replacements.length === 0) { return prepared; }
        const window = trimWindow(source.window, token.sourceLayouts.length);
        const oldFiles = new Set(window.files.map((file) => file.fileId));
        const codec = window.codecs.find((entry) => entry.codecId === codecId) ?? {
            codecId,
            fileId: dictionaryFile.fileId,
            formatVersion: 1,
            dictionaryBytes: dictionaryFile.byteLength,
            dictionarySha256: dictionaryFile.sha256,
        };
        if (!oldFiles.has(codec.fileId)) {
            const file = {fileId: codec.fileId, byteLength: codec.dictionaryBytes, sha256: codec.dictionarySha256};
            window.files.push(file);
            window.physicalFiles.push({...file});
        }
        if (!window.codecs.some((entry) => entry.codecId === codecId)) { window.codecs.push(codec); }
        const spool = {fileId: spoolId, byteLength: spoolLength, sha256: null};
        window.files.push(spool);
        window.physicalFiles.push({...spool});
        const repack = planContentRegionRepack({
            source: window,
            replacements,
            packFiles: token.sourceLayouts.map(({regionId}, index) => ({regionId, fileId: packId(batch.id, index)})),
            relocateFrames: true,
        });
        /**
         * @param {CopyChunk} chunk
         * @returns {Promise<Uint8Array>}
         */
        const readCopyBytes = async (chunk) => {
            this._check(job, signal);
            if (chunk.sourceFileId !== spoolId) { return await source.read(chunk.sourceFileId, chunk.sourceOffset, chunk.length); }
            const entry = inMemory.get(chunk.logicalOffset);
            if (!entry || chunk.sourceOffset < entry.offset || chunk.sourceOffset + chunk.length > entry.offset + entry.bytes.byteLength) {
                throw new TermContentOptimizationIntegrityError('Repack copy escaped its replacement buffer');
            }
            const offset = chunk.sourceOffset - entry.offset;
            return entry.bytes.subarray(offset, offset + chunk.length);
        };

        for (const write of repack.writes) {
            await this._writeAndVerify(job, write, readCopyBytes, signal);
            prepared.files.push({fileId: write.fileId, byteLength: write.byteLength, sha256: null});
        }
        for (let index = 0; index < repack.next.manifests.length; ++index) {
            const manifest = repack.next.manifests[index];
            const bytes = encoder.encode(JSON.stringify(manifest));
            const manifestSha256 = await arrayBufferDigest('SHA-256', bytes.buffer);
            this._check(job, signal);
            prepared.layouts.push({layoutId: batch.id + '-layout-' + index, regionId: manifest.regionId, manifest, manifestSha256});
            for (const frame of manifest.blocks) {
                const logicalOffset = manifest.logicalStart + frame.logicalOffset;
                const original = originalFrames.get(logicalOffset);
                if (original) { prepared.replacements.push({source: original, frame: {...frame, logicalOffset}}); }
            }
        }
        if (prepared.replacements.length !== replacements.length) {
            throw new TermContentOptimizationIntegrityError('Repack layouts lost a replacement frame');
        }
        prepared.retiredCandidates = repack.unreferencedInWindow.filter((fileId) => oldFiles.has(fileId));
        prepared.codec = codec;
        return prepared;
    }

    /**
     * @param {Job} job
     * @param {Batch} batch
     * @param {unknown} cursor
     * @param {AbortSignal} signal
     * @returns {Promise<{cursor: number, done: boolean}>}
     */
    async verificationPage(job, batch, cursor, signal) {
        const prepared = await this.readPreparedBatch(job, batch, signal);
        if (cursor !== null && !isOffset(cursor)) { throw new TypeError('Invalid repack verification cursor'); }
        const index = cursor === null ? 0 : /** @type {number} */ (cursor);
        if (index > prepared.replacements.length) { throw new TermContentOptimizationIntegrityError('Repack verification cursor exceeds its receipt'); }
        const replacement = prepared.replacements[index];
        if (!replacement) { return {cursor: index, done: true}; }
        const file = prepared.files.find(({fileId}) => fileId === replacement.frame.fileId);
        if (!file) { throw new TermContentOptimizationIntegrityError('Repack replacement file is outside the sealed plan'); }
        const dictionary = await this._readDictionary(job, signal);
        this._check(job, signal);
        const check = () => this._check(job, signal);
        const store = this._store;
        await this._replacement.verify(job, replacement.source, replacement.frame, dictionary, async function *readClosed(frame) {
            for (let offset = 0; offset < frame.storedLength; offset += COPY_CHUNK_BYTES) {
                check();
                const length = Math.min(COPY_CHUNK_BYTES, frame.storedLength - offset);
                yield await store.readSlice(frame.fileId, file.byteLength, frame.physicalOffset + offset, length);
            }
        }, signal);
        this._check(job, signal);
        return {cursor: index + 1, done: index + 1 === prepared.replacements.length};
    }

    /**
     * @param {Job} job
     * @param {Batch} batch
     * @param {AbortSignal} signal
     * @returns {Promise<PreparedContentOptimizationBatch>}
     */
    async readPreparedBatch(job, batch, signal) {
        const token = readToken(batch);
        const observation = this._file(job, planId(batch.id), signal);
        if (observation.state !== 'staged' || observation.byteLength <= 0 || observation.byteLength > MAX_PLAN_BYTES ||
        observation.sha256 === null) {
            throw new TermContentOptimizationIntegrityError('Repack plan receipt was not sealed');
        }
        const bytes = await this._store.readSlice(observation.fileId, observation.byteLength, 0, observation.byteLength);
        this._check(job, signal);
        const sha256 = await digestBytes(bytes);
        this._check(job, signal);
        if (sha256 !== observation.sha256) { throw new TermContentOptimizationIntegrityError('Repack plan receipt checksum changed'); }
        /** @type {PreparedContentOptimizationBatch} */
        let prepared;
        try {
            prepared = /** @type {PreparedContentOptimizationBatch} */ (parseJson(decoder.decode(bytes)));
        } catch {
            throw new TermContentOptimizationIntegrityError('Repack plan receipt is unreadable');
        }
        if (prepared?.version !== 1 || prepared.batchId !== batch.id ||
        JSON.stringify(prepared.sourceLayouts) !== JSON.stringify(token.sourceLayouts) ||
        !Array.isArray(prepared.layouts) || !Array.isArray(prepared.files) || !Array.isArray(prepared.retiredCandidates) ||
        !Array.isArray(prepared.replacements) || prepared.replacements.length > token.count ||
        prepared.layouts.length !== (prepared.replacements.length === 0 ? 0 : token.sourceLayouts.length) ||
        prepared.files.length > prepared.layouts.length || (prepared.codec === null) !== (prepared.replacements.length === 0)) {
            throw new TermContentOptimizationIntegrityError('Repack plan receipt metadata disagrees with its intent');
        }
        for (const file of prepared.files) {
            if (!batch.fileIds.includes(file.fileId) || file.fileId === observation.fileId) {
                throw new TermContentOptimizationIntegrityError('Repack plan references an unreserved file');
            }
            const receipt = this._file(job, file.fileId, signal);
            if (receipt.state !== 'staged' || receipt.byteLength !== file.byteLength || receipt.sha256 !== file.sha256) {
                throw new TermContentOptimizationIntegrityError('Repack plan file seal changed');
            }
            const size = await this._store.observe(file.fileId);
            this._check(job, signal);
            if (size !== file.byteLength) {
                throw new TermContentOptimizationIntegrityError('Closed repack pack is missing or has changed size');
            }
        }
        return prepared;
    }

    /**
     * @param {Job} job
     * @param {PackWrite} write
     * @param {(chunk: CopyChunk) => Promise<Uint8Array>} readSource
     * @param {AbortSignal} signal
     */
    async _writeAndVerify(job, write, readSource, signal) {
        const file = this._file(job, write.fileId, signal);
        if (file.state !== 'intent') { throw new TermContentOptimizationIntegrityError('Repack writer does not own an unpublished file'); }
        const exists = await this._store.observe(write.fileId);
        this._file(job, write.fileId, signal);
        if (exists !== null && exists > 0) {
            // The absent seal proves any existing bytes are unpublished. A
            // retry can discard them after the prior writer has been joined.
            await this._store.remove(write.fileId);
            this._file(job, write.fileId, signal);
        }
        const check = () => this._check(job, signal);
        /**
         * @yields {Uint8Array}
         */
        async function *sourceChunks() {
            for (const chunk of iterateContentRepackCopyChunks({writes: [write]}, COPY_CHUNK_BYTES)) {
                check();
                const bytes = await readSource(chunk);
                check();
                if (bytes.byteLength !== chunk.length) { throw new TermContentOptimizationIntegrityError('Repack copy source returned a short byte range'); }
                yield bytes;
            }
        }
        const observed = await this._store.write(write.fileId, sourceChunks(), {expectedByteLength: write.byteLength, signal});
        this._check(job, signal);
        if (observed !== write.byteLength) { throw new TermContentOptimizationIntegrityError('Repack output length changed after close'); }
        for (const chunk of iterateContentRepackCopyChunks({writes: [write]}, COPY_CHUNK_BYTES)) {
            const expected = await readSource(chunk);
            this._check(job, signal);
            const stored = await this._store.readSlice(write.fileId, observed, chunk.targetOffset, chunk.length);
            this._check(job, signal);
            if (expected.byteLength !== chunk.length || stored.byteLength !== chunk.length ||
            stored.some((value, index) => value !== expected[index])) {
                throw new TermContentOptimizationIntegrityError('Closed repack output does not match its copy plan');
            }
        }
    }

    /**
     * @param {Job} job
     * @param {number|null} after
     * @param {number} limit
     * @returns {SourceFrame[]}
     * @throws {Error} If the page exceeds bounds or fails to advance.
     */
    _readFrames(job, after, limit) {
        const rows = this._frames(job, after, limit);
        if (rows.length > limit) { throw new TermContentOptimizationIntegrityError('Repack frame page exceeds admission'); }
        const frames = rows.map(parseOnlineContentFrameDescriptor);
        let prior = after ?? -1;
        for (const {identity} of frames) {
            if (identity.logicalOffset <= prior) { throw new TermContentOptimizationIntegrityError('Repack frame page did not advance'); }
            prior = identity.logicalOffset;
        }
        return frames;
    }

    /**
     * @param {Job} job
     * @param {string} fileId
     * @param {AbortSignal} signal
     * @returns {BatchFileObservation}
     * @throws {Error} If the job does not own the requested file.
     */
    _file(job, fileId, signal) {
        this._check(job, signal);
        const observation = this._lookup(job, fileId);
        if (observation?.ownerJobId !== job.jobId || observation.fileId !== fileId ||
        (observation.state !== 'intent' && observation.state !== 'staged') ||
        (observation.state === 'intent' && (observation.byteLength !== 0 || observation.sha256 !== null))) {
            throw new TermContentOptimizationIntegrityError('Repack file ownership or intent is missing');
        }
        return observation;
    }

    /**
     * @param {Job} job
     * @param {AbortSignal} signal
     */
    _check(job, signal) {
        signal.throwIfAborted();
        this._assertOwned(job);
    }
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isOffset(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * @param {string} id
 * @returns {string}
 */
function planId(id) { return id + '-plan'; }
/**
 * @param {string} id
 * @param {number} index
 * @returns {string}
 */
function packId(id, index) { return id + '-pack-' + index; }

/**
 * @param {Batch} batch
 * @returns {BatchToken}
 * @throws {Error} If the durable plan has an invalid cursor or file IDs.
 */
function readToken(batch) {
    const token = /** @type {BatchToken} */ (batch.token);
    if (!/^batch-[a-f0-9-]{36}$/.test(batch.id) || !token || (token.after !== null && !isOffset(token.after)) ||
    !isOffset(token.lastOffset) || token.lastOffset <= (token.after ?? -1) || token.lastOffset !== batch.nextCursor ||
    !Number.isInteger(token.count) || token.count < 1 || token.count > MAX_FRAMES ||
    !Array.isArray(token.sourceLayouts) || token.sourceLayouts.length === 0 || token.sourceLayouts.length > 2 ||
    JSON.stringify(batch.fileIds) !== JSON.stringify([planId(batch.id), ...token.sourceLayouts.map((_region, index) => packId(batch.id, index))])) {
        throw new TermContentOptimizationIntegrityError('Invalid durable repack token');
    }
    return token;
}

/**
 * @param {BatchSource} source
 * @param {SourceFrame} checkpoint
 * @returns {Promise<SourceFrame>}
 */
async function refreshSourceFrame(source, checkpoint) {
    const observed = parseOnlineContentFrameDescriptor(await source.describe(checkpoint));
    if (JSON.stringify(observed.identity) !== JSON.stringify(checkpoint.identity) || observed.codecId !== null ||
    observed.envelope !== checkpoint.envelope || observed.storedLength !== checkpoint.storedLength ||
    (observed.decodedLength !== null && observed.decodedLength !== checkpoint.decodedLength) ||
    (observed.decodedDigest !== null && observed.decodedDigest !== checkpoint.decodedDigest)) {
        throw new TermContentOptimizationIntegrityError('Repack source frame changed after discovery');
    }
    // Retained bytes may have moved in an earlier pack. The immutable logical
    // identity and canonical length remain the same.
    return {...observed, decodedLength: checkpoint.decodedLength};
}

/**
 * @param {Window} window
 * @param {number} count
 * @returns {Window}
 */
function trimWindow(window, count) {
    const manifests = window.manifests.slice(0, count);
    const externalFrames = window.externalFrames;
    const frames = [...manifests.flatMap(({blocks}) => blocks), ...externalFrames];
    const codecIds = new Set(frames.map(({codecId}) => codecId));
    const codecs = window.codecs.filter(({codecId}) => codecIds.has(codecId));
    const fileIds = new Set(manifests.flatMap(({extents}) => extents.map(({fileId}) => fileId)));
    for (const {fileId} of frames) { fileIds.add(fileId); }
    for (const {fileId} of codecs) { fileIds.add(fileId); }
    return {
        manifests,
        externalFrames,
        codecs,
        files: window.files.filter(({fileId}) => fileIds.has(fileId)),
        physicalFiles: window.physicalFiles.filter(({fileId}) => fileIds.has(fileId)),
    };
}

/**
 * @param {string} id
 * @param {number} byteLength
 * @returns {PackWrite}
 */
function metadataWrite(id, byteLength) {
    return {
        regionId: id,
        fileId: planId(id),
        byteLength,
        operations: [{sourceFileId: id, sourceOffset: 0, targetOffset: 0, length: byteLength, role: 'retained', logicalOffset: 0}],
    };
}

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<string>}
 */
async function digestBytes(bytes) {
    return await arrayBufferDigest('SHA-256', new Uint8Array(bytes).buffer);
}
