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

import {createContentLayoutResolver} from './term-content-layout.js';

/** @typedef {import('./term-content-layout.js').FrameIdentity} FrameIdentity */
/** @typedef {import('./term-content-layout.js').Frame} Frame */
/** @typedef {import('./term-content-layout.js').Extent} Extent */
/** @typedef {import('./term-content-layout.js').RemovedRange} RemovedRange */
/** @typedef {import('./term-content-layout.js').Manifest} Manifest */
/** @typedef {import('./term-content-layout.js').PhysicalFile} PhysicalFile */
/** @typedef {import('./term-content-layout.js').Codec} Codec */
/** @typedef {{manifests: Manifest[], externalFrames: Frame[], files: PhysicalFile[], physicalFiles: PhysicalFile[], codecs: Codec[]}} ContentRepackWindow */
/** @typedef {{regionId: string, fileId: string}} ContentRepackTarget */
/** @typedef {'retained'|'frame'} ContentRepackCopyRole */
/** @typedef {{sourceFileId: string, sourceOffset: number, targetOffset: number, length: number, role: ContentRepackCopyRole, logicalOffset: number}} ContentRepackCopyOperation */
/** @typedef {{regionId: string, fileId: string, byteLength: number, operations: ContentRepackCopyOperation[]}} ContentRepackWrite */
/** @typedef {ContentRepackCopyOperation & {targetFileId: string}} ContentRepackCopyChunk */
/** @typedef {{version: number, logicalStart: number, logicalEnd: number, next: ContentRepackWindow, writes: ContentRepackWrite[], readFiles: PhysicalFile[], unreferencedInWindow: string[]}} ContentRegionRepackPlan */
/** @typedef {{source: ContentRepackWindow, replacements?: Frame[], packFiles?: ContentRepackTarget[], relocateFrames?: boolean}} ContentRegionRepackOptions */

const MAX_ROWS = 16384;
const MAX_OPERATIONS = 32768;
const MAX_PLAN_BYTES = 8 * 1024 * 1024;
const MAX_REPLACEMENT_BYTES = 2 * 1024 * 1024;
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
/** @type {Array<keyof FrameIdentity>} */
const IDENTITY_FIELDS = ['kind', 'logicalOffset', 'recordLength', 'sourceStoredLength', 'originalCodecId', 'expectedDecodedLength', 'originalEnvelope'];
/** @type {Array<keyof Frame>} */
const FRAME_FIELDS = [...IDENTITY_FIELDS, 'fileId', 'physicalOffset', 'storedLength', 'codecId', 'envelope', 'decodedLength', 'decodedDigest'];
const encoder = new TextEncoder();

/**
 * Plans a bounded immutable region repack without I/O or source mutation.
 * Replacement offsets are absolute ORIGINAL identities with independently
 * verified stored bytes, decoded equality and digests. Source catalogs include
 * observed staged replacement/dictionary files and external owner closure.
 * Requested pack IDs must be fresh and durably reserved by the caller before
 * file creation. Frames remain in their immutable assets unless relocateFrames
 * copies start-region frames after retained extents in a requested pack.
 * Physical pack size may exceed logical region size; copy chunks stay bounded.
 * Returned target sizes are expectations until writes/readback finish. The
 * caller owns source leases through all started copies, short-I/O handling,
 * independent readback/decode validation, actual file observations, manifest
 * SHA identities, generation/source-layout checks and atomic SQL publication.
 * unreferencedInWindow never authorizes deletion: root-wide durable references,
 * staged/recovery/checkpoint/codec ownership and runtime leases still apply.
 * @param {ContentRegionRepackOptions} options
 * @returns {ContentRegionRepackPlan}
 * @throws {TypeError|RangeError} If source metadata or copy admission limits are invalid.
 */
