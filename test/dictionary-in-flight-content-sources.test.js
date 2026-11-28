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
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import {describe, expect, test} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';

/** @returns {Promise<{database: DictionaryDatabase, spans: {buffer: Uint8Array, offsets: Uint32Array, lengths: Uint32Array}, offsets: Float64Array}>} */
async function createSources() {
    const database = new DictionaryDatabase();
    const buffer = new Uint8Array(new SharedArrayBuffer(12), 4, 4);
    buffer.set([1, 2, 3, 4]);
    const resolved = await database._resolveArtifactTermContentDedup({
        rowCount: 3,
        contentBytesList: [],
        contentHash1List: [],
        contentHash2List: [],
        contentBytesBuffer: buffer,
        contentBytesBaseOffset: 0,
        contentMetaList: new Uint32Array([0, 2, 10, 20, 2, 0, 11, 21, 2, 2, 12, 22]),
        contentUniqueIndexList: new Uint32Array([0, 1, 2]),
        contentDedupPlan: {
            resolvedFlags: new Uint8Array(3),
            resolvedOffsets: new Float64Array(3),
            resolvedLengths: new Uint32Array(3),
            resolvedDictNames: null,
            pendingEpochs: new Uint32Array(3),
            pendingIndexes: new Uint32Array(3),
            nextEpoch: 1,
            persistedLookupRequired: false,
        },
        contentDictNameList: null,
        uniformContentDictName: 'raw',
    });
    const spans = resolved.pendingContentSpans;
    if (spans === null) { throw new Error('Expected pending source spans'); }
    expect(resolved.pendingContentCount).toBe(3);
    const offsets = new Float64Array([999, 100, 120, 140, 999]).subarray(1, 4);
    spans.offsets = new Uint32Array([999, ...spans.offsets, 999]).subarray(1, 4);
    spans.lengths = new Uint32Array([999, ...spans.lengths, 999]).subarray(1, 4);
    return {database, spans, offsets};
}

/**
 * @param {Awaited<ReturnType<typeof createSources>>} sources
 * @param {string|string[]} [dictNames]
 * @returns {() => void}
 */
function register({database, spans, offsets}, dictNames = 'raw-block-v2:jmdict') {
    return database._registerInFlightTermContentSources(offsets, spans.lengths, dictNames, [], spans);
}

