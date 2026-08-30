/*
 * Copyright (C) 2026  Yomitan Authors
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

/** @typedef {{compressionMethod: unknown, compressedSize: unknown, uncompressedSize: unknown, signature: unknown, filename?: unknown}} CompressedSourceMetadata */

/**
 * Inflates transferred ZIP payloads inside the parser worker. ZIP CRC32 is
 * validated separately in parser WASM after the exact output size is known.
 * @param {ArrayBuffer[]} sourceBuffers
 * @param {CompressedSourceMetadata[]} sourceMetadata
 * @returns {Promise<{sourceBytes: Uint8Array[], signatures: number[]}>}
 */
export async function inflateCompressedTermBankSources(sourceBuffers, sourceMetadata) {
    if (sourceBuffers.length !== sourceMetadata.length) {
        throw new Error('Compressed term-bank source metadata length mismatch');
    }
    const results = await Promise.all(sourceBuffers.map(async (buffer, index) => {
        if (!(buffer instanceof ArrayBuffer)) {
            throw new TypeError(`Compressed term-bank source ${index + 1} buffer is invalid`);
        }
        const metadata = sourceMetadata[index];
        if (typeof metadata !== 'object' || metadata === null) {
            throw new TypeError(`Compressed term-bank source ${index + 1} metadata is invalid`);
        }
        const {compressionMethod, compressedSize, uncompressedSize, signature} = metadata;
        if (
            (compressionMethod !== 0 && compressionMethod !== 8) ||
            !Number.isSafeInteger(compressedSize) || /** @type {number} */ (compressedSize) < 0 ||
            !Number.isSafeInteger(uncompressedSize) || /** @type {number} */ (uncompressedSize) < 0 ||
            !Number.isInteger(signature) || /** @type {number} */ (signature) < 0 || /** @type {number} */ (signature) > 0xffffffff
        ) {
            throw new TypeError(`Compressed term-bank source ${index + 1} metadata is invalid`);
        }
        if (buffer.byteLength !== compressedSize) {
            throw new Error(`Compressed term-bank source ${index + 1} input size mismatch`);
        }
        let bytes;
        if (compressionMethod === 0) {
            bytes = new Uint8Array(buffer);
        } else {
            if (typeof DecompressionStream !== 'function') {
                throw new Error('Raw DEFLATE is unavailable in this parser worker');
            }
            const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
            bytes = new Uint8Array(await new Response(stream).arrayBuffer());
        }
        if (bytes.byteLength !== uncompressedSize) {
            throw new Error(`Compressed term-bank source ${index + 1} output size mismatch`);
        }
        return {bytes, signature: /** @type {number} */ (signature)};
    }));
    return {
        sourceBytes: results.map(({bytes}) => bytes),
        signatures: results.map(({signature}) => signature),
    };
}
