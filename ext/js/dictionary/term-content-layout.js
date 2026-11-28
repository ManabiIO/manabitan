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

const MAX_REGIONS = 2;
const MAX_REGION_BYTES = 128 * 1024 * 1024;
const MAX_DICTIONARY_BYTES = 112640;
const MAX_ROWS = 16384;
const MAX_TOTAL_ROWS = 32768;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_METADATA_BYTES = 2 * MAX_MANIFEST_BYTES;
const FRAME_FIELDS = 'kind logicalOffset recordLength sourceStoredLength originalCodecId expectedDecodedLength originalEnvelope fileId physicalOffset storedLength codecId envelope decodedLength decodedDigest';
const IDENTITY_FIELDS = 'kind logicalOffset recordLength sourceStoredLength originalCodecId expectedDecodedLength originalEnvelope';
const encoder = new TextEncoder();

/** Healthy old compressed bytes were deliberately superseded by a frame override. */
export class SupersededCompressedRangeError extends Error {
    constructor() {
        super('Logical range contains superseded compressed source bytes');
        /**
         *
         */
        this.name = 'SupersededCompressedRangeError';
        /**
         *
         */
        this.code = 'supersededCompressedRange';
    }
}

/** @typedef {{fileId: string, physicalOffset: number, length: number}} PhysicalSpan */
/** @typedef {{kind: 'block'|'legacy-entry'|'shared-glossary', logicalOffset: number, recordLength: number, sourceStoredLength: number, originalCodecId: string|null, expectedDecodedLength: number|null, originalEnvelope: 'mbc2'|'none'}} FrameIdentity */
/** @typedef {{logicalOffset: number, length: number, fileId: string, physicalOffset: number}} Extent */
/** @typedef {{logicalOffset: number, length: number, frameLogicalOffset: number}} RemovedRange */
/** @typedef {FrameIdentity & {fileId: string, physicalOffset: number, storedLength: number, codecId: string, envelope: 'mbc2'|'none', decodedLength: number, decodedDigest: string}} Frame */
/** @typedef {{version: number, regionId: string, logicalStart: number, logicalLength: number, extents: Extent[], blocks: Frame[], removed: RemovedRange[]}} Manifest */
/** @typedef {{fileId: string, byteLength: number, sha256: string|null}} PhysicalFile */
/** @typedef {{codecId: string, fileId: string, formatVersion: number, dictionaryBytes: number, dictionarySha256: string}} Codec */
/** @typedef {{identity: Readonly<FrameIdentity>, sourceStoredLength: number, spans: ReadonlyArray<Readonly<PhysicalSpan>>, storedLength: number, codecId: string|null, envelope: 'mbc2'|'none', decodedLength: number|null, decodedDigest: string|null}} ResolvedContentFrame */

/**
 * Validate one bounded region window and its flat frame/file/codec closure.
 * Frame offsets in manifests are relative; external frame offsets are absolute.
 * Input must be ordinary parsed JSON data. No borrowed object or mutable Map escapes.
 * SHA-256 values are physical-owner attestations; this pure function cannot hash files.
 * @param {unknown} input
 * @returns {{logicalStart: number, logicalEnd: number, resolveLogical: (offset: number, length: number) => ReadonlyArray<Readonly<PhysicalSpan>>, resolveFrame: (identity: unknown) => Readonly<ResolvedContentFrame>}}
 * @throws {TypeError|RangeError} If any metadata closure, interval or admission bound is invalid.
 */
