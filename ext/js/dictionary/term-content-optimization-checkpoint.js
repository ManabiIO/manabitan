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

/** @typedef {import('./term-content-layout.js').FrameIdentity} FrameIdentity */
/** @typedef {{identity: FrameIdentity, physicalKey: string, storedLength: number, codecId: string|null, envelope: 'mbc2'|'none', decodedLength: number|null, decodedDigest: string|null}} OnlineContentFrameDescriptor */
/** @typedef {{sequence: number, byteOffset: number, byteLength: number, sha256: string|null, metadataJson: string}} OnlineContentFrameCheckpoint */

export const ONLINE_CONTENT_FRAME_PAGE_ROWS = 256;

export const ONLINE_CONTENT_FRAME_ROW_BYTES = 16384;

export const ONLINE_CONTENT_FRAME_PAGE_BYTES = 1024 * 1024;

const encoder = new TextEncoder();
const COMPACT_FRAME_FIELDS = new Set([
    'version',
    'kind',
    'logicalOffset',
    'recordLength',
    'sourceStoredLength',
    'originalCodecId',
    'expectedDecodedLength',
    'originalEnvelope',
    'physicalKey',
    'storedLength',
    'codecId',
    'envelope',
    'decodedLength',
    'decodedDigest',
]);

/**
 * @param {unknown} value
 * @param {string[]} fields
 * @returns {Record<string, unknown>}
 * @throws {TypeError} If a record contains missing, extra or accessor fields.
 */
function record(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new TypeError('Invalid optimization checkpoint object'); }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== fields.length || fields.some((key) => !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value'))) {
        throw new TypeError('Invalid optimization checkpoint fields');
    }
    return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {unknown} value
 * @param {number} [minimum]
 * @returns {number}
 * @throws {TypeError} If the value is not a safe bounded integer.
 */
function integer(value, minimum = 0) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) { throw new TypeError('Invalid optimization checkpoint dimension'); }
    return value;
}

/**
 * @param {unknown} value
 * @returns {string|null}
 * @throws {TypeError} If a codec selector is invalid.
 */
function codec(value) {
    if (value === null) { return null; }
    if (typeof value !== 'string' || value.length === 0 || value.length > 128) { throw new TypeError('Invalid optimization checkpoint codec'); }
    return value;
}

/**
 * @param {unknown} value
 * @returns {'mbc2'|'none'}
 * @throws {TypeError} If an envelope is unsupported.
 */
function envelope(value) {
    if (value !== 'mbc2' && value !== 'none') { throw new TypeError('Invalid optimization checkpoint envelope'); }
    return value;
}

/**
 * Owns a generalized frame descriptor. Physical identity may span several
 * files; a single fabricated fileId/offset must never stand in for that span.
 * These optional job bytes are never authoritative dictionary health data.
 * @param {unknown} value
 * @returns {OnlineContentFrameDescriptor}
 * @throws {TypeError} If descriptor metadata is inconsistent.
 */
export function parseOnlineContentFrameDescriptor(value) {
    const frame = record(value, ['identity', 'physicalKey', 'storedLength', 'codecId', 'envelope', 'decodedLength', 'decodedDigest']);
    const source = record(frame.identity, ['kind', 'logicalOffset', 'recordLength', 'sourceStoredLength', 'originalCodecId', 'expectedDecodedLength', 'originalEnvelope']);
    const kind = source.kind;
    if (kind !== 'block' && kind !== 'legacy-entry' && kind !== 'shared-glossary') { throw new TypeError('Invalid optimization frame kind'); }
    const logicalOffset = integer(source.logicalOffset);
    const recordLength = integer(source.recordLength, 1);
    const sourceStoredLength = integer(source.sourceStoredLength, 1);
    if (logicalOffset > Number.MAX_SAFE_INTEGER - sourceStoredLength) { throw new TypeError('Optimization source span overflows'); }
    const originalCodecId = codec(source.originalCodecId);
    const expectedDecodedLength = source.expectedDecodedLength === null ? null : integer(source.expectedDecodedLength, 1);
    const originalEnvelope = envelope(source.originalEnvelope);
    const storedLength = integer(frame.storedLength, 1);
    const decodedLength = frame.decodedLength === null ? null : integer(frame.decodedLength, 1);
    if ((kind !== 'legacy-entry' && recordLength !== sourceStoredLength) ||
    (expectedDecodedLength !== null && expectedDecodedLength !== decodedLength) ||
    typeof frame.physicalKey !== 'string' || frame.physicalKey.length === 0 || frame.physicalKey.length > ONLINE_CONTENT_FRAME_ROW_BYTES ||
    (frame.decodedDigest !== null && (typeof frame.decodedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(frame.decodedDigest))) ||
    (decodedLength === null && frame.decodedDigest !== null)) {
        throw new TypeError('Optimization frame identity is inconsistent');
    }
    return {identity: {kind, logicalOffset, recordLength, sourceStoredLength, originalCodecId, expectedDecodedLength, originalEnvelope},
        physicalKey: frame.physicalKey,
        storedLength,
        codecId: codec(frame.codecId),
        envelope: envelope(frame.envelope),
        decodedLength,
        decodedDigest: frame.decodedDigest};
}

