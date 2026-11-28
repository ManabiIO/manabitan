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
import {RAW_ZIP_BATCH_MAX_FILES, RAW_ZIP_BATCH_MAX_PAYLOAD_BYTES} from './term-bank-source-pipeline.js';
import {validateCompressedZipMediaBatchWasm} from './term-bank-wasm-parser.js';
// eslint-disable-next-line @stylistic/semi
import {createGenerationMediaIndexWriter} from './dictionary-generation-media-store.js'
// eslint-disable-next-line @stylistic/semi
import {DenseZipEntryCatalog} from './dense-zip-file-map.js'

export const MIN_SOURCE_ZIP_IMAGE_COUNT = 8192;

const MIN_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_PACKED_MEDIA_BYTES = 256 * 1024 * 1024;
const ZIP_LOCAL_HEADER_BYTES = 30;
const MAX_RELATIVE_RANGE_OVERHEAD = 1 / 8;

/** @typedef {{readMs: number, validationMs: number, rangeReadCount: number, rangeReadBytes: number, compressedBytes: number, uncompressedBytes: number}} SourceMediaMetrics */
/** @typedef {{blob: Blob, records: import('./dictionary-generation-media-store.js').SourceMediaRange[]} & SourceMediaMetrics} SourceMediaPack */
/** @typedef {{blob: Blob, plan: import('./dictionary-generation-media-store.js').GenerationMediaIndex} & SourceMediaMetrics} SourceMediaIndexPack */
/** @typedef {Array<{type: string, source: {path: string}}>|import('@zip.js/zip.js').Entry[]} SourceMediaFiles */
/** @typedef {import('@zip.js/zip.js').Entry[]|DenseZipEntryCatalog} SourceMediaIndexFiles */

/* eslint-disable @stylistic/semi */
/**
 * Admit only a dense run of referenced, exact-name ZIP images. The output
 * keeps the request order and points into an immutable span of the original
 * archive. Each selected payload is verified before any media sink write.
 * @param {Blob} archive
 * @param {Array<{type: string, source: {path: string}}>} requirements
 * @param {import('dictionary-importer').ArchiveFileMap} fileMap
 * @param {import('./term-bank-source-pipeline.js').RawZipPayloadReader} reader
 * @param {() => void} checkCancellation
 * @returns {Promise<{blob: Blob, records: import('./dictionary-generation-media-store.js').SourceMediaRange[], readMs: number, validationMs: number, rangeReadCount: number, rangeReadBytes: number, compressedBytes: number, uncompressedBytes: number}|null>}
 */
export async function preparePackedSourceZipMedia(archive, requirements, fileMap, reader, checkCancellation) {
    return await preparePackedSourceZipMediaFiles(archive, requirements, fileMap, reader, checkCancellation)
}

/**
 * Pack entries already selected from the ZIP directory without constructing a
 * second path map or a requirement/source wrapper pair for every image.
 * The common packer still checks duplicate paths, metadata and every ZIP CRC.
 * @param {Blob} archive
 * @param {import('@zip.js/zip.js').Entry[]} files
 * @param {import('./term-bank-source-pipeline.js').RawZipPayloadReader} reader
 * @param {() => void} checkCancellation
 * @returns {ReturnType<typeof preparePackedSourceZipMedia>}
 */
export async function preparePackedSourceZipMediaEntries(archive, files, reader, checkCancellation) {
    return await preparePackedSourceZipMediaFiles(archive, files, null, reader, checkCancellation)
}

/**
 * Write verified payload ranges directly into the fixed numeric index instead
 * of retaining a second object per image until packing finishes. Dense entry
 * catalogs already have physical order; other inputs sort only references.
 * Unsupported namespaces leave the ordinary resolver available.
 * @param {Blob} archive
 * @param {SourceMediaIndexFiles} files
 * @param {import('./term-bank-source-pipeline.js').RawZipPayloadReader} reader
 * @param {() => void} checkCancellation
 * @returns {Promise<SourceMediaIndexPack|null>}
 */
