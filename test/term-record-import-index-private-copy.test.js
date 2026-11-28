/* SPDX-License-Identifier: GPL-3.0-or-later */

import {afterEach, describe, expect, test, vi} from 'vitest';
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js';
import {prepareImportIndexChunkParts} from '../ext/js/dictionary/term-record-import-index-chunk.js';
import {createImportIndexChunkFixture} from './util/import-index-chunk-fixture.js';

/** @typedef {Awaited<ReturnType<typeof createImportIndexChunkFixture>>} Fixture */
/** @typedef {Parameters<TermRecordOpfsStore['_createPendingLookupIndexChunk']>} EnvelopeArguments */

/**
 * @param {Fixture} fixture
 * @returns {EnvelopeArguments}
 */
function envelopeArguments(fixture) {
    const {encoded, chunk} = fixture;
    return [1, chunk.rowCount, encoded.contentOffsetBase, encoded.lookupIndexBytes, encoded.recordFields, encoded.recordFieldsFormat];
}

/**
 * Compare observable eager behavior, including errors and getter/coercion order.
 * @param {() => unknown} callback
 * @returns {unknown}
 */
function capture(callback) {
    try { return callback(); } catch (error) {
        if (!(error instanceof Error)) { throw error; }
        return {name: error.name, message: error.message};
    }
}

afterEach(() => { vi.restoreAllMocks(); });

