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

import {describe, expect, test, vi} from 'vitest';
import {inflateCompressedTermBankSources} from '../ext/js/dictionary/term-bank-compressed-source.js';

const textEncoder = new TextEncoder();

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
async function deflateRaw(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * @param {Uint8Array} bytes
 * @returns {ArrayBuffer}
 */
function ownedBuffer(bytes) {
    return Uint8Array.from(bytes).buffer;
}

describe('compressed term-bank sources', () => {
    test('inflates stored and raw-deflate sources while preserving signature order', async () => {
        const stored = textEncoder.encode('[]');
        const deflatedSource = textEncoder.encode('[[' + '"entry",'.repeat(128) + 'null]]');
        const deflated = await deflateRaw(deflatedSource);

        const result = await inflateCompressedTermBankSources([
            ownedBuffer(stored),
            ownedBuffer(deflated),
        ], [
            {compressionMethod: 0, compressedSize: stored.length, uncompressedSize: stored.length, signature: 1},
            {compressionMethod: 8, compressedSize: deflated.length, uncompressedSize: deflatedSource.length, signature: 2},
        ]);

        expect(result.sourceBytes).toStrictEqual([stored, deflatedSource]);
        expect(result.signatures).toStrictEqual([1, 2]);
    });

    test('rejects malformed metadata, input lengths, output lengths, and deflate streams', async () => {
        const bytes = textEncoder.encode('[]');
        await expect(inflateCompressedTermBankSources([ownedBuffer(bytes)], [])).rejects.toThrow('metadata length mismatch');
        await expect(inflateCompressedTermBankSources([ownedBuffer(bytes)], [{
            compressionMethod: 9,
            compressedSize: bytes.length,
            uncompressedSize: bytes.length,
            signature: 0,
        }])).rejects.toThrow('metadata is invalid');
        await expect(inflateCompressedTermBankSources([ownedBuffer(bytes)], [{
            compressionMethod: 0,
            compressedSize: bytes.length + 1,
            uncompressedSize: bytes.length,
            signature: 0,
        }])).rejects.toThrow('input size mismatch');
        await expect(inflateCompressedTermBankSources([ownedBuffer(bytes)], [{
            compressionMethod: 0,
            compressedSize: bytes.length,
            uncompressedSize: bytes.length + 1,
            signature: 0,
        }])).rejects.toThrow('output size mismatch');
        await expect(inflateCompressedTermBankSources([ownedBuffer(bytes)], [{
            compressionMethod: 8,
            compressedSize: bytes.length,
            uncompressedSize: 10,
            signature: 0,
        }])).rejects.toThrow();
    });

    test('reports missing raw-deflate support before consuming the source', async () => {
        const nativeDecompressionStream = globalThis.DecompressionStream;
        vi.stubGlobal('DecompressionStream', void 0);
        try {
            await expect(inflateCompressedTermBankSources([new Uint8Array([1]).buffer], [{
                compressionMethod: 8,
                compressedSize: 1,
                uncompressedSize: 1,
                signature: 0,
            }])).rejects.toThrow('Raw DEFLATE is unavailable');
        } finally {
            vi.stubGlobal('DecompressionStream', nativeDecompressionStream);
        }
    });
});
