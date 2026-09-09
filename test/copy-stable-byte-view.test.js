/*
 * Copyright (C) 2026  Manabitan Authors
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

import {afterEach, describe, expect, test, vi} from 'vitest';
import {copyStableByteView} from '../ext/js/core/copy-stable-byte-view.js';

/** @param {Uint8Array} bytes */
function fillPattern(bytes) {
    for (let i = 0; i < bytes.length; ++i) { bytes[i] = (i * 17 + Math.floor(i / 256)) & 255; }
}

afterEach(() => { vi.unstubAllGlobals(); });

describe.each([false, true])('copyStableByteView shared=%s', (shared) => {
    test.each(Array.from({length: 16}, (_, index) => index))('preserves exact bytes, ownership and allocation at offset %i', (offset) => {
        const lengths = [...Array.from({length: 128}, (_, index) => index), 1023, 1024, 1025, 4095, 4096, 4097, 8191, 8192, 8193];
        for (const length of lengths) {
            const buffer = shared ? new SharedArrayBuffer(length + 64) : new ArrayBuffer(length + 64);
            const all = new Uint8Array(buffer);
            fillPattern(all);
            // Both the view and selected subview have nonzero offsets. Sentinels
            // before/after the selected bytes must never leak into the result.
            const source = all.subarray(16, -16).subarray(offset, offset + length);
            const expected = Uint8Array.from(source);
            const copied = copyStableByteView(source);
            expect(copied).toStrictEqual(expected);
            expect(copied.buffer).toBeInstanceOf(ArrayBuffer);
            expect(copied.byteOffset).toBe(0);
            expect(copied.buffer.byteLength).toBe(length);
            expect(copied.buffer).not.toBe(buffer);
            expect(source).toStrictEqual(expected);
            source.fill(0);
            expect(copied).toStrictEqual(expected);
            copied.fill(255);
            expect(source.every((byte) => byte === 0)).toBe(true);
        }
    });
});

test('uses the unaligned shared path without source slice', () => {
    const source = new Uint8Array(new SharedArrayBuffer(8200), 3, 8193);
    fillPattern(source);
    const expected = Uint8Array.from(source);
    const slice = vi.spyOn(source, 'slice').mockImplementation(() => { throw new Error('unexpected byte slice'); });
    expect(copyStableByteView(source)).toStrictEqual(expected);
    expect(slice).not.toHaveBeenCalled();
});

test('retains ordinary and small/aligned shared slice paths', () => {
    for (const source of [new Uint8Array(new ArrayBuffer(2050), 1, 2048), new Uint8Array(new SharedArrayBuffer(2056), 8, 2048), new Uint8Array(new SharedArrayBuffer(100), 1, 99)]) {
        const slice = vi.spyOn(source, 'slice');
        copyStableByteView(source);
        expect(slice).toHaveBeenCalledOnce();
    }
});

test('works when the SharedArrayBuffer constructor is unavailable', () => {
    const source = new Uint8Array(new SharedArrayBuffer(2050), 1, 2048);
    fillPattern(source);
    const expected = Uint8Array.from(source);
    vi.stubGlobal('SharedArrayBuffer', void 0);
    expect(copyStableByteView(source)).toStrictEqual(expected);
});

test('owns shared WASM bytes across source reuse and memory growth', () => {
    const memory = new WebAssembly.Memory({initial: 1, maximum: 2, shared: true});
    for (let alignment = 0; alignment < 8; ++alignment) {
        const source = new Uint8Array(memory.buffer, 1024 + alignment, 8197);
        fillPattern(source);
        const expected = Uint8Array.from(source);
        const owned = copyStableByteView(source);
        source.fill(0);
        if (alignment === 0) { memory.grow(1); }
        expect(owned).toStrictEqual(expected);
        expect(owned.buffer.byteLength).toBe(source.byteLength);
    }
});

test('keeps detached ordinary source failure semantics', () => {
    const source = new Uint8Array(1024);
    structuredClone(source.buffer, {transfer: [source.buffer]});
    expect(() => copyStableByteView(source)).toThrow(TypeError);
});