export function createContentLayoutResolver(input) {
    const data = record(input, 'manifests externalFrames files physicalFiles codecs');
    let rowCount = 0;
    /**
     * @param {unknown} value
     * @param {number} [maximum]
     * @returns {unknown[]}
     * @throws {TypeError|RangeError} If the table is malformed or exceeds an admission bound.
     */
    function table(value, maximum = MAX_ROWS) {
        const rows = array(value, maximum);
        rowCount += rows.length;
        if (rowCount > MAX_TOTAL_ROWS) { throw new RangeError('Layout metadata row admission exceeded'); }
        return rows;
    }
    const manifests = table(data.manifests, MAX_REGIONS).map((value) => {
        const row = record(value, 'version regionId logicalStart logicalLength extents blocks removed');
        if (row.version !== 1) { throw new TypeError('Unsupported content layout version'); }
        const manifest = {
            version: 1,
            regionId: id(row.regionId),
            logicalStart: integer(row.logicalStart),
            logicalLength: integer(row.logicalLength, true),
            extents: table(row.extents).map(copyExtent),
            blocks: table(row.blocks).map(copyFrame),
            removed: table(row.removed).map(copyRemoved),
        };
        end(manifest.logicalStart, manifest.logicalLength);
        if (manifest.logicalLength > MAX_REGION_BYTES) { throw new RangeError('Layout region byte admission exceeded'); }
        if (encoder.encode(JSON.stringify(manifest)).byteLength > MAX_MANIFEST_BYTES) {
            throw new RangeError('Layout manifest byte admission exceeded');
        }
        return manifest;
    });
    if (manifests.length === 0) { throw new TypeError('At least one layout manifest is required'); }
    const externalFrames = table(data.externalFrames).map(copyFrame);
    const files = table(data.files).map(copyFile);
    const physicalFiles = table(data.physicalFiles).map(copyFile);
    const codecs = table(data.codecs).map(copyCodec);
    if (encoder.encode(JSON.stringify({manifests, externalFrames, files, physicalFiles, codecs})).byteLength > MAX_METADATA_BYTES) {
        throw new RangeError('Layout metadata byte admission exceeded');
    }
    const fileMap = uniqueMap(files, 'fileId');
    const physicalMap = uniqueMap(physicalFiles, 'fileId');
    if (fileMap.size !== physicalMap.size) { throw new TypeError('Physical file identity closure differs from catalog'); }
    for (const file of files) {
        const physical = physicalMap.get(file.fileId);
        if (typeof physical === 'undefined' || file.byteLength !== physical.byteLength || file.sha256 !== physical.sha256) {
            throw new TypeError('Physical file identity or byte length differs from catalog');
        }
    }
    const codecMap = uniqueMap(codecs, 'codecId');
    for (const codec of codecs) {
        const file = fileMap.get(codec.fileId);
        if (typeof file === 'undefined' || file.byteLength !== codec.dictionaryBytes ||
        file.sha256 === null || file.sha256 !== codec.dictionarySha256) {
            throw new TypeError('Codec dictionary file identity closure is missing or inconsistent');
        }
    }
    /**
     * @param {string} fileId
     * @param {number} offset
     * @param {number} length
     * @throws {TypeError|RangeError} If the physical span is outside its immutable file.
     */
    function validatePhysical(fileId, offset, length) {
        const file = fileMap.get(fileId);
        if (typeof file === 'undefined' || end(offset, length) > file.byteLength) {
            throw new TypeError('Physical span exceeds an observed immutable file');
        }
    }
    /** @type {Map<string, Array<{offset: number, length: number}>>} */
    const physicalRanges = new Map();
    /**
     * @param {string} fileId
     * @param {number} offset
     * @param {number} length
     */
    function retainPhysicalRange(fileId, offset, length) {
        let ranges = physicalRanges.get(fileId);
        if (typeof ranges === 'undefined') {
            ranges = [];
            physicalRanges.set(fileId, ranges);
        }
        ranges.push({offset, length});
    }
    let previousEnd = manifests[0].logicalStart;
    const regionIds = new Set();
    /** @type {Frame[]} */
    const frames = [];
    for (const manifest of manifests) {
        if (manifest.logicalStart !== previousEnd || regionIds.has(manifest.regionId)) {
            throw new TypeError('Regions must be sorted, contiguous and uniquely identified');
        }
        regionIds.add(manifest.regionId);
        previousEnd = end(manifest.logicalStart, manifest.logicalLength);
        validateIntervals(manifest.extents, manifest.logicalLength);
        validateIntervals(manifest.removed, manifest.logicalLength);
        let previousOffset = -1;
        for (const block of manifest.blocks) {
            if (block.logicalOffset <= previousOffset || block.logicalOffset >= manifest.logicalLength) {
                throw new TypeError('Frame starts must be sorted, unique and inside their start region');
            }
            previousOffset = block.logicalOffset;
            // Owned copies only: manifest offsets stay relative for admission accounting.
            frames.push({...block, logicalOffset: end(manifest.logicalStart, block.logicalOffset)});
        }
        for (const extent of manifest.extents) {
            validatePhysical(extent.fileId, extent.physicalOffset, extent.length);
            retainPhysicalRange(extent.fileId, extent.physicalOffset, extent.length);
        }
    }
    const logicalStart = manifests[0].logicalStart;
    const logicalEnd = previousEnd;
    let previousExternal = -1;
    for (const frame of externalFrames) {
        if (frame.logicalOffset <= previousExternal || (frame.logicalOffset >= logicalStart && frame.logicalOffset < logicalEnd)) {
            throw new TypeError('External frames must be sorted and start outside the region window');
        }
        previousExternal = frame.logicalOffset;
        frames.push(frame);
    }
    frames.sort((a, b) => a.logicalOffset - b.logicalOffset);
    let previousSourceEnd = -1;
    for (const frame of frames) {
        if (frame.logicalOffset < previousSourceEnd) { throw new TypeError('Original frame source intervals overlap or conflict'); }
        previousSourceEnd = end(frame.logicalOffset, frame.sourceStoredLength);
        validatePhysical(frame.fileId, frame.physicalOffset, frame.storedLength);
        retainPhysicalRange(frame.fileId, frame.physicalOffset, frame.storedLength);
        if (!codecMap.has(frame.codecId)) { throw new TypeError('Replacement codec closure is missing'); }
    }
    for (const codec of codecs) { retainPhysicalRange(codec.fileId, 0, codec.dictionaryBytes); }
    for (const ranges of physicalRanges.values()) {
        ranges.sort((a, b) => a.offset - b.offset);
        let previousRangeEnd = 0;
        for (const range of ranges) {
            if (range.offset < previousRangeEnd) { throw new TypeError('Immutable physical spans overlap'); }
            previousRangeEnd = end(range.offset, range.length);
        }
    }
    for (const manifest of manifests) {
        for (const removed of manifest.removed) {
            const index = floorIndex(frames, removed.frameLogicalOffset, 'logicalOffset');
            const frame = frames[index];
            if (typeof frame === 'undefined' || frame.logicalOffset !== removed.frameLogicalOffset) {
                throw new TypeError('Removed interval has no replacement frame owner');
            }
            const first = Math.max(frame.logicalOffset, manifest.logicalStart);
            const last = Math.min(end(frame.logicalOffset, frame.sourceStoredLength), end(manifest.logicalStart, manifest.logicalLength));
            if (last <= first || removed.logicalOffset !== first - manifest.logicalStart || removed.length !== last - first) {
                throw new TypeError('Removed interval differs from exact original frame intersection');
            }
        }
        // Merge two already-sorted tables; no implicit removal from a frame row.
        let extentIndex = 0;
        let removedIndex = 0;
        let cursor = 0;
        while (extentIndex < manifest.extents.length || removedIndex < manifest.removed.length) {
            const extent = manifest.extents[extentIndex];
            const removed = manifest.removed[removedIndex];
            const useExtent = typeof removed === 'undefined' || (typeof extent !== 'undefined' && extent.logicalOffset < removed.logicalOffset);
            const interval = useExtent ? manifest.extents[extentIndex++] : manifest.removed[removedIndex++];
            if (interval.logicalOffset !== cursor) { throw new TypeError('Retained and removed intervals must exactly cover each region'); }
            cursor = end(cursor, interval.length);
        }
        if (cursor !== manifest.logicalLength) { throw new TypeError('Retained and removed intervals leave an uncovered region suffix'); }
    }

    /**
     * @param {number} offset
     * @param {number} length
     * @returns {ReadonlyArray<Readonly<PhysicalSpan>>}
     * @throws {RangeError|SupersededCompressedRangeError} If the range is outside the loaded layout or its bytes were superseded.
     */
    function resolveLogical(offset, length) {
        const limit = end(offset, length);
        if (offset < logicalStart || limit > logicalEnd) { throw new RangeError('Logical range lies outside the loaded region window'); }
        const spans = [];
        let cursor = offset;
        let regionIndex = floorIndex(manifests, cursor, 'logicalStart');
        while (cursor < limit) {
            const region = manifests[regionIndex];
            const relativeOffset = cursor - region.logicalStart;
            let extentIndex = floorIndex(region.extents, relativeOffset, 'logicalOffset');
            while (cursor < limit && cursor < region.logicalStart + region.logicalLength) {
                const extent = region.extents[extentIndex];
                const relative = cursor - region.logicalStart;
                if (typeof extent === 'undefined' || relative < extent.logicalOffset || relative >= extent.logicalOffset + extent.length) {
                    throw new SupersededCompressedRangeError();
                }
                const spanLength = Math.min(limit - cursor, extent.logicalOffset + extent.length - relative);
                spans.push(Object.freeze({fileId: extent.fileId, physicalOffset: extent.physicalOffset + relative - extent.logicalOffset, length: spanLength}));
                cursor += spanLength;
                ++extentIndex;
            }
            ++regionIndex;
        }
        return Object.freeze(spans);
    }

    /**
     * @param {unknown} value Persisted descriptors are validated before use.
     * @returns {Readonly<ResolvedContentFrame>}
     * @throws {TypeError|RangeError} If the frame identity conflicts with the loaded layout.
     */
    function resolveFrame(value) {
        const identity = copyIdentity(record(value, IDENTITY_FIELDS));
        const index = floorIndex(frames, identity.logicalOffset, 'logicalOffset');
        const replacement = frames[index];
        if (typeof replacement !== 'undefined' && replacement.logicalOffset === identity.logicalOffset) {
            const identityValues = /** @type {Record<string, unknown>} */ (identity);
            const replacementValues = /** @type {Record<string, unknown>} */ (replacement);
            for (const field of IDENTITY_FIELDS.split(' ')) {
                if (identityValues[field] !== replacementValues[field]) { throw new TypeError('Original frame descriptor identity differs from override'); }
            }
            return Object.freeze({
                identity: Object.freeze(identity),
                sourceStoredLength: replacement.sourceStoredLength,
                spans: Object.freeze([Object.freeze({fileId: replacement.fileId, physicalOffset: replacement.physicalOffset, length: replacement.storedLength})]),
                storedLength: replacement.storedLength,
                codecId: replacement.codecId,
                envelope: replacement.envelope,
                decodedLength: replacement.decodedLength,
                decodedDigest: replacement.decodedDigest,
            });
        }
        const sourceEnd = end(identity.logicalOffset, identity.sourceStoredLength);
        const next = frames[index + 1];
        if ((typeof replacement !== 'undefined' && end(replacement.logicalOffset, replacement.sourceStoredLength) > identity.logicalOffset) ||
        (typeof next !== 'undefined' && next.logicalOffset < sourceEnd)) {
            throw new TypeError('Original frame descriptor overlaps another replacement identity');
        }
        return Object.freeze({
            identity: Object.freeze(identity),
            sourceStoredLength: identity.sourceStoredLength,
            spans: resolveLogical(identity.logicalOffset, identity.sourceStoredLength),
            storedLength: identity.sourceStoredLength,
            codecId: identity.originalCodecId,
            envelope: identity.originalEnvelope,
            decodedLength: identity.expectedDecodedLength,
            decodedDigest: null,
        });
    }
    return Object.freeze({logicalStart, logicalEnd, resolveLogical, resolveFrame});
}

