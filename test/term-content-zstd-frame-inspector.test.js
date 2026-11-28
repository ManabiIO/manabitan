/* SPDX-License-Identifier: GPL-3.0-or-later */

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import createZstdModule from '../dev/lib/zstd-simd-module.js';
import {test} from 'vitest';
import {beginZstdFrameInspection, advanceZstdFrameInspection, validateZstdFrameInspectionCursor, ZstdFrameInspectionError} from '../ext/js/dictionary/term-content-zstd-frame-inspector.js';

/**
 * @param {number} size
 * @param {{checksum?: boolean, dictionaryId?: number|null, contentBytes?: 0|1|2|4|8, singleSegment?: boolean, window?: number}} [options]
 * @returns {Uint8Array}
 */
function header(size, {checksum = false, dictionaryId = null, contentBytes = 1, singleSegment = true, window = 0} = {}) {
    const contentSizeFlags = {0: 0, 1: 0, 2: 1, 4: 2, 8: 3};
    const flag = contentSizeFlags[contentBytes];
    const dictionaryBytes = dictionaryId === null ? 0 : 4;
    const bytes = new Uint8Array(5 + (singleSegment ? 0 : 1) + dictionaryBytes + contentBytes);
    new DataView(bytes.buffer).setUint32(0, 0xfd2fb528, true);
    bytes[4] = (flag << 6) | (singleSegment ? 32 : 0) | (checksum ? 4 : 0) | (dictionaryId === null ? 0 : 3);
    let cursor = 5;
    if (!singleSegment) { bytes[cursor++] = window; }
    if (dictionaryId !== null) {
        new DataView(bytes.buffer).setUint32(cursor, dictionaryId, true);
        cursor += 4;
    }
    let value = BigInt(contentBytes === 2 ? size - 256 : size);
    for (let index = 0; index < contentBytes; ++index) {
        bytes[cursor++] = Number(value & 255n);
        value >>= 8n;
    }
    return bytes;
}
/**
 * @param {number} kind
 * @param {number} size
 * @param {boolean} [last]
 * @returns {Uint8Array}
 */
function block(kind, size, last = true) {
    const bits = (size << 3) | (kind << 1) | (last ? 1 : 0);
    return new Uint8Array([bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255]);
}
/**
 * @param {...Uint8Array} items
 * @returns {Uint8Array}
 */
function concat(...items) {
    const output = new Uint8Array(items.reduce((sum, item) => sum + item.byteLength, 0));
    let cursor = 0;
    for (const item of items) {
        output.set(item, cursor);
        cursor += item.byteLength;
    }
    return output;
}
/**
 * @param {Uint8Array} bytes
 * @param {number} [base]
 * @returns {{read: (offset: number, length: number) => Promise<Uint8Array>, calls: Array<{offset: number, length: number}>}}
 */
function reader(bytes, base = 0) {
    /** @type {Array<{offset: number, length: number}>} */
    const calls = [];
    /**
     * @param {number} offset
     * @param {number} length
     * @returns {Promise<Uint8Array>}
     */
    const read = async (offset, length) => {
        calls.push({offset, length});
        return bytes.slice(offset - base, offset - base + length);
    };
    return {read, calls};
}
/**
 * @param {Uint8Array} bytes
 * @param {{expectedDecodedLength?: number, signal?: AbortSignal, assertCurrent?: () => void}} [options]
 * @param {number} [base]
 * @returns {Promise<{read: (offset: number, length: number) => Promise<Uint8Array>, calls: Array<{offset: number, length: number}>, initial: import('../ext/js/dictionary/term-content-zstd-frame-inspector.js').ZstdFrameInspectionCursor, result: {cursor: import('../ext/js/dictionary/term-content-zstd-frame-inspector.js').ZstdFrameInspectionCursor, sourceStoredLength: number|null}}>}
 */
async function inspect(bytes, options = {}, base = 0) {
    const f = reader(bytes, base);
    const initial = await beginZstdFrameInspection(f.read, base, base + bytes.byteLength, options);
    const result = await advanceZstdFrameInspection(f.read, initial);
    return {...f, initial, result};
}

test('raw and RLE block sizes identify exact stored bytes, including checksum', async () => {
    const raw = concat(header(4), block(0, 4), new Uint8Array([1, 2, 3, 4]));
    const rle = concat(header(100, {checksum: true}), block(1, 100), new Uint8Array([7]), new Uint8Array(4));
    for (const bytes of [raw, rle]) {
        const f = await inspect(bytes);
        assert.equal(f.result.sourceStoredLength, bytes.byteLength);
        assert.equal(f.result.cursor.complete, true);
        assert.equal(f.calls.length, 2);
        assert.ok(f.calls.every(({length}) => length <= 18));
    }
});

