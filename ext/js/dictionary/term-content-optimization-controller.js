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
import {inspectSharedGlossaryTrainingArtifact, inspectTermContentTrainingReference} from './term-content-optimization-candidate-source.js';
import {getRawTermContentBlockCompressionDictName} from './raw-term-content.js';
import {probeLegacyTermContentFrame} from './term-content-legacy-eligibility.js';
import {completeTrainingSampleSelection, copyTrainingSampleWindow, createTrainingSampleDiscovery, observeTrainingFrame, planTrainingSampleStep, startTrainingSampleSelection, validateTrainingSampleCheckpoint} from './term-content-training-sampler.js';
import {ZstdTrainerWorkerOwner, ZstdTrainingCorpusError} from './zstd-trainer-worker-owner.js';

/** @typedef {import('./term-content-optimization-checkpoint.js').OnlineContentFrameDescriptor} FrameDescriptor */
/** @typedef {import('./term-content-optimization-candidate-source.js').CandidateFrameSource} CandidateFrameSource */
/** @typedef {import('./term-content-training-sampler.js').TrainingSampleCheckpoint} SamplerCheckpoint */
/** @typedef {import('./term-content-training-sampler.js').TrainingSampleRequest} SampleRequest */
/** @typedef {{fileId: string, byteLength: number, sha256: string}} CheckpointFile */
/** @typedef {'discover'|'sample'|'train'|'recompress'|'reclaim'|'deferred'|'completed'|'no-gain'|'failed'} OptimizationPhase */
/** @typedef {{kind: 'reference', reference: import('./term-record-opfs-store.js').ContentReference}|{kind: 'artifact', artifact: {contentOffset: number, contentLength: number, contentDictName: string, uncompressedLength: number}}} DiscoveryItem */
/** @typedef {{item: DiscoveryItem|null, cursor: unknown, done: boolean}|{items: DiscoveryItem[], cursor: unknown, done: boolean, resumeAfterBlockReference?: (recordId: number) => unknown}} DiscoveryPage */
/** @typedef {{id: string, fileIds: string[], token: unknown, nextCursor: unknown, last: boolean, stage: 'write'|'verify'|'publish', verifyCursor: unknown}} OptimizationBatch */
/**
 * @typedef {object} OptimizationCheckpoint
 * @property {1} version
 * @property {{dictionaryCapacity: number, strategy: number, level: number}} parameters
 * @property {boolean} [legacyProbe]
 * @property {unknown} discoveryCursor
 * @property {{item: DiscoveryItem, remaining?: DiscoveryItem[], nextCursor: unknown, done: boolean, inspection: import('./term-content-zstd-frame-inspector.js').ZstdFrameInspectionCursor|null}|null} pendingDiscovery
 * @property {'summary'|'select'} sampleMode
 * @property {unknown} frameCursor
 * @property {SamplerCheckpoint} sampler
 * @property {CheckpointFile[]} samples
 * @property {{fileId: string, request: SampleRequest, nextSampler: SamplerCheckpoint}|null} pendingSample
 * @property {CheckpointFile|null} dictionary
 * @property {string|null} pendingDictionary
 * @property {OptimizationBatch|null} batch
 * @property {'recompress'|'completed'|'no-gain'|'failed'} afterReclaim
 * @property {OptimizationPhase|null} resumePhase
 * @property {number} publishedBatches
 * @property {number} failures
 */