export function planContentRegionRepack({source, replacements = [], packFiles = [], relocateFrames = false}) {
    const original = createContentLayoutResolver(source);
    assertBoundedArray(replacements, MAX_ROWS, 'Replacement table');
    assertBoundedArray(packFiles, 2, 'Pack table');
    if (typeof relocateFrames !== 'boolean') { throw new TypeError('Invalid frame relocation choice'); }
    const owned = structuredClone(source);
    const newFrames = replacements.map(copyReplacement);
    if (encoder.encode(JSON.stringify(newFrames)).byteLength > MAX_REPLACEMENT_BYTES) {
        throw new RangeError('Replacement metadata admission exceeded');
    }
    const sourceCatalog = new Map(owned.files.map((file) => [file.fileId, file]));
    const catalog = new Map(sourceCatalog);
    const codecCatalog = new Map(owned.codecs.map((codec) => [codec.codecId, codec]));
    const frames = owned.manifests.flatMap((region) => region.blocks.map((frame) => ({
        ...frame,
        logicalOffset: end(region.logicalStart, frame.logicalOffset),
    })));
    frames.push(...owned.externalFrames);
    const byOffset = new Map(frames.map((frame) => [frame.logicalOffset, frame]));
    const replacementOffsets = new Set();
    for (const frame of newFrames) {
        const limit = end(frame.logicalOffset, frame.sourceStoredLength);
        if (frame.sourceStoredLength <= 0 || frame.logicalOffset < original.logicalStart || limit > original.logicalEnd) {
            throw new RangeError('Replacement requires a complete affected region window');
        }
        if (replacementOffsets.has(frame.logicalOffset)) { throw new TypeError('Duplicate replacement identity'); }
        replacementOffsets.add(frame.logicalOffset);
        const old = byOffset.get(frame.logicalOffset);
        if (typeof old !== 'undefined' && (!identityMatches(old, frame) || old.decodedLength !== frame.decodedLength || old.decodedDigest !== frame.decodedDigest)) {
            throw new TypeError('Replacement conflicts with stable original identity or decoded digest');
        }
        byOffset.set(frame.logicalOffset, frame);
    }
    const merged = [...byOffset.values()].sort((a, b) => a.logicalOffset - b.logicalOffset);
    let previousEnd = -1;
    for (const frame of merged) {
        if (frame.logicalOffset < previousEnd) { throw new TypeError('Replacement source intervals overlap or conflict'); }
        previousEnd = end(frame.logicalOffset, frame.sourceStoredLength);
    }
    /** @type {Map<string, string>} */
    const packByRegion = new Map();
    const targetIds = new Set();
    for (const value of packFiles) {
        const pack = copyPackTarget(value);
        if (!owned.manifests.some((region) => region.regionId === pack.regionId) || packByRegion.has(pack.regionId) ||
        targetIds.has(pack.fileId) || catalog.has(pack.fileId)) {
            throw new TypeError('Pack identity is missing, duplicate or not fresh');
        }
        packByRegion.set(pack.regionId, pack.fileId);
        targetIds.add(pack.fileId);
    }
    /** @type {ContentRepackWrite[]} */
    const writes = [];
    /** @type {Manifest[]} */
    const sourceManifests = [];
    let operationCount = 0;
    let firstFrame = 0;
    const nextManifests = owned.manifests.map((region) => {
        const regionEnd = end(region.logicalStart, region.logicalLength);
        while (firstFrame < merged.length && end(merged[firstFrame].logicalOffset, merged[firstFrame].sourceStoredLength) <= region.logicalStart) {
            ++firstFrame;
        }
        /** @type {RemovedRange[]} */
        const removed = [];
        for (let i = firstFrame; i < merged.length && merged[i].logicalOffset < regionEnd; ++i) {
            const frame = merged[i];
            const first = Math.max(region.logicalStart, frame.logicalOffset);
            const last = Math.min(regionEnd, end(frame.logicalOffset, frame.sourceStoredLength));
            if (last > first) {
                removed.push({logicalOffset: first - region.logicalStart, length: last - first, frameLogicalOffset: frame.logicalOffset});
            }
        }
        // Sweep sorted tables using exact sourceStoredLength. recordLength,
        // decoded length and replacement length never determine source holes.
        /** @type {Extent[]} */
        const extents = [];
        let holeIndex = 0;
        for (const extent of region.extents) {
            let cursor = extent.logicalOffset;
            const limit = end(cursor, extent.length);
            while (holeIndex < removed.length && end(removed[holeIndex].logicalOffset, removed[holeIndex].length) <= cursor) {
                ++holeIndex;
            }
            let index = holeIndex;
            while (index < removed.length && removed[index].logicalOffset < limit) {
                const hole = removed[index];
                if (hole.logicalOffset > cursor) {
                    extents.push({...extent,
                        logicalOffset: cursor,
                        physicalOffset: end(extent.physicalOffset, cursor - extent.logicalOffset),
                        length: hole.logicalOffset - cursor});
                }
                cursor = Math.max(cursor, Math.min(limit, end(hole.logicalOffset, hole.length)));
                if (cursor === limit) { break; }
                ++index;
            }
            if (cursor < limit) {
                extents.push({...extent,
                    logicalOffset: cursor,
                    physicalOffset: end(extent.physicalOffset, cursor - extent.logicalOffset),
                    length: limit - cursor});
            }
        }
        const blocks = merged.filter((frame) => frame.logicalOffset >= region.logicalStart && frame.logicalOffset < regionEnd)
            .map((frame) => ({...frame, logicalOffset: frame.logicalOffset - region.logicalStart}));
        // Preserve the pre-relocation metadata for independent source-span validation.
        sourceManifests.push(structuredClone({...region, extents, blocks, removed}));
        const targetId = packByRegion.get(region.regionId);
        if (typeof targetId !== 'undefined') {
            /** @type {ContentRepackWrite} */
            const write = {regionId: region.regionId, fileId: targetId, byteLength: 0, operations: []};
            /**
             * @param {{fileId: string, physicalOffset: number}} row
             * @param {number} length
             * @param {ContentRepackCopyRole} role
             * @param {number} logicalOffset
             * @throws {TypeError|RangeError} If the source file is missing or its copy span is invalid.
             */
            const copy = (row, length, role, logicalOffset) => {
                if (++operationCount > MAX_OPERATIONS) { throw new RangeError('Copy operation admission exceeded'); }
                const sourceFile = sourceCatalog.get(row.fileId);
                if (typeof sourceFile === 'undefined') { throw new TypeError('Copy source file closure is missing'); }
                if (end(row.physicalOffset, length) > sourceFile.byteLength) {
                    throw new RangeError('Copy source physical span exceeds observed immutable file');
                }
                const targetOffset = write.byteLength;
                write.byteLength = end(targetOffset, length);
                write.operations.push({sourceFileId: row.fileId, sourceOffset: row.physicalOffset, targetOffset, length, role, logicalOffset});
                row.fileId = targetId;
                row.physicalOffset = targetOffset;
            };
            for (const extent of extents) {
                copy(extent, extent.length, 'retained', end(region.logicalStart, extent.logicalOffset));
            }
            if (relocateFrames) {
                for (const frame of blocks) {
                    copy(frame, frame.storedLength, 'frame', end(region.logicalStart, frame.logicalOffset));
                }
            }
            if (write.byteLength > 0) {
                writes.push(write);
                catalog.set(targetId, {fileId: targetId, byteLength: write.byteLength, sha256: null});
            }
        }
        return {...region, extents, blocks, removed};
    });
    const externalFrames = merged.filter((frame) => frame.logicalOffset < original.logicalStart || frame.logicalOffset >= original.logicalEnd);
    // Relocation must never conceal malformed original physical descriptors or
    // aliases by replacing their offsets with valid fresh-pack coordinates.
    createContentLayoutResolver({...owned, manifests: sourceManifests, externalFrames});
    const allNextFrames = [...nextManifests.flatMap((region) => region.blocks), ...externalFrames];
    const codecIds = new Set(allNextFrames.map((frame) => frame.codecId));
    const codecs = [...codecIds].map((id) => {
        const codec = codecCatalog.get(id);
        if (typeof codec === 'undefined') { throw new TypeError('Replacement codec closure is missing'); }
        return codec;
    });
    const fileIds = new Set(nextManifests.flatMap((region) => region.extents.map((extent) => extent.fileId)));
    for (const frame of allNextFrames) { fileIds.add(frame.fileId); }
    for (const codec of codecs) { fileIds.add(codec.fileId); }
    const files = [...fileIds].map((id) => {
        const file = catalog.get(id);
        if (typeof file === 'undefined') { throw new TypeError('Replacement file closure is missing'); }
        return file;
    });
    const next = {manifests: nextManifests, externalFrames, files, physicalFiles: structuredClone(files), codecs};
    // Final validation covers descriptor fields, exact coverage, physical bounds/
    // nonoverlap, envelope minimums, codec closure and per-window admission.
    createContentLayoutResolver(next);
    const readIds = new Set(writes.flatMap((write) => write.operations.map((operation) => operation.sourceFileId)));
    const readFiles = [...readIds].map((id) => {
        const file = sourceCatalog.get(id);
        if (typeof file === 'undefined') { throw new TypeError('Copy source closure is incomplete'); }
        return file;
    });
    const result = {
        version: 1,
        logicalStart: original.logicalStart,
        logicalEnd: original.logicalEnd,
        next,
        writes,
        readFiles,
        unreferencedInWindow: owned.files.filter((file) => !fileIds.has(file.fileId)).map((file) => file.fileId),
    };
    if (encoder.encode(JSON.stringify(result)).byteLength > MAX_PLAN_BYTES) {
        throw new RangeError('Repack plan metadata admission exceeded');
    }
    return freezeOwned(result);
}