test('two-byte content size has the specified 256 bias and dictionaries retain unsigned IDs', async () => {
    const bytes = concat(header(256, {contentBytes: 2, dictionaryId: 0xfedcba98}), block(1, 256), new Uint8Array([0]));
    const f = await inspect(bytes, {expectedDecodedLength: 256});
    assert.equal(f.initial.decodedLength, 256);
    assert.equal(f.initial.dictionaryId, 0xfedcba98);
    await assert.rejects(() => inspect(bytes, {expectedDecodedLength: 255}), ZstdFrameInspectionError);
});

test('eight-byte content size and logical addresses above 32 bits stay exact', async () => {
    const base = 2 ** 45 + 19;
    const bytes = concat(header(2 ** 34 + 7, {contentBytes: 8}), block(2, 4), new Uint8Array(4));
    const f = await inspect(bytes, {}, base);
    assert.equal(f.initial.decodedLength, 2 ** 34 + 7);
    assert.equal(f.result.sourceStoredLength, bytes.length);
    assert.equal(f.result.cursor.nextOffset, base + bytes.length);
});

test('absent content sizes use a supplied canonical hint and preserve an unknown length otherwise', async () => {
    const bytes = concat(header(0, {contentBytes: 0, singleSegment: false}), block(0, 4), new Uint8Array(4));
    const known = await inspect(bytes, {expectedDecodedLength: 4});
    const unknown = await inspect(bytes);
    assert.equal(known.initial.decodedLength, 4);
    assert.equal(unknown.initial.decodedLength, null);
    assert.equal(known.initial.windowSize, 1024);
});

test('header-only inspection advances bounded pages with deterministic JSON restart replay', async () => {
    const payload = concat(header(3), block(0, 1, false), new Uint8Array([1]), block(0, 1, false), new Uint8Array([2]), block(0, 1), new Uint8Array([3]));
    const f = reader(payload);
    const initial = await beginZstdFrameInspection(f.read, 0, payload.length);
    const saved = JSON.stringify(initial);
    const first = await advanceZstdFrameInspection(f.read, initial, {maxBlockHeaders: 1});
    const replay = await advanceZstdFrameInspection(f.read, JSON.parse(saved), {maxBlockHeaders: 1});
    assert.deepEqual(first, replay);
    assert.equal(JSON.stringify(initial), saved);
    assert.equal(first.sourceStoredLength, null);
    const second = await advanceZstdFrameInspection(f.read, JSON.parse(JSON.stringify(first.cursor)), {maxBlockHeaders: 1});
    const third = await advanceZstdFrameInspection(f.read, second.cursor, {maxBlockHeaders: 1});
    assert.equal(third.sourceStoredLength, payload.length);
    assert.equal(third.cursor.blocks, 3);
    assert.ok(JSON.stringify(third.cursor).length < 1024);
});

test('current-source truncation, reserved bits and block types reject before accepting a span', async () => {
    const valid = concat(header(4), block(0, 4), new Uint8Array(4));
    for (let length = 0; length < valid.length; ++length) { await assert.rejects(() => inspect(valid.slice(0, length))); }
    const reserved = new Uint8Array(valid); reserved[4] |= 8;
    await assert.rejects(() => inspect(reserved), ZstdFrameInspectionError);
    const badBlock = concat(header(4), block(3, 4), new Uint8Array(4));
    await assert.rejects(() => inspect(badBlock), ZstdFrameInspectionError);
    const oversized = concat(header(1), block(0, 4), new Uint8Array(4));
    await assert.rejects(() => inspect(oversized), ZstdFrameInspectionError);
});

test('foreground preemption after an awaited header read does not advance the caller checkpoint', async () => {
    const bytes = concat(header(4), block(0, 4), new Uint8Array(4));
    const f = reader(bytes);
    const initial = await beginZstdFrameInspection(f.read, 0, bytes.length);
    const saved = JSON.stringify(initial);
    const controller = new AbortController();
    /**
     * @param {number} offset
     * @param {number} length
     * @returns {Promise<Uint8Array>}
     */
    const read = async (offset, length) => {
        const result = await f.read(offset, length);
        controller.abort();
        return result;
    };
    await assert.rejects(() => advanceZstdFrameInspection(read, initial, {signal: controller.signal}), {name: 'AbortError'});
    assert.equal(JSON.stringify(initial), saved);
});