/**
 * @param {unknown} value
 * @param {string} fields
 * @returns {Record<string, unknown>}
 * @throws {TypeError} If the record does not contain the requested own data fields.
 */
function record(value, fields) {
    if (typeof value !== 'object' || value === null || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
        throw new TypeError('Layout record must be a plain own-data object');
    }
    const expected = fields.split(' ');
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expected.length || keys.some((key) => typeof key !== 'string' || !expected.includes(key))) {
        throw new TypeError('Layout record has missing or unknown keys');
    }
    /** @type {Record<string, unknown>} */
    const result = {};
    for (const key of expected) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (typeof descriptor === 'undefined' || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
            throw new TypeError('Layout records cannot contain accessors or hidden fields');
        }
        const fieldValue = /** @type {unknown} */ (descriptor.value);
        result[key] = fieldValue;
    }
    return result;
}

/**
 * @param {unknown} value
 * @param {number} maximum
 * @returns {unknown[]}
 * @throws {TypeError|RangeError} If the table is malformed or exceeds its row bound.
 */
function array(value, maximum) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) { throw new TypeError('Layout table must be a plain array'); }
    if (value.length > maximum) { throw new RangeError('Layout metadata table admission exceeded'); }
    if (Reflect.ownKeys(value).length !== value.length + 1) { throw new TypeError('Layout table has extra keys or holes'); }
    const result = [];
    for (let index = 0; index < value.length; ++index) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (typeof descriptor === 'undefined' || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
            throw new TypeError('Layout table cannot contain holes or accessors');
        }
        result.push(descriptor.value);
    }
    return result;
}

