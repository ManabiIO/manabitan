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

// Matches the native window64k arm: consecutive 64 KiB windows, selected at
// exact global candidate-count midpoints, with at most 4 MiB selected bytes.
// Partition/uniqueness, canonical decoding and durable sample files belong to
// the job owner. This module never reads content or materializes candidates.
const WINDOW_BYTES = 65536;
const SAMPLE_COUNT = 64;
const FINGERPRINT_SEED = 2166136261;
const KIND = 'zstd-frame-windows-64k';

/**
 * @typedef {{entries: number, candidates: number, canonicalBytes: number, fingerprint: number}} TrainingSampleSummary
 */
/**
 * @typedef {{version: 1, kind: 'zstd-frame-windows-64k', identity: string, phase: 'discover', summary: TrainingSampleSummary}} TrainingSampleDiscovery
 */
/**
 * @typedef {{version: 1, kind: 'zstd-frame-windows-64k', identity: string, phase: 'sample'|'done', summary: TrainingSampleSummary, entryIndex: number, candidatesSeen: number, canonicalBytesSeen: number, fingerprint: number, sampleIndex: number, sampleBytes: number}} TrainingSampleSelection
 */
/**
 * @typedef {TrainingSampleDiscovery|TrainingSampleSelection} TrainingSampleCheckpoint
 */
/**
 * @typedef {{key: string, offset: number, length: number}} TrainingFrameDescriptor
 */
/**
 * @typedef {{sampleIndex: number, key: string, frameOffset: number, decodedLength: number, windowOffset: number, length: number}} TrainingSampleRequest
 */
/**
 * @typedef {{kind: 'sample', request: TrainingSampleRequest, state: TrainingSampleSelection}|{kind: 'frame-complete', state: TrainingSampleSelection}} TrainingSampleStep
 */

/**
 * @param {unknown} value
 * @param {string[]} keys
 * @returns {Record<string, unknown>}
 * @throws {TypeError|RangeError} If input metadata is invalid or inconsistent.
 */
function record(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
        throw new TypeError('Invalid training sampler object');
    }
    const properties = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(properties).length !== keys.length || keys.some((key) => !Object.hasOwn(properties, key) || !Object.hasOwn(properties[key], 'value'))) {
        throw new TypeError('Invalid training sampler object fields');
    }
    return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {unknown} value
 * @param {number} [minimum]
 * @param {number} [maximum]
 * @returns {number}
 * @throws {TypeError|RangeError} If input metadata is invalid or inconsistent.
 */
function integer(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new TypeError('Invalid training sampler integer');
    }
    return value;
}

/**
 * @param {unknown} value
 * @returns {string}
 * @throws {TypeError|RangeError} If input metadata is invalid or inconsistent.
 */
function identifier(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 512) { throw new TypeError('Invalid training sampler identity'); }
    return value;
}

/**
 * @param {number} a
 * @param {number} b
 * @returns {number}
 * @throws {TypeError|RangeError} If input metadata is invalid or inconsistent.
 */
function add(a, b) {
    if (a > Number.MAX_SAFE_INTEGER - b) { throw new RangeError('Training sampler counter overflow'); }
    return a + b;
}

/**
 * A consistency fingerprint only; generation and physical integrity are owned above.
 */
/**
 * @param {number} previous
 * @param {TrainingFrameDescriptor} frame
 * @returns {number}
 */
function fingerprint(previous, frame) {
    const text = JSON.stringify([frame.key, frame.offset, frame.length]);
    let result = previous;
    for (let index = 0; index < text.length; ++index) { result = Math.imul(result ^ text.charCodeAt(index), 16777619) >>> 0; }
    return result;
}

/**
 * @param {unknown} value
 * @returns {TrainingFrameDescriptor}
 */
function descriptor(value) {
    const data = record(value, ['key', 'offset', 'length']);
    return {key: identifier(data.key), offset: integer(data.offset), length: integer(data.length, 1)};
}

/**
 * @param {unknown} value
 * @returns {TrainingSampleSummary}
 * @throws {TypeError|RangeError} If input metadata is invalid or inconsistent.
 */
function summary(value) {
    const data = record(value, ['entries', 'candidates', 'canonicalBytes', 'fingerprint']);
    const result = {entries: integer(data.entries),
        candidates: integer(data.candidates),
        canonicalBytes: integer(data.canonicalBytes),
        fingerprint: integer(data.fingerprint, 0, 0xffffffff)};
    if (result.entries > result.candidates || result.candidates > result.canonicalBytes ||
    (result.entries === 0 && (result.candidates !== 0 || result.canonicalBytes !== 0 || result.fingerprint !== FINGERPRINT_SEED)) ||
    BigInt(result.canonicalBytes) > BigInt(result.candidates) * BigInt(WINDOW_BYTES) ||
    BigInt(result.candidates) > BigInt(result.entries) + BigInt(result.canonicalBytes - result.entries) / BigInt(WINDOW_BYTES)) {
        throw new TypeError('Inconsistent training sampler summary');
    }
    return result;
}

