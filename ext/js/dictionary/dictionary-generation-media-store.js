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

import {getImageMediaTypeFromFileName} from '../media/media-util.js';
import {deferPromise} from '../core/utilities.js';

const DIRECTORY = 'manabitan-dictionary-media-v1';
const GENERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PACK_FILE_PATTERN = /^(.*)[.]bin$/;
const HEADER_BYTES = 512;
const HEADER_MAGIC = new TextEncoder().encode('manabitan-generation-media-2');
const ROW_BYTES = 24;
const ROW_ID_OFFSET = 16;
const ROW_CRC_OFFSET = 20;
const MAX_ROWS = 300000;
const MAX_DATA_BYTES = 256 * 1024 * 1024;
const MAX_CONTENT_BYTES = 4 * 1024 * 1024;
const DEFLATE_FLAG = 0x80000000;

/** @typedef {import('dictionary-importer').GenerationMediaDescriptor} GenerationMediaDescriptor */
/** @typedef {{path: string, packedOffset: number, packedLength: number, compressionMethod: number, uncompressedLength: number, signature: number}} SourceMediaRange */
/** @typedef {{descriptor: GenerationMediaDescriptor, index: Uint8Array<ArrayBuffer>}} GenerationMediaIndex */
/** @typedef {{descriptor: GenerationMediaDescriptor, descriptorKey: string, prefix: Blob}} GenerationMediaPrefix */
/** @typedef {{promise: Promise<void>, select: (plan: GenerationMediaIndex) => string, cancel: () => void}} StagedGenerationMediaWrite */

/**
 * Admit only one canonical decimal path namespace with bounded holes. A missing
 * offset slot is distinct from a valid path with zero as its first data offset.
 * @param {SourceMediaRange[]} records
 * @param {number} dataBytes
 * @returns {GenerationMediaIndex|null}
 */
export function createGenerationMediaIndex(records, dataBytes) {
    if (records.length === 0 || records.length > MAX_ROWS || !Number.isSafeInteger(dataBytes) || dataBytes <= 0 || dataBytes > MAX_DATA_BYTES) {
        return null;
    }
    /* eslint-disable @stylistic/semi */
    const layout = createGenerationMediaIndexLayout(records.length, (i) => records[i].path)
    if (layout === null) { return null }
    const {prefix, suffix, ids, firstId, slotCount, index} = layout
    /* eslint-enable @stylistic/semi */
    const view = new DataView(index.buffer);
    for (let i = 0; i < records.length; ++i) {
        const {packedOffset, packedLength, compressionMethod, uncompressedLength, signature} = records[i];
        if (
            !isMediaRange(packedOffset, packedLength, uncompressedLength, compressionMethod, dataBytes) ||
            !Number.isInteger(signature) || signature < 0 || signature > 0xffffffff
        ) {
            return null;
        }
        const row = (ids[i] - firstId) * ROW_BYTES;
        if (view.getUint32(row, true) !== 0) { return null; }
        view.setUint32(row, packedOffset + 1, true);
        view.setUint32(row + 4, packedLength | (compressionMethod === 8 ? DEFLATE_FLAG : 0), true);
        view.setUint32(row + 8, uncompressedLength, true);
        view.setUint32(row + 12, signature, true);
    }
    // Empty slots carry an ID and CRC too. A zeroed or relocated occupied
    // slot cannot masquerade as an ordinary miss under another image ID.
    for (let i = 0; i < slotCount; ++i) {
        const row = i * ROW_BYTES;
        view.setUint32(row + ROW_ID_OFFSET, firstId + i, true);
        view.setUint32(row + ROW_CRC_OFFSET, computeGenerationMediaCrc(index, row, row + ROW_CRC_OFFSET), true);
    }
    return {index, descriptor: {version: 2, prefix, suffix, firstId, slotCount, count: records.length, dataBytes}};
}

