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

export const MIN_SOURCE_ZIP_IMAGE_COUNT = 8192;

const MIN_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_PACKED_MEDIA_BYTES = 256 * 1024 * 1024;
const ZIP_LOCAL_HEADER_BYTES = 30;
const MAX_RELATIVE_RANGE_OVERHEAD = 1 / 8;

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
    if (requirements.length < MIN_SOURCE_ZIP_IMAGE_COUNT || archive.size <= MIN_ARCHIVE_BYTES || !reader.supportsBatchReads()) { return null; }

    const records = [];
    const paths = new Set();
    let rangeStart = Infinity;
    let rangeEndLowerBound = 0;
    let compressedTotal = 0;
    for (const requirement of requirements) {
        if (requirement.type !== 'image' && requirement.type !== 'structured-content-image') { return null; }
        const {path} = requirement.source;
        const entry = fileMap.get(path);
        const mediaType = getImageMediaTypeFromFileName(path);
        if (
            mediaType === null ||
            path.startsWith('mdict-media/') ||
            typeof entry === 'undefined' ||
            entry.filename !== path ||
            Reflect.has(entry, 'bytes') ||
            paths.has(path)
        ) {
            return null;
        }
        const file = /** @type {import('@zip.js/zip.js').Entry} */ (entry);
        const {offset, rawFilename, compressedSize, uncompressedSize, compressionMethod} = file;
        if (
            !Number.isSafeInteger(offset) || offset < 0 || offset >= archive.size ||
            !Number.isSafeInteger(compressedSize) || compressedSize < 0 || compressedSize > RAW_ZIP_BATCH_MAX_PAYLOAD_BYTES ||
            !Number.isSafeInteger(uncompressedSize) || uncompressedSize < 0 || uncompressedSize > RAW_ZIP_BATCH_MAX_PAYLOAD_BYTES ||
            (compressionMethod !== 0 && compressionMethod !== 8) ||
            file.encrypted ||
            !(rawFilename instanceof Uint8Array) ||
            rawFilename.byteLength !== path.length || rawFilename.byteLength > 0xffff
        ) {
            return null;
        }
        // A normalized UTF-8 alias or Unicode extra field can describe a
        // different logical pathname. Leave either to the general resolver.
        for (let i = 0; i < rawFilename.byteLength; ++i) {
            if (rawFilename[i] > 0x7f || rawFilename[i] !== path.charCodeAt(i)) { return null; }
        }
        const firstPossibleEnd = offset + ZIP_LOCAL_HEADER_BYTES + rawFilename.byteLength + compressedSize;
        if (firstPossibleEnd > archive.size) { return null; }
        rangeStart = Math.min(rangeStart, offset);
        rangeEndLowerBound = Math.max(rangeEndLowerBound, firstPossibleEnd);
        compressedTotal += compressedSize;
        paths.add(path);
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
        });
    }

    const maxSpan = Math.min(MAX_PACKED_MEDIA_BYTES, compressedTotal * (1 + MAX_RELATIVE_RANGE_OVERHEAD));
    if (rangeEndLowerBound - rangeStart > maxSpan) { return null; }

    const byOffset = [...records].sort((a, b) => a.offset - b.offset);
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
    for (let start = 0; start < byOffset.length;) {
        checkCancellation();
        let end = start;
        let packedBytes = 0;
        let unpackedBytes = 0;
        while (end < byOffset.length && end - start < RAW_ZIP_BATCH_MAX_FILES) {
            const record = byOffset[end];
            if (
                packedBytes + record.compressedSize > RAW_ZIP_BATCH_MAX_PAYLOAD_BYTES ||
                unpackedBytes + record.uncompressedLength > RAW_ZIP_BATCH_MAX_PAYLOAD_BYTES
            ) {
                break;
            }
            packedBytes += record.compressedSize;
            unpackedBytes += record.uncompressedLength;
            ++end;
        }

        const readStart = Date.now();
        const files = byOffset.slice(start, end).map(({file}) => file);
        const batch = await reader.readBatch(files, void 0, checkRawReadCancelled);
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
            const record = byOffset[start + i];
            const source = batch.sources[i];
            if (source.file !== record.file || record.offset < rangeEnd) { return null; }
            rangeEnd = source.archiveOffset + source.compressedSize;
            if (rangeEnd - rangeStart > maxSpan) { return null; }
            record.packedOffset = source.archiveOffset - rangeStart;
            const bodyOffset = getSingleStoredDeflateBodyOffset(source);
            if (bodyOffset !== 0) {
                // The validator verified the real decoded bytes and CRC. One
                // exact stored block is already byte-identical to its output.
                record.packedOffset += bodyOffset;
                record.packedLength = record.uncompressedLength;
                record.compressionMethod = 0;
            }
        }
        start = end;
    }

    return {
        blob: archive.slice(rangeStart, rangeEnd),
        records,
        readMs,
        validationMs,
        rangeReadCount,
        rangeReadBytes,
        compressedBytes: compressedTotal,
        uncompressedBytes,
    };
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
