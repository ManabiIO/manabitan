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

import {hashTermEntryContentBytesPair} from './term-entry-content-hash.js';

export const TERM_CONTENT_BLOCK_ENVELOPE_BYTES = 12;

export const TERM_CONTENT_BLOCK_ENVELOPE_MAGIC = new Uint8Array([0x4d, 0x42, 0x43, 0x32]);

/**
 * @param {Uint8Array} compressed
 * @returns {Uint8Array}
 */
export function wrapCompressedTermContentBlock(compressed) {
    const output = new Uint8Array(TERM_CONTENT_BLOCK_ENVELOPE_BYTES + compressed.byteLength);
    output.set(compressed, TERM_CONTENT_BLOCK_ENVELOPE_BYTES);
    writeCompressedTermContentBlockEnvelope(output);
    return output;
}

/**
 * Completes an output buffer whose compressed frame starts after the envelope.
 * @param {Uint8Array} output
 * @throws {RangeError} If the output does not contain a compressed frame.
 */
export function writeCompressedTermContentBlockEnvelope(output) {
    if (output.byteLength <= TERM_CONTENT_BLOCK_ENVELOPE_BYTES) {
        throw new RangeError('Compressed term content block is empty');
    }
    const compressed = output.subarray(TERM_CONTENT_BLOCK_ENVELOPE_BYTES);
    const [hash1, hash2] = hashTermEntryContentBytesPair(compressed);
    output.set(TERM_CONTENT_BLOCK_ENVELOPE_MAGIC, 0);
    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
    view.setUint32(4, hash1, true);
    view.setUint32(8, hash2, true);
}
