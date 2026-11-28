/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test} from 'vitest'
import {
    canTakeOwnedTermLookupIndex,
    registerOwnedTermLookupIndexes,
    registerOwnedTermRecordFields,
    takeOwnedTermLookupIndex,
} from '../ext/js/dictionary/term-lookup-index-ownership.js'
import {createImportIndexChunkFixture, getImportIndexChunkParts} from './util/import-index-chunk-fixture.js'

/**
 * @param {Uint8Array[]} parts
 * @returns {Uint8Array}
 */
function concatenate(parts) {
    const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
    let offset = 0
    for (const part of parts) {
        result.set(part, offset)
        offset += part.byteLength
    }
    return result
}

describe('local owned import index envelopes', () => {
    test.each([
        {rows: 2, score: -17, format: 1},
        {rows: 128, score: 9, format: 2},
        {rows: 128, score: -0.25, format: 3},
    ])('preserves format $format bytes and large content offsets while consuming only witnessed buffers', async ({rows, score, format}) => {
        const fixture = await createImportIndexChunkFixture(rows, score)
        const {prepared, encoded, expected, chunk} = fixture
        const originalKeys = Uint8Array.from(chunk.termRecordPreinternedPlan.stringsBuffer)
        const payload = prepared.bytes
        const fields = encoded.recordFields
        expect(encoded.recordFieldsFormat).toBe(format)
        const pending = fixture.adopt()
        expect(pending).not.toBeInstanceOf(Uint8Array)
        expect(payload.byteLength).toBe(0)
        expect(fields.byteLength).toBe(0)
        expect(chunk.termRecordPreinternedPlan.stringsBuffer).toEqual(originalKeys)
        expect(canTakeOwnedTermLookupIndex(prepared, payload, fields)).toBe(false)
        expect(concatenate(getImportIndexChunkParts([pending]))).toEqual(expected)
        expect(() => takeOwnedTermLookupIndex(prepared, payload, fields)).toThrow('ownership')
    })

    test('ordinary caller buffers retain eager snapshot and lifetime behavior', async () => {
        const fixture = await createImportIndexChunkFixture(128, 0, false)
        const pending = fixture.adopt()
        expect(pending).toBeInstanceOf(Uint8Array)
        expect(fixture.prepared.bytes.byteLength).toBeGreaterThan(0)
        expect(fixture.encoded.recordFields.byteLength).toBeGreaterThan(0)
        fixture.prepared.bytes.fill(0)
        fixture.encoded.recordFields.fill(0)
        expect(pending).toEqual(fixture.expected)
    })

    test.each(['inactive', 'worker-source', 'unknown-source'])('retains local caller ownership for $0 routes', async (route) => {
        const fixture = await createImportIndexChunkFixture()
        if (route === 'inactive') {
            Reflect.set(fixture.store, '_importSessionActive', false)
        } else if (route === 'worker-source') {
            fixture.store.setRawTermBankSourceBytes(1024 ** 3)
        } else {
            Reflect.set(fixture.store, '_rawTermBankSourceBytes', null)
        }
        expect(fixture.adopt()).toEqual(fixture.expected)
        expect(fixture.prepared.bytes.byteLength).toBeGreaterThan(0)
        expect(fixture.encoded.recordFields.byteLength).toBeGreaterThan(0)
    })

    test.each(['initial', 'later'])('keeps key-plan aliases alive when introduced $0', async (when) => {
        const fixture = await createImportIndexChunkFixture(128, 0, when === 'later')
        fixture.prepared.preinternedPlan.stringsBuffer = fixture.prepared.bytes.subarray(0, 15)
        if (when === 'initial') { registerOwnedTermLookupIndexes(fixture.chunk) }
        const pending = fixture.adopt()
        expect(pending).toBeInstanceOf(Uint8Array)
        expect(pending).toEqual(fixture.expected)
        expect(fixture.prepared.preinternedPlan.stringsBuffer.byteLength).toBe(15)
    })

    test.each(['stringsBuffer', 'stringLengths', 'expressionIndexes'])('declines segmented $0 aliases before traversing media metadata', async (column) => {
        const fixture = await createImportIndexChunkFixture(128, 0, false)
        const {prepared, chunk} = fixture
        Reflect.set(prepared.preinternedPlan, column, new Uint8Array(prepared.bytes.buffer, 0, 4))
        Object.defineProperty(chunk, 'mediaRows', {
            get() { throw new Error('Borrowed payload registration must not walk media metadata') },
        })
        expect(() => registerOwnedTermLookupIndexes(chunk)).not.toThrow()
        expect(fixture.adopt()).toEqual(fixture.expected)
        expect(prepared.bytes.byteLength).toBeGreaterThan(0)
    })

    test.each(['descriptor', 'bytes', 'plan', 'map', 'duplicate', 'row-column'])('rejects replaced or newly aliased $0 ownership', async (replacement) => {
        const fixture = await createImportIndexChunkFixture()
        const {prepared, encoded, chunk} = fixture
        if (replacement === 'descriptor') {
            expect(canTakeOwnedTermLookupIndex({...prepared}, prepared.bytes, encoded.recordFields)).toBe(false)
            return
        }
        if (replacement === 'bytes') { prepared.bytes = Uint8Array.from(prepared.bytes) }
        if (replacement === 'plan') { prepared.preinternedPlan = {...prepared.preinternedPlan} }
        if (replacement === 'map') { chunk.preparedLookupIndexes = new Map(chunk.preparedLookupIndexes) }
        if (replacement === 'duplicate') { chunk.preparedLookupIndexes?.set('duplicate', {...prepared}) }
        if (replacement === 'row-column') { chunk.scoreList = new Int32Array(prepared.bytes.buffer, 0, 1) }
        expect(canTakeOwnedTermLookupIndex(prepared, prepared.bytes, encoded.recordFields)).toBe(false)
    })

    test.each(['shared', 'partial', 'resizable'])('does not infer ownership from $0 payload views', async (kind) => {
        const fixture = await createImportIndexChunkFixture(128, 0, false)
        const original = fixture.prepared.bytes
        const buffer = kind === 'shared' ?
            new SharedArrayBuffer(original.byteLength) :
            (kind === 'resizable' ?
                /** @type {ArrayBuffer} */ (Reflect.construct(ArrayBuffer, [original.byteLength, {maxByteLength: original.byteLength * 2}])) :
                new ArrayBuffer(original.byteLength + 8))
        fixture.prepared.bytes = new Uint8Array(buffer, kind === 'partial' ? 4 : 0, original.byteLength)
        fixture.prepared.bytes.set(original)
        registerOwnedTermLookupIndexes(fixture.chunk)
        expect(canTakeOwnedTermLookupIndex(fixture.prepared, fixture.prepared.bytes, fixture.encoded.recordFields)).toBe(false)
    })

    test('requires fresh store field ownership and excludes aliases between both transfers', async () => {
        const fixture = await createImportIndexChunkFixture()
        const {prepared, encoded} = fixture
        expect(canTakeOwnedTermLookupIndex(prepared, prepared.bytes, Uint8Array.from(encoded.recordFields))).toBe(false)
        registerOwnedTermRecordFields(prepared.bytes)
        expect(canTakeOwnedTermLookupIndex(prepared, prepared.bytes, prepared.bytes)).toBe(false)
    })

    test.each(['contentDedupPlan', 'resolvedContentReferences', 'mediaRows'])('keeps newly retained nested $0 views alive', async (field) => {
        const fixture = await createImportIndexChunkFixture()
        const bytes = fixture.prepared.bytes
        if (field === 'mediaRows') {
            Reflect.set(fixture.chunk, field, [{row: {expressionBytes: bytes.subarray(0, 3)}}])
        } else {
            Reflect.set(fixture.chunk, field, {offsets: new Uint32Array(bytes.buffer, 0, 1)})
        }
        expect(canTakeOwnedTermLookupIndex(fixture.prepared, bytes, fixture.encoded.recordFields)).toBe(false)
        expect(fixture.adopt()).toEqual(fixture.expected)
        expect(bytes.byteLength).toBeGreaterThan(0)
    })

    test('validates current bytes before detaching and preserves authoritative-field failure precedence', async () => {
        const fixture = await createImportIndexChunkFixture()
        fixture.encoded.recordFields.fill(0)
        fixture.prepared.bytes.fill(0)
        expect(() => fixture.adopt()).toThrow(/term-record fields/)
        expect(fixture.prepared.bytes.byteLength).toBeGreaterThan(0)
        expect(fixture.encoded.recordFields.byteLength).toBeGreaterThan(0)
    })

    test('hashes current valid payload edits before the ownership transfer', async () => {
        const fixture = await createImportIndexChunkFixture()
        fixture.prepared.bytes[fixture.prepared.bytes.length - 1] ^= 1
        const expected = fixture.store._createLookupIndexChunk(
            1,
            fixture.chunk.rowCount,
            fixture.encoded.contentOffsetBase,
            fixture.prepared.bytes,
            fixture.encoded.recordFields,
            fixture.encoded.recordFieldsFormat,
        )
        expect(concatenate(getImportIndexChunkParts([fixture.adopt()]))).toEqual(expected)
    })
})
