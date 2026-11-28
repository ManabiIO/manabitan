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
/* eslint @stylistic/semi: ["error", "never"] */

import {createDenseZipFilenameDecoder} from './dense-zip-filenames.js'

const METADATA_WORDS = 6

/**
 * Compact storage for a completely validated dense ZIP directory. Enumerating
 * names does not create entry objects or filename views for unused media.
 * @implements {Iterable<[string, import('dictionary-importer').ImportFileEntry]>}
 */
export class DenseZipFileMap {
    /**
     * @param {number} count
     * @param {Uint8Array} filenames
     * @param {import('./dense-zip-directory.js').DenseZipEntryReader} getData
     */
    constructor(count, filenames, getData) {
        /** @type {Map<string, number|import('dictionary-importer').ImportFileEntry>} */
        this._entries = new Map()
        /** @type {Uint32Array} */
        this._metadata = new Uint32Array(count * METADATA_WORDS)
        /** @type {Uint8Array} */
        this._filenames = filenames
        /** @type {number} */
        this._pendingEntryCount = count
        /** @type {import('./dense-zip-directory.js').DenseZipEntryReader|null} */
        this._getData = getData
    }

    /** @returns {number} */
    get size() { return this._entries.size }

    /**
     * Used only while the directory reader validates and fills this catalog.
     * Duplicate names are reported after all directory checks have completed.
     * @param {number} row
     * @param {number} filenameOffset
     * @param {number} offset
     * @param {number} compressedSize
     * @param {number} uncompressedSize
     * @param {0|8} compressionMethod
     * @param {number} signature
     */
    addDirectoryMetadata(row, filenameOffset, offset, compressedSize, uncompressedSize, compressionMethod, signature) {
        const base = row * METADATA_WORDS
        this._metadata[base] = offset
        this._metadata[base + 1] = compressedSize
        this._metadata[base + 2] = uncompressedSize
        this._metadata[base + 3] = compressionMethod
        this._metadata[base + 4] = signature
        this._metadata[base + 5] = filenameOffset
    }

    /**
     * Decode admitted ASCII names in bounded windows after all directory
     * geometry has passed validation. ASCII byte and string offsets match.
     * @returns {string|null} First duplicate filename, if any.
     */
    finishDirectory() {
        const decodeFilename = createDenseZipFilenameDecoder(this._filenames)
        for (let row = 0; row < this._pendingEntryCount; ++row) {
            const base = row * METADATA_WORDS
            const filenameStart = this._metadata[base + 5]
            const filenameEnd = row + 1 < this._pendingEntryCount ? this._metadata[base + METADATA_WORDS + 5] : this._filenames.length
            const filename = decodeFilename(filenameStart, filenameEnd)
            this._entries.set(filename, row)
            if (this._entries.size !== row + 1) { return filename }
        }
        return null
    }

    /**
     * @param {string} key
     * @returns {import('dictionary-importer').ImportFileEntry|undefined}
     * @throws {Error} If a cleared catalog still refers to compact metadata.
     */
    get(key) {
        const value = this._entries.get(key)
        if (typeof value !== 'number') { return value }
        const getData = this._getData
        if (getData === null) { throw new Error('Dense ZIP catalog has been cleared') }
        const base = value * METADATA_WORDS
        const filenameOffset = this._metadata[base + 5]
        const entry = /** @type {import('@zip.js/zip.js').Entry} */ (/** @type {unknown} */ ({
            filename: key,
            rawFilename: this._filenames.subarray(filenameOffset, filenameOffset + key.length),
            offset: this._metadata[base],
            compressedSize: this._metadata[base + 1],
            uncompressedSize: this._metadata[base + 2],
            compressionMethod: this._metadata[base + 3],
            signature: this._metadata[base + 4],
            encrypted: false,
            directory: false,
            getData,
        }))
        this._entries.set(key, entry)
        this._releaseMaterializedEntry()
        return entry
    }

    /**
     * @param {string} key
     * @returns {boolean}
     */
    has(key) { return this._entries.has(key) }

    /**
     * Only untouched checked directory slots can skip entry materialization.
     * Obtained or replaced entries may have acquired inline bytes or mutations.
     * @param {string} key
     * @returns {boolean}
     */
    hasUnmaterializedEntry(key) { return typeof this._entries.get(key) === 'number' }

    /**
     * @param {string} key
     * @param {import('dictionary-importer').ImportFileEntry} value
     * @returns {this}
     */
    set(key, value) {
        if (typeof this._entries.get(key) === 'number') { this._releaseMaterializedEntry() }
        this._entries.set(key, value)
        return this
    }

    /**
     * @param {string} key
     * @returns {boolean}
     */
    delete(key) {
        const value = this._entries.get(key)
        if (!this._entries.delete(key)) { return false }
        if (typeof value === 'number') { this._releaseMaterializedEntry() }
        return true
    }

    /** Release both compact metadata and the reader's archive ownership. */
    clear() {
        this._entries.clear()
        this._pendingEntryCount = 0
        this._releaseCompactData()
    }

    /** Drop the compact copy when fallback consumers have opened every member. */
    _releaseMaterializedEntry() {
        if (--this._pendingEntryCount === 0) { this._releaseCompactData() }
    }

    /** */
    _releaseCompactData() {
        this._metadata = new Uint32Array(0)
        this._filenames = new Uint8Array(0)
        this._getData = null
    }

    /** @returns {MapIterator<string>} */
    keys() { return this._entries.keys() }

    /** @returns {Generator<[string, import('dictionary-importer').ImportFileEntry], void, unknown>} */
    *entries() {
        for (const key of this._entries.keys()) {
            yield [key, /** @type {import('dictionary-importer').ImportFileEntry} */ (this.get(key))]
        }
    }

