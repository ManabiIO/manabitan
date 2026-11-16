import {expect, test} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';

const database = new DictionaryDatabase();
/** @type {(a: Uint8Array, buffer: Uint8Array, offset: number, length: number) => boolean} */
const areTermContentBytesEqual = Reflect.get(database, '_termContentBytesEqualSpan').bind(database);

const lengths = [0, 1, 7, 8, 9, 31, 63, 127, 255, 256, 257, 263, 264, 511, 512, 513, 1025];

test.each(lengths)('compares all bytes at length %i across unaligned backing views', (length) => {
    const expected = Uint8Array.from({length}, (_, i) => (i * 73 + length * 13) & 255);
    for (const leftOffset of [0, 1, 3, 7]) {
        for (const rightOffset of [0, 1, 3, 7]) {
            for (const offset of [0, 1, 3, 7]) {
                const left = new Uint8Array(leftOffset + length + 8);
                left.set(expected, leftOffset);
                const a = left.subarray(leftOffset, leftOffset + length);
                const right = new Uint8Array(rightOffset + offset + length + 8);
                const buffer = right.subarray(rightOffset);
                buffer.set(expected, offset);
                expect(areTermContentBytesEqual(a, buffer, offset, length)).toBe(true);
                for (const index of new Set([0, 1, length >>> 1, length - 1])) {
                    if (index < 0 || index >= length) { continue; }
                    buffer[offset + index] ^= 1;
                    expect(areTermContentBytesEqual(a, buffer, offset, length)).toBe(false);
                    buffer[offset + index] ^= 1;
                }
                expect(a).toEqual(expected);
                expect(buffer.subarray(offset, offset + length)).toEqual(expected);
            }
        }
    }
});

test('detects a mismatch at every word and tail position', () => {
    for (const length of [256, 257, 263, 264]) {
        const a = new Uint8Array(length).fill(42);
        const buffer = new Uint8Array(length + 9).fill(42);
        for (let i = 0; i < length; ++i) {
            buffer[i + 3] ^= 1;
            expect(areTermContentBytesEqual(a, buffer, 3, length)).toBe(false);
            buffer[i + 3] ^= 1;
        }
    }
});

test('rejects mismatched lengths and out-of-bounds nonempty spans without throwing', () => {
    const bytes = new Uint8Array(256);
    expect(areTermContentBytesEqual(bytes, bytes, 0, 255)).toBe(false);
    for (const offset of [-1, 0.5, Number.NaN, Infinity, 1, 257]) {
        expect(areTermContentBytesEqual(bytes, bytes, offset, 256)).toBe(false);
    }
});

test('supports shared backing buffers without changing source bytes', () => {
    const a = new Uint8Array(new SharedArrayBuffer(513));
    a.fill(42);
    const buffer = new Uint8Array(new SharedArrayBuffer(520));
    buffer.set(a, 3);
    expect(areTermContentBytesEqual(a, buffer, 3, a.length)).toBe(true);
    buffer[512] = 41;
    expect(areTermContentBytesEqual(a, buffer, 3, a.length)).toBe(false);
    expect(a.every((value) => value === 42)).toBe(true);
});


test('preserves checked whole-buffer comparison inputs and unequal lengths', () => {
    const compare = Reflect.get(database, '_termContentBytesEqual').bind(database);
    const bytes = new Uint8Array(256);
    for (const invalid of [null, [], {}, 'bytes', new Int8Array(256), new DataView(new ArrayBuffer(256))]) {
        expect(() => Reflect.apply(compare, database, [invalid, bytes])).toThrow(TypeError);
        expect(() => Reflect.apply(compare, database, [bytes, invalid])).toThrow(TypeError);
    }
    expect(compare(bytes, new Uint8Array(bytes))).toBe(true);
    expect(compare(bytes, new Uint8Array(255))).toBe(false);
    expect(compare(new Uint8Array(0), new Uint8Array(0))).toBe(true);
});