/**
 * @param {number} index
 * @param {number} total
 * @param {number} count
 * @returns {number}
 */
function selectedOrdinal(index, total, count) {
    return Number((BigInt(index) * 2n + 1n) * BigInt(total) / (2n * BigInt(count)));
}

/**
 * Copies a strict JSON checkpoint; input objects and nested summaries never escape.
 */
/**
 * @param {unknown} value
 * @returns {TrainingSampleCheckpoint}
 * @throws {TypeError|RangeError} If input metadata is invalid or inconsistent.
 */
export function validateTrainingSampleCheckpoint(value) {
    if (!value || typeof value !== 'object') { throw new TypeError('Invalid training sampler checkpoint'); }
    const phase = /** @type {unknown} */ (Object.getOwnPropertyDescriptor(value, 'phase')?.value);
    const baseKeys = ['version', 'kind', 'identity', 'phase', 'summary'];
    const data = record(value, phase === 'discover' ?
baseKeys :
[...baseKeys,
    'entryIndex',
    'candidatesSeen',
    'canonicalBytesSeen',
    'fingerprint',
    'sampleIndex',
    'sampleBytes']);
    if (data.version !== 1 || data.kind !== KIND || (phase !== 'discover' && phase !== 'sample' && phase !== 'done')) {
        throw new TypeError('Unsupported training sampler checkpoint');
    }
    const identity = identifier(data.identity);
    const totals = summary(data.summary);
    if (phase === 'discover') { return {version: 1, kind: KIND, identity, phase, summary: totals}; }
    const count = Math.min(SAMPLE_COUNT, totals.candidates);
    const entryIndex = integer(data.entryIndex, 0, totals.entries);
    const candidatesSeen = integer(data.candidatesSeen, 0, totals.candidates);
    const canonicalBytesSeen = integer(data.canonicalBytesSeen, 0, totals.canonicalBytes);
    const seenFingerprint = integer(data.fingerprint, 0, 0xffffffff);
    const sampleIndex = integer(data.sampleIndex, 0, count);
    const sampleBytes = integer(data.sampleBytes, sampleIndex, sampleIndex * WINDOW_BYTES);
    summary({entries: entryIndex, candidates: candidatesSeen, canonicalBytes: canonicalBytesSeen, fingerprint: seenFingerprint});
    if ((sampleIndex < count && selectedOrdinal(sampleIndex, totals.candidates, count) < candidatesSeen) ||
    (entryIndex === totals.entries && (candidatesSeen !== totals.candidates || canonicalBytesSeen !== totals.canonicalBytes ||
    seenFingerprint !== totals.fingerprint || sampleIndex !== count)) ||
    (phase === 'done' && entryIndex !== totals.entries)) {
        throw new TypeError('Training sampler checkpoint disagrees with discovery');
    }
    return {version: 1,
        kind: KIND,
        identity,
        phase,
        summary: totals,
        entryIndex,
        candidatesSeen,
        canonicalBytesSeen,
        fingerprint: seenFingerprint,
        sampleIndex,
        sampleBytes};
}

/**
 * @param {string} identity
 * @returns {TrainingSampleDiscovery}
 */
export function createTrainingSampleDiscovery(identity) {
    return {version: 1,
        kind: KIND,
        identity: identifier(identity),
        phase: 'discover',
        summary: {entries: 0, candidates: 0, canonicalBytes: 0, fingerprint: FINGERPRINT_SEED}};
}

/**
 * One unique original frame, in stable order; no data reads or candidate arrays.
 */
/**
 * @param {unknown} checkpoint
 * @param {TrainingFrameDescriptor} input
 * @returns {TrainingSampleDiscovery}
 * @throws {TypeError|RangeError} If input metadata is invalid or inconsistent.
 */
export function observeTrainingFrame(checkpoint, input) {
    const state = validateTrainingSampleCheckpoint(checkpoint);
    if (state.phase !== 'discover') { throw new TypeError('Training sample discovery is closed'); }
    const frame = descriptor(input);
    return {...state,
        summary: {entries: add(state.summary.entries, 1),
            candidates: add(state.summary.candidates, Math.ceil(frame.length / WINDOW_BYTES)),
            canonicalBytes: add(state.summary.canonicalBytes, frame.length),
            fingerprint: fingerprint(state.summary.fingerprint, frame)}};
}