/* eslint-disable @stylistic/semi */
/**
 * Reserve a bounded index before ZIP reads. Canonical paths are identified by
 * their shared namespace and IDs; the caller's callback is never retained.
 * The caller supplies each verified payload range exactly once, then seals
 * the index against the actual immutable source span.
 * @param {number} count
 * @param {(index: number) => string} getPath
 * @returns {{write: (index: number, path: string, offset: number, length: number, outputLength: number, method: number, signature: number) => boolean, finish: (dataBytes: number) => GenerationMediaIndex|null}|null}
 */
export function createGenerationMediaIndexWriter(count, getPath) {
    const layout = createGenerationMediaIndexLayout(count, getPath)
    if (layout === null) { return null }
    const {prefix, suffix, ids, firstId, slotCount, index} = layout
    const view = new DataView(index.buffer)
    for (const id of ids) {
        const row = (id - firstId) * ROW_BYTES
        if (view.getUint32(row, true) !== 0) { return null }
        // A reservation rejects duplicate paths before any payload is read.
        view.setUint32(row, 1, true)
    }
    let written = 0
    let end = 0
    let settled = false
    return {
        write(i, path, offset, length, outputLength, method, signature) {
            if (settled || !Number.isInteger(i) || i < 0 || i >= count ||
            !isMediaRange(offset, length, outputLength, method, MAX_DATA_BYTES) ||
            !Number.isInteger(signature) || signature < 0 || signature > 0xffffffff ||
            typeof path !== 'string' || getPathId(path, prefix, suffix) !== ids[i]) {
                settled = true
                return false
            }
            const row = (ids[i] - firstId) * ROW_BYTES
            // CRC slots are private completion markers until finish seals all
            // occupied and empty rows with their final identity and checksum.
            if (view.getUint32(row + ROW_CRC_OFFSET, true) !== 0) {
                settled = true
                return false
            }
            view.setUint32(row, offset + 1, true)
            view.setUint32(row + 4, length | (method === 8 ? DEFLATE_FLAG : 0), true)
            view.setUint32(row + 8, outputLength, true)
            view.setUint32(row + 12, signature, true)
            view.setUint32(row + ROW_CRC_OFFSET, 1, true)
            end = Math.max(end, offset + length)
            ++written
            return true
        },
        finish(dataBytes) {
            if (settled) { return null }
            settled = true
            if (written !== count || !Number.isSafeInteger(dataBytes) || dataBytes < end || dataBytes <= 0 || dataBytes > MAX_DATA_BYTES) { return null }
            for (let i = 0; i < slotCount; ++i) {
                const row = i * ROW_BYTES
                view.setUint32(row + ROW_ID_OFFSET, firstId + i, true)
                view.setUint32(row + ROW_CRC_OFFSET, computeGenerationMediaCrc(index, row, row + ROW_CRC_OFFSET), true)
            }
            return {index, descriptor: {version: 2, prefix, suffix, firstId, slotCount, count, dataBytes}}
        },
    }
}

/**
 * @param {number} count
 * @param {(index: number) => string} getPath
 * @returns {{prefix: string, suffix: string, ids: Uint32Array<ArrayBuffer>, firstId: number, slotCount: number, index: Uint8Array<ArrayBuffer>}|null}
 */
function createGenerationMediaIndexLayout(count, getPath) {
    if (!Number.isInteger(count) || count <= 0 || count > MAX_ROWS) { return null }
    const match = /^(.*[^0-9])([1-9][0-9]*)(\.[A-Za-z0-9]+)$/.exec(getPath(0))
    if (match === null) { return null }
    const [, prefix, , suffix] = match
    if (prefix.length > 128 || !isPrintableAscii(prefix) || suffix.length > 16 || getImageMediaTypeFromFileName(getPath(0)) === null) { return null }
    const ids = new Uint32Array(count)
    let firstId = Infinity
    let lastId = 0
    for (let i = 0; i < count; ++i) {
        const id = getPathId(getPath(i), prefix, suffix)
        if (id === null || id > 0xffffffff) { return null }
        ids[i] = id
        firstId = Math.min(firstId, id)
        lastId = Math.max(lastId, id)
    }
    const slotCount = lastId - firstId + 1
    if (slotCount > Math.min(MAX_ROWS, count * 1.25)) { return null }
    return {prefix, suffix, ids, firstId, slotCount, index: new Uint8Array(slotCount * ROW_BYTES)}
}
/* eslint-enable @stylistic/semi */