/**
 * Stable field order makes exact replay independent of caller property order.
 * @param {unknown} value
 * @returns {OnlineContentFrameCheckpoint}
 * @throws {RangeError} If one descriptor exceeds bounded metadata admission.
 */
export function encodeOnlineContentFrameCheckpoint(value) {
    const frame = parseOnlineContentFrameDescriptor(value);
    const {identity, physicalKey, storedLength, codecId, envelope: storedEnvelope, decodedLength, decodedDigest} = frame;
    const metadataJson = JSON.stringify({
        version: 2,
        kind: identity.kind,
        logicalOffset: identity.logicalOffset,
        recordLength: identity.recordLength,
        sourceStoredLength: identity.sourceStoredLength === identity.recordLength ? void 0 : identity.sourceStoredLength,
        originalCodecId: identity.originalCodecId ?? void 0,
        expectedDecodedLength: identity.expectedDecodedLength ?? void 0,
        originalEnvelope: identity.originalEnvelope === 'mbc2' ? void 0 : identity.originalEnvelope,
        physicalKey,
        storedLength,
        codecId: codecId === identity.originalCodecId ? void 0 : codecId,
        envelope: storedEnvelope === identity.originalEnvelope ? void 0 : storedEnvelope,
        decodedLength: decodedLength === identity.expectedDecodedLength ? void 0 : decodedLength,
        decodedDigest: decodedDigest ?? void 0,
    });
    if (encoder.encode(metadataJson).byteLength > ONLINE_CONTENT_FRAME_ROW_BYTES) { throw new RangeError('Optimization frame metadata exceeds admission'); }
    return {sequence: frame.identity.logicalOffset, byteOffset: 0, byteLength: frame.storedLength, sha256: frame.decodedDigest, metadataJson};
}

/**
 * Validates persisted optional metadata before it can drive sample reads or GC.
 * @param {{sequence: unknown, byteOffset: unknown, byteLength: unknown, sha256: unknown, metadataJson: unknown}} row
 * @returns {OnlineContentFrameDescriptor}
 * @throws {TypeError|RangeError|SyntaxError} If a durable checkpoint is damaged.
 */
export function decodeOnlineContentFrameCheckpoint(row) {
    if (typeof row.metadataJson !== 'string' || encoder.encode(row.metadataJson).byteLength > ONLINE_CONTENT_FRAME_ROW_BYTES) {
        throw new TypeError('Optimization frame checkpoint JSON is invalid');
    }
    const parsed = /** @type {unknown} */ (parseJson(row.metadataJson));
    const frame = parseOnlineContentFrameDescriptor(unpackFrameCheckpoint(parsed));
    if (row.sequence !== frame.identity.logicalOffset || row.byteOffset !== 0 || row.byteLength !== frame.storedLength || row.sha256 !== frame.decodedDigest) {
        throw new TypeError('Optimization frame checkpoint columns disagree');
    }
    return frame;
}

/**
 * Compact checkpoints omit fields whose values equal the original frame.
 * Keep the independent length, logical offset and digest so SQL columns
 * cannot silently disagree with the saved descriptor.
 * @param {unknown} value
 * @returns {unknown}
 * @throws {TypeError} If the persisted version or metadata is invalid.
 */
function unpackFrameCheckpoint(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('Invalid optimization frame checkpoint');
    }
    const parsed = /** @type {Record<string, unknown>} */ (value);
    if (parsed.version === 1) { return record(parsed, ['version', 'frame']).frame; }
    if (parsed.version !== 2) { throw new TypeError('Unsupported optimization frame checkpoint'); }
    if (Object.keys(parsed).some((key) => !COMPACT_FRAME_FIELDS.has(key))) {
        throw new TypeError('Unknown compact optimization checkpoint field');
    }
    const originalCodecId = Object.hasOwn(parsed, 'originalCodecId') ? parsed.originalCodecId : null;
    const expectedDecodedLength = Object.hasOwn(parsed, 'expectedDecodedLength') ? parsed.expectedDecodedLength : null;
    const originalEnvelope = Object.hasOwn(parsed, 'originalEnvelope') ? parsed.originalEnvelope : 'mbc2';
    return {
        identity: {
            kind: parsed.kind,
            logicalOffset: parsed.logicalOffset,
            recordLength: parsed.recordLength,
            sourceStoredLength: Object.hasOwn(parsed, 'sourceStoredLength') ? parsed.sourceStoredLength : parsed.recordLength,
            originalCodecId,
            expectedDecodedLength,
            originalEnvelope,
        },
        physicalKey: parsed.physicalKey,
        storedLength: parsed.storedLength,
        codecId: Object.hasOwn(parsed, 'codecId') ? parsed.codecId : originalCodecId,
        envelope: Object.hasOwn(parsed, 'envelope') ? parsed.envelope : originalEnvelope,
        decodedLength: Object.hasOwn(parsed, 'decodedLength') ? parsed.decodedLength : expectedDecodedLength,
        decodedDigest: Object.hasOwn(parsed, 'decodedDigest') ? parsed.decodedDigest : null,
    };
}