/**
 * @param {unknown} value
 * @param {boolean} [positive]
 * @returns {number}
 * @throws {RangeError} If the value is outside the permitted integer domain.
 */
function integer(value, positive = false) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
        throw new RangeError('Layout byte coordinate must be a nonnegative safe integer');
    }
    return value;
}

/**
 * @param {number} offset
 * @param {number} length
 * @returns {number}
 * @throws {RangeError} If the range exceeds safe integer coordinates.
 */
function end(offset, length) {
    integer(offset);
    integer(length);
    if (offset > Number.MAX_SAFE_INTEGER - length) { throw new RangeError('Layout byte range exceeds safe integer bounds'); }
    return offset + length;
}

/**
 * @param {unknown} value
 * @returns {string}
 * @throws {TypeError} If the value is not an allowed identifier.
 */
function id(value) {
    if (typeof value !== 'string' || value.length > 128 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) { throw new TypeError('Invalid immutable layout identifier'); }
    return value;
}

/**
 * @param {unknown} value
 * @returns {string}
 * @throws {TypeError} If the value is not a lowercase SHA-256 digest.
 */
function digest(value) {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) { throw new TypeError('Invalid SHA-256 identity'); }
    return value;
}

/**
 * @param {unknown} value
 * @returns {'mbc2'|'none'}
 * @throws {TypeError} If the frame envelope is unsupported.
 */