/**
 * Restrict a worker's verified index to the actual glossary references. Keep
 * the same slot range and its validated holes. Only dropped occupied slots
 * need their empty marker checksum recomputed.
 * @param {GenerationMediaIndex} plan
 * @param {Iterable<string>} paths
 * @returns {GenerationMediaIndex|null}
 */
export function restrictGenerationMediaIndex({descriptor, index}, paths) {
    if (!isGenerationMediaDescriptor(descriptor) || index.length !== descriptor.slotCount * ROW_BYTES) { return null; }
    const source = new DataView(index.buffer, index.byteOffset, index.byteLength);
    const keep = new Uint8Array(descriptor.slotCount);
    let count = 0;
    for (const path of paths) {
        const id = getPathId(path, descriptor.prefix, descriptor.suffix);
        if (id === null || id < descriptor.firstId || id >= descriptor.firstId + descriptor.slotCount) { return null; }
        const slot = id - descriptor.firstId;
        const row = slot * ROW_BYTES;
        if (source.getUint32(row, true) === 0 || keep[slot] !== 0 || source.getUint32(row + ROW_ID_OFFSET, true) !== id) { return null; }
        keep[slot] = 1;
        ++count;
    }
    if (count === 0 || count > descriptor.count) { return null; }
    const selected = new Uint8Array(index);
    const target = new DataView(selected.buffer);
    for (let slot = 0; slot < keep.length; ++slot) {
        const row = slot * ROW_BYTES;
        if (keep[slot] !== 0 || target.getUint32(row, true) === 0) { continue; }
        selected.fill(0, row, row + ROW_ID_OFFSET);
        target.setUint32(row + ROW_CRC_OFFSET, computeGenerationMediaCrc(selected, row, row + ROW_CRC_OFFSET), true);
    }
    return {descriptor: {...descriptor, count}, index: selected};
}

/**
 * @param {unknown} value
 * @returns {value is GenerationMediaDescriptor}
 */
export function isGenerationMediaDescriptor(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) { return false; }
    const descriptor = /** @type {Partial<GenerationMediaDescriptor>} */ (value);
    const {version, prefix, suffix, firstId, slotCount, count, dataBytes} = descriptor;
    return version === 2 &&
    typeof prefix === 'string' && prefix.length > 0 && prefix.length <= 128 && isPrintableAscii(prefix) &&
    typeof suffix === 'string' && suffix.length >= 2 && suffix.length <= 16 &&
    /^\.[A-Za-z0-9]+$/.test(suffix) && getImageMediaTypeFromFileName(prefix + '1' + suffix) !== null &&
    typeof firstId === 'number' && Number.isInteger(firstId) && firstId > 0 &&
    typeof slotCount === 'number' && Number.isInteger(slotCount) && slotCount > 0 && slotCount <= MAX_ROWS &&
    firstId + slotCount - 1 <= 0xffffffff &&
    typeof count === 'number' && Number.isInteger(count) && count > 0 && count <= slotCount &&
    typeof dataBytes === 'number' && Number.isInteger(dataBytes) && dataBytes > 0 && dataBytes <= MAX_DATA_BYTES;
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isPrintableAscii(value) {
    for (let i = 0; i < value.length; ++i) {
        const code = value.charCodeAt(i);
        if (code < 0x20 || code > 0x7e) { return false; }
    }
    return true;
}

/**
 * Encode only the format-owned fields in a fixed order. The SQLite summary
 * supplies the expected descriptor and generation on every open.
 * @param {GenerationMediaDescriptor} descriptor
 * @returns {string}
 */