/**
 * Expands an owned planner result lazily into <=4MiB operations without byte
 * allocation. logicalOffset advances for retained bytes; frame chunks retain
 * their stable original frame-start anchor, independent of compressed length.
 * @param {Pick<ContentRegionRepackPlan, 'writes'>} plan
 * @param {number} [chunkBytes]
 * @returns {Generator<ContentRepackCopyChunk, void, unknown>}
 * @yields {ContentRepackCopyChunk} One bounded physical copy operation.
 * @throws {RangeError} If the requested chunk bound is invalid.
 */
export function *iterateContentRepackCopyChunks(plan, chunkBytes = MAX_CHUNK_BYTES) {
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes > MAX_CHUNK_BYTES) {
        throw new RangeError('Invalid copy chunk bound');
    }
    for (const write of plan.writes) {
        for (const operation of write.operations) {
            let copied = 0;
            while (copied < operation.length) {
                const length = Math.min(chunkBytes, operation.length - copied);
                yield {...operation,
                    targetFileId: write.fileId,
                    sourceOffset: end(operation.sourceOffset, copied),
                    targetOffset: end(operation.targetOffset, copied),
                    logicalOffset: operation.role === 'retained' ? end(operation.logicalOffset, copied) : operation.logicalOffset,
                    length};
                copied = end(copied, length);
            }
        }
    }
}

