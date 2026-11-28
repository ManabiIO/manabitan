/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test} from 'vitest'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'

/** @typedef {{buffer: Uint8Array, offsets: Uint32Array, lengths: Uint32Array}} Spans */
/** @typedef {{offsets: number[]|Float64Array, lengths: number[]|Uint32Array, names: string|string[], content: Uint8Array[], spans: Spans|null}} Input */

/** @returns {Input} */
function input() {
    return {
        offsets: new Float64Array([100, 200, 300]),
        lengths: new Uint32Array([2, 2, 2]),
        names: 'raw',
        content: [],
        spans: {
            buffer: Uint8Array.of(11, 12, 21, 22, 31, 32),
            offsets: new Uint32Array([0, 2, 4]),
            lengths: new Uint32Array([2, 2, 2]),
        },
    }
}

/**
 * @param {Input} value
 * @returns {Spans}
 */
function spans(value) {
    if (value.spans === null) { throw new Error('Expected source spans') }
    return value.spans
}

/**
 * @param {DictionaryDatabase} database
 * @param {Input} value
 */
function ownSpans(database, value) {
    if (value.spans === null) { return }
    const {buffer, offsets, lengths} = value.spans
    value.spans = database._createTermContentSourceSpans(buffer, offsets, lengths)
}

/**
 * @param {DictionaryDatabase} database
 * @param {Input} value
 * @returns {() => void}
 */
function register(database, value) {
    return database._registerInFlightTermContentSources(value.offsets, value.lengths, value.names, value.content, value.spans)
}

/**
 * @param {DictionaryDatabase} database
 * @param {number} offset
 * @param {number} length
 * @param {string} [name]
 * @returns {number[]|undefined}
 */
function read(database, offset, length, name = 'raw') {
    const source = database._findInFlightTermContentSource(offset, length, name)
    return typeof source === 'undefined' ? void 0 : [...source.buffer.subarray(source.offset, source.offset + source.length)]
}