export function encodeGenerationMediaDescriptor({version, prefix, suffix, firstId, slotCount, count, dataBytes}) {
    return JSON.stringify([version, prefix, suffix, firstId, slotCount, count, dataBytes]);
}

/**
 * @param {string} generationId
 * @param {string} descriptorKey
 * @returns {Uint8Array<ArrayBuffer>}
 * @throws {Error} If the identity exceeds the fixed header size.
 */
function createHeader(generationId, descriptorKey) {
    const header = new Uint8Array(HEADER_BYTES);
    header.set(HEADER_MAGIC);
    const identity = new TextEncoder().encode(generationId + descriptorKey);
    const metadataOffset = HEADER_MAGIC.byteLength + 4;
    if (identity.length > HEADER_BYTES - metadataOffset) { throw new Error('Generation media header is too long'); }
    new DataView(header.buffer).setUint32(HEADER_MAGIC.byteLength, identity.length, true);
    header.set(identity, metadataOffset);
    return header;
}

/**
 * @param {string} path
 * @param {string} prefix
 * @param {string} suffix
 * @returns {number|null}
 */
function getPathId(path, prefix, suffix) {
    if (!path.startsWith(prefix) || !path.endsWith(suffix)) { return null; }
    const digits = path.slice(prefix.length, -suffix.length);
    const id = Number(digits);
    return Number.isSafeInteger(id) && id > 0 && String(id) === digits ? id : null;
}

/**
 * @param {number} offset
 * @param {number} length
 * @param {number} outputLength
 * @param {number} method
 * @param {number} dataBytes
 * @returns {boolean}
 */
function isMediaRange(offset, length, outputLength, method, dataBytes) {
    return Number.isSafeInteger(offset) && offset >= 0 &&
    Number.isSafeInteger(length) && length > 0 && length <= MAX_CONTENT_BYTES && offset <= dataBytes - length &&
    Number.isSafeInteger(outputLength) && outputLength > 0 && outputLength <= MAX_CONTENT_BYTES &&
    (method === 8 || (method === 0 && length === outputLength));
}

const crcTable = Uint32Array.from({length: 256}, (_, byte) => {
    let value = byte;
    for (let bit = 0; bit < 8; ++bit) {
        value = (value >>> 1) ^ ((value & 1) === 0 ? 0 : 0xedb88320);
    }
    return value;
});

/**
 * @param {Uint8Array} bytes
 * @param {number} [start]
 * @param {number} [end]
 * @returns {number}
 */
export function computeGenerationMediaCrc(bytes, start = 0, end = bytes.length) {
    let crc = 0xffffffff;
    for (let i = start; i < end; ++i) { crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 0xff]; }
    return (~crc) >>> 0;
}

/** Media data and its fixed-width path index are immutable after publication. */
export class DictionaryGenerationMediaStore {
    constructor() {
        /** @type {Map<string, {descriptorKey: string, promise: Promise<File>}>} */
        this._files = new Map();
    }

    /** @returns {boolean} */
    static supportsWrite() {
        return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function' &&
        typeof FileSystemFileHandle !== 'undefined' && typeof FileSystemFileHandle.prototype.createWritable === 'function';
    }

    /**
     * @param {string} generationId
     * @param {Blob} blob
     * @param {GenerationMediaIndex} plan
     */
    async write(generationId, blob, {descriptor, index}) {
        if (
            !GENERATION_ID.test(generationId) ||
            !isGenerationMediaDescriptor(descriptor) ||
            blob.size !== descriptor.dataBytes ||
            index.byteLength !== descriptor.slotCount * ROW_BYTES
        ) {
            throw new Error('Invalid generation media publication');
        }
        const descriptorKey = encodeGenerationMediaDescriptor(descriptor);
        const header = createHeader(generationId, descriptorKey);
        const packed = new Blob([header, index, blob]);
        const directory = await this._getDirectory(true);
        if (directory === null) { throw new Error('Dictionary media requires OPFS'); }
        const handle = await directory.getFileHandle(generationId + '.bin', {create: true});
        const writable = await handle.createWritable();
        try {
            // Keep the original source span as a Blob. Copy it through OPFS
            // without first allocating an archive-sized JS ArrayBuffer.
            await writable.write(packed);
            await writable.close();
        } catch (error) {
            try {
                await writable.abort(error);
            } catch (abortError) {
                throw new AggregateError([error, abortError], 'Generation media write and abort failed');
            }
            throw error;
        }
        await this._validateFile(await handle.getFile(), generationId, descriptor, descriptorKey);
    }