/**
 * @param {unknown} value
 * @returns {Frame}
 * @throws {TypeError|RangeError} If a replacement descriptor contains invalid own data.
 */
function copyReplacement(value) {
    const prototypeValue = /** @type {unknown} */ (Object.getPrototypeOf(/** @type {object} */ (value)));
    const prototype = /** @type {object|null} */ (prototypeValue);
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(prototype) ||
    Reflect.ownKeys(value).length !== FRAME_FIELDS.length) {
        throw new TypeError('Invalid replacement descriptor');
    }
    /** @type {Record<string, unknown>} */
    const copy = {};
    for (const key of FRAME_FIELDS) {
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (typeof property === 'undefined' || !Object.hasOwn(property, 'value') || !property.enumerable) {
            throw new TypeError('Invalid replacement own-data field');
        }
        const field = /** @type {unknown} */ (property.value);
        if (field !== null && typeof field !== 'string' && typeof field !== 'number') {
            throw new TypeError('Invalid replacement own-data field');
        }
        if (typeof field === 'string' && field.length > 128) { throw new RangeError('Replacement string admission exceeded'); }
        copy[key] = field;
    }
    // Field domains are checked by the shared resolver before a plan escapes.
    return /** @type {Frame} */ (/** @type {unknown} */ (copy));
}

/**
 * @param {unknown} value
 * @returns {ContentRepackTarget}
 * @throws {TypeError} If the pack descriptor is not plain own data.
 */
function copyPackTarget(value) {
    const prototypeValue = /** @type {unknown} */ (Object.getPrototypeOf(/** @type {object} */ (value)));
    const prototype = /** @type {object|null} */ (prototypeValue);
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(prototype) || Reflect.ownKeys(value).length !== 2) {
        throw new TypeError('Invalid pack descriptor');
    }
    const region = Object.getOwnPropertyDescriptor(value, 'regionId');
    const file = Object.getOwnPropertyDescriptor(value, 'fileId');
    if (typeof region === 'undefined' || typeof file === 'undefined' || !Object.hasOwn(region, 'value') ||
    !Object.hasOwn(file, 'value') || !region.enumerable || !file.enumerable) {
        throw new TypeError('Invalid pack descriptor own-data fields');
    }
    return {regionId: identifier(region.value), fileId: identifier(file.value)};
}

/**
 * @param {number} offset
 * @param {number} length
 * @returns {number}
 * @throws {RangeError} If the byte interval is outside safe bounds.
 */
function end(offset, length) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || offset > Number.MAX_SAFE_INTEGER - length) {
        throw new RangeError('Unsafe planner byte interval');
    }
    return offset + length;
}

/**
 * @param {unknown} value
 * @returns {string}
 * @throws {TypeError} If the value is not a permitted identity.
 */
function identifier(value) {
    if (typeof value !== 'string' || value.length > 128 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) {
        throw new TypeError('Invalid planner file identity');
    }
    return value;
}

/**
 * @template T
 * @param {T} value
 * @returns {T}
 * @throws {TypeError} If an owned value cannot be traversed or frozen.
 */
function freezeOwned(value) {
    if (value && typeof value === 'object') {
        for (const child of Object.values(value)) { freezeOwned(child); }
        Object.freeze(value);
    }
    return value;
}

/**
 * @param {FrameIdentity} a
 * @param {FrameIdentity} b
 * @returns {boolean}
 */
function identityMatches(a, b) { return IDENTITY_FIELDS.every((key) => a[key] === b[key]); }

/**
 * @param {unknown} value
 * @param {number} maximum
 * @param {string} label
 * @throws {TypeError|RangeError} If the array is not a bounded plain data array.
 */
function assertBoundedArray(value, maximum, label) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1) {
        throw new RangeError(label + ' admission exceeded');
    }
    for (let index = 0; index < value.length; ++index) {
        const property = Object.getOwnPropertyDescriptor(value, String(index));
        if (typeof property === 'undefined' || !Object.hasOwn(property, 'value') || !property.enumerable) {
            throw new TypeError(label + ' must contain plain own-data entries');
        }
    }
}
