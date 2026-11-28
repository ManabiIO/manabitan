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
/* eslint @stylistic/semi: ["error", "never"] */

import {readFileSync} from 'node:fs'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'
import {createImportRecordFieldEncoder} from '../ext/js/dictionary/term-record-fields.js'
import {createArtifactTermRecordChunkWithResolvedContent, TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js'

vi.mock('../ext/js/dictionary/term-record-fields.js', () => ({createImportRecordFieldEncoder: vi.fn()}))

/** @typedef {NonNullable<Awaited<ReturnType<typeof createImportRecordFieldEncoder>>>} Encoder */
/** @typedef {ReturnType<typeof fixture>} Fixture */

/**
 * @template T
 * @returns {{promise: Promise<T>, resolve: (value: T) => void, reject: (reason: unknown) => void}}
 */
function deferred() {
    const callbacks = {
        resolve: /** @type {(value: T) => void} */ (() => {}),
        reject: /** @type {(reason: unknown) => void} */ (() => {}),
    }
    /** @type {Promise<T>} */
    const promise = new Promise((resolve, reject) => {
        callbacks.resolve = resolve
        callbacks.reject = reject
    })
    return {promise, ...callbacks}
}

/** @returns {{rowCount: number, scoreList: Int32Array, resolvedContentReferences: {uniqueIndexList: Uint32Array, offsets: Float64Array, lengths: Uint32Array}}} */
function fixture() {
    return createArtifactTermRecordChunkWithResolvedContent(
        {rowCount: 8, scoreList: new Int32Array(8).fill(-7)},
        Uint32Array.from({length: 8}, (_, i) => i),
        Float64Array.from({length: 8}, (_, i) => 1000 + i * 3),
        new Uint32Array(8).fill(3),
    )
}

/**
 * The fake exercises only store ownership and dispatch. Native-format behavior
 * is covered separately against the actual immutable native module.
 * @param {Uint8Array|null} [output]
 * @returns {{value: Encoder, tryEncode: import('vitest').Mock<(chunk: Fixture) => Uint8Array|null>, dispose: import('vitest').Mock<() => void>}}
 */
function encoderFixture(output = new Uint8Array([1, 2, 3])) {
    let disposed = false
    const diagnostics = {
        nativeCalls: 0,
        nativeRows: 0,
        nativeAttempts: 0,
        inputCopiedBytes: 0,
        outputCopiedBytes: 0,
        tableBytesRequested: 0,
        memoryGrowthBytes: 0,
        maximumLinearMemoryBytes: 131072,
        maximumScratchBytes: 0,
        declines: /** @type {Record<string, number>} */ ({}),
    }
    const tryEncode = vi.fn((/** @type {Fixture} */ chunk) => {
        if (disposed || output === null) { return null }
        ++diagnostics.nativeCalls
        ++diagnostics.nativeAttempts
        diagnostics.nativeRows += chunk.rowCount
        return new Uint8Array(output)
    })
    const dispose = vi.fn(() => { disposed = true })
    const api = {
        tryEncode,
        dispose,
        getDiagnostics: () => ({...diagnostics, declines: {...diagnostics.declines}}),
    }
    return {value: /** @type {Encoder} */ (/** @type {unknown} */ (api)), tryEncode, dispose}
}

/**
 * @param {TermRecordOpfsStore} store
 * @param {ReturnType<typeof encoderFixture>} encoder
 * @returns {Promise<void>}
 */
async function beginReady(store, encoder) {
    vi.mocked(createImportRecordFieldEncoder).mockResolvedValueOnce(encoder.value)
    await store.beginImportSession()
    await vi.dynamicImportSettled()
    expect(store._importRecordFieldSession?.encoder).toBe(encoder.value)
}

beforeEach(() => { vi.mocked(createImportRecordFieldEncoder).mockReset().mockResolvedValue(null) })
afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

describe('import-owned optional native record fields', () => {
    test('prepares once for an accepted session and preserves an already active owner', async () => {
        const store = new TermRecordOpfsStore()
        const encoder = encoderFixture()
        await beginReady(store, encoder)
        const owner = store._importRecordFieldSession
        await store.beginImportSession()
        await vi.dynamicImportSettled()
        expect(store._importRecordFieldSession).toBe(owner)
        expect(createImportRecordFieldEncoder).toHaveBeenCalledTimes(1)
        expect(encoder.dispose).not.toHaveBeenCalled()
        await store.endImportSession()
        expect(encoder.dispose).toHaveBeenCalledTimes(1)
        expect(store._importRecordFieldSession).toBeNull()
    })

    test('does not wait for preparation and accounts for the readiness fallback', async () => {
        const store = new TermRecordOpfsStore()
        const chunk = fixture()
        const expected = store._encodeArtifactRecordFields(chunk, [], [], 1000)
        /** @type {ReturnType<typeof deferred<Encoder|null>>} */
        const pending = deferred()
        vi.mocked(createImportRecordFieldEncoder).mockReturnValueOnce(pending.promise)
        await store.beginImportSession()
        await vi.dynamicImportSettled()
        expect(store._importRecordFieldSession?.encoder).toBeNull()
        expect(store._encodeArtifactRecordFields(chunk, [], [], 1000)).toEqual(expected)
        const encoder = encoderFixture(expected)
        pending.resolve(encoder.value)
        await vi.dynamicImportSettled()
        expect(store._encodeArtifactRecordFields(chunk, [], [], 1000)).toEqual(expected)
        expect(encoder.tryEncode).toHaveBeenCalledWith(chunk, 1000, expect.any(Function))
        await store.endImportSession()
        expect(store.getLastEndImportSessionMetrics()?.recordFields).toMatchObject({
            calls: 2, javascriptCalls: 1, native: {nativeCalls: 1, nativeAttempts: 1, nativeRows: 8},
        })
    })

    test('an unsuccessful optional preparation keeps the original encoder usable', async () => {
        const store = new TermRecordOpfsStore()
        const chunk = fixture()
        const expected = store._encodeArtifactRecordFields(chunk, [], [], 1000)
        vi.mocked(createImportRecordFieldEncoder).mockRejectedValueOnce(new Error('optional loader failure'))
        await store.beginImportSession()
        await vi.dynamicImportSettled()
        expect(store._encodeArtifactRecordFields(chunk, [], [], 1000)).toEqual(expected)
        await store.endImportSession()
        expect(store.getLastEndImportSessionMetrics()?.recordFields).toEqual({calls: 1, javascriptCalls: 1, native: null})
    })

    test('counts the entry before stock getter access and lets stock exceptions escape once', async () => {
        const store = new TermRecordOpfsStore()
        const encoder = encoderFixture(null)
        await beginReady(store, encoder)
        const failure = new Error('original rowCount getter')
        let reads = 0
        const chunk = {
            /** @returns {number} */
            get rowCount() {
                ++reads
                throw failure
            },
            scoreList: new Int32Array(8),
        }
        expect(() => store._encodeArtifactRecordFields(chunk, [], [], 0)).toThrow(failure)
        expect(reads).toBe(1)
        expect(encoder.tryEncode).toHaveBeenCalledTimes(1)
        expect(store._getImportRecordFieldMetrics()).toMatchObject({calls: 1, javascriptCalls: 1, native: {nativeCalls: 0, nativeAttempts: 0}})
        await store.endImportSession()
    })

    test('retains independent diagnostic snapshots', async () => {
        const store = new TermRecordOpfsStore()
        const encoder = encoderFixture()
        await beginReady(store, encoder)
        store._encodeArtifactRecordFields(fixture(), [], [], 1000)
        const snapshot = store._getImportRecordFieldMetrics()
        if (snapshot === null || snapshot.native === null) { throw new Error('Expected active diagnostics') }
        snapshot.calls = 999
        snapshot.native.declines.injected = 999
        expect(store._getImportRecordFieldMetrics()).toMatchObject({calls: 1, javascriptCalls: 0, native: {nativeCalls: 1}})
        expect(store._getImportRecordFieldMetrics()?.native?.declines).toEqual({})
        await store.endImportSession()
    })

    test('disposes preparation which completes after the session ended', async () => {
        const store = new TermRecordOpfsStore()
        /** @type {ReturnType<typeof deferred<Encoder|null>>} */
        const pending = deferred()
        vi.mocked(createImportRecordFieldEncoder).mockReturnValueOnce(pending.promise)
        await store.beginImportSession()
        await vi.dynamicImportSettled()
        await store.endImportSession()
        const encoder = encoderFixture()
        pending.resolve(encoder.value)
        await vi.dynamicImportSettled()
        expect(encoder.dispose).toHaveBeenCalledTimes(1)
        expect(store._importRecordFieldSession).toBeNull()
    })

    test('rollback retires the helper before asynchronous abandonment', async () => {
        const store = new TermRecordOpfsStore()
        const encoder = encoderFixture()
        await beginReady(store, encoder)
        const rollback = store._abandonImportWritesForRollback()
        expect(store._importRecordFieldSession).toBeNull()
        expect(encoder.dispose).toHaveBeenCalledTimes(1)
        await rollback
    })

    test('reset retires the helper before filesystem cleanup', async () => {
        const store = new TermRecordOpfsStore()
        const encoder = encoderFixture()
        await beginReady(store, encoder)
        vi.spyOn(store, '_ensureRecordsDirectoryHandle').mockResolvedValue()
        const reset = store._reset()
        expect(store._importRecordFieldSession).toBeNull()
        expect(encoder.dispose).toHaveBeenCalledTimes(1)
        await reset
    })

    test('prepare retires the helper before awaiting writable cleanup', async () => {
        const store = new TermRecordOpfsStore()
        const encoder = encoderFixture()
        await beginReady(store, encoder)
        /** @type {ReturnType<typeof deferred<void>>} */
        const close = deferred()
        vi.spyOn(store, '_closeAllWritables').mockReturnValueOnce(close.promise)
        vi.spyOn(store, '_ensureRecordsDirectoryHandle').mockResolvedValue()
        const preparing = store._prepare()
        expect(store._importRecordFieldSession).toBeNull()
        expect(encoder.dispose).toHaveBeenCalledTimes(1)
        close.resolve()
        await preparing
    })

    test('a malformed rollback checkpoint cannot abandon the current owner', async () => {
        const store = new TermRecordOpfsStore()
        const encoder = encoderFixture()
        await beginReady(store, encoder)
        const owner = store._importRecordFieldSession
        await expect(store._rollbackImportSession({shards: [{fileName: '../invalid', fileLength: 0}]})).rejects.toThrow(/checkpoint/u)
        expect(store._importRecordFieldSession).toBe(owner)
        expect(encoder.dispose).not.toHaveBeenCalled()
        await store.endImportSession()
    })

    test('failed finalization retires only the current owner and preserves the error', async () => {
        const store = new TermRecordOpfsStore()
        const encoder = encoderFixture()
        await beginReady(store, encoder)
        const failure = new Error('flush failed')
        vi.spyOn(store, '_flushPendingWrites').mockRejectedValueOnce(failure)
        await expect(store.endImportSession()).rejects.toThrow(failure)
        expect(store._importRecordFieldSession).toBeNull()
        expect(encoder.dispose).toHaveBeenCalledTimes(1)
    })

    test('an older real end keeps its diagnostics and cannot retire a later session', async () => {
        const store = new TermRecordOpfsStore()
        const older = encoderFixture()
        await beginReady(store, older)
        store._encodeArtifactRecordFields(fixture(), [], [], 1000)
        const olderMetrics = store._getImportRecordFieldMetrics()
        /** @type {ReturnType<typeof deferred<void>>} */
        const flush = deferred()
        vi.spyOn(store, '_flushPendingWrites').mockReturnValueOnce(flush.promise)
        const ending = store.endImportSession()
        await store._abandonImportWritesForRollback()
        const newer = encoderFixture()
        await beginReady(store, newer)
        store._encodeArtifactRecordFields(fixture(), [], [], 1000)
        store._encodeArtifactRecordFields(fixture(), [], [], 1000)
        const newOwner = store._importRecordFieldSession
        flush.resolve()
        await ending
        expect(store.getLastEndImportSessionMetrics()?.recordFields).toEqual(olderMetrics)
        expect(store._importRecordFieldSession).toBe(newOwner)
        expect(older.dispose).toHaveBeenCalledTimes(1)
        expect(newer.dispose).not.toHaveBeenCalled()
        expect(store._getImportRecordFieldMetrics()).toMatchObject({calls: 2, javascriptCalls: 0, native: {nativeCalls: 2}})
        store._retireImportRecordFieldEncoder()
    })

    test('late preparation from an abandoned owner cannot replace the next helper', async () => {
        const store = new TermRecordOpfsStore()
        /** @type {ReturnType<typeof deferred<Encoder|null>>} */
        const pending = deferred()
        vi.mocked(createImportRecordFieldEncoder).mockReturnValueOnce(pending.promise)
        await store.beginImportSession()
        await vi.dynamicImportSettled()
        await store._abandonImportWritesForRollback()
        const newer = encoderFixture()
        await beginReady(store, newer)
        const newOwner = store._importRecordFieldSession
        const older = encoderFixture()
        pending.resolve(older.value)
        await vi.dynamicImportSettled()
        expect(older.dispose).toHaveBeenCalledTimes(1)
        expect(newer.dispose).not.toHaveBeenCalled()
        expect(store._importRecordFieldSession).toBe(newOwner)
        expect(store._importRecordFieldSession?.encoder).toBe(newer.value)
        await store.endImportSession()
    })
})

/**
 * Focused integration tests deliberately await optional preparation. Actual
 * importer correctness uses its normal asynchronous startup without this wait.
 * @param {TermRecordOpfsStore} store
 * @returns {Promise<Encoder>}
 * @throws {Error}
 */
async function beginReal(store) {
    const url = new URL('../ext/lib/term-record-fields.wasm', import.meta.url)
    const bytes = new Uint8Array(readFileSync(url))
    vi.stubGlobal('fetch', vi.fn(async (/** @type {unknown} */ input) => {
        expect(String(input)).toBe(url.href)
        return new Response(new Uint8Array(bytes).buffer)
    }))
    const actual = /** @type {typeof import('../ext/js/dictionary/term-record-fields.js')} */ (
        await vi.importActual('../ext/js/dictionary/term-record-fields.js')
    )
    const preparation = {promise: /** @type {Promise<Encoder|null>|null} */ (null)}
    vi.mocked(createImportRecordFieldEncoder).mockImplementationOnce(() => {
        preparation.promise = actual.createImportRecordFieldEncoder()
        return preparation.promise
    })
    await store.beginImportSession()
    await vi.dynamicImportSettled()
    if (preparation.promise === null) { throw new Error('Expected optional preparation to start') }
    const encoder = await preparation.promise
    if (encoder === null) { throw new Error('Expected actual field helper') }
    await vi.dynamicImportSettled()
    expect(store._importRecordFieldSession?.encoder).toBe(encoder)
    return encoder
}

describe('actual native helper with the production record-field witness', () => {
    test('encodes an owned resolved chunk through the real store and publishes complete counters', async () => {
        const store = new TermRecordOpfsStore()
        const chunk = fixture()
        const expected = store._encodeArtifactRecordFields(chunk, [], [], 1000)
        await beginReal(store)
        try {
            expect(store._encodeArtifactRecordFields(chunk, [], [], 1000)).toEqual(expected)
            expect(store._getImportRecordFieldMetrics()).toMatchObject({
                calls: 1,
                javascriptCalls: 0,
                native: {nativeCalls: 1, nativeAttempts: 1, nativeRows: 8, inputCopiedBytes: 160, outputCopiedBytes: 84},
            })
        } finally {
            await store.endImportSession()
        }
        expect(store.getLastEndImportSessionMetrics()?.recordFields).toMatchObject({calls: 1, javascriptCalls: 0, native: {nativeCalls: 1}})
    })

    test('keeps an external lookalike on the unchanged stock route', async () => {
        const store = new TermRecordOpfsStore()
        const chunk = {...fixture()}
        const expected = store._encodeArtifactRecordFields(chunk, [], [], 1000)
        await beginReal(store)
        try {
            expect(store._encodeArtifactRecordFields(chunk, [], [], 1000)).toEqual(expected)
            expect(store._getImportRecordFieldMetrics()).toMatchObject({
                calls: 1,
                javascriptCalls: 1,
                native: {nativeCalls: 0, nativeAttempts: 0, inputCopiedBytes: 0, declines: {eligibility: 1}},
            })
        } finally {
            await store.endImportSession()
        }
    })

    test.each([
        {property: 'fixedContentLength', inherited: false},
        {property: 'fixedContentLength', inherited: true},
        {property: 'fixedContentOffsetBase', inherited: false},
        {property: 'fixedContentOffsetBase', inherited: true},
    ])('preserves stock accessor behavior for $property, inherited=$inherited', async ({property, inherited}) => {
        const store = new TermRecordOpfsStore()
        const chunk = fixture()
        await beginReal(store)
        const target = inherited ? Object.prototype : chunk
        const previous = Object.getOwnPropertyDescriptor(target, property)
        if (property === 'fixedContentLength') {
            Object.defineProperty(chunk, 'fixedContentOffsetBase', {configurable: true, value: 1000})
        }
        let reads = 0
        Object.defineProperty(target, property, {
            configurable: true,
            get() { ++reads; return property === 'fixedContentLength' ? 3 : 1000 },
        })
        try {
            const expected = new TermRecordOpfsStore()._encodeArtifactRecordFields(chunk, [], [], 1000)
            const expectedReads = reads
            reads = 0
            expect(store._encodeArtifactRecordFields(chunk, [], [], 1000)).toEqual(expected)
            expect(reads).toBe(expectedReads)
            expect(expectedReads).toBeGreaterThan(0)
            expect(store._getImportRecordFieldMetrics()).toMatchObject({
                calls: 1,
                javascriptCalls: 1,
                native: {nativeCalls: 0, nativeAttempts: 0, inputCopiedBytes: 0, declines: {eligibility: 1}},
            })
        } finally {
            if (typeof previous === 'undefined') {
                Reflect.deleteProperty(target, property)
            } else {
                Object.defineProperty(target, property, previous)
            }
            await store.endImportSession()
        }
    })

    test('rejects a forged real score kind after the production witness accepts its prototype', async () => {
        const store = new TermRecordOpfsStore()
        const chunk = fixture()
        const scores = new Uint16Array(8).fill(32768)
        Object.setPrototypeOf(scores, Int32Array.prototype)
        chunk.scoreList = /** @type {Int32Array} */ (/** @type {unknown} */ (scores))
        const expected = store._encodeArtifactRecordFields(chunk, [], [], 1000)
        await beginReal(store)
        try {
            expect(store._encodeArtifactRecordFields(chunk, [], [], 1000)).toEqual(expected)
            expect(store._getImportRecordFieldMetrics()).toMatchObject({
                calls: 1,
                javascriptCalls: 1,
                native: {nativeCalls: 0, nativeAttempts: 0, inputCopiedBytes: 0, declines: {eligibility: 1}},
            })
        } finally {
            await store.endImportSession()
        }
    })
})