describe('in-flight source registration ranges', () => {
    /** @type {Array<{name: string, change: (value: Input) => void}>} */
    const accepted = [
        {name: 'ordered typed columns', change: () => {}},
        {name: 'unordered typed offsets', change: (value) => { value.offsets = new Float64Array([300, 100, 200]) }},
        {name: 'generic pending columns', change: (value) => { value.offsets = [...value.offsets]; value.lengths = [...value.lengths] }},
        {name: 'per-row dictionaries', change: (value) => { value.names = ['raw', 'other', 'raw'] }},
        {name: 'empty dictionary name', change: (value) => { value.names = '' }},
        {name: 'generic source columns',
            change: (value) => {
                Reflect.set(spans(value), 'offsets', [0, 2, 4])
                Reflect.set(spans(value), 'lengths', [2, 2, 2])
            }},
        {name: 'nonmonotonic source positions', change: (value) => { spans(value).offsets = new Uint32Array([4, 0, 2]) }},
        {name: 'source view with a nonzero byte offset',
            change: (value) => {
                spans(value).buffer = Uint8Array.of(99, 11, 12, 21, 22, 31, 32, 99).subarray(1, 7)
            }},
        {name: 'maximum safe persisted offset', change: (value) => { value.offsets[2] = Number.MAX_SAFE_INTEGER }},
        {name: 'negative zero persisted offset', change: (value) => { value.offsets[0] = -0 }},
        {name: 'shared source bytes',
            change: (value) => {
                const buffer = new Uint8Array(new SharedArrayBuffer(6))
                buffer.set(spans(value).buffer)
                spans(value).buffer = buffer
            }},
        {name: 'shared source metadata',
            change: (value) => {
                const offsets = new Uint32Array(new SharedArrayBuffer(12))
                offsets.set(spans(value).offsets)
                spans(value).offsets = offsets
            }},
        {name: 'individual content buffers',
            change: (value) => {
                value.spans = null
                value.content = [Uint8Array.of(11, 12), Uint8Array.of(21, 22), Uint8Array.of(31, 32)]
            }},
    ]

    test.each(accepted.flatMap((entry) => [false, true].map((factoryOwned) => ({...entry, factoryOwned}))))('keeps exact borrowed sources and cleanup for $name (factory=$factoryOwned)', ({change, factoryOwned}) => {
        const database = new DictionaryDatabase()
        const value = input()
        change(value)
        if (factoryOwned) { ownSpans(database, value) }
        const release = register(database, value)
        for (let index = 0; index < value.offsets.length; ++index) {
            const name = Array.isArray(value.names) ? value.names[index] : value.names
            const expected = value.spans === null ?
                {buffer: value.content[index], offset: 0, length: value.content[index].byteLength} :
                {buffer: value.spans.buffer, offset: value.spans.offsets[index], length: value.spans.lengths[index]}
            const found = database._findInFlightTermContentSource(value.offsets[index], value.lengths[index], name)
            expect(found).toEqual(expected)
            expect(found?.buffer).toBe(expected.buffer)
            expect(database._findInFlightTermContentSource(value.offsets[index], value.lengths[index] + 1, name)).toBeUndefined()
            expect(database._findInFlightTermContentSource(value.offsets[index], value.lengths[index], `${name}-missing`)).toBeUndefined()
        }
        release()
        release()
        expect(database._inFlightTermContentSourceBatches.size).toBe(0)
        expect(read(database, value.offsets[0], value.lengths[0])).toBeUndefined()
    })

    /** @type {Array<{name: string, change: (value: Input) => void}>} */
    const invalid = [
        ...[-1, -0.5, 0.5, Number.NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1].map((offset) => ({
            name: `invalid persisted offset ${String(offset)}`,
            change: (/** @type {Input} */ value) => { value.offsets[2] = offset },
        })),
        {name: 'short pending lengths', change: (value) => { value.lengths = new Uint32Array([2, 2]) }},
        {name: 'different persisted length', change: (value) => { value.lengths[2] = 1 }},
        {name: 'short source offsets', change: (value) => { spans(value).offsets = new Uint32Array([0, 2]) }},
        {name: 'short source lengths', change: (value) => { spans(value).lengths = new Uint32Array([2, 2]) }},
        {name: 'span beyond the source view', change: (value) => { spans(value).offsets[2] = 6 }},
        {name: 'zero-length span beyond the source view',
            change: (value) => {
                spans(value).offsets[2] = 7
                spans(value).lengths[2] = 0
                value.lengths[2] = 0
            }},
        {name: 'span length beyond the source view',
            change: (value) => {
                spans(value).lengths[2] = 0xffffffff
                value.lengths[2] = 0xffffffff
            }},
        {name: 'missing dictionary name', change: (value) => { value.names = ['raw', 'raw'] }},
        {name: 'non-string dictionary name', change: (value) => { Reflect.set(value, 'names', 7) }},
        {name: 'wrong source buffer type', change: (value) => { Reflect.set(spans(value), 'buffer', new Uint16Array(6)) }},
        {name: 'missing individual content buffer',
            change: (value) => {
                value.spans = null
                value.content = [Uint8Array.of(11, 12), Uint8Array.of(21, 22)]
            }},
        ...[-1, 0.5, Number.NaN, Infinity].map((offset) => ({
            name: `invalid generic source offset ${String(offset)}`,
            change: (/** @type {Input} */ value) => { Reflect.set(spans(value), 'offsets', [0, 2, offset]) },
        })),
    ]

    test.each(invalid.flatMap((entry) => [false, true].map((factoryOwned) => ({...entry, factoryOwned}))))('rejects $name without publishing a partial batch (factory=$factoryOwned)', ({change, factoryOwned}) => {
        const database = new DictionaryDatabase()
        const value = input()
        change(value)
        if (factoryOwned) { ownSpans(database, value) }
        expect(() => register(database, value)).toThrow(RangeError)
        expect(database._inFlightTermContentSourceBatches.size).toBe(0)
        expect(read(database, 100, 2)).toBeUndefined()
    })

    test.each([
        {name: 'below an existing range', offsets: [10, 20, 30]},
        {name: 'above an existing range', offsets: [400, 500, 600]},
        {name: 'inside an existing range without identical keys', offsets: [150, 250, 275]},
    ])('keeps both sources $name', ({offsets}) => {
        const database = new DictionaryDatabase()
        const first = input()
        const second = input()
        second.offsets = new Float64Array(offsets)
        spans(second).buffer = Uint8Array.of(41, 42, 51, 52, 61, 62)
        ownSpans(database, first)
        ownSpans(database, second)
        const releaseFirst = register(database, first)
        const releaseSecond = register(database, second)
        expect(read(database, 200, 2)).toEqual([21, 22])
        expect(read(database, offsets[1], 2)).toEqual([51, 52])
        releaseFirst()
        expect(read(database, offsets[1], 2)).toEqual([51, 52])
        releaseSecond()
        expect(database._inFlightTermContentSourceBatches.size).toBe(0)
    })

    test.each([
        {name: 'sorted repeated key', offsets: [100, 100, 300]},
        {name: 'unordered repeated key', offsets: [100, 300, 100]},
    ])('rejects a $name within one batch', ({offsets}) => {
        const database = new DictionaryDatabase()
        const value = input()
        value.offsets = new Float64Array(offsets)
        ownSpans(database, value)
        expect(() => register(database, value)).toThrow('Duplicate in-flight term content storage reference')
        expect(database._inFlightTermContentSourceBatches.size).toBe(0)
    })

    test.each([false, true])('rejects an existing exact key without altering other reservations (unordered=%s)', (unordered) => {
        const database = new DictionaryDatabase()
        const first = input()
        if (unordered) { first.offsets = new Float64Array([300, 100, 200]) }
        ownSpans(database, first)
        const release = register(database, first)
        const second = input()
        second.offsets = new Float64Array([150, 250, 300])
        ownSpans(database, second)
        expect(() => register(database, second)).toThrow('Duplicate in-flight term content storage reference')
        expect(database._inFlightTermContentSourceBatches.size).toBe(1)
        expect(read(database, 150, 2)).toBeUndefined()
        expect(read(database, 300, 2)).toEqual(unordered ? [11, 12] : [31, 32])
        release()
    })

    test.each(['length', 'dictionary'])('keeps equal offsets with distinct %s keys', (difference) => {
        const database = new DictionaryDatabase()
        const value = input()
        value.offsets = new Float64Array([100, 100, 300])
        if (difference === 'length') {
            value.lengths[1] = 1
            spans(value).lengths[1] = 1
        } else {
            value.names = ['raw', 'other', 'raw']
        }
        ownSpans(database, value)
        const release = register(database, value)
        expect(read(database, 100, 2)).toEqual([11, 12])
        expect(read(database, 100, difference === 'length' ? 1 : 2, difference === 'dictionary' ? 'other' : 'raw')).toEqual(difference === 'length' ? [21] : [21, 22])
        release()
    })

    test('accepts exact empty source boundaries and keeps empty-batch cleanup isolated', () => {
        const database = new DictionaryDatabase()
        const empty = {offsets: new Float64Array(), lengths: new Uint32Array(), names: 'raw', content: [], spans: null}
        const releaseEmpty = register(database, empty)
        const value = input()
        value.lengths.fill(0)
        spans(value).offsets.fill(6)
        spans(value).lengths.fill(0)
        ownSpans(database, value)
        const release = register(database, value)
        expect(read(database, 100, 0)).toEqual([])
        releaseEmpty()
        releaseEmpty()
        expect(read(database, 300, 0)).toEqual([])
        expect(database._inFlightTermContentSourceBatches.size).toBe(1)
        release()
        expect(database._inFlightTermContentSourceBatches.size).toBe(0)
    })

    test.each([false, true])('rejects non-integer source metadata exposed by a typed-array proxy (factory=%s)', (factoryOwned) => {
        const database = new DictionaryDatabase()
        const value = input()
        spans(value).offsets = new Proxy(spans(value).offsets, {
            get(target, key) { return key === '1' ? -1 : Reflect.get(target, key, target) },
        })
        if (factoryOwned) { ownSpans(database, value) }
        expect(() => register(database, value)).toThrow(RangeError)
        expect(database._inFlightTermContentSourceBatches.size).toBe(0)
    })

    test.each([false, true])('rejects a short source column despite an overridden length property (factory=%s)', (factoryOwned) => {
        const database = new DictionaryDatabase()
        const value = input()
        const offsets = new Uint32Array([0, 2])
        Object.defineProperty(offsets, 'length', {value: 3})
        spans(value).offsets = offsets
        if (factoryOwned) { ownSpans(database, value) }
        expect(() => register(database, value)).toThrow(RangeError)
        expect(database._inFlightTermContentSourceBatches.size).toBe(0)
    })

    test('does not consume source accessors before the general validation path', () => {
        const database = new DictionaryDatabase()
        const value = input()
        let reads = 0
        Object.defineProperty(spans(value), 'offsets', {
            get() { return new Uint32Array(++reads === 1 ? [7, 2, 4] : [0, 2, 4]) },
        })
        expect(() => register(database, value)).toThrow(RangeError)
        expect(database._inFlightTermContentSourceBatches.size).toBe(0)
    })

    test('freezes only the owned span container and keeps borrowed column identities', () => {
        const database = new DictionaryDatabase()
        const value = input()
        const original = spans(value)
        ownSpans(database, value)
        expect(Object.isFrozen(value.spans)).toBe(true)
        expect(spans(value).buffer).toBe(original.buffer)
        expect(spans(value).offsets).toBe(original.offsets)
        expect(spans(value).lengths).toBe(original.lengths)
        original.buffer[0] = 41
        const release = register(database, value)
        expect(read(database, 100, 2)).toEqual([41, 12])
        release()
    })

    test('checks owned source values again after an asynchronous boundary', async () => {
        const database = new DictionaryDatabase()
        const value = input()
        ownSpans(database, value)
        await Promise.resolve()
        spans(value).offsets[2] = 7
        expect(() => register(database, value)).toThrow(RangeError)
        expect(database._inFlightTermContentSourceBatches.size).toBe(0)
    })

    test('rejects float metadata whose prototype impersonates an unsigned typed array', () => {
        const database = new DictionaryDatabase()
        const value = input()
        const offsets = new Float32Array([0, -1, 4])
        Object.setPrototypeOf(offsets, Uint32Array.prototype)
        Reflect.set(spans(value), 'offsets', offsets)
        ownSpans(database, value)
        expect(() => register(database, value)).toThrow(RangeError)
        expect(database._inFlightTermContentSourceBatches.size).toBe(0)
    })

    test('preserves ordinary subclass metadata through the general path', () => {
        class SourceOffsets extends Uint32Array {}
        const database = new DictionaryDatabase()
        const value = input()
        spans(value).offsets = new SourceOffsets([0, 2, 4])
        ownSpans(database, value)
        const release = register(database, value)
        expect(read(database, 200, 2)).toEqual([21, 22])
        release()
    })

    test('keeps shared metadata on the general path despite a forged private-buffer prototype', () => {
        const database = new DictionaryDatabase()
        const value = input()
        const buffer = new SharedArrayBuffer(12)
        const offsets = new Uint32Array(buffer)
        offsets.set(spans(value).offsets)
        Object.setPrototypeOf(buffer, ArrayBuffer.prototype)
        spans(value).offsets = offsets
        ownSpans(database, value)
        expect(database._getDisjointTermContentSpanRange(value.offsets, value.lengths, value.names, value.spans, value.offsets.length)).toBeNull()
        const release = register(database, value)
        expect(read(database, 200, 2)).toEqual([21, 22])
        release()
    })
})