function envelope(value) {
    if (value !== 'mbc2' && value !== 'none') { throw new TypeError('Unknown frame envelope'); }
    return value;
}

/**
 * @param {Record<string, unknown>} row
 * @returns {FrameIdentity}
 * @throws {TypeError|RangeError} If the original frame identity is invalid.
 */
function copyIdentity(row) {
    const kind = row.kind;
    if (kind !== 'block' && kind !== 'legacy-entry' && kind !== 'shared-glossary') { throw new TypeError('Unknown frame kind'); }
    /** @type {FrameIdentity} */
    const result = {
        kind,
        logicalOffset: integer(row.logicalOffset),
        recordLength: integer(row.recordLength, true),
        sourceStoredLength: integer(row.sourceStoredLength, true),
        originalCodecId: row.originalCodecId === null || row.originalCodecId === '' ? row.originalCodecId : id(row.originalCodecId),
        expectedDecodedLength: row.expectedDecodedLength === null ? null : integer(row.expectedDecodedLength, true),
        originalEnvelope: envelope(row.originalEnvelope),
    };
    if (kind !== 'legacy-entry' && result.recordLength !== result.sourceStoredLength) { throw new TypeError('Exact source length differs from original block or artifact record length'); }
    if (result.originalEnvelope === 'mbc2' && result.sourceStoredLength <= 12) { throw new TypeError('Original MBC2 envelope has no compressed frame'); }
    end(result.logicalOffset, result.sourceStoredLength);
    return result;
}

/**
 * @param {unknown} value
 * @returns {Frame}
 * @throws {TypeError|RangeError} If a replacement frame descriptor is invalid.
 */