/**
 * Reopen the same generation-pinned unique-frame iterator at its beginning.
 */
/**
 * @param {unknown} checkpoint
 * @returns {TrainingSampleSelection}
 * @throws {TypeError|RangeError} If input metadata is invalid or inconsistent.
 */
export function startTrainingSampleSelection(checkpoint) {
    const state = validateTrainingSampleCheckpoint(checkpoint);
    if (state.phase !== 'discover') { throw new TypeError('Training sample discovery is closed'); }
    return {...state,
        phase: 'sample',
        entryIndex: 0,
        candidatesSeen: 0,
        canonicalBytesSeen: 0,
        fingerprint: FINGERPRINT_SEED,
        sampleIndex: 0,
        sampleBytes: 0};
}

/**
 * At most one window per call, even for giant frames. A sample keeps entryIndex
 * unchanged; commit its private bytes and next state together, or replay OLD state.
 * @param {unknown} checkpoint
 * @param {TrainingFrameDescriptor} input
 * @returns {TrainingSampleStep}
 * @throws {TypeError|RangeError} If input metadata is invalid or inconsistent.
 */
export function planTrainingSampleStep(checkpoint, input) {
    const state = validateTrainingSampleCheckpoint(checkpoint);
    if (state.phase !== 'sample' || state.entryIndex >= state.summary.entries) { throw new TypeError('No training frame remains'); }
    const frame = descriptor(input);
    const endCandidate = add(state.candidatesSeen, Math.ceil(frame.length / WINDOW_BYTES));
    const endBytes = add(state.canonicalBytesSeen, frame.length);
    if (endCandidate > state.summary.candidates || endBytes > state.summary.canonicalBytes) { throw new TypeError('Training metadata differs from discovery'); }
    const count = Math.min(SAMPLE_COUNT, state.summary.candidates);
    if (state.sampleIndex > 0 && selectedOrdinal(state.sampleIndex - 1, state.summary.candidates, count) >= endCandidate) {
        throw new TypeError('Training sample cursor passed the current frame');
    }
    const selected = state.sampleIndex < count ? selectedOrdinal(state.sampleIndex, state.summary.candidates, count) : null;
    if (selected !== null && selected < endCandidate) {
        const windowOffset = (selected - state.candidatesSeen) * WINDOW_BYTES;
        const length = Math.min(WINDOW_BYTES, frame.length - windowOffset);
        return {kind: 'sample',
            request: {sampleIndex: state.sampleIndex,
                key: frame.key,
                frameOffset: frame.offset,
                decodedLength: frame.length,
                windowOffset,
                length},
            state: {...state,
                sampleIndex: state.sampleIndex + 1,
                sampleBytes: add(state.sampleBytes, length)}};
    }
    const next = {...state,
        entryIndex: state.entryIndex + 1,
        candidatesSeen: endCandidate,
        canonicalBytesSeen: endBytes,
        fingerprint: fingerprint(state.fingerprint, frame)};
    validateTrainingSampleCheckpoint(next);
    return {kind: 'frame-complete', state: next};
}

/**
 * @param {unknown} checkpoint
 * @returns {TrainingSampleSelection}
 * @throws {TypeError|RangeError} If input metadata is invalid or inconsistent.
 */
export function completeTrainingSampleSelection(checkpoint) {
    const state = validateTrainingSampleCheckpoint(checkpoint);
    if (state.phase !== 'sample' || state.entryIndex !== state.summary.entries) { throw new TypeError('Training sample selection is incomplete'); }
    return {...state, phase: 'done'};
}

/**
 * Own exact canonical window bytes before storing or transferring them. A window
 * offset is DECODED-relative; never add it to a compressed physical file address.
 * @param {Uint8Array} source
 * @param {TrainingSampleRequest} request
 * @returns {Uint8Array<ArrayBuffer>}
 * @throws {TypeError|RangeError} If input metadata is invalid or inconsistent.
 */
export function copyTrainingSampleWindow(source, request) {
    const data = record(request, ['sampleIndex', 'key', 'frameOffset', 'decodedLength', 'windowOffset', 'length']);
    integer(data.sampleIndex, 0, SAMPLE_COUNT - 1);
    identifier(data.key);
    integer(data.frameOffset);
    const decodedLength = integer(data.decodedLength, 1);
    const length = integer(data.length, 1, WINDOW_BYTES);
    integer(data.windowOffset, 0, decodedLength - length);
    if (!(source instanceof Uint8Array) || source.byteLength !== length) { throw new TypeError('Training sample window length mismatch'); }
    const owned = new Uint8Array(length);
    owned.set(source);
    return owned;
}