    /** @returns {Generator<import('dictionary-importer').ImportFileEntry, void, unknown>} */
    *values() {
        for (const key of this._entries.keys()) {
            yield /** @type {import('dictionary-importer').ImportFileEntry} */ (this.get(key))
        }
    }

    /** @returns {Generator<[string, import('dictionary-importer').ImportFileEntry], void, unknown>} */
    [Symbol.iterator]() { return this.entries() }

    /**
     * @param {(this: unknown, value: import('dictionary-importer').ImportFileEntry, key: string, map: DenseZipFileMap) => void} callback
     * @param {unknown} [thisArg]
     */
    forEach(callback, thisArg) {
        for (const [key, value] of this.entries()) { callback.call(thisArg, value, key, this) }
    }
}

/**
 * A checked, physically ordered directory for sequential payload consumers.
 * Keep numeric metadata compact until a bounded read batch needs entry objects.
 */
export class DenseZipEntryCatalog {
    /**
     * @param {number} count
     * @param {Uint8Array} filenames
     */
    constructor(count, filenames) {
        /** @type {Uint32Array} */
        this._metadata = new Uint32Array(count * METADATA_WORDS)
        /** @type {Uint8Array} */
        this._filenames = filenames
        /** @type {string[]} */
        this._names = []
        this._names.length = count
    }

    /** @returns {number} */
    get length() { return this._names.length }

    /**
     * Used only while the directory reader validates and fills this catalog.
     * @param {number} row
     * @param {number} filenameOffset
     * @param {number} offset
     * @param {number} compressedSize
     * @param {number} uncompressedSize
     * @param {0|8} compressionMethod
     * @param {number} signature
     */
    // eslint-disable-next-line sonarjs/no-identical-functions -- Separate catalogs share the validated layout without a per-row adapter.
    addDirectoryMetadata(row, filenameOffset, offset, compressedSize, uncompressedSize, compressionMethod, signature) {
        const base = row * METADATA_WORDS
        this._metadata[base] = offset
        this._metadata[base + 1] = compressedSize
        this._metadata[base + 2] = uncompressedSize
        this._metadata[base + 3] = compressionMethod
        this._metadata[base + 4] = signature
        this._metadata[base + 5] = filenameOffset
    }

    /** Decode names only after the complete directory has passed validation. */
    finishDirectory() {
        const decodeFilename = createDenseZipFilenameDecoder(this._filenames)
        for (let row = 0; row < this.length; ++row) {
            const start = this._metadata[row * METADATA_WORDS + 5]
            const end = row + 1 < this.length ? this._metadata[(row + 1) * METADATA_WORDS + 5] : this._filenames.length
            this._names[row] = decodeFilename(start, end)
        }
    }

    /**
     * Compact the selected rows in place without creating entries or an index
     * array. Stable order preserves the directory's checked physical order.
     * @param {(filename: string) => boolean} predicate
     */
    selectFilenames(predicate) {
        let selected = 0
        for (let row = 0; row < this.length; ++row) {
            const filename = this._names[row]
            if (!predicate(filename)) { continue }
            if (selected !== row) {
                this._names[selected] = filename
                const source = row * METADATA_WORDS
                this._metadata.copyWithin(selected * METADATA_WORDS, source, source + METADATA_WORDS)
            }
            ++selected
        }
        this._names.length = selected
    }

    /**
     * @param {number} row
     * @returns {string}
     */
    filenameAt(row) { return this._names[row] }

    /**
     * @param {number} row
     * @returns {number}
     */
    offsetAt(row) { return this._metadata[row * METADATA_WORDS] }

    /**
     * @param {number} row
     * @returns {number}
     */
    compressedSizeAt(row) { return this._metadata[row * METADATA_WORDS + 1] }

    /**
     * @param {number} row
     * @returns {number}
     */
    uncompressedSizeAt(row) { return this._metadata[row * METADATA_WORDS + 2] }

    /**
     * @param {number} row
     * @returns {0|8}
     */
    compressionMethodAt(row) { return /** @type {0|8} */ (this._metadata[row * METADATA_WORDS + 3]) }

    /**
     * Check the raw pathname without constructing a filename view per member.
     * @param {number} row
     * @param {string} filename
     * @returns {boolean}
     */
    hasExactRawFilename(row, filename) {
        const start = this._metadata[row * METADATA_WORDS + 5]
        if (filename !== this._names[row] || filename.length > 0xffff || start + filename.length > this._filenames.length) { return false }
        for (let i = 0; i < filename.length; ++i) {
            const value = this._filenames[start + i]
            if (value > 0x7f || value !== filename.charCodeAt(i)) { return false }
        }
        return true
    }

    /**
     * Materialize only the caller's current read batch. The catalog retains no
     * reference to these entries or their filename views after the read ends.
     * @param {number} start
     * @param {number} end
     * @returns {import('./dense-zip-directory.js').DenseZipEntry[]}
     */
    getEntries(start, end) {
        /** @type {import('./dense-zip-directory.js').DenseZipEntry[]} */
        const entries = []
        for (let row = start; row < end; ++row) {
            const base = row * METADATA_WORDS
            const filename = this._names[row]
            const filenameOffset = this._metadata[base + 5]
            entries.push({
                filename,
                rawFilename: this._filenames.subarray(filenameOffset, filenameOffset + filename.length),
                offset: this._metadata[base],
                compressedSize: this._metadata[base + 1],
                uncompressedSize: this._metadata[base + 2],
                compressionMethod: /** @type {0|8} */ (this._metadata[base + 3]),
                signature: this._metadata[base + 4],
                encrypted: false,
                directory: false,
            })
        }
        return entries
    }
}
