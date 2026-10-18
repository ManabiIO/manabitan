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

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {deflateSync} from 'node:zlib';
import {inflateSync} from '../../ext/js/dictionary/mdx/vendor/pako.js';
import lzo1x from '../../ext/js/dictionary/mdx/vendor/js-mdict/lzo1x-wrapper.js';
import {MDX} from '../../ext/js/dictionary/mdx/vendor/js-mdict/mdx.js';
import {makeMdictFixture} from './mdict-binary-fixture.js';

/**
 * A literal-only LZO1X stream with the normal 17,0,0 end marker.
 * This is intentionally independent of the vendored compressor.
 * @param {Uint8Array} bytes 4..238 literal bytes.
 * @returns {Uint8Array}
 */
function literalLzo(bytes) {
    if (bytes.length < 4 || bytes.length > 238) { throw new RangeError('invalid test literal size'); }
    return Uint8Array.from([17 + bytes.length, ...bytes, 17, 0, 0]);
}

test('bounded pako inflate returns exact bytes at the declared size', () => {
    const expected = new TextEncoder().encode('bounded zlib payload');
    const packed = new Uint8Array(deflateSync(expected));
    assert.deepEqual(inflateSync(packed, expected.byteLength), expected);
});

test('bounded pako inflate rejects trailing bytes after a complete zlib stream', () => {
    const expected = new TextEncoder().encode('bounded zlib payload');
    const packed = new Uint8Array(deflateSync(expected));
    const trailing = new Uint8Array(packed.byteLength + 3);
    trailing.set(packed);
    trailing.set([0xa5, 0x00, 0xff], packed.byteLength);
    assert.throws(
        () => inflateSync(trailing, expected.byteLength),
        /trailing compressed input/u,
    );
});

test('bounded pako inflate rejects output one byte beyond the declaration', () => {
    const expected = new Uint8Array(128 * 1024);
    expected.fill(65);
    const packed = new Uint8Array(deflateSync(expected));
    assert.throws(
        () => inflateSync(packed, expected.byteLength - 1),
        /decompressed block exceeds declared size/u,
    );
});

test('bounded pako inflate accepts an empty stream with a zero output limit', () => {
    const packed = new Uint8Array(deflateSync(new Uint8Array(0)));
    assert.deepEqual(inflateSync(packed, 0), new Uint8Array(0));
});

for (const value of [-1, 0.5, Number.NaN, Infinity]) {
    test(`bounded pako rejects invalid output limit ${String(value)}`, () => {
        assert.throws(() => inflateSync(new Uint8Array(0), value), /output limit/u);
    });
}

test('LZO wrapper returns an independently encoded literal stream at its exact size', () => {
    const expected = Uint8Array.from({length: 32}, (_, index) => 32 + index);
    assert.deepEqual(lzo1x.decompress(literalLzo(expected), expected.byteLength), expected);
});

test('LZO wrapper rejects literal output beyond the declared size before growth', () => {
    const expected = Uint8Array.from({length: 32}, (_, index) => 32 + index);
    assert.throws(
        () => lzo1x.decompress(literalLzo(expected), expected.byteLength - 1),
        /LZO output exceeds declared size/u,
    );
});

for (const value of [-1, 0.5, Number.NaN, Infinity]) {
    test(`LZO wrapper rejects invalid expected size ${String(value)}`, () => {
        assert.throws(() => lzo1x.decompress(Uint8Array.of(17, 0, 0), value), /decompression bounds/u);
    });
}

test('parser rejects a key block whose zlib output exceeds its advertised unpack size', () => {
    const fixture = makeMdictFixture(
        [{key: 'alpha', value: 'definition'}],
        {keyBlockUnpackSizeDelta: -1},
    );
    assert.throws(
        () => new MDX('Book.mdx', fixture.bytes),
        /decompressed block exceeds declared size/u,
    );
});

/** @type {Array<'raw'|'zlib'>} */
const recordCompressions = ['raw', 'zlib'];
for (const compression of recordCompressions) {
    test(`parser enforces configurable record-block ceiling for ${compression}`, () => {
        const fixture = makeMdictFixture(
            [{key: 'alpha', value: 'x'.repeat(256)}],
            {compression, recordBlockSize: 1024},
        );
        assert.throws(
            () => new MDX('Book.mdx', fixture.bytes, {maxDecompressedBlockBytes: 64}),
            /record block exceeds decompressed block limit/u,
        );
    });
}

test('parser rejects key-info metadata beyond the configured ceiling before inflate', () => {
    const fixture = makeMdictFixture([{key: 'alpha', value: 'definition'}]);
    assert.throws(
        () => new MDX('Book.mdx', fixture.bytes, {maxDecompressedBlockBytes: 8}),
        /key info exceeds decompressed block limit/u,
    );
});

test('zero-size empty dictionary remains valid with a zero block ceiling', () => {
    const fixture = makeMdictFixture([]);
    const dictionary = new MDX('Empty.mdx', fixture.bytes, {maxDecompressedBlockBytes: 0});
    try {
        assert.deepEqual(dictionary.keywordList, []);
        assert.deepEqual(dictionary.recordInfoList, []);
    } finally {
        dictionary.close();
    }
});

for (const value of [-1, 0.5, Number.NaN, Infinity]) {
    test(`parser rejects invalid decompressed-block ceiling ${String(value)}`, () => {
        const fixture = makeMdictFixture([]);
        assert.throws(
            () => new MDX('Empty.mdx', fixture.bytes, {maxDecompressedBlockBytes: value}),
            /decompressed block limit/u,
        );
    });
}
