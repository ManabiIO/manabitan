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

const SEARCH_BYTES = 98;
const LOCAL_HEADER_BYTES = 30;
const DIRECTORY_HEADER_BYTES = 46;
const MAX_ENTRIES = 250_000;
const MIN_ENTRIES = 8192;
const MAX_DIRECTORY_BYTES = 24 * 1024 * 1024;
const MIN_ARCHIVE_BYTES = 128 * 1024 * 1024;
const UINT32_MAX = 0xffffffff;
const decoder = new TextDecoder();

/** @typedef {{filename: string, rawFilename: Uint8Array, offset: number, compressedSize: number, uncompressedSize: number, compressionMethod: 0|8, signature: number, encrypted: false, directory: false}} DenseZipEntry */

/* eslint-disable @stylistic/semi */
/**
 * Keep filename geometry in the catalog instead of retaining one typed-array
 * view per member. ZIP readers borrow a view only while checking a bounded
 * source batch; the original byte arena remains independent of logical names.
 * @implements {DenseZipEntry}
 */
class DenseZipCatalogEntry {
    /** @type {Uint8Array} */
    #filenameBytes
    /** @type {number} */
    #filenameOffset
    /** @type {number} */
    #filenameLength

    /**
     * @param {string} filename
     * @param {Uint8Array} filenameBytes
     * @param {number} filenameOffset
     * @param {number} filenameLength
     * @param {number} offset
     * @param {number} compressedSize
     * @param {number} uncompressedSize
     * @param {0|8} compressionMethod
     * @param {number} signature
     */
    constructor(filename, filenameBytes, filenameOffset, filenameLength, offset, compressedSize, uncompressedSize, compressionMethod, signature) {
        /** @type {string} */
        this.filename = filename
        /** @type {Uint8Array} */
        this.#filenameBytes = filenameBytes
        /** @type {number} */
        this.#filenameOffset = filenameOffset
        /** @type {number} */
        this.#filenameLength = filenameLength
        /** @type {number} */
        this.offset = offset
        /** @type {number} */
        this.compressedSize = compressedSize
        /** @type {number} */
        this.uncompressedSize = uncompressedSize
        /** @type {0|8} */
        this.compressionMethod = compressionMethod
        /** @type {number} */
        this.signature = signature
        /** @type {false} */
        this.encrypted = false
        /** @type {false} */
        this.directory = false
    }

    /** @returns {Uint8Array} */
    get rawFilename() {
        return this.#filenameBytes.subarray(this.#filenameOffset, this.#filenameOffset + this.#filenameLength)
    }

