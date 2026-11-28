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

const OPTIMIZER_DIRECTORY = 'manabitan-online-content-v1';
const ARENA_DIRECTORY = 'manabitan-term-content-arenas-v1';
const LEGACY_FILE_NAME = 'manabitan-term-content.bin';
const LEGACY_SEGMENT_PREFIX = 'manabitan-term-content^';
const MAX_FILE_BYTES = 2 ** 40;
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const PAGE_BYTES = 64 * 1024;
const MAX_SNAPSHOTS = 32;
const MAX_PAGES = 128;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

/** @typedef {{fileId: string, path: string, byteLength: number}} ContentPhysicalFile */
/** @typedef {{fileId: string, path: string, byteLength: number, kind: 'legacy'|'arena'|'optimizer', directories: string[], fileName: string}} ContentPhysicalLocator */

/** Confirmed short/truncated bytes from one immutable physical identity. */
export class ContentPhysicalFileIntegrityError extends Error {
    /**
     * @param {string} message
     * @param {ContentPhysicalFile} file
     */
    constructor(message, file) {
        super(message);
        /** @type {string} */
        this.name = 'ContentPhysicalFileIntegrityError';
        /** @type {Readonly<ContentPhysicalFile>} */
        this.physicalFile = Object.freeze({fileId: file.fileId, path: file.path, byteLength: file.byteLength});
    }
}

/**
 * Parses only the three content-store namespaces. A file ID is an immutable
 * catalog identity, not necessarily a filename: original files stay in their
 * legacy location and sealed import arenas stay in their owned directory.
 * Logical addresses always come from the published layout, never this path.
 * @param {ContentPhysicalFile} file
 * @returns {ContentPhysicalLocator}
 * @throws {TypeError} If the locator is outside the immutable content namespaces.
 */
