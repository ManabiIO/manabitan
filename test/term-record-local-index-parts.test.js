/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test, vi} from 'vitest'
import {
    canTakeOwnedTermLookupIndex,
    getTermLookupIndexConsumer,
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
        expect(canTakeOwnedTermLookupIndex(prepared, payload, fields, fixture.consumer)).toBe(false)
        expect(concatenate(getImportIndexChunkParts([pending]))).toEqual(expected)
        expect(() => takeOwnedTermLookupIndex(prepared, payload, fields, fixture.consumer)).toThrow('ownership')
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
            expect(canTakeOwnedTermLookupIndex({...prepared}, prepared.bytes, encoded.recordFields, fixture.consumer)).toBe(false)
            return
        }
        if (replacement === 'bytes') { prepared.bytes = Uint8Array.from(prepared.bytes) }
        if (replacement === 'plan') { prepared.preinternedPlan = {...prepared.preinternedPlan} }
        if (replacement === 'map') { chunk.preparedLookupIndexes = new Map(chunk.preparedLookupIndexes) }
        if (replacement === 'duplicate') { chunk.preparedLookupIndexes?.set('duplicate', {...prepared}) }
        if (replacement === 'row-column') { chunk.scoreList = new Int32Array(prepared.bytes.buffer, 0, 1) }
        expect(canTakeOwnedTermLookupIndex(prepared, prepared.bytes, encoded.recordFields, fixture.consumer)).toBe(false)
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
        expect(canTakeOwnedTermLookupIndex(fixture.prepared, fixture.prepared.bytes, fixture.encoded.recordFields, fixture.consumer)).toBe(false)
    })

    test('requires fresh store field ownership and excludes aliases between both transfers', async () => {
        const fixture = await createImportIndexChunkFixture()
        const {prepared, encoded} = fixture
        expect(canTakeOwnedTermLookupIndex(prepared, prepared.bytes, Uint8Array.from(encoded.recordFields), fixture.consumer)).toBe(false)
        registerOwnedTermRecordFields(prepared.bytes)
        expect(canTakeOwnedTermLookupIndex(prepared, prepared.bytes, prepared.bytes, fixture.consumer)).toBe(false)
    })

    test.each(['contentDedupPlan', 'resolvedContentReferences', 'mediaRows'])('keeps newly retained nested $0 views alive', async (field) => {
        const fixture = await createImportIndexChunkFixture()
        const bytes = fixture.prepared.bytes
        if (field === 'mediaRows') {
            Reflect.set(fixture.chunk, field, [{row: {expressionBytes: bytes.subarray(0, 3)}}])
        } else {
            Reflect.set(field === 'resolvedContentReferences' ? fixture.consumer : fixture.chunk, field, {offsets: new Uint32Array(bytes.buffer, 0, 1)})
        }
        expect(canTakeOwnedTermLookupIndex(fixture.prepared, bytes, fixture.encoded.recordFields, fixture.consumer)).toBe(false)
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
    test.each(['initial', 'later'])('keeps payload-backed route filters alive when introduced %s', async (when) => {
        const fixture = await createImportIndexChunkFixture(128, 0, when === 'later')
        fixture.prepared.routeFilter = new Uint32Array(fixture.prepared.bytes.buffer, 0, 2)
        if (when === 'initial') { registerOwnedTermLookupIndexes(fixture.chunk) }
        const filter = Uint32Array.from(fixture.prepared.routeFilter)
        expect(fixture.adopt()).toEqual(fixture.expected)
        expect(fixture.prepared.routeFilter).toEqual(filter)
        expect(fixture.prepared.bytes.byteLength).toBeGreaterThan(0)
    })

    test('adopts a normal independent route filter and preserves its storage', async () => {
        const fixture = await createImportIndexChunkFixture(128, 0, false)
        fixture.prepared.routeFilter = Uint32Array.of(1, 2)
        registerOwnedTermLookupIndexes(fixture.chunk)
        const pending = fixture.adopt()
        expect(pending).not.toBeInstanceOf(Uint8Array)
        expect(fixture.prepared.routeFilter).toEqual(Uint32Array.of(1, 2))
        expect(concatenate(getImportIndexChunkParts([pending]))).toEqual(fixture.expected)
    })

    test('keeps a late field-backed route filter alive', async () => {
        const fixture = await createImportIndexChunkFixture()
        fixture.prepared.routeFilter = new Uint32Array(fixture.encoded.recordFields.buffer, 0, 2)
        const filter = Uint32Array.from(fixture.prepared.routeFilter)
        expect(fixture.adopt()).toEqual(fixture.expected)
        expect(fixture.prepared.routeFilter).toEqual(filter)
        expect(fixture.encoded.recordFields.byteLength).toBeGreaterThan(0)
    })

    test.each(['owner', 'consumer', 'key-plan', 'content-plan', 'references', 'prepared'])('declines late %s accessors without invoking them', async (kind) => {
        const fixture = await createImportIndexChunkFixture()
        let reads = 0
        let target
        switch (kind) {
            case 'owner':
            case 'content-plan':
                target = fixture.chunk
                break
            case 'consumer':
                target = fixture.consumer
                break
            case 'key-plan':
                target = fixture.prepared.preinternedPlan
                break
            case 'references':
                target = fixture.consumer.resolvedContentReferences
                break
            default:
                target = fixture.prepared
                break
        }
        let name = 'mediaRows'
        if (kind === 'content-plan') { name = 'contentDedupPlan' }
        if (kind === 'prepared') { name = 'routeFilter' }
        Object.defineProperty(target, name, {
            configurable: true,
            get() { ++reads; throw new Error('Ownership proof must not invoke this getter') },
        })
        expect(fixture.adopt()).toEqual(fixture.expected)
        expect(reads).toBe(0)
        fixture.encoded.recordFields.fill(0)
        expect(() => fixture.adopt()).toThrow(/term-record fields/)
        expect(reads).toBe(0)
    })

    test.each(['payload', 'fields'])('rejects per-object %s geometry and method shadows before reading them', async (kind) => {
        for (const name of ['buffer', 'byteOffset', 'byteLength', 'length', 'constructor', 'subarray', 'slice', 'set', Symbol.iterator]) {
            const fixture = await createImportIndexChunkFixture()
            const target = kind === 'payload' ? fixture.prepared.bytes : fixture.encoded.recordFields
            let reads = 0
            Object.defineProperty(target, name, {
                get() { ++reads; throw new Error('Shadowed view access') },
            })
            expect(canTakeOwnedTermLookupIndex(
                fixture.prepared,
                fixture.prepared.bytes,
                fixture.encoded.recordFields,
                fixture.consumer,
            )).toBe(false)
            expect(reads).toBe(0)
        }
    })

    test.each(['byteLength', 'resizable', 'constructor', 'transfer'])('rejects backing-buffer %s shadows before reading them', async (name) => {
        const fixture = await createImportIndexChunkFixture()
        let reads = 0
        Object.defineProperty(fixture.prepared.bytes.buffer, name, {
            get() { ++reads; throw new Error('Shadowed backing-buffer access') },
        })
        expect(canTakeOwnedTermLookupIndex(
            fixture.prepared,
            fixture.prepared.bytes,
            fixture.encoded.recordFields,
            fixture.consumer,
        )).toBe(false)
        expect(reads).toBe(0)
    })

    test('preserves the eager error for a shorter shadowed payload geometry instead of transferring inconsistent parts', async () => {
        const fixture = await createImportIndexChunkFixture(1)
        const payload = fixture.prepared.bytes
        const buffer = payload.buffer
        const actualByteLength = payload.byteLength
        new Uint32Array(buffer)[3] -= 16
        Object.defineProperty(payload, 'byteLength', {value: actualByteLength - 16})
        Object.defineProperty(buffer, 'byteLength', {value: actualByteLength - 16})
        expect(() => fixture.store._createLookupIndexChunk(
            1,
            1,
            fixture.encoded.contentOffsetBase,
            payload,
            fixture.encoded.recordFields,
            fixture.encoded.recordFieldsFormat,
        )).toThrow(RangeError)
        expect(() => fixture.adopt()).toThrow(RangeError)
        expect(new Uint8Array(buffer).length).toBe(actualByteLength)
        expect(fixture.encoded.recordFields.byteLength).toBeGreaterThan(0)
    })

    test.each(['consumer', 'prepared'])('does not invoke Proxy traps to infer %s provenance', async (kind) => {
        const fixture = await createImportIndexChunkFixture()
        let traps = 0
        const target = kind === 'consumer' ? fixture.consumer : fixture.prepared
        const proxy = new Proxy(target, {
            get() { ++traps; throw new Error('Proxy property read') },
            getOwnPropertyDescriptor() { ++traps; throw new Error('Proxy descriptor read') },
            getPrototypeOf() { ++traps; throw new Error('Proxy prototype read') },
        })
        expect(canTakeOwnedTermLookupIndex(
            kind === 'prepared' ? /** @type {typeof fixture.prepared} */ (proxy) : fixture.prepared,
            fixture.prepared.bytes,
            fixture.encoded.recordFields,
            kind === 'consumer' ? proxy : fixture.consumer,
        )).toBe(false)
        expect(traps).toBe(0)
    })

    test('does not brand an overridable field encoder return value', async () => {
        const fixture = await createImportIndexChunkFixture()
        const fields = Uint8Array.from(fixture.encoded.recordFields)
        const override = vi.spyOn(fixture.store, '_encodeArtifactRecordFields').mockReturnValue(fields)
        try {
            const encoded = await fixture.store._encodeArtifactChunkRecords(
                fixture.consumer,
                new Float64Array(0),
                new Uint32Array(0),
                fixture.prepared.preinternedPlan,
                fixture.prepared.bytes,
            )
            const pending = fixture.store._createPendingLookupIndexChunk(
                1,
                fixture.chunk.rowCount,
                encoded.contentOffsetBase,
                encoded.lookupIndexBytes,
                encoded.recordFields,
                encoded.recordFieldsFormat,
                fixture.prepared,
                fixture.consumer,
            )
            expect(pending).toEqual(fixture.expected)
            expect(fields.byteLength).toBeGreaterThan(0)
            expect(fixture.prepared.bytes.byteLength).toBeGreaterThan(0)
        } finally {
            override.mockRestore()
        }
    })

    test('requires the original factory consumer and empty unshadowed projections', async () => {
        const fixture = await createImportIndexChunkFixture()
        const emptyOffsets = new Float64Array(0)
        const emptyLengths = new Uint32Array(0)
        expect(getTermLookupIndexConsumer(fixture.consumer, emptyOffsets, emptyLengths)).toBe(fixture.consumer)
        expect(getTermLookupIndexConsumer({...fixture.consumer}, emptyOffsets, emptyLengths)).toBeNull()
        expect(getTermLookupIndexConsumer(fixture.consumer, new Float64Array(1), emptyLengths)).toBeNull()
        expect(getTermLookupIndexConsumer(fixture.consumer, emptyOffsets, new Uint32Array(1))).toBeNull()
        let reads = 0
        Object.defineProperty(emptyOffsets, 'length', {
            get() { ++reads; throw new Error('Projection shadow') },
        })
        expect(getTermLookupIndexConsumer(fixture.consumer, emptyOffsets, emptyLengths)).toBeNull()
        expect(reads).toBe(0)
    })

    test.each([false, true])('keeps materialized key-cache slices alive when the consumer plan changes across an await: %s', async (restoreDuringAwait) => {
        const fixture = await createImportIndexChunkFixture(2)
        const {store, consumer, chunk, prepared} = fixture
        const originalPlan = chunk.termRecordPreinternedPlan
        const keyBytes = Uint8Array.from(originalPlan.stringsBuffer)
        const keyOffset = Buffer.from(prepared.bytes).indexOf(Buffer.from(keyBytes))
        expect(keyOffset).toBeGreaterThanOrEqual(0)
        consumer.termRecordPreinternedPlan = {
            ...originalPlan,
            stringsBuffer: prepared.bytes.subarray(keyOffset, keyOffset + keyBytes.length),
        }
        consumer.dictionaryTotalRows = 2
        // The in-memory path retains records before storage is attached by
        // the awaited shard owner; ordinary active OPFS imports discard them.
        Reflect.set(store, '_importSessionActive', false)
        await store.beginImportSession()
        const createShard = store._getOrCreateShardState.bind(store)
        const override = vi.spyOn(store, '_getOrCreateShardState').mockImplementation(async (...args) => {
            Reflect.set(store, '_recordsDirectoryHandle', {async getFileHandle() { return {} }})
            const state = await createShard(...args)
            if (restoreDuringAwait) {
                consumer.termRecordPreinternedPlan = originalPlan
                consumer.dictionaryTotalRows = 528299
            }
            return state
        })
        try {
            await store.appendBatchFromArtifactChunkResolvedContent(consumer, new Float64Array(0), new Uint32Array(0), 'raw')
            const record = Reflect.get(store, '_recordsById').get(1)
            if (typeof record === 'undefined') { throw new Error('Missing materialized record') }
            expect(record.expressionBytes).toEqual(keyBytes.subarray(0, 9))
            expect(record.readingBytes).toEqual(keyBytes.subarray(9, 15))
            expect(prepared.bytes.byteLength).toBeGreaterThan(0)
        } finally {
            override.mockRestore()
        }
    })

    test.each(['normal', 'spread', 'populated-projections'])('whole persisted-only append preserves %s consumer behavior', async (kind) => {
        const fixture = await createImportIndexChunkFixture()
        const {store, prepared} = fixture
        // The production importer removes mediaRows before creating this object.
        Reflect.deleteProperty(fixture.consumer, 'mediaRows')
        const consumer = kind === 'spread' ? {...fixture.consumer} : fixture.consumer
        const rowCount = kind === 'populated-projections' ? fixture.chunk.rowCount : 0
        Reflect.set(store, '_recordsDirectoryHandle', {async getFileHandle() { return {} }})
        Reflect.set(store, '_importSessionActive', false)
        await store.beginImportSession()
        const createPending = store._createPendingLookupIndexChunk.bind(store)
        /** @type {ReturnType<typeof createPending>[]} */
        const pending = []
        const override = vi.spyOn(store, '_createPendingLookupIndexChunk').mockImplementation((...args) => {
            const [firstId, count, base, payload, fields, format] = args
            const expected = store._createLookupIndexChunk(firstId, count, base, payload, fields, format)
            const result = createPending(...args)
            expect(concatenate(getImportIndexChunkParts([result]))).toEqual(expected)
            pending.push(result)
            return result
        })
        try {
            await store.appendBatchFromArtifactChunkResolvedContent(
                consumer,
                new Float64Array(rowCount),
                new Uint32Array(rowCount),
                'raw',
            )
            expect(pending).toHaveLength(1)
            if (kind === 'normal') {
                expect(pending[0]).not.toBeInstanceOf(Uint8Array)
                expect(prepared.bytes.byteLength).toBe(0)
            } else {
                expect(pending[0]).toBeInstanceOf(Uint8Array)
                expect(prepared.bytes.byteLength).toBeGreaterThan(0)
            }
        } finally {
            override.mockRestore()
        }
    })

    test.each([false, true])('declines shared reference backing without throwing when its prototype is forged: %s', async (forged) => {
        const fixture = await createImportIndexChunkFixture()
        const buffer = new SharedArrayBuffer(fixture.chunk.rowCount * Float64Array.BYTES_PER_ELEMENT)
        const offsets = new Float64Array(buffer)
        if (forged) { Object.setPrototypeOf(buffer, ArrayBuffer.prototype) }
        fixture.consumer.resolvedContentReferences.offsets = offsets
        expect(canTakeOwnedTermLookupIndex(
            fixture.prepared,
            fixture.prepared.bytes,
            fixture.encoded.recordFields,
            fixture.consumer,
        )).toBe(false)
        expect(fixture.adopt()).toEqual(fixture.expected)
        expect(fixture.prepared.bytes.byteLength).toBeGreaterThan(0)
    })

    test.each([false, true])('keeps the original shared source slab alive and handles a forged source prototype: %s', async (forged) => {
        const fixture = await createImportIndexChunkFixture(128, 0, false)
        const buffer = new SharedArrayBuffer(32)
        const content = new Uint8Array(buffer).fill(0x5a)
        if (forged) { Object.setPrototypeOf(buffer, ArrayBuffer.prototype) }
        fixture.chunk.contentBytesBuffer = content
        fixture.consumer.contentBytesBuffer = content
        registerOwnedTermLookupIndexes(fixture.chunk)
        const pending = fixture.adopt()
        if (forged) {
            expect(pending).toBeInstanceOf(Uint8Array)
            expect(fixture.prepared.bytes.byteLength).toBeGreaterThan(0)
        } else {
            expect(pending).not.toBeInstanceOf(Uint8Array)
            expect(fixture.prepared.bytes.byteLength).toBe(0)
        }
        expect(content.byteLength).toBe(32)
        expect(content[0]).toBe(0x5a)
        expect(concatenate(getImportIndexChunkParts([pending]))).toEqual(fixture.expected)
    })

    test.each(['fields', 'chunk'])('preserves fresh buffers retained by a %s encoder wrapper', async (kind) => {
        const fixture = await createImportIndexChunkFixture()
        let retained
        let override
        if (kind === 'fields') {
            const original = fixture.store._encodeArtifactRecordFields.bind(fixture.store)
            override = vi.spyOn(fixture.store, '_encodeArtifactRecordFields').mockImplementation((...args) => {
                retained = original(...args)
                return retained
            })
        } else {
            const original = fixture.store._encodeArtifactChunkRecords.bind(fixture.store)
            override = vi.spyOn(fixture.store, '_encodeArtifactChunkRecords').mockImplementation(async (...args) => {
                const result = await original(...args)
                retained = result.recordFields
                return result
            })
        }
        try {
            const encoded = await fixture.store._encodeArtifactChunkRecords(
                fixture.consumer,
                new Float64Array(0),
                new Uint32Array(0),
                fixture.prepared.preinternedPlan,
                fixture.prepared.bytes,
            )
            const pending = fixture.store._createPendingLookupIndexChunk(
                1,
                fixture.chunk.rowCount,
                encoded.contentOffsetBase,
                encoded.lookupIndexBytes,
                encoded.recordFields,
                encoded.recordFieldsFormat,
                fixture.prepared,
                fixture.consumer,
            )
            expect(pending).toEqual(fixture.expected)
            expect(retained).toBe(encoded.recordFields)
            expect(encoded.recordFields.byteLength).toBeGreaterThan(0)
            expect(fixture.prepared.bytes.byteLength).toBeGreaterThan(0)
        } finally {
            override.mockRestore()
        }
    })

    test('does not invoke a late encoder accessor while checking ownership', async () => {
        const fixture = await createImportIndexChunkFixture()
        let reads = 0
        Object.defineProperty(fixture.store, '_encodeArtifactRecordFields', {
            get() { ++reads; throw new Error('Encoder accessor must keep eager snapshot') },
        })
        expect(fixture.adopt()).toEqual(fixture.expected)
        expect(reads).toBe(0)
    })

    test.each(['fields', 'chunk'])('keeps the invocation witness revoked after a %s wrapper restores itself', async (kind) => {
        const fixture = await createImportIndexChunkFixture()
        const {store, consumer, prepared} = fixture
        /** @type {Uint8Array[]} */
        const retained = []
        if (kind === 'fields') {
            const original = store._encodeArtifactRecordFields.bind(store)
            store._encodeArtifactRecordFields = (...args) => {
                Reflect.deleteProperty(store, '_encodeArtifactRecordFields')
                const fields = original(...args)
                retained.push(fields)
                return fields
            }
        } else {
            const original = store._encodeArtifactChunkRecords.bind(store)
            store._encodeArtifactChunkRecords = async (...args) => {
                Reflect.deleteProperty(store, '_encodeArtifactChunkRecords')
                const encoded = await original(...args)
                retained.push(encoded.recordFields)
                return encoded
            }
        }
        Reflect.set(store, '_recordsDirectoryHandle', {async getFileHandle() { return {} }})
        Reflect.set(store, '_importSessionActive', false)
        await store.beginImportSession()
        const createPending = store._createPendingLookupIndexChunk.bind(store)
        /** @type {ReturnType<typeof createPending>[]} */
        const pending = []
        const override = vi.spyOn(store, '_createPendingLookupIndexChunk').mockImplementation((...args) => {
            const value = createPending(...args)
            pending.push(value)
            return value
        })
        try {
            await store.appendBatchFromArtifactChunkResolvedContent(consumer, new Float64Array(0), new Uint32Array(0), 'raw')
            expect(pending).toHaveLength(1)
            expect(pending[0]).toBeInstanceOf(Uint8Array)
            expect(pending[0]).toEqual(fixture.expected)
            expect(retained).toHaveLength(1)
            expect(retained[0].byteLength).toBeGreaterThan(0)
            expect(prepared.bytes.byteLength).toBeGreaterThan(0)
        } finally {
            override.mockRestore()
        }
    })

    test.each(['custom-envelope', 'restoring-append'])('preserves the existing %s hook on public append', async (kind) => {
        const fixture = await createImportIndexChunkFixture()
        const {store, consumer, prepared} = fixture
        let calls = 0
        /** @type {Uint8Array[]} */
        const retained = []
        const failure = new Error('Custom envelope implementation')
        if (kind === 'custom-envelope') {
            store._createLookupIndexChunk = () => {
                ++calls
                throw failure
            }
        } else {
            const original = store._appendEncodedChunk.bind(store)
            store._appendEncodedChunk = async (...args) => {
                ++calls
                const fields = args[6]
                if (!(fields instanceof Uint8Array)) { throw new Error('Missing encoded record fields') }
                retained.push(fields)
                Reflect.deleteProperty(store, '_appendEncodedChunk')
                return await original(...args)
            }
        }
        Reflect.set(store, '_recordsDirectoryHandle', {async getFileHandle() { return {} }})
        Reflect.set(store, '_importSessionActive', false)
        await store.beginImportSession()
        const append = store.appendBatchFromArtifactChunkResolvedContent(consumer, new Float64Array(0), new Uint32Array(0), 'raw')
        if (kind === 'custom-envelope') {
            await expect(append).rejects.toBe(failure)
        } else {
            await append
            expect(retained).toHaveLength(1)
            expect(retained[0].byteLength).toBeGreaterThan(0)
            const states = Reflect.get(store, '_shardStateByFileName')
            expect([...states.values()][0].pendingLookupIndexChunks[0]).toEqual(fixture.expected)
        }
        expect(calls).toBe(1)
        expect(prepared.bytes.byteLength).toBeGreaterThan(0)
    })
})