describe('private copies for heavy import index hashing', () => {
    test.each([[1, -7], [128, 0], [128, 1.5], [128, -1000.25]])('matches eager bytes for %i rows and score %s', async (rowCount, score) => {
        const fixture = await createImportIndexChunkFixture(rowCount, score);
        const sourcePayload = new Uint8Array(fixture.encoded.lookupIndexBytes);
        const sourceFields = new Uint8Array(fixture.encoded.recordFields);
        const deferred = fixture.adopt();
        expect(deferred).not.toBeInstanceOf(Uint8Array);
        if (deferred instanceof Uint8Array) { throw new Error('Expected private parts'); }
        const parts = [deferred.header, deferred.payload, deferred.recordFields];
        expect(new Set(parts.map((part) => part.buffer)).size).toBe(3);
        expect(parts.every((part) => part.byteOffset === 0 && part.byteLength === part.buffer.byteLength)).toBe(true);
        expect(parts.reduce((total, part) => total + part.buffer.byteLength, 0)).toBe(fixture.expected.byteLength);
        expect(deferred.payload.buffer).not.toBe(fixture.encoded.lookupIndexBytes.buffer);
        expect(deferred.recordFields.buffer).not.toBe(fixture.encoded.recordFields.buffer);
        expect(deferred.header.slice(24, 36)).toEqual(new Uint8Array(12));
        expect(Buffer.concat(prepareImportIndexChunkParts([deferred]))).toEqual(Buffer.from(fixture.expected));
        expect(fixture.encoded.lookupIndexBytes).toEqual(sourcePayload);
        expect(fixture.encoded.recordFields).toEqual(sourceFields);
    });

    test('copies exactly P+F bytes with set and never invokes Uint8Array.from', async () => {
        const fixture = await createImportIndexChunkFixture();
        const set = vi.spyOn(Uint8Array.prototype, 'set');
        const from = vi.spyOn(Uint8Array, 'from').mockImplementation(() => { throw new Error('Iterator-based copy is forbidden'); });
        const deferred = fixture.adopt();
        const calls = [...set.mock.calls];
        set.mockRestore();
        from.mockRestore();
        expect(deferred).not.toBeInstanceOf(Uint8Array);
        expect(calls).toHaveLength(2);
        expect(calls.map(([source]) => source)).toEqual([fixture.encoded.lookupIndexBytes, fixture.encoded.recordFields]);
        expect(Buffer.concat(prepareImportIndexChunkParts([deferred]))).toEqual(Buffer.from(fixture.expected));
    });

    test('preserves unknown aliases and snapshots before callers mutate either input', async () => {
        const fixture = await createImportIndexChunkFixture();
        const payload = fixture.encoded.lookupIndexBytes;
        const fields = fixture.encoded.recordFields;
        const alias = {nested: {payload: payload.subarray(0), fields: new DataView(fields.buffer)}};
        const deferred = fixture.adopt();
        expect(payload.byteLength).toBeGreaterThan(0);
        expect(fields.byteLength).toBeGreaterThan(0);
        alias.nested.payload.fill(0xff);
        alias.nested.fields.setUint32(0, 0xffffffff, true);
        expect(Buffer.concat(prepareImportIndexChunkParts([deferred]))).toEqual(Buffer.from(fixture.expected));
        expect(payload[0]).toBe(0xff);
        expect(alias.nested.fields.getUint32(0, true)).toBe(0xffffffff);
    });

    test('copies ordinary offset views sharing one backing buffer without consuming either view', async () => {
        const fixture = await createImportIndexChunkFixture();
        const args = envelopeArguments(fixture);
        const fields = fixture.encoded.recordFields;
        const payload = fixture.encoded.lookupIndexBytes;
        const backing = new ArrayBuffer(8 + payload.byteLength + fields.byteLength);
        args[3] = new Uint8Array(backing, 4, payload.byteLength);
        args[4] = new Uint8Array(backing, 4 + payload.byteLength, fields.byteLength);
        args[3].set(payload);
        args[4].set(fields);
        const deferred = fixture.store._createPendingLookupIndexChunk(...args);
        expect(deferred).not.toBeInstanceOf(Uint8Array);
        new Uint8Array(backing).fill(7);
        expect(backing.byteLength).toBe(8 + payload.byteLength + fields.byteLength);
        expect(Buffer.concat(prepareImportIndexChunkParts([deferred]))).toEqual(Buffer.from(fixture.expected));
    });

    test('does not inspect mutable parser, consumer or projected-media metadata', async () => {
        const fixture = await createImportIndexChunkFixture();
        let reads = 0;
        for (const [target, name] of /** @type {[object, string][]} */ ([
            [fixture.prepared, 'routeFilter'],
            [fixture.prepared, 'preinternedPlan'],
            [fixture.chunk, 'preparedLookupIndexes'],
            [fixture.chunk, 'mediaRows'],
            [fixture.consumer, 'resolvedContentReferences'],
            [fixture.consumer, 'termRecordPreinternedPlan'],
        ])) {
            Object.defineProperty(target, name, {configurable: true,
                get() {
                    ++reads;
                    throw new Error('Unrelated metadata read');
                }});
        }
        const deferred = fixture.adopt();
        expect(deferred).not.toBeInstanceOf(Uint8Array);
        expect(Buffer.concat(prepareImportIndexChunkParts([deferred]))).toEqual(Buffer.from(fixture.expected));
        expect(reads).toBe(0);
    });

    test.each(['inactive', 'small', 'unknown'])('retains the eager envelope for %s imports', async (kind) => {
        const fixture = await createImportIndexChunkFixture();
        if (kind === 'inactive') { Reflect.set(fixture.store, '_importSessionActive', false); }
        if (kind === 'small') { fixture.store.setRawTermBankSourceBytes(1024 ** 3 - 1); }
        if (kind === 'unknown') { fixture.store.setRawTermBankSourceBytes(null); }
        const value = fixture.adopt();
        expect(value).toBeInstanceOf(Uint8Array);
        expect(value).toEqual(fixture.expected);
        expect(fixture.encoded.lookupIndexBytes.byteLength).toBeGreaterThan(0);
        expect(fixture.encoded.recordFields.byteLength).toBeGreaterThan(0);
    });

    test.each(['payload', 'fields'])('validates %s synchronously and preserves field error precedence', async (kind) => {
        const fixture = await createImportIndexChunkFixture();
        const args = envelopeArguments(fixture);
        args[3][0] ^= 1;
        if (kind === 'fields') { args[4] = new Uint8Array(); }
        const expected = capture(() => fixture.store._createLookupIndexChunk(...args));
        expect(capture(() => fixture.store._createPendingLookupIndexChunk(...args))).toEqual(expected);
        expect(expected).toMatchObject({name: 'Error', message: expect.stringMatching(kind === 'fields' ? /term-record fields/ : /persisted term lookup index/)});
        expect(fixture.encoded.lookupIndexBytes.byteLength).toBeGreaterThan(0);
        expect(fixture.encoded.recordFields.byteLength).toBeGreaterThan(0);
    });

    test.each(['shared', 'forged-shared', 'resizable'])('retains eager behavior for %s backing', async (kind) => {
        for (const position of [3, 4]) {
            const fixture = await createImportIndexChunkFixture();
            const args = envelopeArguments(fixture);
            const source = position === 3 ? fixture.encoded.lookupIndexBytes : fixture.encoded.recordFields;
            const backing = kind === 'resizable' ?
                /** @type {ArrayBuffer} */ (Reflect.construct(ArrayBuffer, [source.byteLength, {maxByteLength: source.byteLength * 2}])) :
                new SharedArrayBuffer(source.byteLength);
            const replacement = new Uint8Array(backing);
            replacement.set(source);
            if (kind === 'forged-shared') { Object.setPrototypeOf(backing, ArrayBuffer.prototype); }
            if (position === 3) {
                args[3] = replacement;
            } else {
                args[4] = replacement;
            }
            const expected = fixture.store._createLookupIndexChunk(...args);
            const value = fixture.store._createPendingLookupIndexChunk(...args);
            expect(value).toBeInstanceOf(Uint8Array);
            expect(value).toEqual(expected);
            expect(replacement.byteLength).toBe(source.byteLength);
        }
    });

    test.each(['payload', 'fields'])('does not add getter reads for shadowed %s views', async (kind) => {
        for (const name of ['buffer', 'byteOffset', 'byteLength', 'length', 'constructor', 'subarray', 'slice', 'set', Symbol.iterator]) {
            const fixture = await createImportIndexChunkFixture();
            const args = envelopeArguments(fixture);
            const target = kind === 'payload' ? fixture.encoded.lookupIndexBytes : fixture.encoded.recordFields;
            const value = Reflect.get(target, name);
            /** @type {(string|symbol)[]} */
            const reads = [];
            Object.defineProperty(target, name, {configurable: true,
                get() {
                    reads.push(name);
                    return value;
                }});
            const eager = capture(() => fixture.store._createLookupIndexChunk(...args));
            const expectedReads = reads.splice(0);
            const actual = capture(() => fixture.store._createPendingLookupIndexChunk(...args));
            expect(actual).toEqual(eager);
            expect(reads).toEqual(expectedReads);
        }
    });

    test.each(['byteLength', 'resizable', 'maxByteLength', 'constructor', 'transfer', 'transferToFixedLength'])('does not read a backing-buffer %s accessor during admission', async (name) => {
        const fixture = await createImportIndexChunkFixture();
        const args = envelopeArguments(fixture);
        const backing = fixture.encoded.lookupIndexBytes.buffer;
        const value = Reflect.get(backing, name);
        let reads = 0;
        Object.defineProperty(backing, name, {configurable: true,
            get() {
                ++reads;
                return value;
            }});
        const eager = capture(() => fixture.store._createLookupIndexChunk(...args));
        const expectedReads = reads;
        reads = 0;
        expect(capture(() => fixture.store._createPendingLookupIndexChunk(...args))).toEqual(eager);
        expect(reads).toBe(expectedReads);
    });

    test.each([3, 4])('rejects a Proxy at input %s without adding traps before eager fallback', async (position) => {
        const fixture = await createImportIndexChunkFixture();
        const args = envelopeArguments(fixture);
        const source = position === 3 ? fixture.encoded.lookupIndexBytes : fixture.encoded.recordFields;
        /** @type {string[]} */
        const calls = [];
        const replacement = new Proxy(source, {
            get(target, key) { calls.push(`get:${String(key)}`); return Reflect.get(target, key); },
            getPrototypeOf(target) { calls.push('getPrototypeOf'); return Reflect.getPrototypeOf(target); },
        });
        if (position === 3) {
            args[3] = replacement;
        } else {
            args[4] = replacement;
        }
        const eager = capture(() => fixture.store._createLookupIndexChunk(...args));
        const expectedCalls = calls.splice(0);
        expect(capture(() => fixture.store._createPendingLookupIndexChunk(...args))).toEqual(eager);
        expect(calls).toEqual(expectedCalls);
    });

    test.each([0, 1, 2, 5])('preserves coercion/error order for nonprimitive argument %s', async (position) => {
        const fixture = await createImportIndexChunkFixture(1);
        const args = envelopeArguments(fixture);
        const original = /** @type {number} */ (args[position]);
        /** @type {string[]} */
        const calls = [];
        args[position] = /** @type {never} */ ({[Symbol.toPrimitive](/** @type {string} */ hint) {
            calls.push(hint);
            return original;
        }});
        const eager = capture(() => fixture.store._createLookupIndexChunk(...args));
        const expectedCalls = calls.splice(0);
        expect(capture(() => fixture.store._createPendingLookupIndexChunk(...args))).toEqual(eager);
        expect(calls).toEqual(expectedCalls);
    });

    test.each(['_encodeArtifactRecordFields', '_encodeArtifactChunkRecords', '_appendEncodedChunk', '_createLookupIndexChunk'])('preserves original-method guards for %s', async (name) => {
        const fixture = await createImportIndexChunkFixture();
        const original = /** @type {(...args: unknown[]) => unknown} */ (Reflect.get(fixture.store, name));
        let calls = 0;
        Reflect.set(fixture.store, name, (/** @type {unknown[]} */ ...args) => {
            ++calls;
            return Reflect.apply(original, fixture.store, args);
        });
        expect(fixture.adopt()).toEqual(fixture.expected);
        expect(calls).toBe(name === '_createLookupIndexChunk' ? 1 : 0);
    });

    test.each(['_encodeArtifactRecordFields', '_encodeArtifactChunkRecords', '_appendEncodedChunk'])('declines late %s accessors without invoking them', async (name) => {
        const fixture = await createImportIndexChunkFixture();
        let reads = 0;
        Object.defineProperty(fixture.store, name, {get() {
            ++reads;
            throw new Error('Method getter must not run');
        }});
        expect(fixture.adopt()).toEqual(fixture.expected);
        expect(reads).toBe(0);
    });

    test.each(['_importSessionActive', '_rawTermBankSourceBytes'])('does not add a %s state getter read', async (name) => {
        const fixture = await createImportIndexChunkFixture();
        let reads = 0;
        Object.defineProperty(fixture.store, name, {get() {
            ++reads;
            throw new Error('State getter must not run');
        }});
        expect(fixture.adopt()).toEqual(fixture.expected);
        expect(reads).toBe(0);
    });

    test.each(['DataView', 'Uint16Array'])('does not infer Uint8Array elements from a forged %s prototype', async (kind) => {
        const fixture = await createImportIndexChunkFixture(1);
        const args = envelopeArguments(fixture);
        const original = fixture.encoded.lookupIndexBytes;
        const backing = new ArrayBuffer(original.byteLength);
        new Uint8Array(backing).set(original);
        const forged = kind === 'DataView' ? new DataView(backing) : new Uint16Array(backing);
        Object.setPrototypeOf(forged, Uint8Array.prototype);
        args[3] = /** @type {Uint8Array} */ (/** @type {unknown} */ (forged));
        const expected = capture(() => fixture.store._createLookupIndexChunk(...args));
        expect(capture(() => fixture.store._createPendingLookupIndexChunk(...args))).toEqual(expected);
    });

    test('retains the eager envelope for a store subclass', async () => {
        class CustomStore extends TermRecordOpfsStore {}
        const fixture = await createImportIndexChunkFixture();
        const store = new CustomStore();
        store.setRawTermBankSourceBytes(1024 ** 3);
        Reflect.set(store, '_importSessionActive', true);
        expect(store._createPendingLookupIndexChunk(...envelopeArguments(fixture))).toEqual(fixture.expected);
    });
});