    /**
     * Settle the selection gate even when the source pipeline never picks an
     * index. The database owns cancellation, joining, and unlinking this file.
     * @param {string} generationId
     * @param {Blob} blob
     * @param {GenerationMediaIndex} plan
     * @returns {StagedGenerationMediaWrite}
     * @throws {Error} If the initial payload layout does not match the descriptor.
     */
    stage(generationId, blob, {descriptor, index}) {
        if (
            !GENERATION_ID.test(generationId) || !isGenerationMediaDescriptor(descriptor) ||
            blob.size !== descriptor.dataBytes || index.byteLength !== descriptor.slotCount * ROW_BYTES
        ) {
            throw new Error('Invalid generation media staging geometry');
        }
        const geometry = {...descriptor};
        const payloadOffset = HEADER_BYTES + geometry.slotCount * ROW_BYTES;
        const selection = /** @type {import('core').DeferredPromiseDetails<GenerationMediaPrefix|null>} */ (deferPromise());
        let cancelled = false;
        let selected = false;
        // The caller can register the operation under its journal before any
        // OPFS request starts.
        const promise = Promise.resolve().then(async () => await this._writeStaged(generationId, blob, payloadOffset, selection.promise, () => cancelled));
        const select = (/** @type {GenerationMediaIndex} */ plan) => {
            if (selected || cancelled) { throw new Error('Generation media staging is already settled'); }
            const next = plan.descriptor;
            if (
                !isGenerationMediaDescriptor(next) ||
                next.version !== geometry.version ||
                next.prefix !== geometry.prefix ||
                next.suffix !== geometry.suffix ||
                next.firstId !== geometry.firstId ||
                next.slotCount !== geometry.slotCount ||
                next.count > geometry.count ||
                next.dataBytes !== geometry.dataBytes ||
                plan.index.byteLength !== geometry.slotCount * ROW_BYTES
            ) {
                throw new Error('Selected index does not match staged generation media geometry');
            }
            const descriptorKey = encodeGenerationMediaDescriptor(next);
            const prefix = new Blob([createHeader(generationId, descriptorKey), plan.index]);
            selected = true;
            selection.resolve({descriptor: {...next}, descriptorKey, prefix});
            return descriptorKey;
        };
        return {
            promise,
            select,
            cancel: () => {
                cancelled = true;
                selection.resolve(null);
            },
        };
    }

    /**
     * Use one writable and write the source span once. Keeping the writable
     * open lets the checked index patch avoid copying the large temporary file.
     * @param {string} generationId
     * @param {Blob} blob
     * @param {number} payloadOffset
     * @param {Promise<GenerationMediaPrefix|null>} selection
     * @param {() => boolean} isCancelled
     */
    async _writeStaged(generationId, blob, payloadOffset, selection, isCancelled) {
        if (isCancelled()) { return; }
        const directory = await this._getDirectory(true);
        if (isCancelled()) { return; }
        if (directory === null) { throw new Error('Dictionary media requires OPFS'); }
        const handle = await directory.getFileHandle(generationId + '.bin', {create: true});
        if (isCancelled()) { return; }
        const writable = await handle.createWritable();
        let closed = false;
        try {
            if (isCancelled()) { return; }
            await writable.write({type: 'write', position: payloadOffset, data: blob});
            if (isCancelled()) { return; }
            const selected = await selection;
            if (selected === null || isCancelled()) { return; }
            await writable.write({type: 'write', position: 0, data: selected.prefix});
            if (isCancelled()) { return; }
            await writable.close();
            closed = true;
            await this._validateFile(await handle.getFile(), generationId, selected.descriptor, selected.descriptorKey);
        } catch (error) {
            if (!closed) {
                closed = true;
                try {
                    await writable.abort(error);
                } catch (abortError) {
                    throw new AggregateError([error, abortError], 'Staged generation media write and abort failed');
                }
            }
            throw error;
        } finally {
            if (!closed) { await writable.abort(); }
        }
    }

