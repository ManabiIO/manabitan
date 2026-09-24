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

import {describe, expect, test} from 'vitest';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {DictionaryImporterMediaLoader} from '../ext/js/dictionary/dictionary-importer-media-loader.js';

const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
const validate = /** @type {(entries: Array<{path: string, packedOffset: number, packedLength: number, compressionMethod: number, uncompressedLength: number}>, payloadLength: number, preserveCompressedMedia: boolean) => void} */ (
    Reflect.get(importer, '_validatePackedMediaArtifactEntries').bind(importer)
);

/**
 * @param {Partial<{path: string, packedOffset: number, packedLength: number, compressionMethod: number, uncompressedLength: number}>} overrides
 */
function entry(overrides = {}) {
    return {
        path: 'image.png',
        packedOffset: 10,
        packedLength: 20,
        compressionMethod: 0,
        uncompressedLength: 20,
        ...overrides,
    };
}

describe('DictionaryImporter packed media artifact validation', () => {
    test('accepts ranges at both payload boundaries', () => {
        expect(() => validate([
            entry({packedOffset: 0, packedLength: 1, uncompressedLength: 1}),
            entry({path: 'tail.png', packedOffset: 80, packedLength: 20}),
        ], 100, true)).not.toThrow();
    });

    test('rejects negative, unsafe, overflowing, and truncated ranges', () => {
        expect(() => validate([entry({packedOffset: -1})], 100, false)).toThrow(/out of bounds/);
        expect(() => validate([entry({packedLength: 0})], 100, false)).toThrow(/out of bounds/);
        expect(() => validate([entry({packedOffset: Number.MAX_SAFE_INTEGER + 1})], 100, false)).toThrow(/out of bounds/);
        expect(() => validate([entry({packedLength: Number.MAX_SAFE_INTEGER + 1})], 100, false)).toThrow(/out of bounds/);
        expect(() => validate([entry({packedOffset: 90, packedLength: 20})], 100, false)).toThrow(/out of bounds/);
    });

    test('validates preserved compression descriptors', () => {
        expect(() => validate([
            entry({compressionMethod: 8, packedLength: 12, uncompressedLength: 40}),
        ], 100, true)).not.toThrow();
        expect(() => validate([entry({compressionMethod: 99})], 100, true)).toThrow(/Unsupported/);
        expect(() => validate([entry({compressionMethod: 0, uncompressedLength: 21})], 100, true)).toThrow(/length mismatch/);
        expect(() => validate([entry({compressionMethod: 8, uncompressedLength: 0})], 100, true)).toThrow(/uncompressed length/);
    });

    test('ignores compression metadata when packed bytes are imported uncompressed', () => {
        expect(() => validate([
            entry({compressionMethod: 99, uncompressedLength: 123}),
        ], 100, false)).not.toThrow();
    });
});