export async function preparePackedSourceZipMediaIndex(archive, files, reader, checkCancellation) {
    let orderedFiles = files
    if (!(files instanceof DenseZipEntryCatalog)) {
        for (let i = 1; i < files.length; ++i) {
            if (files[i].offset < files[i - 1].offset) {
                orderedFiles = [...files].sort((a, b) => a.offset - b.offset)
                break
            }
        }
    }
    return await preparePackedSourceZipMediaFiles(archive, orderedFiles, null, reader, checkCancellation, true)
}

/* eslint-enable @stylistic/semi */

/**
 * @overload
 * @param {Blob} archive
 * @param {SourceMediaFiles|DenseZipEntryCatalog} sources
 * @param {import('dictionary-importer').ArchiveFileMap|null} fileMap
 * @param {import('./term-bank-source-pipeline.js').RawZipPayloadReader} reader
 * @param {() => void} checkCancellation
 * @param {true} indexOutput
 * @returns {Promise<SourceMediaIndexPack|null>}
 */
/**
 * @overload
 * @param {Blob} archive
 * @param {SourceMediaFiles} sources
 * @param {import('dictionary-importer').ArchiveFileMap|null} fileMap
 * @param {import('./term-bank-source-pipeline.js').RawZipPayloadReader} reader
 * @param {() => void} checkCancellation
 * @param {false} [indexOutput]
 * @returns {Promise<SourceMediaPack|null>}
 */
/**
 * @param {Blob} archive
 * @param {SourceMediaFiles|DenseZipEntryCatalog} sources
 * @param {import('dictionary-importer').ArchiveFileMap|null} fileMap
 * @param {import('./term-bank-source-pipeline.js').RawZipPayloadReader} reader
 * @param {() => void} checkCancellation
 * @param {boolean} [indexOutput]
 * @returns {Promise<SourceMediaPack|SourceMediaIndexPack|null>}
 */