    /**
     * @param {string} generationId
     * @param {GenerationMediaDescriptor} descriptor
     * @param {string} path
     * @returns {Promise<{content: ArrayBuffer, method: 0|8, outputLength: number, signature: number}|null>}
     */
    async read(generationId, descriptor, path) {
        if (!GENERATION_ID.test(generationId)) { return null; }
        const id = getPathId(path, descriptor.prefix, descriptor.suffix);
        if (id === null || id < descriptor.firstId || id >= descriptor.firstId + descriptor.slotCount) { return null; }
        const filePromise = this._getFile(generationId, descriptor);
        try {
            const file = await filePromise;
            const indexBytes = descriptor.slotCount * ROW_BYTES;
            const rowStart = HEADER_BYTES + (id - descriptor.firstId) * ROW_BYTES;
            const rowBytes = await file.slice(rowStart, rowStart + ROW_BYTES).arrayBuffer();
            if (rowBytes.byteLength !== ROW_BYTES) { throw new Error('Generation media index row length mismatch'); }
            const row = new DataView(rowBytes);
            if (
                row.getUint32(ROW_ID_OFFSET, true) !== id ||
                row.getUint32(ROW_CRC_OFFSET, true) !== computeGenerationMediaCrc(new Uint8Array(rowBytes), 0, ROW_CRC_OFFSET)
            ) {
                throw new Error('Generation media index row identity mismatch');
            }
            const offset = row.getUint32(0, true);
            const flagsAndLength = row.getUint32(4, true);
            const outputLength = row.getUint32(8, true);
            const signature = row.getUint32(12, true);
            if (offset === 0) {
                if (flagsAndLength !== 0 || outputLength !== 0 || signature !== 0) {
                    throw new Error('Generation media empty slot has payload metadata');
                }
                return null;
            }
            const length = flagsAndLength & ~DEFLATE_FLAG;
            const method = (flagsAndLength & DEFLATE_FLAG) === 0 ? 0 : 8;
            if (!isMediaRange(offset - 1, length, outputLength, method, descriptor.dataBytes)) {
                throw new Error('Generation media index points outside its data');
            }
            const start = HEADER_BYTES + indexBytes + offset - 1;
            const content = await file.slice(start, start + length).arrayBuffer();
            if (content.byteLength !== length) { throw new Error('Generation media payload length mismatch'); }
            return {content, method, outputLength, signature};
        } catch (error) {
            // A File snapshot can become unreadable even when the directory
            // and generation are intact. Allow a later request to reopen it.
            if (this._files.get(generationId)?.promise === filePromise) { this._files.delete(generationId); }
            throw error;
        }
    }

    /**
     * Inspect only the small header. The first lookup can reuse this already
     * validated immutable File without reading the whole index.
     * @param {string} generationId
     * @param {GenerationMediaDescriptor} descriptor
     */
    async inspect(generationId, descriptor) {
        await this._getFile(generationId, descriptor);
    }

    /**
     *
     */
    clearReadSnapshots() {
        this._files.clear();
    }

    /**
     * @param {string} generationId
     * @param {GenerationMediaDescriptor} descriptor
     * @returns {Promise<File>}
     */
    _getFile(generationId, descriptor) {
        if (!GENERATION_ID.test(generationId) || !isGenerationMediaDescriptor(descriptor)) {
            return Promise.reject(new Error('Invalid generation media identity'));
        }
        const descriptorKey = encodeGenerationMediaDescriptor(descriptor);
        const previous = this._files.get(generationId);
        if (previous?.descriptorKey === descriptorKey) { return previous.promise; }
        const promise = this._openFile(generationId, descriptor, descriptorKey);
        const snapshot = {descriptorKey, promise};
        this._files.set(generationId, snapshot);
        void promise.catch(() => {
            if (this._files.get(generationId) === snapshot) { this._files.delete(generationId); }
        });
        return promise;
    }