    /**
     * @param {string} filenames Validated printable ASCII, so string and byte offsets agree.
     */
    assignFilename(filenames) {
        this.filename = filenames.slice(this.#filenameOffset, this.#filenameOffset + this.#filenameLength)
    }
}
/* eslint-enable @stylistic/semi */

/**
 * Read a narrow single-disk ZIP directory with plain printable ASCII names.
 * The ordinary reader still handles ZIP variants and all local payload checks.
 * @param {Blob} archive
 * @param {() => void} [checkCancellation]
 * @returns {Promise<DenseZipEntry[]|null>}
 */
export async function readDenseZipDirectory(archive, checkCancellation = () => {}) {
    if (archive.size < MIN_ARCHIVE_BYTES) { return null; }
    const tailStart = archive.size - SEARCH_BYTES;
    checkCancellation();
    const tail = new DataView(await archive.slice(tailStart).arrayBuffer());
    checkCancellation();
    const eocd = tail.byteLength - 22;
    if (
        tail.byteLength !== SEARCH_BYTES ||
        tail.getUint32(eocd, true) !== 0x06054b50 ||
        tail.getUint32(eocd + 4, true) !== 0 ||
        tail.getUint16(eocd + 20, true) !== 0
    ) { return null; }

    let count = tail.getUint16(eocd + 10, true);
    if (tail.getUint16(eocd + 8, true) !== count) { return null; }
    let length = tail.getUint32(eocd + 12, true);
    let offset = tail.getUint32(eocd + 16, true);
    let directoryEnd = tailStart + eocd;
    if (count === 0xffff || offset === UINT32_MAX || length === UINT32_MAX) {
        const locator = eocd - 20;
        const zip64 = locator - 56;
        if (
            tail.getUint32(locator, true) !== 0x07064b50 ||
            tail.getUint32(locator + 4, true) !== 0 ||
            tail.getBigUint64(locator + 8, true) !== BigInt(tailStart + zip64) ||
            tail.getUint32(locator + 16, true) !== 1 ||
            tail.getUint32(zip64, true) !== 0x06064b50 ||
            tail.getBigUint64(zip64 + 4, true) !== 44n ||
            tail.getBigUint64(zip64 + 16, true) !== 0n
        ) { return null; }
        const fullCount = tail.getBigUint64(zip64 + 32, true);
        const fullLength = tail.getBigUint64(zip64 + 40, true);
        const fullOffset = tail.getBigUint64(zip64 + 48, true);
        if (
            tail.getBigUint64(zip64 + 24, true) !== fullCount ||
            (count !== 0xffff && BigInt(count) !== fullCount) ||
            (length !== UINT32_MAX && BigInt(length) !== fullLength) ||
            (offset !== UINT32_MAX && BigInt(offset) !== fullOffset) ||
            fullCount > BigInt(MAX_ENTRIES) ||
            fullLength > BigInt(MAX_DIRECTORY_BYTES) ||
            fullOffset > BigInt(archive.size)
        ) { return null; }
        count = Number(fullCount);
        length = Number(fullLength);
        offset = Number(fullOffset);
        directoryEnd = tailStart + zip64;
    }
    if (
        count < MIN_ENTRIES || count > MAX_ENTRIES ||
        length < count * (DIRECTORY_HEADER_BYTES + 1) ||
        length > MAX_DIRECTORY_BYTES ||
        offset + length !== directoryEnd
    ) { return null; }

    const dir = await archive.slice(offset, directoryEnd).arrayBuffer();
    checkCancellation();
    if (dir.byteLength !== length) { return null; }
    const view = new DataView(dir);
    const bytes = new Uint8Array(dir);
    /* eslint-disable @stylistic/semi */
    // This narrow directory has no extra fields or comments. Filename views
    // retain a compact arena so catalog entries can release central headers.
    const filenameBytes = new Uint8Array(length - count * DIRECTORY_HEADER_BYTES)
    /** @type {DenseZipCatalogEntry[]} */
    const entries = [];
    let position = 0;
    let localEnd = 0;
    let filenamePosition = 0
    while (entries.length < count) {
        if (position > length - DIRECTORY_HEADER_BYTES || view.getUint32(position, true) !== 0x02014b50) { return null; }
        const flags = view.getUint16(position + 8, true);
        const compressionMethod = view.getUint16(position + 10, true);
        const signature = view.getUint32(position + 16, true);
        const compressedSize = view.getUint32(position + 20, true);
        const uncompressedSize = view.getUint32(position + 24, true);
        const filenameLength = view.getUint16(position + 28, true);
        const filenameStart = position + DIRECTORY_HEADER_BYTES;
        const filenameEnd = filenameStart + filenameLength;
        const localOffset = view.getUint32(position + 42, true);
        if (
            (flags !== 0 && flags !== 0x800) ||
            (compressionMethod !== 0 && compressionMethod !== 8) ||
            uncompressedSize === UINT32_MAX ||
            filenameLength === 0 || filenameEnd > length ||
            filenameLength > filenameBytes.byteLength - filenamePosition ||
            view.getUint32(position + 30, true) !== 0 || // Extra field and comment.
            view.getUint16(position + 34, true) !== 0 ||
            (view.getUint8(position + 38) & 0x10) !== 0 ||
            bytes[filenameEnd - 1] === 0x2f ||
            localOffset !== localEnd ||
            localOffset + LOCAL_HEADER_BYTES + filenameLength + compressedSize > offset
        ) { return null; }
        for (let i = 0; i < filenameLength; ++i) {
            const value = bytes[filenameStart + i]
            if (value < 0x20 || value > 0x7e) { return null; }
            filenameBytes[filenamePosition + i] = value
        }
        entries.push(new DenseZipCatalogEntry(
            '',
            filenameBytes,
            filenamePosition,
            filenameLength,
            localOffset,
            compressedSize,
            uncompressedSize,
            compressionMethod,
            signature,
        ))
        position = filenameEnd;
        localEnd = localOffset + LOCAL_HEADER_BYTES + filenameLength + compressedSize;
        filenamePosition += filenameLength
    }
    if (position !== length || localEnd !== offset) { return null }
    // Decode only after the complete directory has proved the arena is plain
    // ASCII. Finish names without allocating a temporary byte view per entry.
    const filenames = decoder.decode(filenameBytes)
    for (const entry of entries) { entry.assignFilename(filenames) }
    return entries
    /* eslint-enable @stylistic/semi */
}