test('temporary read failures retain their identity and a replay can recover', async () => {
    const bytes = concat(header(4), block(0, 4), new Uint8Array(4));
    const f = reader(bytes);
    const initial = await beginZstdFrameInspection(f.read, 0, bytes.length);
    const temporary = new Error('Temporary OPFS failure');
    await assert.rejects(() => advanceZstdFrameInspection(async () => { throw temporary; }, initial), (error) => error === temporary);
    assert.equal((await advanceZstdFrameInspection(f.read, initial)).sourceStoredLength, bytes.length);
});

test('checkpoint validation rejects accessors without evaluating them', () => {
    let touched = false;
    const data = {version: 1,
        frameOffset: 0,
        logicalHighWater: 20,
        nextOffset: 6,
        blocks: 0,
        decodedLength: 4,
        windowSize: 4,
        dictionaryId: 0,
        checksum: false,
        complete: false};
    Object.defineProperty(data, 'complete', {
        get() {
            touched = true;
            return false;
        },
        enumerable: true,
    });
    assert.throws(() => validateZstdFrameInspectionCursor(data), TypeError);
    assert.equal(touched, false);
});


/**
 * @typedef {object} InspectionTestCodec
 * @property {Uint8Array} HEAPU8
 * @property {(bytes: number) => number} _malloc
 * @property {(pointer: number) => void} _free
 * @property {(size: number) => number} _ZSTD_compressBound
 * @property {(destination: number, capacity: number, source: number, bytes: number, level: number) => number} _ZSTD_compress
 * @property {(destination: number, capacity: number, source: number, bytes: number) => number} _ZSTD_decompress
 * @property {(result: number) => number} _ZSTD_isError
 */

test('matches exact stored spans and decoded parity for real current WASM codec frames', async () => {
    const wasmBinary = await readFile(new URL('../dev/data/zstd-simd.wasm', import.meta.url));
    const codec = /** @type {InspectionTestCodec} */ (/** @type {unknown} */ (await createZstdModule({wasmBinary})));
    let checked = 0;
    for (const size of [1, 255, 256, 257, 65536, 131071, 131072, 131073, 1048576]) {
        for (const pattern of ['repeat', 'random', 'structured']) {
            const input = new Uint8Array(size);
            const phrase = new TextEncoder().encode('[{"content":"日本語の意味と読み方","tag":"div"}]');
            let random = 0x12345678;
            for (let index = 0; index < size; ++index) {
                random ^= random << 13;
                random ^= random >>> 17;
                random ^= random << 5;
                input[index] = pattern === 'repeat' ? 7 : (pattern === 'random' ? random & 255 : phrase[index % phrase.length]);
            }
            let source = 0;
            let destination = 0;
            let decoded = 0;
            try {
                source = codec._malloc(size);
                const capacity = codec._ZSTD_compressBound(size);
                destination = codec._malloc(capacity);
                decoded = codec._malloc(size);
                assert.ok(source !== 0 && destination !== 0 && decoded !== 0);
                codec.HEAPU8.set(input, source);
                const storedLength = codec._ZSTD_compress(destination, capacity, source, size, 1);
                assert.equal(codec._ZSTD_isError(storedLength), 0);
                const compressed = codec.HEAPU8.slice(destination, destination + storedLength);
                const base = 2 ** 34 + 19;
                const f = reader(concat(compressed, new Uint8Array(137).fill(233)), base);
                let cursor = await beginZstdFrameInspection(f.read, base, base + compressed.length + 137, {expectedDecodedLength: size});
                let observedLength = null;
                while (!cursor.complete) {
                    const step = await advanceZstdFrameInspection(f.read, JSON.parse(JSON.stringify(cursor)), {maxBlockHeaders: 2});
                    cursor = step.cursor;
                    observedLength = step.sourceStoredLength;
                }
                assert.equal(observedLength, storedLength);
                assert.equal(cursor.decodedLength, size);
                assert.ok(f.calls.every(({length}) => length <= 18));
                const decodedLength = codec._ZSTD_decompress(decoded, size, destination, storedLength);
                assert.equal(codec._ZSTD_isError(decodedLength), 0);
                assert.equal(decodedLength, size);
                assert.deepEqual(codec.HEAPU8.slice(decoded, decoded + size), input);
                ++checked;
            } finally {
                if (decoded !== 0) { codec._free(decoded); }
                if (destination !== 0) { codec._free(destination); }
                if (source !== 0) { codec._free(source); }
            }
        }
    }
    assert.equal(checked, 27);
});