async function preparePackedSourceZipMediaFiles(archive, sources, fileMap, reader, checkCancellation, indexOutput = false) {
    // eslint-disable-next-line @stylistic/semi
    if (sources.length < MIN_SOURCE_ZIP_IMAGE_COUNT || archive.size <= MIN_ARCHIVE_BYTES || !reader.supportsBatchReads()) { return null }

    /* eslint-disable @stylistic/semi */
    const catalog = sources instanceof DenseZipEntryCatalog ? sources : null
    const arraySources = Array.isArray(sources) ? sources : []
    const indexFiles = indexOutput ? /** @type {SourceMediaIndexFiles} */ (sources) : null
    const indexEntries = Array.isArray(indexFiles) ? indexFiles : []
    const indexWriter = indexFiles === null ? null : createGenerationMediaIndexWriter(indexFiles.length, (i) => (catalog === null ? indexEntries[i].filename : catalog.filenameAt(i)))
    if (indexFiles !== null && indexWriter === null) { return null }
    const records = []
    const paths = indexFiles === null ? new Set() : null
    let previousOffset = -1
    let rangeStart = Infinity;
    let rangeEndLowerBound = 0;
    let compressedTotal = 0;
    for (let row = 0; row < sources.length; ++row) {
        let entry
        let path
        if (catalog !== null) {
            path = catalog.filenameAt(row)
        } else if (fileMap === null) {
            const source = arraySources[row]
            entry = /** @type {import('@zip.js/zip.js').Entry} */ (source)
            path = entry.filename
        } else {
            const source = arraySources[row]
            const requirement = /** @type {{type: string, source: {path: string}}} */ (source)
            if (requirement.type !== 'image' && requirement.type !== 'structured-content-image' && requirement.type !== 'image-reference') { return null }
            path = requirement.source.path
            entry = fileMap.get(path)
        }
        const mediaType = getImageMediaTypeFromFileName(path);
        if (
            mediaType === null ||
            path.startsWith('mdict-media/') ||
            (catalog === null && (typeof entry === 'undefined' || entry.filename !== path || Reflect.has(entry, 'bytes'))) ||
            paths?.has(path)
        ) {
            return null;
        }
        const file = /** @type {import('@zip.js/zip.js').Entry} */ (entry)
        const offset = catalog === null ? file.offset : catalog.offsetAt(row)
        const compressedSize = catalog === null ? file.compressedSize : catalog.compressedSizeAt(row)
        const uncompressedSize = catalog === null ? file.uncompressedSize : catalog.uncompressedSizeAt(row)
        const compressionMethod = catalog === null ? file.compressionMethod : catalog.compressionMethodAt(row)
        const rawFilename = file?.rawFilename
        if (
            !Number.isSafeInteger(offset) || offset < 0 || offset >= archive.size ||
            !Number.isSafeInteger(compressedSize) || compressedSize < 0 || compressedSize > RAW_ZIP_BATCH_MAX_PAYLOAD_BYTES ||
            !Number.isSafeInteger(uncompressedSize) || uncompressedSize < 0 || uncompressedSize > RAW_ZIP_BATCH_MAX_PAYLOAD_BYTES ||
            (compressionMethod !== 0 && compressionMethod !== 8) ||
            file?.encrypted ||
            (catalog === null && (!(rawFilename instanceof Uint8Array) || rawFilename.byteLength !== path.length || rawFilename.byteLength > 0xffff))
        ) {
            return null;
        }
        if (indexFiles !== null && offset <= previousOffset) { return null }
        previousOffset = offset
        // A normalized UTF-8 alias or Unicode extra field can describe a
        // different logical pathname. Leave either to the general resolver.
        if (catalog !== null) {
            if (!catalog.hasExactRawFilename(row, path)) { return null }
        } else if (typeof rawFilename !== 'undefined') {
            for (let i = 0; i < rawFilename.byteLength; ++i) {
                if (rawFilename[i] > 0x7f || rawFilename[i] !== path.charCodeAt(i)) { return null }
            }
        }
        const firstPossibleEnd = offset + ZIP_LOCAL_HEADER_BYTES + path.length + compressedSize
        if (firstPossibleEnd > archive.size) { return null; }
        rangeStart = Math.min(rangeStart, offset);
        rangeEndLowerBound = Math.max(rangeEndLowerBound, firstPossibleEnd);
        compressedTotal += compressedSize;
        paths?.add(path)
        if (indexFiles === null) {
            records.push({
                path,
                mediaType,
                file,
                offset,
                compressedSize,
                uncompressedLength: uncompressedSize,
                compressionMethod,
                packedOffset: 0,
                packedLength: compressedSize,
                signature: file.signature,
            })
        }
    }
    /* eslint-enable @stylistic/semi */

    const maxSpan = Math.min(MAX_PACKED_MEDIA_BYTES, compressedTotal * (1 + MAX_RELATIVE_RANGE_OVERHEAD));
    if (rangeEndLowerBound - rangeStart > maxSpan) { return null; }

    /* eslint-disable @stylistic/semi */
    const byOffset = indexFiles === null ? [...records].sort((a, b) => a.offset - b.offset) : []
    const fileCount = indexFiles === null ? byOffset.length : indexFiles.length
    /* eslint-enable @stylistic/semi */
    let rangeEnd = rangeStart;
    let readMs = 0;
    let validationMs = 0;
    let rangeReadCount = 0;
    let rangeReadBytes = 0;
    let uncompressedBytes = 0;
    const checkRawReadCancelled = () => {
        checkCancellation();
        return false;
    };
    for (let start = 0; start < fileCount;) {
        checkCancellation();
        let end = start;
        let packedBytes = 0;
        let unpackedBytes = 0;
        while (end < fileCount && end - start < RAW_ZIP_BATCH_MAX_FILES) {
            /* eslint-disable @stylistic/semi */
            const compressedSize = catalog !== null ? catalog.compressedSizeAt(end) : (indexFiles === null ? byOffset[end].compressedSize : indexEntries[end].compressedSize)
            const uncompressedLength = catalog !== null ? catalog.uncompressedSizeAt(end) : (indexFiles === null ? byOffset[end].uncompressedLength : indexEntries[end].uncompressedSize)
            /* eslint-enable @stylistic/semi */
            if (
                packedBytes + compressedSize > RAW_ZIP_BATCH_MAX_PAYLOAD_BYTES ||
                unpackedBytes + uncompressedLength > RAW_ZIP_BATCH_MAX_PAYLOAD_BYTES
            ) {
                break;
            }
            packedBytes += compressedSize;
            unpackedBytes += uncompressedLength;
            ++end;
        }

        const readStart = Date.now();
        // eslint-disable-next-line @stylistic/semi
        const files = catalog !== null ? /** @type {import('@zip.js/zip.js').Entry[]} */ (/** @type {unknown} */ (catalog.getEntries(start, end))) : (indexFiles === null ? byOffset.slice(start, end).map(({file}) => file) : indexEntries.slice(start, end))
        // eslint-disable-next-line @stylistic/semi
        const offsets = indexFiles === null ? null : files.map(({offset}) => offset)
        // Large-Blob reads use bounded coalesced ranges. Keep payload subviews
        // into that range through validation instead of allocating one owned
        // byte array per image; the validator copies bytes into its WASM arena.
        const batch = await reader.readBatch(files, void 0, checkRawReadCancelled, true);
        if (batch === null || batch.sources.length !== files.length) { return null; }
        readMs += Math.max(0, Date.now() - readStart);
        rangeReadCount += batch.rangeReadCount;
        rangeReadBytes += batch.rangeReadBytes;
        const validationStart = Date.now();
        await validateCompressedZipMediaBatchWasm(batch.sources);
        checkCancellation();
        validationMs += Math.max(0, Date.now() - validationStart);
        uncompressedBytes += unpackedBytes;

        for (let i = 0; i < batch.sources.length; ++i) {
            /* eslint-disable @stylistic/semi */
            const record = indexFiles === null ? byOffset[start + i] : null
            const source = batch.sources[i];
            if (source.file !== files[i] || (offsets === null ? byOffset[start + i].offset : offsets[i]) < rangeEnd) { return null }
            rangeEnd = source.archiveOffset + source.compressedSize;
            if (rangeEnd - rangeStart > maxSpan) { return null; }
            let packedOffset = source.archiveOffset - rangeStart
            let packedLength = record === null ? source.compressedSize : record.packedLength
            let compressionMethod = record === null ? source.compressionMethod : record.compressionMethod
            const uncompressedLength = record === null ? source.uncompressedSize : record.uncompressedLength
            const bodyOffset = getSingleStoredDeflateBodyOffset(source);
            if (bodyOffset !== 0) {
                // The validator verified the real decoded bytes and CRC. One
                // exact stored block is already byte-identical to its output.
                packedOffset += bodyOffset
                packedLength = uncompressedLength
                compressionMethod = 0
            }
            if (record === null) {
                if (indexWriter === null || !indexWriter.write(start + i, source.filename, packedOffset, packedLength, uncompressedLength, compressionMethod, source.signature)) { return null }
            } else {
                record.packedOffset = packedOffset
                record.packedLength = packedLength
                record.compressionMethod = compressionMethod
            }
            /* eslint-enable @stylistic/semi */
        }
        start = end;
    }

    /* eslint-disable @stylistic/semi */
    const blob = archive.slice(rangeStart, rangeEnd)
    const metrics = {
        readMs,
        validationMs,
        rangeReadCount,
        rangeReadBytes,
        compressedBytes: compressedTotal,
        uncompressedBytes,
    }
    if (indexWriter !== null) {
        const plan = indexWriter.finish(blob.size)
        return plan === null ? null : {blob, plan, ...metrics}
    }
    return {blob, records, ...metrics}
    /* eslint-enable @stylistic/semi */
}

/**
 * @param {{bytes: Uint8Array, compressionMethod: number, uncompressedSize: number}} source
 * @returns {number}
 */
function getSingleStoredDeflateBodyOffset({bytes, compressionMethod, uncompressedSize}) {
    if (
        compressionMethod !== 8 ||
        bytes.length < 5 ||
        bytes.length - 5 !== uncompressedSize ||
        uncompressedSize > 0xffff ||
        (bytes[0] & 7) !== 1
    ) {
        return 0;
    }
    const length = bytes[1] | (bytes[2] << 8);
    const invertedLength = bytes[3] | (bytes[4] << 8);
    return length === uncompressedSize && invertedLength === (length ^ 0xffff) ? 5 : 0;
}