/** @typedef {{jobId: string, dictionaryTitle: string, dictionaryGeneration: string, strategyVersion: string, phase: OptimizationPhase, checkpoint: OptimizationCheckpoint, checkpointVersion: number, retryAfter: number|null}} OptimizationJob */
/** @typedef {{frames?: FrameDescriptor[], reserveFileIds?: string[], checkpointFile?: {kind: 'sample'|'dictionary', file: CheckpointFile}}} CheckpointEffects */
/** @typedef {{id: string, fileIds: string[], token: unknown, nextCursor: unknown, last: boolean}} BatchPlan */
/** @typedef {{samples: Uint8Array, lengths: Uint8Array, dictionaryCapacity: number, strategy: number, level: number}} TrainingRequest */
/** @typedef {{train: (request: TrainingRequest, options: {signal: AbortSignal}) => Promise<{dictionary: Uint8Array}>}} Trainer */
/**
 * All methods are mandatory. No optional operation may silently succeed.
 *
 * The host is the existing sole SQLite owner. getJob returns the single unfinished
 * job BEFORE searching vanilla candidates, including reclaim/deferred jobs.
 * createJob must atomically claim that singleton. findCandidate examines actual
 * successful storage generations, excluding terminal generation/strategy pairs.
 * assertOwned verifies the exact durable owner/checkpoint version synchronously;
 * isTargetCurrent additionally resolves renames by immutable storage generation.
 *
 * save is a short synchronous SQLite CAS: cursor/checkpoint and effects commit
 * together. reserveFileIds inserts intents BEFORE any corresponding file exists;
 * frame rows are deduplicated by stable logical identity. checkpointFile records
 * the already closed/readback-checked private file. Late acknowledgements must be
 * reconciled against the exact durable receipt, never guessed or rolled back.
 *
 * acquireSource uses acquireOnlineContentOptimizationSource and private resources.
 * readDiscovery yields at most 64 legacy metadata items or a verified block
 * range with an exact interior cursor. A block range never enters the durable
 * pending-item checkpoint. Single-item checkpoints from earlier jobs remain readable. Its cursor includes sharedGlossaryArtifacts as well
 * as iterateContentReferences state. A read-only page replays after preemption;
 * only an unfinished legacy frame inspection needs a pending checkpoint.
 * framePage uses getOnlineContentOptimizationFramePage(jobId,cursor,1), returning
 * the next keyset cursor even on the last row; null frame means end-of-stream.
 * Unknown decoded lengths require bounded private inspection before checkpoint.
 *
 * writeFile may replay ONLY this job's verified unpublished intent, joining any
 * previous writer first. It closes before returning. readFile returns owned
 * bytes; samples/dictionaries are <=4 MiB/112640 B. readSample returns precisely
 * the requested canonical decoded window, streaming or deferring giant frames.
 *
 * planBatch performs bounded read-only planning. It returns fresh immutable file
 * IDs AND its bounded durable plan token before stageBatch is called. stageBatch
 * replays only those intents, closes all writers and independently observes files.
 * No CPU compression belongs in the SQL owner: supplied signal must synchronously
 * terminate disposable compression/decoder workers on foreground admission.
 * Giant frames require a streaming implementation or ResourceError deferral.
 * Every replacement uses MBC2, including a finalized prefix before close/seal.
 *
 * verificationPage independently decodes original and closed staged output using
 * SEPARATE contexts and returns equally addressed canonical windows, <=1 MiB per
 * arm. It never merely compares compressor input to itself. Its durable cursor
 * denotes verified decoded windows; native stream state is replayed after restart.
 * Complete-frame digest/envelope/length checks must precede done=true.
 * measureBatch counts dictionary, layouts, registry and eventual reclaimable
 * bytes; it returns exact safe-integer byte totals, never an estimated verdict.
 * publishBatch is synchronous metadata-only CAS against source layout IDs and
 * target generation, merges the CURRENT directory, advances root+job to reclaim
 * atomically and synchronously adopts/reconciles the committed runtime root.
 *
 * reclaimStep deletes at most one precisely owned file. Under mutation admission
 * it checks active/staged/recovery/checkpoint/codec/root-lease closure, persists
 * deleting, removes, then retires metadata idempotently. A missing file is success
 * ONLY for known retired/deleting metadata. done means ALL temporary/unpublished
 * files and retired files for this batch are gone; training files are retained
 * while afterReclaim=recompress and are included in terminal cleanup otherwise.
 * Deleted targets may reclaim, but may not train or publish. Return the current
 * durable job if reclaim metadata advanced. A leased old root returns retryAt.
 * @typedef {object} OptimizationHost
 * @property {(jobId?: string) => OptimizationJob|null} getJob
 * @property {() => number|null} [nextRetryAt]
 * @property {(strategyVersion: string) => {jobId: string, dictionaryTitle: string, dictionaryGeneration: string}|null} findCandidate
 * @property {(job: OptimizationJob) => OptimizationJob} createJob
 * @property {(job: OptimizationJob) => void} assertOwned
 * @property {(job: OptimizationJob) => boolean} isTargetCurrent
 * @property {(job: OptimizationJob, phase: OptimizationPhase, checkpoint: OptimizationCheckpoint, effects?: CheckpointEffects, retryAfter?: number|null) => OptimizationJob} save
 * @property {(job: OptimizationJob, signal: AbortSignal) => {source: CandidateFrameSource, close: () => Promise<void>}} acquireSource
 * @property {() => boolean} [isLegacyRoot]
 * @property {(job: OptimizationJob, signal: AbortSignal) => {source: import('./term-content-legacy-eligibility.js').LegacyEligibilitySource, activate: () => Promise<void>}} [acquireLegacyProbe]
 * @property {(job: OptimizationJob, cursor: unknown, signal: AbortSignal, legacyProbe?: boolean) => Promise<DiscoveryPage>} readDiscovery
 * @property {(job: OptimizationJob, cursor: unknown) => {frame: FrameDescriptor|null, cursor: unknown}} framePage
 * @property {(job: OptimizationJob, request: SampleRequest, signal: AbortSignal) => Promise<Uint8Array>} readSample
 * @property {(job: OptimizationJob, fileId: string, bytes: Uint8Array, signal: AbortSignal) => Promise<void>} writeFile
 * @property {(job: OptimizationJob, file: CheckpointFile|{fileId: string}, signal: AbortSignal) => Promise<Uint8Array>} readFile
 * @property {(job: OptimizationJob, cursor: unknown, signal: AbortSignal) => Promise<BatchPlan|null>} planBatch
 * @property {(job: OptimizationJob, batch: OptimizationBatch, dictionary: Uint8Array, signal: AbortSignal) => Promise<void>} stageBatch
 * @property {(job: OptimizationJob, batch: OptimizationBatch, cursor: unknown, signal: AbortSignal) => Promise<({original: Uint8Array, replacement: Uint8Array}|{verified: true}) & {cursor: unknown, done: boolean}>} verificationPage
 * @property {(job: OptimizationJob, batch: OptimizationBatch, signal: AbortSignal) => {beforeBytes: number, afterBytes: number}|Promise<{beforeBytes: number, afterBytes: number}>} measureBatch
 * @property {(job: OptimizationJob, batch: OptimizationBatch, checkpoint: OptimizationCheckpoint, signal: AbortSignal) => OptimizationJob|null|Promise<OptimizationJob|null>} publishBatch
 * @property {(job: OptimizationJob, signal: AbortSignal) => Promise<{job: OptimizationJob, done: boolean, retryAt?: number}>} reclaimStep
 */

export const MAX_BLOCK_DISCOVERY_REFERENCES = 1024;
const MAX_DISCOVERY_FRAMES = 64;
const MAX_CHECKPOINT_BYTES = 32768;
const MAX_SAMPLE_BYTES = 4 * 1024 * 1024;
const MAX_DICTIONARY_BYTES = 112640;
const TERMINAL = new Set(['completed', 'no-gain', 'failed']);
const encoder = new TextEncoder();

/** Optional capacity/transient errors are retryable, never measured no-gain. */
export class TermContentOptimizationResourceError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        /** @type {string} */
        this.name = 'TermContentOptimizationResourceError';
    }
}

/** A fixed input exceeds this strategy's capabilities. Retrying cannot help. */
export class TermContentOptimizationUnsupportedFrameError extends TermContentOptimizationResourceError {
    /** @param {string} message */
    constructor(message) {
        super(message);
        /** @type {string} */
        this.name = 'TermContentOptimizationUnsupportedFrameError';
    }
}

/** Confirmed private canonical/checkpoint damage; source storage remains healthy. */
export class TermContentOptimizationIntegrityError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        /** @type {string} */
        this.name = 'TermContentOptimizationIntegrityError';
    }
}

/**
 *
 * @param {string} identity
 * @param {{dictionaryCapacity: number, strategy: number, level: number}} parameters
 * @returns {OptimizationCheckpoint}
 */
export function createTermContentOptimizationCheckpoint(identity, parameters) {
    return {version: 1,
        parameters: {...parameters},
        discoveryCursor: null,
        pendingDiscovery: null,
        sampleMode: 'summary',
        frameCursor: null,
        sampler: createTrainingSampleDiscovery(identity),
        samples: [],
        pendingSample: null,
        dictionary: null,
        pendingDictionary: null,
        batch: null,
        afterReclaim: 'no-gain',
        resumePhase: null,
        publishedBatches: 0,
        failures: 0};
}

/**
 *
 * @param {Uint8Array} left
 * @param {Uint8Array} right
 * @throws {Error} If canonical bytes differ.
 */
function equalBytes(left, right) {
    if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) || left.byteLength !== right.byteLength) {
        throw new TermContentOptimizationIntegrityError('Independent canonical frame verification length mismatch');
    }
    for (let index = 0; index < left.byteLength; ++index) {
        if (left[index] !== right[index]) { throw new TermContentOptimizationIntegrityError('Independent canonical frame verification mismatch'); }
    }
}

/**
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<string>}
 */