function copyFrame(value) {
    const row = record(value, FRAME_FIELDS);
    const identity = copyIdentity(row);
    const result = {
        ...identity,
        fileId: id(row.fileId),
        physicalOffset: integer(row.physicalOffset),
        storedLength: integer(row.storedLength, true),
        codecId: id(row.codecId),
        envelope: envelope(row.envelope),
        decodedLength: integer(row.decodedLength, true),
        decodedDigest: digest(row.decodedDigest),
    };
    if (identity.expectedDecodedLength !== null && result.decodedLength !== identity.expectedDecodedLength) { throw new TypeError('Replacement decoded length differs from original identity'); }
    if (result.envelope === 'mbc2' && result.storedLength <= 12) { throw new TypeError('Replacement MBC2 envelope has no compressed frame'); }
    end(result.physicalOffset, result.storedLength);
    return result;
}

/**
 * @param {unknown} value
 * @returns {Extent}
 * @throws {TypeError|RangeError} If the retained extent descriptor is invalid.
 */
function copyExtent(value) {
    const row = record(value, 'logicalOffset length fileId physicalOffset');
    const result = {logicalOffset: integer(row.logicalOffset), length: integer(row.length, true), fileId: id(row.fileId), physicalOffset: integer(row.physicalOffset)};
    end(result.physicalOffset, result.length);
    return result;
}

/**
 * @param {unknown} value
 * @returns {RemovedRange}
 * @throws {TypeError|RangeError} If the removed interval descriptor is invalid.
 */
function copyRemoved(value) {
    const row = record(value, 'logicalOffset length frameLogicalOffset');
    return {logicalOffset: integer(row.logicalOffset), length: integer(row.length, true), frameLogicalOffset: integer(row.frameLogicalOffset)};
}

/**
 * @param {unknown} value
 * @returns {PhysicalFile}
 * @throws {TypeError|RangeError} If the immutable file descriptor is invalid.
 */
function copyFile(value) {
    const row = record(value, 'fileId byteLength sha256');
    return {
        fileId: id(row.fileId),
        byteLength: integer(row.byteLength),
        // Large immutable data packs do not require a whole-file hash on cold reads.
        // Codec dictionaries still require their independent mandatory digest below.
        sha256: row.sha256 === null ? null : digest(row.sha256),
    };
}

/**
 * @param {unknown} value
 * @returns {Codec}
 * @throws {TypeError|RangeError} If codec metadata or its dictionary size is invalid.
 */
function copyCodec(value) {
    const row = record(value, 'codecId fileId formatVersion dictionaryBytes dictionarySha256');
    if (row.formatVersion !== 1) { throw new TypeError('Unsupported codec format version'); }
    const dictionaryBytes = integer(row.dictionaryBytes, true);
    if (dictionaryBytes > MAX_DICTIONARY_BYTES) { throw new RangeError('Codec dictionary byte admission exceeded'); }
    return {codecId: id(row.codecId), fileId: id(row.fileId), formatVersion: 1, dictionaryBytes, dictionarySha256: digest(row.dictionarySha256)};
}

/**
 * @template {Record<string, unknown>} T
 * @template {keyof T} K
 * @param {T[]} rows
 * @param {K} key
 * @returns {Map<T[K], T>}
 * @throws {TypeError} If metadata identities are duplicated.
 */
function uniqueMap(rows, key) {
    const result = new Map();
    for (const row of rows) {
        if (result.has(row[key])) { throw new TypeError('Duplicate immutable metadata identity'); }
        result.set(row[key], row);
    }
    return result;
}

/**
 * @param {Array<{logicalOffset: number, length: number}>} rows
 * @param {number} length
 * @throws {TypeError|RangeError} If intervals overlap or lie outside the region.
 */
function validateIntervals(rows, length) {
    let cursor = 0;
    for (const row of rows) {
        const limit = end(row.logicalOffset, row.length);
        if (row.logicalOffset < cursor || limit > length) {
            throw new TypeError('Layout intervals overlap, are unsorted or exceed their region');
        }
        cursor = limit;
    }
}

/**
 * @param {Array<any>} rows
 * @param {number} offset
 * @param {string} key
 * @returns {number}
 */
function floorIndex(rows, offset, key) {
    let first = 0;
    let last = rows.length;
    while (first < last) {
        const middle = first + Math.floor((last - first) / 2);
        if (/** @type {number} */ (rows[middle][key]) <= offset) {
            first = middle + 1;
        } else {
            last = middle;
        }
    }
    return first - 1;
}
