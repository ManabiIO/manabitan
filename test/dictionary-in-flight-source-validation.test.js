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
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';

/**
 * @param {DictionaryDatabase} database
 * @returns {{buffer: Uint8Array, offsets: Uint32Array, lengths: Uint32Array}}
 */
function sourceSpans(database) {
    return database._createArtifactTermContentSpans(
        Uint8Array.of(10, 11, 12, 13, 14, 15),
        new Uint32Array([0, 2, 4]),
        new Uint32Array([2, 2, 2]),
    );
}

describe('in-flight term source validation', () => {
    test('retains independent ordered reservations until each writer releases them', () => {
        const database = new DictionaryDatabase();
        const register = database._registerInFlightTermContentSources.bind(database);
        const first = sourceSpans(database);
        const second = sourceSpans(database);
        const releaseFirst = register(new Float64Array([100, 102, 104]), first.lengths, 'raw', [], first);
        const releaseSecond = register(new Float64Array([200, 202, 204]), second.lengths, 'raw', [], second);
        expect(database._findInFlightTermContentSource(202, 2, 'raw')).toEqual({buffer: second.buffer, offset: 2, length: 2});
        expect(database._findInFlightTermContentSource(102, 2, 'raw')).toEqual({buffer: first.buffer, offset: 2, length: 2});
        releaseFirst();
        expect(database._findInFlightTermContentSource(102, 2, 'raw')).toBeUndefined();
        expect(database._findInFlightTermContentSource(202, 2, 'raw')).toBeDefined();
        releaseSecond();
        expect(database._findInFlightTermContentSource(202, 2, 'raw')).toBeUndefined();
    });

    test('checks overlapping ranges by exact offset, length and codec identity', () => {
        const database = new DictionaryDatabase();
        const register = database._registerInFlightTermContentSources.bind(database);
        const first = sourceSpans(database);
        const releaseFirst = register(new Float64Array([100, 200, 300]), first.lengths, 'raw', [], first);
        const other = sourceSpans(database);
        const releaseOther = register(new Float64Array([101, 200, 299]), other.lengths, 'other', [], other);
        expect(database._findInFlightTermContentSource(200, 2, 'raw')).toEqual({buffer: first.buffer, offset: 2, length: 2});
        expect(database._findInFlightTermContentSource(200, 2, 'other')).toEqual({buffer: other.buffer, offset: 2, length: 2});
        expect(() => register(new Float64Array([150, 200, 250]), other.lengths, 'raw', [], other))
            .toThrow('Duplicate in-flight term content storage reference');
        expect(database._findInFlightTermContentSource(150, 2, 'raw')).toBeUndefined();
        releaseOther();
        releaseFirst();
    });

    test('preserves unordered and repeated-offset fallback semantics', () => {
        const database = new DictionaryDatabase();
        const source = sourceSpans(database);
        const release = database._registerInFlightTermContentSources(new Float64Array([300, 100, 200]), source.lengths, 'raw', [], source);
        expect(database._findInFlightTermContentSource(100, 2, 'raw')).toEqual({buffer: source.buffer, offset: 2, length: 2});
        release();
        expect(() => database._registerInFlightTermContentSources(new Float64Array([100, 200, 100]), source.lengths, 'raw', [], source)).toThrow('Duplicate in-flight term content storage reference');
        expect(database._findInFlightTermContentSource(100, 2, 'raw')).toBeUndefined();
    });

    test.each([-1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid persisted offset %s without registering a partial batch', (offset) => {
        const database = new DictionaryDatabase();
        const source = sourceSpans(database);
        expect(() => database._registerInFlightTermContentSources(new Float64Array([100, 200, offset]), source.lengths, 'raw', [], source)).toThrow('Invalid in-flight term content source at index 2');
        expect(database._findInFlightTermContentSource(100, 2, 'raw')).toBeUndefined();
    });

    test.each(['offset-past-end', 'length-past-end', 'length-mismatch', 'short-offsets', 'short-lengths'])('rejects malformed source spans: %s', (kind) => {
        const database = new DictionaryDatabase();
        const source = sourceSpans(database);
        const persistedLengths = new Uint32Array([2, 2, 2]);
        if (kind === 'offset-past-end') { source.offsets[2] = 7; }
        if (kind === 'length-past-end') { source.offsets[2] = 5; }
        if (kind === 'length-mismatch') { persistedLengths[2] = 1; }
        if (kind === 'short-offsets') { source.offsets = source.offsets.subarray(0, 2); }
        if (kind === 'short-lengths') { source.lengths = source.lengths.subarray(0, 2); }
        expect(() => database._registerInFlightTermContentSources(new Float64Array([100, 200, 300]), persistedLengths, 'raw', [], source)).toThrow('Invalid in-flight term content source at index 2');
        expect(database._findInFlightTermContentSource(100, 2, 'raw')).toBeUndefined();
    });

    test('retains empty spans and treats same-offset different-length sources independently', () => {
        const database = new DictionaryDatabase();
        const source = sourceSpans(database);
        source.lengths[0] = 0;
        const release = database._registerInFlightTermContentSources(new Float64Array([100, 100, 200]), source.lengths, 'raw', [], source);
        expect(database._findInFlightTermContentSource(100, 0, 'raw')).toEqual({buffer: source.buffer, offset: 0, length: 0});
        expect(database._findInFlightTermContentSource(100, 2, 'raw')).toEqual({buffer: source.buffer, offset: 2, length: 2});
        release();
    });

    test.each(['offsets', 'lengths', 'both-lengths'])('rejects missing values hidden by a shadowed typed-array length: %s', (kind) => {
        const database = new DictionaryDatabase();
        const source = sourceSpans(database);
        let persistedLengths = new Uint32Array([2, 2, 2]);
        if (kind === 'offsets') {
            source.offsets = source.offsets.subarray(0, 2);
            Object.defineProperty(source.offsets, 'length', {value: 3});
        } else {
            source.lengths = source.lengths.subarray(0, 2);
            Object.defineProperty(source.lengths, 'length', {value: 3});
            if (kind === 'both-lengths') {
                persistedLengths = persistedLengths.subarray(0, 2);
                Object.defineProperty(persistedLengths, 'length', {value: 3});
            }
        }
        expect(() => database._registerInFlightTermContentSources(new Float64Array([100, 200, 300]), persistedLengths, 'raw', [], source)).toThrow('Invalid in-flight term content source at index 2');
        expect(database._findInFlightTermContentSource(100, 2, 'raw')).toBeUndefined();
    });

    test.each(['persisted-offset-buffer', 'persisted-length-buffer', 'source-offset-buffer', 'source-length-buffer', 'source-offset-length', 'source-length-length'])('does not add getter reads for %s', (kind) => {
        const database = new DictionaryDatabase();
        const source = sourceSpans(database);
        const persistedOffsets = new Float64Array([100, 200, 300]);
        const persistedLengths = new Uint32Array([2, 2, 2]);
        /** @type {Float64Array|Uint32Array} */
        let view = source.lengths;
        if (kind.startsWith('persisted-offset')) {
            view = persistedOffsets;
        } else if (kind.startsWith('persisted-length')) {
            view = persistedLengths;
        } else if (kind.startsWith('source-offset')) {
            view = source.offsets;
        }
        const property = kind.endsWith('-buffer') ? 'buffer' : 'length';
        Object.defineProperty(view, property, {get: () => { throw new Error('Unexpected metadata getter'); }});
        const release = database._registerInFlightTermContentSources(persistedOffsets, persistedLengths, 'raw', [], source);
        expect(database._findInFlightTermContentSource(200, 2, 'raw')).toEqual({buffer: source.buffer, offset: 2, length: 2});
        release();
    });

    test('does not read a new buffer getter on typed-array subclasses', () => {
        class Offsets extends Float64Array {
            /** @returns {ArrayBuffer} */
            get buffer() { throw new Error('Unexpected inherited metadata getter'); }
        }
        const database = new DictionaryDatabase();
        const source = sourceSpans(database);
        const release = database._registerInFlightTermContentSources(new Offsets([100, 200, 300]), source.lengths, 'raw', [], source);
        expect(database._findInFlightTermContentSource(200, 2, 'raw')).toEqual({buffer: source.buffer, offset: 2, length: 2});
        release();
    });

    test.each(['buffer', 'offsets', 'lengths'])('retains ordinary reads for a Proxy with misleading %s descriptors', (property) => {
        const database = new DictionaryDatabase();
        const source = sourceSpans(database);
        const invalid = {
            buffer: new Uint8Array(0),
            offsets: new Uint32Array([0, 2, 99]),
            lengths: new Uint32Array([2, 2, 99]),
        };
        const proxy = new Proxy(source, {
            get(target, key, receiver) {
                return key === property ? Reflect.get(invalid, key) : Reflect.get(target, key, receiver);
            },
        });
        expect(() => database._registerInFlightTermContentSources(new Float64Array([100, 200, 300]), source.lengths, 'raw', [], proxy))
            .toThrow('Invalid in-flight term content source');
        expect(database._findInFlightTermContentSource(100, 2, 'raw')).toBeUndefined();
    });

    test('does not inspect descriptors through a transparent Proxy', () => {
        const database = new DictionaryDatabase();
        const source = sourceSpans(database);
        const proxy = new Proxy(source, {
            getOwnPropertyDescriptor() { throw new Error('Unexpected Proxy descriptor read'); },
        });
        const release = database._registerInFlightTermContentSources(new Float64Array([100, 200, 300]), source.lengths, 'raw', [], proxy);
        expect(database._findInFlightTermContentSource(200, 2, 'raw')).toEqual({buffer: source.buffer, offset: 2, length: 2});
        release();
    });

    test('retains per-row accessor behavior on a changed factory object', () => {
        const database = new DictionaryDatabase();
        const source = sourceSpans(database);
        const offsets = source.offsets;
        let reads = 0;
        Object.defineProperty(source, 'offsets', {
            get() {
                ++reads;
                return reads < 3 ? offsets : new Uint32Array([0, 2, 99]);
            },
        });
        expect(() => database._registerInFlightTermContentSources(new Float64Array([100, 200, 300]), source.lengths, 'raw', [], source))
            .toThrow('Invalid in-flight term content source at index 2');
        expect(reads).toBe(3);
        expect(database._findInFlightTermContentSource(100, 2, 'raw')).toBeUndefined();
    });

    test('keeps caller-created span objects on the ordinary path', () => {
        const database = new DictionaryDatabase();
        const original = sourceSpans(database);
        const source = {...original};
        let reads = 0;
        Object.defineProperty(source, 'offsets', {
            get() {
                ++reads;
                return original.offsets;
            },
        });
        const release = database._registerInFlightTermContentSources(new Float64Array([100, 200, 300]), source.lengths, 'raw', [], source);
        expect(reads).toBe(3);
        release();
    });
});