    /**
     * @param {string} generationId
     * @param {GenerationMediaDescriptor} descriptor
     * @param {string} descriptorKey
     * @returns {Promise<File>}
     */
    async _openFile(generationId, descriptor, descriptorKey) {
        const directory = await this._getDirectory(false);
        if (directory === null) { throw new Error('Missing generation media directory'); }
        const file = await (await directory.getFileHandle(generationId + '.bin')).getFile();
        await this._validateFile(file, generationId, descriptor, descriptorKey);
        return file;
    }

    /**
     * @param {File} file
     * @param {string} generationId
     * @param {GenerationMediaDescriptor} descriptor
     * @param {string} descriptorKey
     */
    async _validateFile(file, generationId, descriptor, descriptorKey) {
        if (file.size !== HEADER_BYTES + descriptor.slotCount * ROW_BYTES + descriptor.dataBytes) {
            throw new Error('Generation media file length mismatch');
        }
        const header = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer());
        const expected = createHeader(generationId, descriptorKey);
        if (header.byteLength !== HEADER_BYTES || expected.some((byte, i) => byte !== header[i])) {
            throw new Error('Generation media file identity mismatch');
        }
    }

    /** @param {string} generationId */
    async remove(generationId) {
        if (!GENERATION_ID.test(generationId)) { return; }
        this._files.delete(generationId);
        const directory = await this._getDirectory(false);
        if (directory === null) { return; }
        try {
            await directory.removeEntry(generationId + '.bin');
        } catch (error) {
            if (!isNotFound(error)) { throw error; }
        }
    }

    /** @param {Set<string>} referencedGenerations */
    async removeOrphans(referencedGenerations) {
        const directory = await this._getDirectory(false);
        if (directory === null) { return; }
        const entriesMethod = /** @type {unknown} */ (Reflect.get(directory, 'entries'));
        if (typeof entriesMethod !== 'function') { return; }
        const entries = /** @type {() => AsyncIterable<[string, FileSystemHandle]>} */ (entriesMethod).call(directory);
        for await (const [name, entry] of entries) {
            const match = PACK_FILE_PATTERN.exec(name);
            if (
                entry.kind !== 'file' || match === null || !GENERATION_ID.test(match[1]) ||
                referencedGenerations.has(match[1])
            ) {
                continue;
            }
            try {
                await directory.removeEntry(name);
                this._files.delete(match[1]);
            } catch (error) {
                if (!isNotFound(error)) { throw error; }
            }
        }
    }

    /**
     *
     */
    async reset() {
        this._files.clear();
        const directory = await this._getDirectory(false);
        if (directory === null) { return; }
        const root = await this._getRoot();
        if (root === null) { return; }
        try {
            await root.removeEntry(DIRECTORY, {recursive: true});
        } catch (error) {
            if (!isNotFound(error)) { throw error; }
        }
    }

    /**
     * @param {boolean} create
     * @returns {Promise<FileSystemDirectoryHandle|null>}
     */
    async _getDirectory(create) {
        const root = await this._getRoot();
        if (root === null || typeof root.getDirectoryHandle !== 'function') { return null; }
        try {
            return await root.getDirectoryHandle(DIRECTORY, {create});
        } catch (error) {
            if (!isNotFound(error) || create) { throw error; }
            return null;
        }
    }

    /** @returns {Promise<FileSystemDirectoryHandle|null>} */
    async _getRoot() {
        if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') { return null; }
        return await navigator.storage.getDirectory();
    }
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isNotFound(error) {
    return typeof error === 'object' && error !== null && Reflect.get(error, 'name') === 'NotFoundError';
}