describe('in-flight content source registration', () => {
    test('retains exact sources and sorted bounds for typed subviews including empty content', async () => {
        const sources = await createSources();
        const {database, spans} = sources;
        const unregister = register(sources);
        expect(database._inFlightTermContentSourceBatches.size).toBe(1);
        const [batch] = database._inFlightTermContentSourceBatches;
        expect(batch).toMatchObject({minimumOffset: 100, maximumOffset: 140, sortedOffsets: true});
        expect(batch.contentSpans).toBe(spans);
        expect(batch.offsets).toBe(sources.offsets);
        for (let i = 0; i < 3; ++i) {
            expect(database._findInFlightTermContentSource(sources.offsets[i], spans.lengths[i], 'raw-block-v2:jmdict'))
                .toEqual({buffer: spans.buffer, offset: spans.offsets[i], length: spans.lengths[i]});
        }
        expect(database._findInFlightTermContentSource(120, 1, 'raw-block-v2:jmdict')).toBeUndefined();
        unregister();
        expect(database._inFlightTermContentSourceBatches.size).toBe(0);
    });

    test.each([-1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects malformed final persisted offset %s atomically', async (offset) => {
        const sources = await createSources();
        sources.offsets[2] = offset;
        expect(() => register(sources)).toThrow('Invalid in-flight term content source at index 2');
        expect(sources.database._inFlightTermContentSourceBatches.size).toBe(0);
    });

    test.each([[4, 1], [5, 0], [0xffffffff, 0], [0, 0xffffffff]])('rejects final span %s/%s atomically', async (offset, length) => {
        const sources = await createSources();
        sources.spans.offsets[2] = offset;
        sources.spans.lengths[2] = length;
        expect(() => register(sources)).toThrow('Invalid in-flight term content source at index 2');
        expect(sources.database._inFlightTermContentSourceBatches.size).toBe(0);
    });

    test('accepts a zero-length span at the source boundary and a maximal safe persisted offset', async () => {
        const sources = await createSources();
        sources.spans.offsets[2] = 4;
        sources.spans.lengths[2] = 0;
        sources.offsets[2] = Number.MAX_SAFE_INTEGER;
        const unregister = register(sources);
        expect(sources.database._findInFlightTermContentSource(Number.MAX_SAFE_INTEGER, 0, 'raw-block-v2:jmdict'))
            .toEqual({buffer: sources.spans.buffer, offset: 4, length: 0});
        unregister();
    });

    test('retains zero-valued persisted offsets and empty-batch bounds', async () => {
        const sources = await createSources();
        sources.offsets.set([-0, 20, 40]);
        const unregister = register(sources);
        const [batch] = sources.database._inFlightTermContentSourceBatches;
        expect(Object.is(batch.minimumOffset, -0)).toBe(true);
        expect(sources.database._findInFlightTermContentSource(0, 2, 'raw-block-v2:jmdict')).toBeDefined();
        unregister();
        const unregisterEmpty = sources.database._registerInFlightTermContentSources([], [], 'raw', [], null);
        const [empty] = sources.database._inFlightTermContentSourceBatches;
        expect(empty).toMatchObject({minimumOffset: Infinity, maximumOffset: -Infinity, sortedOffsets: true});
        expect(sources.database._findInFlightTermContentSource(0, 0, 'raw')).toBeUndefined();
        unregisterEmpty();
    });

    test('rejects short columns and mismatched persisted lengths without registering', async () => {
        const sources = await createSources();
        const {database, offsets, spans} = sources;
        expect(() => database._registerInFlightTermContentSources(offsets, spans.lengths.subarray(0, 2), 'raw', [], spans))
            .toThrow('In-flight term content offset and length counts do not match');
        const otherLengths = new Uint32Array(spans.lengths);
        otherLengths[2] = 1;
        expect(() => database._registerInFlightTermContentSources(offsets, otherLengths, 'raw', [], spans))
            .toThrow('Invalid in-flight term content source at index 2');
        spans.offsets = spans.offsets.subarray(0, 2);
        expect(() => register(sources)).toThrow('Invalid in-flight term content source at index 2');
        expect(database._inFlightTermContentSourceBatches.size).toBe(0);
    });

    test('keeps unordered lookup and duplicate detection for the generic path', async () => {
        const sources = await createSources();
        sources.offsets.set([140, 120, 100]);
        const unregister = register(sources);
        const [batch] = sources.database._inFlightTermContentSourceBatches;
        expect(batch).toMatchObject({minimumOffset: 100, maximumOffset: 140, sortedOffsets: false});
        expect(sources.database._findInFlightTermContentSource(100, 2, 'raw-block-v2:jmdict'))
            .toEqual({buffer: sources.spans.buffer, offset: 2, length: 2});
        unregister();
        sources.offsets.set([140, 120, 140]);
        expect(() => register(sources)).toThrow('Duplicate in-flight term content storage reference');
        expect(sources.database._inFlightTermContentSourceBatches.size).toBe(0);
    });

    test('distinguishes equal offsets by length and dictionary and rejects exact active aliases', async () => {
        const sources = await createSources();
        sources.offsets.fill(100);
        const unregister = register(sources, ['first', 'first', 'second']);
        expect(sources.database._findInFlightTermContentSource(100, 0, 'first')).toBeDefined();
        expect(sources.database._findInFlightTermContentSource(100, 2, 'second')).toBeDefined();
        expect(() => register(sources, ['first', 'first', 'second'])).toThrow('Duplicate in-flight term content storage reference');
        expect(sources.database._inFlightTermContentSourceBatches.size).toBe(1);
        unregister();
        expect(() => register(sources, 'first')).toThrow('Duplicate in-flight term content storage reference');
        expect(sources.database._inFlightTermContentSourceBatches.size).toBe(0);
    });

    test.each(['own', 'inherited'])('preserves %s source accessors and their malformed later values', async (kind) => {
        const sources = await createSources();
        const offsets = sources.spans.offsets;
        const invalidOffsets = new Uint32Array([0, 9, 2]);
        let reads = 0;
        const descriptor = {get: () => (++reads === 2 ? invalidOffsets : offsets), configurable: true};
        if (kind === 'own') {
            Object.defineProperty(sources.spans, 'offsets', descriptor);
        } else {
            Reflect.deleteProperty(sources.spans, 'offsets');
            Object.setPrototypeOf(sources.spans, Object.create(null, {offsets: descriptor}));
        }
        expect(() => register(sources)).toThrow('Invalid in-flight term content source at index 1');
        expect(reads).toBe(2);
        expect(sources.database._inFlightTermContentSourceBatches.size).toBe(0);
    });

    test('does not read a shadowed column length in admission', async () => {
        const sources = await createSources();
        let reads = 0;
        Object.defineProperty(sources.offsets, 'length', {get: () => {
            ++reads;
            return 3;
        }});
        const unregister = register(sources);
        expect(reads).toBe(1);
        unregister();
    });

    test('uses intrinsic buffer capabilities without invoking a shadowed resizable getter', async () => {
        const sources = await createSources();
        Object.defineProperty(sources.offsets.buffer, 'resizable', {get: () => {
            throw new Error('Unexpected buffer property access');
        }});
        register(sources)();
        expect(sources.database._inFlightTermContentSourceBatches.size).toBe(0);
    });

    test('preserves source byte-length accessors and rejects their current bounds', async () => {
        const sources = await createSources();
        let reads = 0;
        Object.defineProperty(sources.spans.buffer, 'byteLength', {get: () => (++reads === 3 ? 3 : 4)});
        expect(() => register(sources)).toThrow('Invalid in-flight term content source at index 2');
        expect(reads).toBe(3);
        expect(sources.database._inFlightTermContentSourceBatches.size).toBe(0);
    });

    test('revalidates current values after an await and after a successful earlier registration', async () => {
        const sources = await createSources();
        register(sources)();
        await Promise.resolve();
        sources.spans.lengths[2] = 3;
        expect(() => register(sources)).toThrow('Invalid in-flight term content source at index 2');
        expect(sources.database._inFlightTermContentSourceBatches.size).toBe(0);
    });

    test('retains checks for shared metadata and source proxies', async () => {
        const sources = await createSources();
        const sharedOffsets = new Float64Array(new SharedArrayBuffer(24));
        sharedOffsets.set(sources.offsets);
        sources.offsets = sharedOffsets;
        register(sources)();
        sharedOffsets[2] = Number.NaN;
        expect(() => register(sources)).toThrow('Invalid in-flight term content source at index 2');
        sharedOffsets[2] = 140;
        const sourceSpans = sources.spans;
        sources.spans = new Proxy(sourceSpans, {
            get(target, key) {
                return key === 'offsets' ? new Uint32Array([0, 2, 99]) : Reflect.get(target, key);
            },
        });
        sources.offsets = new Float64Array([100, 120, 140]);
        expect(() => register(sources)).toThrow('Invalid in-flight term content source at index 2');
        expect(sources.database._inFlightTermContentSourceBatches.size).toBe(0);
    });

    test('does not treat a typed-array proxy as an intrinsically bounded source column', async () => {
        const sources = await createSources();
        sources.spans.offsets = new Proxy(sources.spans.offsets, {
            get(target, key) {
                return key === '2' ? 99 : Reflect.get(target, key, target);
            },
        });
        expect(() => register(sources)).toThrow('Invalid in-flight term content source at index 2');
        expect(sources.database._inFlightTermContentSourceBatches.size).toBe(0);
    });

    test('rejects source-column proxies before invoking prototype traps that can hide malformed values', async () => {
        const sources = await createSources();
        const offsets = sources.spans.offsets;
        offsets[2] = 99;
        let prototypeReads = 0;
        sources.spans.offsets = new Proxy(offsets, {
            getPrototypeOf(target) {
                ++prototypeReads;
                target[2] = 0;
                return Reflect.getPrototypeOf(target);
            },
            get(target, key) {
                return Reflect.get(target, key, target);
            },
        });
        expect(() => register(sources)).toThrow('Invalid in-flight term content source at index 2');
        expect(prototypeReads).toBe(0);
        expect(sources.database._inFlightTermContentSourceBatches.size).toBe(0);
    });

    test('does not infer unsigned elements from a forged typed-array prototype', async () => {
        const sources = await createSources();
        const offsets = new Int32Array([0, 2, -1]);
        Object.setPrototypeOf(offsets, Uint32Array.prototype);
        Reflect.set(sources.spans, 'offsets', offsets);
        expect(() => register(sources)).toThrow('Invalid in-flight term content source at index 2');
        expect(sources.database._inFlightTermContentSourceBatches.size).toBe(0);
    });

    test('does not traverse a typed-array prototype proxy during optional admission', async () => {
        const sources = await createSources();
        const offsets = sources.spans.offsets;
        offsets[2] = 99;
        let prototypeReads = 0;
        Object.setPrototypeOf(offsets, new Proxy(Uint32Array.prototype, {
            getPrototypeOf(target) {
                ++prototypeReads;
                offsets[2] = 0;
                return Reflect.getPrototypeOf(target);
            },
        }));
        expect(() => register(sources)).toThrow('Invalid in-flight term content source at index 2');
        expect(prototypeReads).toBe(0);
        expect(sources.database._inFlightTermContentSourceBatches.size).toBe(0);
    });

    test('does not traverse backing-buffer prototype proxies during optional admission', async () => {
        const sources = await createSources();
        sources.offsets[2] = -1;
        let prototypeReads = 0;
        Object.setPrototypeOf(sources.offsets.buffer, new Proxy(ArrayBuffer.prototype, {
            getPrototypeOf(target) {
                ++prototypeReads;
                sources.offsets[2] = 140;
                return Reflect.getPrototypeOf(target);
            },
        }));
        expect(() => register(sources)).toThrow('Invalid in-flight term content source at index 2');
        expect(prototypeReads).toBe(0);
        expect(sources.database._inFlightTermContentSourceBatches.size).toBe(0);
    });

    test('keeps shared metadata generic even when its buffer has an ArrayBuffer prototype', async () => {
        const sources = await createSources();
        const sharedBuffer = new SharedArrayBuffer(12);
        const lengths = new Uint32Array(sharedBuffer);
        lengths.set(sources.spans.lengths);
        Object.setPrototypeOf(sharedBuffer, ArrayBuffer.prototype);
        sources.spans.lengths = lengths;
        const unregister = register(sources);
        expect(sources.database._inFlightTermContentSourceBatches.size).toBe(1);
        unregister();
        lengths[2] = 3;
        expect(() => register(sources)).toThrow('Invalid in-flight term content source at index 2');
        expect(sources.database._inFlightTermContentSourceBatches.size).toBe(0);
    });
});