async function sha256(bytes) {
    const owned = new Uint8Array(bytes);
    return [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', owned))].map((value) => value.toString(16).padStart(2, '0')).join('');
}

/**
 *
 * @param {string} value
 * @returns {boolean}
 */
function fileId(value) { return typeof value === 'string' && /^[a-zA-Z0-9._-]{1,128}$/.test(value); }

/**
 * Owns a bounded metadata page before any optional frame I/O starts.
 * @param {DiscoveryItem[]} input
 * @param {number} [limit]
 * @returns {DiscoveryItem[]}
 * @throws {TypeError} If source metadata cannot be safely checkpointed.
 */
function discoveryItems(input, limit = MAX_DISCOVERY_FRAMES) {
    if (!Array.isArray(input) || input.length > limit) { throw new TypeError('Discovery metadata page exceeds admission'); }
    return input.map((item) => {
        if (!item || typeof item !== 'object') { throw new TypeError('Invalid discovery item'); }
        if (item.kind === 'reference') {
            const ref = item.reference;
            if (!ref || !Number.isSafeInteger(ref.recordId) || ref.recordId < 0 ||
            !Number.isSafeInteger(ref.entryContentOffset) || ref.entryContentOffset < 0 ||
            !Number.isSafeInteger(ref.entryContentLength) || ref.entryContentLength <= 0 ||
            typeof ref.entryContentDictName !== 'string' || ref.entryContentDictName.length > 512) {
                throw new TypeError('Invalid discovery reference');
            }
            return {kind: /** @type {const} */ ('reference'),
                reference: {recordId: ref.recordId,
                    entryContentOffset: ref.entryContentOffset,
                    entryContentLength: ref.entryContentLength,
                    entryContentDictName: ref.entryContentDictName}};
        }
        if (item.kind !== 'artifact') { throw new TypeError('Invalid discovery item kind'); }
        const artifact = item.artifact;
        if (!artifact || !Number.isSafeInteger(artifact.contentOffset) || artifact.contentOffset < 0 ||
        !Number.isSafeInteger(artifact.contentLength) || artifact.contentLength <= 0 ||
        !Number.isSafeInteger(artifact.uncompressedLength) || artifact.uncompressedLength < 0 ||
        typeof artifact.contentDictName !== 'string' || artifact.contentDictName.length > 512) {
            throw new TypeError('Invalid discovery artifact');
        }
        return {kind: /** @type {const} */ ('artifact'),
            artifact: {contentOffset: artifact.contentOffset,
                contentLength: artifact.contentLength,
                contentDictName: artifact.contentDictName,
                uncompressedLength: artifact.uncompressedLength}};
    });
}

/**
 * @param {Map<number, FrameDescriptor>} frames
 * @param {FrameDescriptor} frame
 * @throws {TypeError} If one immutable logical address resolves inconsistently.
 */
function rememberDiscoveredFrame(frames, frame) {
    const prior = frames.get(frame.identity.logicalOffset);
    if (prior && JSON.stringify(prior) !== JSON.stringify(frame)) {
        throw new TypeError('Discovery page contains conflicting immutable frame identities');
    }
    frames.set(frame.identity.logicalOffset, frame);
}

/**
 * Keep durable JSON small even when a host accidentally returns a whole layout.
 * Strict sampler validation owns its scalar invariants; this validation also
 * prevents malformed optional metadata from driving file creation/deletion.
 * @param {OptimizationCheckpoint} input
 * @returns {OptimizationCheckpoint}
 * @throws {TypeError|RangeError} If durable state is invalid or unbounded.
 */
function checkpoint(input) {
    const text = JSON.stringify(input);
    if (typeof text !== 'string' || encoder.encode(text).byteLength > MAX_CHECKPOINT_BYTES) { throw new RangeError('Optimization checkpoint exceeds admission'); }
    const value = /** @type {OptimizationCheckpoint} */ (parseJson(text));
    if (!value || value.version !== 1 || !value.parameters ||
    !Number.isSafeInteger(value.parameters.dictionaryCapacity) || value.parameters.dictionaryCapacity < 1024 || value.parameters.dictionaryCapacity > MAX_DICTIONARY_BYTES ||
    !Number.isSafeInteger(value.parameters.strategy) || value.parameters.strategy < 0 || value.parameters.strategy > 2 ||
    !Number.isSafeInteger(value.parameters.level) || value.parameters.level < -1 || value.parameters.level > 9 ||
    (typeof value.legacyProbe !== 'undefined' && typeof value.legacyProbe !== 'boolean') ||
    !['summary', 'select'].includes(value.sampleMode) ||
    !Array.isArray(value.samples) || value.samples.length > 64 ||
    !Number.isSafeInteger(value.publishedBatches) || value.publishedBatches < 0 ||
    !Number.isSafeInteger(value.failures) || value.failures < 0 ||
    !['recompress', 'completed', 'no-gain', 'failed'].includes(value.afterReclaim) ||
    (value.resumePhase !== null && !['discover', 'sample', 'train', 'recompress', 'reclaim'].includes(value.resumePhase))) {
        throw new TypeError('Invalid optimization checkpoint');
    }
    if (value.pendingDiscovery !== null) {
        const pending = value.pendingDiscovery;
        if (!pending || typeof pending.done !== 'boolean') { throw new TypeError('Invalid pending discovery page'); }
        discoveryItems([pending.item, ...(pending.remaining ?? [])]);
    }
    value.sampler = validateTrainingSampleCheckpoint(value.sampler);
    let total = 0;
    const ids = new Set();
    for (const file of [...value.samples, ...(value.dictionary === null ? [] : [value.dictionary])]) {
        if (!file || !fileId(file.fileId) || ids.has(file.fileId) || !Number.isSafeInteger(file.byteLength) || file.byteLength <= 0 ||
        typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) { throw new TypeError('Invalid optimization checkpoint file'); }
        ids.add(file.fileId);
    }
    for (const file of value.samples) {
        if (file.byteLength > 65536) { throw new TypeError('Invalid training window checkpoint'); }
        total += file.byteLength;
    }
    if (total > MAX_SAMPLE_BYTES || (value.dictionary !== null && value.dictionary.byteLength > MAX_DICTIONARY_BYTES) ||
    (value.pendingDictionary !== null && !fileId(value.pendingDictionary))) { throw new TypeError('Invalid optimization checkpoint byte bounds'); }
    if (value.pendingSample !== null && (!fileId(value.pendingSample.fileId) || ids.has(value.pendingSample.fileId))) {
        throw new TypeError('Invalid pending sample intent');
    }
    if (value.pendingSample !== null) {
        const pending = value.pendingSample;
        const request = pending.request;
        if (!request || !Number.isSafeInteger(request.sampleIndex) || request.sampleIndex < 0 || request.sampleIndex >= 64 ||
        typeof request.key !== 'string' || !request.key || request.key.length > 512 ||
        !Number.isSafeInteger(request.frameOffset) || request.frameOffset < 0 ||
        !Number.isSafeInteger(request.decodedLength) || request.decodedLength <= 0 ||
        !Number.isSafeInteger(request.length) || request.length <= 0 || request.length > 65536 ||
        !Number.isSafeInteger(request.windowOffset) || request.windowOffset < 0 || request.windowOffset > request.decodedLength - request.length) {
            throw new TypeError('Invalid pending training window');
        }
        const planned = planTrainingSampleStep(value.sampler, {key: request.key, offset: request.frameOffset, length: request.decodedLength});
        if (planned.kind !== 'sample' || Object.keys(planned.request).some((key) => Reflect.get(planned.request, key) !== Reflect.get(request, key)) ||
        JSON.stringify(validateTrainingSampleCheckpoint(pending.nextSampler)) !== JSON.stringify(validateTrainingSampleCheckpoint(planned.state))) {
            throw new TypeError('Pending training window disagrees with the durable sampler');
        }
    }
    if (value.batch !== null && (!fileId(value.batch.id) || !Array.isArray(value.batch.fileIds) ||
    value.batch.fileIds.length === 0 || value.batch.fileIds.length > 16 ||
    value.batch.fileIds.some((id) => !fileId(id) || ids.has(id)) ||
    new Set(value.batch.fileIds).size !== value.batch.fileIds.length ||
    !['write', 'verify', 'publish'].includes(value.batch.stage) || typeof value.batch.last !== 'boolean')) {
        throw new TypeError('Invalid optimization batch intent');
    }
    return value;
}

/**
 * Phase compatibility is separate from structural admission so reclaim can
 * dispose of a damaged or obsolete training checkpoint without training it.
 * @param {OptimizationJob} job
 * @param {OptimizationCheckpoint} state
 * @throws {TypeError} If resumed work is inconsistent with its durable sampler.
 */
function validatePhase(job, state) {
    const phase = job.phase === 'deferred' ? state.resumePhase : job.phase;
    if (phase === 'reclaim') { return; }
    const sampler = state.sampler;
    if (phase === 'discover' || (phase === 'sample' && state.sampleMode === 'summary')) {
        if (sampler.phase !== 'discover' || state.samples.length > 0 || state.pendingSample !== null) {
            throw new TypeError('Discovery phase disagrees with durable training samples');
        }
    } else if (phase === 'sample' || phase === 'train' || phase === 'recompress') {
        if (state.sampleMode !== 'select' || sampler.phase === 'discover' ||
        state.samples.length !== sampler.sampleIndex ||
        state.samples.reduce((sum, file) => sum + file.byteLength, 0) !== sampler.sampleBytes) {
            throw new TypeError('Durable samples disagree with sampler state');
        }
        if ((phase === 'sample' && sampler.phase !== 'sample') ||
        (phase !== 'sample' && (sampler.phase !== 'done' || state.pendingSample !== null || state.samples.length < 8))) {
            throw new TypeError('Optimization phase requires completed durable sampling');
        }
    }
    if ((phase === 'discover' && state.sampleMode !== 'summary') ||
    ((phase === 'discover' || phase === 'sample') && (state.dictionary !== null || state.pendingDictionary !== null)) ||
    (phase === 'train' && state.dictionary !== null) ||
    (phase === 'recompress' && (state.dictionary === null || state.pendingDictionary !== null)) ||
    (phase !== 'discover' && state.pendingDiscovery !== null) ||
    (phase !== 'recompress' && state.batch !== null)) {
        throw new TypeError('Optimization phase contains incompatible pending work');
    }
}

/**
 * Exact receipt reconciliation must never give a stale callback ownership of a
 * successor checkpoint merely because it retained the same job ID.
 * @param {OptimizationJob} actual
 * @param {OptimizationJob} expected
 * @returns {boolean}
 */
function matchesReceipt(actual, expected) {
    return actual.jobId === expected.jobId && actual.dictionaryTitle === expected.dictionaryTitle &&
    actual.dictionaryGeneration === expected.dictionaryGeneration && actual.strategyVersion === expected.strategyVersion &&
    actual.checkpointVersion === expected.checkpointVersion && actual.phase === expected.phase &&
    actual.retryAfter === expected.retryAfter && JSON.stringify(actual.checkpoint) === JSON.stringify(expected.checkpoint);
}

/**
 * One durable owner; each runStep advances at most one I/O/CPU/checkpoint unit.
 * No in-memory phase is authoritative. Restart always loads the durable CAS.
 */
export class TermContentOptimizationController {
    /**
     * @param {{host: OptimizationHost, strategyVersion: string, dictionaryCapacity: number, strategy: number, level: number, createTrainer?: () => Trainer, now?: () => number}} options
     * @throws {TypeError} If required adapters or resource bounds are missing.
     */
    constructor({host, strategyVersion, dictionaryCapacity, strategy, level, createTrainer = () => new ZstdTrainerWorkerOwner(), now = Date.now}) {
        const methods = ['getJob',
            'findCandidate',
            'createJob',
            'assertOwned',
            'isTargetCurrent',
            'save',
            'acquireSource',
            'readDiscovery',
            'framePage',
            'readSample',
            'writeFile',
            'readFile',
            'planBatch',
            'stageBatch',
            'verificationPage',
            'measureBatch',
            'publishBatch',
            'reclaimStep'];
        if (!host || methods.some((key) => typeof Reflect.get(host, key) !== 'function') ||
        typeof strategyVersion !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(strategyVersion) ||
        !Number.isSafeInteger(dictionaryCapacity) || dictionaryCapacity < 1024 || dictionaryCapacity > MAX_DICTIONARY_BYTES ||
        !Number.isSafeInteger(strategy) || strategy < 0 || strategy > 2 ||
        !Number.isSafeInteger(level) || level < -1 || level > 9 || typeof createTrainer !== 'function' || typeof now !== 'function') {
            throw new TypeError('Invalid content optimization controller options');
        }
        /** @type {OptimizationHost} */
        this._host = host;
        /** @type {string} */
        this._strategyVersion = strategyVersion;
        /** @type {number} */
        this._dictionaryCapacity = dictionaryCapacity;
        /** @type {number} */
        this._strategy = strategy;
        /** @type {number} */
        this._level = level;
        /** @type {() => Trainer} */
        this._createTrainer = createTrainer;
        /** @type {() => number} */
        this._now = now;
        /** @type {boolean} */
        this._running = false;
        /** @type {OptimizationJob|null} */
        this._expectedReceipt = null;
    }

    /**
     * Aborts synchronously through the supplied signal's disposable CPU owners.
     * The scheduler joins this promise before lifecycle teardown, never before
     * dispatching ordinary foreground reads.
     * @param {AbortSignal} signal
     * @returns {Promise<{pending: boolean, retryAt?: number}>}
     * @throws {Error} If preempted or if durable work needs diagnostic retry.
     */
    async runStep(signal) {
        if (this._running) { throw new Error('Content optimization controller already has a running step'); }
        this._running = true;
        this._expectedReceipt = null;
        /** @type {OptimizationJob|null} */
        let job = null;
        try {
            this._checkSignal(signal);
            job = this._host.getJob();
            if (job === null) {
                const candidate = this._host.findCandidate(this._strategyVersion);
                if (candidate === null) {
                    const retryAt = this._host.nextRetryAt?.() ?? null;
                    return retryAt === null ? {pending: false} : {pending: true, retryAt};
                }
                const state = createTermContentOptimizationCheckpoint(
                    candidate.dictionaryGeneration + ':' + this._strategyVersion,
                    {dictionaryCapacity: this._dictionaryCapacity, strategy: this._strategy, level: this._level},
                );
                job = {...candidate,
                    strategyVersion: this._strategyVersion,
                    phase: 'discover',
                    checkpoint: state,
                    checkpointVersion: 0,
                    retryAfter: null};
                this._expectedReceipt = structuredClone(job);
                job = this._host.createJob(job);
                this._check(job, signal, false);
                return {pending: true};
            }
            if (TERMINAL.has(job.phase)) { throw new Error('Host returned a terminal optimization job as unfinished'); }
            if (job.retryAfter !== null && job.retryAfter > this._now()) { return {pending: true, retryAt: job.retryAfter}; }
            this._check(job, signal, false);
            /** @type {OptimizationCheckpoint} */
            let state;
            try {
                state = checkpoint(job.checkpoint);
            } catch (_) {
                // Unpublished files are catalog-owned. Reclaim by durable
                // owner without trusting file IDs from a damaged checkpoint.
                const cleanup = createTermContentOptimizationCheckpoint(
                    job.dictionaryGeneration + ':' + job.strategyVersion,
                    {dictionaryCapacity: this._dictionaryCapacity, strategy: this._strategy, level: this._level},
                );
                this._save(job, 'reclaim', {...cleanup, afterReclaim: 'failed'});
                return {pending: true};
            }
            if (!this._host.isTargetCurrent(job) && (job.phase !== 'reclaim' || state.afterReclaim !== 'failed')) {
                this._save(job, 'reclaim', {...state, afterReclaim: 'failed', resumePhase: null});
                return {pending: true};
            }
            if (state.sampler.identity !== job.dictionaryGeneration + ':' + job.strategyVersion) {
                throw new TypeError('Durable training sampler belongs to a different job');
            }
            const effectivePhase = job.phase === 'deferred' ? state.resumePhase : job.phase;
            const strategyCurrent = job.strategyVersion === this._strategyVersion &&
            state.parameters.dictionaryCapacity === this._dictionaryCapacity && state.parameters.strategy === this._strategy && state.parameters.level === this._level;
            if (!strategyCurrent && (effectivePhase !== 'reclaim' || state.afterReclaim === 'recompress')) {
                // An unsupported strategy cannot become available through
                // resource backoff. Reclaim it before admitting current work.
                this._save(job, 'reclaim', {...state, afterReclaim: 'failed', resumePhase: null});
                return {pending: true};
            }
            validatePhase(job, state);
            if (job.phase === 'deferred') {
                if (state.resumePhase === null) { throw new TypeError('Deferred optimization has no resumable phase'); }
                this._save(job, state.resumePhase, {...state, resumePhase: null});
                return {pending: true};
            }
            switch (job.phase) {
                case 'discover': await this._discover(job, state, signal); break;
                case 'sample': await this._sample(job, state, signal); break;
                case 'train': await this._train(job, state, signal); break;
                case 'recompress': await this._recompress(job, state, signal); break;
                case 'reclaim': {
                    const result = await this._host.reclaimStep(job, signal);
                    if (result.job.jobId !== job.jobId || result.job.dictionaryGeneration !== job.dictionaryGeneration ||
                    result.job.strategyVersion !== job.strategyVersion || result.job.phase !== 'reclaim' ||
                    result.job.checkpointVersion < job.checkpointVersion || typeof result.done !== 'boolean' ||
                    (typeof result.retryAt !== 'undefined' && (!Number.isSafeInteger(result.retryAt) || result.retryAt < 0))) {
                        throw new Error('Reclamation returned a different durable owner');
                    }
                    job = result.job;
                    this._check(job, signal, false);
                    state = checkpoint(job.checkpoint);
                    if (!this._host.isTargetCurrent(job) && state.afterReclaim !== 'failed') {
                        this._save(job, 'reclaim', {...state, afterReclaim: 'failed'});
                        return {pending: true};
                    }
                    if (!result.done) { return {pending: true, ...(typeof result.retryAt === 'undefined' ? {} : {retryAt: result.retryAt})}; }
                    const next = state.afterReclaim;
                    // Terminal rows block retraining for this strategy. Once
                    // cleanup is done they no longer need any artifact pointers.
                    const after = next === 'recompress' ?
                        {...state, batch: null, pendingSample: null, pendingDictionary: null, resumePhase: null} :
                        {...createTermContentOptimizationCheckpoint(state.sampler.identity, state.parameters),
                            afterReclaim: next,
                            publishedBatches: state.publishedBatches};
                    this._save(job, next, after);
                    break;
                }
                default: throw new TypeError('Unsupported content optimization phase');
            }
            return {pending: true};
        } catch (error) {
            if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) { throw error; }
            const current = job === null ? null : this._host.getJob(job.jobId);
            if (job === null || current === null || current.jobId !== job.jobId ||
            current.dictionaryTitle !== job.dictionaryTitle || current.dictionaryGeneration !== job.dictionaryGeneration ||
            current.strategyVersion !== job.strategyVersion) { throw error; }
            if (this._expectedReceipt !== null && matchesReceipt(current, this._expectedReceipt)) {
                // This exact mutation committed despite a failed acknowledgement.
                // Continue from its receipt without deferring a successful phase.
                return {pending: true};
            }
            if (current.checkpointVersion !== job.checkpointVersion || current.phase !== job.phase) { throw error; }
            this._host.assertOwned(job);
            const state = checkpoint(current.checkpoint);
            if (TERMINAL.has(current.phase)) { throw error; }
            if (error instanceof TermContentOptimizationIntegrityError ||
            error instanceof TermContentOptimizationUnsupportedFrameError) {
                this._save(current, 'reclaim', {...state, afterReclaim: 'failed', resumePhase: null});
                throw error;
            }
            const resume = current.phase === 'deferred' ? state.resumePhase : current.phase;
            if (resume === null || TERMINAL.has(resume)) { throw error; }
            const failures = Math.min(state.failures + 1, 16);
            const retryAt = this._now() + Math.min(3600000, 30000 * 2 ** Math.min(failures - 1, 7));
            this._save(current, 'deferred', {...state, failures, resumePhase: resume}, {}, retryAt);
            // The exact original failure remains observable to scheduler diagnostics.
            throw error;
        } finally {
            this._expectedReceipt = null;
            this._running = false;
        }
    }

    /**
     *
     * @param {AbortSignal} signal
     * @throws {DOMException} If foreground admitted.
     */
    _checkSignal(signal) {
        if (signal.aborted) { throw new DOMException('Content optimization was preempted', 'AbortError'); }
    }

    /**
     *
     * @param {OptimizationJob} job
     * @param {AbortSignal} signal
     * @param {boolean} [target]
     * @throws {Error} If optional ownership changed.
     */
    _check(job, signal, target = true) {
        this._checkSignal(signal);
        this._host.assertOwned(job);
        if (target && !this._host.isTargetCurrent(job)) { throw new Error('Content optimization target generation changed'); }
    }

    /**
     *
     * @param {OptimizationJob} job
     * @param {OptimizationPhase} phase
     * @param {OptimizationCheckpoint} state
     * @param {CheckpointEffects} [effects]
     * @param {number|null} [retryAfter]
     * @returns {OptimizationJob}
     */
    _save(job, phase, state, effects = {}, retryAfter = null) {
        this._host.assertOwned(job);
        const next = checkpoint(state);
        this._expectedReceipt = structuredClone({...job, phase, checkpoint: next, checkpointVersion: job.checkpointVersion + 1, retryAfter});
        return this._host.save(job, phase, next, effects, retryAfter);
    }

    /**
     *
     * @param {OptimizationJob} job
     * @param {OptimizationCheckpoint} state
     * @param {AbortSignal} signal
     * @throws {Error} If the bounded phase cannot safely advance.
     */
    async _discover(job, state, signal) {
        const legacyProbe = this._host.isLegacyRoot?.() === true;
        if (legacyProbe !== (state.legacyProbe === true)) {
            // Before a cutover, no private layout key can be retained. After
            // a committed activation with a lost receipt or process exit,
            // replay root-backed discovery from its own initial cursor.
            this._save(job, 'discover', {...state, legacyProbe, discoveryCursor: null, pendingDiscovery: null});
            return;
        }
        let pending = state.pendingDiscovery;
        if (pending === null) {
            const page = await this._host.readDiscovery(job, state.discoveryCursor, signal, legacyProbe);
            this._check(job, signal);
            if (!page || typeof page.done !== 'boolean') { throw new TypeError('Invalid bounded discovery page'); }
            const resumeBlockRange = 'items' in page ? page.resumeAfterBlockReference : undefined;
            if (legacyProbe && resumeBlockRange) { throw new TypeError('Legacy discovery cannot use an immutable block range'); }
            const items = discoveryItems('items' in page ? page.items : (page.item === null ? [] : [page.item]),
                resumeBlockRange ? MAX_BLOCK_DISCOVERY_REFERENCES : MAX_DISCOVERY_FRAMES);
            if (items.length === 0) {
                if (legacyProbe && page.done) {
                    this._finishLegacyEligibilityNoOp(job, state);
                } else {
                    this._save(job, page.done ? 'sample' : 'discover', {...state, discoveryCursor: page.cursor});
                }
                return;
            }
            if (resumeBlockRange) {
                await this._discoverBlockRange(job, state, items, page, resumeBlockRange, signal);
                return;
            }
            // Observation is read-only. If interrupted, replay this bounded
            // page from the previous durable cursor instead of writing it twice.
            pending = {item: items[0],
                remaining: items.slice(1),
                nextCursor: page.cursor,
                done: page.done,
                inspection: null};
        }
        if (legacyProbe) {
            await this._probeLegacyPage(job, state, pending, signal);
            return;
        }
        const items = [pending.item, ...(pending.remaining ?? [])];
        const lease = this._host.acquireSource(job, signal);
        /** @type {Map<number, FrameDescriptor>} */
        const frames = new Map();
        /** @type {OptimizationCheckpoint['pendingDiscovery']} */
        let nextPending = null;
        try {
            for (let index = 0; index < items.length; ++index) {
                const item = items[index];
                const result = item.kind === 'reference' ?
                    await inspectTermContentTrainingReference(lease.source, item.reference, signal, index === 0 ? pending.inspection : null) :
                    await inspectSharedGlossaryTrainingArtifact(lease.source, item.artifact, signal);
                this._check(job, signal);
                if (result.kind === 'pending') {
                    nextPending = {...pending, item, remaining: items.slice(index + 1), inspection: result.cursor};
                    break;
                }
                if (result.kind === 'frame') { rememberDiscoveredFrame(frames, result.frame); }
            }
        } finally {
            await lease.close();
        }
        this._check(job, signal);
        this._save(
            job,
nextPending === null && pending.done ? 'sample' : 'discover',
{...state, discoveryCursor: nextPending === null ? pending.nextCursor : state.discoveryCursor, pendingDiscovery: nextPending},
{frames: [...frames.values()]},
        );
    }

    /**
     * Direct block references can be inspected without a resumable frame
     * parser. Stop at the frame budget and checkpoint only the consumed prefix.
     * @param {OptimizationJob} job
     * @param {OptimizationCheckpoint} state
     * @param {DiscoveryItem[]} items
     * @param {{cursor: unknown, done: boolean}} page
     * @param {(recordId: number) => unknown} resumeAfter
     * @param {AbortSignal} signal
     * @throws {Error} If immutable observation or cursor ownership fails.
     */
    async _discoverBlockRange(job, state, items, page, resumeAfter, signal) {
        const lease = this._host.acquireSource(job, signal);
        /** @type {Map<number, FrameDescriptor>} */
        const frames = new Map();
        /** @type {Map<string, FrameDescriptor>} */
        const descriptions = new Map();
        const observedReferences = new Set();
        let cursor = page.cursor;
        let done = page.done;
        /** @type {CandidateFrameSource} */
        const source = {...lease.source,
            describe: async (identity) => {
                lease.source.assertCurrent();
                const key = JSON.stringify(identity);
                const cached = descriptions.get(key);
                if (cached) { return cached; }
                const frame = await lease.source.describe(identity);
                descriptions.set(key, frame);
                return frame;
            }};
        try {
            for (let index = 0; index < items.length; ++index) {
                const item = items[index];
                if (item.kind !== 'reference' ||
                typeof getRawTermContentBlockCompressionDictName(item.reference.entryContentDictName) === 'undefined') {
                    throw new TypeError('Immutable block range contains a non-block reference');
                }
                const reference = item.reference;
                const key = reference.entryContentOffset + ':' + reference.entryContentLength + ':' + reference.entryContentDictName;
                if (observedReferences.has(key)) { continue; }
                const result = await inspectTermContentTrainingReference(source, reference, signal);
                this._check(job, signal);
                if (result.kind === 'pending') { throw new TypeError('Immutable block reference cannot require a legacy cursor'); }
                observedReferences.add(key);
                if (result.kind !== 'frame') { continue; }
                rememberDiscoveredFrame(frames, result.frame);
                if (frames.size === MAX_DISCOVERY_FRAMES && index < items.length - 1) {
                    cursor = resumeAfter(reference.recordId);
                    done = false;
                    break;
                }
            }
        } finally {
            await lease.close();
        }
        this._check(job, signal);
        this._save(job, done ? 'sample' : 'discover', {...state, discoveryCursor: cursor}, {frames: [...frames.values()]});
    }

    /**
     * @param {OptimizationJob} job
     * @param {OptimizationCheckpoint} state
     * @param {NonNullable<OptimizationCheckpoint['pendingDiscovery']>} pending
     * @param {AbortSignal} signal
     * @throws {Error} If legacy ownership, admission or frame metadata changes.
     */
    async _probeLegacyPage(job, state, pending, signal) {
        const probe = this._host.acquireLegacyProbe?.(job, signal);
        if (!probe) { throw new Error('Legacy content eligibility source is unavailable'); }
        const items = [pending.item, ...(pending.remaining ?? [])];
        for (let index = 0; index < items.length; ++index) {
            const item = items[index];
            const result = await probeLegacyTermContentFrame(probe.source, item, signal, index === 0 ? pending.inspection : null);
            this._check(job, signal);
            if (result.kind === 'eligible') {
                await probe.activate();
                this._check(job, signal);
                this._save(job, 'discover', {...state, legacyProbe: false, discoveryCursor: null, pendingDiscovery: null});
                return;
            }
            if (result.kind === 'pending') {
                this._save(job, 'discover', {...state, pendingDiscovery: {
                    ...pending, item, remaining: items.slice(index + 1), inspection: result.cursor,
                }});
                return;
            }
        }
        if (pending.done) {
            this._finishLegacyEligibilityNoOp(job, state);
        } else {
            this._save(job, 'discover', {...state, discoveryCursor: pending.nextCursor, pendingDiscovery: null});
        }
    }

    /**
     * The completed generation remains an inexpensive durable no-op verdict.
     * @param {OptimizationJob} job
     * @param {OptimizationCheckpoint} state
     */
    _finishLegacyEligibilityNoOp(job, state) {
        this._save(job, 'no-gain', {...state, legacyProbe: false, discoveryCursor: null, pendingDiscovery: null});
    }

    /**
     *
     * @param {OptimizationJob} job
     * @param {OptimizationCheckpoint} state
     * @param {AbortSignal} signal
     */
    async _sample(job, state, signal) {
        if (state.pendingSample !== null) {
            const pending = state.pendingSample;
            const bytes = copyTrainingSampleWindow(await this._host.readSample(job, pending.request, signal), pending.request);
            this._check(job, signal);
            const file = await this._writeCheckedFile(job, pending.fileId, bytes, signal);
            this._check(job, signal);
            this._save(
                job,
                'sample',
                {...state, sampler: pending.nextSampler, samples: [...state.samples, file], pendingSample: null},
                {checkpointFile: {kind: 'sample', file}},
            );
            return;
        }
        const page = this._host.framePage(job, state.frameCursor);
        this._check(job, signal);
        if (state.sampleMode === 'summary') {
            if (page.frame === null) {
                if (state.sampler.summary.entries === 0) {
                    this._save(job, 'reclaim', {...state, afterReclaim: 'no-gain'});
                } else {
                    this._save(job, 'sample', {...state, sampleMode: 'select', frameCursor: null, sampler: startTrainingSampleSelection(state.sampler)});
                }
            } else {
                const frame = this._trainingDescriptor(page.frame);
                this._save(job, 'sample', {...state, frameCursor: page.cursor, sampler: observeTrainingFrame(state.sampler, frame)});
            }
            return;
        }
        if (page.frame === null) {
            const sampler = completeTrainingSampleSelection(state.sampler);
            if (state.samples.length !== sampler.sampleIndex || state.samples.reduce((sum, file) => sum + file.byteLength, 0) !== sampler.sampleBytes) {
                throw new Error('Durable samples disagree with sampler state');
            }
            // Too few windows cannot improve on retry for this fixed generation.
            // Clean up and record ineligibility without claiming measured no-gain.
            if (state.samples.length < 8) {
                this._save(job, 'reclaim', {...state, sampler, afterReclaim: 'failed'});
                return;
            }
            this._save(job, 'train', {...state, sampler, frameCursor: null});
            return;
        }
        const step = planTrainingSampleStep(state.sampler, this._trainingDescriptor(page.frame));
        if (step.kind === 'frame-complete') {
            this._save(job, 'sample', {...state, sampler: step.state, frameCursor: page.cursor});
        } else {
            const id = this._fileId(job, 'sample-' + step.request.sampleIndex);
            this._save(job, 'sample', {...state, pendingSample: {fileId: id, request: step.request, nextSampler: step.state}}, {reserveFileIds: [id]});
        }
    }

    /**
     *
     * @param {FrameDescriptor} frame
     * @returns {{key: string, offset: number, length: number}}
     * @throws {TermContentOptimizationResourceError} If private canonical inspection is required.
     */
    _trainingDescriptor(frame) {
        if (frame.codecId !== null || frame.decodedLength === null || frame.decodedLength <= 0) {
            throw new TermContentOptimizationUnsupportedFrameError('Training frame lacks a supported canonical length');
        }
        return {key: frame.physicalKey, offset: frame.identity.logicalOffset, length: frame.decodedLength};
    }

    /**
     *
     * @param {OptimizationJob} job
     * @param {OptimizationCheckpoint} state
     * @param {AbortSignal} signal
     */
    async _train(job, state, signal) {
        if (state.pendingDictionary === null) {
            const id = this._fileId(job, 'dictionary');
            this._save(job, 'train', {...state, pendingDictionary: id}, {reserveFileIds: [id]});
            return;
        }
        const bytes = state.samples.reduce((sum, file) => sum + file.byteLength, 0);
        if (bytes > MAX_SAMPLE_BYTES || state.samples.length < 8) { throw new TermContentOptimizationResourceError('Training sample admission failed'); }
        const samples = new Uint8Array(bytes);
        const lengths = new Uint8Array(state.samples.length * 4);
        const sizes = new DataView(lengths.buffer);
        let offset = 0;
        for (let index = 0; index < state.samples.length; ++index) {
            const file = state.samples[index];
            const input = await this._readCheckedFile(job, file, signal);
            this._check(job, signal);
            samples.set(input, offset);
            sizes.setUint32(index * 4, input.byteLength, true);
            offset += input.byteLength;
        }
        /** @type {{dictionary: Uint8Array}} */
        let result;
        try {
            result = await this._createTrainer().train({samples,
                lengths,
                dictionaryCapacity: this._dictionaryCapacity,
                strategy: this._strategy,
                level: this._level}, {signal});
        } catch (error) {
            this._check(job, signal);
            if (error instanceof ZstdTrainingCorpusError) {
                // This fixed corpus cannot improve on retry. Preserve every
                // intent until resumable cleanup has finished, then try others.
                this._save(job, 'reclaim', {...state, afterReclaim: 'failed'});
                return;
            }
            throw error;
        }
        this._check(job, signal);
        if (!(result.dictionary instanceof Uint8Array) || result.dictionary.byteLength < 8 || result.dictionary.byteLength > this._dictionaryCapacity) {
            throw new Error('Invalid trained dictionary output');
        }
        const file = await this._writeCheckedFile(job, state.pendingDictionary, new Uint8Array(result.dictionary), signal);
        this._check(job, signal);
        this._save(
            job,
            'recompress',
            {...state, dictionary: file, pendingDictionary: null, frameCursor: null},
            {checkpointFile: {kind: 'dictionary', file}},
        );
    }

    /**
     *
     * @param {OptimizationJob} job
     * @param {OptimizationCheckpoint} state
     * @param {AbortSignal} signal
     */
    async _recompress(job, state, signal) {
        if (state.dictionary === null) { throw new TypeError('Recompression has no durable dictionary'); }
        if (state.batch === null) {
            const plan = await this._host.planBatch(job, state.frameCursor, signal);
            this._check(job, signal);
            if (plan === null) {
                this._save(job, 'reclaim', {...state, afterReclaim: state.publishedBatches > 0 ? 'completed' : 'no-gain'});
                return;
            }
            const batch = {...plan, stage: /** @type {const} */ ('write'), verifyCursor: null};
            // This save and its intents precede EVERY byte of the batch output.
            this._save(job, 'recompress', {...state, batch}, {reserveFileIds: batch.fileIds});
            return;
        }
        const batch = state.batch;
        if (batch.stage === 'write') {
            const dictionary = await this._readCheckedFile(job, state.dictionary, signal);
            this._check(job, signal);
            await this._host.stageBatch(job, batch, dictionary, signal);
            this._check(job, signal);
            this._save(job, 'recompress', {...state, batch: {...batch, stage: 'verify'}});
            return;
        }
        if (batch.stage === 'verify') {
            const page = await this._host.verificationPage(job, batch, batch.verifyCursor, signal);
            this._check(job, signal);
            if (typeof page.done !== 'boolean') { throw new RangeError('Invalid independent verification page'); }
            if ('verified' in page) {
                if (page.verified !== true) { throw new TypeError('Invalid independent verification receipt'); }
            } else {
                if (!(page.original instanceof Uint8Array) || !(page.replacement instanceof Uint8Array) ||
                page.original.byteLength > 1024 * 1024 || page.replacement.byteLength > 1024 * 1024 ||
                (!page.done && page.original.byteLength === 0)) { throw new RangeError('Independent verification page exceeds admission'); }
                equalBytes(page.original, page.replacement);
            }
            if (!page.done && JSON.stringify(page.cursor) === JSON.stringify(batch.verifyCursor)) {
                throw new Error('Independent verification cursor made no forward progress');
            }
            this._save(job, 'recompress', {...state, batch: {...batch, stage: page.done ? 'publish' : 'verify', verifyCursor: page.cursor}});
            return;
        }
        const sizes = await this._host.measureBatch(job, batch, signal);
        this._check(job, signal);
        if (![sizes.beforeBytes, sizes.afterBytes].every((size) => Number.isSafeInteger(size) && size >= 0)) { throw new TypeError('Invalid exact batch storage accounting'); }
        const afterReclaim = batch.last ? (state.publishedBatches > 0 ? 'completed' : 'no-gain') : 'recompress';
        const next = checkpoint({...state, frameCursor: batch.nextCursor, afterReclaim});
        if (sizes.afterBytes >= sizes.beforeBytes) {
            this._save(job, 'reclaim', next);
        } else {
            // A thrown/aborted late acknowledgement cannot turn a committed
            // root into unpublished cleanup; runStep reloads its durable receipt.
            const published = checkpoint({...next,
                publishedBatches: state.publishedBatches + 1,
                afterReclaim: batch.last ? 'completed' : 'recompress'});
            this._expectedReceipt = structuredClone({...job,
                phase: 'reclaim',
                checkpoint: published,
                checkpointVersion: job.checkpointVersion + 1,
                retryAfter: null});
            const receipt = await this._host.publishBatch(job, batch, published, signal);
            if (receipt === null) {
                // The publication transaction measured physical catalog growth
                // and rolled back when that growth consumed the savings.
                this._check(job, signal);
                this._save(job, 'reclaim', next);
            }
        }
    }

    /**
     *
     * @param {OptimizationJob} job
     * @param {string} suffix
     * @returns {string}
     * @throws {RangeError} If the file ID exceeds admission.
     */
    _fileId(job, suffix) {
        const id = job.jobId + '-' + suffix;
        if (!fileId(id)) { throw new RangeError('Optimization file identity exceeds admission'); }
        return id;
    }

    /**
     *
     * @param {OptimizationJob} job
     * @param {CheckpointFile} file
     * @param {AbortSignal} signal
     * @returns {Promise<Uint8Array>}
     * @throws {Error} If the immutable checkpoint is damaged.
     */
    async _readCheckedFile(job, file, signal) {
        const bytes = await this._host.readFile(job, file, signal);
        this._check(job, signal);
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== file.byteLength || await sha256(bytes) !== file.sha256) {
            throw new TermContentOptimizationIntegrityError('Optimization checkpoint file checksum mismatch');
        }
        this._check(job, signal);
        return new Uint8Array(bytes);
    }

    /**
     *
     * @param {OptimizationJob} job
     * @param {string} id
     * @param {Uint8Array} bytes
     * @param {AbortSignal} signal
     * @returns {Promise<CheckpointFile>}
     * @throws {Error} If closed readback does not match its input.
     */
    async _writeCheckedFile(job, id, bytes, signal) {
        const digest = await sha256(bytes);
        this._check(job, signal);
        await this._host.writeFile(job, id, bytes, signal);
        this._check(job, signal);
        const readback = await this._host.readFile(job, {fileId: id}, signal);
        this._check(job, signal);
        equalBytes(bytes, readback);
        const observedDigest = await sha256(readback);
        this._check(job, signal);
        if (observedDigest !== digest) { throw new TermContentOptimizationIntegrityError('Optimization checkpoint write checksum mismatch'); }
        return {fileId: id, byteLength: bytes.byteLength, sha256: digest};
    }
}