export function parseContentPhysicalFile(file) {
    if (!file || typeof file !== 'object' || typeof file.fileId !== 'string' || !IDENTIFIER.test(file.fileId) ||
    typeof file.path !== 'string' || file.path.length > 384 ||
    !Number.isSafeInteger(file.byteLength) || file.byteLength < 0 || file.byteLength > MAX_FILE_BYTES) {
        throw new TypeError('Invalid immutable content file observation');
    }
    const parts = file.path.split('/');
    /** @type {ContentPhysicalLocator['kind']} */
    let kind;
    if (parts.length === 1 && isLegacyFileName(parts[0])) {
        kind = 'legacy';
    } else if (parts.length === 2 && parts[0] === OPTIMIZER_DIRECTORY && parts[1] === file.fileId + '.bin') {
        kind = 'optimizer';
    } else if (parts.length === 3 && parts[0] === ARENA_DIRECTORY && IDENTIFIER.test(parts[1]) && isLegacyFileName(parts[2])) {
        kind = 'arena';
    } else {
        throw new TypeError('Immutable content file path is outside its owned namespace');
    }
    return {fileId: file.fileId,
        path: file.path,
        byteLength: file.byteLength,
        kind,
        directories: parts.slice(0, -1),
        fileName: parts[parts.length - 1]};
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function isLegacyFileName(name) {
    if (name === LEGACY_FILE_NAME) { return true; }
    if (!name.startsWith(LEGACY_SEGMENT_PREFIX) || !name.endsWith('.bin')) { return false; }
    const ordinal = name.slice(LEGACY_SEGMENT_PREFIX.length, -4);
    const value = Number(ordinal);
    return /^[1-9][0-9]*$/.test(ordinal) && Number.isSafeInteger(value) && value > 0 && String(value) === ordinal;
}

/**
 * Read/removal adapter for cataloged immutable files. This class never creates
 * files, scans inventories, hashes whole packs, or supplies legacy fallbacks.
 * The sole SQL owner validates active/staged/recovery/lease closure before GC.
 */
export class TermContentPhysicalFileStore {
    constructor() {
        /** @type {Map<string, {locator: ContentPhysicalLocator, observed: File|null, promise: Promise<File>}>} */
        this._snapshots = new Map();
        /** @type {Map<string, {fileKey: string, snapshot: File, promise: Promise<Uint8Array>}>} */
        this._pages = new Map();
    }

    /**
     * @param {ContentPhysicalFile} file
     * @param {number} offset
     * @param {number} length
     * @returns {Promise<Uint8Array>}
     */
    async readSlice(file, offset, length) {
        const locator = parseContentPhysicalFile(file);
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 ||
        length > MAX_CHUNK_BYTES || offset > locator.byteLength - length) {
            throw new RangeError('Immutable content read is outside its observed file or chunk bound');
        }
        if (length === 0) { return new Uint8Array(0); }
        const fileKey = JSON.stringify([locator.fileId, locator.path, locator.byteLength]);
        const snapshot = await this._getSnapshot(fileKey, locator);
        if (length > PAGE_BYTES) { return await this._readObservedRange(snapshot, locator, offset, length); }
        const result = new Uint8Array(length);
        let copied = 0;
        while (copied < length) {
            const position = offset + copied;
            const pageOffset = Math.floor(position / PAGE_BYTES) * PAGE_BYTES;
            const page = await this._getPage(fileKey, snapshot, locator, pageOffset);
            const inPage = position - pageOffset;
            const count = Math.min(length - copied, page.byteLength - inPage);
            result.set(page.subarray(inPage, inPage + count), copied);
            copied += count;
        }
        return result;
    }

    /**
     * Streams bounded reads while the caller retains the physical root lease.
     * @param {ContentPhysicalFile} file
     * @param {number} [chunkBytes]
     * @returns {AsyncGenerator<Uint8Array>}
     * @yields {Uint8Array} An owned bounded byte range.
     */
    async *readChunks(file, chunkBytes = MAX_CHUNK_BYTES) {
        const locator = parseContentPhysicalFile(file);
        if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes > MAX_CHUNK_BYTES) {
            throw new RangeError('Invalid immutable content chunk bound');
        }
        for (let offset = 0; offset < locator.byteLength; offset += chunkBytes) {
            yield await this.readSlice(locator, offset, Math.min(chunkBytes, locator.byteLength - offset));
        }
    }

    /**
     * Removes exactly one already GC-admitted file. A missing file is returned
     * as an error; only the owner knows whether durable 'deleting' makes that
     * idempotent success. No recursive directory deletion occurs here.
     * @param {ContentPhysicalFile} file
     * @returns {Promise<void>}
     */
    async remove(file) {
        const locator = parseContentPhysicalFile(file);
        // Evict before and after removal. Pending loads from a former file
        // lifetime must never repopulate caches after purge or failed removal.
        this.invalidate(file);
        try {
            const directory = await this._getDirectory(locator);
            await directory.removeEntry(locator.fileName);
        } finally {
            this.invalidate(file);
        }
    }

    /**
     * Evicts one precise catalog identity, or all identities during purge.
     * @param {ContentPhysicalFile|null} [file]
     */
    invalidate(file = null) {
        const key = file === null ? null : JSON.stringify([file.fileId, file.path, file.byteLength]);
        if (key === null) {
            this._snapshots.clear();
        } else {
            this._snapshots.delete(key);
        }
        for (const [pageKey, page] of this._pages) {
            if (key === null || page.fileKey === key) { this._pages.delete(pageKey); }
        }
    }

    /**
     * Single-flight immutable snapshots. The bounded map also fences late
     * completions; rejected loads never become negative cache entries.
     * @param {string} key
     * @param {ContentPhysicalLocator} locator
     * @returns {Promise<File>}
     */
    _getSnapshot(key, locator) {
        const cached = this._snapshots.get(key);
        if (cached) {
            this._snapshots.delete(key);
            this._snapshots.set(key, cached);
            return cached.promise;
        }
        if (this._snapshots.size >= MAX_SNAPSHOTS) {
            const oldest = this._snapshots.keys().next().value;
            if (typeof oldest === 'string') { this._snapshots.delete(oldest); }
        }
        const promise = this._loadSnapshot(locator);
        /** @type {{locator: ContentPhysicalLocator, observed: File|null, promise: Promise<File>}} */
        const entry = {locator, observed: null, promise};
        entry.promise = promise.then((observed) => {
            entry.observed = observed;
            return observed;
        }).catch((error) => {
            if (this._snapshots.get(key) === entry) { this._snapshots.delete(key); }
            throw error;
        });
        this._snapshots.set(key, entry);
        return entry.promise;
    }

    /**
     * @param {ContentPhysicalLocator} locator
     * @returns {Promise<File>}
     */
    async _loadSnapshot(locator) {
        const directory = await this._getDirectory(locator);
        const handle = await directory.getFileHandle(locator.fileName, {create: false});
        const observed = await handle.getFile();
        if (observed.size !== locator.byteLength) {
            throw new ContentPhysicalFileIntegrityError('Immutable content physical file length changed', locator);
        }
        return observed;
    }

    /**
     * Adjacent scalar references share one bounded page read. Successful pages
     * are immutable private bytes; readSlice always returns a separate copy.
     * @param {string} fileKey
     * @param {File} snapshot
     * @param {ContentPhysicalLocator} locator
     * @param {number} offset
     * @returns {Promise<Uint8Array>}
     */
    _getPage(fileKey, snapshot, locator, offset) {
        if (this._snapshots.get(fileKey)?.observed !== snapshot) {
            return this._readObservedRange(snapshot, locator, offset, Math.min(PAGE_BYTES, locator.byteLength - offset));
        }
        const key = JSON.stringify([fileKey, offset]);
        const cached = this._pages.get(key);
        if (cached?.snapshot === snapshot) {
            this._pages.delete(key);
            this._pages.set(key, cached);
            return cached.promise;
        }
        if (this._pages.size >= MAX_PAGES) {
            const oldest = this._pages.keys().next().value;
            if (typeof oldest === 'string') { this._pages.delete(oldest); }
        }
        const entry = {fileKey, snapshot, promise: Promise.resolve(new Uint8Array(0))};
        entry.promise = this._readObservedRange(snapshot, locator, offset, Math.min(PAGE_BYTES, locator.byteLength - offset)).catch((error) => {
            if (this._pages.get(key) === entry) { this._pages.delete(key); }
            throw error;
        });
        this._pages.set(key, entry);
        return entry.promise;
    }

    /**
     * @param {File} observed
     * @param {ContentPhysicalLocator} locator
     * @param {number} offset
     * @param {number} length
     * @returns {Promise<Uint8Array>}
     */
    async _readObservedRange(observed, locator, offset, length) {
        const bytes = new Uint8Array(await observed.slice(offset, offset + length).arrayBuffer());
        if (bytes.byteLength !== length) {
            throw new ContentPhysicalFileIntegrityError('Immutable content physical file returned a short range', locator);
        }
        return bytes;
    }

    /**
     * @param {ContentPhysicalLocator} locator
     * @returns {Promise<FileSystemDirectoryHandle>}
     */
    async _getDirectory(locator) {
        if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') {
            throw new Error('Origin private file storage is unavailable for immutable content');
        }
        let directory = await navigator.storage.getDirectory();
        for (const name of locator.directories) {
            directory = await directory.getDirectoryHandle(name, {create: false});
        }
        return directory;
    }
}
